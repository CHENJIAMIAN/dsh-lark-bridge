import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * The plugin inventory comes from the host's loader seam. A deployment with
 * no plugins and a deployment whose seam is missing look identical to the
 * reader unless the bridge tells them apart: one means "nothing to
 * install", the other means "the inventory is broken".
 */
describe('the plugin inventory tells an empty deployment from a broken seam', () => {
  it('reports the inventory as unreachable when the loader seam is missing', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: '/plugins' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
    expect(reply).toContain('拿不到插件清单')
    // The reader must not be told there is nothing installed.
    expect(reply).not.toContain('清单为空')
    await harness.dispose()
  })

  it('reports an empty inventory as empty when the seam is present', async () => {
    const harness = await mountChannel({}, {
      loader: { await: async () => undefined, entries: () => [] },
    })
    await harness.fake.emitMessage(fakeMessage({ content: '/plugins' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
    expect(reply).toContain('清单为空')
    expect(reply).not.toContain('拿不到插件清单')
    await harness.dispose()
  })
})
