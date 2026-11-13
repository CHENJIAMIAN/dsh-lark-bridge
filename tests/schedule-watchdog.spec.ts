import { describe, expect, it } from 'vitest'
import type { StoredScheduleTask } from '../src/schedule-watchdog.ts'
import { chatOfSession, DEFAULT_OVERDUE_WINDOW_MS, localDue, overdueTasks } from '../src/schedule-watchdog.ts'

const NOW = Date.parse('2026-11-09T12:00:00Z')

/** A daily task due `minutesLate` minutes before now. */
function daily(minutesLate: number, extra: Partial<StoredScheduleTask> = {}): StoredScheduleTask {
  const due = new Date(NOW - minutesLate * 60_000).toISOString()
  return {
    record: { id: 'schedule-1', title: '健康检查', kind: 'daily', scheduledAt: due, prompt: '跑一下' },
    status: 'active',
    target: { sessionId: 'feishu-oc_a:r1' },
    ...extra,
  }
}

describe('overdue schedule detection', () => {
  it('reports an active task whose occurrence passed undelivered', () => {
    const rows = overdueTasks({ k: daily(37) }, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('健康检查')
    expect(rows[0]!.overdueMs).toBe(37 * 60_000)
    expect(rows[0]!.sessionId).toBe('feishu-oc_a:r1')
  })

  it('ignores a task that has not come due yet', () => {
    expect(overdueTasks({ k: daily(-5) }, NOW)).toEqual([])
  })

  it('ignores a task the host already delivered for that exact occurrence', () => {
    const row = daily(37)
    const delivered: StoredScheduleTask = {
      ...row,
      lastDelivery: { scheduledAt: row.record!.scheduledAt },
    }
    expect(overdueTasks({ k: delivered }, NOW)).toEqual([])
  })

  it('still reports a later occurrence after an earlier one was delivered', () => {
    // A daily task delivered yesterday is not a licence to skip today; only an
    // exact timestamp match counts as delivered.
    const row = daily(37)
    const staleDelivery: StoredScheduleTask = {
      ...row,
      lastDelivery: { scheduledAt: new Date(NOW - 24 * 60 * 60_000).toISOString() },
    }
    expect(overdueTasks({ k: staleDelivery }, NOW)).toHaveLength(1)
  })

  it('ignores paused and one-shot rows', () => {
    expect(overdueTasks({ k: { ...daily(37), status: 'inactive' } }, NOW)).toEqual([])
    expect(overdueTasks({ k: { ...daily(37), status: undefined } }, NOW)).toEqual([])
  })

  it('stops nagging past the window', () => {
    const tooOld = DEFAULT_OVERDUE_WINDOW_MS / 60_000 + 60
    expect(overdueTasks({ k: daily(tooOld) }, NOW)).toEqual([])
    expect(overdueTasks({ k: daily(tooOld) }, NOW, 48 * 60 * 60_000)).toHaveLength(1)
  })

  it('ignores rows with no readable time', () => {
    const broken: StoredScheduleTask = {
      record: { id: 'x', title: 'x', scheduledAt: 'not a date' },
      status: 'active',
    }
    expect(overdueTasks({ k: broken }, NOW)).toEqual([])
  })

  it('does not call an every-row missed when the cadence already carried it past', () => {
    // 2026-11-10 现场：每 2 小时的任务因为一次提前投递，scheduledAt 前移到了
    // 20:00，而 lastDelivery 还停在 16:00 那一次上。旧判据只比「相等」，于是
    // 20:00 这个点每轮扫描都被报成漏发——可它 16:00 就执行过了。
    const due = new Date(NOW + 60 * 60_000).toISOString()
    const every: StoredScheduleTask = {
      record: { id: 'every', title: '盯进度', kind: 'every', everySeconds: 7200, scheduledAt: due },
      status: 'active',
      lastDelivery: { scheduledAt: new Date(NOW - 6 * 3600_000).toISOString() },
      deliveryHistory: {
        records: [
          { scheduledAt: new Date(NOW - 6 * 3600_000).toISOString(), deliveredAt: new Date(NOW - 6 * 3600_000).toISOString() },
          { scheduledAt: due, deliveredAt: new Date(NOW - 30 * 60_000).toISOString() },
        ],
      },
    }
    expect(overdueTasks({ k: every }, NOW)).toEqual([])
  })

  it('still reports an every-row whose instants were genuinely skipped', () => {
    // 反过来也要成立：所有交付记录都停在该时间点之前，说明中间那几轮真没跑。
    const due = new Date(NOW - 60 * 60_000).toISOString()
    const skipped: StoredScheduleTask = {
      record: { id: 'every', title: '盯进度', kind: 'every', everySeconds: 7200, scheduledAt: due },
      status: 'active',
      lastDelivery: { scheduledAt: new Date(NOW - 9 * 3600_000).toISOString() },
    }
    expect(overdueTasks({ k: skipped }, NOW)).toHaveLength(1)
  })

  it('does not cry wolf over a firing a few seconds late', () => {
    // 「已经晚了 0 分钟」是 2026-11-10 那条卡片的原话。几秒的抖动不算漏发。
    expect(overdueTasks({ k: daily(1) }, NOW)).toEqual([])
  })

  it('sorts oldest first so the most stale is dealt with first', () => {    const rows = overdueTasks({
      a: daily(10, { record: { id: 'a', title: 'A', scheduledAt: new Date(NOW - 10 * 60_000).toISOString() } }),
      b: daily(90, { record: { id: 'b', title: 'B', scheduledAt: new Date(NOW - 90 * 60_000).toISOString() } }),
    }, NOW)
    expect(rows.map(row => row.id)).toEqual(['b', 'a'])
  })

  it('reads the chat out of a bound session id', () => {
    expect(chatOfSession('feishu-oc_abc:r1')).toBe('oc_abc')
    expect(chatOfSession('oc_abc')).toBe('oc_abc')
    expect(chatOfSession('feishu-oc_abc')).toBe('oc_abc')
    expect(chatOfSession(undefined)).toBeUndefined()
    expect(chatOfSession('')).toBeUndefined()
  })

  it('renders a UTC instant in local time, not as raw ISO', () => {
    // The card used to print `2026-11-10T04:00:00.000Z` while saying "44 分钟",
    // which reads as a contradiction to anyone on +08:00.
    const stamp = localDue('2026-11-10T04:00:00.000Z')
    expect(stamp).not.toContain('T')
    expect(stamp).not.toContain('Z')
    expect(stamp).toContain('+08:00')
  })

  it('falls back to the raw string for an unparseable instant', () => {
    expect(localDue('not a date')).toBe('not a date')
  })

  it('waits five minutes before calling a late firing missed', () => {
    // 2026-11-13 现场：调度器晚了两分钟就被报成漏发，运营方要求改成 5 分钟。
    expect(overdueTasks({ k: daily(3) }, NOW)).toEqual([])
    expect(overdueTasks({ k: daily(4) }, NOW)).toEqual([])
    expect(overdueTasks({ k: daily(6) }, NOW)).toHaveLength(1)
    // 容差也是可调的：给 0 就按「到点没发就算漏」判。
    expect(overdueTasks({ k: daily(1) }, NOW, DEFAULT_OVERDUE_WINDOW_MS, 0)).toHaveLength(1)
  })
})