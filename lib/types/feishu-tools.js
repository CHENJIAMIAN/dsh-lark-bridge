/**
 * Native Feishu capabilities as agent-callable tools.
 *
 * The bridge already renders the agent TO the human; this module lets the
 * agent act on Feishu itself — proactive messages into the current (or any
 * known) chat, and the app's own cloud-drive space as a durable scratchpad.
 * Both ride capabilities the channel already owns: outbound transport for
 * messages, the FeishuCloud client (built for fleet arbitration/migration)
 * for the drive. Tools follow the `send_file` factory pattern: plain
 * definition objects, the outcome in the result, never a throw across the
 * tool boundary.
 * @module dsh-lark-bridge/feishu-tools
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { listing, resolveEffort, resolveModelRequest } from "./model-switch.js";
import { FeishuCloud } from "./sync/feishu-cloud.js";
/** Tool names, exported for tests and deny-list references. */
export const FEISHU_NOTIFY_TOOL = 'feishu_notify';
export const FEISHU_DRIVE_WRITE_TOOL = 'feishu_drive_write';
export const FEISHU_DRIVE_READ_TOOL = 'feishu_drive_read';
export const FEISHU_DRIVE_LIST_TOOL = 'feishu_drive_list';
export const BIND_WORKSPACE_TOOL = 'bind_workspace';
export const SWITCH_MODEL_TOOL = 'switch_model';
const asText = (value) => (typeof value === 'string' ? value : '');
/**
 * The four definitions. `exec.agent.session.id` names the chat for
 * `feishu_notify` the same way `send_file` resolves its delivery target.
 */
export function createFeishuTools(deps) {
    const resolveChat = (exec, explicit) => {
        if (typeof explicit === 'string' && explicit.trim() !== '')
            return explicit.trim();
        const sessionId = exec.agent?.session?.id;
        return sessionId === undefined ? undefined : deps.chatOfSession(sessionId);
    };
    const cloud = () => {
        if (deps.credentials === undefined)
            return undefined;
        return new FeishuCloud(deps.credentials, deps.fetchImpl);
    };
    return [
        {
            name: BIND_WORKSPACE_TOOL,
            description: 'Bind THIS Feishu chat to a project directory, durably. The next `/new` in this '
                + 'chat starts there, so that directory\'s AGENTS.md is loaded — this is how a chat '
                + 'switches project memory. The running conversation keeps the directory it was '
                + 'created in, so tell the human to send /new. Pass dir="default" to unbind and fall '
                + 'back to the deployment directory.',
            parameters: {
                type: 'object',
                properties: {
                    dir: {
                        type: 'string',
                        description: 'Absolute project directory, or "default" to unbind',
                    },
                },
                required: ['dir'],
            },
            // 工具层强制要求 output：缺了它注册会抛
            // "must declare output { schema, render, presentationMeta? }"，
            // 而 composeChatAgent 把注册异常吞成一行 stderr，工具就静默消失。
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        dir: { type: 'string' },
                        unbind: { type: 'boolean' },
                        note: { type: 'string' },
                        error: { type: 'string' },
                    },
                    additionalProperties: false,
                },
                render: (_args, value) => [
                    { type: 'text', text: value.ok ? (value.note ?? `已绑定到 \`${value.dir ?? '?'}\`。`) : `绑定失败：${value.error ?? '未知错误'}` },
                ],
            },
            async execute(args, exec) {
                const chatId = resolveChat(exec, undefined);
                if (chatId === undefined)
                    return { ok: false, error: 'cannot resolve this chat' };
                if (deps.bindChatCwd === undefined) {
                    return { ok: false, error: 'this deployment cannot rebind a chat workspace' };
                }
                const raw = asText(args.dir).trim().replace(/^["']|["']$/g, '');
                if (raw === '')
                    return { ok: false, error: 'dir is required' };
                if (raw.toLowerCase() === 'default') {
                    await deps.bindChatCwd(chatId, null);
                    return { ok: true, unbind: true, note: '已解除绑定：下一个 /new 回到部署目录。' };
                }
                const target = resolve(raw);
                let isDirectory = false;
                try {
                    isDirectory = statSync(target).isDirectory();
                }
                catch { /* missing or denied */ }
                if (!isDirectory)
                    return { ok: false, error: `目录不存在或不是目录：${target}` };
                await deps.bindChatCwd(chatId, target);
                return {
                    ok: true,
                    dir: target,
                    note: `已绑定到 ${target}：发 /new 开新对话，之后就在这个项目里工作。`,
                };
            },
        },
        {
            name: FEISHU_NOTIFY_TOOL,
            description: 'Send a message to a Feishu chat through the bridge transport — including a chat '
                + 'DIFFERENT from the one this turn runs in. Use it for proactive pings the human '
                + 'should see now: a long task hit a milestone, a scheduled job finished, a '
                + 'background subagent needs attention. Without chat_id it posts into the CURRENT '
                + 'chat; the text is Feishu markdown.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Message body, Feishu markdown (post text)' },
                    chat_id: { type: 'string', description: 'Target chat id; omit to send into the current chat' },
                },
                required: ['text'],
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        chat_id: { type: 'string' },
                        error: { type: 'string' },
                    },
                    additionalProperties: false,
                },
                render: (_args, value) => [
                    { type: 'text', text: value.ok ? `已发送到聊天 \`${value.chat_id ?? '?'}\`。` : `发送失败：${value.error ?? '未知错误'}` },
                ],
            },
            async execute(args, exec) {
                const parsed = args;
                const text = asText(parsed.text);
                if (text.trim() === '')
                    return { ok: false, error: 'text 不能为空' };
                const chatId = resolveChat(exec, parsed.chat_id);
                if (chatId === undefined)
                    return { ok: false, error: '无法确定目标聊天：当前会话未绑定聊天，且未传 chat_id' };
                try {
                    await deps.port.send(chatId, { markdown: text });
                    return { ok: true, chat_id: chatId };
                }
                catch (error) {
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            },
        },
        {
            name: SWITCH_MODEL_TOOL,
            description: 'Switch the model (and optionally the reasoning effort) of THIS conversation, in place. '
                + 'It takes effect on the very next request — no /new needed — and is recorded in the '
                + 'session so it survives a restart. Speak naturally: "deepseek v4", "the free one", '
                + '"下一个", "default" to go back to the deployment default. It NEVER changes the '
                + 'deployment default (that is what /model does, and it only affects NEW sessions). '
                + 'Call it with action="list" first when you do not know which models exist, so you can '
                + 'map what the human said onto a real id instead of guessing.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: '"list" to just report the current model and the choices; "switch" (default) to change it',
                    },
                    model: {
                        type: 'string',
                        description: 'What to switch to, in the human\'s own words: an id, "provider/model", a name, "下一个", or "default"',
                    },
                    effort: {
                        type: 'string',
                        description: 'Optional reasoning effort for the new model (e.g. off / low / high / max); omit to keep the adapter default',
                    },
                },
                required: [],
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        current: { type: 'string' },
                        effort: { type: 'string' },
                        models: { type: 'array', items: { type: 'string' } },
                        note: { type: 'string' },
                        error: { type: 'string' },
                    },
                    additionalProperties: false,
                },
                render: (_args, value) => [
                    {
                        type: 'text',
                        text: value.ok
                            ? (value.note ?? `当前模型：${value.current ?? '?'}`)
                            : `切换失败：${value.error ?? '未知错误'}`,
                    },
                ],
            },
            async execute(args, exec) {
                const deps2 = deps.modelSwitch;
                const sessionId = exec.agent?.session?.id;
                if (deps2 === undefined)
                    return { ok: false, error: '本部署没有组合 llm 运行时，无法查询或切换模型' };
                if (sessionId === undefined || sessionId === '')
                    return { ok: false, error: '拿不到当前会话' };
                const parsed = args;
                const action = asText(parsed.action).trim().toLowerCase();
                const said = asText(parsed.model).trim();
                const entries = await deps2.list();
                const route = deps2.current(sessionId);
                const current = route.provider === undefined || route.model === undefined ? undefined : `${route.provider}/${route.model}`;
                const models = entries.map(entry => listing(entry));
                if (action === 'list' || (said === '' && asText(parsed.effort).trim() === '')) {
                    return {
                        ok: true,
                        ...current === undefined ? {} : { current },
                        models,
                        note: `当前模型 ${current ?? '未知'}。可选：${models.join(' · ') || '清单为空'}`,
                    };
                }
                const resolved = resolveModelRequest(said, entries, current);
                if (resolved.kind === 'unknown') {
                    return {
                        ok: false,
                        error: `${resolved.reason}${resolved.candidates.length > 0 ? `\n可选：${resolved.candidates.join(' · ')}` : ''}`,
                        ...current === undefined ? {} : { current },
                        models,
                    };
                }
                if (resolved.kind === 'reset') {
                    deps2.reset(sessionId);
                    return { ok: true, note: '已回到部署默认模型（下一次请求生效，不用 /new）', models };
                }
                const target = `${resolved.provider}/${resolved.model}`;
                // 档位只在新 route 真的声明时才带；声明了却写成别的档，宁可拒绝也不要
                // 让宿主在下一步请求里抛 UNSUPPORTED_REASONING_EFFORT 把整轮打死。
                const levels = await deps2.levels(resolved.provider, resolved.model);
                const askedEffort = asText(parsed.effort);
                let effort;
                if (askedEffort.trim() !== '') {
                    const picked = resolveEffort(askedEffort, levels);
                    if (picked === null) {
                        return {
                            ok: false,
                            error: `\`${target}\` 没有「${askedEffort}」这一档。可选：${levels.length > 0 ? levels.map(level => `\`${level}\``).join(' · ') : '该模型没声明档位'}`,
                            models,
                        };
                    }
                    effort = picked;
                }
                // 不带 effort 时**不要**沿用旧 route 的档位：新模型未必有那一档，
                // 而宿主会因此整轮报 UNSUPPORTED_REASONING_EFFORT。交给适配器默认即可。
                deps2.apply(sessionId, {
                    provider: resolved.provider,
                    model: resolved.model,
                    ...effort === undefined ? {} : { reasoningEffort: effort },
                });
                return {
                    ok: true,
                    current: target,
                    ...effort === undefined ? {} : { effort },
                    note: `已切换为 ${target}（${resolved.why}），下一步请求即生效，不用 /new。`,
                };
            },
        },
        {
            name: FEISHU_DRIVE_WRITE_TOOL,
            description: 'Write (or overwrite) a text file in the Feishu app\'s own cloud-drive space — a '
                + 'durable spot reachable from any device with this Feishu app, independent of the '
                + 'workspace filesystem. Use it for handoff notes, fleet state, or artifacts the '
                + 'human wants to open inside Feishu.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'File name in the app drive space (e.g. notes.md)' },
                    content: { type: 'string', description: 'Full text content to store' },
                },
                required: ['name', 'content'],
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        name: { type: 'string' },
                        error: { type: 'string' },
                    },
                    additionalProperties: false,
                },
                render: (_args, value) => [
                    { type: 'text', text: value.ok ? `已写入飞书云空间：\`${value.name ?? '?'}\`。` : `写入失败：${value.error ?? '未知错误'}` },
                ],
            },
            async execute(args) {
                const parsed = args;
                const name = asText(parsed.name);
                const content = typeof parsed.content === 'string' ? parsed.content : '';
                if (name.trim() === '')
                    return { ok: false, error: 'name 不能为空' };
                const client = cloud();
                if (client === undefined)
                    return { ok: false, error: '本端未配置飞书凭证，云空间不可用' };
                try {
                    await client.putJson(name, content);
                    return { ok: true, name };
                }
                catch (error) {
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            },
        },
        {
            name: FEISHU_DRIVE_READ_TOOL,
            description: 'Read one text file back from the Feishu app\'s cloud-drive space (the files '
                + '`feishu_drive_write` stores). Returns null content when the name is unknown.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'File name in the app drive space' },
                },
                required: ['name'],
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        name: { type: 'string' },
                        // 0.1.5's schema subset rejects type arrays ("must be a single type
                        // string"); exact-one `oneOf` is the supported way to spell a value
                        // that may be null. A type array here makes the whole tool fail to
                        // register, so the tool silently does not exist for the model.
                        content: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                        error: { type: 'string' },
                    },
                    additionalProperties: false,
                },
                render: (_args, value) => [
                    { type: 'text', text: value.ok ? `已读取 \`${value.name ?? '?'}\`（${value.content === null || value.content === undefined ? 0 : value.content.length} 字符）。` : `读取失败：${value.error ?? '未知错误'}` },
                ],
            },
            async execute(args) {
                const parsed = args;
                const name = asText(parsed.name);
                if (name.trim() === '')
                    return { ok: false, error: 'name 不能为空' };
                const client = cloud();
                if (client === undefined)
                    return { ok: false, error: '本端未配置飞书凭证，云空间不可用' };
                try {
                    const content = await client.getJson(name);
                    return { ok: true, name, content };
                }
                catch (error) {
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            },
        },
        {
            name: FEISHU_DRIVE_LIST_TOOL,
            description: 'List the files currently stored in the Feishu app\'s cloud-drive space.',
            parameters: { type: 'object', properties: {} },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, modifiedMs: { type: 'number' } } } },
                        error: { type: 'string' },
                    },
                    additionalProperties: false,
                },
                render: (_args, value) => [
                    { type: 'text', text: value.ok ? `云空间共 ${value.files?.length ?? 0} 个文件。` : `列出失败：${value.error ?? '未知错误'}` },
                ],
            },
            async execute() {
                const client = cloud();
                if (client === undefined)
                    return { ok: false, error: '本端未配置飞书凭证，云空间不可用' };
                try {
                    const files = await client.list();
                    return { ok: true, files: files.map((file) => ({ name: file.name, modifiedMs: file.modifiedMs })) };
                }
                catch (error) {
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            },
        },
    ];
}
/** The prompt section text for the tools above (composeChatAgent registers it). */
export function feishuToolsPromptSection() {
    return 'Channel-native Feishu tools are registered for you: `feishu_notify` posts a message '
        + 'into this chat (or any chat_id you pass) outside your normal reply flow — use it for '
        + 'proactive pings from long or scheduled work, not as a substitute for your reply. '
        + '`feishu_drive_write` / `feishu_drive_read` / `feishu_drive_list` store and fetch text '
        + 'files in the Feishu app\'s own cloud space, which survives across devices and '
        + 'machines — use them for handoff notes and state that must outlive this workspace. '
        + '`bind_workspace` binds THIS chat to a project directory durably: the next `/new` starts '
        + 'there and loads that directory\'s AGENTS.md, which is how a chat switches project '
        + 'memory. Call it when the human asks to move this conversation to another project; then '
        + 'tell them to send `/new`, because the running conversation keeps its directory. '
        + '`switch_model` changes the model of THIS conversation in place — the very next request '
        + 'uses it, no `/new` — and accepts the human\'s own words ("deepseek v4", "the free one", '
        + '"下一个", "default"). Use `action="list"` when you do not know which models exist, '
        + 'instead of guessing an id. It deliberately does NOT touch the deployment default; that '
        + 'is `/model`, which only affects new sessions.';
}
//# sourceMappingURL=feishu-tools.js.map