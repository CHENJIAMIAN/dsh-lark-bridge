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
  readonly runId: string
  readonly name: string
}

/** One workflow member (from `tool-workflow/agent-start`). */
export interface WorkflowAgentStart {
  readonly runId: string
  readonly seq: number
  readonly label: string
}

/** One workflow member settlement (from `tool-workflow/agent-end`). */
export interface WorkflowAgentEnd {
  readonly runId: string
  readonly seq: number
  readonly outcome: 'completed' | 'failed' | 'cancelled'
}

/** One workflow run close (from `tool-workflow/run-end`). */
export interface WorkflowRunEnd {
  readonly runId: string
  readonly stopReason: 'completed' | 'cancelled' | 'error'
}

/** A workflow narration line (live `workflow/log` event). */
export function workflowLogLine(message: string): string {
  return `📝 ${message}`
}

/** The tool name the model calls to run a workflow script. */
export const WORKFLOW_TOOL_NAME = 'workflow'

/** Shown when the call arguments carry no readable run name. */
const UNNAMED_RUN = '未命名'

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
export function workflowNameFromArguments(argumentsJson: string): string {
  try {
    const args = JSON.parse(argumentsJson) as { meta?: { name?: unknown } }
    const name = args.meta?.name
    if (typeof name !== 'string') return UNNAMED_RUN
    const trimmed = name.trim()
    return trimmed === '' ? UNNAMED_RUN : trimmed
  } catch {
    return UNNAMED_RUN
  }
}
