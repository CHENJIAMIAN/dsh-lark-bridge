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
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
/** The `send_file` tool the bridge registers on chat agents. */
export const SEND_FILE_TOOL_NAME = 'send_file';
/**
 * The kind a file is delivered in, read from its extension.
 *
 * Only the containers the transport can actually carry in kind count as audio
 * or video: it declares every such upload as an `opus` or `mp4` container and
 * reads the duration out of an Ogg or MP4 stream, refusing the send when it
 * finds neither. An mp3 named as a voice note therefore fails at upload, while
 * a file attachment always arrives — so everything outside those two containers
 * is a file. The extension is the only signal the model does not have to be
 * taught, and an unknown one reads as a file, the shape that always works.
 * @param fileName - the file's name.
 * @returns the kind to deliver it in.
 */
export function sendFileKindFor(fileName) {
    const ext = extensionOf(fileName);
    if (AUDIO_EXTENSIONS.has(ext))
        return 'audio';
    if (VIDEO_EXTENSIONS.has(ext))
        return 'video';
    if (IMAGE_EXTENSIONS.has(ext))
        return 'image';
    return 'file';
}
/** A name's lowercased extension, without the dot. */
function extensionOf(fileName) {
    return fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
}
/** Extensions delivered as a voice note: Ogg containers, the only ones it can time. */
const AUDIO_EXTENSIONS = new Set(['ogg', 'opus']);
/** Extensions delivered as a video: MP4 containers, the only ones it can time. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v']);
/** Extensions delivered as an image; image upload needs no duration. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
/**
 * Extensions that name a recording whose container the transport cannot carry.
 * They arrive as files, and the caller is told so: a send that would have failed
 * at upload must not look like a voice note that went out.
 */
const AUDIO_SHAPED_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'amr']);
/** Extensions that name a clip whose container the transport cannot carry. */
const VIDEO_SHAPED_EXTENSIONS = new Set(['mov', 'mkv', 'webm', 'avi']);
/** Model-facing content renderer for the tool's canonical result. */
export function renderSendFileResult(args, value) {
    void args;
    if (value.ok && value.fileName !== undefined) {
        const sent = `已发送文件 \`${value.fileName}\` 到当前聊天。`;
        return [{ type: 'text', text: value.note === undefined ? sent : `${sent}${value.note}` }];
    }
    return [{ type: 'text', text: `文件发送失败：${value.error ?? '未知错误'}` }];
}
/** Presentation title for one pending call, for the call log/card header. */
export function presentSendFileCall(args) {
    const path = args.path;
    return { title: `发送文件 ${typeof path === 'string' ? path : ''}`.trimEnd() };
}
/**
 * The tool definition to register on one chat agent's scope. The factory
 * captures the bridge's delivery capability so the tool can reach the chat
 * the agent belongs to.
 * @param capability - the bridge's file delivery hook.
 * @returns a dsh `ToolDefinition`-shaped registration.
 */
export function createSendFileTool(capability) {
    return {
        name: SEND_FILE_TOOL_NAME,
        description: 'Send one file from the workspace as an attachment in the current chat. '
            + 'Use it to deliver finished artifacts to the human: HTML reports, PDFs, '
            + 'spreadsheets, images, logs. The human can open or download the file '
            + 'directly from the chat. Pass an absolute path, or a path relative to '
            + 'the workspace root. A recording or a clip plays in place only in a '
            + 'container the chat can carry — ogg or opus for a voice note, mp4 or m4v '
            + 'for a video. Every other media format (mp3, wav, m4a, aac, flac, amr, '
            + 'mov, mkv, webm, avi) arrives as a file attachment, and the result says '
            + 'when that happened.',
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
                    description: 'How to deliver it. Omit it and the extension decides: '
                        + 'an ogg or opus recording arrives as a voice note, an mp4 or m4v clip as a video, '
                        + 'an image as an image, everything else as a file. Naming a kind can narrow the shape '
                        + '(ask for a file or an image) but cannot widen it: a format the chat cannot carry in '
                        + 'kind always arrives as a file, and the result says so.',
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
                    note: { type: 'string' },
                    error: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: renderSendFileResult,
            presentationMeta: presentSendFileCall,
        },
        async execute(args, exec) {
            const parsed = args;
            const sessionId = exec.agent?.session?.id;
            if (sessionId === undefined) {
                return { ok: false, error: '无法确定所属会话' };
            }
            try {
                const delivered = await capability.deliverBySession(sessionId, parsed);
                return delivered.note === undefined
                    ? { ok: true, fileName: delivered.fileName }
                    : { ok: true, fileName: delivered.fileName, note: delivered.note };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
/** Model-facing name of each shape that needs a container. */
const MEDIA_LABEL = { audio: '语音', video: '视频' };
/** The one container per shape the transport can carry. */
const MEDIA_CONTAINERS = { audio: 'ogg/opus', video: 'mp4/m4v' };
/** How long a probe may take before the file is delivered as a plain attachment. */
const FFPROBE_TIMEOUT_MS = 8_000;
const execFileAsync = promisify(execFile);
/**
 * Measure one file's duration in milliseconds, without making `ffprobe` a
 * dependency: the transport times an Ogg or MP4 container itself, so a machine
 * without the tool still sends those two in kind. What it cannot do is time a
 * payload its parser trips over, which is why a failed measurement is reported
 * rather than guessed.
 * @param path - the file to measure.
 * @returns the duration, or why there is none.
 */
async function probeDurationMs(path) {
    try {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: FFPROBE_TIMEOUT_MS });
        const seconds = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(seconds) || seconds <= 0)
            return { state: 'failed' };
        return { state: 'measured', ms: Math.round(seconds * 1000) };
    }
    catch (error) {
        // A missing tool is not a measurement that failed: nothing was measured.
        return error.code === 'ENOENT'
            ? { state: 'no-tool' }
            : { state: 'failed' };
    }
}
/**
 * Decide the shape of one delivery, measuring a duration where the transport
 * needs one.
 *
 * A named kind can narrow the shape (a file always arrives) but never widen it:
 * the transport declares a voice note as an `opus` container and a video as
 * `mp4`, and rejects the send when it cannot time the payload — so asking for
 * audio on an mp3 is a send that would fail, and a file attachment plus a note
 * is the honest alternative.
 * @param fileName - the delivered file's base name.
 * @param asked - the caller's `kind`, when it named one.
 * @param path - absolute path, for measuring.
 * @param measure - the duration measurement to use.
 */
async function planDelivery(fileName, asked, path, measure) {
    if (asked === 'file' || asked === 'image')
        return { kind: asked };
    const deliverable = sendFileKindFor(fileName);
    const wanted = asked ?? claimedMediaKind(fileName) ?? deliverable;
    if (wanted === 'file' || wanted === 'image')
        return { kind: wanted };
    if (deliverable !== wanted) {
        return {
            kind: 'file',
            note: `${MEDIA_LABEL[wanted]}仅支持 ${MEDIA_CONTAINERS[wanted]} 容器，该文件已作为文件发送。`,
        };
    }
    const measured = await measure(path);
    if (measured.state === 'failed') {
        return {
            kind: 'file',
            note: `读不出该文件的时长，${MEDIA_LABEL[wanted]}无法定时发送，已作为文件发送。`,
        };
    }
    return measured.state === 'measured'
        ? { kind: wanted, duration: measured.ms }
        : { kind: wanted };
}
/** The media shape a name claims, whether or not the transport can carry it. */
function claimedMediaKind(fileName) {
    const ext = extensionOf(fileName);
    if (AUDIO_SHAPED_EXTENSIONS.has(ext))
        return 'audio';
    if (VIDEO_SHAPED_EXTENSIONS.has(ext))
        return 'video';
    return undefined;
}
/**
 * Deliver a file to a chat through the outbound transport. Resolves with the
 * delivered file name, or rejects with a message the tool turns into a result.
 * @param port - the outbound transport (replay-wrapped by the bridge).
 * @param chatId - the target chat.
 * @param cwd - workspace root, for resolving relative paths.
 * @param args - the parsed tool arguments.
 * @param measure - duration measurement for a voice note or a video; defaults to `ffprobe`.
 */
export async function deliverFile(port, chatId, cwd, args, measure = probeDurationMs) {
    const absolute = resolve(cwd, args.path);
    const stat = await fs.stat(absolute).catch((error) => {
        throw new Error(`文件不存在或不可读：${args.path}（${error instanceof Error ? error.message : String(error)}）`);
    });
    if (!stat.isFile())
        throw new Error(`不是文件：${args.path}`);
    const fileName = absolute.split(/[\\/]/).pop() ?? 'file';
    // SendInput is a UNION: `file` and `markdown` are mutually exclusive
    // members, and the transport dispatches on `"markdown" in input` FIRST — a
    // mixed `{ file, markdown }` shape silently sends only the caption and
    // drops the file. A caption must be its own message, before the file.
    const caption = args.caption;
    if (caption !== undefined && caption !== '') {
        await port.send(chatId, { markdown: caption });
    }
    const delivery = await planDelivery(fileName, args.kind, absolute, measure);
    const duration = delivery.duration;
    if (delivery.kind === 'image') {
        await port.send(chatId, { image: { source: absolute } });
    }
    else if (delivery.kind === 'audio') {
        await port.send(chatId, duration === undefined
            ? { audio: { source: absolute } }
            : { audio: { source: absolute, duration } });
    }
    else if (delivery.kind === 'video') {
        await port.send(chatId, duration === undefined
            ? { video: { source: absolute } }
            : { video: { source: absolute, duration } });
    }
    else {
        await port.send(chatId, { file: { source: absolute, fileName } });
    }
    return delivery.note === undefined ? { fileName } : { fileName, note: delivery.note };
}
// ── Inbound file saving (P045) ──────────────────────────────────────────────
import { join as _join } from 'node:path';
/** Inbound resource kinds the bridge persists, with their note flavour. */
const INBOUND_KINDS = {
    file: { label: '文件', icon: '📎' },
    audio: { label: '语音', icon: '🎤' },
    video: { label: '视频', icon: '🎬' },
    sticker: { label: '贴纸', icon: '🏷️' },
};
/**
 * Whether a path is already taken.
 *
 * The synchronous form of this question blocks the event loop for the length of
 * a `stat`, which on a Windows-bridged workspace is a round trip to the host —
 * and this is asked on the inbound message path. Any error answers "not taken",
 * the same reading the synchronous form gave.
 * @param path - the candidate destination.
 */
async function pathTaken(path) {
    try {
        await fs.access(path);
        return true;
    }
    catch {
        return false;
    }
}
/** A destination that does not overwrite an earlier arrival with the same name. */
async function uniqueDest(base) {
    if (!(await pathTaken(base)))
        return base;
    const dot = base.lastIndexOf('.');
    const cut = dot > base.lastIndexOf('/') ? dot : base.length;
    const stem = base.slice(0, cut);
    const ext = base.slice(cut);
    for (let n = 2;; n += 1) {
        const candidate = `${stem}-${n}${ext}`;
        if (!(await pathTaken(candidate)))
            return candidate;
    }
}
/**
 * Download and save non-image resources from one chat message into the agent's
 * workspace so the agent can read them with its own tools. Audio, video and
 * stickers ride the same download path (`type: 'file'` — the SDK fetches any
 * non-image resource by key); before this they were dropped silently and the
 * model only ever saw a placeholder tag.
 */
export async function saveInboundFiles(msg, download, workDir) {
    const files = msg.resources.filter((r) => Object.hasOwn(INBOUND_KINDS, r.type));
    if (files.length === 0)
        return { notes: [], paths: [] };
    const notes = [];
    const paths = [];
    for (const file of files) {
        const flavour = INBOUND_KINDS[file.type];
        // Control characters would inject line breaks into the note the model reads.
        const cleaned = (file.fileName || `${file.type}_${file.fileKey.slice(0, 12)}`)
            .replace(/[/\\]/g, '_')
            .replace(/[\u0000-\u001f\u007f]/g, '_');
        try {
            // Booked before the download: the name settles while the bytes are still
            // in flight, which leaves the write as the only step left when they land.
            const dest = await uniqueDest(_join(workDir, cleaned));
            const { buffer } = await download(msg.messageId, file.fileKey, 'file');
            // Asynchronous on purpose: this runs for every inbound message, and a
            // blocking write holds the event loop for the length of the disk I/O. On
            // a Windows-bridged workspace each write is a round trip to the host, so
            // one inbound file would freeze every other chat in the bridge until it
            // returned. A failed write rejects into the `catch` below, which is the
            // same place a failed synchronous write raised.
            await fs.writeFile(dest, buffer);
            paths.push(dest);
            const savedName = dest.split(/[/\\]/).pop() ?? cleaned;
            notes.push(`${flavour.icon} 用户发送了${flavour.label}「${savedName}」，已保存到工作区`);
        }
        catch (e) {
            notes.push(`${flavour.icon} ${flavour.label} ${cleaned} 保存失败：${String(e).slice(0, 80)}`);
        }
    }
    return { notes, paths };
}
//# sourceMappingURL=files.js.map