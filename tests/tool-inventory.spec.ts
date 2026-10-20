import { describe, expect, it, vi } from 'vitest'
import { createFakePresets, createFakeTools, fakeMessage, mountChannel } from './harness.ts'

/**
 * `/tools` used to answer one question only: what did someone switch off.
 * The question a reader actually has is "what can this machine do", and
 * the host keeps the tool list behind a seam the bridge had not read.
 */
describe('the tool listing says what the machine can do, not only what was switched off', () => {
  it('lists the tools visible in the session scope', async () => {
    const tools = createFakeTools({}, [
      { name: 'bash', description: 'Run a shell command' },
      { name: 'read_file', description: 'Read a file' },
    ])
    const harness = await mountChannel({}, { tools: tools.service })
    await harness.fake.emitMessage(fakeMessage({ content: '/tools' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
    expect(reply).toContain('bash')
    expect(reply).toContain('Run a shell command')
    expect(reply).toContain('read_file')
    await harness.dispose()
  })

  it('still reports the denied tools', async () => {
    const tools = createFakeTools({}, [{ name: 'bash', description: 'Run a shell command' }])
    const harness = await mountChannel({ denyTools: ['web_search'] }, { tools: tools.service })
    await harness.fake.emitMessage(fakeMessage({ content: '/tools' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
    expect(reply).toContain('web_search')
    expect(reply).toContain('bash')
    await harness.dispose()
  })

  it('asks the host in the session scope, because a roster keeps tools off the global layer', async () => {
    const tools = createFakeTools({}, [{ name: 'bash', description: 'Run a shell command' }])
    const roster = createFakePresets(['standard'], 'standard')
    const harness = await mountChannel({}, { tools: tools.service, presets: roster.presets })
    await harness.fake.emitMessage(fakeMessage({ content: '/tools' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    // The scope the roster hands out, not the global layer: a deployment with
    // a roster keeps every model-facing row off the global one, so asking
    // without the scope would report an empty inventory.
    expect(tools.scopes).toContain('standing:standard')
    await harness.dispose()
  })

  it('names the MCP servers the deployment talks to', async () => {
    const tools = createFakeTools({}, [
      { name: 'mcp__zhengshitang__record', description: '入驿' },
      { name: 'mcp__firecrawl__scrape', description: '抓网页' },
      { name: 'mcp__zhengshitang__report', description: '简报' },
      { name: 'bash', description: 'Run a shell command' },
    ])
    const harness = await mountChannel({}, { tools: tools.service })
    await harness.fake.emitMessage(fakeMessage({ content: '/tools' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
    expect(reply).toContain('MCP 服务器')
    expect(reply).toContain('zhengshitang')
    expect(reply).toContain('firecrawl')
    await harness.dispose()
  })

  it('answers with the deny list alone when the deployment composes no tool listing', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: '/tools' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
    expect(reply).toContain('工具开关')
    expect(reply).not.toContain('可用（')
    await harness.dispose()
  })
})
