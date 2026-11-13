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
import { messageTimeStamp } from "./clock.js";
/** How far back the bridge is willing to surface a missed occurrence. */
export const DEFAULT_OVERDUE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * How late an occurrence may be before it counts as missed.
 *
 * 调度器本来就会晚几十秒到一两分钟才真正触发（它靠后续事件追赶，不是到点就发）。
 * 把这点延误叫「漏发」是噪音——2026-11-10 那条「已经晚了 0 分钟」的卡片就是这事。
 *
 * 默认 **5 分钟**：运营方 2026-11-13 要求「晚了 5 分钟才提醒」——2 分钟的容差把
 * 一次正常的晚触发报成了漏发。可用 `overdueToleranceMinutes` 调整。
 */
export const OVERDUE_TOLERANCE_MS = 5 * 60 * 1000;
/**
 * The newest delivery a row recorded, from either place it stores one.
 *
 * `deliveryHistory.records` is authoritative when present: on an `every` row the
 * top-level `lastDelivery` can lag behind it.
 * @param row - the stored task row.
 * @returns the newest recorded delivery, or undefined.
 */
function lastRecordedDelivery(row) {
    let best = row.lastDelivery;
    let bestAt = best?.deliveredAt === undefined ? undefined : Date.parse(best.deliveredAt);
    for (const candidate of row.deliveryHistory?.records ?? []) {
        const at = candidate.deliveredAt === undefined ? undefined : Date.parse(candidate.deliveredAt);
        if (at === undefined)
            continue;
        if (bestAt === undefined || at > bestAt) {
            best = candidate;
            bestAt = at;
        }
    }
    return best;
}
/**
 * List the occurrences the host should have delivered and did not.
 *
 * Two shapes of row, two answers:
 *
 * - **One-shot** (`after`): delivered only when a record names this exact
 *   occurrence. Comparing "is there any delivery at all" would hide every miss
 *   on a repeating task after its first successful run.
 * - **`every`**: `scheduledAt` is the NEXT firing and moves forward each time
 *   one lands, so "record.scheduledAt was delivered" is unanswerable — after any
 *   early delivery (a restart catching up, a manual re-run) the top-level
 *   record no longer names the upcoming instant at all. The row was announced
 *   as overdue forever on 2026-11-10 for exactly this reason. What is decidable
 *   is whether the instant has already been overtaken: a firing at or after it
 *   means it was covered, and the next one is still ahead.
 *
 * @param tasks - rows keyed by id, as stored.
 * @param now - current time in epoch ms.
 * @param windowMs - how far back to look.
 * @param toleranceMs - how late still counts as on time.
 * @returns the overdue occurrences, oldest first.
 */
export function overdueTasks(tasks, now, windowMs = DEFAULT_OVERDUE_WINDOW_MS, toleranceMs = OVERDUE_TOLERANCE_MS) {
    const found = [];
    for (const [key, row] of Object.entries(tasks)) {
        if (row.status !== 'active')
            continue;
        const record = row.record;
        if (record === undefined || record.scheduledAt === undefined)
            continue;
        // `after` tasks are one-shots that already fired; `inactive` is checked
        // above. A daily/every/after row with a past `scheduledAt` and no matching
        // delivery is the case this module exists for.
        const due = Date.parse(record.scheduledAt);
        if (!Number.isFinite(due))
            continue;
        const overdueMs = now - due;
        if (overdueMs <= toleranceMs)
            continue;
        if (overdueMs > windowMs)
            continue;
        // A row was fired for THIS instant when a record names it exactly (one-shot),
        // or when the cadence has already carried it past this instant (`every`).
        if (record.everySeconds === undefined) {
            if (lastRecordedDelivery(row)?.scheduledAt === record.scheduledAt)
                continue;
        }
        else if (isOvertaken(row, due)) {
            continue;
        }
        const id = record.id ?? key;
        const sessionId = row.target?.sessionId ?? row.sessionId;
        found.push({
            id,
            title: record.title ?? id,
            prompt: record.prompt ?? '',
            ...sessionId === undefined ? {} : { sessionId },
            scheduledAt: record.scheduledAt,
            overdueMs,
        });
    }
    return found.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
}
/**
 * Whether a repeating row's instant has already been covered.
 *
 * Each firing is recorded with the instant it belonged to. On an `every` row
 * that instant may be one the row has since moved past, but the FACT that a
 * firing belongs to an instant at or after `due` is what matters: the cadence
 * reached it. A record only ever gets older than `due` when several firings
 * were skipped — which is a genuine gap and must still be announced.
 * @param row - the stored task row.
 * @param due - the instant currently recorded as next.
 * @returns true when some recorded firing covers `due`.
 */
function isOvertaken(row, due) {
    for (const candidate of row.deliveryHistory?.records ?? []) {
        const at = candidate.scheduledAt === undefined ? undefined : Date.parse(candidate.scheduledAt);
        if (at !== undefined && at >= due)
            return true;
    }
    const top = row.lastDelivery?.scheduledAt === undefined ? undefined : Date.parse(row.lastDelivery.scheduledAt);
    return top !== undefined && top >= due;
}
/**
 * The chat one bound session id belongs to.
 *
 * Bridge session ids carry their chat: `feishu-oc_xxx:round` or a plain
 * `oc_xxx` facet. A row that names no session has no chat to surface in — the
 * caller decides what to do with that, this only reports it.
 * @param sessionId - a session id from the schedule row.
 * @returns the chat id, or undefined when the id carries none.
 */
export function chatOfSession(sessionId) {
    if (sessionId === undefined)
        return undefined;
    const marker = 'feishu-';
    const rest = sessionId.startsWith(marker) ? sessionId.slice(marker.length) : sessionId;
    const chat = rest.split(':')[0];
    return chat === undefined || chat === '' ? undefined : chat;
}
/** The card-button payload the bridge uses to run a missed occurrence. */
export const OVERDUE_ACTION = 'dsh-lark-bridge/schedule-overdue';
/**
 * Narrow an arbitrary card-action value to this plugin's overdue payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function overdueActionValue(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    if (record.kind !== OVERDUE_ACTION)
        return undefined;
    if (typeof record.key !== 'string' || typeof record.sessionId !== 'string')
        return undefined;
    return { kind: OVERDUE_ACTION, key: record.key, sessionId: record.sessionId };
}
/** `37 分钟` / `2 小时` — lateness a reader can judge without arithmetic. */
function describeLateness(ms) {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60)
        return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
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
export function localDue(iso) {
    const at = Date.parse(iso);
    return Number.isFinite(at) ? messageTimeStamp(at) ?? iso : iso;
}
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
export function overdueCard(task, chatId) {
    const key = `${task.id}@${task.scheduledAt}`;
    return {
        config: { wide_screen_mode: true },
        header: { template: 'orange', title: { tag: 'plain_text', content: '⏰ 定时任务漏发了' } },
        elements: [
            {
                tag: 'div',
                text: { tag: 'lark_md', content: `**${task.title}**\n本应在 ${localDue(task.scheduledAt)} 执行，已经晚了 ${describeLateness(task.overdueMs)}。` },
            },
            {
                tag: 'action',
                actions: [{
                        tag: 'button',
                        text: { tag: 'plain_text', content: '现在执行' },
                        type: 'primary',
                        value: {
                            kind: OVERDUE_ACTION,
                            key,
                            sessionId: task.sessionId ?? `feishu-${chatId}`,
                        },
                    }],
            },
        ],
    };
}
//# sourceMappingURL=schedule-watchdog.js.map