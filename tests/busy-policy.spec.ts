/**
 * Busy-input policy (issue #5): a message that lands while a turn is running
 * takes the inbox boundary the deployment chose — an ordinary queued turn
 * (`queue`, the default and the behaviour before this option existed), steering
 * at the next step boundary (`steer`), or model-facing context for the next
 * pre-step (`inject`) — and the chat is told which one it got.
 */

import { describe, expect, it, vi } from 'vitest'
import { busyDelivery } from '../src/bridge.ts'
import { fakeMessage, mountChannel } from './harness.ts'

/** First composition reads the preset roster off a /mnt mount; give it room. */
const PATIENCE = { timeout: 5_000, interval: 50 } as const

type Policy = 'queue' | 'steer' | 'inject'

/** Mount with one policy and return the agent once its first message landed. */
async function mountWith(busyPolicy: Policy | undefined, overrides: { running?: boolean } = {}) {
  const harness = await mountChannel(busyPolicy === undefined ? {} : { busyPolicy })
  await harness.fake.emitMessage(fakeMessage({ content: 'task-a' }))
  await vi.waitFor(() => { expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(1) }, PATIENCE)
  const agent = harness.agents.created[0]!.agent
  Object.defineProperty(agent, 'status', { value: overrides.running === false ? 'idle' : 'running', configurable: true })
  return { harness, agent }
}

/** The receipts one message produced: markdown lines it sent while it was handled. */
function receiptsSince(harness: Awaited<ReturnType<typeof mountWith>>['harness'], from: number): string[] {
  return harness.fake.sent
    .slice(from)
    .map(entry => (entry.input as { markdown?: string }).markdown ?? '')
    .filter(line => line !== '')
}

/** The text the delivered message carries, whichever boundary took it. */
function spokenContent(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.map(block => block.text ?? '').join('\n')
}

describe('busy input policy (issue #5)', () => {
  it('queues by default and says so', async () => {
    const { harness, agent } = await mountWith(undefined)
    const before = harness.fake.sent.length
    try {
      await harness.fake.emitMessage(fakeMessage({ content: 'task-b' }))
      await vi.waitFor(() => { expect(agent.followup).toHaveBeenCalledTimes(2) }, PATIENCE)
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.inject).not.toHaveBeenCalled()
      expect(receiptsSince(harness, before).some(line => line.includes('已排队'))).toBe(true)
    } finally { await harness.dispose() }
  })

  it('steers at the next step boundary when the policy says steer', async () => {
    const { harness, agent } = await mountWith('steer')
    const before = harness.fake.sent.length
    try {
      await harness.fake.emitMessage(fakeMessage({ content: 'task-b' }))
      await vi.waitFor(() => { expect(agent.steer).toHaveBeenCalledTimes(1) }, PATIENCE)
      // The running turn keeps its own follow-up; the correction does not
      // become a second turn behind it.
      expect(agent.followup).toHaveBeenCalledTimes(1)
      expect(agent.inject).not.toHaveBeenCalled()
      expect(spokenContent(agent.steer.mock.calls[0]![0])).toContain('task-b')
      const lines = receiptsSince(harness, before)
      expect(lines.some(line => line.includes('已插话'))).toBe(true)
      // The receipt names the escape hatch: steering is not a stop.
      expect(lines.some(line => line.includes('/stop'))).toBe(true)
    } finally { await harness.dispose() }
  })

  it('injects as model-facing context when the policy says inject', async () => {
    const { harness, agent } = await mountWith('inject')
    const before = harness.fake.sent.length
    try {
      await harness.fake.emitMessage(fakeMessage({ content: 'task-b' }))
      await vi.waitFor(() => { expect(agent.inject).toHaveBeenCalledTimes(1) }, PATIENCE)
      expect(agent.followup).toHaveBeenCalledTimes(1)
      expect(agent.steer).not.toHaveBeenCalled()
      expect(spokenContent(agent.inject.mock.calls[0]![0])).toContain('task-b')
      expect(receiptsSince(harness, before).some(line => line.includes('注入'))).toBe(true)
    } finally { await harness.dispose() }
  })

  it('keeps an idle message an ordinary follow-up whatever the policy', async () => {
    const { harness, agent } = await mountWith('steer', { running: false })
    const before = harness.fake.sent.length
    try {
      await harness.fake.emitMessage(fakeMessage({ content: 'task-b' }))
      await vi.waitFor(() => { expect(agent.followup).toHaveBeenCalledTimes(2) }, PATIENCE)
      // Nothing is running, so nothing is steered — and no receipt is due:
      // there is no wait for the chat to misread.
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.inject).not.toHaveBeenCalled()
      expect(receiptsSince(harness, before)).toEqual([])
    } finally { await harness.dispose() }
  })

  it('falls back to the queue when the host has no steer, and says so', async () => {
    const { harness, agent } = await mountWith('steer')
    const before = harness.fake.sent.length
    try {
      Reflect.deleteProperty(agent, 'steer')
      await harness.fake.emitMessage(fakeMessage({ content: 'task-b' }))
      await vi.waitFor(() => { expect(agent.followup).toHaveBeenCalledTimes(2) }, PATIENCE)
      const lines = receiptsSince(harness, before)
      expect(lines.some(line => line.includes('不支持中途插话'))).toBe(true)
    } finally { await harness.dispose() }
  })
})

describe('busyDelivery', () => {
  const agent = { steer: () => {}, inject: () => {} }

  it('never steers an idle agent', () => {
    expect(busyDelivery(false, 'steer', agent)).toEqual({ policy: 'queue', receipt: '' })
    expect(busyDelivery(false, 'inject', agent)).toEqual({ policy: 'queue', receipt: '' })
  })

  it('names the receipt the policy produced', () => {
    expect(busyDelivery(true, 'queue', agent).policy).toBe('queue')
    expect(busyDelivery(true, 'steer', agent).policy).toBe('steer')
    expect(busyDelivery(true, 'inject', agent).policy).toBe('inject')
  })

  it('degrades a missing boundary to the queue rather than throwing', () => {
    expect(busyDelivery(true, 'steer', {}).policy).toBe('queue')
    expect(busyDelivery(true, 'inject', {}).policy).toBe('queue')
    expect(busyDelivery(true, 'steer', {}).receipt).toContain('steer')
    expect(busyDelivery(true, 'inject', {}).receipt).toContain('inject')
  })
})
