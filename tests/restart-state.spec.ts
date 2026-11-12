import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRestartStore, restartStateFile } from '../src/restart-state.ts'

/** 一个临时 harness home。 */
function home(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-restart-'))
}

describe('restart state store', () => {
  it('keeps a pending question across a fresh store (a restart)', () => {
    const dir = home()
    const store = createRestartStore(dir)
    store.rememberQuestion({
      token: 'abcd1234',
      chatId: 'oc_1',
      sessionId: 'ses_1',
      messageId: 'om_card',
      questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
      askedAt: new Date().toISOString(),
    })

    // 新进程：只凭磁盘把同一个 token 找回来。
    const reopened = createRestartStore(dir)
    const found = reopened.load().questions.find(row => row.token === 'abcd1234')
    expect(found).toMatchObject({ chatId: 'oc_1', sessionId: 'ses_1', messageId: 'om_card' })
    expect(found?.questions[0]?.question).toBe('选哪个？')
  })

  it('forgets a question once it is answered', () => {
    const dir = home()
    const store = createRestartStore(dir)
    store.rememberQuestion({
      token: 't1', chatId: 'oc_1', sessionId: 'ses_1',
      questions: [{ id: 'q1', question: '?' }], askedAt: new Date().toISOString(),
    })
    store.forgetQuestion('t1')
    expect(createRestartStore(dir).load().questions).toEqual([])
  })

  it('drops entries older than a day, so yesterday\'s card is not answerable today', () => {
    const dir = home()
    const file = restartStateFile(dir)
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    writeFileSync(file, JSON.stringify({
      version: 1,
      questions: [{ token: 'old', chatId: 'oc', sessionId: 'ses', questions: [{ id: 'q', question: '?' }], askedAt: old }],
      approvals: [],
      turns: [],
      cards: [],
      deniedTools: [],
    }), 'utf8')
    expect(createRestartStore(dir).load().questions).toEqual([])
  })

  it('reads a corrupt file as empty instead of blocking the boot', () => {
    const dir = home()
    writeFileSync(restartStateFile(dir), '{not json', 'utf8')
    expect(createRestartStore(dir).load()).toMatchObject({ questions: [], approvals: [], turns: [], cards: [] })
  })

  it('keeps the denied-tool list and one turn marker per chat', () => {
    const dir = home()
    const store = createRestartStore(dir)
    store.rememberDeniedTools(['bash', 'write'])
    store.startTurn({ chatId: 'oc_1', sessionId: 'ses_1', turn: 3, startedAt: new Date().toISOString() })
    store.startTurn({ chatId: 'oc_1', sessionId: 'ses_1', turn: 4, startedAt: new Date().toISOString() })

    const reopened = createRestartStore(dir).load()
    expect(reopened.deniedTools).toEqual(['bash', 'write'])
    // 同一个聊天只留最新那一轮，否则开机要报一串已经过去的轮次。
    expect(reopened.turns).toHaveLength(1)
    expect(reopened.turns[0]?.turn).toBe(4)

    store.endTurn('oc_1')
    expect(createRestartStore(dir).load().turns).toEqual([])
  })

  it('writes the file atomically enough to be re-readable', () => {
    const dir = home()
    const store = createRestartStore(dir)
    store.rememberCard({ chatId: 'oc_1', kind: 'console', messageId: 'om_1', updatedAt: new Date().toISOString() })
    const raw = readFileSync(restartStateFile(dir), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(createRestartStore(dir).load().cards[0]).toMatchObject({ kind: 'console', messageId: 'om_1' })
  })
})
