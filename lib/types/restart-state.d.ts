/**
 * The bridge's own state that has to survive a restart.
 *
 * 宿主持久的是**会话**（历史、模型选择、目标），桥自己那一层却全在内存里：等回答
 * 的提问、等确认的审批、`/tools disable` 的运行时禁用、各类卡片的消息 id、正在
 * 进行中的流式卡、以及「哪一轮被重启打断」。重启一次，这些就都消失，用户的感受
 * 是「问题点了没反应」「卡片不刷新了」「我禁掉的工具又回来了」。
 *
 * 这个模块只负责**存**，不负责怎么用：一个原子写的 JSON，读坏当空，条目带 24 小时
 * 过期（过期的待回答不该在第二天突然能点）。用它的地方在 `bridge.ts` 与
 * `questions.ts`。
 * @module dsh-lark-bridge/restart-state
 */
/** A question card that was waiting for a human when the process went away. */
export interface RestartQuestion {
    /** Card control token; the same token the buttons carry. */
    readonly token: string;
    readonly chatId: string;
    readonly sessionId: string;
    /** The card's message id, so a stale card can be rewritten instead of ignored. */
    readonly messageId?: string;
    /** The question as the model asked it, so an answer can be replayed verbatim. */
    readonly questions: readonly RestartAskedQuestion[];
    /** ISO 8601. */
    readonly askedAt: string;
}
/** One question of a persisted request — only what a replay needs. */
export interface RestartAskedQuestion {
    readonly id: string;
    readonly question: string;
    readonly options?: readonly {
        readonly label: string;
    }[];
}
/** An approval card that was waiting for a human. */
export interface RestartApproval {
    readonly id: string;
    readonly chatId: string;
    readonly sessionId: string;
    readonly messageId?: string;
    /** What the tool wanted to do, for the replay sentence. */
    readonly title: string;
    readonly askedAt: string;
}
/** A turn that was in flight; a boot that finds one says so in its chat. */
export interface RestartTurn {
    readonly chatId: string;
    readonly sessionId: string;
    /** Where the turn had got to, for the notice. */
    readonly turn: number;
    readonly startedAt: string;
}
/** A card the bridge is still updating; after a boot it can be taken over again. */
export interface RestartCard {
    readonly chatId: string;
    /** `console`, `goal`, `todo`, `team`, `subagent`, `workflow`. */
    readonly kind: string;
    readonly messageId: string;
    readonly updatedAt: string;
}
/** Everything one boot reads back. */
export interface RestartState {
    readonly questions: readonly RestartQuestion[];
    readonly approvals: readonly RestartApproval[];
    readonly turns: readonly RestartTurn[];
    readonly cards: readonly RestartCard[];
    /** Runtime-disabled tools, by name; restored before the first turn. */
    readonly deniedTools: readonly string[];
}
/** How long an entry stays usable. A day-old pending question is not answerable. */
export declare const RESTART_STATE_TTL_MS: number;
/**
 * The harness home this file lives in: `DSH_HOME` when set, else `~/.dsh`.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export declare function restartStateHome(home?: string): string;
/**
 * Path of the state file.
 * @param home - override for tests.
 * @returns the file path.
 */
export declare function restartStateFile(home?: string): string;
/** What the bridge drives. */
export interface RestartStore {
    /** Everything still fresh, read once at boot. */
    load(): RestartState;
    /** Record a question waiting for a human. */
    rememberQuestion(question: RestartQuestion): void;
    /** Drop a question once it is answered, cancelled or superseded. */
    forgetQuestion(token: string): void;
    /** Record an approval waiting for a human. */
    rememberApproval(approval: RestartApproval): void;
    /** Drop an approval once it is decided. */
    forgetApproval(id: string): void;
    /** Remember (or clear, with an empty set) the runtime tool deny list. */
    rememberDeniedTools(tools: readonly string[]): void;
    /** Note that a turn started; the boot after a crash still sees it. */
    startTurn(turn: RestartTurn): void;
    /** Note that a turn finished, so a clean shutdown leaves nothing behind. */
    endTurn(chatId: string): void;
    /** Remember the message id of a card the bridge keeps updating. */
    rememberCard(card: RestartCard): void;
    /** Forget a card that is gone (recalled, replaced, session closed). */
    forgetCard(chatId: string, kind: string): void;
}
/**
 * Build the store the bridge drives.
 * @param home - harness home override (tests).
 * @returns the store.
 */
export declare function createRestartStore(home?: string): RestartStore;
//# sourceMappingURL=restart-state.d.ts.map