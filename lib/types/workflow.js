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
/** The tool name the model calls to run a workflow script. */
export const WORKFLOW_TOOL_NAME = 'workflow';
/** Shown when the call arguments carry no readable run name. */
const UNNAMED_RUN = '未命名';
/**
 * Read the run name out of a `workflow` tool call's arguments.
 *
 * The card opens on `tool/call`, seconds before the durable run-start event
 * arrives, so the name has to come from the call itself. The arguments are
 * model-produced and untrusted: anything unparseable degrades to a neutral
 * label rather than throwing into the event stream.
 * @param argumentsJson - the raw arguments JSON the model produced.
 * @returns the run name, or a neutral fallback.
 */
export function workflowNameFromArguments(argumentsJson) {
    try {
        const args = JSON.parse(argumentsJson);
        const name = args.meta?.name;
        if (typeof name !== 'string')
            return UNNAMED_RUN;
        const trimmed = name.trim();
        return trimmed === '' ? UNNAMED_RUN : trimmed;
    }
    catch {
        return UNNAMED_RUN;
    }
}
//# sourceMappingURL=workflow.js.map