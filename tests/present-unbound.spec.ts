import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeMessage, mountChannel } from './harness.ts'

/**
 * The host's `present` tool is available to every agent, including a subagent,
 * and its event carries no "who declared this" beyond the session it lands in.
 * A file that cannot be delivered is reported in the chat rather than failing
 * silently — this is the case where it used to be neither.
 */
describe('a declaration from a session this chat does not own', () => {
  it('is reported, not dropped without a word', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const before = harness.fake.sent.length
    const file = join(mkdtempSync(join(tmpdir(), 'dsh-child-')), 'report.html')
    writeFileSync(file, 'deliverable')

    // A child session: the host runs every subagent in its own session.
    harness.ctx.emit('session/event', { id: 'session_of_a_child_agent' }, {
      type: 'deliverables/presented',
      data: { turn: 2, callId: 'call-child', files: [{ path: file, description: '子任务产物' }] },
    })

    await new Promise((resolve) => setTimeout(resolve, 400))
    const after = harness.fake.sent.slice(before)
    const files = after.filter(s => (s.input as { file?: unknown }).file !== undefined)
    // Either the file reached the chat, or the reader was told that it did
    // not. Silence is the failure: a reader cannot tell "it worked" from
    // "it vanished".
    const notices = after.filter(s => {
      const text = String((s.input as { markdown?: string }).markdown ?? '')
      return text.includes('未能送达') || text.includes('交付文件')
    })
    expect(files.length + notices.length).toBeGreaterThan(0)
    await harness.dispose()
  })
})
