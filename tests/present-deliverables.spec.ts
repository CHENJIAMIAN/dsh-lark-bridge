import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * The model can end a turn by declaring files it produced. The bridge
 * delivers them to the chat, because a deliverable that stays on the host's
 * disk is invisible to the person who asked for it.
 */
describe('declared deliverables reach the chat', () => {
  /** A real file on disk, so the delivery has something to upload. */
  function realFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-present-'))
    const path = join(dir, name)
    writeFileSync(path, 'deliverable')
    return path
  }

  /** Bind one chat and return an emitter for its session events. */
  async function chat(harness: Awaited<ReturnType<typeof mountChannel>>) {
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  /** The files the harness saw sent, in order. */
  function sentFiles(harness: Awaited<ReturnType<typeof mountChannel>>) {
    return harness.fake.sent
      .map((s) => (s.input as { file?: { source?: string; fileName?: string } }).file)
      .filter((f): f is { source?: string; fileName?: string } => f !== undefined)
  }

  it('delivers a declared file to the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    const path = realFile('report.html')

    emit('deliverables/presented', {
      turn: 3,
      callId: 'call-1',
      files: [{ path, description: '季度报告' }],
    })

    await vi.waitFor(() => { expect(sentFiles(harness).length).toBe(1) }, { timeout: 20_000, interval: 50 })
    expect(sentFiles(harness)[0]!.fileName).toBe('report.html')
    await harness.dispose()
  })

  it('does not deliver the same declaration twice', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    const path = realFile('report.html')

    const declaration = { turn: 3, callId: 'call-1', files: [{ path }] }
    emit('deliverables/presented', declaration)
    await vi.waitFor(() => { expect(sentFiles(harness).length).toBe(1) }, { timeout: 20_000, interval: 50 })
    // A host may replay the event; the call id is what makes it once.
    emit('deliverables/presented', declaration)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(sentFiles(harness).length).toBe(1)
    await harness.dispose()
  })

  it('delivers nothing when the bridge is switched off', async () => {
    const harness = await mountChannel({ presentBridge: false })
    const emit = await chat(harness)
    const path = realFile('report.html')

    emit('deliverables/presented', { turn: 1, callId: 'call-1', files: [{ path }] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(sentFiles(harness).length).toBe(0)
    await harness.dispose()
  })

  it('reports a file it cannot deliver, in the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)

    // A path that does not exist cannot be uploaded; the chat is told rather
    // than the delivery failing silently.
    emit('deliverables/presented', {
      turn: 1,
      callId: 'call-1',
      files: [{ path: '/tmp/definitely-not-here-9f3a.html' }],
    })

    await vi.waitFor(() => {
      const said = harness.fake.sent.some((s) => {
        const md = String((s.input as { markdown?: string }).markdown ?? '')
        return md.includes('未能送达')
      })
      expect(said).toBe(true)
    }, { timeout: 20_000, interval: 50 })
    await harness.dispose()
  })
})
