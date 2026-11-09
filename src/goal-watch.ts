/**
 * Which conversations still hold an active goal, kept across a host restart.
 *
 * A goal is durable in the session log, but its *continuation authority* is not:
 * after a restart the runtime leaves it `disarmed` and waits for the next human
 * message before re-arming. That is a deliberate safety default, and it is why
 * a long task silently stops being driven the moment the bridge is deployed to.
 *
 * The bridge cannot enumerate the host's goals — the service only answers
 * `get(agent)`, which needs an agent it has not opened yet. So the sessions that
 * matter are recorded here as they become active, and a boot reads this list
 * back to decide which ones to re-open and re-arm.
 *
 * The file is local on purpose: a session id names something on this machine.
 * @module dsh-lark-bridge/goal-watch
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** One conversation the bridge should re-arm after a restart. */
export interface WatchedGoal {
  /** Session the goal lives on. */
  readonly sessionId: string
  /** Chat its output belongs to — the bridge needs this to rebuild a renderer. */
  readonly chatId: string
  /** `p2p` or a group kind; carried so a rebuilt binding judges approvals the same way. */
  readonly chatType: string
  /** Host goal id, when the snapshot carried one. */
  readonly goalId?: string
  /** Revision seen last, so a stale entry can be told apart from a newer goal. */
  readonly revision?: number
  /** The objective, for a boot-time log line and nothing else. */
  readonly objective: string
  /** When this entry was last refreshed (ISO 8601). */
  readonly seenAt: string
}

/** How long an entry survives without a refresh. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The harness home the watch file lives in: `DSH_HOME` when set, else `~/.dsh`.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export function goalWatchHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh')
}

/**
 * Path of the watch file.
 * @param home - override for tests.
 * @returns the file path.
 */
export function goalWatchFile(home?: string): string {
  return path.join(goalWatchHome(home), 'lark-bridge-goals.json')
}

/** What the store offers the bridge. */
export interface GoalWatchStore {
  /**
   * Record or refresh one conversation's active goal.
   *
   * Refreshing rather than appending is what keeps a long-running goal on one
   * entry: every `goal/change` for it rewrites the same row.
   * @param entry - the conversation and its goal as just observed.
   */
  remember(entry: Omit<WatchedGoal, 'seenAt'>): void
  /**
   * Drop a conversation, typically because its goal settled or was cleared.
   * @param sessionId - the conversation whose goal is no longer active.
   */
  forget(sessionId: string): void
  /**
   * Everything worth re-arming after a boot, newest first.
   *
   * Entries whose file is unreadable or corrupt read as empty: a boot that
   * cannot parse this must still start the bridge.
   * @returns the live entries.
   */
  pending(): readonly WatchedGoal[]
}

/**
 * Build the watch store.
 * @param home - harness home override (tests).
 * @returns the store the bridge drives.
 */
export function createGoalWatch(home?: string): GoalWatchStore {
  const file = goalWatchFile(home)
  let cache: WatchedGoal[] | undefined

  const load = (): WatchedGoal[] => {
    if (cache !== undefined) return cache
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw) as { goals?: unknown }
      const rows = Array.isArray(parsed.goals) ? parsed.goals : []
      const cutoff = Date.now() - STALE_MS
      cache = rows.filter((row): row is WatchedGoal => {
        if (typeof row !== 'object' || row === null) return false
        const entry = row as Partial<WatchedGoal>
        if (typeof entry.sessionId !== 'string' || typeof entry.chatId !== 'string') return false
        if (typeof entry.objective !== 'string' || typeof entry.seenAt !== 'string') return false
        const seen = Date.parse(entry.seenAt)
        return Number.isFinite(seen) && seen >= cutoff
      })
    } catch {
      // A missing or corrupt file is the normal first-boot state, not an error.
      cache = []
    }
    return cache
  }

  const persist = (entries: readonly WatchedGoal[]): boolean => {
    cache = [...entries]
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, goals: entries }, null, 2), 'utf8')
      // Atomic replace: a crash mid-write must not leave an unparseable file
      // that silently disables re-arming on the next boot.
      renameSync(tmp, file)
      return true
    } catch {
      // The in-process cache still holds; only a restart would lose it.
      return false
    }
  }

  return {
    remember(entry) {
      const now = new Date().toISOString()
      const next = load().filter(row => row.sessionId !== entry.sessionId)
      next.unshift({ ...entry, seenAt: now })
      persist(next)
    },
    forget(sessionId) {
      const current = load()
      if (!current.some(row => row.sessionId === sessionId)) return
      persist(current.filter(row => row.sessionId !== sessionId))
    },
    pending() {
      return [...load()].sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt))
    },
  }
}
