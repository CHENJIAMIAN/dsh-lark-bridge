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
import type { TeamMemberSnapshot, TeamTaskSnapshot, TeamMessageSnapshot } from './host.ts';
/** The lifecycle phase a team member is in. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed';
/** The state a shared task is in. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
/** One member of the team, as the card shows it. */
export interface TeamMemberEntry {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly provider: string;
    readonly phase: TeamMemberPhase;
    readonly error?: string;
}
/** One shared task, as the card shows it. */
export interface TeamTaskEntry {
    readonly id: string;
    readonly subject: string;
    readonly description: string;
    readonly status: TeamTaskStatus;
    readonly ownerId?: string;
    readonly blockedBy: readonly string[];
}
/** One mailbox message, as the card shows it. */
export interface TeamMessageEntry {
    readonly id: string;
    readonly senderName: string;
    readonly targetId: string;
    readonly content: string;
    readonly delivered: boolean;
}
/** Everything one chat's card shows. */
export interface TeamCardState {
    /** The team this card is about. */
    readonly teamId: string;
    /** Members by id, in join order. */
    readonly members: Map<string, TeamMemberEntry>;
    /** Shared tasks by id. */
    readonly tasks: Map<string, TeamTaskEntry>;
    /** Mailbox messages by id, newest last. */
    readonly messages: Map<string, TeamMessageEntry>;
}
/** How many mailbox messages the card keeps. */
export declare const TEAM_MESSAGE_MAX = 20;
/** A fresh card state for one team. */
export declare function createTeamState(teamId: string): TeamCardState;
/**
 * Fold a member snapshot into the state.
 * @param state - the card state to update.
 * @param member - the member as the host recorded it.
 */
export declare function addTeamMember(state: TeamCardState, member: TeamMemberSnapshot): void;
/**
 * Fold a shared-task snapshot into the state.
 * @param state - the card state to update.
 * @param task - the task as the host recorded it.
 */
export declare function addTeamTask(state: TeamCardState, task: TeamTaskSnapshot): void;
/**
 * Fold a queued mailbox message into the state.
 * @param state - the card state to update.
 * @param message - the message as the host recorded it.
 */
export declare function addTeamMessage(state: TeamCardState, message: TeamMessageSnapshot): void;
/**
 * Mark a message as acknowledged by the session that recorded it.
 * @param state - the card state to update.
 * @param messageId - the acknowledged message.
 */
export declare function markTeamMessageDelivered(state: TeamCardState, messageId: string): void;
/**
 * The text of a message, flattened from the host's content blocks.
 * @param blocks - the content blocks the host recorded.
 * @returns one line of readable text.
 */
export declare function teamContentText(blocks: readonly {
    readonly type?: string;
    readonly text?: string;
}[]): string;
/**
 * Render the card for one team.
 * @param state - the card state.
 * @returns the card object the transport sends.
 */
export declare function renderTeamCard(state: TeamCardState): object;
//# sourceMappingURL=team-card.d.ts.map