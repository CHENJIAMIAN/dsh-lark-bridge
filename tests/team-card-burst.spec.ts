import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * The team roster arrives as a burst of separate session events, each a fresh
 * socket frame, milliseconds apart — far inside one Feishu HTTP round trip.
 * The card is supposed to be sent once and updated in place. These emit the
 * burst the host produces (two members joining back to back) and count the
 * cards that reach the chat.
 */
const MEMBER = {
  id: 'ses_1', name: 'RESEARCHER', description: '查资料', provider: 'deepseek',
  context: 'fresh' as const, phase: 'active' as const,
}

function teamEvent(type: string, data: unknown) {
  return { type, data }
}

describe('the team card is one card per chat', () => {
  it('a burst of two roster events produces ONE card', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const before = harness.fake.sent.length

    // Two members joined. The host appends each as its own event.
    harness.ctx.emit('session/event', session, teamEvent('team/member', { version: 2, teamId: 't1', member: MEMBER }))
    harness.ctx.emit('session/event', session, teamEvent('team/member', {
      version: 2, teamId: 't1', member: { ...MEMBER, id: 'ses_2', name: 'WRITER' },
    }))

    await new Promise((resolve) => setTimeout(resolve, 300))
    const cards = harness.fake.sent.slice(before).filter(s => (s.input as { card?: object }).card !== undefined)
    expect(cards.length).toBe(1)
    await harness.dispose()
  })

  it('a later event updates the one card in place', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const before = harness.fake.sent.length
    harness.ctx.emit('session/event', session, teamEvent('team/member', { version: 2, teamId: 't1', member: MEMBER }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    harness.ctx.emit('session/event', session, teamEvent('team/task', {
      version: 2, teamId: 't1',
      task: { id: 'task_1', revision: 1, subject: 'GATHER', description: 'd', status: 'pending', blockedBy: [], writeScopes: [] },
    }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const cards = harness.fake.sent.slice(before).filter(s => (s.input as { card?: object }).card !== undefined)
    console.log('[probe] cards:', cards.length, '| updates:', harness.fake.updated.length)
    expect(cards.length).toBe(1)
    expect(harness.fake.updated.length).toBeGreaterThanOrEqual(1)
    await harness.dispose()
  })
})
