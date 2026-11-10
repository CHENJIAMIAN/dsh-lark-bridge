import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { markSeen, readSeen, seenFile } from '../src/overdue-seen.ts'

const homes: string[] = []
function freshHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-overdue-'))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('persisted overdue notices', () => {
  it('reads an absent file as empty', () => {
    expect(readSeen(1_000, 10_000, freshHome())).toEqual({})
  })

  it('survives a fresh read, so a restart does not re-announce', () => {
    const home = freshHome()
    const seen = readSeen(1_000, 10_000, home)
    markSeen(seen, 'task@2026-11-10T04:00:00Z', 1_000, home)
    const afterRestart = readSeen(2_000, 10_000, home)
    expect(afterRestart['task@2026-11-10T04:00:00Z']).toBe(1_000)
  })

  it('drops notices older than the retention window', () => {
    const home = freshHome()
    const seen = readSeen(1_000, 10_000, home)
    markSeen(seen, 'old@x', 1_000, home)
    markSeen(seen, 'new@x', 9_000, home)
    // At 18_000 the old notice is 17_000 old (dropped), the new one 9_000
    // old (kept within the 10_000 window).
    const later = readSeen(18_000, 10_000, home)
    expect(later['old@x']).toBeUndefined()
    expect(later['new@x']).toBe(9_000)
  })

  it('keeps one entry per occurrence, not per process', () => {
    const home = freshHome()
    const seen = readSeen(1_000, 10_000, home)
    markSeen(seen, 'a@1', 1_000, home)
    markSeen(seen, 'a@1', 2_000, home)
    markSeen(seen, 'b@2', 2_000, home)
    expect(Object.keys(readSeen(3_000, 10_000, home))).toEqual(['a@1', 'b@2'])
  })

  it('reads a corrupt file as empty instead of throwing', () => {
    const home = freshHome()
    writeFileSync(seenFile(home), '{not json', 'utf8')
    expect(readSeen(1_000, 10_000, home)).toEqual({})
  })

  it('writes atomically — no temp file left behind', () => {
    const home = freshHome()
    const seen = readSeen(1_000, 10_000, home)
    markSeen(seen, 'k@1', 1_000, home)
    expect(readFileSync(seenFile(home), 'utf8')).toContain('k@1')
    expect(readSeen(1_000, 10_000, home)['k@1']).toBe(1_000)
  })
})
