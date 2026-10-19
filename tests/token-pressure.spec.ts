import { describe, expect, it, vi } from 'vitest'
import type { HostSession, HostTokenMeter } from '../src/host.ts'
import { tokenPressureLine } from '../src/notices.ts'
import { fakeMessage, mountChannel } from './harness.ts'

const THRESHOLD = 120_000
/** The schema floor; polls run on the production cadence, driven by fake timers. */
const INTERVAL_MS = 60_000

/**
 * A `tokenMeter` that prices a session the way the host's does: replay the
 * session log through `seq` + `eventAt(seq)` and add up what each event costs.
 *
 * The replay loop is written against `session.seq` in the same shape as the
 * upstream `_sync` (its `while (consumed < session.seq)`), which is what makes
 * this double worth having: handed something that merely carries an `id`, the
 * comparison is against `undefined`, the loop never runs, and every session
 * prices at zero — silently, because nothing throws. That is the production
 * failure this spec pins; a double that reads `id` and looks up a total in a
 * fixture table could never see it.
 */
function createFakeTokenMeter() {
  /** Every session object the bridge handed `measure`, in call order. */
  const priced: HostSession[] = []
  const service: HostTokenMeter = {
    measure(session: HostSession) {
      priced.push(session)
      let totalTokens = 0
      let surfaceTokens = 0
      for (let seq = 0; seq < session.seq; seq += 1) {
        const event = session.eventAt(seq) as { tokens?: number; surface?: number } | undefined
        totalTokens += event?.tokens ?? 0
        surfaceTokens += event?.surface ?? 0
      }
      return { totalTokens, surfaceTokens }
    },
  }
  return { service, priced }
}

/** The context-pressure warnings this run posted, in send order. */
function pressureWarnings(harness: Awaited<ReturnType<typeof mountChannel>>) {
  return harness.fake.sent.filter(
    sent => 'markdown' in sent.input && sent.input.markdown.includes('上下文压力'),
  )
}

/** Hold until exactly `count` pressure warnings went out; a quiet sweep fails loudly. */
async function waitForWarnings(harness: Awaited<ReturnType<typeof mountChannel>>, count: number) {
  await vi.waitFor(() => {
    const warnings = pressureWarnings(harness)
    if (warnings.length !== count) {
      throw new Error(`expected ${count} context-pressure warning(s), got ${warnings.length} of ${harness.fake.sent.length} send(s)`)
    }
  }, { timeout: 10_000, interval: 50 })
}

/**
 * Mount the bridge, drive one inbound message so a session is bound, and hand
 * back that session's log. The log is the only input the fake meter prices, so
 * a test grows the context by appending to it.
 */
async function mountWithLiveSession() {
  const meter = createFakeTokenMeter()
  const harness = await mountChannel(
    { onboarding: false, tokenPressure: { enabled: true, intervalMs: INTERVAL_MS, threshold: THRESHOLD } },
    { tokenMeter: meter.service },
  )
  await harness.fake.emitMessage(fakeMessage({ content: '长任务' }))
  // The inbound handler is fire-and-forget (the bridge voids it), so the agent
  // and its binding land after `emitMessage` returns. The 1 s default timeout
  // is what the suite's own config calls out as the flake on a loaded machine.
  await vi.waitFor(() => {
    if (harness.agents.created.length === 0) throw new Error('the inbound message created no agent')
  }, { timeout: 30_000, interval: 50 })
  const session = harness.agents.created[0]!.agent.session
  const events = harness.agents.sessionEvents.get(session.id)!
  return { harness, meter, session, events }
}

describe('context-pressure polling', () => {
  it('prices the bound session object and warns once per crossing', async () => {
    vi.useFakeTimers()
    try {
      const { harness, meter, session, events } = await mountWithLiveSession()
      // 145,000 tokens over two events: a context past the 120,000 advice line.
      events.push({ tokens: 90_000, surface: 4_000 }, { tokens: 55_000, surface: 1_200 })

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // What the meter was handed: the host's own session object, with the
      // fields the replay needs. Soft, so a run that hands it an id reports
      // this AND the missing warning below instead of stopping at the first.
      // Every poll is checked rather than a count assumed: waiting out a slow
      // agent creation can advance the clock far enough for an early poll.
      const priced = meter.priced.at(-1)
      expect.soft(meter.priced.length).toBeGreaterThan(0)
      for (const seen of meter.priced) expect.soft(seen).toBe(session)
      expect.soft(priced?.seq).toBe(2)
      expect.soft(typeof priced?.eventAt).toBe('function')

      await waitForWarnings(harness, 1)

      // The measured total — not a threshold constant — is what the chat reads.
      expect(pressureWarnings(harness)[0]!.input).toEqual({
        markdown: tokenPressureLine({ total: 145_000, surface: 5_200, threshold: THRESHOLD }),
      })

      // Still over the line: the next poll must not repeat itself. The zero
      // advance lets the poll's fire-and-forget send land before counting, so a
      // duplicate is caught here rather than reported as a passing quiet step.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(pressureWarnings(harness)).toHaveLength(1)

      // Compaction drops the session back under the line: no new warning, and
      // the crossing is re-armed.
      events.length = 0
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(pressureWarnings(harness)).toHaveLength(1)

      // A fresh climb warns again.
      events.push({ tokens: 130_000, surface: 2_000 })
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await waitForWarnings(harness, 2)

      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet while the session prices below the threshold', async () => {
    vi.useFakeTimers()
    try {
      const { harness, events } = await mountWithLiveSession()
      events.push({ tokens: 60_000, surface: 1_000 })

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(pressureWarnings(harness)).toHaveLength(0)

      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
