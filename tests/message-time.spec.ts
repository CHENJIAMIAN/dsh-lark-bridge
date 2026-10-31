/**
 * 消息时间戳：引用那条和本条的都要给到模型。
 *
 * 为什么要盯这条：模型看不到任何时间，判断「刚才那个是不是没成」时只能去翻
 * 进程启动时间和文件修改时间，而这个判断一旦错，后面整段复查都白跑。时间戳
 * 必须按本地时区渲染并带偏移——飞书给的是毫秒时间戳，直接格式化在别的时区
 * 机器上会差 8 小时。
 */

import { describe, expect, it } from 'vitest'
import { messageTimeStamp, quotedPrefix } from '../src/bridge.ts'
import type { NormalizedMessage } from '@larksuite/channel'

/** 一条最简消息，只有引用渲染会读的字段。 */
function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_sender',
    content: '正文',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 0,
    ...overrides,
  } as NormalizedMessage
}

describe('messageTimeStamp', () => {
  it('按本地时区渲染到分钟，并带上偏移', () => {
    // 2026-11-01 00:29:00 +08:00
    const stamp = messageTimeStamp(1793464140000)
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(\+08:00\)$/)
  })

  it('本地时区的分钟数换算正确，不差小时', () => {
    // 断言"时刻"而不是写死字符串：换一台别的时区的机器跑，这条仍应成立。
    const at = 1793464140000
    const expected = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at)).replace(/,? /g, ' ')
    expect(messageTimeStamp(at)!.startsWith(expected.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3'))).toBe(true)
    expect(messageTimeStamp(at)).toContain(':29')
  })

  it('没有时间就返回 undefined，不瞎编', () => {
    expect(messageTimeStamp(undefined)).toBeUndefined()
    expect(messageTimeStamp(0)).toBeUndefined()
    expect(messageTimeStamp(Number.NaN)).toBeUndefined()
    expect(messageTimeStamp(-1)).toBeUndefined()
  })
})

describe('quotedPrefix 的时间', () => {
  const quoted = message({ senderName: '陶佳明', content: '重启了好像没生效', createTime: 1793464140000 })

  it('开着时间时，表头带上引用那条的发送时间', () => {
    const block = quotedPrefix(quoted, 8000, true)
    expect(block.startsWith('[引用 · 陶佳明 · ')).toBe(true)
    expect(block).toContain('(+08:00)]')
    expect(block).toContain('重启了好像没生效')
  })

  it('关着时间时退回老样子，不留空括号', () => {
    const block = quotedPrefix(quoted, 8000, false)
    expect(block.startsWith('[引用 · 陶佳明]\n')).toBe(true)
    expect(block).not.toContain('(+08:00)')
  })

  it('引用没有时间戳时，表头不带空的时间位', () => {
    const block = quotedPrefix(message({ senderName: '陶佳明', createTime: 0 }), 8000, true)
    expect(block.startsWith('[引用 · 陶佳明]\n')).toBe(true)
  })

  it('超长引用照样截断，时间不受影响', () => {
    const block = quotedPrefix(message({ senderName: '陶佳明', content: 'x'.repeat(50), createTime: 1793464140000 }), 10, true)
    expect(block).toContain('已截断')
    expect(block).toContain('(+08:00)')
  })
})
