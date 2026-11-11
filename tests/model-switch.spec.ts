/**
 * `switch_model`：用自然语言切本会话的模型。
 *
 * 和 `/think` 一样落 `model/selection`，由 `agent/request` 重写信封——所以这里
 * 验证两件事：解析（人话 → 一个 route，绝不猜）和写入（只动本会话、不碰部署
 * 默认）。这两半都可以脱离宿主单独跑。
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createFeishuTools, SWITCH_MODEL_TOOL } from '../src/feishu-tools.ts'
import type { ModelSwitchDeps } from '../src/feishu-tools.ts'
import { effortIntent, pickEffort, resolveEffort, resolveModelRequest } from '../src/model-switch.ts'
import type { ModelEntry } from '../src/model-catalog.ts'
import { EffortOverrides } from '../src/think.ts'
import type { HostSession } from '../src/host.ts'
import type { OutboundPort } from '../src/outbound.ts'

const ENTRIES: readonly ModelEntry[] = [
  { provider: 'deepseek-official', providerName: 'DeepSeek', id: 'deepseek-v4', name: 'DeepSeek V4' },
  { provider: 'deepseek-official', providerName: 'DeepSeek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'opencode-zen', providerName: 'OpenCode Zen', id: 'glm-5', name: 'GLM 5' },
  { provider: 'openrouter', providerName: 'OpenRouter', id: 'deepseek-v4', name: 'DeepSeek V4' },
]

describe('resolveModelRequest', () => {
  it('直取完整 route', () => {
    expect(resolveModelRequest('opencode-zen/glm-5', ENTRIES, undefined))
      .toMatchObject({ kind: 'select', provider: 'opencode-zen', model: 'glm-5' })
  })

  it('按说出来的名字切', () => {
    expect(resolveModelRequest('换成 deepseek v4 flash', ENTRIES, undefined))
      .toMatchObject({ kind: 'select', provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('撞名时拒绝，而不是随便挑一个', () => {
    // 「deepseek-v4」在两家 provider 下都有；猜错的代价是一次跑错的请求。
    const result = resolveModelRequest('deepseek-v4', ENTRIES, undefined)
    // 完整 id 不是完整 route 时，走模糊匹配——两家都命中。
    expect(result.kind).toBe('unknown')
    if (result.kind === 'unknown') {
      expect(result.candidates).toContain('deepseek-official/deepseek-v4')
      expect(result.candidates).toContain('openrouter/deepseek-v4')
    }
  })

  it('下一个 / 上一个 按当前在清单里的位置走', () => {
    const current = 'deepseek-official/deepseek-v4'
    expect(resolveModelRequest('下一个', ENTRIES, current))
      .toMatchObject({ kind: 'select', model: 'deepseek-v4-flash' })
    // 「上一个」从第二个位置往回走才落到第一个；已经在第一个时就是到头。
    expect(resolveModelRequest('上一个', ENTRIES, 'deepseek-official/deepseek-v4-flash'))
      .toMatchObject({ kind: 'select', model: 'deepseek-v4' })
    expect(resolveModelRequest('第一个', ENTRIES, current))
      .toMatchObject({ kind: 'select', model: 'deepseek-v4' })
    expect(resolveModelRequest('上一个', ENTRIES, current).kind).toBe('unknown')
  })

  it('走到头了就说走到头了', () => {
    const result = resolveModelRequest('下一个', ENTRIES, 'openrouter/deepseek-v4')
    expect(result.kind).toBe('unknown')
  })

  it('认「回到默认」', () => {
    expect(resolveModelRequest('default', ENTRIES, undefined).kind).toBe('reset')
    expect(resolveModelRequest('恢复默认', ENTRIES, undefined).kind).toBe('reset')
  })

  it('对不上的说法如实报告并列候选', () => {
    const result = resolveModelRequest('那个便宜的', ENTRIES, undefined)
    expect(result.kind).toBe('unknown')
    if (result.kind === 'unknown') expect(result.candidates).toHaveLength(ENTRIES.length)
  })
})

describe('resolveEffort', () => {
  it('空说法 = 不指定', () => {
    expect(resolveEffort('', ['off', 'high'])).toBeUndefined()
    expect(resolveEffort('默认', ['off', 'high'])).toBeUndefined()
  })

  it('认档位，不认的返回 null', () => {
    expect(resolveEffort('high', ['off', 'high'])).toBe('high')
    expect(resolveEffort('turbo', ['off', 'high'])).toBeNull()
  })

  it('认人话：关掉 / 多想想 / 最高 / 省点', () => {
    const levels = ['off', 'low', 'high', 'max']
    expect(resolveEffort('关掉思考', levels)).toBe('off')
    expect(resolveEffort('别想太多', levels)).toBe('off')
    expect(resolveEffort('多想想', levels)).toBe('high')
    expect(resolveEffort('拉满', levels)).toBe('max')
    expect(resolveEffort('省点钱', levels)).toBe('off')
  })

  it('「不要想太多」是关，不是加强', () => {
    // 两句话都含「想」，意思相反；判定顺序错了就会把省钱说成使劲想。
    expect(effortIntent('不要想太多')).toBe('off')
    expect(effortIntent('多想想')).toBe('more')
  })
})

describe('pickEffort', () => {
  it('没有「关闭」这一档时给最低的，并说明', () => {
    const picked = pickEffort('off', ['low', 'high'])
    expect(picked.level).toBe('low')
    expect(picked.downgraded).toContain('最低')
  })

  it('没有「最高」时给最高的，不硬塞一个不存在的档', () => {
    expect(pickEffort('max', ['low', 'high']).level).toBe('high')
  })

  it('档位表为空时不写死值', () => {
    expect(pickEffort('max', []).level).toBeUndefined()
  })
})

describe('EffortOverrides.setEffort', () => {
  /** 一条能记录 append 的会话。 */
  function session(events: { type: string; data?: unknown }[] = []): HostSession {
    return {
      id: 'ses_1',
      seq: events.length,
      eventAt: (index: number) => events[index],
      append: (type: string, data: unknown) => { events.push({ type, data }); return {} },
    } as unknown as HostSession
  }

  it('只换档位时不丢 route', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const overrides = new EffortOverrides(ctx)
    const one = session()
    overrides.set(one, { provider: 'p', model: 'm' })
    overrides.setEffort(one, { reasoningEffort: 'low' })
    expect(overrides.get(one.id)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  })

  it('没有档案时也能只设档位', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const overrides = new EffortOverrides(ctx)
    const one = session()
    overrides.setEffort(one, { provider: 'p', model: 'm', reasoningEffort: 'max' })
    expect(overrides.get(one.id)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' })
  })
})

describe('switch_model 工具', () => {
  /** 一份记录调用的假能力。 */
  function fakeSwitch(overrides: Partial<ModelSwitchDeps> = {}): ModelSwitchDeps & {
    applied: unknown[]
    resets: string[]
    efforts: unknown[]
  } {
    const applied: unknown[] = []
    const resets: string[] = []
    const efforts: unknown[] = []
    return {
      applied,
      resets,
      efforts,
      list: async () => ENTRIES,
      current: () => ({ provider: 'deepseek-official', model: 'deepseek-v4' }),
      levels: async () => ['off', 'low', 'high', 'max'],
      apply: (_sessionId, selection) => { applied.push(selection) },
      applyEffort: (_sessionId, provider, model, effort) => { efforts.push({ provider, model, effort }) },
      reset: (sessionId) => { resets.push(sessionId) },
      ...overrides,
    }
  }

  /** 取出工具并直接调 execute，exec 里只带会话 id。 */
  async function run(deps: ModelSwitchDeps, args: Record<string, unknown>) {
    const tools = createFeishuTools({
      port: { send: vi.fn() } as unknown as OutboundPort,
      chatOfSession: () => 'oc_1',
      credentials: undefined,
      modelSwitch: deps,
    }) as { name: string; execute: (a: unknown, e: unknown) => Promise<any> }[]
    const tool = tools.find(candidate => candidate.name === SWITCH_MODEL_TOOL)
    expect(tool).toBeDefined()
    return tool!.execute(args, { agent: { session: { id: 'ses_1' } } })
  }

  it('list 给出当前模型和全部可选', async () => {
    const result = await run(fakeSwitch(), { action: 'list' })
    expect(result.ok).toBe(true)
    expect(result.current).toBe('deepseek-official/deepseek-v4')
    expect(result.models).toHaveLength(ENTRIES.length)
  })

  it('按人话切到唯一命中的模型', async () => {
    const deps = fakeSwitch()
    const result = await run(deps, { action: 'switch', model: 'glm 5' })
    expect(result.ok).toBe(true)
    expect(deps.applied).toEqual([{ provider: 'opencode-zen', model: 'glm-5' }])
    expect(result.current).toBe('opencode-zen/glm-5')
  })

  it('说错档位时拒绝，不把坏档位写进去', async () => {
    const deps = fakeSwitch({ levels: async () => ['off', 'high'] })
    const result = await run(deps, { action: 'switch', model: 'glm 5', effort: 'turbo' })
    expect(result.ok).toBe(false)
    expect(deps.applied).toEqual([])
  })

  it('切到没声明档位的模型时不带旧档位', async () => {
    const deps = fakeSwitch({ levels: async () => [] })
    const result = await run(deps, { action: 'switch', model: 'glm 5' })
    expect(result.ok).toBe(true)
    expect(deps.applied).toEqual([{ provider: 'opencode-zen', model: 'glm-5' }])
  })

  it('default 回到部署默认', async () => {
    const deps = fakeSwitch()
    const result = await run(deps, { action: 'switch', model: 'default' })
    expect(result.ok).toBe(true)
    expect(deps.resets).toEqual(['ses_1'])
  })

  it('只给 effort 时改强度、不动模型', async () => {
    // 「多想想」这句话里没有模型名；把它当换模型处理会误伤 route。
    const deps = fakeSwitch()
    const result = await run(deps, { action: 'switch', effort: '多想想' })
    expect(result.ok).toBe(true)
    expect(result.effort).toBe('high')
    expect(deps.efforts).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4', effort: 'high' }])
    expect(deps.applied).toEqual([])
  })

  it('只给 effort 时说「关掉」「省点」也认', async () => {
    const deps = fakeSwitch()
    for (const said of ['关掉思考', '省点钱', '别想太多']) {
      const result = await run(deps, { action: 'switch', effort: said })
      expect(result.ok).toBe(true)
      expect(result.effort).toBe('off')
    }
  })

  it('对不上的说法不猜', async () => {
    const deps = fakeSwitch()
    const result = await run(deps, { action: 'switch', model: '那个便宜的' })
    expect(result.ok).toBe(false)
    expect(deps.applied).toEqual([])
    expect(result.models).toHaveLength(ENTRIES.length)
  })

  it('没有 llm 运行时就说清楚不可用', async () => {
    const tools = createFeishuTools({
      port: { send: vi.fn() } as unknown as OutboundPort,
      chatOfSession: () => 'oc_1',
      credentials: undefined,
    }) as { name: string; execute: (a: unknown, e: unknown) => Promise<any> }[]
    const tool = tools.find(candidate => candidate.name === SWITCH_MODEL_TOOL)!
    const result = await tool.execute({ action: 'list' }, { agent: { session: { id: 'ses_1' } } })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('llm')
  })
})
