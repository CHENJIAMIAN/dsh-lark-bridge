import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'
import { helpText } from '../src/commands.ts'
import type { HostAgent } from '../src/host.ts'

/**
 * Every command the bridge owns is registered on the panel and listed by
 * `/help`. The two lists drifted apart three times: a command on the panel
 * but not in the help text, and the reverse. This is the check that stops
 * the fourth.
 *
 */
const BRIDGE_COMMANDS = ['stop', 'new', 'preset', 'sessions', 'tools', 'schedules',
  'jobs', 'context', 'skills', 'model', 'balance', 'manual', 'ws',
  'plugins', 'audit', 'config', 'help', 'bot']

describe('the panel and the help listing carry the same commands', () => {
  /** The agent stub the help text only reads the scope from. */
  const agent = { id: 'agent-1' } as unknown as HostAgent

  it('lists every bridge command in the help text', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage({ content: '/help' }))
    await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const reply = (harness.fake.sent[0]!.input as { markdown: string }).markdown
    for (const name of BRIDGE_COMMANDS) {
      expect(reply, `/${name} is missing from the help listing`).toContain(`/${name}`)
    }
    await harness.dispose()
  })

  it('registers every bridge command on the panel', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => {
      expect(harness.fake.panelCommands.length).toBeGreaterThan(0)
    }, { timeout: 20_000, interval: 50 })
    for (const name of BRIDGE_COMMANDS) {
      expect(harness.fake.panelCommands, `/${name} is missing from the panel`).toContain(name)
    }
    await harness.dispose()
  })

  it('offers the same set in both places', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => {
      expect(harness.fake.panelCommands.length).toBeGreaterThan(0)
    }, { timeout: 20_000, interval: 50 })
    const panel = new Set(harness.fake.panelCommands)
    const text = helpText(undefined, agent, 'zh')
    // The listing uses `/name`; the panel uses the bare name.
    const listed = new Set([...text.matchAll(/`\/([a-z][a-z0-9_-]*)`/g)].map(match => match[1]!))
    for (const name of listed) {
      expect(panel.has(name), `/${name} is listed but not on the panel`).toBe(true)
    }
    await harness.dispose()
  })
})
