import { describe, expect, it } from 'vitest'
import { createWorkflowCard } from '../src/workflow-card.ts'

/** Any node the tests walk out of a card. */
interface CardNode {
  tag?: string
  content?: string
  elements?: CardNode[]
  header?: { template?: string; title?: { content?: string } }
  config?: { wide_screen_mode?: boolean }
}

/** A minimal fake port recording sends and in-place updates. */
function fakePort() {
  const sent: { chatId: string; card: object }[] = []
  const updated: { messageId: string; card: object }[] = []
  return {
    sent,
    updated,
    async send(chatId: string, input: { card: object }) {
      sent.push({ chatId, card: input.card })
      return { messageId: `om_${sent.length}` }
    },
    async updateCard(messageId: string, card: object) {
      updated.push({ messageId, card })
    },
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** Wait past the coalescing window so the pending write lands. */
const settle = () => new Promise(resolve => setTimeout(resolve, 40))

/** Every markdown/plain text line a card carries. */
function lines(card: object): string[] {
  const body = (card as { elements?: CardNode[] }).elements ?? []
  const out: string[] = []
  const push = (node: CardNode): void => {
    if (node.content !== undefined) out.push(node.content)
    // A `div` keeps its text under `text.content`, a `note` under its children.
    const text = (node as { text?: { content?: string } }).text
    if (text?.content !== undefined) out.push(text.content)
    for (const child of node.elements ?? []) push(child)
  }
  for (const element of body) push(element)
  return out
}

/** The header title of a card. */
function title(card: object): string | undefined {
  return (card as CardNode).header?.title?.content
}

/** The template (colour) of a card header. */
function template(card: object): string | undefined {
  return (card as CardNode).header?.template
}

describe('workflow card', () => {
  it('opens one card and never posts a message per member', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.runStart({ runId: 'r1', name: 'scan-pitfalls-batch' }, 'oc_chat')
    await tick()

    expect(port.sent).toHaveLength(1)
    expect(title(port.sent[0]!.card)).toContain('scan-pitfalls-batch')
    expect(template(port.sent[0]!.card)).toBe('blue')

    // Eight member events: four starts, four ends.
    for (let seq = 0; seq < 4; seq += 1) {
      card.agentStart({ runId: 'r1', seq, label: `chunk-${65 + seq}.txt` }, 'oc_chat')
    }
    for (let seq = 0; seq < 4; seq += 1) {
      card.agentEnd({ runId: 'r1', seq, outcome: 'completed' }, 'oc_chat')
    }
    await settle()

    // Still ONE message: the card was rewritten, not multiplied.
    expect(port.sent).toHaveLength(1)
    expect(port.updated.length).toBeGreaterThan(0)
    expect(port.updated.length).toBeLessThan(8)

    const last = port.updated.at(-1)!.card
    const body = lines(last).join('\n')
    expect(body).toContain('启动 4')
    expect(body).toContain('✅ 4')

    card.dispose()
  })

  it('names the failures instead of only counting them', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5, maxNamedFailures: 2 })

    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    for (let seq = 0; seq < 4; seq += 1) {
      card.agentStart({ runId: 'r1', seq, label: `chunk-${seq}.txt` }, 'oc_chat')
    }
    card.agentEnd({ runId: 'r1', seq: 1, outcome: 'failed' }, 'oc_chat')
    card.agentEnd({ runId: 'r1', seq: 2, outcome: 'failed' }, 'oc_chat')
    card.agentEnd({ runId: 'r1', seq: 3, outcome: 'failed' }, 'oc_chat')
    await settle()

    const body = lines(port.updated.at(-1)!.card).join('\n')
    // Two named, the third becomes a remainder — a 60-failure run stays one line.
    expect(body).toContain('chunk-1.txt、chunk-2.txt 等 3 个')
    expect(body).not.toContain('chunk-3.txt')

    card.dispose()
  })

  it('shows the phase on the card', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    card.phase('r1', '精读')
    await settle()

    const body = lines(port.updated.at(-1)!.card).join('\n')
    expect(body).toContain('阶段')
    expect(body).toContain('精读')

    card.dispose()
  })

  it('settles the card on the closing reason and reuses it for the next run', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    await tick()
    card.runEnd({ runId: 'r1', stopReason: 'completed' }, 'oc_chat')
    await settle()

    expect(template(port.updated.at(-1)!.card)).toBe('green')
    expect(title(port.updated.at(-1)!.card)).toContain('完成')

    // A second run on the same chat rewrites the same message, not a new one.
    card.runStart({ runId: 'r2', name: 'second' }, 'oc_chat')
    await settle()
    expect(port.sent).toHaveLength(1)
    expect(title(port.updated.at(-1)!.card)).toContain('second')

    card.dispose()
  })

  it('marks a failed run red', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    await tick()
    card.runEnd({ runId: 'r1', stopReason: 'error' }, 'oc_chat')
    await settle()

    expect(template(port.updated.at(-1)!.card)).toBe('red')

    card.dispose()
  })

  it('reports whether a chat is inside a run, so delegation is not announced twice', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    expect(card.isActive('oc_chat')).toBe(false)
    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    expect(card.isActive('oc_chat')).toBe(true)
    expect(card.isActive('oc_other')).toBe(false)

    card.runEnd({ runId: 'r1', stopReason: 'completed' }, 'oc_chat')
    expect(card.isActive('oc_chat')).toBe(false)

    card.dispose()
  })

  it('degrades to the opening card when the port cannot update', async () => {
    const sent: { chatId: string; card: object }[] = []
    const port = {
      async send(chatId: string, input: { card: object }) {
        sent.push({ chatId, card: input.card })
        return { messageId: `om_${sent.length}` }
      },
    }
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    card.agentStart({ runId: 'r1', seq: 0, label: 'chunk-1.txt' }, 'oc_chat')
    await settle()

    expect(sent).toHaveLength(1)
    card.dispose()
  })

  it('puts the card up on the tool call, before any run event exists', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    // This is the whole point: the durable run-start only lands with the tool
    // result, so waiting for it means a long fan-out shows nothing until it is
    // over. The opening card is what the reader sees during the silence.
    card.opening('oc_chat', 'scan-pitfalls-batch')
    await tick()

    expect(port.sent).toHaveLength(1)
    expect(title(port.sent[0]!.card)).toContain('scan-pitfalls-batch')
    expect(title(port.sent[0]!.card)).toContain('启动中')

    card.dispose()
  })

  it('keeps the opening card when the run takes over', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.opening('oc_chat', 'scan')
    await tick()
    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    card.agentStart({ runId: 'r1', seq: 0, label: 'chunk-1.txt' })
    await settle()

    // Same message, rewritten: a run that started under the opening card must
    // not leave two cards behind.
    expect(port.sent).toHaveLength(1)
    expect(port.updated.length).toBeGreaterThan(0)
    expect(title(port.updated.at(-1)!.card)).toContain('scan')
    expect(title(port.updated.at(-1)!.card)).not.toContain('启动中')

    card.dispose()
  })

  it('settles an opening card the run never claimed', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.opening('oc_chat', 'scan')
    await tick()
    card.abandon('oc_chat')
    await settle()

    // Without this the "启动中" card sits forever, which reads as hung.
    expect(title(port.updated.at(-1)!.card)).toContain('没有启动')
    expect(template(port.updated.at(-1)!.card)).toBe('grey')

    card.dispose()
  })

  it('ignores an abandon when no opening card is waiting', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.abandon('oc_chat')
    await settle()

    // Every failed tool calls this; it must not emit anything by itself.
    expect(port.sent).toHaveLength(0)
    expect(port.updated).toHaveLength(0)

    card.dispose()
  })

  it('does not reopen a card while a run owns it', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.runStart({ runId: 'r1', name: 'scan' }, 'oc_chat')
    await tick()
    card.agentStart({ runId: 'r1', seq: 0, label: 'chunk-1.txt' })
    await settle()

    // A second delegation inside the same run must not reset the card to
    // "启动中" and wipe the live counts.
    card.opening('oc_chat', 'other')
    await settle()
    expect(port.updated.at(-1)!.card).not.toBeUndefined()
    expect(JSON.stringify(port.updated.at(-1)!.card)).not.toContain('启动中')

    card.dispose()
  })

  it('ignores events for a run it never opened', async () => {
    const port = fakePort()
    const card = createWorkflowCard(port, { coalesceMs: 5 })

    card.agentStart({ runId: 'ghost', seq: 0, label: 'x' }, 'oc_chat')
    card.agentEnd({ runId: 'ghost', seq: 0, outcome: 'completed' }, 'oc_chat')
    await settle()

    expect(port.sent).toHaveLength(0)
    expect(port.updated).toHaveLength(0)

    card.dispose()
  })
})
