import { describe, expect, it, vi } from 'vitest'
import {
  EffortOverrides,
  FALLBACK_EFFORTS,
  effortCatalog,
  lastSelection,
  parseThinkLine,
  runThinkCommand,
} from '../src/think.ts'
import { THINK_COMMAND } from '../src/commands.ts'
import type { HostAgent, HostDefaultModel, HostLlm, HostSession } from '../src/host.ts'
import type { Context } from '@deepseek-ai/cordis'

/** A session whose log is the given events, addressed the way the host does. */
function fakeSession(events: readonly { type: string; data?: unknown }[] = []): HostSession {
  return {
    id: 'ses_1',
    seq: events.length,
    eventAt: (seq: number) => events[seq],
  } as unknown as HostSession
}

/** A context whose only seam is `get`, standing in for the host's service map. */
function fakeCtx(services: Record<string, unknown> = {}): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** An agent driving one session. */
function fakeAgent(session: HostSession): HostAgent {
  return {
    id: session.id,
    session,
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as HostAgent
}

/** A default-model service reporting one selection. */
function fakeDefaults(selection: { provider: string; model: string; reasoningEffort?: string }): HostDefaultModel {
  return { currentSelection: () => selection }
}

describe('parseThinkLine', () => {
  it('reads a bare command as "show"', () => {
    expect(parseThinkLine(`/${THINK_COMMAND}`)).toEqual({ kind: 'show' })
    expect(parseThinkLine(`  /${THINK_COMMAND}   `)).toEqual({ kind: 'show' })
  })

  it('reads a level as a switch, lowercased and trimmed', () => {
    expect(parseThinkLine(`/${THINK_COMMAND} MAX`)).toEqual({ kind: 'set', effort: 'max' })
    expect(parseThinkLine(`/${THINK_COMMAND}   low  `)).toEqual({ kind: 'set', effort: 'low' })
  })

  it('treats reset, default, and auto as the same intent', () => {
    for (const word of ['reset', 'default', 'auto']) {
      expect(parseThinkLine(`/${THINK_COMMAND} ${word}`)).toEqual({ kind: 'reset' })
    }
  })
})

describe('lastSelection', () => {
  it('returns undefined for a session that never recorded one', () => {
    expect(lastSelection(fakeSession([{ type: 'user/message' }]))).toBeUndefined()
  })

  it('returns the newest selection, ignoring other events', () => {
    const session = fakeSession([
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
      { type: 'turn/start' },
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
    ])
    expect(lastSelection(session)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' })
  })
})

describe('effortCatalog', () => {
  it('uses the adapter’s own levels, in its order', async () => {
    const llm = {
      resolveModelInfo: async () => ({
        reasoning: {
          efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
          defaultEffort: 'high',
        },
      }),
    } as unknown as HostLlm
    const catalog = await effortCatalog(llm, 'p', 'm')
    expect(catalog.source).toBe('adapter')
    expect(catalog.levels.map(level => level.id)).toEqual(['off', 'high'])
    expect(catalog.defaultEffort).toBe('high')
  })

  it('falls back to the shipped levels when no llm service is composed', async () => {
    const catalog = await effortCatalog(undefined, 'p', 'm')
    expect(catalog.source).toBe('fallback')
    expect(catalog.levels.map(level => level.id)).toEqual([...FALLBACK_EFFORTS])
  })

  it('falls back when the route declares no reasoning metadata', async () => {
    const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) } as unknown as HostLlm
    const catalog = await effortCatalog(llm, 'p', 'm')
    expect(catalog.source).toBe('fallback')
  })

  it('falls back when the adapter throws instead of claiming "no levels"', async () => {
    const llm = { resolveModelInfo: async () => { throw new Error('adapter down') } } as unknown as HostLlm
    const catalog = await effortCatalog(llm, 'p', 'm')
    expect(catalog.source).toBe('fallback')
    expect(catalog.levels.length).toBeGreaterThan(0)
  })

  it('skips the lookup without a full route', async () => {
    const resolveModelInfo = vi.fn()
    const llm = { resolveModelInfo } as unknown as HostLlm
    await effortCatalog(llm, undefined, 'm')
    await effortCatalog(llm, 'p', '')
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })
})

describe('EffortOverrides', () => {
  it('records a choice and reads it back', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    expect(overrides.get(session.id)?.reasoningEffort).toBe('low')
  })

  it('keeps the route when the selection carries no effort', () => {
    // A selection without an effort still names a route, and the route must
    // keep overriding — only the effort falls back to the route's default.
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    overrides.set(session, { provider: 'p', model: 'm2' })
    expect(overrides.get(session.id)).toEqual({ provider: 'p', model: 'm2' })
  })

  it('appends the choice as a durable model/selection event', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const append = vi.fn()
    const session = { ...fakeSession(), append } as unknown as HostSession
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'max' })
    expect(append).toHaveBeenCalledWith('model/selection', { provider: 'p', model: 'm', reasoningEffort: 'max' })
  })

  it('keeps the choice in memory when the host cannot append', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    expect(() => overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'off' })).not.toThrow()
    expect(overrides.get(session.id)?.reasoningEffort).toBe('off')
  })

  it('restores a resumed session’s choice from its own log', () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession([
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
    ])
    overrides.restore(session)
    expect(overrides.get(session.id)?.reasoningEffort).toBe('low')
  })

  it('restores the route from a selection that carries no effort', () => {
    // The last recorded selection is the truth: a later one without an effort
    // means "this route, at its own default effort", not "forget everything".
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession([
      { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
      { type: 'model/selection', data: { provider: 'p', model: 'm2' } },
    ])
    overrides.restore(session)
    expect(overrides.get(session.id)).toEqual({ provider: 'p', model: 'm2' })
  })

  describe('the request hook', () => {
    /** Install the hook and hand back a function that runs it once. */
    function hook(overrides: EffortOverrides, sessionId: string): (envelope: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown> {
      const handlers = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
      const scope = {
        on: (name: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
          handlers.set(name, listener)
          return () => undefined
        },
      } as unknown as Context
      overrides.install(scope, sessionId)
      const listener = handlers.get('agent/request')
      if (listener === undefined) throw new Error('hook not installed')
      return envelope => listener({ turn: 1, step: 1, signal: new AbortController().signal }, async () => envelope)
    }

    it('passes the envelope through untouched with no choice', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      const run = hook(overrides, 'ses_1')
      await expect(run({ provider: 'p', model: 'm', reasoningEffort: 'high' })).resolves.toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    })

    // 2026-11-11 的现场：宿主 0.2.2 在每一步准备阶段用 `agent.model.current()`
    // 固定一次 selection，随后硬校验 `agent/request` 瀑布的返回值必须与它逐字段
    // 相等（`proposed reasoning effort "adapter default" after step preparation
    // fixed "off"; use agent.model.select() before step preparation`）。
    // 所以这个钩子**只允许改路由**：effort 由落盘的 `model/selection` 承载，
    // 宿主下一步准备阶段自己就读到了。在这里改 effort 等于把整轮打成 UNKNOWN。
    it('never rewrites the effort the step preparation already fixed', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'low' })
      const run = hook(overrides, 'ses_1')
      // 准备阶段固定的是 max（本会话的选择还没走到这一步）；把它改成 low
      // 正是 2026-11-11 那一轮的崩溃原因。
      const result = await run({ provider: 'p', model: 'm', reasoningEffort: 'max' })
      expect(result.reasoningEffort).toBe('max')
    })

    it('keeps the rest of the envelope (maxTokens and the route)', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'max' })
      const run = hook(overrides, 'ses_1')
      const result = await run({ provider: 'p', model: 'm', maxTokens: 4096 } as unknown as { provider: string; model: string })
      expect(result).toMatchObject({ provider: 'p', model: 'm', maxTokens: 4096 })
    })

    it('moves the route to the recorded choice', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      overrides.set(fakeSession(), { provider: 'p', model: 'chosen' })
      const run = hook(overrides, 'ses_1')
      await expect(run({ provider: 'p', model: 'm' })).resolves.toEqual({ provider: 'p', model: 'chosen' })
    })

    it('is scoped to one session', async () => {
      const overrides = new EffortOverrides(fakeCtx())
      overrides.set(fakeSession(), { provider: 'p', model: 'm', reasoningEffort: 'off' })
      const run = hook(overrides, 'ses_2')
      await expect(run({ provider: 'p', model: 'm' })).resolves.toEqual({ provider: 'p', model: 'm' })
    })
  })

  describe('the recorded selection', () => {
    /** A session that records what it was told to append. */
    function recordingSession(): { session: HostSession; appended: { type: string; data?: unknown }[] } {
      const appended: { type: string; data?: unknown }[] = []
      const session = {
        ...fakeSession(),
        append: (type: string, data?: unknown) => { appended.push({ type, data }) },
      } as unknown as HostSession
      return { session, appended }
    }

    // `off` 不是普通的档位名：它要求「请求里没有 reasoning 字段」。
    // 把 off 原样落盘等于让宿主去查 `reasoningEfforts.off` 的 wire 值，
    // 而 magpie 会把它写成 "none"——上游不认，照样思考。见 think.ts 的注释。
    it('records off as an absent effort, so the host sends no reasoning field', () => {
      const { session, appended } = recordingSession()
      const overrides = new EffortOverrides()
      overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'off' })
      expect(appended).toHaveLength(1)
      expect(appended[0]!.type).toBe('model/selection')
      const data = appended[0]!.data as Record<string, unknown>
      expect(Object.hasOwn(data, 'reasoningEffort')).toBe(false)
      expect(data).toEqual({ provider: 'p', model: 'm' })
      // 内存里保留 off：/think 与 CoT banner 靠它显示「已关闭」。
      expect(overrides.get('ses_1')).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'off' })
    })

    it('records a normal level verbatim', () => {
      const { session, appended } = recordingSession()
      const overrides = new EffortOverrides()
      overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'low' })
      expect(appended[0]!.data).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })
    })

    it('reads a recorded level back into the table', () => {
      const session = fakeSession([
        { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
      ])
      const overrides = new EffortOverrides()
      overrides.restore(session)
      expect(overrides.get('ses_1')).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    })

    // 迁移：旧版本把 off 原样落盘，宿主会据此去查 wire 值（magpie 写成 "none"），
    // 于是「关闭」实际发的是 "none"。restore 读到旧形状要改写成「无 effort」。
    it('rewrites a legacy off record as an absent effort', () => {
      const appended: { type: string; data?: unknown }[] = []
      const session = {
        ...fakeSession([
          { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'off' } },
        ]),
        append: (type: string, data?: unknown) => { appended.push({ type, data }) },
      } as unknown as HostSession
      const overrides = new EffortOverrides()
      overrides.restore(session)
      expect(appended).toHaveLength(1)
      expect(Object.hasOwn(appended[0]!.data as object, 'reasoningEffort')).toBe(false)
      // 内存里仍是 off，供显示。
      expect(overrides.get('ses_1')).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'off' })
    })
  })
})

describe('runThinkCommand', () => {
  const defaults = fakeDefaults({ provider: 'p', model: 'm', reasoningEffort: 'max' })

  it('shows the session’s choice, the levels, and the deployment default', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(fakeSession()), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply).toContain('思考强度')
    expect(outcome.reply).toContain('`off`')
    expect(outcome.reply).toContain('部署默认：`max`')
  })

  it('reports the live choice as this session’s own', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.reply).toContain('`low`')
    expect(outcome.reply).toContain('本会话设置')
  })

  it('reads what the last request actually sent from the header', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = {
      ...fakeSession(),
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    } as unknown as HostSession
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.reply).toContain('`high`')
    expect(outcome.reply).toContain('上一次请求实际使用')
  })

  it('prints the header’s branded effort id, not [object Object]', async () => {
    // 宿主把 `reasoningEffort` 记成 `ReasoningEffortId`——一个带 `id` 的品牌
    // 对象，不是字符串。直接插进模板串就是 `[object Object]`（2026-11-11 现场）。
    const overrides = new EffortOverrides(fakeCtx())
    const session = {
      ...fakeSession(),
      requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: { id: 'max' } } }),
    } as unknown as HostSession
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.reply).not.toContain('[object Object]')
    expect(outcome.reply).toContain('`max`')
    expect(outcome.reply).toContain('上一次请求实际使用')
  })

  it('switches a known level and says when it lands', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    const outcome = await runThinkCommand(`/${THINK_COMMAND} low`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(true)
    expect(overrides.get(session.id)?.reasoningEffort).toBe('low')
    expect(outcome.reply).toContain('下一步请求即生效')
  })

  it('refuses an unknown level and lists the real ones', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    const outcome = await runThinkCommand(`/${THINK_COMMAND} turbo`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(false)
    expect(overrides.get(session.id)).toBeUndefined()
    expect(outcome.reply).toContain('`off`')
  })

  it('clears the choice on reset and names what it returns to', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const session = fakeSession()
    overrides.set(session, { provider: 'p', model: 'm', reasoningEffort: 'off' })
    const outcome = await runThinkCommand(`/${THINK_COMMAND} reset`, fakeAgent(session), overrides, undefined, defaults)
    expect(outcome.resolved).toBe(true)
    expect(overrides.get(session.id)).toBeUndefined()
    expect(outcome.reply).toContain('`max`')
  })

  it('is unavailable when the bridge wired no override table', async () => {
    const outcome = await runThinkCommand(`/${THINK_COMMAND}`, fakeAgent(fakeSession()), undefined, undefined, defaults)
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('不可用')
  })

  it('asks for one request when the route is not known yet', async () => {
    const overrides = new EffortOverrides(fakeCtx())
    const outcome = await runThinkCommand(`/${THINK_COMMAND} low`, fakeAgent(fakeSession()), overrides, undefined, undefined)
    expect(outcome.resolved).toBe(false)
    expect(outcome.reply).toContain('等这轮请求跑完')
  })
})
