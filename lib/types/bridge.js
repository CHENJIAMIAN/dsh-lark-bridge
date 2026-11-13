/**
 * The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
 * committed assistant output returns as chat messages, and host approval
 * questions become interactive cards answered by button clicks.
 * @module dsh-lark-bridge/bridge
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { readDeviceState, ensureDeviceId } from "./sync/migrate.js";
import { arbitrationForInbound, claimIfActiveStale, isActiveEndpoint, accountUseByName, accountForgetByName } from "./sync/bot-command.js";
import { accountCardValue } from "./account-card.js";
import { DEFAULT_LIMITS } from "./config.js";
import { isAssistantMessageEvent, isTeamRelayMessageEvent, isCompactionEndEvent, isPresentedEvent, isCompactionPruneEvent, isCompactionStartEvent, isCompactionSummaryEvent, isGoalChangeEvent, isLlmRetryEvent, isScheduleChangeEvent, isStepStartEvent, isSubagentCatalogEvent, isSubagentDescriptorEvent, isTodoWriteEvent, isToolCallEvent, isToolResultEvent, isTurnEndEvent, isWebSearchRequestEvent, isWorkflowAgentEndEvent, isWorkflowAgentStartEvent, isWorkflowRunEndEvent, isWorkflowRunStartEvent, isTeamMemberEvent, isTeamTaskEvent, isTeamMessageEvent, isTeamMessageDeliveredEvent } from "./host.js";
import { createCotRenderer } from "./cot.js";
import { readChatWorkspaces, writeChatWorkspace } from "./chat-workspace.js";
import { createMessageRenderer, createStreamRenderer } from "./outbound.js";
import { refuseApprovalClick, refuseMessage } from "./authorization.js";
import { postChronicle } from "./chronicle.js";
import { briefingPrefix } from "./briefing.js";
import * as subCard from "./subagent-card.js";
import * as teamCard from "./team-card.js";
import { AUDIT_COMMAND, BALANCE_COMMAND, BOT_COMMAND, commandName, CONFIG_COMMAND, CONTEXT_COMMAND, FEEDBACK_COMMAND, HELP_COMMAND, isCommandLine, JOBS_COMMAND, MANUAL_COMMAND, MODEL_COMMAND, NEW_COMMAND, CONSOLE_COMMAND, PANEL_COMMAND, PLUGINS_COMMAND, PRESET_COMMAND, RESTART_COMMAND, RESUME_COMMAND, runCommandLine, SCHEDULES_COMMAND, SESSION_COMMAND, SESSIONS_COMMAND, SKILLS_COMMAND, STOP_COMMAND, THINK_COMMAND, TOOLS_COMMAND, WS_COMMAND, } from "./commands.js";
import { EffortOverrides, effortCatalog, effortName } from "./think.js";
import { getSyncContext } from "./sync/bot-command.js";
import { collectImages } from "./images.js";
import { saveInboundFiles } from "./files.js";
import { syncSlashPanel } from "./slash-panel.js";
import { describeCommand } from "./i18n.js";
import { ConversationSessions, conversationKey, sessionIdFor } from "./session.js";
import { baseSessionIdOf, createRotationStore } from "./session-rotation.js";
import { readPreviews, describeScale, describeSpan } from "./session-preview.js";
import { createReactionTracker } from "./reaction.js";
import { discoverModels } from "./model-catalog.js";
import { createGoalWatch } from "./goal-watch.js";
import { createRestartStore } from "./restart-state.js";
import { createConsoleCardStore, panelActionValue, panelCard, panelSubmitted, panelSubmitAction, resolvePanelAction } from "./panel.js";
import { chatOfSession, localDue, overdueActionValue, overdueCard, overdueTasks } from "./schedule-watchdog.js";
import { markSeen, readSeen } from "./overdue-seen.js";
import { createQuestionProvider } from "./questions.js";
import { createTodoRenderer } from "./todo.js";
import { createGoalRenderer } from "./goal.js";
import { goalActionValue } from "./goal.js";
import { WORKFLOW_TOOL_NAME, workflowLogLine, workflowNameFromArguments } from "./workflow.js";
import { createWorkflowCard } from "./workflow-card.js";
import { compactionPruneLine, compactionSummaryLine, jobDoneLine, retryLine, scheduleDispatchLine, scheduleLine, subagentEndLine, tokenPressureLine, webSearchLine, } from "./notices.js";
import { readContextBreakdown, readContextWindow } from "./context-breakdown.js";
import { onboardingMessage } from "./first-contact.js";
import { createReplayPort, isUndeliveredId } from "./replay.js";
import { createSendFileTool, deliverFile } from "./files.js";
import { createFeishuTools, feishuToolsPromptSection, FEISHU_NOTIFY_TOOL } from "./feishu-tools.js";
import { FeishuCloud } from "./sync/feishu-cloud.js";
import { pricingPromptLine } from "./pricing.js";
// `messageTimeStamp` used to be defined here. It moved to `clock.ts` so the
// thinking process renders the same instant the same way without `cot.ts`
// importing this module (which imports `cot.ts`); re-exported so every
// existing caller — and the tests that pin its exact form — is unchanged.
import { elapsedPhrase, messageTimeStamp } from "./clock.js";
export { messageTimeStamp } from "./clock.js";
/** Marker distinguishing this plugin's approval buttons from other card actions. */
const APPROVAL_ACTION = 'dsh-lark-bridge/approval';
/**
 * Narrow an arbitrary card-action value to this plugin's approval payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
function approvalActionValue(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    if (record.kind !== APPROVAL_ACTION)
        return undefined;
    if (typeof record.id !== 'string')
        return undefined;
    if (record.decision !== 'allow' && record.decision !== 'reject')
        return undefined;
    return { kind: APPROVAL_ACTION, id: record.id, decision: record.decision };
}
/**
 * Build the interactive approval card for one permission question.
 * @param toolName - the tool the question is about.
 * @param reason - the asker's explanation, when it gave one.
 * @param id - correlation id carried by both decision buttons.
 * @returns a Feishu card object for `send({ card })`.
 */
function approvalCard(toolName, reason, command, id) {
    // Only this plugin's own labels use `lark_md`. Every untrusted value — the
    // model's justification and the exact arguments it wants to run — rides a
    // `plain_text` element, which the platform renders literally, so neither can
    // inject card markup or disguise itself as the card's own text.
    const untrusted = (label, value) => [
        { tag: 'div', text: { tag: 'lark_md', content: `**${label}**` } },
        { tag: 'div', text: { tag: 'plain_text', content: value } },
    ];
    return {
        config: { wide_screen_mode: true },
        header: { template: 'orange', title: { tag: 'plain_text', content: 'DSH 操作审批' } },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: `**工具**：\`${toolName}\`` } },
            ...command === undefined ? [] : untrusted('将执行', command),
            ...reason === undefined || reason === '' ? [] : untrusted('模型说明', reason),
            { tag: 'note', elements: [{ tag: 'plain_text', content: '批准前请确认上面的内容确实是你要执行的。' }] },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '允许一次' },
                        type: 'primary',
                        value: { kind: APPROVAL_ACTION, id, decision: 'allow' },
                    },
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '拒绝' },
                        type: 'danger',
                        value: { kind: APPROVAL_ACTION, id, decision: 'reject' },
                    },
                ],
            },
        ],
    };
}
/** Card headline and color for each settled approval outcome. */
const SETTLED_CARD = {
    'allowed-once': { template: 'green', text: '✅ 已允许执行一次' },
    'rejected': { template: 'red', text: '⛔ 已拒绝' },
    'cancelled': { template: 'grey', text: '⏹ 请求已撤回' },
    'unavailable': { template: 'grey', text: '⏹ 无法作答' },
};
/**
 * Build the static replacement card shown after an approval settles.
 * @param toolName - the tool the question was about.
 * @param outcome - the closed decision.
 * @returns a Feishu card object for `updateCard`.
 */
function settledCard(toolName, outcome, decidedBy) {
    const look = SETTLED_CARD[outcome];
    return {
        config: { wide_screen_mode: true },
        header: { template: look.template, title: { tag: 'plain_text', content: 'DSH 操作审批' } },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: `**工具**：\`${toolName}\`\n${look.text}` } },
            // Who decided, named rather than restricted: with approvals open to a
            // room, the room should see whose press granted the escalation.
            ...decidedBy === undefined
                ? []
                : [{ tag: 'note', elements: [{ tag: 'plain_text', content: `操作人：${decidedBy}` }] }],
        ],
    };
}
/** How long one tool-activity label may be before it is ellipsized. */
const ACTIVITY_LABEL_MAX_CHARS = 90;
/**
 * Reduce one presentation title to a single safe card line: the value is
 * model-influenced (a search pattern, a command) and rides a markdown card, so
 * newlines and code fences — the two things that could restructure the card —
 * come out, and the rest is bounded.
 * @param title - the tool's own label for this call.
 * @returns the label as one bounded line.
 */
/**
 * 把 compaction 事件里的 seq 归类，好让聊天里那句提示说得出"修剪了什么"。
 *
 * 事件本身只带序号（`shadowedSeqs`），序号的含义只存在于会话日志里；
 * 读不到的事件记进 `other`，不猜。
 */
function classifyShadowed(session, seqs) {
    const counts = { user: 0, assistant: 0, toolCall: 0, toolResult: 0, other: 0 };
    for (const seq of seqs) {
        const event = session.eventAt(seq);
        switch (event?.type) {
            case 'user/message':
                counts.user += 1;
                break;
            case 'assistant/message':
                counts.assistant += 1;
                break;
            case 'tool/call':
                counts.toolCall += 1;
                break;
            case 'tool/result':
                counts.toolResult += 1;
                break;
            default: counts.other += 1;
        }
    }
    return counts;
}
function activityLabel(title) {
    // One pass over both hazards: any run of whitespace (newlines included) or
    // backticks collapses to a single space, so neither a line break nor a code
    // fence in a model-influenced value can restructure the card.
    const line = title.replace(/[\s`]+/g, ' ').trim();
    return line.length <= ACTIVITY_LABEL_MAX_CHARS
        ? line
        : `${line.slice(0, ACTIVITY_LABEL_MAX_CHARS - 1)}…`;
}
/**
 * Build the tool-call describer for one agent's view of the registry. Prefers
 * the tool's own `presentCall` title — the label the host's own surfaces show,
 * so a chat line says what a call does rather than repeating its name — then
 * the model's `description` argument, then the bare name.
 * @param tools - the host tool registry, when composed.
 * @param scope - the viewing scope key holding this agent's tools.
 * @returns a describer safe to call on every `tool/call` event.
 */
function createCallPresenter(tools, scope) {
    return (name, argumentsJson) => {
        let args;
        try {
            args = JSON.parse(argumentsJson);
        }
        catch {
            // Raw model output: malformed JSON is the model's mistake, not a reason
            // to lose the activity line.
            return { title: name };
        }
        try {
            const view = tools?.get(name, scope)?.presentCall?.(args);
            const title = view?.title;
            if (typeof title === 'string' && title.trim() !== '') {
                return {
                    title: activityLabel(title),
                    ...typeof view?.kind === 'string' ? { kind: view.kind } : {},
                };
            }
        }
        catch {
            // presentCall is contracted pure, but it is another package's code and a
            // throw here must not cost the chat its activity line.
        }
        const described = args?.description;
        return typeof described === 'string' && described.trim() !== ''
            ? { title: `${name} · ${activityLabel(described)}` }
            : { title: name };
    };
}
/**
 * Bound one untrusted value to what an approval card may carry.
 * @param text - raw tool arguments as the model produced them.
 * @returns the value, ellipsized when it exceeds the card's budget.
 */
function boundCardText(text, maxChars = DEFAULT_LIMITS.approvalArgChars) {
    return text.length <= maxChars
        ? text
        : `${text.slice(0, maxChars - 1)}…`;
}
/**
 * Compose the parts of a chat agent's world this channel owns: the tools it
 * must not call, and the prompt sentence that tells the model what to do
 * instead. Both registrations are scoped to this one agent.
 * @param agentCtx - the agent's scope context, inside creation `setup`.
 * @param config - resolved plugin configuration.
 */
/**
 * Compose one chat agent's channel-facing context: tool restrictions, the
 * channel identity prompt, and the channel-owned `send_file` tool when the
 * deployment offers file delivery.
 * @param agentCtx - the agent's scoped Cordis context.
 * @param config - resolved bridge configuration.
 * @param extraTools - channel-owned tools to register on this agent's scope.
 * @param runtimeDenied - the live denied-tool set shared across agents, when
 * the bridge offers runtime `/tools` toggling; falls back to a frozen copy of
 * `config.denyTools` when absent.
 */
function composeChatAgent(agentCtx, config, extraTools = [], runtimeDenied = undefined, identityClause) {
    // Channel-owned tools (currently `send_file`) register on the agent's own
    // scope, so they exist exactly where the agent looks, and vanish with it.
    // The service is read through the Context merge first (`agent.ctx.tools`):
    // that is where the host puts it, and the accessor reaches the same
    // instance. `ctx.get('tools')` is the fallback for harnesses that only
    // register the service under its name.
    //
    // The comment this replaced said `get` no longer handed back the service.
    // That was true of one 0.1.5-era shape; the current host registers the
    // runtime as `super(ctx, 'tools')`, so `get` resolves it again — the
    // upstream's own plugins read it that way.
    const tools = (agentCtx.tools
        ?? agentCtx.get('tools'));
    for (const tool of extraTools) {
        try {
            tools?.register(tool);
        }
        catch (error) {
            // A duplicate or reserved name must not fail the whole agent creation;
            // the tool simply does not exist for this agent.
            process.stderr.write(`dsh-lark-bridge: channel tool registration skipped (${String(error)})\n`);
        }
    }
    if (config.denyTools.length > 0 || (runtimeDenied !== undefined && runtimeDenied.size > 0)) {
        const denied = runtimeDenied ?? new Set(config.denyTools);
        agentCtx.get('tools')?.guard(execution => denied.has(execution.name)
            ? `${execution.name} is unavailable in this chat channel: its answer would surface on a `
                + 'different interface. Ask the user directly in your reply instead, and continue when they answer.'
            : undefined);
    }
    // The channel's identity is a fact the model must know before anything else:
    // the same harness serves Web and CLI surfaces, and without an explicit
    // persona a chat agent answers as "a coding agent" instead of the Feishu bot
    // the human is actually talking to. The bot's Feishu app name (when the
    // lookup settled) leads the section — asked "who are you", the model quotes
    // the name the human already sees in the chat header, plus which fleet
    // endpoint is answering. Kept independent of denyTools so it is always
    // injected, not only when there is a tool restriction to announce.
    const prompt = agentCtx.get('systemPrompt');
    const clause = identityClause?.();
    prompt?.section({
        name: 'dsh-lark-bridge:identity',
        order: 120,
        text: (clause === undefined ? '' : `你是飞书上的${clause}。`)
            + 'You are a coding agent running inside a Feishu/Lark chat '
            + 'via the DeepSeek Harness host. The person you are talking to is the user of this '
            + 'chat, not a machine. Reply in the same language they write in. '
            + 'You have the full coding-agent toolset of the host: you can read and edit files, run '
            + 'commands, and work on projects in the workspace. When you need a decision or want to '
            + 'ask a clarifying question, write it directly in your reply — their next message is the '
            + 'answer, and the chat keeps the conversation going. Do not describe your own '
            + 'architecture or ask what kind of interface you are running on; you are simply the bot '
            + 'in this chat. When the user asks who you are, answer with the Chinese name above '
            + '(if present) — never invent a different name.',
    });
    prompt?.section({
        name: 'dsh-lark-bridge:interaction',
        order: 150,
        text: 'To ask a question or seek approval for a plan, '
            + 'write it in your reply — their next message is the answer. '
            + (config.denyTools.length > 0
                ? `These tools are unavailable here: ${[...new Set(config.denyTools)].join(', ')}.`
                : ''),
    });
    if (extraTools.some((tool) => tool.name === FEISHU_NOTIFY_TOOL)) {
        prompt?.section({ name: 'dsh-lark-bridge:feishu-tools', order: 121, text: feishuToolsPromptSection() });
    }
    prompt?.section({ name: 'dsh-lark-bridge:pricing', order: 122, text: pricingPromptLine() });
    prompt?.section({
        name: 'dsh-lark-bridge:background-tasks',
        order: 130,
        text: 'Long-running commands (builds, installs, setup scripts, anything that may take '
            + 'minutes): ALWAYS pass run_in_background=true to the shell/exec tool. '
            + 'The host JobRegistry tracks the job and the bridge automatically sends a '
            + 'completion notice with the output tail into this chat when it settles — '
            + 'you do NOT need to poll. '
            + 'NEVER wrap a command in `while pgrep ...; do sleep N; done; tail ...` or '
            + 'similar polling loops: the wrapper itself becomes the process that gets '
            + 'killed by the turn timeout, and the tail/echo after the loop never runs. '
            + 'If you need to check on a background job later, use `/jobs` or read the '
            + 'log file the command was told to write to — do not block a turn waiting.',
    });
}
/**
 * Whether a standby endpoint answers this line in the chat.
 *
 * The fleet is single-writer: only the arbitration-active endpoint replies,
 * and a standby stays silent on ordinary traffic so a phone client never
 * talks over the machine that is actually answering. Silence is wrong for the
 * two READ-ONLY lines the user guide sends a puzzled operator to (`/help` and
 * `/bot devices`) — their entire job is to say where the fleet is, so
 * swallowing them turns a healthy standby into "the bot is dead". Everything
 * with an effect (and all prose) still gets nothing, so answering can never
 * make a standby a second executor of the same command.
 * @param text - the inbound message text exactly as received.
 * @returns whether this line deserves a standby notice.
 */
function standbyAnswers(text) {
    const line = text.trim();
    const name = commandName(line);
    if (name === HELP_COMMAND)
        return true;
    if (name !== BOT_COMMAND)
        return false;
    // Mirrors `runBotCommand`'s own split, so the line answered here is the line
    // that would have run `/bot devices` on the active end.
    const sub = line.slice(1 + BOT_COMMAND.length).trim().split(/\s+/)[0] ?? '';
    return sub === 'devices';
}
/**
 * Create an identified user message from one chat input. Group messages carry
 * the sender so the model can tell voices apart; direct messages stay verbatim.
 * @param msg - normalized inbound chat message.
 * @returns a frozen user message for `agent.followup()`.
 */
export function chatUserMessage(msg, images) {
    const spoken = msg.chatType === 'group'
        ? `${msg.senderName ?? msg.senderId}: ${msg.content}`
        : msg.content;
    // Notes ride the text so a model that cannot be shown an image still knows
    // one was sent, instead of answering as though it had seen it.
    const text = [spoken, ...images.notes].filter(line => line !== '').join('\n');
    const content = [
        ...text === '' ? [] : [{ type: 'text', text }],
        ...images.blocks,
    ];
    return Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze(content),
        source: Object.freeze({ kind: 'user' }),
    });
}
/**
 * How much of a quoted message the model is shown.
 *
 * A quote can be an entire bot answer. Repeating it verbatim buys nothing the
 * session history does not already hold, and a long one would push the actual
 * question out of the model's attention — so the head, and a marker.
 */
/**
 * How long this chat had been quiet before the current turn started.
 *
 * Keyed by session id and held for the life of the process. A restart forgets
 * it, which is the honest behaviour: after a restart the agent genuinely
 * cannot say how long the chat was quiet, and inventing "刚刚" would be a lie
 * the model then reasons from. Read-and-write in one call so the gap is always
 * measured from the previous turn, never from this one.
 */
const lastTurnStarted = new Map();
/**
 * How long the chat was quiet before this turn, as a phrase for the model.
 *
 * Only the GAP comes from here. The absolute time belongs to the message
 * stamp beside it (`showMessageTime`), and saying the same instant twice put
 * two timestamps three seconds apart at the top of every message — which
 * leaves the model to guess which one is "now". One line, one time, one gap:
 * the gap is the part the stamp cannot carry, and it is the part that
 * actually changes behaviour. A model resuming after eight hours should
 * re-check state it assumed; one resuming after three minutes should not
 * spend a turn doing it.
 * @param sessionId - the session this turn belongs to.
 * @param now - epoch milliseconds at turn start.
 * @returns the phrase (e.g. `4 分钟前`), or '' when the gap is unknown or
 *   too small to be worth a word.
 */
export function sessionGapPhrase(sessionId, now) {
    const previous = lastTurnStarted.get(sessionId);
    lastTurnStarted.set(sessionId, now);
    if (previous === undefined)
        return '';
    const gap = elapsedPhrase(now - previous);
    // "刚刚" on a message that already carries its own time is noise.
    return gap === '刚刚' ? '' : gap;
}
/**
 * Pull the readable text out of a card JSON whose shape may be 1.0 or 2.0.
 *
 * 飞书的卡片消息有两种结构：1.0 是 `title` + `elements`，2.0 是 `schema: "2.0"`
 * + `header` + `body.elements`。这里的任务只有一个——把卡片里**人能看到的那几行字**
 * 按阅读顺序取出来，拼成纯文本。
 *
 * 为什么不能直接用 `im.v1.message.get` 的默认返回：不带 `card_msg_content_type`
 * 时，2.0 卡片会降级成 v1 占位（`[interactive card]` 就是这么来的），引用一块面板卡
 * 时模型只拿到一个括号词组。带上 `user_card_content` 才拿得到原始 JSON。
 *
 * 取舍：这里只认 `plain_text` / `lark_md` / `markdown` 三种文本节点，其余结构一律
 * 靠遍历找下去。卡片里本来就没有别的可读文字，认多了只会把样式当内容吐出来。
 *
 * @param card - the parsed card JSON (`body.content` of an interactive message).
 * @param maxChars - how much text to keep; truncation is marked, never silent.
 * @returns the readable text, '' when the card carries none.
 */
export function cardText(card, maxChars = DEFAULT_LIMITS.quoteChars) {
    const lines = [];
    const seen = new Set();
    const visit = (node) => {
        if (node === null || typeof node !== 'object')
            return;
        // 卡片 JSON 是树，正常不会有环；防一手恶意/异常输入把递归拖死。
        if (seen.has(node))
            return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const item of node)
                visit(item);
            return;
        }
        const obj = node;
        const tag = obj.tag;
        const content = obj.content;
        if ((tag === 'markdown' || tag === 'lark_md' || tag === 'plain_text') && typeof content === 'string') {
            const text = content.trim();
            if (text !== '')
                lines.push(text);
            return;
        }
        // 标题在 `header.title`、2.0 正文在 `body.elements`、1.0 正文在 `elements`。
        // 直接遍历值，不依赖具体字段名：卡片组件种类太多，逐个列会漏新组件。
        for (const value of Object.values(obj))
            visit(value);
    };
    visit(card);
    // 卡片里 markdown 段落常常自带换行，逐段拼回去时用单换行分隔，避免出现成片空行。
    const text = lines.join('\n').trim();
    if (text === '')
        return '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}…（引用内容过长，已截断）` : text;
}
/**
 * Render the message a chat message quotes back, as a block to prepend.
 *
 * 飞书的「引用」不是正文的一部分：入站事件只带 `parent_id`，被引用的那条要
 * 另外调 `im.v1.message.get` 才能读到。不取它，模型看到的就是一句「这个你再
 * 改改」加一片空白——它只能猜「这个」是什么，而人会以为它当然看得见。
 *
 * @param quoted - the referenced message, already fetched.
 * @param maxChars - how much of its text to keep.
 * @param showTime - whether to stamp when the quoted message was sent. A quote
 *   read without its time turns "你引用的那条" into "whatever that was" — the
 *   model cannot tell a reply to a two-minute-old message from a six-hour one.
 * @returns the block and its trailing newline, or '' when there is nothing to show.
 */
export function quotedPrefix(quoted, maxChars = DEFAULT_LIMITS.quoteChars, showTime = false) {
    if (quoted === undefined)
        return '';
    const body = quoted.content.trim();
    const who = quoted.senderName ?? quoted.senderId;
    const when = showTime ? messageTimeStamp(quoted.createTime) : undefined;
    // A quote with no text is usually an image or a file: say so, rather than
    // presenting an empty quote that reads as a bug.
    const text = body !== ''
        ? body.length > maxChars
            ? `${body.slice(0, maxChars)}…（引用内容过长，已截断）`
            : body
        : quoted.resources.length > 0
            ? '（这是一条图片/文件消息，没有文字内容）'
            : '（这条被引用的消息没有文字内容）';
    const head = when === undefined ? `[引用 · ${who}]` : `[引用 · ${who} · ${when}]`;
    return `${head}\n${text}\n[/引用]\n`;
}
/**
 * SDK 读不懂卡片正文时的占位词。
 *
 * `@larksuite/channel` 的 `convertInteractive` 只认 `plain_text` / `lark_md` /
 * `markdown` 三种节点；一个都提取不到就吐这个字符串。所以它出现等于「正文没读到」，
 * 而不是「用户真的发了这几个字」——拿到它就该去补读原始卡片 JSON。
 */
const CARD_PLACEHOLDER = /^\[interactive card\]$/i;
/**
 * 把引用到的卡片正文补进 `quoted.content`，其余字段原样保留。
 *
 * 为什么需要这一步：`fetchMessage` 走的是 `im.v1.message.get` 且**不带**
 * `card_msg_content_type`，2.0 卡片只会返回降级后的 v1 占位，SDK 归一化后
 * 就变成 `[interactive card]` —— 用户引用一张面板卡说「这个再改改」，模型
 * 看到的全是同一个括号词组，根本不知道指的是哪张卡。带上 `user_card_content`
 * 重读一次才拿得到原始 JSON。
 *
 * 只在「读回来的内容等于占位词」时才补读：普通文本消息一次就够，不额外发请求。
 * 补读失败就退回原样——引用少一段正文，不能让整条消息发不出去。
 */
async function withCardText(quoted, messageId, fetchRaw) {
    if (quoted === undefined)
        return quoted;
    const body = quoted.content.trim();
    // 不是占位词说明已经读到了真内容（普通文本、图片说明、1.0 卡片正文都算）。
    if (body !== '' && !CARD_PLACEHOLDER.test(body))
        return quoted;
    if (fetchRaw === undefined)
        return quoted;
    try {
        const items = await fetchRaw(messageId);
        const raw = items[0];
        const content = raw?.body?.content;
        if (typeof content !== 'string' || content === '')
            return quoted;
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            // 不是 JSON 就当纯文本用：某些卡片降级后会直接给一段可读字符串。
            return { ...quoted, content };
        }
        const text = cardText(parsed);
        if (text === '')
            return quoted;
        return { ...quoted, content: text };
    }
    catch {
        return quoted;
    }
}
/**
 * Choose the inbox boundary for one chat message (issue #5).
 *
 * A message that lands while a turn is running used to be queued
 * unconditionally: the chat read the wait as a hang, and the only way to change
 * direction was `/stop`, which throws the running turn's work away. `steer`
 * lands the message at the running driver's next step boundary, so a
 * correction takes effect inside the turn it corrects.
 *
 * An idle agent keeps the original semantics — an ordinary follow-up turn that
 * opens one — whatever the policy says, because there is nothing to steer.
 *
 * A policy the host cannot honour (an agent double with no `steer`, a host old
 * enough to predate it) degrades to `queue` and says so: the message must still
 * arrive, one turn later.
 *
 * @param busy - whether a turn is running (`agent.status === 'running'`).
 * @param policy - the deployment's `busyPolicy`.
 * @param agent - the live agent, inspected for the boundary it accepts.
 * @returns the policy to apply and the receipt line for it.
 */
export function busyDelivery(busy, policy, agent) {
    if (!busy)
        return { policy: 'queue', receipt: '' };
    if (policy === 'steer') {
        return typeof agent.steer === 'function'
            ? { policy: 'steer', receipt: '🎯 已插话：下一个 step 边界生效，当前进度保留；要立即中止请发 /stop。' }
            : { policy: 'queue', receipt: '⚠️ 本宿主不支持中途插话（steer），已退回排队：当前任务完成后处理这条。' };
    }
    if (policy === 'inject') {
        return typeof agent.inject === 'function'
            ? { policy: 'inject', receipt: '📎 已作为上下文注入：模型下一步会读到，不打断当前任务。' }
            : { policy: 'queue', receipt: '⚠️ 本宿主不支持上下文注入（inject），已退回排队：当前任务完成后处理这条。' };
    }
    return { policy: 'queue', receipt: '⏳ 已排队：当前任务完成后自动处理这条。' };
}
/**
 * Install the bridge on a scoped plugin context. Every registration is owned
 * by the context's fiber: disposal disconnects the transport, disposes every
 * agent this channel owns, and settles pending approvals as `'cancelled'`.
 * @param ctx - scoped plugin context carrying the `agents` service.
 * @param config - resolved plugin configuration.
 * @param port - the transport to drive; production passes the real Lark channel.
 * @param deps - injectable seams for tests; production leaves it empty.
 */
export function installBridge(ctx, config, port, notify, authorization, deps = {}) {
    // Wrap the transport so a long-connection gap queues outbound calls instead
    // of losing them; `setConnected` toggles the gate from the reconnecting /
    // reconnected subscriptions below.
    const rawPort = port;
    const replay = createReplayPort(port, (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        notify(`dsh-lark-bridge: replay flush failed: ${detail}`);
    }, notify);
    // Workflow fan-out arrives as one session event per member. Sending one chat
    // line each turned a 68-member scan into 136 messages, which is both
    // unreadable and enough to trip Feishu's per-chat rate limit — the limit
    // whose rejections then sat in the replay queue for most of a night. The card
    // keeps ONE message per run and rewrites it in place: phase, counts, failures.
    const workflows = createWorkflowCard(replay, {
        onFailure: (error) => {
            const detail = error instanceof Error ? error.message : String(error);
            notify(`dsh-lark-bridge: workflow card failed: ${detail}`);
        },
    });
    // File delivery: `send_file` is the one channel-owned tool, registered per
    // agent below. The session→chat mapping is the bridge's own registry, and
    // the send rides the replay-wrapped transport so a connection gap queues
    // the file like any other outbound message.
    const sendFileTool = createSendFileTool({
        deliverBySession: async (sessionId, args) => {
            const binding = bySession.get(sessionId);
            if (binding === undefined)
                throw new Error(`会话 ${sessionId} 不在当前聊天`);
            return deliverFile(replay, binding.chatId, cwd, args);
        },
    });
    // Declared deliverables reach the chat through the same path. The model
    // ends a turn by naming files it produced; without this they stay on the
    // host's disk, and the person who asked for them is looking at the chat.
    const deliverDeclaredFile = async (sessionId, path, caption) => {
        const binding = bySession.get(sessionId);
        if (binding === undefined)
            throw new Error(`会话 ${sessionId} 不在当前聊天`);
        return deliverFile(replay, binding.chatId, cwd, {
            path,
            ...caption === undefined || caption === '' ? {} : { caption },
        });
    };
    /**
     * Deliver a file a child session declared into the chat that owns it.
     *
     * A child runs in its own session, so the session is not the one bound to
     * the chat; the chat is found through the child mapping instead. A file
     * nobody can place is reported rather than dropped without a word.
     */
    const deliverChildDeclaredFile = async (chatId, path, caption) => {
        await deliverFile(replay, chatId, cwd, {
            path,
            ...caption === undefined || caption === '' ? {} : { caption },
        });
    };
    // Native Feishu tools (2026-09-09): the agent can act on Feishu itself —
    // proactive messages through the same replay-wrapped transport, and the
    // app's cloud-drive space as a durable cross-device scratchpad. Registered
    // per chat agent next to `send_file`; a failure here must not touch the
    // channel, matching every other composition step.
    const feishuTools = createFeishuTools({
        port: replay,
        chatOfSession: (sessionId) => bySession.get(sessionId)?.chatId,
        // Lazy arrows, not direct references: this factory runs before the binding
        // helpers below are initialised, and the tools only call them at use time.
        bindChatCwd: (chatId, dir) => bindChatCwd(chatId, dir),
        chatCwd: (chatId) => chatCwd(chatId),
        // 本会话的模型切换，和 `/think` 走同一条路：写 EffortOverrides（它落的
        // 就是 `model/selection` 事件），由 `agent/request` 重写信封生效。
        // **不碰** `agentDefaultModel.saveSelection()`——那是 `/model` 的语义，
        // 只影响新会话，混进来会让用户以为切了、实际再开新会话才变。
        //
        // 这里的每个箭头都是在**调用时**才去读 effortOverrides / agents：它们在
        // 本文件里声明得更晚，工厂执行时还不存在，直接引用会撞上 TDZ。
        modelSwitch: {
            list: () => discoverModels(ctx.get('llm')),
            current: (sessionId) => {
                const wanted = effortOverrides.get(sessionId);
                const header = agents.get(sessionId)?.session.requestHeader?.()?.config;
                const provider = wanted?.provider ?? header?.provider;
                const model = wanted?.model ?? header?.model;
                return {
                    ...provider === undefined ? {} : { provider },
                    ...model === undefined ? {} : { model },
                };
            },
            levels: async (provider, model) => {
                const catalog = await effortCatalog(ctx.get('llm'), provider, model);
                return catalog.levels.map(level => level.id);
            },
            apply: (sessionId, selection) => {
                const session = agents.get(sessionId)?.session;
                if (session === undefined)
                    return;
                effortOverrides.set(session, selection);
            },
            applyEffort: (sessionId, provider, model, effort) => {
                const session = agents.get(sessionId)?.session;
                if (session === undefined)
                    return;
                // `setEffort` 保留 route、只换档位，落的仍是同一条 `model/selection` 事件。
                effortOverrides.setEffort(session, {
                    provider,
                    model,
                    ...effort === undefined ? {} : { reasoningEffort: effort },
                });
            },
            reset: (sessionId) => {
                const session = agents.get(sessionId)?.session;
                if (session === undefined)
                    return;
                effortOverrides.clear(session);
            },
        },
        credentials: config.appId !== undefined && config.appSecret !== undefined
            ? { appId: config.appId, appSecret: config.appSecret, ...(config.domain !== undefined ? { domain: config.domain } : {}) }
            : undefined,
    });
    /**
     * Who the human is talking to, as Feishu itself names the app — quoted by
     * the model's self-description and the first-contact guide so the identity
     * question is answered before it is asked (fleet UX: endpoints and even
     * separate deployments echo similar names; the form/profile suffix tells
     * same-app ends apart). Best-effort: a failed lookup only hides the name.
     */
    let botName;
    if (config.appId !== undefined && config.appSecret !== undefined) {
        void new FeishuCloud({
            appId: config.appId,
            appSecret: config.appSecret,
            ...(config.domain !== undefined ? { domain: config.domain } : {}),
        }).botInfo().then((info) => { botName = info.name; }).catch(() => { });
    }
    /** One clause naming this bot and which endpoint is answering. */
    const identityClause = () => {
        const syncCtx = getSyncContext();
        const where = syncCtx === undefined ? '' : `（本端：${syncCtx.form} · ${syncCtx.profile}）`;
        return botName === undefined ? undefined : `「${botName}」${where}`;
    };
    // 重启对账用的状态：待回答的提问/审批、运行时禁用、在跑的轮次、卡片消息 id。
    // 内存里那份丢了没关系，这里是为了让下次开机还能把它们接回来。
    const restartStore = createRestartStore();
    const restoredState = restartStore.load();
    // The live denied-tool set: seeded from config, then toggled at runtime via
    // /tools. Every chat agent's guard reads this same object, so a switch takes
    // effect on the next tool call without a restart.
    //
    // 重启前的运行时禁用也要接回来：用户禁用某个工具后，重启又自己回来，是最容易
    // 让人以为「设置没生效」的那类意外。
    const runtimeDeniedTools = new Set([...config.denyTools, ...restoredState.deniedTools]);
    // Active schedules seen for this process, keyed by session id then schedule
    // id. Fed by schedule/change events as they stream in, and rebuilt from the
    // schedule plugin itself the first time a session is asked about (see
    // seedScheduleRegistry) — a restart otherwise starts empty, and a reminder
    // created by an earlier process would never be reported again.
    const scheduleRegistry = new Map();
    /** Sessions whose registry was already rebuilt from their own log. */
    const seededSchedules = new Set();
    /**
     * One service record as a registry entry.
     *
     * Every optional field is copied only when the service reported it, so an
     * older host that knows nothing about wall-clock rules produces an entry the
     * renderer can still describe — it just has less to say. `createdAt` is
     * passed in because a refresh must keep the original creation instant
     * instead of restamping it to now.
     */
    const entryFromRecord = (record, createdAt) => ({
        id: record.id,
        kind: record.kind,
        prompt: record.prompt,
        createdAt,
        ...record.title === undefined ? {} : { title: record.title },
        ...record.everySeconds === undefined ? {} : { everySeconds: record.everySeconds },
        ...record.time === undefined ? {} : { time: record.time },
        ...record.timeZone === undefined ? {} : { timeZone: record.timeZone },
        ...record.weekdays === undefined ? {} : { weekdays: record.weekdays },
        ...record.expression === undefined ? {} : { expression: record.expression },
        ...record.scheduledAt === undefined ? {} : { scheduledAt: record.scheduledAt },
        ...record.state === undefined ? {} : { state: record.state },
        ...record.lastDelivery === undefined ? {} : { lastDelivery: record.lastDelivery },
    });
    /**
     * Apply one `schedule/change` payload to a session's registry.
     *
     * `create` records, `delete` forgets, `dispatch` fires a one-shot (drop it)
     * or ticks a repeating schedule (keep it for the next round). Split out of
     * the event handler so the log replay below applies exactly the same rules —
     * two implementations of "what is still scheduled" is how the two drift.
     *
     * A historical event carries only the three legacy kinds and no title, so a
     * task first seen this way is later enriched by {@link refreshScheduleRegistry}
     * — the fields it cannot know are simply absent until then.
     *
     * @param byId - the session's registry.
     * @param data - the event payload.
     */
    const applyScheduleChange = (byId, data) => {
        const id = data.schedule?.id ?? data.id;
        if (id === undefined)
            return;
        if (data.operation === 'create' && data.schedule !== undefined) {
            const previous = byId.get(id);
            byId.set(id, {
                id,
                kind: data.schedule.kind,
                prompt: data.schedule.prompt,
                createdAt: previous?.createdAt ?? Date.now(),
                ...data.schedule.title === undefined ? {} : { title: data.schedule.title },
                ...data.schedule.everySeconds === undefined ? {} : { everySeconds: data.schedule.everySeconds },
            });
            return;
        }
        if (data.operation === 'delete')
            byId.delete(id);
        // A one-shot reminder dispatched once is done.
        else if (data.operation === 'dispatch' && data.schedule?.kind === 'after')
            byId.delete(id);
    };
    /**
     * Re-read one session's tasks from the host service, replacing the registry.
     *
     * `/schedules` answers "what is scheduled" and now also "when did it last
     * run" and "let me change it", so a process-lifetime cache filled by events
     * is not enough: a task created in another chat, or a delivery that just
     * happened, exists only in the service. The service is authoritative — a
     * record it no longer reports is gone, which is exactly right after a delete
     * from another surface.
     * @param sessionId - the session whose tasks to re-read.
     */
    const refreshScheduleRegistry = async (sessionId) => {
        const store = ctx.get('schedule');
        if (store?.list === undefined)
            return;
        const records = await store.list({ sessionId });
        // `list` answers "what is still scheduled" and stops there — it carries no
        // delivery receipt. "上次什么时候跑的" is the question the old panel could
        // not answer at all, so it is worth one extra read per task; the page is
        // capped at one record and a failure leaves the row without a receipt
        // instead of without a task.
        const enriched = await Promise.all(records.map(async (record) => {
            if (record.lastDelivery !== undefined || store.history === undefined)
                return record;
            try {
                const page = await store.history({ sessionId, id: record.id, limit: 1 });
                const latest = page.records?.[0];
                return latest === undefined ? record : { ...record, lastDelivery: latest };
            }
            catch {
                return record;
            }
        }));
        const previous = scheduleRegistry.get(sessionId);
        const byId = new Map();
        const now = Date.now();
        for (const record of enriched) {
            byId.set(record.id, entryFromRecord(record, previous?.get(record.id)?.createdAt ?? now));
        }
        if (byId.size === 0)
            scheduleRegistry.delete(sessionId);
        else
            scheduleRegistry.set(sessionId, byId);
    };
    /**
     * Rebuild one session's schedule registry from its own log, once.
     *
     * The registry is fed by live `schedule/change` events, so a restart starts
     * empty — and a reminder created before this process booted never announces
     * itself again. That is not a corner case: a long-running deployment creates
     * reminders in one process and answers `/schedules` in the next, and the
     * command then reports "none" for reminders that are still firing.
     *
     * The schedule plugin owns the truth: its `list` is what actually fires, and
     * it survives restarts. The session log is only a fallback — it carries the
     * change events that happened to be appended, and a reminder created before
     * this process booted has none, which is exactly the case that broke.
     *
     * Either way the replay is silent on purpose: someone asking what is
     * scheduled must not be told again about every reminder ever created.
     *
     * @param session - the session to restore.
     */
    const seedScheduleRegistry = async (session) => {
        if (seededSchedules.has(session.id))
            return;
        seededSchedules.add(session.id);
        const byId = scheduleRegistry.get(session.id) ?? new Map();
        // Authoritative first. `list` is the query the scheduler itself answers
        // with, so whatever it returns IS what will fire.
        const store = ctx.get('schedule');
        if (store?.list !== undefined) {
            try {
                const records = await store.list({ sessionId: session.id });
                const now = Date.now();
                for (const record of records) {
                    byId.set(record.id, entryFromRecord(record, byId.get(record.id)?.createdAt ?? now));
                }
                if (byId.size > 0)
                    scheduleRegistry.set(session.id, byId);
                return;
            }
            catch {
                // A deployment without the schedule service (or a version whose
                // `list` moved) still deserves the log fallback below.
            }
        }
        for (let seq = 0; seq < session.seq; seq++) {
            const event = session.eventAt(seq);
            if (event === undefined || !isScheduleChangeEvent(event))
                continue;
            applyScheduleChange(byId, event.data);
        }
        if (byId.size > 0)
            scheduleRegistry.set(session.id, byId);
    };
    /**
     * Turn a non-mutating schedule result into a line the chat can act on.
     *
     * The host answers a refused mutation with a code rather than an exception:
     * "already deleted", "someone else changed it first", "that binding cannot be
     * edited". Passing the raw code through would be accurate and useless, so
     * each one is said in the words that tell the reader what to do next.
     */
    function scheduleRefusal(result, verb) {
        switch (result.code) {
            case 'schedule_not_found': return '任务已经不在了（可能刚被删除）';
            case 'schedule_conflict': return '任务刚被改动过（可能刚好触发了一次投递），稍后再试一次';
            case 'schedule_ended': return '任务已经结束，改不了；需要的话重新建一个';
            case 'subagent_session': return '这个任务绑在子会话上，在这里改不了';
            default: return result.message ?? `${verb}被拒绝（${result.code ?? '未知原因'}）`;
        }
    }
    /**
     * What `/schedules` can DO, as opposed to what the registry remembers.
     *
     * Reads stay in the registry; every write and the delivery history come from
     * the host service, which is the only thing that owns them. Each write
     * refreshes the registry afterwards, so the reply the chat gets and the list
     * it sees next agree.
     *
     * Failures come back as a line instead of a throw: a command always owes the
     * chat an answer, and "the task is gone" is information, not a crash.
     */
    const scheduleControl = {
        get store() {
            return ctx.get('schedule');
        },
        refresh: refreshScheduleRegistry,
        remove: async (sessionId, id) => {
            const store = ctx.get('schedule');
            if (store?.delete === undefined)
                return '本部署的定时服务没有提供删除接口';
            try {
                const result = await store.delete({ sessionId, id });
                // A refusal resolves rather than throws: the task was already gone, or
                // this session never owned it. Reporting success there would be a lie
                // the reader only discovers when the task keeps firing.
                if (result.deleted === false)
                    return scheduleRefusal(result, '删除');
            }
            catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
            await refreshScheduleRegistry(sessionId).catch(() => { });
            return undefined;
        },
        edit: async (sessionId, id, change) => {
            const store = ctx.get('schedule');
            if (store?.update === undefined || store.list === undefined)
                return '本部署的定时服务没有提供修改接口';
            let expected;
            try {
                const records = await store.list({ sessionId });
                const found = records.find(record => record.id === id);
                // The host compares the whole record before writing; a record read
                // after someone else deleted it would only produce a conflict, so the
                // clearer answer is that it is gone.
                if (found === undefined)
                    return '任务已经不在了（可能刚被删除）';
                expected = found;
            }
            catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
            try {
                // `change` (the timing selector) is deliberately absent: an edit from
                // the chat rewrites the name or the instruction and keeps the rule, so
                // a `run 1` a minute later still fires on the schedule the reader set.
                const result = await store.update({ sessionId, id, expected, ...change });
                if (result.updated !== true)
                    return scheduleRefusal(result, '修改');
            }
            catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
            await refreshScheduleRegistry(sessionId).catch(() => { });
            return undefined;
        },
    };
    /**
     * Call ids whose declared files were already delivered, per session.
     *
     * A turn can end with more than one declaration, and a host may replay
     * the event or nest calls, so the call id is what makes the delivery
     * exactly-once. The set is bounded by the number of declarations one
     * session makes, which is small.
     */
    const presentedCalls = new Map();
    // Per-session preset choice made via /preset. Process-local: a restart
    // falls back to the configured default, which the /config command states.
    const sessionPresets = new Map();
    /**
     * Per-session reasoning effort chosen via /think.
     *
     * Unlike the preset choice above this one survives a restart: it is recorded
     * as a durable `model/selection` event on the session itself, and restored
     * when the agent is composed. The choice belongs to the session — `/sessions`
     * can bring that session back, and it must come back at the effort it was
     * left at.
     */
    const effortOverrides = new EffortOverrides(ctx);
    const subagentTrackers = new Map();
    /** One team card per chat, with the message id it updates in place. */
    const teamTrackers = new Map();
    /** 外勤会话镜像 (P141)：未绑定且非子会话的独立会话，按会话节流推一行进度。 */
    const externalMirrorAt = new Map();
    /** childId → chatId. 0.1.5 runs every child in its OWN session — the id
     * `subagent/catalog` reports as `childId` IS that session id (verified against
     * this install: each of the 20 catalog ids had a matching session directory),
     * so a child's events arrive under a session that has no chat binding. This map
     * is how they find their panel row without touching the parent's display. */
    const childChat = new Map();
    /**
     * 别处的动静该推给哪一个群。
     *
     * 一个会话既不是本群开的、也不是已知子会话时，它和任何一个群都没有关系。
     * 这类消息原先是向**所有**绑定群各发一份的（2026-11-04 现场：`D:\Desktop`
     * 下一个子代理会话让每个群都收到 `T1 进行中`）。代价随群数线性增长，而收
     * 到的读者全都不知道说的是什么。
     *
     * 现在只发给一个群：显式配置的 `externalMirrorChatId`，没配就取第一个绑
     * 定了会话的群（进程内一致——同一轮里多次调用必须落在同一个群，否则同一件
     * 事的进度和交付文件会散到两个群）。一个绑定群都没有时返回 undefined，
     * 调用方据此静默。
     */
    const externalMirrorChat = () => {
        const configured = config.externalMirrorChatId;
        if (configured !== '')
            return configured;
        // Map 的插入顺序是绑定顺序；取第一个是稳定且可解释的。
        for (const binding of bySession.values())
            return binding.chatId;
        return undefined;
    };
    // Per-session operation counters for /audit, accumulated from the session
    // event stream. Process-local like the schedule registry.
    const auditStats = new Map();
    const bySession = new Map();
    const pendingApprovals = new Map();
    /**
     * Arguments of tool calls this turn requested, by call id. An approval names
     * the call it decides but not what that call does, and the human cannot judge
     * an escalation without seeing the command; the log already published these.
     */
    const pendingCallArguments = new Map();
    /** Live workflow run id -> chat id, fed by the durable run-start event. */
    const workflowChats = new Map();
    /** Most recent assistant message id per session, for `/feedback`. */
    const lastAssistantIds = new Map();
    // Sessions that already received a token-pressure warning since the last
    // drop below threshold. Re-arms when a later poll finds the session back
    // under the threshold, so a fresh climb warns again.
    const pressureWarned = new Set();
    /** The last token total seen for a session, so the poll log only speaks when it changed. */
    const lastMeasured = new Map();
    const cwd = resolve(config.cwd ?? process.cwd());
    /**
     * Per-chat cwd overrides, loaded once and kept in step with writes.
     *
     * A chat that ran `/ws use <dir>` keeps that directory across restarts and
     * across `/new`: the binding is the chat's, not the session's, because the
     * whole point is that the next conversation starts in the same project.
     */
    let chatBindingsPromise;
    /**
     * The loaded bindings, for callers that cannot await — the CoT banner runs
     * inside a synchronous renderer callback. Filled on the first read and kept
     * in step by {@link bindChatCwd}; `undefined` only before that first read
     * settles, where the banner simply omits the binding instead of guessing.
     */
    let chatBindingsCache;
    const chatBindings = () => {
        chatBindingsPromise ??= readChatWorkspaces().then((bindings) => {
            chatBindingsCache = bindings;
            return bindings;
        });
        return chatBindingsPromise;
    };
    /**
     * The directory a chat's next session should start in.
     *
     * Bound chats win; everything else falls back to the deployment `cwd`. The
     * result is canonicalised because the workspace registry validates a session
     * header against a realpath, and an uncanonicalized variant is rejected.
     *
     * @param chatId - the chat asking.
     * @returns the absolute directory for its next session.
     */
    const chatCwd = async (chatId) => {
        const bindings = await chatBindings();
        const bound = bindings[chatId];
        return bound === undefined ? cwd : resolve(bound);
    };
    /**
     * Bind one chat to a directory (or clear it with `null`) and drop the cached
     * workspace promise, so the next session resolves the new directory.
     *
     * @param chatId - the chat being rebound.
     * @param dir - absolute directory, or `null` to fall back to the deployment cwd.
     */
    const bindChatCwd = async (chatId, dir) => {
        await writeChatWorkspace(chatId, dir);
        const bindings = await chatBindings();
        if (dir === null)
            delete bindings[chatId];
        else
            bindings[chatId] = dir;
        // Same object the promise resolved with, so the banner sees the rebind
        // immediately rather than on the next process start.
        chatBindingsCache = bindings;
    };
    /**
     * The host's working-directory owner, when this composition loads it.
     *
     * Resolved per call rather than cached: a profile can hot-load the plugin
     * (`dsh` is plugin-based), and a cached `undefined` would keep the bridge in
     * "only the next session moves" mode for the life of the process.
     *
     * `strict = false` because the caller already treats the service as optional
     * and falls back to the session header. With strict lookup a service whose
     * providing fiber is not ACTIVE reads as absent, and the bridge would quietly
     * degrade to "wait for /new" on a fully capable host.
     */
    const workingDirectory = () => ctx.get('workingDirectory', false);
    /**
     * Where a session actually runs, or undefined when the host cannot say.
     *
     * NOT `session.meta.cwd`: that is the immutable original project. The
     * effective directory is the one every directory-based operation uses, and
     * it moves when `workingDirectory.set` runs. Takes the session because that
     * is what `get` needs — no liveness required to read.
     * @param session - the session to ask about.
     * @returns its current directory, or undefined without the host service.
     */
    const workingDirectoryOf = (session) => {
        if (session === undefined)
            return undefined;
        const service = workingDirectory();
        if (service === undefined)
            return undefined;
        try {
            return service.get(session);
        }
        catch {
            return undefined;
        }
    };
    /**
     * Move a LIVE agent onto another directory, in place.
     *
     * This is what makes switching a workspace take effect immediately instead of
     * on the next `/new`: the host appends a durable `working-directory/change`
     * event and injects a model-facing notice, and the AGENTS.md loader re-reads
     * the directory on every prompt assembly.
     *
     * A refusal is reported and swallowed: the chat's binding is already written,
     * so the operator still reaches the project on `/new`, and a failed switch
     * must not leave them wondering whether the command ran at all — the caller
     * says which of the two promises held.
     * @param agent - the live agent to move.
     * @param dir - the absolute directory to move it to.
     * @returns the canonical directory it now runs in, or undefined when it could not move.
     */
    const switchLiveDirectory = async (agent, dir) => {
        const service = workingDirectory();
        if (service === undefined)
            return undefined;
        try {
            return await service.set(agent, dir);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            notify(`dsh-lark-bridge: switching session ${agent.session.id} to ${dir} failed: ${detail}`);
            // The session may be mid-turn or the agent already disposed. Either way
            // the binding stands and the reply says the move deferred to `/new`.
            return undefined;
        }
    };
    /**
     * The directory each session id must start in, seeded before the ladder runs.
     *
     * `SessionLadder.create` receives only the session id — the chat it came from
     * is not part of the contract — so the bound directory is handed over here,
     * keyed by the id the acquire path is about to ask for.
     */
    const pendingSessionCwd = new Map();
    /**
     * Multi-agent panel plumbing — ONE updatable card per chat, keyed by the
     * child's own session id.
     *
     * Why `subagent/catalog` and not `subagent/descriptor`: 0.1.5 appends the
     * descriptor inside the CHILD's session (subagent-in-process-driver
     * `attachDescriptorAppend`), so a subscriber on the parent chat session never
     * receives it. The durable parent-side record is `subagent/catalog`
     * (`establishCatalogChild` → `parent.append`), and it carries
     * `childId / childCreatedAt / mode / label`. Wiring the panel to the
     * descriptor is why「多代理执行面板」never appeared while every gate stayed
     * green (2026-09-15).
     */
    const CARD_UPDATE_MIN_MS = 4000;
    const streamDebug = process.env.DSH_BRIDGE_STREAM_DEBUG === '1';
    const trackerFor = (chatId) => {
        let tracker = subagentTrackers.get(chatId);
        if (tracker === undefined) {
            tracker = subCard.createTracker();
            subagentTrackers.set(chatId, tracker);
        }
        return tracker;
    };
    /** Send the panel the first time, then keep it updated in place. */
    const flushSubagentCard = async (chatId, tracker, force) => {
        const now = Date.now();
        if (!force && tracker.updatedAt !== undefined && now - tracker.updatedAt < CARD_UPDATE_MIN_MS)
            return;
        // Serialize writes. The panel is now the only place a child's progress
        // shows, and six children settling inside one window used to fire six
        // overlapping updates: each rendered from the state it read before the
        // previous write landed, so the last writer could publish a stale panel,
        // and the burst brushed Feishu's per-chat update limit.
        if (tracker.sending === true) {
            tracker.pending = true;
            return;
        }
        tracker.sending = true;
        tracker.updatedAt = now;
        try {
            const card = subCard.render(tracker, now);
            if (tracker.messageId === undefined) {
                const sent = await replay.send(chatId, { card });
                tracker.messageId = sent.messageId;
                // A send issued while the connection was down only got queued, so the
                // id above is a placeholder. Repoint the tracker at the real message
                // once it lands, otherwise every later update edits a message that
                // does not exist and Feishu answers 99992354.
                replay.whenDelivered(sent.messageId, (realId) => {
                    const live = subagentTrackers.get(chatId);
                    if (live !== undefined && live.messageId === sent.messageId)
                        live.messageId = realId;
                });
            }
            else {
                await port.updateCard(tracker.messageId, card);
            }
            tracker.failures = 0;
        }
        catch (error) {
            tracker.failures = (tracker.failures ?? 0) + 1;
            // One failure is a blip; a run of them means the panel is frozen and the
            // chat no longer narrates children anywhere else, so say it out loud
            // once rather than letting the card quietly stop moving.
            if (tracker.failures === 3) {
                void replay.send(chatId, {
                    markdown: '⚠️ 多代理执行面板更新连续失败，面板上的进展可能已停止刷新；子代理仍在运行，结束时仍会汇报。',
                }).catch(reportSendFailure);
            }
            reportSendFailure(error);
        }
        finally {
            tracker.sending = false;
        }
        if (tracker.pending === true) {
            tracker.pending = false;
            await flushSubagentCard(chatId, tracker, true);
        }
    };
    /**
     * 重发面板：把当前那张冻结成快照，再沿消息流底部发一张新的接管更新。
     *
     * 存在的理由只有一个：面板一旦发出去就钉在消息流那个位置，后面的每条消息
     * （子代理完成播报、助手回复、工具结果）都排在它下面，长任务里要往上翻很远
     * 才看得见。飞书没有撤回接口，也没有「把消息重新置底」的接口，所以唯一能让
     * 它回到视野里的办法就是发一张新的。
     *
     * 旧的不能就那么放着：它还顶着「3 在跑」的旧画面，读者分不清哪张是活的，
     * 比没有卡更糟。所以先把它改写成说明白的快照（见 `renderFrozen`），再让它
     * 彻底退出更新循环——`messageId` 换掉之后，所有 flush 都指向新卡。
     * @param chatId - 面板所在的对话。
     * @returns 新卡是否发出；没有可发的面板（一张子代理都没派过）时为 false。
     */
    const repostSubagentCard = async (chatId) => {
        const tracker = subagentTrackers.get(chatId);
        if (tracker === undefined || tracker.entries.size === 0)
            return false;
        // 有发送在飞就先让开：否则新卡的 id 会被那次 in-flight 的 flush 用旧卡
        // 覆盖，之后所有更新都打回那张已经冻结的卡上。
        if (tracker.sending === true) {
            tracker.pending = true;
            return false;
        }
        const previous = tracker.messageId;
        const now = Date.now();
        if (previous !== undefined) {
            // 冻结失败不该阻止新卡发出：最坏结局是旧卡停在一张旧画面上，而新卡
            // 照样能用。所以这里独立 try，不让异常打断整个重发。
            try {
                await port.updateCard(previous, subCard.renderFrozen(tracker, now));
                tracker.frozenIds.push(previous);
            }
            catch (error) {
                reportSendFailure(error);
            }
        }
        // 清掉发送状态再发：新卡的 id 必须在 send 返回后立刻接管，期间任何
        // flush 都该被 `sending` 挡在门外而不是拿着旧 id 去更新。
        // 用 delete 而不是赋 undefined——`exactOptionalPropertyTypes` 下后者不合法。
        delete tracker.messageId;
        delete tracker.updatedAt;
        await flushSubagentCard(chatId, tracker, true);
        return tracker.messageId !== undefined;
    };
    /**
     * Send or refresh the team card for one chat.
     *
     * The card is sent once and updated in place afterwards, so a reader
     * watches one panel instead of scrolling a stream of team notices. The
     * throttle keeps a burst of team events from turning into a burst of card
     * updates.
     * @param chatId - the chat that leads the team.
     * @param force - update even inside the throttle window.
     */
    const flushTeamCard = async (chatId, force) => {
        const tracker = teamTrackers.get(chatId);
        if (tracker === undefined)
            return;
        const now = Date.now();
        if (!force && tracker.updatedAt !== undefined && now - tracker.updatedAt < CARD_UPDATE_MIN_MS)
            return;
        tracker.updatedAt = now;
        const card = teamCard.renderTeamCard(tracker.state);
        if (tracker.messageId === undefined) {
            // The first send waits on a round trip, and a second event can land
            // inside that window. Without this latch both see no message id and
            // each send a card of its own, so a chat ends up with two panels.
            //
            // The event that arrives meanwhile is not dropped: it is remembered,
            // and the card is sent again once the first send settled, so the
            // panel shows the newest state rather than the state at first send.
            if (tracker.sending === true) {
                tracker.pending = true;
                return;
            }
            tracker.sending = true;
            try {
                const sent = await replay.send(chatId, { card });
                tracker.messageId = sent.messageId;
                // Same placeholder hazard as the subagent panel: repair the cached id
                // when a queued send finally reaches Feishu.
                replay.whenDelivered(sent.messageId, (realId) => {
                    const live = teamTrackers.get(chatId);
                    if (live !== undefined && live.messageId === sent.messageId)
                        live.messageId = realId;
                });
            }
            finally {
                tracker.sending = false;
            }
            if (tracker.pending === true) {
                tracker.pending = false;
                await flushTeamCard(chatId, true);
            }
            return;
        }
        await port.updateCard(tracker.messageId, card);
    };
    /**
     * Fold a message one teammate relayed into another into the team card.
     *
     * The team package steers a member's message into the recipient's inbox
     * rather than recording a mailbox event, so the card's message list is
     * built from these relayed messages. A chat that has not seen a roster
     * event yet has no card to update, and the message is dropped with a note
     * rather than inventing a team the chat never led.
     */
    const noteTeamRelayMessage = (chatId, event) => {
        if (!isTeamRelayMessageEvent(event))
            return;
        const tracker = teamTrackers.get(chatId);
        if (tracker === undefined)
            return;
        teamCard.addTeamRelayMessage(tracker.state, event.data.message, event.data.message.source.senderSessionId);
        void flushTeamCard(chatId, true).catch(reportSendFailure);
    };
    const upsertSubagent = (chatId, id, descriptor, force = false) => {
        const tracker = trackerFor(chatId);
        subCard.addEntry(tracker, id, descriptor);
        void flushSubagentCard(chatId, tracker, force).catch(reportSendFailure);
    };
    /** The panel's「最近在做的事」line: the tool's name plus its most telling string
     * argument (path / command / query). markActivity clips it to one card line. */
    const toolActivityLine = (name, args) => {
        const first = Object.values((args ?? {}))
            .find(v => typeof v === 'string' && v.trim() !== '');
        return first === undefined ? name : `${name} ${String(first)}`;
    };
    /**
     * Fold one activity sample into a child's row.
     *
     * Attribution here is EXACT rather than guessed: the child works in its own
     * session and callers pass that session id, which is the same id
     * `subagent/catalog` keyed the row with — so concurrent children can never
     * show one child's work under another child's name.
     */
    const noteChildActivity = (chatId, childId, line, kind = 'tool') => {
        const tracker = subagentTrackers.get(chatId);
        if (tracker === undefined || line.trim() === '')
            return;
        const entry = subCard.markActivity(tracker, childId, line, Date.now(), kind);
        if (entry === undefined)
            return;
        if (streamDebug)
            notify(`dsh-lark-bridge: child ${childId}: ${line.slice(0, 60)}`);
        // The first thing a child does is worth an immediate redraw — otherwise the
        // row sits at「进行中」with no detail until the throttle window passes.
        //
        // The panel is the only channel. This used to ALSO post one chat message
        // per child per 30s (`🔀 label · step`), and the window was per child, so
        // six concurrent children produced up to twelve messages a minute: a long
        // fan-out buried the chat in `🔀 … write {…}` fragments that said less
        // than the row they duplicated. Progress lives in the card now; the chat
        // speaks once, when a child settles (see the `subagent/end` handler).
        void flushSubagentCard(chatId, tracker, entry.chunks <= 1).catch(reportSendFailure);
    };
    /**
     * A child's own session events are what the panel narrates.
     *
     * This routing is the whole point of the panel. Without it the card was
     * rendered once when `subagent/catalog` arrived and then froze at
     * 「进行中 · 0秒」for the child's entire run — the row existed, but the reader
     * still could not see what the child was doing.
     */
    const noteChildSessionEvent = (chatId, childId, event) => {
        // A message one teammate relayed to another lands in the recipient's own
        // session, so a chat that leads the team sees it through the child
        // mapping rather than through its own session.
        if (isTeamRelayMessageEvent(event)) {
            noteTeamRelayMessage(chatId, event);
            return;
        }
        // A child can declare a deliverable too. The declaration lands in the
        // child's own session, so the branch that serves the chat's own session
        // never sees it — and a file that cannot be placed used to vanish
        // without a word. The chat that owns the child gets it, or a notice.
        if (isPresentedEvent(event) && config.presentBridge !== false) {
            const callId = event.data.callId;
            let seen = presentedCalls.get(childId);
            if (seen === undefined) {
                seen = new Set();
                presentedCalls.set(childId, seen);
            }
            if (!seen.has(callId)) {
                seen.add(callId);
                void (async () => {
                    for (const file of event.data.files) {
                        const caption = file.description === undefined || file.description === ''
                            ? `交付文件 · turn ${event.data.turn}`
                            : file.description;
                        try {
                            await deliverChildDeclaredFile(chatId, file.path, caption);
                        }
                        catch (error) {
                            const detail = error instanceof Error ? error.message : String(error);
                            void replay.send(chatId, {
                                markdown: `⚠️ 交付文件 \`${file.path}\` 未能送达：${detail}`,
                            }).catch(reportSendFailure);
                        }
                    }
                })();
            }
            return;
        }
        if (isToolCallEvent(event)) {
            noteChildActivity(chatId, childId, toolActivityLine(event.data.name, event.data.arguments));
            return;
        }
        if (isAssistantMessageEvent(event)) {
            const text = event.data.message.content
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text).join('');
            noteChildActivity(chatId, childId, text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '', 'message');
        }
    };
    /**
     * Keep「已跑时长」honest while a child is quiet: a running row is re-rendered
     * on a slow tick even when no activity arrives, so the panel never looks
     * frozen. Idle chats cost nothing — the tick skips them.
     */
    const PANEL_TICK_MS = 15_000;
    const panelTicker = setInterval(() => {
        const now = Date.now();
        for (const [chatId, tracker] of subagentTrackers) {
            if (subCard.runningEntries(tracker).length === 0)
                continue;
            if (tracker.updatedAt !== undefined && now - tracker.updatedAt < PANEL_TICK_MS - 1_000)
                continue;
            void flushSubagentCard(chatId, tracker, true).catch(reportSendFailure);
        }
    }, PANEL_TICK_MS);
    panelTicker.unref?.();
    /**
     * Proactive context-pressure polling. While a live session is bound, the
     * host `tokenMeter` reports how many tokens the session's context costs; a
     * long task that outgrows the advised ceiling degrades quality before any
     * compaction runs. This heads-up posts at most once per crossing.
     */
    const pollTokenPressure = () => {
        if (config.tokenPressure.enabled === false)
            return;
        const tokenMeter = ctx.get('tokenMeter');
        if (tokenMeter === undefined)
            return;
        const { threshold } = config.tokenPressure;
        for (const [sessionId, binding] of bySession) {
            let total;
            let surface;
            try {
                // The meter replays the session's own event log, so it gets the
                // session object. Passing the id alone makes the replay read
                // nothing and the meter report zero tokens for every session —
                // silently, with no error to catch — and the context-pressure
                // warning below would then never fire.
                const measure = tokenMeter.measure(binding.session);
                total = measure.totalTokens;
                surface = measure.surfaceTokens;
            }
            catch (error) {
                // A session without a usable meter is not the chat's problem; log and
                // move on so one bad session cannot stall the whole sweep.
                ctx.logger.warn('token pressure measure failed for %s: %s', sessionId, error);
                continue;
            }
            // The sweep says nothing when it succeeds, so there is no way to
            // tell from outside that it ran at all — and "the meter was handed
            // the wrong thing" looks exactly like "no session is under
            // pressure". A line with the number the meter returned makes the
            // difference visible: a non-zero total proves the meter read the
            // session.
            //
            // The line is written only when the number moved, or the first
            // time it is seen. A poll every ten minutes for every session
            // would put a line per session per poll into the log, and a log
            // that repeats itself is a log nobody reads.
            const previous = lastMeasured.get(sessionId);
            if (previous === undefined || previous !== total) {
                lastMeasured.set(sessionId, total);
                notify(`dsh-lark-bridge: token pressure poll session=${sessionId} total=${total} surface=${surface} threshold=${threshold}`);
            }
            if (total >= threshold) {
                if (pressureWarned.has(sessionId))
                    continue;
                pressureWarned.add(sessionId);
                void replay
                    .send(binding.chatId, {
                    // 差额里哪一块在变要说得出来：拿到宿主的三段拆分就报细分，
                    // 拿不到才退回「系统提示 + 工具说明」的笼统说法。
                    markdown: tokenPressureLine({
                        total,
                        surface,
                        threshold,
                        breakdown: readContextBreakdown(ctx, binding.session),
                    }),
                })
                    .catch(reportSendFailure);
            }
            else {
                pressureWarned.delete(sessionId);
            }
        }
    };
    /**
     * 压缩/修剪完成那一刻的占用与窗口。
     *
     * 事件已经落盘，所以 `measure()` 回放出来的是压完之后的数——正是提示里
     * 「还剩多少可用」要报的那个。测不出来（没有计量服务、会话不可回放）时返回
     * `undefined`，提示退回只说释放量，而不是报一个假数字。
     */
    const compactionUsage = (session) => {
        const tokenMeter = ctx.get('tokenMeter');
        if (tokenMeter === undefined)
            return undefined;
        try {
            return {
                total: tokenMeter.measure(session).totalTokens,
                window: readContextWindow(ctx, session),
            };
        }
        catch (error) {
            ctx.logger.warn('compaction usage measure failed: %s', error);
            return undefined;
        }
    };
    const pressureTimer = config.tokenPressure.enabled === false
        ? undefined
        : setInterval(pollTokenPressure, config.tokenPressure.intervalMs);
    /**
     * Occurrences already surfaced, persisted across restarts.
     *
     * A plain in-memory Set re-announced the whole backlog on every boot, which
     * read as "the bridge keeps telling me about the same missed task". One
     * notice per occurrence is the contract, so it has to outlive the process.
     */
    const overdueWindowMs = Math.max(1, config.overdueScheduleWindowHours) * 3_600_000;
    const overdueSeen = readSeen(Date.now(), overdueWindowMs);
    /** The host's schedule table, in the same harness home the store uses. */
    const scheduleTableFile = () => join(process.env.DSH_HOME ?? join(process.env.HOME ?? homedir(), '.dsh'), 'storages', 'schedule.json');
    /**
     * Surface scheduled tasks whose moment passed without the host delivering them.
     *
     * The host driver does not fire on the clock — it catches up on some later
     * event — so a 09:00 task can land at 15:06 or not at all. This cannot
     * dispatch (that is an agent turn, the host's authority), but it can put the
     * miss in front of the person who scheduled it, with a button to run it now.
     */
    const checkOverdueSchedules = async () => {
        if (config.notifyOverdueSchedules === false)
            return;
        let table;
        try {
            table = JSON.parse(await readFile(scheduleTableFile(), 'utf8'));
        }
        catch {
            // No table, unreadable file, or corrupt JSON: all mean "nothing to say".
            return;
        }
        const now = Date.now();
        const window = Math.max(1, config.overdueScheduleWindowHours) * 3_600_000;
        // Who an unattended dispatch is attributed to. Without an allowlisted
        // sender there is no one to attribute the turn to, so the watchdog falls
        // back to asking — the same path as when auto-dispatch is off.
        const autoSender = config.autoDispatchOverdueSchedules === true && config.senderAllowlist.length > 0
            ? config.senderAllowlist[0]
            : undefined;
        // 容差来自配置：晚 N 分钟才算漏发，避免把调度器正常的晚触发报成漏发。
        const tolerance = Math.max(0, config.overdueToleranceMinutes) * 60_000;
        for (const task of overdueTasks(table.tables?.tasks ?? {}, now, window, tolerance)) {
            const key = `${task.id}@${task.scheduledAt}`;
            if (overdueSeen[key] !== undefined)
                continue;
            const chatId = chatOfSession(task.sessionId);
            if (chatId === undefined)
                continue;
            // Record BEFORE sending. If the send fails, retrying on the next minute
            // is right; if it succeeds, a restart must not announce it again.
            markSeen(overdueSeen, key, now);
            if (autoSender !== undefined && task.sessionId !== undefined) {
                const started = await dispatchOverdue(key, task.sessionId, chatId, autoSender);
                await replay.send(chatId, {
                    markdown: started
                        ? `⏰ 定时任务「${task.title}」漏发了，已经自动补跑（本应 ${localDue(task.scheduledAt)} 执行）。`
                        : `⏰ 定时任务「${task.title}」漏发了，自动补跑没起来，请手动处理。`,
                }).catch(reportSendFailure);
                continue;
            }
            await replay.send(chatId, { card: overdueCard(task, chatId) }).catch(reportSendFailure);
        }
    };
    const overdueTimer = config.notifyOverdueSchedules === false
        ? undefined
        : setInterval(() => { void checkOverdueSchedules().catch(reportSendFailure); }, 60_000);
    // First pass shortly after boot rather than a minute in: a restart is exactly
    // when a backlog is waiting.
    const overdueFirstPass = config.notifyOverdueSchedules === false
        ? undefined
        : setTimeout(() => { void checkOverdueSchedules().catch(reportSendFailure); }, 20_000);
    overdueTimer?.unref?.();
    overdueFirstPass?.unref?.();
    // Warm the binding snapshot the CoT banner reads synchronously. A failure is
    // reported, never fatal: the banner just omits the binding for that boot.
    void chatBindings().catch((error) => {
        notify(`dsh-lark-bridge: reading chat workspace bindings failed: ${String(error)}`);
    });
    /**
     * The workspace chat sessions are accounted under, resolved once. Workspace
     * grouping is an ACCOUNT, not a cwd derivation: a session nobody attaches
     * stays in the GUI's Ungrouped bucket however its cwd reads. Registering the
     * directory when no record exists keeps chat sessions out of that bucket
     * instead of orphaning every one of them.
     */
    /**
     * Resolve (or register) the workspace record for one directory.
     *
     * Cached by DIRECTORY, not by chat: two chats in the same project share one
     * lookup, and a chat rebound to another project simply asks under a new key —
     * so a rebind can never be served by a stale promise.
     *
     * @param dir - the canonical directory a session starts in.
     * @returns the workspace record, or undefined when no registry is composed.
     */
    const workspacePromises = new Map();
    const chatWorkspace = (dir) => {
        const existing = workspacePromises.get(dir);
        if (existing !== undefined)
            return existing;
        const pending = (async () => {
            const registry = ctx.get('workspaceRegistry');
            if (registry === undefined)
                return undefined;
            return (await registry.resolveByPath(dir)) ?? await registry.create(dir);
        })().catch((error) => {
            // Grouping is presentation: a chat must still work in a deployment whose
            // registry refuses this directory.
            notify(`dsh-lark-bridge: workspace lookup failed for ${dir}: ${String(error)}`);
            return undefined;
        });
        workspacePromises.set(dir, pending);
        return pending;
    };
    // Operator-facing, so it goes to the process stream as well as the logger:
    // the shipped profiles compose no logger printer, and a silently swallowed
    // outbound failure is indistinguishable from a hung chat.
    const reportSendFailure = (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        notify(`dsh-lark-bridge: outbound send failed: ${detail}`);
        ctx.logger.warn('outbound send failed: %s', detail);
    };
    /**
     * One platform error as an operator can act on.
     *
     * The SDK's `LarkChannelError` keeps the open-platform `code` and `log_id`
     * away from the message text, and those two are precisely what Feishu's
     * ticket system and its docs ask for — "Invalid ids" without the code is a
     * dead end. Reading them off the error object costs nothing when absent.
     * @param error - whatever was thrown.
     * @returns message plus code/log id when the SDK supplied them.
     */
    const describeError = (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const record = (typeof error === 'object' && error !== null ? error : {});
        const code = record.code ?? record.errorCode;
        const logId = record.logId ?? record.log_id;
        // The SDK keeps the platform's own answer on the `cause` chain (a `code` +
        // `msg` response body), not in the message it composes. Walking a couple of
        // levels is enough and cannot cycle forever.
        const causes = [];
        let cause = record.cause;
        for (let depth = 0; depth < 3 && typeof cause === 'object' && cause !== null; depth++) {
            const inner = cause;
            const parts = [inner.code, inner.msg ?? inner.message]
                .filter(part => part !== undefined && part !== '')
                .map(part => String(part));
            if (parts.length > 0 && !causes.includes(parts.join(' ')))
                causes.push(parts.join(' '));
            cause = inner.cause;
        }
        const extras = [
            code === undefined ? '' : `code=${String(code)}`,
            logId === undefined ? '' : `log_id=${String(logId)}`,
            causes.length === 0 ? '' : `飞书返回：${causes.join(' ← ')}`,
        ].filter(part => part !== '');
        return extras.length === 0 ? message : `${message}（${extras.join('，')}）`;
    };
    /** Lifecycle emoji feedback on triggering messages; disabled by configuration. */
    const reactions = config.reactionFeedback
        ? createReactionTracker(port, undefined, reportSendFailure)
        : undefined;
    /**
     * Live todo progress cards: `todo_write` snapshots render as one card per
     * session, updated in place. This is the chat equivalent of the Web UI's
     * sidebar todo projection.
     */
    //
    // 重启后认回上次那张卡：否则同一轮待办会多发一张、旧卡永远停住。
    const restoredCards = (kind) => new Map(restoredState.cards
        .filter(card => card.kind === kind && card.sessionId !== undefined)
        .map(card => [card.sessionId, { chatId: card.chatId, messageId: card.messageId }]));
    const rememberCard = (kind, sessionId, chatId, messageId) => {
        restartStore.rememberCard({
            chatId,
            kind,
            messageId,
            ...sessionId === undefined ? {} : { sessionId },
            updatedAt: new Date().toISOString(),
        });
    };
    const todos = createTodoRenderer(port, reportSendFailure, {
        restored: restoredCards('todo'),
        onCard: (sessionId, chatId, messageId) => rememberCard('todo', sessionId, chatId, messageId),
    });
    /** Live goal cards: `goal/change` snapshots render as one card per session. */
    const goals = createGoalRenderer(port, reportSendFailure, {
        restored: restoredCards('goal'),
        onCard: (sessionId, chatId, messageId) => rememberCard('goal', sessionId, chatId, messageId),
    });
    /**
     * The conversations whose goal must be re-armed after a restart.
     *
     * A goal stays durable in the session log across a boot, but its continuation
     * authority resets to `disarmed` and the runtime waits for a human message.
     * That default stops a long task dead on every deploy, so the bridge keeps the
     * short list of conversations to reopen and re-arm by itself.
     */
    const goalWatch = createGoalWatch();
    /**
     * The model-to-human question flow. dsh's `ask_user_question` tool pauses a
     * tool call until a human answers through the single user-questions provider.
     *
     * The seam allows exactly ONE provider. The web profile's api-proxy
     * registers it first (its questions surface in the browser), so a bridge
     * registered on the web profile would fail the plugin's fiber asynchronously
     * and stop the WebSocket from connecting. Deploy the bridge on a profile
     * WITHOUT the web-app bundle (e.g. bundles = [dsh-base, dsh-lark-bridge]):
     * then this bridge owns the slot and the model's question becomes a Feishu
     * card. On the web profile the register is skipped and chat agents ask in
     * prose instead.
     */
    const questions = createQuestionProvider(port, (sessionId) => {
        const binding = bySession.get(sessionId);
        return binding === undefined ? undefined : { chatId: binding.chatId };
    }, {
        // 待回答落盘：重启后还能按 token 找回来，把那一按变成一条新消息送回会话，
        // 而不是让用户对着「该问题已失效」的提示发呆。
        remember: question => restartStore.rememberQuestion(question),
        forget: token => restartStore.forgetQuestion(token),
        find: token => restartStore.load().questions.find(row => row.token === token),
        answer: (entry, text, operatorId) => {
            // 点按钮的人可能拿不到（旧事件没有 operator），退到第一个授权用户：
            // 这条消息必须可归属，否则会绕过 allowlist 的判断。
            void replayRestartAnswer(entry, text, operatorId === '' ? config.senderAllowlist[0] ?? '' : operatorId);
        },
    });
    let disposeQuestions;
    try {
        // 0.1.5 moved this seam from a provider registry on `ctx.userQuestions`
        // (`registerProvider`) to the `user-questions/request` waterfall: a
        // listener claims the request by RETURNING an answer and delegates by
        // calling `next()`. The request shape is unchanged (questions/agent/
        // signal), so the provider plugs in directly. A throw fails the question
        // closed rather than leaving the model hanging.
        const onQuestion = async (request, next) => {
            try {
                return await questions.provider.ask(request);
            }
            catch (error) {
                ctx.logger.warn('user-questions answerer failed, delegating: %s', error);
                return await next();
            }
        };
        disposeQuestions = ctx.on('user-questions/request', onQuestion);
    }
    catch (error) {
        // A synchronous throw here means the seam is absent from this profile
        // composition. The card handler stays installed either way so a slot
        // that opens later can still resolve a pending question.
        notify(`dsh-lark-bridge: user-questions provider unavailable (${error instanceof Error ? error.message : String(error)})`);
        ctx.logger.warn('user-questions provider unavailable: %s', error);
    }
    /**
     * Resolve the provider/model for a new chat agent.
     *
     * The host's own selection comes first: it carries the choice `/model`
     * saved, and the config values are the deployment's initial defaults
     * rather than a lock. Reading the config first would make `/model` report
     * a switch that never reaches a new agent.
     */
    const modelSelection = () => {
        const defaults = ctx.get('agentDefaultModel');
        if (defaults !== undefined) {
            return defaults.currentSelection();
        }
        if (config.provider !== undefined || config.model !== undefined) {
            return { provider: config.provider, model: config.model };
        }
        throw new Error('dsh-lark-bridge: no model configured — set config.provider/model or compose the agentDefaultModel service');
    };
    /**
     * Resolve what one agent joins, and the view its calls are described through.
     * A deployment with a preset roster keeps every model-facing row on the agent
     * plane, so an agent that joins nothing reaches the model with NO tools and
     * none of the deployment's prompt sections. The id is resolved up front to
     * record it, and the join happens inside setup so a broken preset rolls the
     * whole creation back instead of publishing a toolless session.
     * @returns the composition every rung of one session's ladder applies.
     * @throws when the roster supplies no such preset.
     */
    const composeAgent = async (sessionId) => {
        // Loader siblings mount concurrently; await the complete application so a
        // first message arriving during boot never sees a half-composed agent world.
        await ctx.get('loader')?.await();
        const presets = ctx.get('agentPresets');
        // A /preset switch is remembered per session, so a later resume (the chat
        // speaking again after /stop, or a bridge restart) composes the preset the
        // human chose instead of silently falling back to the configured default.
        const presetId = presets === undefined ? undefined : (await presets.resolve(sessionPresets.get(sessionId) ?? config.preset)).id;
        // A roster keeps every tool off the global layer, so its standing key is
        // the view that can describe this agent's calls.
        // 0.1.7: `standingKeyFor` was replaced by `acquireScope`, which returns a
        // disposable lease `{ key: ScopeKey } & AsyncDisposable` instead of a bare
        // key. Sources: dsh-api-session-controller/lib/index.js:2324 (hands the
        // lease to its caller) and dsh-webhook/lib/index.js:158 (holds it for the
        // life of the using-scope). This scope lives as long as the session does,
        // so the lease is kept and released with the session, never eagerly.
        const toolScopeLease = presets === undefined || presetId === undefined
            ? undefined
            : await presets.acquireScope(presetId);
        const toolScope = toolScopeLease?.key;
        return {
            ...presetId === undefined ? {} : { presetId },
            ...toolScope === undefined ? {} : { toolScope },
            presentCall: createCallPresenter(ctx.get('tools'), toolScope),
            setup: async (agentCtx, agent) => {
                if (presets !== undefined && presetId !== undefined)
                    await presets.mount(agentCtx, presetId);
                composeChatAgent(agentCtx, config, [sendFileTool, ...feishuTools], runtimeDeniedTools, identityClause);
                // `/think` has two edges, and both belong to this session's scope: the
                // choice recorded in the session's own log (so a resumed session comes
                // back at the effort its human left it at, not the deployment default),
                // and the request hook that applies it (so a change lands on the next
                // step instead of the next session). The hook reads the table by
                // session id, so one agent's choice can never move another's.
                //
                // Guarded on the agent: the host hands it over, but a host old enough
                // to omit the second argument must still get a composed agent — a
                // missing `/think` is a smaller failure than a chat that cannot start.
                if (agent !== undefined) {
                    effortOverrides.restore(agent.session);
                    effortOverrides.install(agentCtx, agent.session.id);
                }
                // Background jobs: a registered under this agent scope sees exactly the
                // jobs its owner starts. Announce terminals so a long-running task's
                // completion is visible in the chat instead of silent until asked.
                // Direct subagent tool calls announce their settlement live. The
                // opening is already covered by the durable subagent/descriptor line,
                // so only the terminal edge is rendered here.
                agentCtx.on('subagent/end', (info) => {
                    const binding = bySession.get(sessionId);
                    if (binding === undefined)
                        return;
                    // Settle the panel row this child owns. `info.id` is the child's
                    // session id, which is exactly the key the catalog row used.
                    const tracker = subagentTrackers.get(binding.chatId);
                    // The child is done: stop resolving its session to this chat.
                    childChat.delete(info.id);
                    const settled = tracker?.entries.get(info.id);
                    if (tracker !== undefined) {
                        // 失败时把「它最后说的话」留下面板：只标一个 ❌ 回答不了「为什么
                        // 失败」，读者还得去翻会话记录。子代理的最后一条助手消息通常就是
                        // 错误原文或它卡住的地方。
                        const detail = subCard.failureText(info);
                        if (subCard.settleEntry(tracker, info.id, info.stopReason, Date.now(), detail) !== undefined) {
                            void flushSubagentCard(binding.chatId, tracker, true).catch(reportSendFailure);
                        }
                    }
                    // Prefer the delivery block (label + duration + what it produced) over
                    // the bare「子任务结束 [id]」line, which told the reader nothing.
                    const delivery = settled === undefined ? undefined : subCard.deliveryText(settled);
                    // A child settling inside a running workflow is one of that run's
                    // members: the run card already counts it, and one line per child is
                    // what turned a 68-member scan into a wall of identical messages.
                    // The panel row above still settles, so nothing is lost — only the
                    // chat message is withheld. A standalone child keeps its report.
                    if (!workflows.isActive(binding.chatId)) {
                        void replay.send(binding.chatId, {
                            markdown: delivery ?? subagentEndLine(info),
                        }).catch(reportSendFailure);
                    }
                });
                const jobs = agentCtx.get('jobs');
                /**
                 * The retained output of a settled job, for its completion notice.
                 *
                 * `readAt` is the non-consuming read: it leaves the cursor the agent
                 * pulls from exactly where it is, so announcing a completion never
                 * steals output the model still expects to see (a `read()` here would).
                 * A notice without its tail still beats no notice, so any failure
                 * degrades to "no tail" instead of throwing into the event stream.
                 */
                const jobOutput = (job) => {
                    const coords = job.output;
                    if (jobs === undefined || coords === undefined || coords.total <= coords.earliest)
                        return '';
                    try {
                        // The engine's owner check takes a bare session-id string; the old
                        // object form failed it and the catch below ate the throw — the
                        // notice's tail was silently empty ever since the feature landed.
                        return jobs.readAt(job.id, coords.earliest, sessionId)
                            .chunks.map((chunk) => chunk.text).join('');
                    }
                    catch (error) {
                        // Degrading to "no tail" is right — a notice without its tail
                        // still beats no notice. But it used to degrade silently, and
                        // that is how the wrong caller shape stayed invisible: the
                        // failure left nothing behind to point at. It leaves a trace
                        // now, and still does not throw into the event stream.
                        console.warn(`[dsh-lark-bridge] 读取子任务 ${job.id} 的输出失败：`
                            + `${error instanceof Error ? error.message : String(error)}`);
                        return '';
                    }
                };
                // dsh 0.1.7 removed `JobRegistry.onJobDone`; completions now arrive on
                // the registry's event stream as a `settled` event carrying the job's
                // projection. `awaited` marks settlements a live `wait()` already
                // delivered, so only the unawaited ones are announced here — reporting
                // the awaited ones too would duplicate what the caller already got.
                jobs?.events?.subscribe({ owners: 'scope' }, (event) => {
                    if (event.type !== 'settled')
                        return;
                    if (event.awaited)
                        return;
                    const snapshot = event.job;
                    if (snapshot.status === 'running' || snapshot.status === 'stopping')
                        return;
                    const binding = bySession.get(sessionId);
                    if (binding === undefined)
                        return;
                    const output = jobOutput(snapshot);
                    // The projection carries only `startedAt`; the notice wants the
                    // elapsed time, so measure it here, at settlement.
                    const durationMs = Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0 ? Math.max(0, Date.now() - snapshot.startedAt) : undefined;
                    const terminal = {
                        id: snapshot.id,
                        kind: snapshot.kind,
                        label: snapshot.label,
                        status: snapshot.status,
                        ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
                        ...durationMs === undefined ? {} : { durationMs },
                        ...output === '' ? {} : { output },
                    };
                    void replay.send(binding.chatId, { markdown: jobDoneLine(terminal, config.limits.jobTailChars) }).catch(reportSendFailure);
                });
            },
        };
    };
    /**
     * One composition per session id, shared by the resume attempt, the create
     * that follows it, and the renderer that describes the session's calls.
     * Resolving a preset re-reads the roster, and a first-contact chat walks every
     * rung, so an uncached ladder would read the roster once per rung.
     */
    const compositions = new Map();
    const compositionFor = (sessionId) => {
        let pending = compositions.get(sessionId);
        if (pending === undefined) {
            pending = composeAgent(sessionId);
            compositions.set(sessionId, pending);
            // A rejected composition is not replayed: the next message may arrive
            // after the roster it named was fixed.
            pending.catch(() => { compositions.delete(sessionId); });
        }
        return pending;
    };
    const agents = ctx.agents;
    /** Session ids created (not resumed) this boot — they get the first-contact guide. */
    const freshlyCreated = new Set();
    const ladder = {
        lookup: (sessionId) => {
            const agent = agents.get(sessionId);
            // An agent another owner published is theirs to dispose.
            return agent === undefined ? undefined : { agent, dispose: () => Promise.resolve() };
        },
        resume: async (sessionId) => {
            const composition = await compositionFor(sessionId);
            const handle = await agents.resume({
                resumeSessionId: sessionId,
                agentOptions: modelSelection(),
                setup: composition.setup,
            });
            // The panel is app-wide and reconcile is idempotent; a resumed session
            // after a restart must refresh it too, or the human's `/` list keeps
            // whatever the previous boot published.
            publishSlashPanel(handle.agent);
            maybeSyncPendingPanel(handle.agent);
            return handle;
        },
        create: async (sessionId, requested) => {
            const composition = await compositionFor(sessionId);
            // The directory this session starts in: what the caller asked for when
            // it asked, else the chat's binding, else the deployment cwd. The
            // workspace's own canonical path is used so `attachSession` finds the
            // header cwd it validates against rather than an uncanonicalized variant.
            //
            // `requested` is how `/new` arrives here. A rotation is a preemptive
            // command that returns before the inbound path seeds
            // `pendingSessionCwd`, so before 2026-11-11 every `/new` fell through
            // to the deployment cwd and a chat bound to a project never moved —
            // the map lookup below only ever served ordinary messages. Both the
            // rotated id and the conversation's base id are still consulted for
            // those, since the seeding that triggered a rotation only knew the base.
            const baseSessionId = baseSessionIdOf(sessionId);
            const dir = requested
                ?? pendingSessionCwd.get(sessionId)
                ?? pendingSessionCwd.get(baseSessionId)
                ?? cwd;
            pendingSessionCwd.delete(sessionId);
            pendingSessionCwd.delete(baseSessionId);
            const workspace = await chatWorkspace(dir);
            const handle = await agents.create({
                sessionId,
                meta: {
                    cwd: workspace?.path ?? dir,
                    ...composition.presetId === undefined ? {} : { agentPreset: composition.presetId },
                },
                agentOptions: modelSelection(),
                setup: composition.setup,
            });
            // Only a true first contact (create, not resume) gets the guide; a
            // resumed session across restarts must not see it a second time.
            freshlyCreated.add(sessionId);
            if (workspace !== undefined) {
                await workspace.attachSession(sessionId).catch((error) => {
                    notify(`dsh-lark-bridge: session ${sessionId} stays ungrouped: ${String(error)}`);
                });
            }
            // The panel is app-wide, and the command list is only knowable from an
            // agent's scope, so the first chat to exist is what can publish it.
            publishSlashPanel(handle.agent);
            maybeSyncPendingPanel(handle.agent);
            return handle;
        },
        // A rejected resume is the registry's only existence probe, and an
        // unreadable session log looks exactly like a chat nobody ever messaged, so
        // the ladder's handled failures are reported rather than swallowed.
        report: (line) => { ctx.logger.info(line); },
    };
    /**
     * Forget everything this process keyed by a session that stopped serving its
     * conversation.
     *
     * `/new` disposes the previous agent and moves the chat to a fresh id, but
     * the per-session maps below outlived it. The binding was the one that hurt:
     * the ten-minute pressure sweep walks `bySession`, and `tokenMeter.measure`
     * replays a session's own log, which stays readable after disposal — so the
     * retired conversation kept being priced and its total was posted into the
     * chat that had just been rotated, reading as if the brand-new session were
     * already 127k deep (2026-11-06).
     *
     * Only maps that are meaningless once the session is gone are cleared here.
     * `sessionPresets` deliberately survives `/new`: the chat's model choice is
     * the chat's, and dropping it would make every rotation re-pick one.
     */
    const forgetSession = (sessionId) => {
        bySession.delete(sessionId);
        compositions.delete(sessionId);
        pressureWarned.delete(sessionId);
        lastMeasured.delete(sessionId);
        lastAssistantIds.delete(sessionId);
    };
    const sessions = new ConversationSessions(config.sessionScope, ladder, createRotationStore(), (sessionId) => { forgetSession(sessionId); });
    /**
     * 每条对话最近一次 `/resume` 列表的会话 id，按展示顺序。
     *
     * 序号是给人用的，必须对应到「他刚才看到的那张列表」——重新 list 一遍会
     * 因为中间有新会话落盘而整体错位，选 3 号却切到别的会话。所以缓存列表本身，
     * 只在 `/resume` 无参时刷新。
     */
    const resumeLists = new Map();
    /** 一张 `/resume` 列表最多列几个会话，多出来的只说数量。 */
    const RESUME_ROWS_MAX = 20;
    /**
     * 其中前几个带「上次做到哪」的预览。
     *
     * 每读一个预览都要扫一遍会话日志，列表整页都读会把一次查看变成磁盘冲击；
     * 而用户要挑的几乎总是最近那几个，更早的看时间和目录就够。
     */
    const RESUME_PREVIEW_ROWS = 8;
    /**
     * The renderer for one session, opened on first use and kept until the fiber
     * unwinds: it holds the turn's streaming card, which outlives any one message.
     * @param sessionId - the session whose events it renders.
     * @param msg - the message that reached this session.
     * @returns the binding, the same object for every later message of the session.
     * @throws when the session's composition cannot be resolved.
     */
    const bindingFor = async (sessionId, msg, session) => {
        const existing = bySession.get(sessionId);
        if (existing !== undefined)
            return existing;
        const { presentCall } = await compositionFor(sessionId);
        // The renderer is the composition's last reader; dropping it here leaves the
        // next conversation bound on this id to read the roster fresh.
        compositions.delete(sessionId);
        const binding = {
            chatId: msg.chatId,
            chatType: msg.chatType,
            renderer: renderFor(msg.chatId, presentCall, session),
            currentMessageId: undefined,
            session,
        };
        bySession.set(sessionId, binding);
        // Register this conversation's active goal for the boot-time re-arm.
        //
        // `goal/change` only fires when a goal is created or mutated, so a session
        // that already held one before this build existed would never appear on the
        // list — and the first restart would silently drop it. Touching the session
        // is the one moment the bridge has an agent to ask, so it asks here too.
        try {
            const service = ctx.goals;
            const live = agents.get(sessionId) ?? undefined;
            const view = live === undefined ? undefined : service?.get(live);
            if (view?.phase === 'active') {
                goalWatch.remember({
                    sessionId,
                    chatId: msg.chatId,
                    chatType: msg.chatType,
                    ...view.id === undefined ? {} : { goalId: view.id },
                    ...view.revision === undefined ? {} : { revision: view.revision },
                    objective: view.objective ?? '',
                });
            }
        }
        catch {
            // Registration is an optimisation for the next boot; never fail a message.
        }
        // First contact this boot: send the one-time guide. Best-effort — a send
        // failure must not block the chat that already has the agent working.
        if (config.onboarding && freshlyCreated.delete(sessionId)) {
            void replay.send(binding.chatId, onboardingMessage(process.env, identityClause())).catch(reportSendFailure);
        }
        return binding;
    };
    /**
     * The renderer one chat's output goes through.
     *
     * `cot` shows the process as the platform's own agent messages do — reasoning
     * in a thinking area, each tool call with an icon and its result as a code
     * block — and leaves the answer to an ordinary markdown message, which is
     * where the platform says a final answer belongs. `stream` keeps the whole
     * turn in one typewriter card instead, for clients older than that surface.
     * Either way `showProcess` decides whether the process is shown at all.
     * @param chatId - the chat this renderer serves.
     * @param presentCall - the session's tool presenter.
     * @returns the renderer for the configured output.
     */
    const renderFor = (chatId, presentCall, session) => {
        if (config.output === 'stream') {
            return createStreamRenderer(port, chatId, {
                showProcess: config.showProcess,
                presentCall,
                onFailure: reportSendFailure,
            });
        }
        return createCotRenderer(port, chatId, {
            showProcess: config.showProcess,
            hidden: config.hideProcessWhenDone,
            presentCall,
            onFailure: reportSendFailure,
            answer: createMessageRenderer(port, chatId, reportSendFailure),
            limits: config.limits,
            // 每一轮开头写一行「模型 · 工作区」。是**回调**不是取值：渲染器每个聊天
            // 只建一次，会跨过好多次换模型、换工作区，取一次值就永远是第一次那个。
            banner: () => {
                // `session` 是建这个渲染器时绑定的会话（渲染器本来就一个会话一个），
                // 查不到登记时用它兜底：第一轮 CoT 打开时 bySession 还没写上。
                const bound = [...bySession.values()].find(binding => binding.chatId === chatId);
                const sessionId = bound?.session.id ?? session?.id;
                const live = session ?? agents.get(sessionId ?? '')?.session ?? bound?.session;
                const wanted = sessionId === undefined ? undefined : effortOverrides.get(sessionId);
                const header = live?.requestHeader?.()?.config;
                // 回退到部署默认：一轮都还没发过请求时，header 还是空的，而这时读者
                // 最想知道「这一轮会用哪个模型」。
                const configured = ctx.get('agentDefaultModel')?.currentSelection();
                // 最后回退到桥配置本身：宿主没组合 model 服务、会话又还没发过请求时，
                // 这两处是仅有的真相——空着一行就等于这条提示没写。
                const provider = wanted?.provider ?? header?.provider ?? configured?.provider ?? config.provider;
                const model = wanted?.model ?? header?.model ?? configured?.model ?? config.model;
                const effort = effortName(wanted?.reasoningEffort ?? header?.reasoningEffort ?? configured?.reasoningEffort);
                // 目录取「当前实际在跑的那个」，不是 `meta.cwd`（那是会话出生时的原始
                // 项目，切过就是旧值）。宿主没组合 workingDirectory 时退回 header。
                const runIn = workingDirectoryOf(live) ?? live?.meta?.cwd ?? config.cwd;
                // 绑定读的是同步快照：banner 是渲染器的同步回调，等不了磁盘。第一次
                // 读还没落定时就不写这一项，宁可不显示也不猜一个目录。
                const boundDir = chatBindingsCache?.[chatId];
                return {
                    ...provider === undefined || model === undefined ? {} : { model: `${provider}/${model}` },
                    ...effort === undefined ? {} : { effort },
                    ...runIn === undefined ? {} : { workspace: runIn },
                    ...boundDir === undefined || resolve(boundDir) === runIn ? {} : { boundElsewhere: resolve(boundDir) },
                };
            },
        });
    };
    /**
     * Publish what this chat accepts to the bot's `/` panel. Reconcile is
     * idempotent (create missing, remove stale), so it runs on every session
     * acquire — a restart that resumes sessions still refreshes the panel.
     * Fire and forget: discovery is a convenience, and every command works
     * typed by hand.
     */
    /**
     * The Loader tree as of now, flattened for the chat inventory: the bridge's
     * scoped context shares the root loader, so its entries ARE the deployment's
     * plugin tree. Structural group rows (no name) are filtered downstream.
     */
    const loaderEntries = () => {
        try {
            // The bridge's scoped context delegates `loader` to the root; the cast is
            // safe because every dsh deployment mounts the loader plugin.
            // The same lookup the rest of the bridge uses for host services. The
            // earlier property access on the scoped context was not the same
            // seam, so a host that moved the loader left the inventory silently
            // empty.
            const loader = ctx.get('loader');
            const entries = loader?.entries;
            // A missing seam is not an empty deployment. Returning [] here would
            // tell the reader "no plugins are installed" when the truth is that
            // the bridge cannot see them, which is the difference between
            // "nothing to install" and "the inventory is broken".
            if (entries === undefined)
                return undefined;
            return [...entries.call(loader)];
        }
        catch {
            return undefined;
        }
    };
    /** The channel-owned commands, independent of any agent's scope — the boot-time panel floor. */
    const channelCommands = (locale) => [
        { name: CONSOLE_COMMAND, description: describeCommand(CONSOLE_COMMAND, locale, 'Open the console card') },
        { name: PRESET_COMMAND, description: describeCommand(PRESET_COMMAND, locale, 'View or switch mode') },
        { name: SESSIONS_COMMAND, description: describeCommand(SESSIONS_COMMAND, locale, 'View session history') },
        { name: SESSION_COMMAND, description: describeCommand(SESSION_COMMAND, locale, 'Inspect the current session') },
        { name: TOOLS_COMMAND, description: describeCommand(TOOLS_COMMAND, locale, 'View, deny, or allow tools') },
        { name: SCHEDULES_COMMAND, description: describeCommand(SCHEDULES_COMMAND, locale, 'View scheduled reminders') },
        { name: JOBS_COMMAND, description: describeCommand(JOBS_COMMAND, locale, 'View background jobs') },
        { name: AUDIT_COMMAND, description: describeCommand(AUDIT_COMMAND, locale, 'View operation audit') },
        { name: BALANCE_COMMAND, description: describeCommand(BALANCE_COMMAND, locale, 'DeepSeek API balance') },
        { name: MANUAL_COMMAND, description: describeCommand(MANUAL_COMMAND, locale, 'The full user guide') },
        // Only when the deployment composed the feedback service: a panel entry
        // that always answers with "not available" is worse than no entry.
        ...(ctx.get('messageFeedback') === undefined ? [] : [{ name: FEEDBACK_COMMAND, description: describeCommand(FEEDBACK_COMMAND, locale, 'Record feedback about this session') }]),
        { name: CONTEXT_COMMAND, description: describeCommand(CONTEXT_COMMAND, locale, 'View context pressure') },
        { name: SKILLS_COMMAND, description: describeCommand(SKILLS_COMMAND, locale, 'List / inspect discoverable skills') },
        { name: MODEL_COMMAND, description: describeCommand(MODEL_COMMAND, locale, 'View or switch the default model') },
        { name: THINK_COMMAND, description: describeCommand(THINK_COMMAND, locale, 'View or change this session’s reasoning effort') },
        { name: WS_COMMAND, description: describeCommand(WS_COMMAND, locale, 'List registered workspaces') },
        { name: PLUGINS_COMMAND, description: describeCommand(PLUGINS_COMMAND, locale, 'List deployed plugins and status') },
        { name: CONFIG_COMMAND, description: describeCommand(CONFIG_COMMAND, locale, 'View current configuration') },
        // /bot is listed even when the sync layer is not up: it answers with the
        // reason rather than failing, and a deployment that enables sync later
        // must not need a panel re-registration to reach it. The sync context is
        // published asynchronously, so testing for it here would be a race.
        { name: BOT_COMMAND, description: describeCommand(BOT_COMMAND, locale, 'Bridge dual-end status, settings, plugin sync') },
        // /restart only exists when the deployment wired a restart command; an
        // unconfigured restart must not sit on the panel answering with an error.
        ...(config.restartCommand === '' ? [] : [{ name: RESTART_COMMAND, description: describeCommand(RESTART_COMMAND, locale, 'Restart the host process') }]),
        { name: STOP_COMMAND, description: describeCommand(STOP_COMMAND, locale, 'Stop the current task') },
        { name: NEW_COMMAND, description: describeCommand(NEW_COMMAND, locale, 'Start a new session') },
        { name: RESUME_COMMAND, description: describeCommand(RESUME_COMMAND, locale, 'Switch to a stored session') },
        { name: PANEL_COMMAND, description: describeCommand(PANEL_COMMAND, locale, 'Repost the subagent panel') },
        { name: HELP_COMMAND, description: describeCommand(HELP_COMMAND, locale, 'Show available commands') },
    ];
    /**
     * The panel belongs to the Feishu APP, and a fleet shares one app: when web
     * and desktop both boot, two differently composed host command sets would
     * rewrite the panel out from under each other, and the menu stops matching
     * whichever endpoint actually answers the commands. The arbitration's
     * active endpoint is therefore the single panel writer — standbys keep
     * their list to themselves and re-sync the moment they are promoted
     * (election, `/bot activate`), which the inbound path drives through
     * `maybeSyncPendingPanel`.
     */
    let panelSyncPending = false;
    const ownPanel = async () => {
        const arbitration = await arbitrationForInbound();
        if (arbitration === null)
            return true;
        const syncCtx = getSyncContext();
        const identity = await ensureDeviceId();
        return isActiveEndpoint(arbitration, identity.deviceId, syncCtx?.form ?? 'web', syncCtx?.profile ?? 'web');
    };
    const publishSlashPanel = (agent) => {
        if (!config.syncSlashCommands)
            return;
        void (async () => {
            if (!(await ownPanel())) {
                panelSyncPending = true;
                notify('dsh-lark-bridge: standby endpoint skipped slash-panel sync (the active endpoint owns the panel)');
                return;
            }
            panelSyncPending = false;
            const hosted = ctx.get('commands')?.list(agent) ?? [];
            // The channel's own commands must appear in the panel too, not only the
            // host's: a command that lives in runCommandLine but never reaches the
            // bot's `/` list is invisible to the human, who reads the panel as the
            // contract of what the bot accepts. Host command descriptions come from
            // dsh in English; the panel follows the bridge's resolved locale, and
            // anything unmapped keeps its own description verbatim.
            const locale = config.locale;
            const desired = [
                ...hosted.map(descriptor => ({
                    name: descriptor.name,
                    description: describeCommand(descriptor.name, locale, descriptor.description),
                })),
                ...channelCommands(locale),
            ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            void syncSlashPanel(port, desired, notify).then(({ added, removed }) => {
                if (added.length > 0)
                    notify(`dsh-lark-bridge: registered /${added.join(', /')} on the bot's slash panel`);
                if (removed.length > 0)
                    notify(`dsh-lark-bridge: removed /${removed.join(', /')} from the bot's slash panel`);
            });
        })();
    };
    /** A promoted standby re-syncs the panel once, on the next inbound message. */
    const maybeSyncPendingPanel = (agent) => {
        if (!panelSyncPending || !config.syncSlashCommands)
            return;
        void ownPanel().then((mine) => {
            if (!mine)
                return;
            panelSyncPending = false;
            publishSlashPanel(agent);
        });
    };
    /** Aborts in-flight command executions when this bridge unwinds. */
    const commands = new AbortController();
    const lastSearchNoticeAt = new Map();
    ctx.effect(() => () => { commands.abort(); }, 'dsh-lark-bridge:commands');
    const commandSignal = () => commands.signal;
    /**
     * Report a stage that overruns, naming it.
     *
     * The inbound handler awaits several things with no deadline (device state,
     * the cloud arbitration record, session acquisition). When one never
     * settles the handler parks for good: the message is acknowledged with a
     * reaction and then nothing happens — no reply, no error, no log — and only
     * a restart clears it. Naming the stage that overran turns that from
     * guesswork into a one-line diagnosis.
     */
    const SLOW_STAGE_MS = 10_000;
    const stage = async (messageId, name, run) => {
        const timer = setInterval(() => notify(`dsh-lark-bridge: inbound ${messageId} still in stage=${name} after ${SLOW_STAGE_MS / 1000}s`), SLOW_STAGE_MS);
        timer.unref?.();
        try {
            return await run();
        }
        finally {
            clearInterval(timer);
        }
    };
    const handleMessage = async (msg) => {
        // One line per inbound message: without it, "no reply and no log" cannot be
        // told apart from "the handler never ran at all" — and that distinction
        // decides whether to look inside the bridge or outside it.
        notify(`dsh-lark-bridge: inbound ${msg.messageId} in ${msg.chatId}`);
        // Diagnostic probe: a ref'd watchdog sitting next to the unref'd stage
        // timers. If this line appears while a `still in stage=…` never does, the
        // awaited call is not what stalled — the timer subsystem is, and every
        // unref'd diagnostic in this file has been lying by staying silent.
        setTimeout(() => notify(`dsh-lark-bridge: ref'd watchdog fired for ${msg.messageId} (stage timers are unref'd)`), 15_000);
        // Authorization before anything else: a message here starts a
        // shell-capable agent. Refusals stay silent in the chat — answering would
        // turn the bot into an oracle for who is authorized — and name the sender
        // on the operator console, which is also how an owner finds their own id.
        const refusal = refuseMessage(authorization, msg);
        if (refusal !== undefined) {
            notify(`dsh-lark-bridge: ignored a message in ${msg.chatId}: ${refusal}`);
            return;
        }
        // A bot answering a bot is how mention loops start. `undefined` means the
        // event omitted the sender kind, which is "unknown", not "not a bot" — and
        // refusing every unknown sender would refuse ordinary traffic, so only a
        // positive bot signal is skipped.
        if (msg.senderIsBot === true)
            return;
        // An @-only ping carries no text; starting a turn on an empty prompt spends
        // a turn for nothing. Skipped before the acknowledgement, which would
        // otherwise promise work no turn is doing.
        if (msg.content.trim() === '')
            return;
        // The bot received a real request: acknowledge immediately so the sender
        // sees it landed, before any agent work starts.
        //
        // A synthetic message — one the bridge replayed for a missed schedule —
        // carries an id this platform never issued, so reacting to it is rejected
        // and replying to it is rejected too. The check is on the id's shape
        // because that is the only thing that distinguishes the two.
        const realMessage = msg.messageId.startsWith('om_');
        if (realMessage)
            reactions?.ack(msg.messageId);
        // A retired device answers with a one-line notice instead of an agent
        // turn — the successor machine owns the Feishu app's reply path now.
        // `/bot activate` passes through so this end can be re-enabled in chat.
        if (msg.content.trim() !== '/bot activate') {
            const deviceState = await stage(msg.messageId, 'device-state', () => readDeviceState());
            if (deviceState.retired === true) {
                await port.send(msg.chatId, {
                    markdown: '↪️ 本端已退位（设备已迁移）。如需在本机重新启用，请发 `/bot activate`。',
                }).catch(reportSendFailure);
                return;
            }
            // Cloud arbitration (when present): only the active ENDPOINT replies —
            // device + form + profile, since one machine running web and desktop
            // holds two Feishu connections and a machine-only check would let both
            // answer every message twice. Absence of arbitration — no credentials,
            // carrier down, never written — keeps every end replying as before.
            // When the active endpoint has gone silent, election lets the smallest
            // fresh endpoint key take over.
            const arbitration = await stage(msg.messageId, 'arbitration', () => arbitrationForInbound());
            if (arbitration !== null) {
                const syncCtx = getSyncContext();
                const myIdentity = await stage(msg.messageId, 'device-identity', () => ensureDeviceId());
                const myForm = syncCtx?.form ?? 'web';
                const myProfile = syncCtx?.profile ?? 'web';
                if (!isActiveEndpoint(arbitration, myIdentity.deviceId, myForm, myProfile)) {
                    const claimed = syncCtx !== undefined && await claimIfActiveStale(syncCtx, arbitration);
                    if (!claimed) {
                        // Standby backs off so the active endpoint is the only writer: a
                        // per-message chat notice would read as the bot talking to itself
                        // from a phone client (2026-09-10 operator report). The exception
                        // is the read-only troubleshooting pair — silence there is what
                        // makes a healthy standby look like a dead bot, since `/bot
                        // devices` is the very first thing the guide tells a puzzled
                        // operator to send. Everything else still gets no chat line.
                        const where = arbitration.form === undefined ? '' : `（${arbitration.form}${arbitration.profile === undefined ? '' : `/${arbitration.profile}`}）`;
                        notify(`dsh-lark-bridge: standby backed off a message in ${msg.chatId} (active: ${arbitration.activeName}${where})`);
                        if (standbyAnswers(msg.content)) {
                            await port.send(msg.chatId, {
                                markdown: `🛰️ 本端是待命端，活跃端是 **${arbitration.activeName}**${where}——命令由活跃端执行。`
                                    + '这条只读命令请到活跃端发；想让本端接管，发 `/bot activate`。',
                            }).catch(reportSendFailure);
                        }
                        return;
                    }
                    notify(`dsh-lark-bridge: elected active endpoint ${myIdentity.deviceId} (${myForm}/${myProfile}; previous went silent)`);
                }
            }
        }
        // Full-transcript ingest is fire-and-forget: never awaited, never blocks
        // or fails the turn (contract in src/chronicle.ts).
        postChronicle(config.chronicleEndpoint, { source: config.chronicleSource, text: msg.content, chatId: msg.chatId }, notify);
        try {
            // The ladder only sees the session id — the chat it came from is not part
            // of its contract — so the directory this session must start in is handed
            // over here, before the acquire that may create it.
            pendingSessionCwd.set(sessionIdFor(conversationKey(config.sessionScope ?? 'chat', msg)), 
            // Staged like the rest: a workspace read that never settles used to
            // park the handler with no log at all, and every message of the chat
            // queued behind it.
            await stage(msg.messageId, 'chat-cwd', () => chatCwd(msg.chatId)));
            const opened = await stage(msg.messageId, 'session-acquire', () => sessions.acquire(msg));
            const binding = await stage(msg.messageId, 'session-bind', () => bindingFor(opened.handle.agent.session.id, msg, opened.handle.agent.session));
            // The reaction lifecycle follows this session's current trigger.
            binding.currentMessageId = msg.messageId;
            // ── Preemptive commands (owner request 08-25): these bypass the normal
            // pipeline and act IMMEDIATELY on the agent, even mid-turn.
            const preemptive = msg.content.trim().toLowerCase();
            if (preemptive === '/stop') {
                opened.handle.agent.cancel('user-requested');
                notify(`dsh-lark-bridge: preemptive /stop for session ${opened.handle.agent.session.id}`);
                await port.send(msg.chatId, { markdown: '⏹ 已停止当前任务' }).catch(reportSendFailure);
                return;
            }
            // `/ws use <dir>` binds THIS chat to a project directory, durably, and
            // switches the LIVE session onto it.
            //
            // Two different promises, both kept:
            //   · the chat's binding — where the NEXT `/new` starts, because a chat
            //     outlives any one session and its project should survive a rotation;
            //   · the running session — switched in place through the host's
            //     `workingDirectory` service, so the user's next message already runs
            //     in the new project with its `AGENTS.md` loaded.
            //
            // The in-place switch is the host's own mechanism: `set()` appends a
            // durable `working-directory/change` event and injects a notice the model
            // reads on its next request, and the AGENTS.md loader calls
            // `workingDirectory.ensure()` per prompt assembly. This plugin used to
            // claim "the host has no way to move a running session" and demand a
            // `/new`; that claim was wrong (2026-11-11).
            //
            // A host whose composition lacks the service still works: the binding is
            // written and the reply says the switch takes effect on `/new`.
            const wsUse = /^\/ws\s+use(?:\s+(.+))?$/i.exec(msg.content.trim());
            if (wsUse !== null) {
                const asked = (wsUse[1] ?? '').trim().replace(/^["']|["']$/g, '');
                const liveDir = workingDirectoryOf(opened.handle.agent.session);
                if (asked === '') {
                    const bound = await chatCwd(msg.chatId);
                    const where = liveDir === undefined ? '' : `\n本会话实际运行目录：\`${liveDir}\``;
                    await port.send(msg.chatId, {
                        markdown: `📁 本会话绑定：\`${bound}\`${where}\n\n\`/ws use <目录>\` 切换（立即生效） · \`/ws use default\` 解除绑定`,
                    }).catch(reportSendFailure);
                    return;
                }
                if (asked.toLowerCase() === 'default') {
                    await bindChatCwd(msg.chatId, null);
                    const moved = await switchLiveDirectory(opened.handle.agent, cwd);
                    await port.send(msg.chatId, {
                        markdown: moved === undefined
                            ? `📁 已解除绑定，回到部署目录 \`${cwd}\`。\n\n⚠️ 本会话当前目录未变（宿主未组合 workingDirectory），发 \`/new\` 生效。`
                            : `📁 已解除绑定，本会话已切回部署目录 \`${moved}\`。\n\n该目录的 \`AGENTS.md\` 从下一条消息起生效。`,
                    }).catch(reportSendFailure);
                    return;
                }
                const target = resolve(asked);
                let isDirectory = false;
                try {
                    isDirectory = statSync(target).isDirectory();
                }
                catch { /* missing or denied */ }
                if (!isDirectory) {
                    await port.send(msg.chatId, {
                        markdown: `⚠️ 目录不存在或不是目录：\`${target}\`\n\n绑定未改动。`,
                    }).catch(reportSendFailure);
                    return;
                }
                await bindChatCwd(msg.chatId, target);
                const moved = await switchLiveDirectory(opened.handle.agent, target);
                await port.send(msg.chatId, {
                    markdown: moved === undefined
                        ? `📁 本会话已绑定到 \`${target}\`。\n\n⚠️ 本会话当前目录未变（宿主未组合 workingDirectory），发 \`/new\` 开新会话后生效。`
                        : `📁 本会话已切到 \`${moved}\`。\n\n该目录的 \`AGENTS.md\` 从下一条消息起生效，后续 \`/new\` 也默认落在这个项目。`,
                }).catch(reportSendFailure);
                return;
            }
            // `/new` (and its alias `/clear`) rotates the conversation onto a fresh
            // session, leaving the old one stored for history (`/sessions`). Refused
            // mid-turn: disposing the old agent would kill work the chat never asked
            // to abandon.
            if (preemptive === '/new' || preemptive === '/clear') {
                if (opened.handle.agent.status === 'running') {
                    await port.send(msg.chatId, { markdown: '⏳ 当前任务还在跑：先 /stop 或等它结束，再 /new 开新会话。' }).catch(reportSendFailure);
                    return;
                }
                try {
                    // The binding has to be resolved HERE, not inside the ladder: `/new`
                    // is preemptive and returns before the inbound path seeds
                    // `pendingSessionCwd`, so a rotation that let the ladder infer its
                    // directory always landed in the deployment cwd.
                    const rotated = await sessions.rotate(msg, await stage(msg.messageId, 'rotate-cwd', () => chatCwd(msg.chatId)));
                    notify(`dsh-lark-bridge: /new rotated ${msg.chatId} to session ${rotated.handle.agent.session.id}`);
                    const warn = rotated.persisted ? '' : '\n⚠️ 但轮换记忆写入失败：重启后这条对话会退回旧历史，重要话题先别开。';
                    await port.send(msg.chatId, { markdown: '🆕 已开新会话。下一条消息起就是新话题；旧会话保留在历史里（`/sessions` 可查）。' + warn }).catch(reportSendFailure);
                }
                catch (error) {
                    await port.send(msg.chatId, { markdown: `⚠️ 开新会话失败：${error instanceof Error ? error.message : String(error)}` }).catch(reportSendFailure);
                }
                return;
            }
            // `/panel` 把子代理面板重新发到消息流底部：面板就地更新，位置钉死，
            // 后面的消息一多就得往上翻很远才看得见，而「随时看进度」正是它的用途。
            if (new RegExp(`^\\/${PANEL_COMMAND}$`, 'i').test(msg.content.trim())) {
                try {
                    const reposted = await repostSubagentCard(msg.chatId);
                    if (!reposted) {
                        await port.send(msg.chatId, {
                            markdown: '（这条对话还没派过子代理，没有面板可重发。派出子代理后会自动出现。）',
                        }).catch(reportSendFailure);
                    }
                    // 成功时不再额外发话：新卡本身就是回答，多发一条只会又把它往下顶。
                }
                catch (error) {
                    await port.send(msg.chatId, {
                        markdown: `⚠️ 重发面板失败：${error instanceof Error ? error.message : String(error)}`,
                    }).catch(reportSendFailure);
                }
                return;
            }
            // `/resume` 切回本聊天的历史会话：`/sessions` 的列表 + `/new` 的换绑。
            // 序号只在最近一次 `/resume` 列表里有效（见 resumeLists），完整 id 任何时候都能用。
            const resumeAsked = /^\/resume(?:\s+(.+))?$/i.exec(msg.content.trim());
            if (resumeAsked !== null) {
                if (opened.handle.agent.status === 'running') {
                    await port.send(msg.chatId, { markdown: '⏳ 当前任务还在跑：先 /stop 或等它结束，再 /resume 切会话。' }).catch(reportSendFailure);
                    return;
                }
                const persistence = ctx.get('sessionPersistence');
                if (persistence === undefined) {
                    await port.send(msg.chatId, { markdown: '⚠️ 本部署没有组合会话存储，`/resume` 不可用。' }).catch(reportSendFailure);
                    return;
                }
                const asked = (resumeAsked[1] ?? '').trim();
                const currentId = opened.handle.agent.session.id;
                // 归属判定用推导出来的 id，而不是硬编码 `feishu-`：`sessionScope` 决定
                // key 里是否带线程/发送者 facet，前缀只有 sessionIdFor 算得准。
                const home = sessionIdFor(conversationKey(config.sessionScope ?? 'chat', msg));
                const belongsHere = (id) => id === home || id.startsWith(`${home}:`);
                if (asked === '') {
                    let headers;
                    try {
                        headers = await persistence.list();
                    }
                    catch (error) {
                        await port.send(msg.chatId, { markdown: `⚠️ 读取会话列表失败：${error instanceof Error ? error.message : String(error)}` }).catch(reportSendFailure);
                        return;
                    }
                    const owned = headers
                        .filter(header => belongsHere(header.header.id))
                        .sort((a, b) => b.header.createdAt - a.header.createdAt);
                    if (owned.length === 0) {
                        await port.send(msg.chatId, { markdown: '**历史会话**\n本聊天还没有已保存的会话。' }).catch(reportSendFailure);
                        return;
                    }
                    const shown = owned.slice(0, RESUME_ROWS_MAX);
                    resumeLists.set(msg.chatId, shown.map(header => header.header.id));
                    // 前几个带「上次做到哪」：切会话时窗口里看不到旧对话，没有这句用户
                    // 只能靠时间猜，等于盲切。
                    const previewed = await readPreviews(shown.slice(0, RESUME_PREVIEW_ROWS).map(header => header.header.id), { maxChars: 80 });
                    const rows = shown.map((header, index) => {
                        const when = new Date(header.header.createdAt).toLocaleString('zh-CN', { hour12: false });
                        const where = header.header.cwd === undefined ? '' : ` · \`${header.header.cwd}\``;
                        const mark = header.header.id === currentId ? ' ← 当前' : '';
                        const preview = previewed[index];
                        const head = `${index + 1}. ${when}${where}${mark}`;
                        if (preview === undefined)
                            return head;
                        // 第二行是规模，第三行是上次说到哪。规模决定「是不是那个很长的
                        // 会话」，上次那句话决定「是不是那个事」，两者缺一不可。
                        const scale = describeScale(preview);
                        const span = describeSpan(preview);
                        const scaleLine = scale === '' ? '' : `\n   ${scale}${span === '' ? '' : ` · 历时 ${span}`}`;
                        // 你说的话比我说的话更能唤起记忆，所以优先它；只有回复时退回回复。
                        const last = preview.lastUser ?? preview.lastAssistant;
                        return last === undefined ? `${head}${scaleLine}` : `${head}${scaleLine}\n   上次：${last}`;
                    });
                    const more = owned.length > shown.length
                        ? `\n…还有 ${owned.length - shown.length} 个更早的未列出（只显示最近 ${RESUME_ROWS_MAX} 个）。`
                        : '';
                    await port.send(msg.chatId, {
                        markdown: `**历史会话**（${owned.length} 个）\n${rows.join('\n')}${more}\n\n发 \`/resume <序号>\` 切过去。会话本身不会被改动，只是这条对话改为接着它聊。`,
                    }).catch(reportSendFailure);
                    return;
                }
                let targetId;
                if (/^\d+$/.test(asked)) {
                    const list = resumeLists.get(msg.chatId);
                    if (list === undefined) {
                        await port.send(msg.chatId, { markdown: '⚠️ 序号只对最近一次 `/resume` 列表有效：先发 `/resume` 看列表。' }).catch(reportSendFailure);
                        return;
                    }
                    const index = Number(asked);
                    if (index < 1 || index > list.length) {
                        await port.send(msg.chatId, { markdown: `⚠️ 序号超出范围（1–${list.length}）：先发 \`/resume\` 看列表。` }).catch(reportSendFailure);
                        return;
                    }
                    targetId = list[index - 1];
                }
                else {
                    targetId = asked;
                }
                if (targetId === currentId) {
                    await port.send(msg.chatId, { markdown: '↩️ 已经在这个会话上了，没有切换。' }).catch(reportSendFailure);
                    return;
                }
                try {
                    const attached = await sessions.attach(msg, targetId);
                    notify(`dsh-lark-bridge: /resume moved ${msg.chatId} to session ${attached.handle.agent.session.id}`);
                    const warn = attached.persisted ? '' : '\n⚠️ 但切换记忆写入失败：重启后这条对话会退回原来的会话。';
                    // 切换后补一句「上次做到哪」：窗口里看不到旧对话，不给定位线索
                    // 用户只能凭时间猜自己切对了没有。
                    const [preview] = await readPreviews([attached.handle.agent.session.id], { maxChars: 150 });
                    const scale = preview === undefined ? '' : describeScale(preview);
                    const recap = preview === undefined
                        ? ''
                        : [
                            scale === '' ? '' : `\n这段对话有 ${scale}。`,
                            preview.lastUser === undefined ? '' : `\n上次你说：「${preview.lastUser}」`,
                            preview.lastAssistant === undefined ? '' : `\n我上次回：「${preview.lastAssistant}」`,
                        ].join('');
                    await port.send(msg.chatId, {
                        markdown: `🔁 已切到会话 \`${attached.handle.agent.session.id}\`。${recap}\n下一条消息起就接着那个会话聊。${warn}`,
                    }).catch(reportSendFailure);
                }
                catch (error) {
                    await port.send(msg.chatId, { markdown: `⚠️ 切换会话失败：${error instanceof Error ? error.message : String(error)}` }).catch(reportSendFailure);
                }
                return;
            }
            // A slash line is a control, not a prompt: the host runs it without a
            // model turn, so it must not be handed to the model as text — and it
            // needs no reply target, since its answer is not an assistant turn.
            if (isCommandLine(msg.content)) {
                const sessionId = opened.handle.agent.session.id;
                const presetBefore = sessionPresets.get(sessionId);
                // `/tools` 前后的禁用集合快照：命令可能改它，改了就落盘。
                const deniedBefore = [...runtimeDeniedTools].join('\u0000');
                // A slash command runs on the host, not on the model. When it
                // throws, the outer catch would report "cannot start session" —
                // which is not what happened and sent issue #2's reporter looking
                // for a session problem instead of a command-argument problem.
                // The command path therefore owns its own error surface.
                let outcome;
                try {
                    // `/console` is the bridge's own card, not a host command: there is no
                    // command runtime seam that returns "send this card", so it is handled
                    // before the dispatcher rather than through it.
                    if (/^\/(?:console|控制台)\s*$/iu.test(msg.content.trim())) {
                        await openConsole(msg.chatId, opened.handle.agent.session.id);
                        return;
                    }
                    // A slash command may ask what is scheduled. Rebuild the registry
                    // first: a reminder created by an earlier process never announced
                    // itself to this one, and /schedules would report "none" for
                    // something that is still firing.
                    await stage(msg.messageId, 'schedule-seed', () => seedScheduleRegistry(opened.handle.agent.session));
                    // The command body, argument evaluation included: `compositionFor`
                    // and two workspace reads run before the call itself, so a stall
                    // there is just as invisible as one inside a command.
                    outcome = await stage(msg.messageId, 'command', async () => runCommandLine(msg.content, opened.handle.agent, ctx.get('commands'), commandSignal(), ctx.get('agentPresets'), ctx.get('sessionPersistence'), msg.chatId, runtimeDeniedTools, scheduleRegistry, auditStats, config, sessionPresets, ctx.get('sessionQuery'), ctx.get('jobs'), ctx.get('messageFeedback'), lastAssistantIds.get(sessionId), ctx.get('tokenMeter'), ctx.get('skills'), ctx.get('agentDefaultModel'), {
                        ...config.provider === undefined ? {} : { provider: config.provider },
                        ...config.model === undefined ? {} : { model: config.model },
                    }, ctx.get('workspaceRegistry'), 
                    // The chat's effective directory, not the deployment default: a
                    // `/ws use` binding outranks `config.cwd` for the next session, so
                    // `/ws` must report the same directory `/new` will land in.
                    await chatCwd(msg.chatId), loaderEntries(), getSyncContext(), ctx.get('tools'), (await compositionFor(sessionId)).toolScope, 
                    // `cwdBound` trails the whole signature, so it is last here even
                    // though it describes the cwd two arguments up.
                    (await chatBindings())[msg.chatId] !== undefined, 
                    // Seams added after the positional list stopped growing.
                    {
                        llm: ctx.get('llm'),
                        efforts: effortOverrides,
                        ctx,
                        sessionCwd: await chatCwd(msg.chatId),
                        sessionCwdBound: (await chatBindings())[msg.chatId] !== undefined,
                        sessionPreset: sessionPresets.get(sessionId),
                        schedule: scheduleControl,
                    }));
                }
                catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    notify(`dsh-lark-bridge: command execution failed for chat ${msg.chatId}: ${detail}`);
                    ctx.logger.warn('command execution failed for chat %s: %s', msg.chatId, error);
                    try {
                        const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
                        appendFileSync('/tmp/dsh-session-crash.log', `[${new Date().toISOString()}] chat=${msg.chatId} command=${msg.content}\n${stack}\n\n`);
                    }
                    catch { /* diagnostics must never mask the original failure */ }
                    await port
                        .send(msg.chatId, { text: `⚠️ 命令执行失败：${detail}` })
                        .catch(reportSendFailure);
                    return;
                }
                // A /preset switch changed this session's composition contract; the
                // cached composition would resume the OLD preset, so drop it and let
                // the next acquire compose from the remembered choice.
                if (sessionPresets.get(sessionId) !== presetBefore) {
                    compositions.delete(sessionId);
                }
                // `/tools deny|allow` 改的是这份内存集合，重启就没了。写完就落盘，
                // 下次开机在创建 store 时并回来（见 runtimeDeniedTools 的初始化）。
                if ([...runtimeDeniedTools].join('\u0000') !== deniedBefore) {
                    restartStore.rememberDeniedTools([...runtimeDeniedTools]);
                }
                if (outcome.reply !== '') {
                    await replay.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure);
                }
                // An interactive outcome (the account switcher) rides a card; the
                // empty reply says the card IS the whole answer.
                if (outcome.card !== undefined) {
                    await replay.send(binding.chatId, { card: outcome.card }).catch(reportSendFailure);
                }
                return;
            }
            // Busy-input routing (issue #5, `busyPolicy`) and its visibility
            // (2026-09-12 operator report, P140: a message sent mid-turn used to be
            // silent, and the chat read the wait as a hang). One short line names the
            // boundary the message actually took.
            const busyPlan = busyDelivery(opened.handle.agent.status === 'running', config.busyPolicy, opened.handle.agent);
            if (busyPlan.receipt !== '') {
                void replay.send(binding.chatId, { markdown: busyPlan.receipt }).catch(reportSendFailure);
            }
            // Aimed before the turn starts: the reply belongs to the message that
            // asked for it, and in a topic group an unaimed reply leaves the thread.
            // A synthetic message has no real id to quote, so it replies plainly
            // rather than failing the send on an id the platform never issued.
            if (msg.messageId.startsWith('om_')) {
                binding.renderer.aim({
                    messageId: msg.messageId,
                    ...msg.threadId === undefined ? {} : { threadId: msg.threadId },
                });
            }
            // Inbound file saving: non-image resources land in the workspace.
            let fileNotes = [];
            if (config.autoSaveFiles && msg.resources?.length) {
                try {
                    const saved = await saveInboundFiles(msg, (mid, fk, type) => port.downloadResourceWithMeta(mid, fk, type), config.cwd ?? process.cwd());
                    fileNotes = saved.notes;
                }
                catch { /* degrade silently */ }
            }
            // Auto-resume: after a bridge restart an interrupted goal stays durable
            // but its continuation authority resets to disarmed (dsh design). With
            // autoResumeGoals the bridge re-arms an active goal when the chat speaks
            // again, so a deploy no longer silently stops a running task. Best-effort
            // and fire-once per live agent: a later explicit /goal pause still wins.
            if (config.autoResumeGoals) {
                const agent = opened.handle.agent;
                try {
                    const goalsHost = ctx.goals;
                    const view = goalsHost?.get(agent);
                    if (view !== undefined && view?.phase === 'active' && view.activation === 'disarmed') {
                        const ref = { id: view.id, revision: view.revision };
                        const goalsRemote = ctx.goals;
                        await goalsRemote?.resume(agent, ref);
                        notify(`dsh-lark-bridge: auto-resumed goal "${ref.id}" for session ${agent.session.id}`);
                    }
                }
                catch (error) {
                    notify(`dsh-lark-bridge: auto-resume skipped for session ${opened.handle.agent.session.id}: ${String(error)}`);
                    ctx.logger.warn('goal auto-resume skipped: %s', error);
                }
            }
            {
                // Ambient situational briefing: once per session, prepended ahead of the
                // user's own text; failures degrade silently to no-briefing. The read is
                // sync and the file may live on a bridged filesystem, so wrap it: a
                // stall then names its stage instead of freezing the loop silently.
                const prefix = await stage(msg.messageId, 'briefing', async () => briefingPrefix(config.briefingFile, opened.handle.agent.session.id, notify));
                // 引用回复（消息 → 回复）：飞书只把 `parent_id` 放进事件，被引用那条的
                // 正文要另外读一次。不读，用户发的是「这个再改改」，模型看到的就只剩
                // 这五个字——它只能猜「这个」指什么。
                //
                // 话题群是例外：那里 `parent_id` 指的是话题根，不是用户主动引用的一条，
                // 拿它当引用会让每条消息都背上一段历史，把真正的提问挤出注意力。
                //
                // 除了正文，这里还要留下那条消息的 id：飞书「从别的应用分享」时会发成
                // 两条——图片一条、带文字的回一条并引用它。回的那条事件里照样列着图片，
                // 但只有图片自己那条消息能取到它（拿文字那条的 id 去取，飞书回 400）。
                const quote = await stage(msg.messageId, 'quote', async () => {
                    const parentId = msg.replyToMessageId;
                    if (parentId === undefined || parentId === '' || parentId === msg.messageId)
                        return undefined;
                    if (msg.threadId !== undefined && parentId === msg.threadId)
                        return undefined;
                    const fetchOne = port.fetchMessage;
                    if (typeof fetchOne !== 'function')
                        return undefined;
                    try {
                        const quotedMsg = await fetchOne.call(port, parentId);
                        // fetchRawMessage 是 transport 实例上的方法，内部要读 this.rawClient，
                        // 所以必须带着 port 这个 this 绑过去，不能裸传函数引用。
                        const fetchRaw = typeof port.fetchRawMessage === 'function'
                            ? port.fetchRawMessage.bind(port)
                            : undefined;
                        return {
                            prefix: quotedPrefix(await withCardText(quotedMsg, parentId, fetchRaw), config.limits.quoteChars, config.showMessageTime),
                            message: quotedMsg,
                        };
                    }
                    catch (error) {
                        // A quote the app cannot read must not cost the whole message: the
                        // user's own words still reach the model, minus the quote.
                        notify(`dsh-lark-bridge: quoted message ${parentId} unreadable: ${error instanceof Error ? error.message : String(error)}`);
                        return undefined;
                    }
                });
                const quoted = quote?.prefix ?? '';
                // …and the images belong to whichever message actually holds them.
                const quotedHasImages = quote?.message?.resources?.some(resource => resource.type === 'image') === true;
                const imageSource = quotedHasImages && quote?.message !== undefined ? quote.message.messageId : msg.messageId;
                // 图片必须等 `imageSource` 定下来再收：分享过来的图挂在被引用那条消息上。
                const images = await collectImages(msg, port, ctx.get('attachments'), config.attachImages, line => notify(`dsh-lark-bridge: ${line}`), imageSource);
                // Append file notes to the user's text so the agent knows what arrived.
                // (`chatUserMessage` folds `images.notes` into the text itself — adding
                // them here as well made every image note reach the model twice.)
                const allNotes = [...fileNotes];
                // 用户这条什么时候发的。模型拿到的是正文，看不到任何时间——判断「刚才
                // 那个是不是没成」时，它只能去翻进程启动时间和文件修改时间，而且经常
                // 翻错。行首给一个时间戳，比事后按日志倒推便宜得多。
                const sentAt = config.showMessageTime ? messageTimeStamp(msg.createTime) : undefined;
                // 「距上一轮多久」拼在发送时刻那一行里，不另起一行。模型需要的是间隔
                // 这个它推不出来的事实；绝对时刻上面已经有了，再说一遍只会让两行时间戳
                // 相差三秒，模型还得猜哪个才是「现在」。
                const gap = config.showMessageTime ? sessionGapPhrase(opened.handle.agent.session.id, Date.now()) : '';
                const stamped = sentAt === undefined
                    ? msg.content
                    : `${gap === '' ? `[${sentAt}]` : `[${sentAt} · 距上一轮 ${gap}]`}\n${msg.content}`;
                const spoken = [quoted, stamped, ...allNotes].filter(part => part !== '').join('\n');
                const turn = chatUserMessage({ ...msg, content: spoken }, images);
                let content = prefix === ''
                    ? turn.content
                    : Object.freeze([
                        { type: 'text', text: prefix },
                        ...turn.content,
                    ]);
                // `inject` only attaches to a live driver: a turn that closed while the
                // images or the briefing were being read would leave the note parked in
                // the inbox with nothing to wake it, so a message that is no longer
                // mid-turn becomes the ordinary follow-up it has now become. Steering
                // needs no such check — an idle driver starts a turn for it.
                const parkedInject = busyPlan.policy === 'inject' && opened.handle.agent.status !== 'running';
                if (parkedInject) {
                    notify(`dsh-lark-bridge: inject downgraded to followup for session ${opened.handle.agent.session.id} (turn closed before delivery)`);
                }
                const delivery = parkedInject ? 'queue' : busyPlan.policy;
                const message = { ...turn, content };
                if (delivery === 'steer')
                    opened.handle.agent.steer?.(message);
                else if (delivery === 'inject')
                    opened.handle.agent.inject?.(message);
                else
                    opened.handle.agent.followup(message);
            }
        }
        catch (error) {
            notify(`dsh-lark-bridge: agent creation failed for chat ${msg.chatId}: ${String(error)}`);
            ctx.logger.warn('agent creation failed for chat %s: %s', msg.chatId, error);
            // The chat only shows the message; the operator needs the stack. journald
            // carries no trace for this process, so persist it where it survives.
            const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
            try {
                appendFileSync('/tmp/dsh-session-crash.log', `[${new Date().toISOString()}] chat=${msg.chatId}\n${stack}\n\n`);
            }
            catch { /* diagnostics must never mask the original failure */ }
            await port
                .send(msg.chatId, { text: `⚠️ 无法启动会话：${error instanceof Error ? error.message : String(error)}` })
                .catch(reportSendFailure);
        }
    };
    const settleApproval = (id, outcome, decidedBy) => {
        const pending = pendingApprovals.get(id);
        if (pending === undefined)
            return false;
        pendingApprovals.delete(id);
        pending.clearReminder?.();
        pending.settle(outcome);
        void port
            .updateCard(pending.messageId, settledCard(pending.toolName, outcome, decidedBy))
            .catch(reportSendFailure);
        return true;
    };
    const askViaCard = async (binding, request, next) => {
        const id = randomUUID();
        let sent;
        try {
            const command = request.callId === undefined ? undefined : pendingCallArguments.get(request.callId);
            sent = await rawPort.send(binding.chatId, {
                card: approvalCard(request.toolName, request.reason, command === undefined ? undefined : boundCardText(command, config.limits.approvalArgChars), id),
            });
        }
        catch (error) {
            // With no card in front of a human, let the next composed answerer decide.
            reportSendFailure(error);
            return next();
        }
        return new Promise((resolveOutcome) => {
            // Nudge an unanswered card: the agent is parked on it, and a chat with
            // no visual "pending" surface otherwise looks like the bot stopped.
            let reminder;
            if (config.approvalReminderMs > 0) {
                reminder = setTimeout(() => {
                    if (!pendingApprovals.has(id))
                        return;
                    void port
                        .send(binding.chatId, {
                        markdown: `⏳ 有一张审批卡等你处理（\`${request.toolName}\`）——点卡片上的按钮继续，或发 \`/stop\` 取消当前操作。`,
                    })
                        .catch(reportSendFailure);
                }, config.approvalReminderMs);
            }
            // 重启后这张卡还能被点：先把「谁在等什么」落盘，答案再按新消息送回会话。
            restartStore.rememberApproval({
                id,
                chatId: binding.chatId,
                sessionId: binding.session.id,
                ...sent.messageId === undefined ? {} : { messageId: sent.messageId },
                title: request.toolName,
                askedAt: new Date().toISOString(),
            });
            pendingApprovals.set(id, {
                chatId: binding.chatId,
                chatType: binding.chatType,
                messageId: sent.messageId,
                toolName: request.toolName,
                ...reminder === undefined ? {} : { clearReminder: () => clearTimeout(reminder) },
                settle: resolveOutcome,
            });
            request.signal?.addEventListener('abort', () => { settleApproval(id, 'cancelled'); }, { once: true });
        });
    };
    /**
     * Drive a goal card's buttons: pause / resume / clear. The buttons carry the
     * session id, so a click from elsewhere is refused before touching the goal.
     */
    const handleGoalCardAction = (evt, value) => {
        const binding = bySession.get(value.sessionId);
        if (binding === undefined || binding.chatId !== evt.chatId) {
            return { toast: { type: 'info', content: '该目标卡已失效' } };
        }
        // Same authority as an approval click: whoever may drive this chat may
        // control its goal; anyone else gets a refusal, not a silent no-op.
        const clickRefusal = refuseApprovalClick(authorization, { operatorId: evt.operator.openId, chatId: evt.chatId }, { chatId: binding.chatId, chatType: binding.chatType });
        if (clickRefusal !== undefined) {
            notify(`dsh-lark-bridge: rejected a goal click: ${clickRefusal}`);
            return { toast: { type: 'error', content: '你无权操作此目标' } };
        }
        const agent = agents.get(value.sessionId);
        if (agent === undefined) {
            return { toast: { type: 'info', content: '该会话当前不在线' } };
        }
        const goals = ctx.goals;
        if (goals === undefined) {
            return { toast: { type: 'error', content: '目标服务不可用' } };
        }
        const view = goals.get(agent);
        if (view === undefined) {
            return { toast: { type: 'info', content: '当前没有目标' } };
        }
        const ref = { id: view.id, revision: view.revision };
        try {
            const labels = {
                pause: '已暂停',
                resume: '已继续',
                clear: '已清除',
            };
            if (value.operation === 'pause')
                goals.pause(agent, ref);
            else if (value.operation === 'resume')
                goals.resume(agent, ref);
            else
                goals.clear(agent, ref);
            notify(`dsh-lark-bridge: goal ${value.operation} for session ${value.sessionId}`);
            return { toast: { type: 'success', content: labels[value.operation] } };
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            notify(`dsh-lark-bridge: goal ${value.operation} failed for session ${value.sessionId}: ${detail}`);
            return { toast: { type: 'error', content: `操作失败：${detail}` } };
        }
    };
    /**
     * The account-switcher card's buttons: fleet-single-writer (both ends
     * receive every click; only the arbitration-active endpoint acts), then
     * operator authorization, then the same switch/forget the text command
     * runs. The result lands as a toast plus a chat line — the stale card
     * stays behind, the line is the truth.
     */
    const handleAccountCardAction = async (evt, acct) => {
        const syncCtx = getSyncContext();
        if (syncCtx === undefined)
            return { toast: { type: 'error', content: '同步层未就绪，稍后再试' } };
        const arbitration = await arbitrationForInbound();
        if (arbitration !== null) {
            const identity = await ensureDeviceId();
            if (!isActiveEndpoint(arbitration, identity.deviceId, syncCtx.form, syncCtx.profile)) {
                return { toast: { type: 'info', content: '本端为待命端，已忽略（活跃端处理中）' } };
            }
        }
        const refusal = refuseMessage(authorization, {
            senderId: evt.operator.openId,
            chatId: evt.chatId,
            chatType: 'p2p',
        });
        if (refusal !== undefined) {
            notify(`dsh-lark-bridge: rejected an account-card click: ${refusal}`);
            return { toast: { type: 'error', content: '你无权切换账号' } };
        }
        const outcome = acct.act === 'use'
            ? await accountUseByName(syncCtx, acct.name)
            : await accountForgetByName(syncCtx, acct.name);
        void replay.send(evt.chatId, { markdown: outcome.text }).catch(reportSendFailure);
        return {
            toast: {
                type: outcome.ok ? 'success' : 'error',
                content: outcome.ok
                    ? (acct.act === 'use' ? `已切换到 ${acct.name}，重启后生效` : `已删除 ${acct.name}`)
                    : '没有这个账号，见聊天里的提示',
            },
        };
    };
    /**
     * Run one missed occurrence, on a human's button or on the watchdog's own
     * decision.
     *
     * The dispatch itself is the host's authority, so this goes the long way
     * round: it rebuilds the inbound message the schedule driver would have sent
     * and feeds it through the ordinary inbound path. That path carries the
     * authorization, device-state and arbitration checks — which is the point.
     * Faking a dispatch would skip them, and a task firing on a retired device is
     * exactly the duplicate the arbitration exists to prevent.
     *
     * The sender is who asked for the run: the clicking human, or the first
     * allowlisted sender when the watchdog decided on its own. Either way the run
     * is attributable and passes the allowlist on its own merits.
     * @param key - occurrence key: task id plus the scheduled instant.
     * @param sessionId - the session the task is bound to.
     * @param chatId - where the outcome is reported.
     * @param senderId - open id the turn is attributed to.
     * @returns whether a turn was actually started.
     */
    /**
     * 把「重启后才提交的答案/审批」当成一条新消息送回同一个会话。
     *
     * 走普通入站路径：授权、设备退位、云端仲裁一个都不跳过——绕过它们伪造一次
     * 执行，才是真正会出重复的写法。
     * @param entry - 落盘的待回答条目（聊天与会话）。
     * @param text - 用户这次给出的答复，已经是人话。
     * @param senderId - 点按钮的人，作为这条消息的发起人。
     */
    async function replayRestartAnswer(entry, text, senderId) {
        const msg = {
            messageId: `restored-${Date.now()}`,
            chatId: chatOfSession(entry.sessionId) ?? entry.chatId,
            chatType: 'p2p',
            senderId,
            senderType: 'user',
            senderIsBot: false,
            content: text,
            rawContentType: 'text',
            resources: [],
            mentions: [],
            mentionAll: false,
            mentionedBot: true,
            createTime: Date.now(),
        };
        try {
            await handleMessage(msg);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            notify(`dsh-lark-bridge: replaying a restored answer failed: ${detail}`);
            ctx.logger.warn('restored answer replay failed: %s', detail);
        }
    }
    async function dispatchOverdue(key, sessionId, chatId, senderId) {
        const taskId = key.split('@')[0];
        let prompt;
        try {
            const table = JSON.parse(await readFile(scheduleTableFile(), 'utf8'));
            prompt = table.tables?.tasks?.[taskId ?? '']?.record?.prompt;
        }
        catch {
            // Fall through to the refusal below: a task whose prompt cannot be read
            // is not something to invent a turn for.
        }
        if (prompt === undefined || prompt.trim() === '') {
            await replay.send(chatId, { markdown: '⚠️ 这条定时任务的定义已经读不到了，没法补跑。' }).catch(reportSendFailure);
            return false;
        }
        const msg = {
            messageId: `overdue-${Date.now()}`,
            chatId: chatOfSession(sessionId) ?? chatId,
            chatType: 'p2p',
            senderId,
            senderType: 'user',
            senderIsBot: false,
            content: prompt,
            rawContentType: 'text',
            resources: [],
            mentions: [],
            mentionAll: false,
            mentionedBot: true,
            createTime: Date.now(),
        };
        try {
            await handleMessage(msg);
            return true;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            notify(`dsh-lark-bridge: overdue schedule run failed for ${taskId}: ${detail}`);
            ctx.logger.warn('overdue schedule run failed: %s', detail);
            return false;
        }
    }
    /**
     * One managed card entity per chat, with strictly increasing sequences.
     * Kept in `panel.ts` so the create-vs-update decision is unit-testable.
     */
    const consoleCards = createConsoleCardStore();
    /**
     * The message each chat's console card currently lives in.
     *
     * A replacement is only invisible when the previous message is taken down
     * with it, so this map decides what to recall after the new card is sent.
     */
    const consoleMessages = new Map();
    // 重启前那张控制台卡还在聊天里：认回它的 id，下一次 /console 才能「发新卡 + 撤回旧卡」，
    // 而不是在聊天里堆第二张。
    for (const card of restoredState.cards) {
        if (card.kind === 'console')
            consoleMessages.set(card.chatId, card.messageId);
    }
    /**
     * Put the console in front of a chat.
     *
     * **Always a new message.** The card is a managed CardKit 2.0 entity, so
     * `createCard` + `send({cardId})` is the only sequence that is guaranteed to
     * appear: `updateCardById` re-renders that entity in place and emits no new
     * message, which from the chat side is indistinguishable from a bridge that
     * ignored the command. That is exactly how `/console` looked dead — the log
     * shows `console card updated in place (seq 5/6/7)` for three consecutive
     * commands while the operator's screen never changed.
     *
     * The previous console message is recalled after the new one lands, so the
     * chat keeps one live card instead of a column of them. Recall is
     * best-effort: a refusal must never turn a command that worked into an error.
     * @param chatId - the chat it belongs to.
     * @param sessionId - the session its controls act on.
     */
    async function openConsole(chatId, sessionId) {
        const card = panelCard(await consoleView(sessionId, chatId));
        // A failure here used to propagate into the caller's `catch`, which turned
        // it into "命令执行失败" or into nothing at all — and the operator saw an
        // empty chat and had no way to tell a refused card from a hung bridge.
        // Every step now names itself, so the report says WHICH call the platform
        // rejected and with what code.
        let cardId;
        try {
            cardId = (await replay.createCard(card)).cardId;
        }
        catch (first) {
            // cardkit 是 bey 消息通道之外的又一步 HTTP 调用，最常失败的是瞬时网络
            // 抖动（2026-11-10 17:06 现场：先是整串 connect ETIMEDOUT，网络恢复后
            // 又报 `returned no card_id`——请求发出去了，响应没带回来）。这种失败
            // 隔一下重发就成，不值得直接把它判成「控制台不可用」。
            notify(`dsh-lark-bridge: cardkit create failed for ${chatId}, retrying once: ${describeError(first)}`);
            await new Promise(resolve => { setTimeout(resolve, 600); });
            try {
                cardId = (await replay.createCard(card)).cardId;
            }
            catch (error) {
                await reportConsoleFailure(chatId, sessionId, `cardkit.v1.card.create 失败：${describeError(error)}`);
                return;
            }
        }
        notify(`dsh-lark-bridge: console card entity created for ${chatId} (${cardId})`);
        const previous = consoleMessages.get(chatId);
        try {
            const sent = await replay.send(chatId, { cardId });
            consoleCards.created(chatId, cardId);
            const messageId = sent.messageId;
            // A queued send answers with a placeholder (`queued:N`), NOT a message id.
            // Storing it means the next `/console` recalls a message that never
            // existed and Feishu answers `99992354 … Invalid ids: [queued:1]` — which
            // is exactly what happened the first time this ran on a dropped socket.
            // Wait for the real id instead: `whenDelivered` repairs it on flush.
            if (messageId !== undefined && messageId !== '' && !isUndeliveredId(messageId)) {
                consoleMessages.set(chatId, messageId);
            }
            else {
                consoleMessages.delete(chatId);
                if (messageId !== undefined && isUndeliveredId(messageId)) {
                    replay.whenDelivered(messageId, realId => { consoleMessages.set(chatId, realId); });
                }
            }
            notify(`dsh-lark-bridge: console card sent for ${chatId} (${messageId ?? 'no id'})`);
        }
        catch (error) {
            // The entity exists but no message references it. Leaving it out of the
            // store is right: the next `/console` must create a fresh entity that its
            // own message actually points at.
            await reportConsoleFailure(chatId, sessionId, `im.v1.messages 发送失败：${describeError(error)}`);
            return;
        }
        // Only now: a recall before the replacement lands would leave the chat with
        // no console at all if the send had failed.
        const recall = port.recallMessage;
        if (previous !== undefined
            && !isUndeliveredId(previous)
            && previous !== consoleMessages.get(chatId)
            && recall !== undefined) {
            try {
                await recall.call(port, previous);
                notify(`dsh-lark-bridge: recalled previous console message ${previous}`);
            }
            catch (error) {
                // A message older than the recall window, or one already deleted, is
                // ordinary history rather than a fault: say so and keep the new card.
                notify(`dsh-lark-bridge: could not recall previous console message ${previous}: ${describeError(error)}`);
            }
        }
    }
    /**
     * Tell the chat a console card failed, in a way that survives whatever broke.
     *
     * **Plain text only.** The failed step may well be cardkit itself, and a
     * `schema: "2.0"` card pushed through `im.v1.messages` is downgraded to its
     * fallback text by the platform (the mistake AGENTS.md records) — so a
     * "diagnostic card" here would be the one thing guaranteed not to render.
     * The text carries the same four facts and always goes out.
     * @param chatId - the chat that asked.
     * @param sessionId - the session whose state was being rendered.
     * @param detail - what failed, with the platform's message.
     */
    async function reportConsoleFailure(chatId, sessionId, detail) {
        notify(`dsh-lark-bridge: console failed for ${chatId}: ${detail}`);
        ctx.logger.warn('console failed for chat %s: %s', chatId, detail);
        await port
            .send(chatId, { text: `⚠️ 控制台打不开：${detail}\n\n会话 \`${sessionId}\`\n再发一次 \`/console\` 可重试。` })
            .catch(reportSendFailure);
    }
    /**
     * Read the state one console rendering needs.
     *
     * Every field is read fresh rather than cached, because the whole point of
     * pressing a control is to see the world after the change.
     * @param sessionId - the session the card acts on.
     * @param chatId - the chat, whose `/ws use` binding decides the working dir.
     * @returns the view to render.
     */
    const consoleView = async (sessionId, chatId) => {
        const defaults = ctx.get('agentDefaultModel');
        const selection = defaults?.currentSelection();
        // A per-session override wins: it is what the next request will actually
        // send, while the deployment default only decides sessions not yet opened.
        const liveSession = agents.get(sessionId)?.session;
        const override = liveSession === undefined ? undefined : effortOverrides.get(liveSession.id);
        const currentModel = override?.provider !== undefined && override.model !== undefined
            ? `${override.provider}/${override.model}`
            : selection === undefined
                ? '未配置'
                : `${selection.provider}/${selection.model}`;
        const models = await discoverModels(ctx.get('llm'));
        const registry = ctx.get('workspaceRegistry');
        const workspaces = (registry?.list?.() ?? []).map(entry => entry.path);
        const session = agents.get(sessionId)?.session;
        const breakdown = session === undefined ? undefined : readContextBreakdown(ctx, session);
        const used = breakdown === undefined
            ? undefined
            : breakdown.messageTokens + breakdown.systemTokens + breakdown.toolsTokens;
        const window = session === undefined ? undefined : readContextWindow(ctx, session);
        return {
            sessionId,
            currentModel,
            models,
            // Two different facts, kept apart:
            //   · `currentWorkspace` — where THIS session runs RIGHT NOW. Read from
            //     the host's working-directory owner, because a mid-conversation
            //     `/ws use` moves it and `session.meta.cwd` (the original project)
            //     would then be a stale answer.
            //   · `boundWorkspace`   — where the NEXT `/new` starts (the chat's binding).
            // Showing only the binding made the card claim the session had moved;
            // showing only the session hid what the pick had just done.
            currentWorkspace: workingDirectoryOf(session) ?? session?.meta?.cwd ?? await chatCwd(chatId),
            boundWorkspace: await chatCwd(chatId),
            // 宿主没组合 workingDirectory 时，切换只能等下一个会话，卡片要如实说。
            canSwitchLive: workingDirectory() !== undefined,
            workspaces,
            ...used === undefined ? {} : { contextUsed: used },
            ...window === undefined ? {} : { contextWindow: window },
        };
    };
    /**
     * The session one chat currently talks to, or undefined when it has none.
     *
     * This is the session the console card describes, and the id its redraw has
     * to be bounded to: an unrouted redraw (empty id) renders a card about no
     * session at all.
     * @param chatId - the chat to look up.
     * @returns the session id, or undefined.
     */
    const chatSessionId = (chatId) => [...bySession.values()].find(binding => binding.chatId === chatId)?.session.id;
    /**
     * Redraw this chat's console after an interaction.
     *
     * The front half of {@link handlePanelAction} was broken out so the workspace
     * branch can end in the SAME redraw every other branch gets. It used to
     * `return` a toast from inside that branch instead, so a workspace pick wrote
     * the binding and then left the card untouched — the operator's description
     * was exact: "改完工作区，卡片不会自动更新，要手动点一下刷新". The toast said
     * the click landed, the card said nothing happened, and the two disagreed.
     *
     * Failures are reported, never thrown: the caller has already answered the
     * click, and a redraw problem must not turn into. A chat with no session at
     * all gets an explicit line rather than a card about nothing.
     * @param chatId - the chat whose card is being redrawn.
     */
    async function redrawConsole(chatId) {
        const sessionId = chatSessionId(chatId);
        if (sessionId === undefined) {
            notify(`dsh-lark-bridge: console redraw skipped for ${chatId}: no session`);
            await port
                .send(chatId, { text: '这个聊天还没有会话，先发一条消息或 `/new`，再 `/console`。' })
                .catch(reportSendFailure);
            return;
        }
        try {
            // A new card, not an in-place rewrite: see `openConsole` for why the
            // latter silently does nothing on this platform.
            await openConsole(chatId, sessionId);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            notify(`dsh-lark-bridge: console redraw failed: ${detail}`);
        }
    }
    /**
     * Apply one console interaction, then redraw the card.
     *
     * The redraw is unconditional: a switch that succeeded and one that silently
     * did nothing must not look identical, and the only way to tell them apart is
     * to show the state the bridge now believes.
     * @param evt - the card action.
     * @param action - what the control asked for.
     * @returns the toast to show the clicker.
     */
    const handlePanelAction = async (evt, action) => {
        // Resolved fresh after every effect: a branch may create a session
        // (`new-session`), and the redraw must describe the one that exists now.
        const defaults = ctx.get('agentDefaultModel');
        // Routing lives in `resolvePanelAction` so it can be tested without a host;
        // this function only performs what was decided.
        // 诊断一行：这一次点击到底带了什么。卡片回调的字段名在 1.0 / 2.0 之间不同，
        // 「点了没反应」既可能是没拿到值、也可能存了但读回旧值，只有把三个都打出来
        // 才能一次分清。跑通后可以降级成 debug。
        notify(`dsh-lark-bridge: panel ${action.section}/${action.op} option=${evt.action.option ?? '∅'} formValue=${JSON.stringify(evt.action.formValue ?? null)} picked=${panelSubmitted(evt.action) ?? '∅'}`);
        // 按钮自带 value，下拉才需要从 formValue / option 里找。按钮这条路在 1.0 和
        // 2.0 上都成立，所以优先用它。
        const effect = resolvePanelAction(action, action.value ?? panelSubmitted(evt.action));
        if (effect.kind === 'invalid') {
            return { toast: { type: 'warning', content: effect.reason } };
        }
        // 新建会话：`/new` 是宿主命令，桥进入命令执行的唯一入口是一条入站消息，
        // 所以这里重放一条——参数装配、授权、设备检查全部照旧。
        if (effect.kind === 'new-session') {
            try {
                await handleMessage({
                    messageId: `panel-new-${Date.now()}`,
                    chatId: evt.chatId,
                    chatType: 'p2p',
                    senderId: evt.operator.openId,
                    senderType: 'user',
                    senderIsBot: false,
                    content: '/new',
                    rawContentType: 'text',
                    resources: [],
                    mentions: [],
                    mentionAll: false,
                    mentionedBot: true,
                    createTime: Date.now(),
                });
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return { toast: { type: 'error', content: `新建失败：${detail}` } };
            }
            // 新会话换了 id，卡片必须跟着换——否则下一次点会打到已经结束的旧会话。
            const fresh = chatSessionId(evt.chatId);
            if (fresh !== undefined)
                await openConsole(evt.chatId, fresh).catch(reportSendFailure);
            return { toast: { type: 'success', content: '已新建会话' } };
        }
        // 每次现取：`new-session` 那一支会换掉会话，上面已经自己收尾并返回了；
        // 走到这里的分支操作的都是当前这个会话。
        const sessionId = chatSessionId(evt.chatId) ?? '';
        if (effect.kind === 'set-model') {
            // Switch the running session FIRST, through the request-side override.
            // `saveSelection` alone cannot do it: a deployment that pins
            // `agent-default-model` in a home patch refuses every runtime write
            // ("Configuration … is overridden by a home patch or command-line
            // overlay"), so saving only ever changes the NEXT session — which is why
            // the card used to look like it ignored the pick.
            const liveSession = agents.get(sessionId)?.session;
            if (liveSession !== undefined) {
                // The old route's effort does NOT carry over: another model has another
                // set of levels, and shipping `max` to a route without one fails the
                // whole turn with UNSUPPORTED_REASONING_EFFORT. A switch means "run as
                // this model defaults"; `/think` is where a level is chosen.
                effortOverrides.set(liveSession, { provider: effect.provider, model: effect.model });
                notify(`dsh-lark-bridge: model -> ${effect.provider}/${effect.model} for ${liveSession.id}`);
            }
            // Then try to make it the default too. A refusal here is expected on a
            // pinned deployment and must not fail the switch the session already got.
            if (defaults?.saveSelection !== undefined) {
                try {
                    await defaults.saveSelection({
                        ...defaults.currentSelection(),
                        provider: effect.provider,
                        model: effect.model,
                    });
                    notify(`dsh-lark-bridge: model default saved as ${effect.provider}/${effect.model}`);
                }
                catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    notify(`dsh-lark-bridge: model default not saved (session already switched): ${detail}`);
                }
            }
        }
        else if (effect.kind === 'set-workspace') {
            // 面板的「切换工作区」和 `/ws use` 做同一件事：写聊天级绑定（决定下一次
            // `/new` 落哪），并且把**当前活会话**切过去。只写绑定、要求用户再发
            // `/new` 是旧行为——它源于「宿主挪不动运行中的会话」这个错误判断。
            const target = resolve(effect.path);
            let isDirectory = false;
            try {
                isDirectory = statSync(target).isDirectory();
            }
            catch { /* missing or denied */ }
            if (!isDirectory) {
                return { toast: { type: 'error', content: `目录不存在或不是目录：${target}` } };
            }
            try {
                await bindChatCwd(evt.chatId, target);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return { toast: { type: 'error', content: `写入工作区绑定失败：${detail}` } };
            }
            const liveAgent = agents.get(chatSessionId(evt.chatId) ?? '');
            const moved = liveAgent === undefined ? undefined : await switchLiveDirectory(liveAgent, target);
            notify(`dsh-lark-bridge: workspace for ${evt.chatId} -> ${target} (live switch ${moved === undefined ? 'deferred to /new' : 'applied'})`);
            // 不在这里 return：上一版就是直接 return 一个 toast，于是「点了绑定，卡片一动不动」，
            // 只能靠人手点刷新——用户看到的正是这个。和其他分支一样走下去，重绘完再给 toast。
        }
        await redrawConsole(evt.chatId);
        // toast 说清哪一层真的动了：会话当场切过去了，还是只能等 `/new`。
        const confirmed = effect.kind === 'set-workspace'
            ? (workingDirectory() === undefined ? '已绑定，发 /new 生效' : '已切换，本会话立即生效')
            : '已更新';
        return { toast: { type: 'success', content: confirmed } };
    };
    const handleCardAction = (evt) => {
        const questionResponse = questions.handleCardAction(evt);
        if (questionResponse !== undefined)
            return questionResponse;
        const overdue = overdueActionValue(evt.action.value);
        if (overdue !== undefined) {
            void dispatchOverdue(overdue.key, overdue.sessionId, evt.chatId, evt.operator.openId);
            return { toast: { type: 'info', content: '正在执行…' } };
        }
        // A 2.0 form submit reports the button's `name` and its fields under
        // `formValue`; it does NOT echo the button's `value`. Plain buttons still
        // carry theirs in `action.value`, so both paths are tried.
        const panelAction = panelActionValue(evt.action.value) ?? panelSubmitAction(evt.action.name);
        if (panelAction !== undefined) {
            // The effect runs asynchronously (it may write settings or replay a
            // `/new`), but the click must still get an immediate answer: a card that
            // reacts to nothing reads as a broken bridge. The redraw that follows is
            // the real confirmation.
            void handlePanelAction(evt, panelAction);
            return { toast: { type: 'info', content: '正在应用…' } };
        }
        const acct = accountCardValue(evt.action.value);
        if (acct !== undefined) {
            void handleAccountCardAction(evt, acct);
            return { toast: { type: 'info', content: '正在处理…' } };
        }
        const goalValue = goalActionValue(evt.action.value);
        if (goalValue !== undefined) {
            return handleGoalCardAction(evt, goalValue);
        }
        const value = approvalActionValue(evt.action.value);
        if (value === undefined)
            return undefined;
        const pending = pendingApprovals.get(value.id);
        if (pending === undefined)
            return { toast: { type: 'info', content: '该审批已失效' } };
        // Anyone who can see the card can press its button — a group may hold
        // people who are not authorized to run anything here, and one press grants
        // the escalation. The decision counts only from an authorized human, in
        // the chat this card was published to.
        const clickRefusal = refuseApprovalClick(authorization, { operatorId: evt.operator.openId, chatId: evt.chatId }, pending);
        if (clickRefusal !== undefined) {
            notify(`dsh-lark-bridge: rejected an approval click: ${clickRefusal}`);
            return { toast: { type: 'error', content: '你无权批准此操作' } };
        }
        const outcome = value.decision === 'allow' ? 'allowed-once' : 'rejected';
        const decidedBy = evt.operator.name ?? evt.operator.openId;
        if (!settleApproval(value.id, outcome, decidedBy)) {
            return { toast: { type: 'info', content: '该审批已失效' } };
        }
        return {
            toast: {
                type: value.decision === 'allow' ? 'success' : 'info',
                content: value.decision === 'allow' ? '已允许执行一次' : '已拒绝',
            },
        };
    };
    // Inbound events. Registered before connect so no early event is dropped.
    // A rejected handler must not vanish: the message is acknowledged with a
    // reaction before any of the work starts, so an unobserved rejection (or a
    // handler parked on a call with no deadline) reads to the human as "the bot
    // saw me, then did nothing" and leaves no trace to diagnose. Report it and
    // settle the reaction as a failure so the ack is not the last thing it shows.
    ctx.effect(() => replay.on('message', (msg) => {
        void handleMessage(msg).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            notify(`dsh-lark-bridge: inbound handler failed for ${msg.messageId}: ${detail}`);
            ctx.logger.warn('inbound handler failed for %s: %s', msg.messageId, error);
            void reactions?.fail(msg.messageId);
        });
    }), 'dsh-lark-bridge:on(message)');
    ctx.effect(() => replay.on('cardAction', handleCardAction), 'dsh-lark-bridge:on(cardAction)');
    // Observability. Without these, the failure modes an operator actually hits —
    // "the bot ignored me", "an inbound handler threw", "the connection dropped" —
    // leave no trace at all, because the transport reports each only as an event.
    ctx.effect(() => replay.on('reject', (evt) => {
        // A missing mention in a group is the configured steady state, not an
        // incident, so it stays off the operator console it would flood.
        if (evt.reason === 'no_mention') {
            ctx.logger.debug('rejected %s in %s: %s', evt.messageId, evt.chatId, evt.reason);
            return;
        }
        ctx.logger.info('rejected %s in %s from %s: %s', evt.messageId, evt.chatId, evt.senderId, evt.reason);
        // A tripped loop guard means the bot went quiet on purpose; an operator who
        // does not know that reads it as a hang.
        if (evt.reason === 'bot_loop') {
            notify(`dsh-lark-bridge: bot loop guard tripped in chat ${evt.chatId} — traffic from bots is being refused`);
        }
    }), 'dsh-lark-bridge:on(reject)');
    ctx.effect(() => replay.on('error', (error) => {
        notify(`dsh-lark-bridge: transport error [${error.code}]: ${error.message}`);
        ctx.logger.warn('transport error [%s]: %s', error.code, error.message);
    }), 'dsh-lark-bridge:on(error)');
    // A gap in the long connection is a gap in delivery: the transport has no
    // replay and no cursor, so events arriving while it is down are simply lost.
    let disconnectedAt;
    ctx.effect(() => replay.on('reconnecting', () => {
        replay.setConnected(false);
        disconnectedAt ??= Date.now();
        notify('dsh-lark-bridge: connection lost, reconnecting — outbound is queued and will replay once restored');
        ctx.logger.warn('connection lost, reconnecting');
    }), 'dsh-lark-bridge:on(reconnecting)');
    /**
     * 重连后核实断线窗口里是否真有用户消息丢失，再决定说不说。
     *
     * 传输层没有游标，断线期间的事件在到达桥之前就没了；但消息本身还在飞书
     * 服务器上。原来一断线就发一条"可能丢了消息"的提示，对已经自己察觉到
     * 断线的用户就是噪音（2026-11-04 运营方质疑）。现在先按窗口拉一次历史，
     * 只有真的存在 user 消息才点名告诉对方丢了 N 条；窗口里没有消息就静默。
     * 拉不到（无凭证/无权限/网络）才退回通用提示，保证不漏报。
     */
    const reportGap = async (chats, gapStartMs, gapEndMs, gapMs) => {
        const gapLabel = gapMs < 120_000
            ? `${Math.round(gapMs / 1000)} 秒`
            : `${Math.round(gapMs / 60_000)} 分钟`;
        const fallback = `⚠️ 连接中断了约 ${gapLabel}——期间发来的消息飞书不会补送，若有遗漏请重发。`;
        const send = (chatId, markdown) => {
            void replay.send(chatId, { markdown }).catch(reportSendFailure);
        };
        const credentials = config.appId !== undefined && config.appSecret !== undefined
            ? { appId: config.appId, appSecret: config.appSecret, ...(config.domain !== undefined ? { domain: config.domain } : {}) }
            : undefined;
        if (credentials === undefined) {
            for (const chatId of chats)
                send(chatId, fallback);
            return;
        }
        const cloud = new FeishuCloud(credentials, deps.fetchImpl);
        const counts = await Promise.allSettled(chats.map(async (chatId) => {
            const messages = await cloud.listMessages(chatId, gapStartMs, gapEndMs);
            return messages.filter(message => message.senderType === 'user').length;
        }));
        for (let index = 0; index < chats.length; index += 1) {
            const chatId = chats[index];
            const result = counts[index];
            if (result.status === 'rejected') {
                // 拉不到就按"可能丢了"处理：宁可多说一句，不可静默吞掉。
                ctx.logger.warn('gap history read failed for %s: %s', chatId, result.reason instanceof Error ? result.reason.message : String(result.reason));
                send(chatId, fallback);
                continue;
            }
            if (result.value === 0) {
                ctx.logger.debug('gap of %s lost no user message in %s', gapLabel, chatId);
                continue;
            }
            send(chatId, `⚠️ 刚才连接断了约 ${gapLabel}，这期间你有 ${result.value} 条消息没送到，请重发。`);
        }
    };
    ctx.effect(() => replay.on('reconnected', () => {
        replay.setConnected(true);
        notify('dsh-lark-bridge: connection restored');
        ctx.logger.info('connection restored');
        // Inbound events are not replayed across a gap (the transport has no
        // cursor), so a long one silently ate every message the chat sent. Read
        // the window back before speaking: a gap that lost nothing is not news
        // (2026-09-12 P140; 2026-11-04 operator report on the noise it caused).
        const gapStart = disconnectedAt;
        disconnectedAt = undefined;
        if (gapStart === undefined)
            return;
        if (config.gapNoticeMinMs <= 0)
            return;
        const gapEnd = Date.now();
        const gapMs = gapEnd - gapStart;
        if (gapMs < config.gapNoticeMinMs)
            return;
        const chats = [...new Set([...bySession.values()].map(binding => binding.chatId))];
        if (chats.length === 0)
            return;
        void reportGap(chats, gapStart, gapEnd, gapMs).catch(reportSendFailure);
    }), 'dsh-lark-bridge:on(reconnected)');
    // Boot-time panel floor: sync the channel-owned commands as soon as the
    // bridge installs, before any chat exists. Without this, a restart that
    // receives no message leaves the panel at the previous boot's list — and an
    // OLD process (one built before new channel commands existed) that does
    // receive a message would reconcile the panel DOWN to its own stale list,
    // deleting commands this channel actually accepts. The agent-scoped full
    // sync (hosted + channel) still runs on every acquire.
    //
    // The transport may not hold credentials yet at install time, so the first
    // attempt can fail before any notify fires; retry on a backoff until the
    // panel answers, then stop — this is a floor, not a poller.
    if (config.syncSlashCommands) {
        const floor = channelCommands(config.locale);
        void (async () => {
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                try {
                    const { added } = await syncSlashPanel(port, floor, notify);
                    if (added.length > 0)
                        notify(`dsh-lark-bridge: registered /${added.join(', /')} on the bot's slash panel`);
                    return;
                }
                catch {
                    if (attempt === 3)
                        return;
                    await new Promise(resolve => setTimeout(resolve, attempt * 15_000));
                }
            }
        })();
    }
    // Outbound: the owned chat's renderer decides what reaches the chat. The
    // bridge additionally remembers each call's arguments for the approval card,
    // and forgets the turn's calls once it closes.
    // Live workflow narration: phase and log events carry only the run identity,
    // so the durable tool-workflow/run-start event supplies the run->chat map.
    // Best-effort: lines arriving before the durable mapping exists are dropped.
    ctx.on('workflow/phase', (info, title) => {
        workflows.phase(info.id, title);
    });
    ctx.on('workflow/log', (info, message) => {
        const chatId = workflowChats.get(info.id);
        if (chatId === undefined)
            return;
        void replay.send(chatId, { markdown: workflowLogLine(message) }).catch(reportSendFailure);
    });
    /**
    * Host contract mirror: 0.1.5 delivers live assistant streaming through the
    * Agent-scoped `agent/assistant-stream` event. Older harnesses appended an
    * `assistant/chunk` session event instead, and 0.1.5 dropped that producer —
    * the type survives only in the session-format migrations, so a renderer
    * that waits for it renders no reasoning at all while the run looks healthy.
    *
    * The frame union carries `turn`/`step` on `start` and only the `chunk` on
    * each `chunk` frame, so the pair is tracked per attempt and folded back in
    * before handing the renderer the event shape it already consumes.
    */
    const attemptSteps = new Map();
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        const sessionId = agent.session.id;
        const binding = bySession.get(sessionId);
        if (binding === undefined)
            return;
        // Children publish their own attempts on the session they share with the
        // agent that spawned them, and their turn/step counters restart at 1. Left
        // unfiltered they render into the same chat as the parent's, so the reader
        // sees the reasoning of every subagent interleaved with the parent's and
        // the same step numbers over and over. Only the session's own agent owns
        // the chat's process display.
        const owner = agents.get(sessionId);
        if (owner !== undefined && owner !== agent) {
            // Child agent. Two rules, both learned the hard way:
            //   1. never render it into the parent's process display — unfiltered,
            //      every subagent's reasoning interleaved with the parent's and its
            //      turn/step counters restarted at 1, so the reader saw the same
            //      step numbers over and over (fix 80b6019);
            //   2. do not drop it either — route it to the multi-agent panel, keyed
            //      by the child's own session id, so the run stays visible without
            //      polluting the parent's answer.
            // (A child streams in its own session, so it never reaches this branch —
            // its content is narrated by `noteChildSessionEvent`.)
            return;
        }
        if (frame.type === 'end') {
            attemptSteps.delete(frame.attemptId);
            return;
        }
        if (frame.type === 'start') {
            attemptSteps.set(frame.attemptId, { turn: frame.turn, step: frame.step });
            return;
        }
        const at = attemptSteps.get(frame.attemptId) ?? { turn: 0, step: 0 };
        binding.renderer.handle({
            type: 'assistant/chunk',
            data: { turn: at.turn, step: at.step, chunk: frame.chunk },
        });
    });
    ctx.on('session/event', (session, event) => {
        const binding = bySession.get(session.id);
        if (binding === undefined) {
            // A child runs in its own session (see `childChat`), so its events never
            // match a bound session — narrate them into its panel row instead of
            // dropping them. This is what makes the panel live.
            const childOf = childChat.get(session.id);
            if (childOf !== undefined) {
                noteChildSessionEvent(childOf, session.id, event);
                return;
            }
            // 外勤会话镜像 (P141, 09-15 令：实时多agent实况)：既未绑定、也非
            // 子会话的独立会话（并行开发线/CLI 运行）→ 按会话节流（60s）推一行进度/
            // 完结到绑定聊天。聊天自身会话走下方渲染管线，互不重复。
            // A session that is neither this chat's nor a known child's still
            // declares deliverables. It belongs to no chat, so the files cannot be
            // placed — but the person who asked for them is looking at a chat, and
            // silence reads as "it worked". The files are announced to the chats
            // this bridge serves, so the reader can go and get them.
            //
            // 2026-11-04：这个分支原本向**所有**绑定群广播，和下面的外勤镜像同病。
            // 但它和进度播报性质不同：进度是噪声（「T1 进行中」不看也无所谓），交付
            // 文件是实体（「有个文件给你了」）。所以这里不关，只收敛——发给
            // externalMirrorChat() 选出的那一个群，而不是每个群都塞一份。
            if (isPresentedEvent(event) && config.presentBridge !== false) {
                const callId = event.data.callId;
                let seen = presentedCalls.get(session.id);
                if (seen === undefined) {
                    seen = new Set();
                    presentedCalls.set(session.id, seen);
                }
                if (!seen.has(callId)) {
                    seen.add(callId);
                    const watcher = externalMirrorChat();
                    if (watcher === undefined)
                        return;
                    for (const file of event.data.files) {
                        const caption = file.description === undefined || file.description === ''
                            ? `交付文件 · turn ${event.data.turn}`
                            : file.description;
                        void replay.send(watcher, {
                            markdown: `📎 另一个会话声明了交付文件：\`${file.path}\`${caption === '' ? '' : ` · ${caption}`}\n（该会话不是本群开的，文件没送到本群；路径可以直接打开）`,
                        }).catch(() => { });
                    }
                }
                return;
            }
            // 外勤会话镜像 (P141, 09-15 令：实时多agent实况)：既未绑定、也非
            // 子会话的独立会话（并行开发线/CLI 运行）→ 按会话节流推一行进度/完结。
            //
            // ⚠ 2026-11-04 修：这里原本遍历 `bySession.values()` 往**每一个**绑定群都发
            // 一份。当天现场：D:\Desktop 下有个子代理会话（父会话在网页端，桥收不到
            // `subagent/catalog`，所以没被认成子代理），于是每个群都收到一串
            // `⚙️ [会话 21ffe969] T1 进行中` —— 一个群都没派它，人人挨一发。
            //
            // 一个不属于任何群的会话，没有资格向所有群广播：群的数量随使用增长，
            // 广播成本是 O(群数)，而读者收到的全是看不懂的哈希和轮次号。现在只推
            // 给 externalMirrorChat() 选出的那一个群。
            const mirrorChat = externalMirrorChat();
            const notable = isStepStartEvent(event) || isTurnEndEvent(event);
            const nowMs = Date.now();
            const last = externalMirrorAt.get(session.id);
            if (mirrorChat !== undefined && notable && (last === undefined || nowMs - last >= 60_000)) {
                externalMirrorAt.set(session.id, nowMs);
                const turn = event.data.turn;
                // 轮次号是本桥的内部叫法，会话 id 前缀也认不出是哪个会话。用能读懂的
                // 句子；查不到标题就说「另一个会话」，不编造。
                const label = isTurnEndEvent(event) ? `第 ${turn ?? '?'} 轮完成` : `第 ${turn ?? '?'} 轮开始`;
                void replay.send(mirrorChat, { markdown: `⚙️ 另一个会话在跑（不是本群开的）：${label}` }).catch(() => { });
            }
            return;
        }
        // One answer, one bubble — no cross-surface relay here.
        //
        // A `🌐【web】` mirror used to re-post turns the bridge did not drive, on the
        // premise that they "never passed the Feishu pipeline". They already do: the
        // renderer below handles EVERY event of a bound session, whoever drove the
        // turn, so each external turn went out twice — the answer, and the same text
        // ~0.1s later behind that prefix (7 such pairs in one 150-message window of
        // production traffic). The mirror also carried a dead guard: it deleted the
        // driving flag at `turn/end` before reading it, so that check never failed.
        // Contract: tests/cross-surface-delivery.spec.ts.
        // 重启对账：一轮开始时记一笔、结束时销账。开机时还留着的条目，就是被重启
        // 打断的那一轮——没有它，聊天只会突然安静，没人知道是「做完了」还是「死了」。
        if (isStepStartEvent(event) && event.data.step === 1) {
            restartStore.startTurn({
                chatId: binding.chatId,
                sessionId: session.id,
                turn: event.data.turn,
                startedAt: new Date().toISOString(),
            });
        }
        if (isTurnEndEvent(event))
            restartStore.endTurn(binding.chatId);
        if (isTurnEndEvent(event)) {
            // Close out one-shot children spawned by this turn, so the panel does not
            // leave stale「进行中」rows behind. `continuable` children outlive the
            // turn by design and keep their own status.
            const panel = subagentTrackers.get(binding.chatId);
            if (panel !== undefined && subCard.settleRunningOneShots(panel) > 0) {
                void flushSubagentCard(binding.chatId, panel, true).catch(reportSendFailure);
            }
        }
        // Audit counters: one lightweight pass over the same stream the renderers
        // consume, so /audit needs no file access or extra host seam.
        {
            let stats = auditStats.get(session.id);
            if (stats === undefined) {
                stats = {
                    startedAt: Date.now(),
                    turns: 0, steps: 0, toolCalls: 0, turnErrors: 0,
                    compactions: 0, retries: 0, subagents: 0, workflows: 0, schedules: 0,
                };
                auditStats.set(session.id, stats);
            }
            if (isToolCallEvent(event))
                stats.toolCalls += 1;
            else if (isTurnEndEvent(event)) {
                stats.turns += 1;
                if (event.data.reason.kind === 'error')
                    stats.turnErrors += 1;
            }
            else if (isStepStartEvent(event))
                stats.steps += 1;
            else if (isCompactionStartEvent(event))
                stats.compactions += 1;
            else if (isLlmRetryEvent(event))
                stats.retries += 1;
            else if (isSubagentDescriptorEvent(event))
                stats.subagents += 1;
            else if (isWorkflowRunStartEvent(event))
                stats.workflows += 1;
            else if (isScheduleChangeEvent(event))
                stats.schedules += 1;
        }
        if (isAssistantMessageEvent(event)) {
            lastAssistantIds.set(session.id, event.data.message.id);
        }
        if (isToolCallEvent(event)) {
            pendingCallArguments.set(event.data.callId, event.data.arguments);
            // A `workflow` call is the FIRST real-time sign that a run is coming:
            // `tool-workflow/run-start` is durable and only lands with the tool
            // result. Opening the card here is what makes progress visible during a
            // long fan-out instead of only after it is over.
            if (event.data.name === WORKFLOW_TOOL_NAME) {
                workflows.opening(binding.chatId, workflowNameFromArguments(event.data.arguments));
            }
        }
        else if (isTurnEndEvent(event)) {
            pendingCallArguments.clear();
        }
        // A failed tool leaves no result payload to attribute; a `workflow` call
        // that failed never opened a run, so its "启动中" card has to settle here
        // or it sits there looking hung. `abandon` is a no-op when no opening card
        // is waiting, so this needs no per-tool filtering.
        if (isToolResultEvent(event) && event.data.error !== undefined) {
            workflows.abandon(binding.chatId);
        }
        // Reaction lifecycle: the agent started working once a step opens, and
        // settles when the turn ends. `currentMessageId` is undefined between
        // turns and for slash commands, which drive no agent turn at all.
        if (reactions !== undefined && binding.currentMessageId !== undefined) {
            if (isStepStartEvent(event))
                reactions.working(binding.currentMessageId);
            else if (isTurnEndEvent(event)) {
                if (event.data.reason.kind === 'error')
                    reactions.fail(binding.currentMessageId);
                else
                    reactions.done(binding.currentMessageId);
                binding.currentMessageId = undefined;
            }
        }
        // Live todo progress: every whole-list snapshot updates the chat card.
        if (isTodoWriteEvent(event)) {
            const items = event.data.todos.filter((item) => item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed');
            void todos.handle(session.id, binding.chatId, items);
        }
        // Live goal state: every snapshot mutation updates the chat card.
        if (isGoalChangeEvent(event)) {
            const goal = event.data.goal;
            if (goal !== undefined && (goal.phase === 'active' || goal.phase === 'paused' || goal.phase === 'blocked' || goal.phase === 'complete')) {
                void goals.handle(session.id, binding.chatId, {
                    operation: event.data.operation,
                    goal: { objective: goal.objective, phase: goal.phase, ...goal.blockedReason !== undefined ? { blockedReason: goal.blockedReason } : {}, ...goal.maxGoalRounds !== undefined ? { maxGoalRounds: goal.maxGoalRounds } : {} },
                });
            }
            // Keep the boot-time re-arm list in step with the goal. Only `active`
            // belongs on it: a goal the human paused, or one that blocked or finished,
            // must not come back to life because the bridge was deployed to.
            if (goal !== undefined && goal.phase === 'active') {
                goalWatch.remember({
                    sessionId: session.id,
                    chatId: binding.chatId,
                    chatType: binding.chatType,
                    ...goal.id === undefined ? {} : { goalId: goal.id },
                    ...goal.revision === undefined ? {} : { revision: goal.revision },
                    objective: goal.objective,
                });
            }
            else {
                goalWatch.forget(session.id);
            }
        }
        // Live workflow fan-out: a text stream per run, so the chat sees the
        // subagent fan-out instead of a silent gap. Best-effort, like todo/goal.
        if (isWorkflowRunStartEvent(event)) {
            workflowChats.set(event.data.runId, binding.chatId);
            workflows.runStart(event.data, binding.chatId);
        }
        else if (isWorkflowAgentStartEvent(event)) {
            workflows.agentStart(event.data);
        }
        else if (isWorkflowAgentEndEvent(event)) {
            workflows.agentEnd(event.data);
        }
        else if (isWorkflowRunEndEvent(event)) {
            workflowChats.delete(event.data.runId);
            workflows.runEnd(event.data);
        }
        // Context compaction: tell the chat when history is being summarized, so
        // a later "it forgot" is understood rather than mysterious. The summary
        // and prune events (between start and end) show what the pass produced.
        if (isCompactionStartEvent(event)) {
            void replay.send(binding.chatId, { markdown: '📦 上下文较长，正在压缩（较早内容将被摘要）…' }).catch(reportSendFailure);
        }
        else if (isCompactionSummaryEvent(event)) {
            void replay.send(binding.chatId, {
                markdown: compactionSummaryLine(event.data, classifyShadowed(session, event.data.shadowedSeqs), compactionUsage(session)),
            }).catch(reportSendFailure);
        }
        else if (isCompactionPruneEvent(event)) {
            void replay.send(binding.chatId, {
                markdown: compactionPruneLine(event.data, classifyShadowed(session, event.data.shadowedSeqs), compactionUsage(session)),
            }).catch(reportSendFailure);
        }
        else if (isCompactionEndEvent(event)) {
            if (event.data.error !== undefined) {
                void replay.send(binding.chatId, { markdown: `⚠️ 上下文压缩失败：${event.data.error}` }).catch(reportSendFailure);
            }
        }
        // One-shot notices for the remaining low-frequency events. `dispatch`
        // stays silent (a schedule firing is noise), retry announces once.
        if (isSubagentDescriptorEvent(event)) {
            // Multi-agent progress card: one updatable card per chat.
            //
            // This used to `replay.send` a fresh card on every descriptor — a second
            // panel next to the one `subagent/catalog` maintains, and one more per
            // delivery. The descriptor also arrives inside the CHILD's session in
            // 0.1.5, so this branch mostly fired for a card nobody could attribute.
            // Rows belong to the catalog path below; this only refreshes what is
            // already there.
            const tracker = subagentTrackers.get(binding.chatId);
            if (tracker !== undefined)
                void flushSubagentCard(binding.chatId, tracker, true).catch(reportSendFailure);
        }
        if (isSubagentCatalogEvent(event)) {
            // Durable child record on the PARENT session — the reachable event in
            // 0.1.5 (see the panel plumbing note above). Keyed by the child's own
            // session id, so its activity can be attributed later.
            // Register the child so its OWN session events can find this chat.
            childChat.set(event.data.childId, binding.chatId);
            // Say the delegation out loud. A child that is announced only in the
            // panel is invisible to a reader who is looking at the chat: the panel
            // is a card that must be found, and the chat is where the question was
            // asked. The label is the child's own description of its work, so the
            // line says what is being done rather than that something is.
            // A child dispatched while a workflow is running is one of that
            // workflow's members: the card already reports it, under the member
            // label, and announcing it here too is what made one delegation read as
            // two unrelated events. A standalone delegation still gets its line.
            if (config.announceSubagents !== false && !workflows.isActive(binding.chatId)) {
                const label = event.data.label === undefined || event.data.label.trim() === ''
                    ? '未命名任务'
                    : event.data.label.trim();
                void replay.send(binding.chatId, {
                    markdown: `🔀 派出子代理 · ${label}\n（进展会实时更新，完成后一并汇报）`,
                }).catch(reportSendFailure);
            }
            upsertSubagent(binding.chatId, event.data.childId, {
                mode: event.data.mode,
                ...event.data.label === undefined ? {} : { label: event.data.label },
            }, true);
        }
        // Team events (W-10a): the host records the members and the shared tasks
        // in the session that leads the team. One card per chat shows all of it,
        // updated in place. The two mailbox events are historical records the
        // host reads but never writes — live traffic arrives as relayed
        // messages, handled above.
        // A message a teammate relayed into this session. The team package does
        // not record a mailbox event for it: it steers the message into the
        // recipient's inbox, and it arrives as a `user/message` whose source
        // names the sender.
        if (isTeamRelayMessageEvent(event)) {
            noteTeamRelayMessage(binding.chatId, event);
        }
        if (isTeamMemberEvent(event) || isTeamTaskEvent(event) || isTeamMessageEvent(event) || isTeamMessageDeliveredEvent(event)) {
            const teamId = event.data.teamId;
            let tracker = teamTrackers.get(binding.chatId);
            if (tracker === undefined || tracker.state.teamId !== teamId) {
                tracker = { state: teamCard.createTeamState(teamId) };
                teamTrackers.set(binding.chatId, tracker);
            }
            if (isTeamMemberEvent(event))
                teamCard.addTeamMember(tracker.state, event.data.member);
            else if (isTeamTaskEvent(event))
                teamCard.addTeamTask(tracker.state, event.data.task);
            else if (isTeamMessageEvent(event))
                teamCard.addTeamMessage(tracker.state, event.data.message);
            else
                teamCard.markTeamMessageDelivered(tracker.state, event.data.messageId);
            void flushTeamCard(binding.chatId, true).catch(reportSendFailure);
        }
        if (isPresentedEvent(event)) {
            // The model declared files at the end of its turn. Deliver them to the
            // chat, once per declaration.
            //
            // The event fires once per declaration, but a host may replay it or
            // nest calls, so the call id is what makes the delivery exactly-once.
            // A session that already delivered this call is skipped.
            if (config.presentBridge !== false) {
                const callId = event.data.callId;
                let seen = presentedCalls.get(session.id);
                if (seen === undefined) {
                    seen = new Set();
                    presentedCalls.set(session.id, seen);
                }
                if (!seen.has(callId)) {
                    seen.add(callId);
                    // Deliveries are sequential: the chat reads them in the order the
                    // model declared them, and a second file waits for the first to
                    // settle rather than racing it.
                    void (async () => {
                        for (const file of event.data.files) {
                            const caption = file.description === undefined || file.description === ''
                                ? `交付文件 · turn ${event.data.turn}`
                                : file.description;
                            try {
                                await deliverDeclaredFile(session.id, file.path, caption);
                            }
                            catch (error) {
                                // A file that cannot be delivered is reported once, in the
                                // chat, and not retried: the retry belongs to the model,
                                // which can call the send tool again with a different path.
                                const detail = error instanceof Error ? error.message : String(error);
                                void replay.send(binding.chatId, {
                                    markdown: `⚠️ 交付文件 \`${file.path}\` 未能送达：${detail}`,
                                }).catch(reportSendFailure);
                            }
                        }
                    })();
                }
            }
        }
        if (isScheduleChangeEvent(event)) {
            // Keep /schedules in step with the live stream. A session whose log was
            // already replayed (seedScheduleRegistry) starts from that state; one
            // that was not yet starts from what this event says, and the replay
            // later re-applies it — applyScheduleChange is idempotent by design.
            const sessionId = session.id;
            const byId = scheduleRegistry.get(sessionId) ?? new Map();
            // Resolve the task BEFORE applying the change: a delete event carries no
            // record, so the name worth reporting is the one the registry still
            // holds, and a dispatch has to be attributed to a task the registry may
            // know better than the event does.
            const id = event.data.schedule?.id ?? event.data.id;
            const known = id === undefined ? undefined : byId.get(id);
            applyScheduleChange(byId, event.data);
            if (byId.size === 0)
                scheduleRegistry.delete(sessionId);
            else
                scheduleRegistry.set(sessionId, byId);
            const view = {
                ...known === undefined ? {} : {
                    title: known.title,
                    time: known.time,
                    timeZone: known.timeZone,
                    weekdays: known.weekdays,
                    expression: known.expression,
                    scheduledAt: known.scheduledAt,
                },
                ...event.data.schedule === undefined ? {} : {
                    kind: event.data.schedule.kind,
                    prompt: event.data.schedule.prompt,
                    ...event.data.schedule.title === undefined ? {} : { title: event.data.schedule.title },
                    ...event.data.schedule.everySeconds === undefined ? {} : { everySeconds: event.data.schedule.everySeconds },
                },
                ...known === undefined || event.data.schedule?.kind !== undefined ? {} : { kind: known.kind },
                ...known === undefined || event.data.schedule?.prompt !== undefined ? {} : { prompt: known.prompt },
            };
            if (event.data.operation === 'dispatch') {
                // 定时器触发时必须先说一声：宿主把任务内容当普通用户消息塞进会话，
                // 聊天里只看到一段没人署名的指令，读者分不清是人在派活还是定时器
                // 在跑——每半小时一次的任务尤其像人在反复催。一行说明就够了，
                // 任务自己的输出紧跟其后，卡片只会把它挤出屏幕。
                if (config.notifyOnScheduleDispatch) {
                    void replay.send(binding.chatId, { markdown: scheduleDispatchLine(view) }).catch(reportSendFailure);
                }
            }
            else {
                const line = scheduleLine({ operation: event.data.operation, ...view });
                if (line !== undefined)
                    void replay.send(binding.chatId, { markdown: line }).catch(reportSendFailure);
            }
        }
        if (isWebSearchRequestEvent(event)) {
            const nowMs = Date.now();
            const last = lastSearchNoticeAt.get(binding.chatId);
            if (last === undefined || nowMs - last >= 90_000) {
                lastSearchNoticeAt.set(binding.chatId, nowMs);
                void replay.send(binding.chatId, { markdown: webSearchLine() }).catch(reportSendFailure);
            }
        }
        if (isLlmRetryEvent(event)) {
            const line = retryLine(event.data);
            if (line !== undefined)
                void replay.send(binding.chatId, { markdown: line }).catch(reportSendFailure);
        }
        binding.renderer.handle(event);
    });
    // Approval questions for owned agents become cards; everything else delegates.
    //
    // PREPEND is load-bearing. A host answerer may claim every audited request
    // rather than only the sessions its own clients own — the Web app's BFF does
    // exactly that, pushing the question to browser clients and never calling
    // `next()`. Registered in arrival order this plugin would sit behind it (its
    // rows mount during tree load, this bridge installs after the loader
    // settles), so a chat-driven approval would surface in a browser nobody is
    // watching while the chat waits forever. Answering first is correct on the
    // merits too: the human who typed the request is in the chat, and this
    // listener still delegates every session it does not own.
    ctx.on('approval/request', (request, next) => {
        const binding = bySession.get(request.agent.session.id);
        if (binding === undefined)
            return next();
        return askViaCard(binding, request, next);
    }, { prepend: true });
    /**
     * Re-open the conversations we recorded as having an active goal, and re-arm
     * each of them.
     *
     * A goal's phase survives a restart, but its continuation authority does not:
     * the runtime leaves it `disarmed` until a human message arrives. For a
     * background job that message never comes, so the task sits stopped with
     * nobody watching — which is exactly what a deploy must not do to it.
     *
     * Two things have to happen for a re-armed goal to be useful, and both are
     * done here: the session has to be reopened (an agent is what holds the goal),
     * and the chat binding has to be rebuilt (a renderer is what its output goes
     * through). Re-arming without either would leave a goal running with nowhere
     * to report.
     */
    const resumeWatchedGoals = async () => {
        const watched = goalWatch.pending();
        if (watched.length === 0)
            return;
        notify(`dsh-lark-bridge: re-arming ${watched.length} active goal(s) after boot`);
        const service = ctx.goals;
        for (const entry of watched) {
            try {
                const handle = await ladder.resume(entry.sessionId);
                // Only `chatId` and `chatType` are read when a binding is built; the
                // rest of a normalised message belongs to inbound handling.
                const pseudo = { chatId: entry.chatId, chatType: entry.chatType };
                await bindingFor(entry.sessionId, pseudo, handle.agent.session);
                const view = service?.get(handle.agent);
                if (view?.phase === 'active' && view.activation === 'disarmed') {
                    await service?.resume(handle.agent, { id: view.id, revision: view.revision });
                    notify(`dsh-lark-bridge: re-armed goal ${view.id} for ${entry.chatId}`);
                    // Refresh the record so a goal that keeps running does not age out of
                    // the re-arm window while the bridge stays up.
                    goalWatch.remember({
                        sessionId: entry.sessionId,
                        chatId: entry.chatId,
                        chatType: entry.chatType,
                        goalId: view.id,
                        revision: view.revision,
                        objective: entry.objective,
                    });
                }
                else {
                    // Nothing left to resume (settled, paused, or already armed by the
                    // host). Drop it rather than retrying every boot.
                    goalWatch.forget(entry.sessionId);
                }
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                notify(`dsh-lark-bridge: goal re-arm failed for ${entry.sessionId}: ${detail}`);
                ctx.logger.warn('goal re-arm failed for %s: %s', entry.sessionId, detail);
            }
        }
    };
    if (config.resumeGoalsOnBoot && config.autoResumeGoals) {
        const delay = Math.max(0, config.resumeGoalsBootDelaySeconds) * 1_000;
        const timer = setTimeout(() => { void resumeWatchedGoals().catch(reportSendFailure); }, delay);
        timer.unref?.();
    }
    // 上一个进程留下的「在跑的轮次」= 被重启打断的那一轮。等传输起来后逐条说一声，
    // 然后销账：一条安静的聊天比一条说明更糟，人分不清是「做完了」还是「进程死了」。
    if (restoredState.turns.length > 0) {
        const delay = Math.max(0, config.resumeGoalsBootDelaySeconds) * 1_000;
        const timer = setTimeout(() => {
            // 流式卡写到一半断了：补一句落在同一聊天里，读者才知道那张卡不会再有下文。
            for (const card of restoredState.cards) {
                if (card.kind !== 'stream')
                    continue;
                void replay
                    .send(card.chatId, {
                    markdown: '⚠️ 上面那张正文卡写到一半就断了（进程重启），后面的内容不会再有——完整过程见会话记录。',
                })
                    .catch(reportSendFailure)
                    .finally(() => restartStore.forgetCard(card.chatId, 'stream'));
            }
            // 运行级卡片（团队 / 子代理 / 工作流）故意不接回来：那次运行已经被重启杀掉了。
            // 但也不能让它们看起来还在跑——每个聊天说一句，然后销账。
            const stoppedChats = new Set(restoredState.cards
                .filter(card => card.kind === 'team' || card.kind === 'subagent' || card.kind === 'workflow')
                .map(card => card.chatId));
            for (const chatId of stoppedChats) {
                void replay
                    .send(chatId, {
                    markdown: 'ℹ️ 上面那张进度卡停在重启那一刻（那次运行已经结束），后续进度会出现在新卡里。',
                })
                    .catch(reportSendFailure)
                    .finally(() => {
                    for (const kind of ['team', 'subagent', 'workflow'])
                        restartStore.forgetCard(chatId, kind);
                });
            }
            for (const turn of restoredState.turns) {
                void replay
                    .send(turn.chatId, {
                    markdown: `⚠️ 上一轮（第 ${turn.turn} 轮）在重启时被中断了，那一轮之后的输出不会再有。\n需要接着做，回一句「继续」就行；不需要就当它已经结束。`,
                })
                    .catch(reportSendFailure)
                    .finally(() => restartStore.endTurn(turn.chatId));
            }
        }, delay);
        timer.unref?.();
    }
    // Owned live state unwinds with the fiber: agents down, open questions
    // closed, open streaming cards settled. The session store owns the agents, so
    // it does the disposing — and it leaves an adopted one running for its owner.
    ctx.effect(() => () => {
        if (pressureTimer !== undefined)
            clearInterval(pressureTimer);
        for (const [id, pending] of [...pendingApprovals]) {
            pendingApprovals.delete(id);
            pending.settle('cancelled');
        }
        disposeQuestions?.();
        const bindings = [...bySession.values()];
        bySession.clear();
        compositions.clear();
        pendingCallArguments.clear();
        lastAssistantIds.clear();
        goals.dispose();
        todos.dispose();
        workflows.dispose();
        for (const binding of bindings) {
            if (binding.currentMessageId !== undefined)
                reactions?.forget(binding.currentMessageId);
        }
        return Promise.allSettled([
            sessions.close(),
            ...bindings.map((binding) => binding.renderer.close()),
        ]).then(() => undefined);
    }, 'dsh-lark-bridge:agents');
    // Registered last so disposal disconnects the transport first.
    ctx.effect(() => {
        replay.connect().catch((error) => {
            notify(`dsh-lark-bridge: connect failed: ${error instanceof Error ? error.message : String(error)}`);
            ctx.logger.error('dsh-lark-bridge channel connect failed: %s', error);
        });
        return () => replay.disconnect().catch(reportSendFailure).then(() => { replay.dispose(); });
    }, 'dsh-lark-bridge:connect');
}
//# sourceMappingURL=bridge.js.map