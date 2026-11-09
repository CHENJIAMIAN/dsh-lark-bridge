import { describe, expect, it } from 'vitest'
import type { StoredScheduleTask } from '../src/schedule-watchdog.ts'
import { chatOfSession, DEFAULT_OVERDUE_WINDOW_MS, overdueTasks } from '../src/schedule-watchdog.ts'

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

  it('sorts oldest first so the most stale is dealt with first', () => {
    const rows = overdueTasks({
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
})
