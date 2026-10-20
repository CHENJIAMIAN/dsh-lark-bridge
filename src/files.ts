/**
 * File delivery: the `send_file` tool the bridge registers on every chat
 * agent, and the delivery helper it calls.
 *
 * The host session event stream carries no file payloads — a tool result is
 * text, a path is not an artifact the channel knows about. So the channel
 * exposes its own tool: an agent that produced a report, spreadsheet, or
 * image calls `send_file(path)` and the bridge uploads that file to the
 * Feishu chat as a real attachment. The agent learns the outcome in its
 * result, and the human gets a clickable file in the chat it is already
 * watching.
 * @module dsh-lark-bridge/files
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { OutboundPort } from './outbound.ts'

/** The `send_file` tool the bridge registers on chat agents. */
export const SEND_FILE_TOOL_NAME = 'send_file'

/** Parsed `send_file` arguments, validated by the tool schema. */
export interface SendFileArgs {
  /** Absolute or workspace-relative path of the file to deliver. */
  readonly path: string
  /** Optional caption text delivered with the attachment. */
  readonly caption?: string
  /**
   * How to deliver the file, when the extension does not say.
   *
   * A recording named `recording.dat` would otherwise arrive as a download
   * link; the transport can carry it as a voice note the human plays in
   * place. Omitted, the kind is read from the extension.
   */
  readonly kind?: SendFileKind
}

/** The shapes the transport can deliver a file in. */
export type SendFileKind = 'file' | 'image' | 'audio' | 'video'

/**
 * The kind a file is delivered in, read from its extension.
 *
 * The extension is the only signal the model does not have to be taught:
 * a `.mp3` is a recording and a `.mp4` is a clip, whatever the tool call
 * says. An unknown extension is a file — the safe reading, because a file
 * can always be opened.
 * @param fileName - the file's name.
 * @returns the kind to deliver it in.
 */
export function sendFileKindFor(fileName: string): SendFileKind {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'file'
}

/** Extensions the transport delivers as a voice note. */
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'amr'])
/** Extensions the transport delivers as a video. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'])
/** Extensions the transport delivers as an image. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

/** The file-delivery capability the tool factory receives from the bridge. */
export interface SendFileCapability {
  /**
   * Deliver one file on behalf of an agent session. Resolves when the platform
   * accepted the upload and the message send settled; rejects with a
   * descriptive error on any failure (unknown session, missing file, too
   * large, transport down).
   */
  deliverBySession(sessionId: string, args: SendFileArgs): Promise<{ readonly fileName: string }>
}

/** Canonical JSON value the tool's `output.schema` declares. */
export interface SendFileResult {
  readonly ok: boolean
  readonly fileName?: string
  readonly error?: string
}

/** Model-facing content renderer for the tool's canonical result. */
export function renderSendFileResult(args: unknown, value: SendFileResult): object[] {
  void args
  if (value.ok && value.fileName !== undefined) {
    return [{ type: 'text', text: `已发送文件 \`${value.fileName}\` 到当前聊天。` }]
  }
  return [{ type: 'text', text: `文件发送失败：${value.error ?? '未知错误'}` }]
}

/** Presentation title for one pending call, for the call log/card header. */
export function presentSendFileCall(args: unknown): { readonly title?: string; readonly kind?: string } {
  const path = (args as { path?: unknown }).path
  return { title: `发送文件 ${typeof path === 'string' ? path : ''}`.trimEnd() }
}

/**
 * The tool definition to register on one chat agent's scope. The factory
 * captures the bridge's delivery capability so the tool can reach the chat
 * the agent belongs to.
 * @param capability - the bridge's file delivery hook.
 * @returns a dsh `ToolDefinition`-shaped registration.
 */
export function createSendFileTool(capability: SendFileCapability): object {
  return {
    name: SEND_FILE_TOOL_NAME,
    description:
      'Send one file from the workspace as an attachment in the current chat. '
      + 'Use it to deliver finished artifacts to the human: HTML reports, PDFs, '
      + 'spreadsheets, images, logs. The human can open or download the file '
      + 'directly from the chat. Pass an absolute path, or a path relative to '
      + 'the workspace root.',
    // `parameters` (not `schema`) is the ToolSchema field dsh projects onto
    // the model. A JSON Schema object, so snapshotJsonValue keeps it lossless.
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path of the file to send' },
        caption: { type: 'string', description: 'Optional short caption delivered with the file' },
        kind: {
          type: 'string',
          enum: ['file', 'image', 'audio', 'video'],
          description: 'How to deliver it. Omit it and the file extension decides: '
            + 'a recording arrives as a voice note and a clip as a video, both playable in the chat. '
            + 'Name it only when the extension does not tell.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          fileName: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: renderSendFileResult,
      presentationMeta: presentSendFileCall,
    },
    async execute(args: unknown, exec: unknown): Promise<SendFileResult> {
      const parsed = args as SendFileArgs
      const sessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
      if (sessionId === undefined) {
        return { ok: false, error: '无法确定所属会话' }
      }
      try {
        const { fileName } = await capability.deliverBySession(sessionId, parsed)
        return { ok: true, fileName }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/**
 * Deliver a file to a chat through the outbound transport. Resolves with the
 * delivered file name, or rejects with a message the tool turns into a result.
 * @param port - the outbound transport (replay-wrapped by the bridge).
 * @param chatId - the target chat.
 * @param cwd - workspace root, for resolving relative paths.
 * @param args - the parsed tool arguments.
 */
export async function deliverFile(
  port: OutboundPort,
  chatId: string,
  cwd: string,
  args: SendFileArgs,
): Promise<{ readonly fileName: string }> {
  const absolute = resolve(cwd, args.path)
  const stat = await fs.stat(absolute).catch((error: unknown) => {
    throw new Error(`文件不存在或不可读：${args.path}（${error instanceof Error ? error.message : String(error)}）`)
  })
  if (!stat.isFile()) throw new Error(`不是文件：${args.path}`)
  const fileName = absolute.split(/[\\/]/).pop() ?? 'file'
  // SendInput is a UNION: `file` and `markdown` are mutually exclusive
  // members, and the transport dispatches on `"markdown" in input` FIRST — a
  // mixed `{ file, markdown }` shape silently sends only the caption and
  // drops the file. A caption must be its own message, before the file.
  const caption = args.caption
  if (caption !== undefined && caption !== '') {
    await port.send(chatId, { markdown: caption })
  }
  const kind = args.kind ?? sendFileKindFor(fileName)
  if (kind === 'image') {
    await port.send(chatId, { image: { source: absolute } })
  } else if (kind === 'audio') {
    await port.send(chatId, { audio: { source: absolute } })
  } else if (kind === 'video') {
    await port.send(chatId, { video: { source: absolute } })
  } else {
    await port.send(chatId, { file: { source: absolute, fileName } })
  }
  return { fileName }
}

// ── Inbound file saving (P045) ──────────────────────────────────────────────

import { writeFileSync as _wf } from 'node:fs'
import { join as _join } from 'node:path'

export interface SavedFiles {
  readonly notes: string[]
  readonly paths: string[]
}

/** Inbound resource kinds the bridge persists, with their note flavour. */
const INBOUND_KINDS = {
  file: { label: '文件', icon: '📎' },
  audio: { label: '语音', icon: '🎤' },
  video: { label: '视频', icon: '🎬' },
  sticker: { label: '贴纸', icon: '🏷️' },
} as const

/** A destination that does not overwrite an earlier arrival with the same name. */
function uniqueDest(base: string): string {
  if (!existsSync(base)) return base
  const dot = base.lastIndexOf('.')
  const cut = dot > base.lastIndexOf('/') ? dot : base.length
  const stem = base.slice(0, cut)
  const ext = base.slice(cut)
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`
    if (!existsSync(candidate)) return candidate
  }
}

/**
 * Download and save non-image resources from one chat message into the agent's
 * workspace so the agent can read them with its own tools. Audio, video and
 * stickers ride the same download path (`type: 'file'` — the SDK fetches any
 * non-image resource by key); before this they were dropped silently and the
 * model only ever saw a placeholder tag.
 */
export async function saveInboundFiles(
  msg: { messageId: string; resources: ReadonlyArray<{ type: string; fileKey: string; fileName?: string }> },
  download: (messageId: string, fileKey: string, type: 'image' | 'file') => Promise<{ buffer: Uint8Array }>,
  workDir: string,
): Promise<SavedFiles> {
  const files = msg.resources.filter((r) => Object.hasOwn(INBOUND_KINDS, r.type))
  if (files.length === 0) return { notes: [], paths: [] }
  const notes: string[] = []
  const paths: string[] = []
  for (const file of files) {
    const flavour = INBOUND_KINDS[file.type as keyof typeof INBOUND_KINDS]
    // Control characters would inject line breaks into the note the model reads.
    const cleaned = (file.fileName || `${file.type}_${file.fileKey.slice(0, 12)}`)
      .replace(/[/\\]/g, '_')
      .replace(/[\u0000-\u001f\u007f]/g, '_')
    try {
      const { buffer } = await download(msg.messageId, file.fileKey, 'file')
      const dest = uniqueDest(_join(workDir, cleaned))
      _wf(dest, buffer)
      paths.push(dest)
      const savedName = dest.split(/[/\\]/).pop() ?? cleaned
      notes.push(`${flavour.icon} 用户发送了${flavour.label}「${savedName}」，已保存到工作区`)
    } catch (e: unknown) {
      notes.push(`${flavour.icon} ${flavour.label} ${cleaned} 保存失败：${String(e).slice(0, 80)}`)
    }
  }
  return { notes, paths }
}
