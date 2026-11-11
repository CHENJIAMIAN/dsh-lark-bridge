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
import type { ModelEntry } from './model-catalog.ts';
/** 一次解析的结果。 */
export type ModelResolve = 
/** 明确要复位到部署默认。 */
{
    readonly kind: 'reset';
}
/** 解析到唯一一个 route。 */
 | {
    readonly kind: 'select';
    readonly provider: string;
    readonly model: string;
    readonly why: string;
}
/** 没解析出来：给出原因和（能列就列的）候选。 */
 | {
    readonly kind: 'unknown';
    readonly reason: string;
    readonly candidates: readonly string[];
};
/**
 * 解析一次切换请求。
 * @param input - 用户/模型给的原始说法；空串表示「单纯查清单」。
 * @param entries - 当前可路由的模型清单，顺序即「下一个」的顺序。
 * @param current - 当前生效的 `provider/model`，用于相对位置和「已是这个」判断。
 * @returns 解析结果。
 */
export declare function resolveModelRequest(input: string, entries: readonly ModelEntry[], current: string | undefined): ModelResolve;
/** 清单里一行怎么显示：`provider/id（名字）`。 */
export declare function listing(entry: ModelEntry): string;
/**
 * 把一句人话解析成档位意图。
 * @param input - 原始说法。
 * @returns 档位意图；`undefined` 表示「恢复默认」，`null` 表示没听懂。
 */
export declare function effortIntent(input: string): 'off' | 'min' | 'max' | 'more' | 'less' | undefined | null;
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
export declare function pickEffort(want: 'off' | 'min' | 'max' | 'more' | 'less' | undefined, levels: readonly string[]): {
    readonly level: string | undefined;
    readonly downgraded?: string;
};
/**
 * 解析思考强度：接受档位名，也接受「不设/自动」。
 * @param input - 原始说法。
 * @param levels - 该 route 声明的档位。
 * @returns 档位 id；`undefined` 表示「不指定，交给适配器默认」，`null` 表示说了但说错了。
 */
export declare function resolveEffort(input: string, levels: readonly string[]): string | undefined | null;
//# sourceMappingURL=model-switch.d.ts.map