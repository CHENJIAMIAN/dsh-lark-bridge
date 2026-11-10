import { describe, expect, it } from 'vitest'
import type { HostLlm } from '../src/host.ts'
import { CATALOG_MAX_ROWS, discoverModels, formatModelCatalog, modelByNumber } from '../src/model-catalog.ts'

/** A host llm that answers with fixed providers and models. */
function fakeLlm(
  providers: { id: string; name: string }[],
  models: Record<string, { id: string; name: string; description?: string }[] | Error>,
): HostLlm {
  return {
    resolveModelInfo: async () => ({}),
    listProviders: () => providers,
    listModels: async (provider: string) => {
      const entry = models[provider]
      if (entry === undefined) return []
      if (entry instanceof Error) throw entry
      return entry.map(model => ({ provider, ...model }))
    },
  }
}

describe('model discovery', () => {
  it('flattens every provider into one catalogue', async () => {
    const llm = fakeLlm(
      [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openrouter', name: 'OpenRouter' }],
      {
        deepseek: [{ id: 'v4', name: 'DeepSeek V4' }],
        openrouter: [{ id: 'claude', name: 'Claude' }],
      },
    )
    const entries = await discoverModels(llm)
    expect(entries).toHaveLength(2)
    expect(entries.map(entry => `${entry.provider}/${entry.id}`)).toEqual(['deepseek/v4', 'openrouter/claude'])
    expect(entries[0]!.providerName).toBe('DeepSeek')
  })

  it('drops a provider whose discovery throws, keeping the others', async () => {
    const llm = fakeLlm(
      [{ id: 'ok', name: 'OK' }, { id: 'broken', name: 'Broken' }],
      { ok: [{ id: 'm1', name: 'M1' }], broken: new Error('provider unreachable') },
    )
    const entries = await discoverModels(llm)
    // One dead provider must not cost the reader the rest of the list.
    expect(entries).toHaveLength(1)
    expect(entries[0]!.provider).toBe('ok')
  })

  it('returns nothing when the host exposes no listing', async () => {
    expect(await discoverModels(undefined)).toEqual([])
    expect(await discoverModels({ resolveModelInfo: async () => ({}) })).toEqual([])
  })

  it('tolerates a provider that lists no models', async () => {
    const llm = fakeLlm([{ id: 'empty', name: 'Empty' }], { empty: [] })
    expect(await discoverModels(llm)).toEqual([])
  })

  it('falls back to the id when a name is blank', async () => {
    const llm = fakeLlm([{ id: 'p', name: '' }], { p: [{ id: 'm', name: '' }] })
    const entries = await discoverModels(llm)
    expect(entries[0]!.providerName).toBe('p')
    expect(entries[0]!.name).toBe('m')
  })
})

describe('model catalogue menu', () => {
  it('groups by provider and marks the current route', async () => {
    const llm = fakeLlm(
      [{ id: 'deepseek', name: 'DeepSeek' }],
      { deepseek: [{ id: 'v4', name: 'DeepSeek V4' }, { id: 'flash', name: 'Flash' }] },
    )
    const entries = await discoverModels(llm)
    const text = formatModelCatalog(entries, 'deepseek/v4')
    expect(text).toContain('**DeepSeek**')
    expect(text).toContain('1. DeepSeek V4 ← 当前')
    expect(text).toContain('2. Flash')
  })

  it('truncates a long list instead of pasting all of it', async () => {
    const many = Array.from({ length: CATALOG_MAX_ROWS + 5 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}` }))
    const llm = fakeLlm([{ id: 'p', name: 'P' }], { p: many })
    const entries = await discoverModels(llm)
    const text = formatModelCatalog(entries, 'p/m0')
    expect(text).toContain('还有 5 个没列出')
  })

  it('resolves a menu number against the last listing', async () => {
    const llm = fakeLlm(
      [{ id: 'deepseek', name: 'DeepSeek' }],
      { deepseek: [{ id: 'v4', name: 'V4' }, { id: 'flash', name: 'Flash' }] },
    )
    await discoverModels(llm)
    // The reader picks against what they saw, so the number must resolve
    // against that same cached list rather than a fresh query.
    expect(modelByNumber(1)?.id).toBe('v4')
    expect(modelByNumber(2)?.id).toBe('flash')
    expect(modelByNumber(3)).toBeUndefined()
    expect(modelByNumber(0)).toBeUndefined()
  })
})
