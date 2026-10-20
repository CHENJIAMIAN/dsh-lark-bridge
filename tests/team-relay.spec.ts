import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'
import { addTeamMember, addTeamRelayMessage, createTeamState, renderTeamCard } from '../src/team-card.ts'
import { isTeamRelayMessageEvent } from '../src/host.ts'

const MEMBER = {
  id: 'ses_member_1',
  name: 'RESEARCHER',
  description: 'reads',
  provider: 'spawn',
  context: 'fresh' as const,
  phase: 'active' as const,
}

/**
 * The team package does not record a mailbox event when one member messages
 * another. It steers the message into the recipient's inbox, and it lands
 * there as a `user/message` whose source names the sender. A card built from
 * the mailbox events alone would show an empty message list forever.
 */
describe('a message one teammate relayed to another', () => {
  it('is recognised by the shape the host delivers it in', () => {
    const event = {
      type: 'user/message',
      data: {
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'Team message from RESEARCHER: bring the numbers' }],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'ses_member_1' },
        },
      },
    }
    expect(isTeamRelayMessageEvent(event)).toBe(true)
  })

  it('is not confused with a message the chat owner sent', () => {
    const event = {
      type: 'user/message',
      data: {
        message: {
          id: 'msg_2',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'user' },
        },
      },
    }
    expect(isTeamRelayMessageEvent(event)).toBe(false)
  })

  it('reaches the card without the relay prefix repeated', () => {
    const state = createTeamState('t1')
    addTeamMember(state, MEMBER)
    addTeamRelayMessage(
      state,
      { id: 'msg_1', content: [{ type: 'text', text: 'Team message from RESEARCHER: bring the numbers' }] },
      'ses_member_1',
    )
    const card = JSON.stringify(renderTeamCard(state))
    expect(card).toContain('RESEARCHER')
    expect(card).toContain('bring the numbers')
    // The prefix names the sender, which the card already shows.
    expect(card).not.toContain('Team message from')
  })

  it('reaches the chat as part of the team card', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    // The roster event first: the card exists because the chat leads a team.
    harness.ctx.emit('session/event', session, { type: 'team/member', data: { version: 2, teamId: 't1', member: MEMBER } })
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(0) }, { timeout: 8_000, interval: 50 })
    const before = harness.fake.sent.length
    harness.ctx.emit('session/event', session, {
      type: 'user/message',
      data: {
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'Team message from RESEARCHER: bring the numbers' }],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'ses_member_1' },
        },
      },
    })
    await vi.waitFor(() => { expect(harness.fake.updated.length + (harness.fake.sent.length - before)).toBeGreaterThan(0) }, { timeout: 8_000, interval: 50 })
    const all = JSON.stringify(harness.fake.sent) + JSON.stringify(harness.fake.updated)
    expect(all).toContain('bring the numbers')
    await harness.dispose()
  })
})
