import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTICE_TTL_MS,
  deliverRestartNotice,
  readRestartRequest,
  restartNoticeLine,
  restartNoticePath,
  scheduleRestartNotice,
  writeRestartRequest,
} from '../src/restart-notice.ts'

describe('restart notice', () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lark-restart-'))
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('round-trips a request', () => {
    expect(writeRestartRequest('oc_chat', home)).toBe(true)
    const request = readRestartRequest(home)
    expect(request?.chatId).toBe('oc_chat')
    expect(typeof request?.requestedAt).toBe('number')
  })

  it('returns null without a record', () => {
    expect(readRestartRequest(home)).toBeNull()
  })

  it('drops and clears a stale record', () => {
    writeRestartRequest('oc_chat', home)
    expect(readRestartRequest(home, Date.now() + NOTICE_TTL_MS + 1000)).toBeNull()
    expect(fs.existsSync(restartNoticePath(home))).toBe(false)
  })

  it('drops an unparsable record', () => {
    fs.writeFileSync(restartNoticePath(home), '{not json', 'utf8')
    expect(readRestartRequest(home)).toBeNull()
    expect(fs.existsSync(restartNoticePath(home))).toBe(false)
  })

  it('renders the restored line with time and duration', () => {
    const requestedAt = Date.now() - 138_000
    const line = restartNoticeLine({ chatId: 'oc_chat', requestedAt }, Date.now())
    expect(line).toContain('重启完成')
    expect(line).toContain('2 分')
  })

  it('renders seconds for a short restart', () => {
    const line = restartNoticeLine({ chatId: 'oc_chat', requestedAt: Date.now() - 45_000 }, Date.now())
    expect(line).toContain('45 秒')
  })

  it('delivers once and clears the record', async () => {
    writeRestartRequest('oc_chat', home)
    const sent: Array<{ chatId: string; markdown: string }> = []
    const port = {
      send: async (chatId: string, message: { markdown: string }): Promise<void> => {
        sent.push({ chatId, markdown: message.markdown })
      },
    }
    await expect(deliverRestartNotice(port, () => {}, { home })).resolves.toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.chatId).toBe('oc_chat')
    expect(sent[0]?.markdown).toContain('重启完成')
    expect(readRestartRequest(home)).toBeNull()
  })

  it('keeps the record when delivery fails', async () => {
    writeRestartRequest('oc_chat', home)
    const lines: string[] = []
    const port = {
      send: async (): Promise<void> => {
        throw new Error('ws down')
      },
    }
    await expect(deliverRestartNotice(port, line => lines.push(line), { home })).resolves.toBe('retry')
    expect(lines.some(line => line.includes('retry'))).toBe(true)
    expect(readRestartRequest(home)?.chatId).toBe('oc_chat')
  })

  it('does nothing without a record', async () => {
    const port = { send: async (): Promise<void> => {} }
    await expect(deliverRestartNotice(port, () => {}, { home })).resolves.toBe('none')
  })

  it('retries until the transport accepts, then stops', async () => {
    writeRestartRequest('oc_chat', home)
    let calls = 0
    const port = {
      send: async (): Promise<void> => {
        calls += 1
        if (calls === 1) throw new Error('connecting')
      },
    }
    const stop = scheduleRestartNotice(port, () => {}, { home, intervalMs: 10, maxAttempts: 5 })
    try {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))
      expect(readRestartRequest(home)).toBeNull()
    } finally {
      stop()
    }
  })

  it('never double-posts when a send hangs across ticks', async () => {
    writeRestartRequest('oc_chat', home)
    const sent: string[] = []
    const port = {
      send: async (_chatId: string, message: { markdown: string }): Promise<void> => {
        await new Promise(resolve => setTimeout(resolve, 40))
        sent.push(message.markdown)
      },
    }
    const stop = scheduleRestartNotice(port, () => {}, { home, intervalMs: 5, maxAttempts: 5 })
    try {
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      // Several more 5ms ticks elapse while nothing is in flight; the guard
      // must keep the count at one (the bug re-sent on every overlapping tick).
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(sent).toHaveLength(1)
    } finally {
      stop()
    }
  })
})
