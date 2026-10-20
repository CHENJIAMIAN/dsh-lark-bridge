import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * The realistic shape: the first card send is a Feishu HTTP round trip, and the
 * next roster event lands 10 ms later — long before that round trip settles.
 * A fake send that returns in one microtask hides this; a fake send with the
 * latency of the real transport does not.
 */
const MEMBER = {
  id: 'ses_1', name: 'RESEARCHER', description: '查资料', provider: 'deepseek',
  context: 'fresh' as const, phase: 'active' as const,
}

describe('team card under production send latency', () => {
  it('one card, even when the second roster event lands inside the first send', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session

    // 50 ms is conservative for a Feishu send; production is 100–500 ms.
    const raw = harness.fake.port.send.bind(harness.fake.port)
    harness.fake.port.send = async (to, input, opts) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return raw(to, input, opts)
    }
    const before = harness.fake.sent.length

    harness.ctx.emit('session/event', session, { type: 'team/member', data: { version: 2, teamId: 't1', member: MEMBER } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    harness.ctx.emit('session/event', session, { type: 'team/member', data: { version: 2, teamId: 't1', member: { ...MEMBER, id: 'ses_2', name: 'WRITER' } } })

    await new Promise((resolve) => setTimeout(resolve, 600))
    const cards = harness.fake.sent.slice(before).filter(s => (s.input as { card?: object }).card !== undefined)
    expect(cards.length).toBe(1)
    await harness.dispose()
  })
})
