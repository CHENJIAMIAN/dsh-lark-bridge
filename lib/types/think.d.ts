/**
 * Per-session reasoning effort: `/think`.
 *
 * The effort a turn runs at is not something the bridge can set on the agent.
 * The loop resolves it as `options.reasoningEffort ?? persisted header`, and
 * the options come from the deployment's default at creation time — so
 * rewriting that default, which is all `/model` can do, reaches the NEXT
 * session and leaves every running one where it was. A chat needs two things a
 * command can give it: a way to READ what the next request will actually send,
 * and a way to CHANGE it without opening a new session.
 *
 * The change rides the host's own `agent/request` waterfall — the same seam the
 * web UI's model picker uses (`installModelSelection`): the resolved envelope
 * is rewritten on its way to the adapter, so a switch lands on the next step
 * rather than the next session. The choice is recorded as a durable
 * `model/selection` event, the exact event shape that surface writes, so a
 * resumed session and a web-UI client read the same fact instead of two.
 * @module dsh-lark-bridge/think
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandOutcome } from './commands.ts';
import type { HostAgent, HostDefaultModel, HostLlm, HostSession } from './host.ts';
/**
 * Levels offered when no adapter publishes its own.
 *
 * These are the levels the DeepSeek adapters ship (off/low/high/max). The list
 * is a fallback, not the truth: a route that describes itself wins, because
 * offering a level the provider rejects turns a settings command into a failed
 * turn.
 */
export declare const FALLBACK_EFFORTS: readonly string[];
/** One selectable level. */
export interface EffortLevel {
    readonly id: string;
    /** Adapter-provided display name, when it has one. */
    readonly name?: string;
}
/** The levels one route accepts, and where that list came from. */
export interface EffortCatalog {
    readonly levels: readonly EffortLevel[];
    /** The adapter's own default, materialized when a request omits an effort. */
    readonly defaultEffort?: string;
    /** `adapter` when the route described itself, `fallback` otherwise. */
    readonly source: 'adapter' | 'fallback';
}
/** What one `/think` line asked for. */
export type ThinkIntent = {
    readonly kind: 'show';
} | {
    readonly kind: 'set';
    readonly effort: string;
} | {
    readonly kind: 'reset';
};
/**
 * `/think off` 的档位名。
 *
 * 这一档和其他档不同：它要求的是「选择里根本没有 reasoning 这一项」，而不是
 * 「把 off 这个名字查成某个 wire 值发出去」。宿主的查表结果取决于配置里
 * `reasoningEfforts.off` 写成 null 还是字符串，而 magpie 会把它写成 `"none"`；
 * `"none"` 不是任何厂商认的关闭值，上游只会当成没听懂。
 *
 * **实现位置在「选择」层，不在「请求」层（2026-11-11 修正）。**
 * 早先的做法是在 `agent/request` 瀑布里把这个字段删掉。宿主 0.2.2 起在每一步
 * 准备阶段固定 `selection`，随后硬校验瀑布的返回值必须与它完全一致（loop 的
 * `proposed reasoning effort "adapter default" after step preparation fixed "off"`），
 * 于是「准备阶段说是 off、请求阶段却把字段删了」直接把整轮打成 `UNKNOWN`——
 * 用户切「关闭思考」就炸，切 low 却没事，因为 low 两边一致。
 *
 * 现在改成：落盘 `model/selection` 时不带 effort。宿主自己的
 * `AgentModel.current()` 对「没有 effort 的选择」返回不含该字段的选择（其注释
 * 说得明白：adapter 默认出来的 effort 会被省略，让后续请求重新取默认），于是
 * 准备阶段和请求阶段都认为「不指定」，天然一致，请求里也就没有 reasoning 字段
 * ——正是「关闭」要的效果。
 */
export declare const EFFORT_OFF = "off";
/** A recorded model selection, as the session log stores it. */
export interface ModelSelection {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
}
/** The parts of one resolved request envelope the override touches. */
export interface RequestEnvelope {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/**
 * Parse one `/think` line.
 * @param line - the trimmed command line, leading slash included.
 * @returns what the line asked for; an empty argument means "show".
 */
export declare function parseThinkLine(line: string): ThinkIntent;
/**
 * The printable name of an effort value, wherever it came from.
 *
 * Not every source hands back a string. A selection the user saved is one, but
 * the effort the host records in `requestHeader().config` is a `ReasoningEffortId`
 * — a branded **object** around the id — so interpolating it straight into a
 * template string printed `[object Object]` as the session's current level
 * (2026-11-11, operator report). Unwrap it; anything genuinely unrecognisable
 * reads as "not set" rather than as a broken line.
 * @param value - an effort id, a branded effort id, or nothing.
 * @returns the id as text, or undefined.
 */
export declare function effortName(value: unknown): string | undefined;
/**
 * Read the last model selection one session recorded.
 *
 * The scan is a plain array walk — the host serves `eventAt` straight out of
 * the loaded log — so it costs nothing measurable on the path that opens a
 * session, and it keeps the choice in the session instead of in a second store
 * that could drift from it.
 * @param session - the session whose log to scan.
 * @returns the newest recorded selection, or undefined when none exists.
 */
export declare function lastSelection(session: HostSession): ModelSelection | undefined;
/**
 * Resolve the levels one route accepts.
 * @param llm - the llm runtime, when composed.
 * @param provider - the route's provider.
 * @param model - the route's model.
 * @returns the adapter's own list when it has one, the fallback otherwise.
 */
export declare function effortCatalog(llm: HostLlm | undefined, provider: string | undefined, model: string | undefined): Promise<EffortCatalog>;
/**
 * The live per-session effort choices, and the route hook that applies them.
 *
 * One instance serves the whole bridge: every agent's `setup` installs a hook
 * that reads this table by session id, so a choice made in a chat applies to
 * that chat's agent and to no other.
 */
export declare class EffortOverrides {
    /**
     * What each session asked to run as: the route it wants, its effort, or both.
     *
     * Storing the whole selection rather than just the effort is what lets a
     * switch reach the CURRENT session: the deployment's default is written into
     * the agent at creation, and a home-patch overlay refuses to be rewritten at
     * runtime, so saveSelection alone only ever reaches the next session.
     */
    private readonly bySession;
    /**
     * @param _ctx - 保留的桥上下文。
     *
     * 档位能力校验（原来在 `agent/request` 瀑布里做，问 `llm.resolveModelInfo`
     * 这个模型认不认当前档位）随瀑布一起从这里撤掉了：那一步现在禁止改动任何
     * 请求字段。校验改由命令层在切换前完成（`runThinkCommand` 已经比对 catalog），
     * 这里留一个可选参数只是为了不牵动十几处调用点。
     */
    constructor(_ctx?: Context);
    /**
     * The override in force for one session.
     * @param sessionId - the session to look up.
     * @returns the chosen selection, or undefined when the session follows the default.
     */
    get(sessionId: string): ModelSelection | undefined;
    /**
     * Re-read one session's choice from its own log.
     *
     * Called when an agent is composed: a resumed session must come back at the
     * effort its human chose, not at the deployment default.
     * @param session - the session being opened.
     */
    restore(session: HostSession): void;
    /**
     * Drop one session's override entirely, returning it to the deployment default.
     *
     * Distinct from recording a selection with no effort: that keeps a route
     * override in place, while a reset means 'nothing of mine applies here' —
     * both the route and the effort go back to the deployment's choice.
     * @param session - the session being reset.
     */
    clear(session: HostSession): void;
    /**
     * Record one session's choice, durably when the host can append.
     *
     * `EFFORT_OFF` is stored in memory as the literal `'off'` — that is what
     * `/think` prints back and what tells "the human asked for no thinking" apart
     * from "nobody chose anything". What reaches the session log omits the field:
     * the host then reads the selection as "unspecified" at step preparation and
     * leaves the request without a reasoning field, which is the only encoding of
     * "off" that survives the loop's consistency check. See {@link EFFORT_OFF}.
     * @param session - the session the choice belongs to.
     * @param selection - the provider/model it applies to, plus the effort
     *   (`undefined` clears the override and returns the session to the default).
     */
    set(session: HostSession, selection: ModelSelection): void;
    /**
     * Change only the effort of the route a session already runs.
     *
     * 给「换模型但不动档位」「只调档位不换模型」这类操作共用：路由保持不变，
     * 只替换 `reasoningEffort`，落的仍是同一条 `model/selection` 事件——历史和
     * `/think` 完全一致，resume 时一条扫描就读回来了。
     * @param session - the session being changed.
     * @param selection - the route it runs, and the effort to send with it.
     */
    setEffort(session: HostSession, selection: ModelSelection): void;
    /**
     * Install the route override on one agent's scope.
     *
     * **只覆盖路由，绝不改 `reasoningEffort`。**
     *
     * 宿主 0.2.2 起在每一步准备阶段用 `agent.model.current()` 固定一次
     * `selection`，随后硬校验 `agent/request` 瀑布的返回值必须与它逐字段相等
     * （loop 的 `… after step preparation fixed …; use agent.model.select()
     * before step preparation`）。所以任何在瀑布里改 effort 的写法都会让整轮
     * 变成 `UNKNOWN` —— 2026-11-11 用户点「关闭思考」就是这么炸的。
     *
     * effort 现在完全通过落盘的 `model/selection` 事件生效（`set()` 会写），
     * 宿主下一步准备阶段自己就读到了。这里剩下的路由覆盖与那条事件同源，
     * 所以返回的值恒等于准备阶段固定下来的值，不会被判为不一致。
     * @param agentCtx - the agent's scoped context.
     * @param sessionId - the session this agent drives.
     */
    install(agentCtx: Context, sessionId: string): void;
}
/**
 * Handle `/think [level|reset]`: show or change this session's reasoning effort.
 * @param line - the trimmed command line.
 * @param agent - the chat's agent (owns the session being changed).
 * @param overrides - the live override table, when the bridge wired one.
 * @param llm - the llm runtime, when composed (for the route's own levels).
 * @param defaultModel - the deployment default, for the "follow the default" line.
 * @returns the reply for the chat.
 */
export declare function runThinkCommand(line: string, agent: HostAgent, overrides: EffortOverrides | undefined, llm: HostLlm | undefined, defaultModel: HostDefaultModel | undefined): Promise<CommandOutcome>;
//# sourceMappingURL=think.d.ts.map