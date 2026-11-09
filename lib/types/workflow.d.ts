/**
 * Workflow event shapes and the one line still posted as chat text.
 *
 * A run's progress is a CARD now (see `workflow-card.ts`), not a stream of
 * lines: a fan-out is not a story, and one message per member is a wall to
 * scroll past. What remains here are the event types the bridge mirrors and the
 * narration line `workflow/log` still posts verbatim — a narration is something
 * the workflow script chose to SAY, so it belongs in the chat rather than inside
 * a card that gets rewritten under it.
 * @module dsh-lark-bridge/workflow
 */
/** One workflow run's identity and display name (from `tool-workflow/run-start`). */
export interface WorkflowRunStart {
    readonly runId: string;
    readonly name: string;
}
/** One workflow member (from `tool-workflow/agent-start`). */
export interface WorkflowAgentStart {
    readonly runId: string;
    readonly seq: number;
    readonly label: string;
}
/** One workflow member settlement (from `tool-workflow/agent-end`). */
export interface WorkflowAgentEnd {
    readonly runId: string;
    readonly seq: number;
    readonly outcome: 'completed' | 'failed' | 'cancelled';
}
/** One workflow run close (from `tool-workflow/run-end`). */
export interface WorkflowRunEnd {
    readonly runId: string;
    readonly stopReason: 'completed' | 'cancelled' | 'error';
}
/** A workflow narration line (live `workflow/log` event). */
export declare function workflowLogLine(message: string): string;
//# sourceMappingURL=workflow.d.ts.map