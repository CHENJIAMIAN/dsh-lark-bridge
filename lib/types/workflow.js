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
/** A workflow narration line (live `workflow/log` event). */
export function workflowLogLine(message) {
    return `📝 ${message}`;
}
//# sourceMappingURL=workflow.js.map