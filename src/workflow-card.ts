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

import type {
  WorkflowAgentEnd,
  WorkflowAgentStart,
  WorkflowRunEnd,
  WorkflowRunStart,
} from './workflow.ts'

/** The transport surface a workflow card needs: send it, then replace it. */
export interface WorkflowCardPort {
  send(chatId: string, input: { card: object }): Promise<{ messageId: string }>
  /** Replace a sent card's content in place; absent on a test double that does not model it. */
  updateCard?(messageId: string, card: object): Promise<void>
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
  readonly coalesceMs?: number
  /** How many failing members are named before the rest become a count. */
  readonly maxNamedFailures?: number
  /** Report a send or update failure. */
  readonly onFailure?: (error: unknown) => void
}

/** Everything one run has to tell the reader. */
interface RunState {
  readonly chatId: string
  readonly name: string
  readonly beganAt: number
  phase?: string
  started: number
  completed: number
  failed: number
  cancelled: number
  /** Member labels by event `seq`, so a settlement can name what failed. */
  readonly labels: Map<number, string>
  /** Names of failed members, in failure order. */
  readonly failedLabels: string[]
  ended?: { readonly reason: WorkflowRunEnd['stopReason']; readonly at: number } | undefined
}

/** The card message a chat currently owns, and the run it is showing. */
interface CardSlot {
  readonly messageId: string
  runId: string
}

/** The surface the bridge drives as workflow events arrive. */
export interface WorkflowCard {
  /** A run opened: show its card at once, then coalesce. */
  runStart(run: WorkflowRunStart, chatId: string): void
  /** The run entered a named phase. */
  phase(runId: string, title: string): void
  /** A member started. */
  agentStart(agent: WorkflowAgentStart): void
  /** A member settled. */
  agentEnd(agent: WorkflowAgentEnd): void
  /** A run closed: write the final card. */
  runEnd(run: WorkflowRunEnd): void
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
  isActive(chatId: string): boolean
  /** Cancel pending writes and forget every run. */
  dispose(): void
}

/** `2m13s` / `45s` — a run's elapsed time, at the resolution a reader cares about. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}

/** The header line and template, which say at a glance whether to worry. */
function headline(state: RunState): { title: string; template: string } {
  const name = `工作流「${state.name}」`
  if (state.ended === undefined) return { title: `🧩 ${name}`, template: 'blue' }
  switch (state.ended.reason) {
    case 'completed': return { title: `✅ ${name}完成`, template: 'green' }
    case 'cancelled': return { title: `⏹️ ${name}已取消`, template: 'grey' }
    case 'error': return { title: `⚠️ ${name}出错`, template: 'red' }
  }
}

/**
 * Render one run's card.
 *
 * Order is deliberate: the phase answers "where is it", the counters answer
 * "how far", and only then do the failures appear — a reader who sees a red
 * count immediately wants the names, and a run with no failures stays two lines.
 * @param state - the run as it currently stands.
 * @param maxNamedFailures - how many failing members to name.
 * @param now - the moment the card is drawn, for the elapsed time.
 * @returns a Feishu card object for `send({ card })` / `updateCard`.
 */
function workflowCard(state: RunState, maxNamedFailures: number, now: number): object {
  const { title, template } = headline(state)
  const elements: object[] = []

  if (state.phase !== undefined && state.phase !== '') {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**阶段** ${state.phase}` } })
  }

  const counts = [`启动 ${state.started}`]
  if (state.completed > 0) counts.push(`✅ ${state.completed}`)
  if (state.failed > 0) counts.push(`❌ ${state.failed}`)
  if (state.cancelled > 0) counts.push(`⏹️ ${state.cancelled}`)
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: counts.join(' · ') } })

  if (state.failedLabels.length > 0) {
    const named = state.failedLabels.slice(0, maxNamedFailures)
    const rest = state.failedLabels.length - named.length
    const list = rest > 0 ? `${named.join('、')} 等 ${state.failedLabels.length} 个` : named.join('、')
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**失败** ${list}` } })
  }

  const elapsed = formatDuration((state.ended?.at ?? now) - state.beganAt)
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: state.ended === undefined ? `进行中 · 已用 ${elapsed}` : `用时 ${elapsed}` }],
  })

  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  }
}

/**
 * Build the coalescing workflow card writer.
 * @param port - how to send and update the card.
 * @param options - coalesce window, failure-name budget, failure reporting.
 * @returns the card writer the bridge drives.
 */
export function createWorkflowCard(
  port: WorkflowCardPort,
  options: WorkflowCardOptions = {},
): WorkflowCard {
  const coalesceMs = options.coalesceMs ?? 1_200
  const maxNamedFailures = options.maxNamedFailures ?? 5
  const onFailure = options.onFailure ?? (() => {})

  const runs = new Map<string, RunState>()
  /** One card per chat: a second run reuses and overwrites the first one's card. */
  const cards = new Map<string, CardSlot>()
  /** Pending coalesced write per run. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Serialises writes per chat so a slow update cannot land out of order. */
  const writing = new Map<string, Promise<void>>()
  /** A write that arrived while another was in flight. */
  const again = new Set<string>()

  const clearTimer = (runId: string): void => {
    const timer = timers.get(runId)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(runId)
  }

  const write = (runId: string, state: RunState, final: boolean): void => {
    const card = workflowCard(state, maxNamedFailures, Date.now())
    const previous = writing.get(state.chatId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const slot = cards.get(state.chatId)
      if (slot === undefined) {
        const sent = await port.send(state.chatId, { card })
        cards.set(state.chatId, { messageId: sent.messageId, runId })
        return
      }
      slot.runId = runId
      if (port.updateCard === undefined) return
      await port.updateCard(slot.messageId, card)
    }).catch((error: unknown) => {
      // A card that failed to write must not take the run down: the answer
      // still arrives, and the next event retries the write.
      onFailure(error)
      if (final) cards.delete(state.chatId)
    }).finally(() => {
      if (writing.get(state.chatId) === next) writing.delete(state.chatId)
    })
    writing.set(state.chatId, next)
  }

  const schedule = (runId: string, state: RunState): void => {
    if (timers.has(runId)) return
    const timer = setTimeout(() => {
      timers.delete(runId)
      if (again.has(state.chatId)) {
        again.delete(state.chatId)
      }
      write(runId, state, false)
    }, coalesceMs)
    // A pending window must never hold the process open.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    timers.set(runId, timer)
  }

  return {
    runStart(run, chatId) {
      // A re-delivered run-start must not reset a run that is already counting.
      if (runs.has(run.runId)) return
      const state: RunState = {
        chatId,
        name: run.name,
        beganAt: Date.now(),
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        labels: new Map(),
        failedLabels: [],
      }
      runs.set(run.runId, state)
      // The opening card is written immediately: it is the reader's proof that
      // the fan-out started, and a 1.2 s silence at the start reads as a hang.
      write(run.runId, state, false)
    },
    phase(runId, title) {
      const state = runs.get(runId)
      if (state === undefined) return
      state.phase = title
      schedule(runId, state)
    },
    agentStart(agent) {
      const state = runs.get(agent.runId)
      if (state === undefined) return
      state.started += 1
      state.labels.set(agent.seq, agent.label)
      schedule(agent.runId, state)
    },
    agentEnd(agent) {
      const state = runs.get(agent.runId)
      if (state === undefined) return
      if (agent.outcome === 'completed') state.completed += 1
      else if (agent.outcome === 'failed') {
        state.failed += 1
        const label = state.labels.get(agent.seq)
        state.failedLabels.push(label === undefined ? `#${agent.seq}` : label)
      } else state.cancelled += 1
      schedule(agent.runId, state)
    },
    runEnd(run) {
      const state = runs.get(run.runId)
      if (state === undefined) return
      clearTimer(run.runId)
      state.ended = { reason: run.stopReason, at: Date.now() }
      runs.delete(run.runId)
      write(run.runId, state, true)
    },
    isActive(chatId) {
      for (const state of runs.values()) {
        if (state.chatId === chatId) return true
      }
      return false
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      runs.clear()
      cards.clear()
      again.clear()
    },
  }
}
