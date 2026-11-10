/**
 * Which overdue occurrences the bridge has already told the human about.
 *
 * The watchdog used to keep this in a plain in-memory Set. That survives a
 * long-running process but not a deploy: every restart re-announced the same
 * backlog, so a restart looked like "why is it telling me this again". A miss
 * is worth one notice per occurrence, not one per process lifetime.
 *
 * @module dsh-lark-bridge/overdue-seen
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Shape on disk: occurrence key -> when we first surfaced it. */
type Seen = Record<string, number>

/** The harness home, matching the other bridge state files. */
export function seenHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh')
}

/** Where the notices are recorded. */
export function seenFile(home?: string): string {
  return path.join(seenHome(home), 'lark-bridge-overdue.json')
}

/**
 * Read the recorded notices, dropping ones older than the retention window.
 * A missing or corrupt file reads as empty — a bad state file must never stop
 * the watchdog from noticing a real miss.
 * @param now - current epoch ms.
 * @param keepMs - how long a notice stays relevant.
 * @param home - override for tests.
 */
export function readSeen(now: number, keepMs: number, home?: string): Seen {
  let raw: string
  try {
    raw = readFileSync(seenFile(home), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as Seen
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const live: Seen = {}
    for (const [key, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && Number.isFinite(at) && now - at <= keepMs) live[key] = at
    }
    return live
  } catch {
    return {}
  }
}

/**
 * Record one occurrence as surfaced. Atomic rename so a crash mid-write leaves
 * the previous file intact rather than a truncated one.
 * @param seen - the current notices.
 * @param key - the occurrence key (`id@scheduledAt`).
 * @param now - epoch ms to record.
 * @param home - override for tests.
 */
export function markSeen(seen: Seen, key: string, now: number, home?: string): void {
  seen[key] = now
  const file = seenFile(home)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(seen), 'utf8')
    renameSync(tmp, file)
  } catch {
    // A read-only or failing home must not stop the card from being sent.
  }
}
