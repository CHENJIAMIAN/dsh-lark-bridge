/**
 * One workflow run as one live card, instead of a line per event.
 *
 * A fan-out is not a story: 68 members produce 136 start/end events plus a
 * phase and a closing line, and posting them as chat messages means the reader
 * scrolls past a wall of "chunk-N.txt 启动…" to find the one fact they wanted —
 * whether it is done, and what broke. Worse, the subagent channel was already
 * announcing the same members under a different label, so every delegation was
 * reported twice.
 *
 * So the chat gets ONE card per run, updated in place: the phase it is in, how
 * many members have started / finished / failed, and the names of the failures.
 * Updates are coalesced because a fan-out of eight settles inside a second and
 * a card rewritten eight times a second is rate-limited by Feishu and unreadable
 * anyway.
 *
 * The card deliberately keeps no member list. A reader does not scan 68 names;
 * they ask "is it done" and "what broke". Everything else is arithmetic.
 * @module dsh-lark-bridge/workflow-card
 */
import type { WorkflowAgentEnd, WorkflowAgentStart, WorkflowRunEnd, WorkflowRunStart } from './workflow.ts';
/** The transport surface a workflow card needs: send it, then replace it. */
export interface WorkflowCardPort {
    send(chatId: string, input: {
        card: object;
    }): Promise<{
        messageId: string;
    }>;
    /** Replace a sent card's content in place; absent on a test double that does not model it. */
    updateCard?(messageId: string, card: object): Promise<void>;
}
/** Tuning for {@link createWorkflowCard}. */
export interface WorkflowCardOptions {
    /**
     * How long card writes are coalesced.
     *
     * Defaults to 1.2 s. Shorter and a fan-out rewrites the card faster than a
     * reader can follow (and than Feishu will accept); longer and the card looks
     * frozen while the run is clearly moving.
     */
    readonly coalesceMs?: number;
    /** How many failing members are named before the rest become a count. */
    readonly maxNamedFailures?: number;
    /** Report a send or update failure. */
    readonly onFailure?: (error: unknown) => void;
}
/** The surface the bridge drives as workflow events arrive. */
export interface WorkflowCard {
    /** A run opened: show its card at once, then coalesce. */
    runStart(run: WorkflowRunStart, chatId: string): void;
    /** The run entered a named phase. */
    phase(runId: string, title: string): void;
    /** A member started. */
    agentStart(agent: WorkflowAgentStart): void;
    /** A member settled. */
    agentEnd(agent: WorkflowAgentEnd): void;
    /** A run closed: write the final card. */
    runEnd(run: WorkflowRunEnd): void;
    /**
     * Whether this chat is inside a running workflow.
     *
     * While true the bridge suppresses its per-delegation announcement: the card
     * already says a member started, and the subagent channel reports the SAME
     * delegation under a different label — two voices for one event is most of
     * why the chat looked like noise.
     * @param chatId - the chat to test.
     * @returns true while a run on that chat has not ended.
     */
    isActive(chatId: string): boolean;
    /** Cancel pending writes and forget every run. */
    dispose(): void;
}
/**
 * Build the coalescing workflow card writer.
 * @param port - how to send and update the card.
 * @param options - coalesce window, failure-name budget, failure reporting.
 * @returns the card writer the bridge drives.
 */
export declare function createWorkflowCard(port: WorkflowCardPort, options?: WorkflowCardOptions): WorkflowCard;
//# sourceMappingURL=workflow-card.d.ts.map