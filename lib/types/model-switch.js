/**
 * 把「人嘴里的那个模型」解析成一个可切换的 route。
 *
 * 工具调用的输入是自然语言：「换成那个免费的」「用 deepseek 的 v4」「下一个」
 * 「回到默认」。这里只做解析，不碰会话、不碰宿主——解析对不对是所有切换行为
 * 共同的前提，而它恰好是可以脱离宿主单独验证的那一半。
 *
 * 三条规矩：
 * - **绝不猜。** 用户说「那个便宜的」，解析不出来就说出来并列出候选，而不是
 *   随便挑一个差不多的模型——切错模型的代价是一次跑错的请求，而且用户当时
 *   看着屏幕以为已经切好了。
 * - **唯一才命中。** 「v4」能唯一定位到 deepseek-official/deepseek-v4 就切；
 *   同时命中两个 provider 时列出来让人选。
 * - **相对序号可用。** 「下一个」「往上一个」按当前在清单里的位置走，这是模型
 *   在对话里最常被要求的形式。
 * @module dsh-lark-bridge/model-switch
 */
/** 复位到部署默认的说法。 */
const RESET_WORDS = ['default', 'reset', 'auto', '默认', '恢复默认', '回到默认', '部署默认', '不指定'];
/** 相对位置的量。长的说法放前面：`上一个` 不能先被 `下一个` 之类的短词吃掉。 */
const RELATIVE = [
    { words: ['第一个', 'first'], step: 0 },
    { words: ['下一个', 'next', '下面一个'], step: 1 },
    { words: ['上一个', 'previous', 'prev', '上面一个'], step: -1 },
];
/**
 * 一个 entry 的几种叫法，全部小写，用于包含式匹配。
 *
 * 同一个模型在不同人口里是不同名字：id、显示名、`provider/id`、以及去掉
 * provider 前缀后的显示名。全放进去，让「deepseek v4」「DeepSeek · V4」都能命中。
 * @param entry - 清单里的一项。
 * @returns 去重后的叫法，长的在前（长的更容易是唯一命中）。
 */
function aliases(entry) {
    const all = [
        `${entry.provider}/${entry.id}`,
        entry.id,
        entry.name,
        entry.description ?? '',
    ];
    return [...new Set(all.map(alias => alias.trim().toLowerCase()).filter(alias => alias !== ''))]
        .sort((left, right) => right.length - left.length);
}
/** 去噪：小写、压掉多余空白，方便逐字包含比较。 */
function normalize(text) {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
/**
 * 解析一次切换请求。
 * @param input - 用户/模型给的原始说法；空串表示「单纯查清单」。
 * @param entries - 当前可路由的模型清单，顺序即「下一个」的顺序。
 * @param current - 当前生效的 `provider/model`，用于相对位置和「已是这个」判断。
 * @returns 解析结果。
 */
export function resolveModelRequest(input, entries, current) {
    const wanted = normalize(input);
    if (wanted === '')
        return { kind: 'unknown', reason: '没有给出要切换到哪个模型', candidates: [] };
    if (RESET_WORDS.includes(wanted))
        return { kind: 'reset' };
    // ① 精确 route：`provider/model` 与清单逐字相符就直取，不做模糊。
    const exact = entries.find(entry => normalize(`${entry.provider}/${entry.id}`) === wanted);
    if (exact !== undefined) {
        return { kind: 'select', provider: exact.provider, model: exact.id, why: '完整 route 名' };
    }
    // ② 相对位置，「下一个」按当前在清单里的位置走。
    const relative = RELATIVE.find(candidate => candidate.words.some(word => wanted.includes(word)));
    if (relative !== undefined) {
        const index = entries.findIndex(entry => `${entry.provider}/${entry.id}` === current);
        const base = index < 0 ? 0 : index;
        const target = relative.step === 0 ? 0 : base + relative.step;
        const entry = entries[target];
        if (entry === undefined) {
            return {
                kind: 'unknown',
                reason: `按当前位置往${relative.step > 0 ? '后' : '前'}已经到头了`,
                candidates: entries.map(listing),
            };
        }
        return { kind: 'select', provider: entry.provider, model: entry.id, why: '按当前位置的相对序号' };
    }
    // ③ 模糊：说法包含某个叫法就算命中，命中 route 去重后**取最长的那批**。
    //
    // 只留最长命中的原因：「换成 deepseek v4 flash」同时包含 `deepseek-v4` 和
    // `deepseek-v4-flash`，可前者只是后者的前缀——按最长留就是唯一解。真撞名
    // （两家 provider 下都叫 deepseek-v4）两边的叫法一样长，仍然会剩两条，按
    // 「不猜」的规矩报出来让人选。
    const hits = new Map();
    for (const entry of entries) {
        for (const alias of aliases(entry)) {
            if (!wanted.includes(alias))
                continue;
            const key = `${entry.provider}/${entry.id}`;
            const previous = hits.get(key);
            if (previous === undefined || alias.length > previous.alias.length) {
                hits.set(key, { provider: entry.provider, model: entry.id, alias });
            }
        }
    }
    const longest = Math.max(0, ...[...hits.values()].map(hit => hit.alias.length));
    const best = [...hits.values()].filter(hit => hit.alias.length === longest);
    if (best.length === 1) {
        const hit = best[0];
        return { kind: 'select', provider: hit.provider, model: hit.model, why: `匹配「${hit.alias}」` };
    }
    if (best.length > 1) {
        return {
            kind: 'unknown',
            reason: `「${input.trim()}」能对上多个模型，请说得更具体`,
            candidates: best.map(hit => `${hit.provider}/${hit.model}`),
        };
    }
    // 兜底：按空白切开逐词找，只接受唯一命中（用于「deepseek v4」这种拼起来的说法）。
    const tokens = wanted.split(' ').filter(token => token.length >= 2);
    const loose = entries.filter(entry => tokens.length > 0
        && tokens.every(token => aliases(entry).some(alias => alias.includes(token))));
    if (loose.length === 1) {
        const entry = loose[0];
        return { kind: 'select', provider: entry.provider, model: entry.id, why: `按关键词逐词匹配` };
    }
    if (loose.length > 1) {
        return {
            kind: 'unknown',
            reason: `「${input.trim()}」能对上多个模型，请说得更具体`,
            candidates: loose.map(entry => `${entry.provider}/${entry.id}`),
        };
    }
    return {
        kind: 'unknown',
        reason: `清单里没有和「${input.trim()}」对得上的模型`,
        candidates: entries.map(listing),
    };
}
/** 清单里一行怎么显示：`provider/id（名字）`。 */
export function listing(entry) {
    return `${entry.provider}/${entry.id}（${entry.name}）`;
}
/**
 * 说人话的档位：一句话对到档位意图，再由意图落到该 route 真有的档位上。
 *
 * 顺序有讲究——**强的说法放前面**：「不要想太多」里含「想」，但意思是关掉；
 * 「多想想」里也含「想」，意思是加。所以先判否定与关闭，再判加强，再判减弱。
 * 每条都是一组同义说法，命中即止，不做模糊打分：档位只有三四个，猜错一次就是
 * 一整轮跑错力度，宁可不认。
 */
const EFFORT_PHRASES = [
    {
        want: 'off',
        words: [
            'off', '关掉', '关闭', '不用思考', '别思考', '别想', '不要想', '不想思考', '别推理', '不要推理',
            '关闭思考', '关掉思考', '不思考', '省点', '省钱', '最省', '省钱模式', '快一点', '快点',
            '最快', '立即', '别磨叽', '不用想',
        ],
    },
    {
        want: 'min',
        words: ['low', '最低', '最小', '轻一点', '随便', '简单点', '粗略'],
    },
    {
        want: 'max',
        words: ['max', '最高', '最大', '拉满', '全开', '全力', '使劲', '死磕', '狠狠想', '最大化'],
    },
    {
        want: 'more',
        words: ['high', '多想想', '多想', '认真想', '好好想', '想清楚', '深入', '增强', '加一点', '提高', '厉害一点'],
    },
    {
        want: 'less',
        words: ['少想', '简单想', '别想太多', '不要想太多', '降低', '减轻', '弱一点'],
    },
];
/** 档位低到高的大致顺序，用于「没有这一档时找最近的」。 */
const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
/**
 * 把一句人话解析成档位意图。
 * @param input - 原始说法。
 * @returns 档位意图；`undefined` 表示「恢复默认」，`null` 表示没听懂。
 */
export function effortIntent(input) {
    const wanted = normalize(input);
    if (wanted === '')
        return undefined;
    if (['default', 'reset', 'auto', '不设', '默认', '自动', '恢复默认', '回到默认'].includes(wanted))
        return undefined;
    for (const phrase of EFFORT_PHRASES) {
        if (phrase.words.some(word => wanted.includes(word)))
            return phrase.want;
    }
    return null;
}
/**
 * 在一条 route 声明的档位里挑出意图对应的那一档。
 *
 * 「没有这一档」时不是直接失败，而是往意图方向找最近的一档：模型只声明了
 * `off/low/high/max` 时说「最高」，`max` 就是它；只说 `low/high` 时说「关掉」，
 * 那只能给 `low` 并如实说明——拒绝会让「关掉思考」在这种模型上永远做不到。
 * @param want - 档位意图（`undefined` = 恢复默认）。
 * @param levels - 该 route 声明的档位。
 * @returns 选中的档位，和是否做了降级说明；档位表为空时返回 undefined。
 */
export function pickEffort(want, levels) {
    if (want === undefined)
        return { level: undefined };
    if (levels.length === 0)
        return { level: undefined };
    const byName = (name) => levels.find(level => normalize(level) === name);
    if (want === 'off') {
        const exact = byName('off') ?? byName('none');
        // 没有关闭档：给最低的那一档，并说清楚这不是真正的关闭。
        if (exact !== undefined)
            return { level: exact };
        const lowest = lowestLevel(levels);
        return { level: lowest, downgraded: `这个模型没有「关闭思考」这一档，已取最低的「${lowest}」` };
    }
    if (want === 'max') {
        const exact = byName('max') ?? byName('high');
        if (exact !== undefined)
            return { level: exact };
        const highest = highestLevel(levels);
        return { level: highest, downgraded: `这个模型没有「最高」这一档，已取最高的「${highest}」` };
    }
    if (want === 'min' || want === 'less') {
        const exact = want === 'min' ? byName('low') ?? byName('minimal') : byName('medium') ?? byName('low');
        return exact === undefined ? { level: lowestLevel(levels) } : { level: exact };
    }
    // 「加强一点」：在 medium/high 之间找，没有就给最高的。
    const exact = byName('high') ?? byName('medium');
    return exact === undefined ? { level: highestLevel(levels) } : { level: exact };
}
/** 按 LEVEL_ORDER 找最低的一档；不在顺序表里的取第一个。 */
function lowestLevel(levels) {
    let best = levels[0];
    let bestRank = rankOf(best);
    for (const level of levels) {
        const rank = rankOf(level);
        if (rank < bestRank) {
            best = level;
            bestRank = rank;
        }
    }
    return best;
}
/** 按 LEVEL_ORDER 找最高的一档。 */
function highestLevel(levels) {
    let best = levels[0];
    let bestRank = rankOf(best);
    for (const level of levels) {
        const rank = rankOf(level);
        if (rank > bestRank) {
            best = level;
            bestRank = rank;
        }
    }
    return best;
}
/** 一档在标准顺序里的位置；不认识的排中间。 */
function rankOf(level) {
    const index = LEVEL_ORDER.indexOf(normalize(level));
    return index < 0 ? 2 : index;
}
/**
 * 解析思考强度：接受档位名，也接受「不设/自动」。
 * @param input - 原始说法。
 * @param levels - 该 route 声明的档位。
 * @returns 档位 id；`undefined` 表示「不指定，交给适配器默认」，`null` 表示说了但说错了。
 */
export function resolveEffort(input, levels) {
    const wanted = normalize(input);
    if (wanted === '')
        return undefined;
    if (['default', 'reset', 'auto', '不设', '默认', '自动'].includes(wanted))
        return undefined;
    // 先认精确档位名，再认人话；两者都认才叫「自然语言切换」。
    const hit = levels.find(level => normalize(level) === wanted);
    if (hit !== undefined)
        return hit;
    const want = effortIntent(input);
    if (want === null)
        return null;
    return pickEffort(want, levels).level;
}
//# sourceMappingURL=model-switch.js.map