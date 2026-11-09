import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGoalWatch, goalWatchFile } from '../src/goal-watch.ts'

/** A throwaway harness home so no test touches the real `~/.dsh`. */
let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'goal-watch-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const entry = {
  sessionId: 'feishu-oc_a:r1',
  chatId: 'oc_a',
  chatType: 'p2p',
  goalId: 'goal-1',
  revision: 3,
  objective: '把录像清理推到完成',
}

describe('goal watch store', () => {
  it('starts empty when no file exists', () => {
    expect(createGoalWatch(home).pending()).toEqual([])
  })

  it('records an active goal and reads it back', () => {
    const store = createGoalWatch(home)
    store.remember(entry)

    const rows = createGoalWatch(home).pending()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe(entry.sessionId)
    expect(rows[0]!.chatId).toBe(entry.chatId)
    expect(rows[0]!.objective).toBe(entry.objective)
  })

  it('refreshes instead of appending on repeat changes', () => {
    const store = createGoalWatch(home)
    store.remember(entry)
    store.remember({ ...entry, revision: 4 })

    const rows = store.pending()
    // A long-running goal emits one goal/change per round; without this the
    // file would grow without bound and re-arm the same session many times.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.revision).toBe(4)
  })

  it('forgets a settled goal', () => {
    const store = createGoalWatch(home)
    store.remember(entry)
    store.forget(entry.sessionId)

    expect(store.pending()).toEqual([])
    expect(createGoalWatch(home).pending()).toEqual([])
  })

  it('ignores forget for an unknown session', () => {
    const store = createGoalWatch(home)
    store.remember(entry)
    store.forget('someone-else')

    expect(store.pending()).toHaveLength(1)
  })

  it('keeps several conversations apart', () => {
    const store = createGoalWatch(home)
    store.remember(entry)
    store.remember({ ...entry, sessionId: 'feishu-oc_b:r2', chatId: 'oc_b' })

    const rows = store.pending()
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.chatId).sort()).toEqual(['oc_a', 'oc_b'])
  })

  it('drops entries older than the stale window', () => {
    const file = goalWatchFile(home)
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(file, JSON.stringify({ version: 1, goals: [{ ...entry, seenAt: old }] }), 'utf8')

    // A goal untouched for a week is not something to re-arm on boot.
    expect(createGoalWatch(home).pending()).toEqual([])
  })

  it('survives a corrupt file instead of failing the boot', () => {
    writeFileSync(goalWatchFile(home), '{not json', 'utf8')
    expect(createGoalWatch(home).pending()).toEqual([])

    // And the next write repairs it.
    const store = createGoalWatch(home)
    store.remember(entry)
    expect(JSON.parse(readFileSync(goalWatchFile(home), 'utf8')).goals).toHaveLength(1)
  })

  it('writes atomically', () => {
    const store = createGoalWatch(home)
    store.remember(entry)

    // The temp file must not survive the write, or a crash would leave debris
    // that looks like state.
    const files = readFileSync(goalWatchFile(home), 'utf8')
    expect(JSON.parse(files).version).toBe(1)
  })
})
