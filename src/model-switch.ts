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

import type { ModelEntry } from './model-catalog.ts'

/** 一次解析的结果。 */
export type ModelResolve =
  /** 明确要复位到部署默认。 */
  | { readonly kind: 'reset' }
  /** 解析到唯一一个 route。 */
  | { readonly kind: 'select'; readonly provider: string; readonly model: string; readonly why: string }
  /** 没解析出来：给出原因和（能列就列的）候选。 */
  | { readonly kind: 'unknown'; readonly reason: string; readonly candidates: readonly string[] }

/** 复位到部署默认的说法。 */
const RESET_WORDS = ['default', 'reset', 'auto', '默认', '恢复默认', '回到默认', '部署默认', '不指定'] as const

/** 相对位置的量。长的说法放前面：`上一个` 不能先被 `下一个` 之类的短词吃掉。 */
const RELATIVE: readonly { readonly words: readonly string[]; readonly step: number }[] = [
  { words: ['第一个', 'first'], step: 0 },
  { words: ['下一个', 'next', '下面一个'], step: 1 },
  { words: ['上一个', 'previous', 'prev', '上面一个'], step: -1 },
]

/**
 * 一个 entry 的几种叫法，全部小写，用于包含式匹配。
 *
 * 同一个模型在不同人口里是不同名字：id、显示名、`provider/id`、以及去掉
 * provider 前缀后的显示名。全放进去，让「deepseek v4」「DeepSeek · V4」都能命中。
 * @param entry - 清单里的一项。
 * @returns 去重后的叫法，长的在前（长的更容易是唯一命中）。
 */
function aliases(entry: ModelEntry): string[] {
  const all = [
    `${entry.provider}/${entry.id}`,
    entry.id,
    entry.name,
    entry.description ?? '',
  ]
  return [...new Set(all.map(alias => alias.trim().toLowerCase()).filter(alias => alias !== ''))]
    .sort((left, right) => right.length - left.length)
}

/** 去噪：小写、压掉多余空白，方便逐字包含比较。 */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * 解析一次切换请求。
 * @param input - 用户/模型给的原始说法；空串表示「单纯查清单」。
 * @param entries - 当前可路由的模型清单，顺序即「下一个」的顺序。
 * @param current - 当前生效的 `provider/model`，用于相对位置和「已是这个」判断。
 * @returns 解析结果。
 */
export function resolveModelRequest(
  input: string,
  entries: readonly ModelEntry[],
  current: string | undefined,
): ModelResolve {
  const wanted = normalize(input)
  if (wanted === '') return { kind: 'unknown', reason: '没有给出要切换到哪个模型', candidates: [] }
  if ((RESET_WORDS as readonly string[]).includes(wanted)) return { kind: 'reset' }

  // ① 精确 route：`provider/model` 与清单逐字相符就直取，不做模糊。
  const exact = entries.find(entry => normalize(`${entry.provider}/${entry.id}`) === wanted)
  if (exact !== undefined) {
    return { kind: 'select', provider: exact.provider, model: exact.id, why: '完整 route 名' }
  }

  // ② 相对位置，「下一个」按当前在清单里的位置走。
  const relative = RELATIVE.find(candidate => candidate.words.some(word => wanted.includes(word)))
  if (relative !== undefined) {
    const index = entries.findIndex(entry => `${entry.provider}/${entry.id}` === current)
    const base = index < 0 ? 0 : index
    const target = relative.step === 0 ? 0 : base + relative.step
    const entry = entries[target]
    if (entry === undefined) {
      return {
        kind: 'unknown',
        reason: `按当前位置往${relative.step > 0 ? '后' : '前'}已经到头了`,
        candidates: entries.map(listing),
      }
    }
    return { kind: 'select', provider: entry.provider, model: entry.id, why: '按当前位置的相对序号' }
  }

  // ③ 模糊：说法包含某个叫法就算命中，命中 route 去重后**取最长的那批**。
  //
  // 只留最长命中的原因：「换成 deepseek v4 flash」同时包含 `deepseek-v4` 和
  // `deepseek-v4-flash`，可前者只是后者的前缀——按最长留就是唯一解。真撞名
  // （两家 provider 下都叫 deepseek-v4）两边的叫法一样长，仍然会剩两条，按
  // 「不猜」的规矩报出来让人选。
  const hits = new Map<string, { provider: string; model: string; alias: string }>()
  for (const entry of entries) {
    for (const alias of aliases(entry)) {
      if (!wanted.includes(alias)) continue
      const key = `${entry.provider}/${entry.id}`
      const previous = hits.get(key)
      if (previous === undefined || alias.length > previous.alias.length) {
        hits.set(key, { provider: entry.provider, model: entry.id, alias })
      }
    }
  }
  const longest = Math.max(0, ...[...hits.values()].map(hit => hit.alias.length))
  const best = [...hits.values()].filter(hit => hit.alias.length === longest)
  if (best.length === 1) {
    const hit = best[0]!
    return { kind: 'select', provider: hit.provider, model: hit.model, why: `匹配「${hit.alias}」` }
  }
  if (best.length > 1) {
    return {
      kind: 'unknown',
      reason: `「${input.trim()}」能对上多个模型，请说得更具体`,
      candidates: best.map(hit => `${hit.provider}/${hit.model}`),
    }
  }
  // 兜底：按空白切开逐词找，只接受唯一命中（用于「deepseek v4」这种拼起来的说法）。
  const tokens = wanted.split(' ').filter(token => token.length >= 2)
  const loose = entries.filter(entry => tokens.length > 0
    && tokens.every(token => aliases(entry).some(alias => alias.includes(token))))
  if (loose.length === 1) {
    const entry = loose[0]!
    return { kind: 'select', provider: entry.provider, model: entry.id, why: `按关键词逐词匹配` }
  }
  if (loose.length > 1) {
    return {
      kind: 'unknown',
      reason: `「${input.trim()}」能对上多个模型，请说得更具体`,
      candidates: loose.map(entry => `${entry.provider}/${entry.id}`),
    }
  }
  return {
    kind: 'unknown',
    reason: `清单里没有和「${input.trim()}」对得上的模型`,
    candidates: entries.map(listing),
  }
}

/** 清单里一行怎么显示：`provider/id（名字）`。 */
export function listing(entry: ModelEntry): string {
  return `${entry.provider}/${entry.id}（${entry.name}）`
}

/**
 * 解析思考强度：接受档位名，也接受「不设/自动」。
 * @param input - 原始说法。
 * @param levels - 该 route 声明的档位。
 * @returns 档位 id；`undefined` 表示「不指定，交给适配器默认」，`null` 表示说了但说错了。
 */
export function resolveEffort(input: string, levels: readonly string[]): string | undefined | null {
  const wanted = normalize(input)
  if (wanted === '') return undefined
  if (['default', 'reset', 'auto', '不设', '默认', '自动'].includes(wanted)) return undefined
  const hit = levels.find(level => normalize(level) === wanted)
  return hit ?? null
}
