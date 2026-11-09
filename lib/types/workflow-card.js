/**
 * One workflow run as one live card, instead of a line per event.
 *
 * A fan-out is not a story: 68 members produce 136 start/end events plus a
 * phase and a closing line, and posting them as chat messages means the reader
 * scrolls past a wall of "chunk-N.txt 启动…" to find the one fact they wanted —
 * whether it is done, and what broke. Worse, the subagent channel was already
 * announcing the same members under a different label, so every delegation was
 * reported twice.
 *
 * So the chat gets ONE card per run, updated in place: the phase it is in, how
 * many members have started / finished / failed, and the names of the failures.
 * Updates are coalesced because a fan-out of eight settles inside a second and
 * a card rewritten eight times a second is rate-limited by Feishu and unreadable
 * anyway.
 *
 * The card deliberately keeps no member list. A reader does not scan 68 names;
 * they ask "is it done" and "what broke". Everything else is arithmetic.
 * @module dsh-lark-bridge/workflow-card
 */
/** `2m13s` / `45s` — a run's elapsed time, at the resolution a reader cares about. */
function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60)
        return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60}m`;
}
/** The header line and template, which say at a glance whether to worry. */
function headline(state) {
    const name = `工作流「${state.name}」`;
    if (state.ended === undefined)
        return { title: `🧩 ${name}`, template: 'blue' };
    switch (state.ended.reason) {
        case 'completed': return { title: `✅ ${name}完成`, template: 'green' };
        case 'cancelled': return { title: `⏹️ ${name}已取消`, template: 'grey' };
        case 'error': return { title: `⚠️ ${name}出错`, template: 'red' };
    }
}
/**
 * Render one run's card.
 *
 * Order is deliberate: the phase answers "where is it", the counters answer
 * "how far", and only then do the failures appear — a reader who sees a red
 * count immediately wants the names, and a run with no failures stays two lines.
 * @param state - the run as it currently stands.
 * @param maxNamedFailures - how many failing members to name.
 * @param now - the moment the card is drawn, for the elapsed time.
 * @returns a Feishu card object for `send({ card })` / `updateCard`.
 */
function workflowCard(state, maxNamedFailures, now) {
    const { title, template } = headline(state);
    const elements = [];
    if (state.phase !== undefined && state.phase !== '') {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**阶段** ${state.phase}` } });
    }
    const counts = [`启动 ${state.started}`];
    if (state.completed > 0)
        counts.push(`✅ ${state.completed}`);
    if (state.failed > 0)
        counts.push(`❌ ${state.failed}`);
    if (state.cancelled > 0)
        counts.push(`⏹️ ${state.cancelled}`);
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: counts.join(' · ') } });
    if (state.failedLabels.length > 0) {
        const named = state.failedLabels.slice(0, maxNamedFailures);
        const rest = state.failedLabels.length - named.length;
        const list = rest > 0 ? `${named.join('、')} 等 ${state.failedLabels.length} 个` : named.join('、');
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**失败** ${list}` } });
    }
    const elapsed = formatDuration((state.ended?.at ?? now) - state.beganAt);
    elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: state.ended === undefined ? `进行中 · 已用 ${elapsed}` : `用时 ${elapsed}` }],
    });
    return {
        config: { wide_screen_mode: true },
        header: { template, title: { tag: 'plain_text', content: title } },
        elements,
    };
}
/**
 * The card shown between "the model called `workflow`" and "the run opened".
 *
 * It exists because those two moments can be seconds or minutes apart: the
 * durable run-start lands with the tool result. Keeping it deliberately bare —
 * the name and a "starting" note — is the honest thing to show while nothing
 * has actually happened yet.
 * @param name - the run name read from the call arguments, or a fallback.
 * @returns a Feishu card object.
 */
function openingCard(name) {
    return {
        config: { wide_screen_mode: true },
        header: { template: 'blue', title: { tag: 'plain_text', content: `🧩 工作流「${name}」启动中` } },
        elements: [{
                tag: 'note',
                elements: [{ tag: 'plain_text', content: '正在准备子任务…' }],
            }],
    };
}
/**
 * The card shown when the tool call ended without a run ever opening.
 *
 * Grey rather than red: nothing ran, so there is nothing to be alarmed about —
 * but the reader who just watched a "启动中" card deserves to be told it will
 * not progress.
 * @param name - the run name read from the call arguments, or a fallback.
 * @returns a Feishu card object.
 */
function abandonedCard(name) {
    return {
        config: { wide_screen_mode: true },
        header: { template: 'grey', title: { tag: 'plain_text', content: `⏹️ 工作流「${name}」没有启动` } },
        elements: [{
                tag: 'note',
                elements: [{ tag: 'plain_text', content: '工具调用结束了，但没有收到工作流事件。' }],
            }],
    };
}
/**
 * Build the coalescing workflow card writer.
 * @param port - how to send and update the card.
 * @param options - coalesce window, failure-name budget, failure reporting.
 * @returns the card writer the bridge drives.
 */
export function createWorkflowCard(port, options = {}) {
    const coalesceMs = options.coalesceMs ?? 1_200;
    const maxNamedFailures = options.maxNamedFailures ?? 5;
    const onFailure = options.onFailure ?? (() => { });
    const runs = new Map();
    /** One card per chat: a second run reuses and overwrites the first one's card. */
    const cards = new Map();
    /** Chats whose `workflow` tool call opened a card the run has not claimed yet. */
    const openings = new Map();
    /** A run-start that never arrives must not leave an eternal "启动中" card. */
    const openingTimers = new Map();
    /** Pending coalesced write per run. */
    const timers = new Map();
    /** Serialises writes per chat so a slow update cannot land out of order. */
    const writing = new Map();
    /** A write that arrived while another was in flight. */
    const again = new Set();
    const clearTimer = (runId) => {
        const timer = timers.get(runId);
        if (timer === undefined)
            return;
        clearTimeout(timer);
        timers.delete(runId);
    };
    const clearOpening = (chatId) => {
        const timer = openingTimers.get(chatId);
        if (timer !== undefined) {
            clearTimeout(timer);
            openingTimers.delete(chatId);
        }
        openings.delete(chatId);
    };
    /**
     * Write one card, creating it the first time a chat is served.
     *
     * Writes are chained per chat because `send`/`updateCard` are independent
     * requests: without the chain a slow update can land AFTER the closing card
     * and resurrect a finished run as "进行中".
     */
    const writeCard = (chatId, runId, card, final) => {
        const previous = writing.get(chatId) ?? Promise.resolve();
        const next = previous.then(async () => {
            const slot = cards.get(chatId);
            if (slot === undefined) {
                const sent = await port.send(chatId, { card });
                cards.set(chatId, { messageId: sent.messageId, runId });
                return;
            }
            slot.runId = runId;
            if (port.updateCard === undefined)
                return;
            await port.updateCard(slot.messageId, card);
        }).catch((error) => {
            // A card that failed to write must not take the run down: the answer
            // still arrives, and the next event retries the write.
            onFailure(error);
            if (final)
                cards.delete(chatId);
        }).finally(() => {
            if (writing.get(chatId) === next)
                writing.delete(chatId);
        });
        writing.set(chatId, next);
    };
    const write = (runId, state, final) => {
        writeCard(state.chatId, runId, workflowCard(state, maxNamedFailures, Date.now()), final);
    };
    const schedule = (runId, state) => {
        if (timers.has(runId))
            return;
        const timer = setTimeout(() => {
            timers.delete(runId);
            if (again.has(state.chatId)) {
                again.delete(state.chatId);
            }
            write(runId, state, false);
        }, coalesceMs);
        timer.unref?.();
        timers.set(runId, timer);
    };
    return {
        opening(chatId, name) {
            // A run already on this chat owns the card; a second opening would
            // overwrite live progress with "starting".
            for (const state of runs.values())
                if (state.chatId === chatId)
                    return;
            openings.set(chatId, name);
            writeCard(chatId, '', openingCard(name), false);
            const previousTimer = openingTimers.get(chatId);
            if (previousTimer !== undefined)
                clearTimeout(previousTimer);
            const timer = setTimeout(() => {
                openingTimers.delete(chatId);
                if (openings.get(chatId) === undefined)
                    return;
                openings.delete(chatId);
                writeCard(chatId, '', abandonedCard(name), true);
            }, 90_000);
            timer.unref?.();
            openingTimers.set(chatId, timer);
        },
        runStart(run, chatId) {
            // A re-delivered run-start must not reset a run that is already counting.
            if (runs.has(run.runId))
                return;
            clearOpening(chatId);
            const state = {
                chatId,
                name: run.name,
                beganAt: Date.now(),
                started: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
                labels: new Map(),
                failedLabels: [],
            };
            runs.set(run.runId, state);
            // The opening card (if any) is rewritten in place by the same writeCard
            // path, so a run that started under a "启动中" card never leaves a
            // second card behind.
            write(run.runId, state, false);
        },
        phase(runId, title) {
            const state = runs.get(runId);
            if (state === undefined)
                return;
            state.phase = title;
            schedule(runId, state);
        },
        agentStart(agent) {
            const state = runs.get(agent.runId);
            if (state === undefined)
                return;
            state.started += 1;
            state.labels.set(agent.seq, agent.label);
            schedule(agent.runId, state);
        },
        agentEnd(agent) {
            const state = runs.get(agent.runId);
            if (state === undefined)
                return;
            if (agent.outcome === 'completed')
                state.completed += 1;
            else if (agent.outcome === 'failed') {
                state.failed += 1;
                const label = state.labels.get(agent.seq);
                state.failedLabels.push(label === undefined ? `#${agent.seq}` : label);
            }
            else
                state.cancelled += 1;
            schedule(agent.runId, state);
        },
        runEnd(run) {
            const state = runs.get(run.runId);
            if (state === undefined)
                return;
            clearTimer(run.runId);
            state.ended = { reason: run.stopReason, at: Date.now() };
            runs.delete(run.runId);
            write(run.runId, state, true);
        },
        abandon(chatId) {
            const name = openings.get(chatId);
            if (name === undefined)
                return;
            clearOpening(chatId);
            writeCard(chatId, '', abandonedCard(name), true);
        },
        isActive(chatId) {
            for (const state of runs.values()) {
                if (state.chatId === chatId)
                    return true;
            }
            return false;
        },
        dispose() {
            for (const timer of timers.values())
                clearTimeout(timer);
            for (const timer of openingTimers.values())
                clearTimeout(timer);
            timers.clear();
            openingTimers.clear();
            runs.clear();
            cards.clear();
            openings.clear();
            again.clear();
        },
    };
}
//# sourceMappingURL=workflow-card.js.map