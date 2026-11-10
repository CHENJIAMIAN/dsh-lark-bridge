/**
 * Which scheduled tasks the host has let slip.
 *
 * The host's own schedule driver is supposed to fire a task when its
 * `scheduledAt` arrives. In practice it does not: the delivery log shows a
 * 09:00 task landing at 15:06, and every other backlogged task landing in the
 * same minute — the driver catches up on some later event rather than on the
 * clock. A task whose moment passed while the process was up stays unsent until
 * something else happens to nudge it.
 *
 * The bridge cannot dispatch a task itself; dispatching means starting an agent
 * turn, which belongs to the host. What it CAN do is notice, and put a "run it
 * now" in front of the human. This module is the noticing half: pure, testable,
 * no filesystem and no clock of its own.
 *
 * "Overdue" is deliberately narrow — active, timed, past due, and with no
 * delivery recorded for that exact occurrence. Anything wider would nag about
 * tasks the human paused or about occurrences the host did deliver.
 * @module dsh-lark-bridge/schedule-watchdog
 */
/** One task row, as `schedule.json` stores it. */
export interface StoredScheduleTask {
    readonly record?: {
        readonly id?: string;
        readonly title?: string;
        readonly kind?: string;
        readonly scheduledAt?: string;
        readonly prompt?: string;
    } | undefined;
    readonly status?: string;
    readonly target?: {
        readonly sessionId?: string;
    } | undefined;
    readonly lastDelivery?: {
        readonly scheduledAt?: string;
    } | undefined;
    /** Where the prompt should go when there is no target session. */
    readonly sessionId?: string;
}
/** One occurrence the bridge should surface. */
export interface OverdueTask {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    /** Session the task is bound to, when the row names one. */
    readonly sessionId?: string;
    /** The occurrence that was never delivered. */
    readonly scheduledAt: string;
    /** How late it is, in milliseconds. */
    readonly overdueMs: number;
}
/** How far back the bridge is willing to surface a missed occurrence. */
export declare const DEFAULT_OVERDUE_WINDOW_MS: number;
/**
 * List the occurrences the host should have delivered and did not.
 *
 * A task counts as delivered only when `lastDelivery.scheduledAt` matches the
 * occurrence exactly. Comparing "is there any delivery at all" would hide every
 * miss on a daily task after its first successful run.
 * @param tasks - rows keyed by id, as stored.
 * @param now - current time in epoch ms.
 * @param windowMs - how far back to look.
 * @returns the overdue occurrences, oldest first.
 */
export declare function overdueTasks(tasks: Readonly<Record<string, StoredScheduleTask>>, now: number, windowMs?: number): OverdueTask[];
/**
 * The chat one bound session id belongs to.
 *
 * Bridge session ids carry their chat: `feishu-oc_xxx:round` or a plain
 * `oc_xxx` facet. A row that names no session has no chat to surface in — the
 * caller decides what to do with that, this only reports it.
 * @param sessionId - a session id from the schedule row.
 * @returns the chat id, or undefined when the id carries none.
 */
export declare function chatOfSession(sessionId: string | undefined): string | undefined;
/** The card-button payload the bridge uses to run a missed occurrence. */
export declare const OVERDUE_ACTION = "dsh-lark-bridge/schedule-overdue";
/** What one overdue card's button carries. */
export interface OverdueActionValue {
    readonly kind: typeof OVERDUE_ACTION;
    /** Occurrence key — task id plus the exact scheduled instant. */
    readonly key: string;
    readonly sessionId: string;
}
/**
 * Narrow an arbitrary card-action value to this plugin's overdue payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export declare function overdueActionValue(value: unknown): OverdueActionValue | undefined;
/**
 * Render a scheduled instant the way a human reads it.
 *
 * `scheduledAt` is an ISO UTC string. Printing it raw produced
 * 「本应在 2026-11-10T04:00:00.000Z 执行，已经晚了 44 分钟」 — the reader sees
 * 04:00 while their clock says 12:44, so the two halves of the sentence look
 * contradictory. Render in the machine's local zone and keep the offset.
 * @param iso - the stored scheduled instant.
 * @returns a local stamp, or the raw string when it cannot be parsed.
 */
export declare function localDue(iso: string): string;
/**
 * Build the card that surfaces one missed occurrence.
 *
 * It offers a button rather than acting: running the task means starting an
 * agent turn, which is the host's authority, and a task the human scheduled for
 * 09:00 being started at 15:06 is exactly the kind of thing somebody may want to
 * decline.
 * @param task - the overdue occurrence.
 * @param chatId - the chat the card lands in.
 * @returns a Feishu card object.
 */
export declare function overdueCard(task: OverdueTask, chatId: string): object;
//# sourceMappingURL=schedule-watchdog.d.ts.map