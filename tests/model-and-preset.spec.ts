import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * A deployment may pin a provider and a model in its config. That is the
 * deployment's initial default, not a lock: `/model` saves a choice, and
 * that choice has to reach the next agent or the command reports a switch
 * that never happens.
 */
describe('the saved model choice reaches the next agent', () => {
  it('prefers the host selection over a pinned config', async () => {
    const harness = await mountChannel(
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      { defaultModel: { currentSelection: () => ({ provider: 'opencode-go', model: 'muse-spark' }) } },
    )
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    // The config value is the deployment's initial default; the host's
    // selection carries the choice the user made, and it wins.
    expect(harness.agents.created[0]!.agentOptions).toEqual({ provider: 'opencode-go', model: 'muse-spark' })
    await harness.dispose()
  })

  it('falls back to the pinned config when the host has no selection', async () => {
    const harness = await mountChannel(
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      {},
    )
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    expect(harness.agents.created[0]!.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    await harness.dispose()
  })
})
