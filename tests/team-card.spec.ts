import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'
import {
  isTeamMemberEvent,
  isTeamMessageDeliveredEvent,
  isTeamMessageEvent,
  isTeamTaskEvent,
} from '../src/host.ts'
import { addTeamMember, addTeamMessage, addTeamTask, createTeamState, renderTeamCard } from '../src/team-card.ts'
import type { HostSessionEvent } from '../src/host.ts'

/** A member snapshot as the host records it. */
const MEMBER = {
  id: 'ses_1',
  name: 'RESEARCHER',
  description: '查资料',
  provider: 'deepseek',
  context: 'fresh' as const,
  phase: 'active' as const,
}

/** A task snapshot as the host records it. */
const TASK = {
  id: 'task_1',
  revision: 3,
  subject: 'GATHER-SAMPLES',
  description: '三条以上',
  status: 'in_progress' as const,
  ownerId: 'ses_1',
  blockedBy: [],
  writeScopes: [],
}

/** Wrap a payload in the event shape the host delivers. */
function event(type: string, data: unknown): HostSessionEvent {
  return { type, data }
}

describe('the team events are recognised as the host writes them', () => {
  it('reads a member event', () => {
    expect(isTeamMemberEvent(event('team/member', { version: 2, teamId: 't1', member: MEMBER }))).toBe(true)
  })

  it('reads a task event', () => {
    expect(isTeamTaskEvent(event('team/task', { version: 2, teamId: 't1', task: TASK }))).toBe(true)
  })

  it('reads a queued message', () => {
    const message = { id: 'm1', senderId: 'ses_1', senderName: '研究员', targetId: 'ses_2', content: [{ type: 'text', text: '找到了' }] }
    expect(isTeamMessageEvent(event('team/message/queued', { version: 2, teamId: 't1', message }))).toBe(true)
  })

  it('reads a delivery acknowledgement', () => {
    expect(isTeamMessageDeliveredEvent(event('team/message/delivered', { version: 2, teamId: 't1', messageId: 'm1', targetId: 'ses_2' }))).toBe(true)
  })

  it('ignores a payload that is not the version the host writes', () => {
    expect(isTeamMemberEvent(event('team/member', { version: 1, teamId: 't1', member: MEMBER }))).toBe(false)
    expect(isTeamTaskEvent(event('team/task', { version: 2, teamId: 't1' }))).toBe(false)
    expect(isTeamMessageEvent(event('team/message/queued', { teamId: 't1' }))).toBe(false)
  })

  it('ignores an event of another kind', () => {
    expect(isTeamMemberEvent(event('subagent/end', { version: 2, teamId: 't1', member: MEMBER }))).toBe(false)
  })
})

describe('the team card shows what the team is doing', () => {
  it('lists the members, the shared tasks and the mailbox', () => {
    const state = createTeamState('t1')
    addTeamMember(state, MEMBER)
    addTeamTask(state, TASK)
    addTeamMessage(state, { id: 'm1', senderId: 'ses_1', senderName: '研究员', targetId: 'ses_2', content: [{ type: 'text', text: '找到了' }] })
    const card = JSON.stringify(renderTeamCard(state))
    expect(card).toContain('RESEARCHER')
    expect(card).toContain('GATHER-SAMPLES')
    expect(card).toContain('找到了')
  })

  it('shows a member that failed as failed', () => {
    const state = createTeamState('t1')
    addTeamMember(state, { ...MEMBER, phase: 'failed', error: 'provider refused' })
    const card = JSON.stringify(renderTeamCard(state))
    expect(card).toContain('失败')
    expect(card).toContain('provider refused')
  })
})

describe('a team event reaches the chat as a card', () => {
  it('sends the team card when the lead session records a member', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const before = harness.fake.sent.length
    // The host appends the member to the session that leads the team.
    harness.ctx.emit('session/event', session, { type: 'team/member', data: { version: 2, teamId: 't1', member: MEMBER } })
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(before) }, { timeout: 8_000, interval: 50 })
    const last = harness.fake.sent[harness.fake.sent.length - 1]!.input as { card?: object }
    expect(last.card).toBeDefined()
    expect(JSON.stringify(last.card)).toContain('RESEARCHER')
    await harness.dispose()
  })
})
