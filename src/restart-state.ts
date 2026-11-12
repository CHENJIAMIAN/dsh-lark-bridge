/**
 * The bridge's own state that has to survive a restart.
 *
 * 宿主持久的是**会话**（历史、模型选择、目标），桥自己那一层却全在内存里：等回答
 * 的提问、等确认的审批、`/tools disable` 的运行时禁用、各类卡片的消息 id、正在
 * 进行中的流式卡、以及「哪一轮被重启打断」。重启一次，这些就都消失，用户的感受
 * 是「问题点了没反应」「卡片不刷新了」「我禁掉的工具又回来了」。
 *
 * 这个模块只负责**存**，不负责怎么用：一个原子写的 JSON，读坏当空，条目带 24 小时
 * 过期（过期的待回答不该在第二天突然能点）。用它的地方在 `bridge.ts` 与
 * `questions.ts`。
 * @module dsh-lark-bridge/restart-state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** A question card that was waiting for a human when the process went away. */
export interface RestartQuestion {
  /** Card control token; the same token the buttons carry. */
  readonly token: string
  readonly chatId: string
  readonly sessionId: string
  /** The card's message id, so a stale card can be rewritten instead of ignored. */
  readonly messageId?: string
  /** The question as the model asked it, so an answer can be replayed verbatim. */
  readonly questions: readonly RestartAskedQuestion[]
  /** ISO 8601. */
  readonly askedAt: string
}

/** One question of a persisted request — only what a replay needs. */
export interface RestartAskedQuestion {
  readonly id: string
  readonly question: string
  readonly options?: readonly { readonly label: string }[]
}

/** An approval card that was waiting for a human. */
export interface RestartApproval {
  readonly id: string
  readonly chatId: string
  readonly sessionId: string
  readonly messageId?: string
  /** What the tool wanted to do, for the replay sentence. */
  readonly title: string
  readonly askedAt: string
}

/** A turn that was in flight; a boot that finds one says so in its chat. */
export interface RestartTurn {
  readonly chatId: string
  readonly sessionId: string
  /** Where the turn had got to, for the notice. */
  readonly turn: number
  readonly startedAt: string
}

/** A card the bridge is still updating; after a boot it can be taken over again. */
export interface RestartCard {
  readonly chatId: string
  /** `console`, `goal`, `todo`, `team`, `subagent`, `workflow`, `stream`. */
  readonly kind: string
  readonly messageId: string
  /** 会话级卡片（目标/待办）按会话认领；聊天级卡片可以不带。 */
  readonly sessionId?: string
  readonly updatedAt: string
}

/** Everything one boot reads back. */
export interface RestartState {
  readonly questions: readonly RestartQuestion[]
  readonly approvals: readonly RestartApproval[]
  readonly turns: readonly RestartTurn[]
  readonly cards: readonly RestartCard[]
  /** Runtime-disabled tools, by name; restored before the first turn. */
  readonly deniedTools: readonly string[]
}

/** How long an entry stays usable. A day-old pending question is not answerable. */
export const RESTART_STATE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The harness home this file lives in: `DSH_HOME` when set, else `~/.dsh`.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export function restartStateHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh')
}

/**
 * Path of the state file.
 * @param home - override for tests.
 * @returns the file path.
 */
export function restartStateFile(home?: string): string {
  return path.join(restartStateHome(home), 'lark-bridge-restart.json')
}

/** What the bridge drives. */
export interface RestartStore {
  /** Everything still fresh, read once at boot. */
  load(): RestartState
  /** Record a question waiting for a human. */
  rememberQuestion(question: RestartQuestion): void
  /** Drop a question once it is answered, cancelled or superseded. */
  forgetQuestion(token: string): void
  /** Record an approval waiting for a human. */
  rememberApproval(approval: RestartApproval): void
  /** Drop an approval once it is decided. */
  forgetApproval(id: string): void
  /** Remember (or clear, with an empty set) the runtime tool deny list. */
  rememberDeniedTools(tools: readonly string[]): void
  /** Note that a turn started; the boot after a crash still sees it. */
  startTurn(turn: RestartTurn): void
  /** Note that a turn finished, so a clean shutdown leaves nothing behind. */
  endTurn(chatId: string): void
  /** Remember the message id of a card the bridge keeps updating. */
  rememberCard(card: RestartCard): void
  /** Forget a card that is gone (recalled, replaced, session closed). */
  forgetCard(chatId: string, kind: string): void
}

/** What is on disk; absent sections read as empty. */
interface Stored {
  readonly version?: number
  readonly questions?: unknown
  readonly approvals?: unknown
  readonly turns?: unknown
  readonly cards?: unknown
  readonly deniedTools?: unknown
}

/**
 * Read the persisted state, dropping anything stale or malformed.
 * @param file - the state file.
 * @returns the fresh state; empty when the file is missing or corrupt.
 */
function readState(file: string): RestartState {
  const cutoff = Date.now() - RESTART_STATE_TTL_MS
  const fresh = (stamp: unknown): boolean => {
    if (typeof stamp !== 'string') return false
    const at = Date.parse(stamp)
    return Number.isFinite(at) && at >= cutoff
  }
  let stored: Stored
  try {
    stored = JSON.parse(readFileSync(file, 'utf8')) as Stored
  } catch {
    // A missing or corrupt file is the normal first-boot state, not an error:
    // a boot that cannot parse this must still start the bridge.
    return { questions: [], approvals: [], turns: [], cards: [], deniedTools: [] }
  }
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const questions = list(stored.questions).filter((row): row is RestartQuestion => {
    if (typeof row !== 'object' || row === null) return false
    const entry = row as Partial<RestartQuestion>
    return typeof entry.token === 'string'
      && typeof entry.chatId === 'string'
      && typeof entry.sessionId === 'string'
      && Array.isArray(entry.questions)
      && fresh(entry.askedAt)
  })
  const approvals = list(stored.approvals).filter((row): row is RestartApproval => {
    if (typeof row !== 'object' || row === null) return false
    const entry = row as Partial<RestartApproval>
    return typeof entry.id === 'string'
      && typeof entry.chatId === 'string'
      && typeof entry.sessionId === 'string'
      && typeof entry.title === 'string'
      && fresh(entry.askedAt)
  })
  const turns = list(stored.turns).filter((row): row is RestartTurn => {
    if (typeof row !== 'object' || row === null) return false
    const entry = row as Partial<RestartTurn>
    return typeof entry.chatId === 'string'
      && typeof entry.sessionId === 'string'
      && typeof entry.turn === 'number'
      && fresh(entry.startedAt)
  })
  const cards = list(stored.cards).filter((row): row is RestartCard => {
    if (typeof row !== 'object' || row === null) return false
    const entry = row as Partial<RestartCard>
    return typeof entry.chatId === 'string'
      && typeof entry.kind === 'string'
      && typeof entry.messageId === 'string'
      && fresh(entry.updatedAt)
  })
  const deniedTools = list(stored.deniedTools).filter((row): row is string => typeof row === 'string')
  return { questions, approvals, turns, cards, deniedTools }
}

/**
 * Write one state atomically.
 *
 * 写临时文件再 rename：半截写坏的文件会让下次开机读成空、悄悄丢掉所有待回答，
 * 而这正是这个模块要防的那类故障。
 * @param file - the state file.
 * @param state - what to write.
 * @returns whether it reached disk; the in-memory copy stays either way.
 */
function writeState(file: string, state: RestartState): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * Build the store the bridge drives.
 * @param home - harness home override (tests).
 * @returns the store.
 */
export function createRestartStore(home?: string): RestartStore {
  const file = restartStateFile(home)
  let cache: RestartState | undefined
  const current = (): RestartState => (cache ??= readState(file))
  const commit = (next: RestartState): void => {
    cache = next
    writeState(file, next)
  }

  return {
    load() {
      return current()
    },
    rememberQuestion(question) {
      const state = current()
      commit({ ...state, questions: [question, ...state.questions.filter(row => row.token !== question.token)] })
    },
    forgetQuestion(token) {
      const state = current()
      if (!state.questions.some(row => row.token === token)) return
      commit({ ...state, questions: state.questions.filter(row => row.token !== token) })
    },
    rememberApproval(approval) {
      const state = current()
      commit({ ...state, approvals: [approval, ...state.approvals.filter(row => row.id !== approval.id)] })
    },
    forgetApproval(id) {
      const state = current()
      if (!state.approvals.some(row => row.id === id)) return
      commit({ ...state, approvals: state.approvals.filter(row => row.id !== id) })
    },
    rememberDeniedTools(tools) {
      const state = current()
      commit({ ...state, deniedTools: [...tools] })
    },
    startTurn(turn) {
      const state = current()
      commit({ ...state, turns: [turn, ...state.turns.filter(row => row.chatId !== turn.chatId)] })
    },
    endTurn(chatId) {
      const state = current()
      if (!state.turns.some(row => row.chatId === chatId)) return
      commit({ ...state, turns: state.turns.filter(row => row.chatId !== chatId) })
    },
    rememberCard(card) {
      const state = current()
      const rest = state.cards.filter(row => !(row.chatId === card.chatId && row.kind === card.kind))
      commit({ ...state, cards: [card, ...rest] })
    },
    forgetCard(chatId, kind) {
      const state = current()
      if (!state.cards.some(row => row.chatId === chatId && row.kind === kind)) return
      commit({ ...state, cards: state.cards.filter(row => !(row.chatId === chatId && row.kind === kind)) })
    },
  }
}
