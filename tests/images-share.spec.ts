/**
 * 分享过来的图片：图在「被引用那条」消息上，不在带文字的回消息上。
 *
 * 2026-11-11 现场：飞书从别的应用分享图片 + 文字时，发成两条——图片一条、
 * 文字回一条并引用它。回消息的 `resources` 里照样列着图片，桥却拿回消息的
 * id 去取资源，飞书回 400 `type is required`，模型只看到一句「附加失败」。
 *
 * 所以 `collectImages` 必须能在「另一条消息」上取图。
 */

import { describe, expect, it } from 'vitest'
import { collectImages } from '../src/images.ts'
import type { HostAttachments } from '../src/host.ts'

const IMAGE_KEY = 'img_v3_share_test'

/** A message-shaped object carrying one image resource. */
function messageWithImage(messageId: string): never {
  return {
    messageId,
    chatId: 'oc_1',
    content: '',
    resources: [{ type: 'image', fileKey: IMAGE_KEY }],
  } as never
}

/** The smallest attachment store that accepts anything it is handed. */
function store(): HostAttachments {
  return {
    imageLimits: {
      maxImageBytes: 10_000_000,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 50_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    saveImage: async () => ({ attachmentId: 'att_1' }),
  } as unknown as HostAttachments
}

describe('collectImages 的来源消息', () => {
  it('默认在消息自己身上取图', async () => {
    const asked: string[] = []
    const port = {
      async downloadResourceWithMeta(messageId: string) {
        asked.push(messageId)
        return { buffer: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }
      },
    }
    const result = await collectImages(messageWithImage('om_self'), port, store(), true)
    expect(asked).toEqual(['om_self'])
    expect(result.blocks).toHaveLength(1)
    expect(result.notes).toEqual([])
  })

  it('分享的图按来源消息 id 取，不在带文字那条上取', async () => {
    const asked: string[] = []
    const port = {
      async downloadResourceWithMeta(messageId: string) {
        // 拿错了就是现场那个 400：文字消息上没有这张图。
        if (messageId !== 'om_image_owner') throw new Error('Request failed with status code 400')
        asked.push(messageId)
        return { buffer: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }
      },
    }
    const result = await collectImages(messageWithImage('om_text_reply'), port, store(), true, undefined, 'om_image_owner')
    expect(asked).toEqual(['om_image_owner'])
    expect(result.blocks).toHaveLength(1)
    expect(result.notes).toEqual([])
  })

  it('取图失败时把原因同时报出去，让日志能看见', async () => {
    const lines: string[] = []
    const port = {
      async downloadResourceWithMeta() {
        throw new Error('Request failed with status code 400')
      },
    }
    const result = await collectImages(messageWithImage('om_text_reply'), port, store(), true, line => lines.push(line))
    expect(result.blocks).toEqual([])
    expect(result.notes[0]).toContain('附加失败')
    expect(lines[0]).toContain(IMAGE_KEY)
    expect(lines[0]).toContain('400')
  })
})
