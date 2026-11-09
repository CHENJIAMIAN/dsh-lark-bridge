/**
 * Which conversations still hold an active goal, kept across a host restart.
 *
 * A goal is durable in the session log, but its *continuation authority* is not:
 * after a restart the runtime leaves it `disarmed` and waits for the next human
 * message before re-arming. That is a deliberate safety default, and it is why
 * a long task silently stops being driven the moment the bridge is deployed to.
 *
 * The bridge cannot enumerate the host's goals — the service only answers
 * `get(agent)`, which needs an agent it has not opened yet. So the sessions that
 * matter are recorded here as they become active, and a boot reads this list
 * back to decide which ones to re-open and re-arm.
 *
 * The file is local on purpose: a session id names something on this machine.
 * @module dsh-lark-bridge/goal-watch
 */
/** One conversation the bridge should re-arm after a restart. */
export interface WatchedGoal {
    /** Session the goal lives on. */
    readonly sessionId: string;
    /** Chat its output belongs to — the bridge needs this to rebuild a renderer. */
    readonly chatId: string;
    /** `p2p` or a group kind; carried so a rebuilt binding judges approvals the same way. */
    readonly chatType: string;
    /** Host goal id, when the snapshot carried one. */
    readonly goalId?: string;
    /** Revision seen last, so a stale entry can be told apart from a newer goal. */
    readonly revision?: number;
    /** The objective, for a boot-time log line and nothing else. */
    readonly objective: string;
    /** When this entry was last refreshed (ISO 8601). */
    readonly seenAt: string;
}
/**
 * The harness home the watch file lives in: `DSH_HOME` when set, else `~/.dsh`.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export declare function goalWatchHome(home?: string): string;
/**
 * Path of the watch file.
 * @param home - override for tests.
 * @returns the file path.
 */
export declare function goalWatchFile(home?: string): string;
/** What the store offers the bridge. */
export interface GoalWatchStore {
    /**
     * Record or refresh one conversation's active goal.
     *
     * Refreshing rather than appending is what keeps a long-running goal on one
     * entry: every `goal/change` for it rewrites the same row.
     * @param entry - the conversation and its goal as just observed.
     */
    remember(entry: Omit<WatchedGoal, 'seenAt'>): void;
    /**
     * Drop a conversation, typically because its goal settled or was cleared.
     * @param sessionId - the conversation whose goal is no longer active.
     */
    forget(sessionId: string): void;
    /**
     * Everything worth re-arming after a boot, newest first.
     *
     * Entries whose file is unreadable or corrupt read as empty: a boot that
     * cannot parse this must still start the bridge.
     * @returns the live entries.
     */
    pending(): readonly WatchedGoal[];
}
/**
 * Build the watch store.
 * @param home - harness home override (tests).
 * @returns the store the bridge drives.
 */
export declare function createGoalWatch(home?: string): GoalWatchStore;
//# sourceMappingURL=goal-watch.d.ts.map