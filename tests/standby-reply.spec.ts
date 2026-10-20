/**
 * A standby endpoint is the fleet's silent half: only the arbitration-active
 * endpoint answers, so two Feishu connections never reply twice. That silence
 * is wrong for the READ-ONLY lines the user guide sends a puzzled operator to
 * when the bot looks dead (`/bot devices`, `/help`) — swallowing them is what
 * turns "the other machine is answering" into "the bot is broken". This spec
 * pins both halves: those two get one line naming the active endpoint, and
 * everything with an effect stays unanswered (a standby must never become a
 * second executor).
 */

import { describe, expect, it, vi } from 'vitest'
import { fakeMessage, mountChannel } from './harness.ts'
import type { SentMessage } from './harness.ts'
import { getSyncContext, setSyncContext } from '../src/sync/bot-command.ts'
import type { Arbitration } from '../src/sync/bot-command.ts'
import type { FeishuCloud } from '../src/sync/feishu-cloud.ts'

const ACTIVE_NAME = 'OFFICE-PC'
const ACTIVE_ENDPOINT = 'dev-active-0001:web:web'

/** A ledger where another machine holds the slot and its presence is fresh. */
function standbyLedger(): Arbitration {
  const now = Date.now()
  return {
    activeDeviceId: 'dev-active-0001',
    activeName: ACTIVE_NAME,
    form: 'web',
    profile: 'web',
    activeEndpoint: ACTIVE_ENDPOINT,
    updatedAt: new Date(now).toISOString(),
    devices: {
      [ACTIVE_ENDPOINT]: { name: ACTIVE_NAME, form: 'web', profile: 'web', version: '0.9.5', lastSeen: now },
    },
  }
}

/** The chat-visible body of one outbound message. */
function textOf(sent: SentMessage): string {
  const input = sent.input as { markdown?: string; text?: string }
  return input.markdown ?? input.text ?? ''
}

/**
 * Mount the bridge with the fleet ledger pointing at ANOTHER endpoint.
 *
 * The runtime publishes its own sync context on activation (credentials from
 * the entry config, no cloud client); the inbound path reads arbitration
 * through that context, so the test waits for the publish and then swaps in a
 * cloud that serves the standby ledger. That is exactly the input the standby
 * branch is supposed to react to, without touching a real carrier.
 */
async function mountStandby(): Promise<Awaited<ReturnType<typeof mountChannel>>> {
  const harness = await mountChannel()
  await vi.waitFor(() => {
    if (getSyncContext() === undefined) throw new Error('sync context not published yet')
  }, { timeout: 20_000, interval: 25 })
  const ledger = standbyLedger()
  const cloud = {
    getJson: async (name: string) => (name === 'dsh-lark-bridge-arbitration.json' ? JSON.stringify(ledger) : null),
    putJson: async () => {},
    removeByName: async () => {},
  } as unknown as FeishuCloud
  setSyncContext({ ...getSyncContext()!, cloud })
  return harness
}

/** Wait until the inbound handler has taken the standby branch. */
async function backedOff(harness: Awaited<ReturnType<typeof mountChannel>>): Promise<void> {
  await vi.waitFor(() => {
    if (!harness.notices.some(line => line.includes('standby backed off'))) {
      throw new Error('the inbound message never reached the standby branch')
    }
  }, { timeout: 20_000, interval: 25 })
}

describe('a standby endpoint answers the troubleshooting entries', () => {
  it('answers /bot devices with the active endpoint and where to go', async () => {
    const harness = await mountStandby()
    try {
      await harness.fake.emitMessage(fakeMessage({ content: '/bot devices' }))
      await backedOff(harness)
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 25 })

      const body = textOf(harness.fake.sent[0]!)
      expect(body).toContain('待命')
      expect(body).toContain(ACTIVE_NAME)
      expect(body).toContain('活跃端')
      expect(body).toContain('/bot activate')
      // Answering a status question must never start a turn.
      expect(harness.agents.created).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('answers /help the same way', async () => {
    const harness = await mountStandby()
    try {
      await harness.fake.emitMessage(fakeMessage({ content: '/help' }))
      await backedOff(harness)
      await vi.waitFor(() => { expect(harness.fake.sent).toHaveLength(1) }, { timeout: 20_000, interval: 25 })

      expect(textOf(harness.fake.sent[0]!)).toContain(ACTIVE_NAME)
      expect(harness.agents.created).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('stays silent on a command with effects, so it never executes twice', async () => {
    const harness = await mountStandby()
    try {
      await harness.fake.emitMessage(fakeMessage({ content: '/clear' }))
      await backedOff(harness)
      // The branch was reached; give a stray send the time it would need.
      await new Promise((done) => { setTimeout(done, 100) })
      expect(harness.fake.sent).toHaveLength(0)
      expect(harness.agents.created).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('stays silent on ordinary prose', async () => {
    const harness = await mountStandby()
    try {
      await harness.fake.emitMessage(fakeMessage({ content: '帮我看下日志' }))
      await backedOff(harness)
      await new Promise((done) => { setTimeout(done, 100) })
      expect(harness.fake.sent).toHaveLength(0)
      expect(harness.agents.created).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})
