import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverFile } from '../src/files.ts'

/** A fake outbound port recording every send. */
function fakePort() {
  const sent: { to: string; input: object }[] = []
  const port = {
    sent,
    async send(to: string, input: object) {
      sent.push({ to, input })
      return { messageId: `om_${sent.length}` }
    },
    async stream() { return { messageId: 'om_s' } },
  } as never
  return { port, sent }
}

/** A real temp file for delivery tests. */
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-media-'))
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

/**
 * The transport could carry a voice note and a video all along: its send
 * input has an `audio` and a `video` member. The bridge only ever filled in
 * `file`, so a recording arrived as a download link instead of something the
 * human could play in place.
 */
describe('a recording is delivered as a recording', () => {
  it('sends an audio file as audio, not as a file attachment', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('note.mp3', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path })
    expect(sent).toHaveLength(1)
    const input = sent[0]!.input as { audio?: unknown; file?: unknown }
    expect(input.audio).toBeDefined()
    expect(input.file).toBeUndefined()
  })

  it('sends a video file as video', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('clip.mp4', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path })
    const input = sent[0]!.input as { video?: unknown; file?: unknown }
    expect(input.video).toBeDefined()
    expect(input.file).toBeUndefined()
  })

  it('sends an image as an image', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('shot.png', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path })
    const input = sent[0]!.input as { image?: unknown; file?: unknown }
    expect(input.image).toBeDefined()
    expect(input.file).toBeUndefined()
  })

  it('sends anything else as a file', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('report.html', '<p>hi</p>')
    await deliverFile(port, 'oc_1', '/tmp', { path })
    const input = sent[0]!.input as { file?: { fileName?: string }; image?: unknown }
    expect(input.file).toBeDefined()
    expect(input.file!.fileName).toBe('report.html')
    expect(input.image).toBeUndefined()
  })

  it('reads the kind off extensions beyond the obvious three', async () => {
    const { port, sent } = fakePort()
    await deliverFile(port, 'oc_1', '/tmp', { path: tempFile('memo.wav', 'binary') })
    await deliverFile(port, 'oc_1', '/tmp', { path: tempFile('shot.webp', 'binary') })
    await deliverFile(port, 'oc_1', '/tmp', { path: tempFile('clip.webm', 'binary') })
    const inputs = sent.map(entry => entry.input as { audio?: unknown; image?: unknown; video?: unknown })
    expect(inputs[0]!.audio).toBeDefined()
    expect(inputs[1]!.image).toBeDefined()
    expect(inputs[2]!.video).toBeDefined()
  })

  it('lets the caller name the kind when the extension does not tell', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('recording.dat', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path, kind: 'audio' })
    const input = sent[0]!.input as { audio?: unknown; file?: unknown }
    expect(input.audio).toBeDefined()
    expect(input.file).toBeUndefined()
  })

  it('keeps the caption as its own message before the media', async () => {
    const { port, sent } = fakePort()
    const path = tempFile('note.mp3', 'binary')
    await deliverFile(port, 'oc_1', '/tmp', { path, caption: '今天这段' })
    expect(sent).toHaveLength(2)
    expect((sent[0]!.input as { markdown?: string }).markdown).toBe('今天这段')
    expect((sent[1]!.input as { audio?: unknown }).audio).toBeDefined()
  })
})
