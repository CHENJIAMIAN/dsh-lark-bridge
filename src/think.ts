/**
 * Per-session reasoning effort: `/think`.
 *
 * The effort a turn runs at is not something the bridge can set on the agent.
 * The loop resolves it as `options.reasoningEffort ?? persisted header`, and
 * the options come from the deployment's default at creation time — so
 * rewriting that default, which is all `/model` can do, reaches the NEXT
 * session and leaves every running one where it was. A chat needs two things a
 * command can give it: a way to READ what the next request will actually send,
 * and a way to CHANGE it without opening a new session.
 *
 * The change rides the host's own `agent/request` waterfall — the same seam the
 * web UI's model picker uses (`installModelSelection`): the resolved envelope
 * is rewritten on its way to the adapter, so a switch lands on the next step
 * rather than the next session. The choice is recorded as a durable
 * `model/selection` event, the exact event shape that surface writes, so a
 * resumed session and a web-UI client read the same fact instead of two.
 * @module dsh-lark-bridge/think
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandOutcome } from './commands.ts'
import { THINK_COMMAND } from './commands.ts'
import type { HostAgent, HostDefaultModel, HostLlm, HostSession } from './host.ts'

/**
 * Levels offered when no adapter publishes its own.
 *
 * These are the levels the DeepSeek adapters ship (off/low/high/max). The list
 * is a fallback, not the truth: a route that describes itself wins, because
 * offering a level the provider rejects turns a settings command into a failed
 * turn.
 */
export const FALLBACK_EFFORTS: readonly string[] = ['off', 'low', 'high', 'max']

/** One selectable level. */
export interface EffortLevel {
  readonly id: string
  /** Adapter-provided display name, when it has one. */
  readonly name?: string
}

/** The levels one route accepts, and where that list came from. */
export interface EffortCatalog {
  readonly levels: readonly EffortLevel[]
  /** The adapter's own default, materialized when a request omits an effort. */
  readonly defaultEffort?: string
  /** `adapter` when the route described itself, `fallback` otherwise. */
  readonly source: 'adapter' | 'fallback'
}

/** What one `/think` line asked for. */
export type ThinkIntent =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly effort: string }
  | { readonly kind: 'reset' }

/**
 * `/think off` 的档位名。
 *
 * 这一档和其他档不同：它要求的是「选择里根本没有 reasoning 这一项」，而不是
 * 「把 off 这个名字查成某个 wire 值发出去」。宿主的查表结果取决于配置里
 * `reasoningEfforts.off` 写成 null 还是字符串，而 magpie 会把它写成 `"none"`；
 * `"none"` 不是任何厂商认的关闭值，上游只会当成没听懂。
 *
 * **实现位置在「选择」层，不在「请求」层（2026-11-11 修正）。**
 * 早先的做法是在 `agent/request` 瀑布里把这个字段删掉。宿主 0.2.2 起在每一步
 * 准备阶段固定 `selection`，随后硬校验瀑布的返回值必须与它完全一致（loop 的
 * `proposed reasoning effort "adapter default" after step preparation fixed "off"`），
 * 于是「准备阶段说是 off、请求阶段却把字段删了」直接把整轮打成 `UNKNOWN`——
 * 用户切「关闭思考」就炸，切 low 却没事，因为 low 两边一致。
 *
 * 现在改成：落盘 `model/selection` 时不带 effort。宿主自己的
 * `AgentModel.current()` 对「没有 effort 的选择」返回不含该字段的选择（其注释
 * 说得明白：adapter 默认出来的 effort 会被省略，让后续请求重新取默认），于是
 * 准备阶段和请求阶段都认为「不指定」，天然一致，请求里也就没有 reasoning 字段
 * ——正是「关闭」要的效果。
 */
export const EFFORT_OFF = 'off'

/** A recorded model selection, as the session log stores it. */
export interface ModelSelection {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** The parts of one resolved request envelope the override touches. */
export interface RequestEnvelope {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The `agent/request` waterfall payload (subset). */
interface AgentRequestPayload {
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/**
 * Parse one `/think` line.
 * @param line - the trimmed command line, leading slash included.
 * @returns what the line asked for; an empty argument means "show".
 */
export function parseThinkLine(line: string): ThinkIntent {
  // Built per call rather than at module scope on purpose: the command name is
  // imported from `commands.ts`, which imports this module back, and reading it
  // during module evaluation would hit the binding before it initialises.
  const match = new RegExp(`^/${THINK_COMMAND}(?:\\s+(.*))?$`, 'i').exec(line.trim())
  const arg = (match?.[1] ?? '').trim().toLowerCase()
  if (arg === '') return { kind: 'show' }
  // `auto` is what the web picker calls "follow the model"; `default` is the
  // word a reader reaches for. Both mean the same thing here.
  if (arg === 'reset' || arg === 'default' || arg === 'auto') return { kind: 'reset' }
  return { kind: 'set', effort: arg }
}

/**
 * The printable name of an effort value, wherever it came from.
 *
 * Not every source hands back a string. A selection the user saved is one, but
 * the effort the host records in `requestHeader().config` is a `ReasoningEffortId`
 * — a branded **object** around the id — so interpolating it straight into a
 * template string printed `[object Object]` as the session's current level
 * (2026-11-11, operator report). Unwrap it; anything genuinely unrecognisable
 * reads as "not set" rather than as a broken line.
 * @param value - an effort id, a branded effort id, or nothing.
 * @returns the id as text, or undefined.
 */
export function effortName(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const candidate of [record.id, record.name, record.value, record.effort]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * Read the last model selection one session recorded.
 *
 * The scan is a plain array walk — the host serves `eventAt` straight out of
 * the loaded log — so it costs nothing measurable on the path that opens a
 * session, and it keeps the choice in the session instead of in a second store
 * that could drift from it.
 * @param session - the session whose log to scan.
 * @returns the newest recorded selection, or undefined when none exists.
 */
export function lastSelection(session: HostSession): ModelSelection | undefined {
  let found: ModelSelection | undefined
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq) as { readonly type?: string; readonly data?: unknown } | undefined
    if (event?.type !== 'model/selection') continue
    const data = event.data as ModelSelection | undefined
    if (data !== undefined && typeof data === 'object') found = data
  }
  return found
}

/**
 * Resolve the levels one route accepts.
 * @param llm - the llm runtime, when composed.
 * @param provider - the route's provider.
 * @param model - the route's model.
 * @returns the adapter's own list when it has one, the fallback otherwise.
 */
export async function effortCatalog(
  llm: HostLlm | undefined,
  provider: string | undefined,
  model: string | undefined,
): Promise<EffortCatalog> {
  if (llm !== undefined && provider !== undefined && provider !== '' && model !== undefined && model !== '') {
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const reasoning = info.reasoning
      if (reasoning !== undefined && reasoning.efforts.length > 0) {
        return {
          levels: reasoning.efforts.map(effort => ({
            id: effort.id,
            ...effort.name === undefined ? {} : { name: effort.name },
          })),
          ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
          source: 'adapter',
        }
      }
    } catch {
      // A route that cannot describe itself is not a route without levels:
      // falling through to the bridge's list beats claiming "no levels".
    }
  }
  return { levels: FALLBACK_EFFORTS.map(id => ({ id })), source: 'fallback' }
}

/**
 * The selection as it goes into the session log.
 *
 * `EFFORT_OFF` never reaches disk as a value: the log entry drops the field
 * entirely, so the host reads "unspecified" and sends no reasoning parameter.
 * A selection without an effort is a real state the host models (it is how an
 * adapter-defaulted effort is forgotten rather than pinned), so this is not a
 * trick — it is the supported way to say "do not pick a level".
 * @param selection - the choice held in memory.
 * @returns the shape to append.
 */
function durableSelection(selection: ModelSelection): ModelSelection {
  if (selection.reasoningEffort !== EFFORT_OFF) return selection
  // exactOptionalPropertyTypes 下不能赋 undefined 了事：那会让键继续存在，
  // 而「字段缺席」要求的是这个键根本不在事件里。
  const { reasoningEffort: _dropped, ...rest } = selection
  return rest
}

/**
 * The live per-session effort choices, and the route hook that applies them.
 *
 * One instance serves the whole bridge: every agent's `setup` installs a hook
 * that reads this table by session id, so a choice made in a chat applies to
 * that chat's agent and to no other.
 */
export class EffortOverrides {
  /**
   * What each session asked to run as: the route it wants, its effort, or both.
   *
   * Storing the whole selection rather than just the effort is what lets a
   * switch reach the CURRENT session: the deployment's default is written into
   * the agent at creation, and a home-patch overlay refuses to be rewritten at
   * runtime, so saveSelection alone only ever reaches the next session.
   */
  private readonly bySession = new Map<string, ModelSelection>()

  /**
   * @param _ctx - 保留的桥上下文。
   *
   * 档位能力校验（原来在 `agent/request` 瀑布里做，问 `llm.resolveModelInfo`
   * 这个模型认不认当前档位）随瀑布一起从这里撤掉了：那一步现在禁止改动任何
   * 请求字段。校验改由命令层在切换前完成（`runThinkCommand` 已经比对 catalog），
   * 这里留一个可选参数只是为了不牵动十几处调用点。
   */
  constructor(_ctx?: Context) {}

  /**
   * The override in force for one session.
   * @param sessionId - the session to look up.
   * @returns the chosen selection, or undefined when the session follows the default.
   */
  get(sessionId: string): ModelSelection | undefined {
    return this.bySession.get(sessionId)
  }

  /**
   * Re-read one session's choice from its own log.
   *
   * Called when an agent is composed: a resumed session must come back at the
   * effort its human chose, not at the deployment default.
   * @param session - the session being opened.
   */
  restore(session: HostSession): void {
    const recorded = lastSelection(session)
    if (recorded === undefined) return
    this.bySession.set(session.id, recorded)
    // 迁移：2026-11-11 之前 `off` 是原样落盘的。那种事件会让宿主的准备阶段
    // 认定「这一档叫 off」，再去查配置里的 wire 值（magpie 写的是 "none"），
    // 于是「关闭思考」实际发的是 reasoning_effort: "none"。把它改写成
    // 「无 effort」的选择，下一次准备阶段就真的不指定了。
    // 只在读到旧形状时写，所以只发生一次。
    if (recorded.reasoningEffort === EFFORT_OFF) {
      session.append?.('model/selection', durableSelection(recorded))
    }
  }

  /**
   * Drop one session's override entirely, returning it to the deployment default.
   *
   * Distinct from recording a selection with no effort: that keeps a route
   * override in place, while a reset means 'nothing of mine applies here' —
   * both the route and the effort go back to the deployment's choice.
   * @param session - the session being reset.
   */
  clear(session: HostSession): void {
    this.bySession.delete(session.id)
  }

  /**
   * Record one session's choice, durably when the host can append.
   *
   * `EFFORT_OFF` is stored in memory as the literal `'off'` — that is what
   * `/think` prints back and what tells "the human asked for no thinking" apart
   * from "nobody chose anything". What reaches the session log omits the field:
   * the host then reads the selection as "unspecified" at step preparation and
   * leaves the request without a reasoning field, which is the only encoding of
   * "off" that survives the loop's consistency check. See {@link EFFORT_OFF}.
   * @param session - the session the choice belongs to.
   * @param selection - the provider/model it applies to, plus the effort
   *   (`undefined` clears the override and returns the session to the default).
   */
  set(session: HostSession, selection: ModelSelection): void {
    this.bySession.set(session.id, selection)
    // Best effort by design: a host without `append` still honours the choice
    // for this process, and the reply says which of the two happened.
    session.append?.('model/selection', durableSelection(selection))
  }

  /**
   * Change only the effort of the route a session already runs.
   *
   * 给「换模型但不动档位」「只调档位不换模型」这类操作共用：路由保持不变，
   * 只替换 `reasoningEffort`，落的仍是同一条 `model/selection` 事件——历史和
   * `/think` 完全一致，resume 时一条扫描就读回来了。
   * @param session - the session being changed.
   * @param selection - the route it runs, and the effort to send with it.
   */
  setEffort(session: HostSession, selection: ModelSelection): void {
    const previous = this.bySession.get(session.id)
    const provider = selection.provider ?? previous?.provider
    const model = selection.model ?? previous?.model
    this.set(session, {
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    })
  }

  /**
   * Install the route override on one agent's scope.
   *
   * **只覆盖路由，绝不改 `reasoningEffort`。**
   *
   * 宿主 0.2.2 起在每一步准备阶段用 `agent.model.current()` 固定一次
   * `selection`，随后硬校验 `agent/request` 瀑布的返回值必须与它逐字段相等
   * （loop 的 `… after step preparation fixed …; use agent.model.select()
   * before step preparation`）。所以任何在瀑布里改 effort 的写法都会让整轮
   * 变成 `UNKNOWN` —— 2026-11-11 用户点「关闭思考」就是这么炸的。
   *
   * effort 现在完全通过落盘的 `model/selection` 事件生效（`set()` 会写），
   * 宿主下一步准备阶段自己就读到了。这里剩下的路由覆盖与那条事件同源，
   * 所以返回的值恒等于准备阶段固定下来的值，不会被判为不一致。
   * @param agentCtx - the agent's scoped context.
   * @param sessionId - the session this agent drives.
   */
  install(agentCtx: Context, sessionId: string): void {
    const override = async (
      _payload: AgentRequestPayload,
      next: () => Promise<RequestEnvelope>,
    ): Promise<RequestEnvelope> => {
      const resolved = await next()
      const wanted = this.bySession.get(sessionId)
      if (wanted === undefined) return resolved
      // The route is part of the override, not just the effort. A deployment
      // that pins `agent-default-model` in a home patch refuses runtime writes,
      // so `saveSelection` only ever reaches the NEXT session; rewriting the
      // envelope is the one seam that moves the CURRENT one.
      return {
        ...resolved,
        provider: wanted.provider ?? resolved.provider,
        model: wanted.model ?? resolved.model,
      }
    }
    // `agent/request` is a host event whose declaration this package does not
    // import — the bridge keeps its host contract as structural copies so the
    // package builds self-contained — so the context's event table cannot name
    // it. The payload and resolver shapes are mirrored above from the loop's
    // own dispatch; the cast is that mirror, not a guess about behaviour.
    const scope = agentCtx as unknown as {
      on(
        name: string,
        listener: (payload: AgentRequestPayload, next: () => Promise<RequestEnvelope>) => Promise<RequestEnvelope>,
      ): () => void
    }
    scope.on('agent/request', override)
  }
}

/** Render the levels one catalog offers, in the order the adapter gave them. */
function levelList(catalog: EffortCatalog): string {
  return catalog.levels.map(level => `\`${level.id}\``).join(' · ')
}

/**
 * Handle `/think [level|reset]`: show or change this session's reasoning effort.
 * @param line - the trimmed command line.
 * @param agent - the chat's agent (owns the session being changed).
 * @param overrides - the live override table, when the bridge wired one.
 * @param llm - the llm runtime, when composed (for the route's own levels).
 * @param defaultModel - the deployment default, for the "follow the default" line.
 * @returns the reply for the chat.
 */
export async function runThinkCommand(
  line: string,
  agent: HostAgent,
  overrides: EffortOverrides | undefined,
  llm: HostLlm | undefined,
  defaultModel: HostDefaultModel | undefined,
): Promise<CommandOutcome> {
  if (overrides === undefined) {
    return { reply: '⚠️ 本部署没有启用思考强度控制，`/think` 不可用。', resolved: false }
  }
  const session = agent.session
  const intent = parseThinkLine(line)
  const header = session.requestHeader?.()?.config
  const configured = defaultModel?.currentSelection()
  const provider = header?.provider ?? configured?.provider
  const model = header?.model ?? configured?.model
  const catalog = await effortCatalog(llm, provider, model)
  const current = overrides.get(session.id)

  if (intent.kind === 'show') {
    // Two facts, kept apart on purpose: what the next request will send, and
    // what the deployment would send if this session had no choice of its own.
    // Every effort below goes through `effortName`: the header's one is a
    // branded object, and printing it raw is how `[object Object]` got here.
    const effective = effortName(current) ?? effortName(header?.reasoningEffort)
    const recorded = effortName(header?.reasoningEffort)
    const origin = current !== undefined
      ? '本会话设置'
      : recorded === undefined
        ? '未显式设置，由模型决定'
        : '上一次请求实际使用'
    const fallback = effortName(configured?.reasoningEffort)
    const lines = [
      '**思考强度**（本会话）',
      `当前：${effective === undefined ? '未设置' : `\`${effective}\``}（${origin}）`,
      `可选：${levelList(catalog)}${catalog.source === 'fallback' ? '（模型未声明，按 DeepSeek 通用档位）' : ''}`,
      `部署默认：${fallback === undefined ? '未设置' : `\`${fallback}\``}`,
      '',
      `切换：\`/${THINK_COMMAND} <档位>\` · 回到默认：\`/${THINK_COMMAND} reset\``,
      '改动对下一步请求即生效，不用 `/new`。',
    ]
    return { reply: lines.join('\n'), resolved: true }
  }

  const route = { provider, model }
  if (route.provider === undefined || route.provider === '' || route.model === undefined || route.model === '') {
    return { reply: '⚠️ 还不知道本会话用哪个模型，等这轮请求跑完再试 `/think`。', resolved: false }
  }

  if (intent.kind === 'reset') {
    overrides.clear(session)
    const back = effortName(configured?.reasoningEffort)
    return {
      reply: `✅ 已回到部署默认${back === undefined ? '（未设置，由模型决定）' : `（\`${back}\`）`}，下一步请求生效。`,
      resolved: true,
    }
  }

  const known = catalog.levels.some(level => level.id === intent.effort)
  if (!known) {
    return {
      reply: `⚠️ 没有 \`${intent.effort}\` 这一档。\n可选：${levelList(catalog)}`,
      resolved: false,
    }
  }
  overrides.set(session, { provider: route.provider, model: route.model, reasoningEffort: intent.effort })
  return {
    reply: `✅ 思考强度已设为 \`${intent.effort}\`，下一步请求即生效（不用 \`/new\`）。回到默认：\`/${THINK_COMMAND} reset\`。`,
    resolved: true,
  }
}
