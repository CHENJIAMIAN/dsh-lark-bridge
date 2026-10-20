/**
 * Tracks one team's members, shared tasks and mailbox, and renders them as a
 * single updatable Feishu card.
 *
 * The host writes the four team events into the Team Lead session — the
 * session that owns the team — so a chat that leads a team sees them as
 * ordinary session events. This module turns those events into one card a
 * reader can watch: who joined, what the shared tasks are, and what passed
 * between the members.
 *
 * The shapes come from the host's `agent-team` package (`types.ts`), which
 * versions every event at 2. A payload that does not carry that version is
 * not this host's shape, and is ignored rather than rendered half-right.
 * @module dsh-lark-bridge/team-card
 */

import type { TeamMemberSnapshot, TeamTaskSnapshot, TeamMessageSnapshot } from './host.ts'

/** The lifecycle phase a team member is in. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** The state a shared task is in. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** One member of the team, as the card shows it. */
export interface TeamMemberEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** One shared task, as the card shows it. */
export interface TeamTaskEntry {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: string
  readonly blockedBy: readonly string[]
}

/** One mailbox message, as the card shows it. */
export interface TeamMessageEntry {
  readonly id: string
  readonly senderName: string
  readonly targetId: string
  readonly content: string
  readonly delivered: boolean
}

/** Everything one chat's card shows. */
export interface TeamCardState {
  /** The team this card is about. */
  readonly teamId: string
  /** Members by id, in join order. */
  readonly members: Map<string, TeamMemberEntry>
  /** Shared tasks by id. */
  readonly tasks: Map<string, TeamTaskEntry>
  /** Mailbox messages by id, newest last. */
  readonly messages: Map<string, TeamMessageEntry>
}

/** How many mailbox messages the card keeps. */
export const TEAM_MESSAGE_MAX = 20

/** A fresh card state for one team. */
export function createTeamState(teamId: string): TeamCardState {
  return { teamId, members: new Map(), tasks: new Map(), messages: new Map() }
}

/**
 * Fold a member snapshot into the state.
 * @param state - the card state to update.
 * @param member - the member as the host recorded it.
 */
export function addTeamMember(state: TeamCardState, member: TeamMemberSnapshot): void {
  state.members.set(member.id, {
    id: member.id,
    name: member.name,
    description: member.description,
    provider: member.provider,
    phase: member.phase,
    ...member.error === undefined ? {} : { error: member.error },
  })
}

/**
 * Fold a shared-task snapshot into the state.
 * @param state - the card state to update.
 * @param task - the task as the host recorded it.
 */
export function addTeamTask(state: TeamCardState, task: TeamTaskSnapshot): void {
  state.tasks.set(task.id, {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...task.ownerId === undefined ? {} : { ownerId: task.ownerId },
    blockedBy: [...task.blockedBy],
  })
}

/**
 * Fold a queued mailbox message into the state.
 * @param state - the card state to update.
 * @param message - the message as the host recorded it.
 */
export function addTeamMessage(state: TeamCardState, message: TeamMessageSnapshot): void {
  state.messages.set(message.id, {
    id: message.id,
    senderName: message.senderName,
    targetId: message.targetId,
    content: teamContentText(message.content),
    delivered: false,
  })
  // The card keeps the tail: a mailbox that never forgets is a wall of text.
  while (state.messages.size > TEAM_MESSAGE_MAX) {
    const oldest = state.messages.keys().next()
    if (oldest.done === true) break
    state.messages.delete(oldest.value)
  }
}

/**
 * The prefix the team package puts on a relayed message's first block.
 *
 * The sender's own name is in it, and the rest of the message follows in the
 * blocks after it, so the prefix is removed rather than shown twice.
 */
const RELAY_PREFIX = /^Team message from ([^:]+):\s*/

/**
 * Fold a message a teammate relayed into the state.
 *
 * The team package does not record a mailbox event when one member messages
 * another; it steers the message into the target's inbox, and it arrives as
 * a `user/message` whose source names the sender. The name is resolved
 * against the roster, because the event carries the sender's session id.
 * @param state - the card state to update.
 * @param message - the relayed message, as the host delivered it.
 * @param senderSessionId - the session that sent it.
 */
export function addTeamRelayMessage(
  state: TeamCardState,
  message: { readonly id: string; readonly content: readonly { readonly type?: string; readonly text?: string }[] },
  senderSessionId: string | undefined,
): void {
  const raw = teamContentText(message.content)
  const match = RELAY_PREFIX.exec(raw)
  const senderName = match?.[1] ?? (senderSessionId === undefined ? '队友' : state.members.get(senderSessionId)?.name ?? '队友')
  const content = match === null ? raw : raw.slice(match[0].length)
  state.messages.set(message.id, {
    id: message.id,
    senderName,
    targetId: senderSessionId ?? '',
    content,
    delivered: true,
  })
  while (state.messages.size > TEAM_MESSAGE_MAX) {
    const oldest = state.messages.keys().next()
    if (oldest.done === true) break
    state.messages.delete(oldest.value)
  }
}

/**
 * Mark a message as acknowledged by the session that recorded it.
 * @param state - the card state to update.
 * @param messageId - the acknowledged message.
 */
export function markTeamMessageDelivered(state: TeamCardState, messageId: string): void {
  const message = state.messages.get(messageId)
  if (message === undefined) return
  state.messages.set(messageId, { ...message, delivered: true })
}

/**
 * The text of a message, flattened from the host's content blocks.
 * @param blocks - the content blocks the host recorded.
 * @returns one line of readable text.
 */
export function teamContentText(blocks: readonly { readonly type?: string; readonly text?: string }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block?.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/** The mark a member's phase is shown with. */
function memberMark(phase: TeamMemberPhase): string {
  if (phase === 'active') return '🟢'
  if (phase === 'failed') return '🔴'
  return '⏳'
}

/** The text a member's phase is shown with. */
function memberPhaseText(phase: TeamMemberPhase): string {
  if (phase === 'active') return '在岗'
  if (phase === 'failed') return '失败'
  return '准备中'
}

/** The mark a task's status is shown with. */
function taskMark(status: TeamTaskStatus): string {
  if (status === 'completed') return '✅'
  if (status === 'in_progress') return '🔨'
  if (status === 'deleted') return '🗑️'
  return '⏳'
}

/**
 * Render the card for one team.
 * @param state - the card state.
 * @returns the card object the transport sends.
 */
export function renderTeamCard(state: TeamCardState): object {
  const memberRows: string[] = []
  for (const member of state.members.values()) {
    const detail = member.description === '' ? member.provider : `${member.description}`
    const failure = member.error === undefined ? '' : `（${member.error}）`
    memberRows.push(` ${memberMark(member.phase)} **${member.name}** · ${memberPhaseText(member.phase)} · ${detail}${failure}`)
  }
  const taskRows: string[] = []
  for (const task of state.tasks.values()) {
    if (task.status === 'deleted') continue
    const blocked = task.blockedBy.length === 0 ? '' : ` · 被 ${task.blockedBy.length} 项阻塞`
    taskRows.push(` ${taskMark(task.status)} **${task.subject}**${blocked}`)
  }
  const messageRows: string[] = []
  for (const message of state.messages.values()) {
    const mark = message.delivered ? '📨' : '📥'
    messageRows.push(` ${mark} ${message.senderName}: ${message.content}`)
  }

  const elements: object[] = []
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: memberRows.length === 0 ? '（暂无成员）' : memberRows.join('\n') } })
  if (taskRows.length > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**共享任务**\n${taskRows.join('\n')}` } })
  }
  if (messageRows.length > 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**往来消息**\n${messageRows.join('\n')}` } })
  }

  const active = [...state.members.values()].filter(member => member.phase === 'active').length
  const running = [...state.tasks.values()].filter(task => task.status === 'in_progress').length
  return {
    config: { wide_screen_mode: true },
    header: {
      template: running > 0 ? 'purple' : 'grey',
      title: { tag: 'plain_text', content: `👥 团队面板（${active} 在岗 / ${running} 进行中）` },
    },
    elements,
  }
}
