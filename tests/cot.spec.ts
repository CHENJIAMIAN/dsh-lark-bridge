import { describe, expect, it, vi } from 'vitest'
import { COT_BANNER_PREFIX, cotBannerText, renderToolChange } from '../src/cot.ts'
import { fakeMessage, mountChannel } from './harness.ts'

/** Every event written to the first thinking process, in order. */
function events(harness: Awaited<ReturnType<typeof mountChannel>>) {
  return harness.fake.cots[0]?.events ?? []
}

/** The content of the first event of one type. */
function contentOf(harness: Awaited<ReturnType<typeof mountChannel>>, type: string) {
  return events(harness).find((e) => e.type === type)?.content
}

describe('thinking process (CoT)', () => {
  /** Bind one chat and return an emitter for its session events. */
  async function chat(harness: Awaited<ReturnType<typeof mountChannel>>) {
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  it('is the default output, opened per turn and aimed at the asking message', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })

    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    const cot = harness.fake.cots[0]!
    expect(cot.chatId).toBe('oc_chat_1')
    // The process belongs to the message that asked for it.
    expect(cot.replyTo).toBe('om_in_1')
    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_STARTED') })
    // A step is one iteration of the agent's loop; numbering it above the work
    // tells a reader nothing the reasoning and tool calls do not.
    expect(events(harness).map((e) => e.type)).not.toContain('STEP_STARTED')
    await harness.dispose()
  })

  it('streams reasoning into the thinking area, not the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先看目录' } })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '，再回答。' } })

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(2)
    })
    expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_START')
    // The first delta carries the block's clock time, because a reasoning
    // message has no title to put it in.
    expect(contentOf(harness, 'REASONING_MESSAGE_CONTENT')).toMatchObject({ delta: expect.stringMatching(/^〔\d{2}:\d{2}:\d{2}〕 先看目录$/) })
    // Reasoning never becomes a chat message.
    expect(harness.fake.sent).toHaveLength(0)
    await harness.dispose()
  })

  it('gives each reasoning block its own id, so a thought stays where it happened', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // One agentic step: think, run a tool, think again. The second thought
    // belongs AFTER the call — reusing one id for the whole turn made the
    // client treat it as an edit of the first block, so every thought piled up
    // at the top of the thinking area, away from the call it explains.
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先读日志' } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok', toolCallId: 'c1' }] },
    })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '日志里没写，换个地方' } })

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(2)
    })
    const written = events(harness)
    const starts = written
      .filter((e) => e.type === 'REASONING_MESSAGE_START')
      .map((e) => e.content.messageId as string)
    expect(starts).toHaveLength(2)
    expect(new Set(starts).size).toBe(2)
    // Each delta carries the id of the block it belongs to.
    const contents = written
      .filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
      .map((e) => e.content.messageId as string)
    expect(contents).toEqual(starts)
    // And the second block opens after the tool call closed, not before it.
    const callEnd = written.findIndex((e) => e.type === 'TOOL_CALL_END')
    const secondStart = written.findIndex(
      (e) => e.type === 'REASONING_MESSAGE_START' && e.content.messageId === starts[1],
    )
    expect(callEnd).toBeGreaterThanOrEqual(0)
    expect(secondStart).toBeGreaterThan(callEnd)
    await harness.dispose()
  })

  it('renders a whole reasoning block when the adapter delivers block-end, not deltas', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // pi-ai's deepseek route emits ONE block-end carrying the complete
    // reasoning text and no reasoning-delta events in between.
    const thinking = '这个问题的完整思考链：先看上下文，再决定如何回答。'.repeat(10)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'block-start', blockType: 'reasoning' } })
    emit('assistant/chunk', {
      turn: 1,
      chunk: { type: 'block-end', block: { type: 'reasoning', text: thinking } },
    })

    await vi.waitFor(() => {
      expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_START')
    })
    const contents = events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
    // The full block lands as one content event (the API's per-event bound
    // applies, but a 637-char reasoning block is far under it).
    expect(contents).toHaveLength(1)
    const delta = (contents[0]!.content as { delta: string }).delta
    expect(delta).toMatch(/^〔\d{2}:\d{2}:\d{2}〕 /)
    expect(delta.endsWith(thinking)).toBe(true)
    // The block is closed so the client stops showing "still thinking".
    expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_END')
    await harness.dispose()
  })

  it('shows a thought once when the host delivers both its deltas and its closing block', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // The host publishes one attempt twice: token deltas as they arrive, then a
    // block-end carrying the whole paragraph. Rendering both is what put every
    // thought in the chat twice — the reader saw each paragraph repeated.
    const thinking = '先看日志，再决定。'
    emit('assistant/chunk', { turn: 1, chunk: { type: 'block-start', blockType: 'reasoning' } })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先看日志' } })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '，再决定。' } })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'block-end', block: { type: 'reasoning', text: thinking } } })

    await vi.waitFor(() => {
      expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_END')
    })
    const written = events(harness)
      .filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
      .map((e) => e.content.delta as string)
      .join('')
    expect(written.match(/先看日志/g) ?? []).toHaveLength(1)
    expect(written).toContain(thinking)
    await harness.dispose()
  })

  it('stamps a thought with the clock time it started', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // A reasoning message carries no title, so the time has to ride at the head
    // of its text — the only place a reader is guaranteed to see it.
    emit('assistant/chunk', {
      turn: 1,
      chunk: { type: 'block-end', block: { type: 'reasoning', text: '想一下。' } },
    })

    await vi.waitFor(() => {
      expect(events(harness).map((e) => e.type)).toContain('REASONING_MESSAGE_END')
    })
    const first = events(harness).find((e) => e.type === 'REASONING_MESSAGE_CONTENT')!
    expect(first.content.delta).toMatch(/^〔\d{2}:\d{2}:\d{2}〕 想一下。$/)
    await harness.dispose()
  })

  it('stamps every event after the one before it', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    for (const delta of ['一', '二', '三', '四', '五', '六', '七', '八']) {
      emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: delta } })
    }

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')).toHaveLength(8)
    })
    // The client ORDERS by timestamp, and a burst shares a millisecond — equal
    // stamps are free to be reordered, which arrives as interleaved sentences.
    const stamps = harness.fake.cots[0]!.timestamps.map(Number)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
    expect(new Set(stamps).size).toBe(stamps.length)
    await harness.dispose()
  })

  it('reports a tool call with the platform icon its kind maps to', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_START')).toBeDefined() })
    // With no presenter composed the label is the bare name and the icon the
    // default. The title also carries the clock time: the AG-UI timestamp is
    // an ordering key the client never renders, so "when did this happen" has
    // to ride on the one string the reader actually sees — at its FRONT,
    // because a long path at the tail gets truncated away by the client.
    expect(contentOf(harness, 'TOOL_CALL_START')).toMatchObject({
      toolCallId: 'c1', toolCallName: 'bash', icon: 'default',
    })
    expect((contentOf(harness, 'TOOL_CALL_START') as { title: string }).title)
      .toMatch(/^\d{2}:\d{2}:\d{2} · bash$/)
    const written = events(harness).map((e) => e.type)
    expect(written).toContain('TOOL_CALL_ARGS')
    expect(written).toContain('TOOL_CALL_END')
    // The arguments are summarised, not copied. A file write's arguments
    // are the whole file, and the chat already has the file on disk; the
    // session log keeps the full arguments.
    expect(contentOf(harness, 'TOOL_CALL_ARGS')).toMatchObject({ delta: 'command: ls -la' })
    await harness.dispose()
  })

  it('never puts a tool\'s payload into the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    const payload = 'x'.repeat(5000)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ path: '/tmp/a.txt', content: payload }) })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_ARGS')).toBeDefined() })
    const written = JSON.stringify(events(harness))
    expect(written).not.toContain(payload)
    // What identifies the call is kept.
    expect(contentOf(harness, 'TOOL_CALL_ARGS')).toMatchObject({ delta: 'path: /tmp/a.txt · content: 5000 字符' })
    await harness.dispose()
  })

  it('stamps every tool call with the clock time it started', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'TOOL_CALL_START')).toHaveLength(2)
    })
    // The fake parses each event's payload on the way in, the way the API does.
    const titles = events(harness)
      .filter((e) => e.type === 'TOOL_CALL_START')
      .map((e) => e.content.title as string)
    // Two calls in the same run may share a second — but each carries a time,
    // which is the thing a reader needs to line a step up against their message.
    for (const title of titles) expect(title).toMatch(/^\d{2}:\d{2}:\d{2} · /)
    await harness.dispose()
  })

  it('reports how long a slow tool call took, and stays quiet about a fast one', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'slow', name: 'bash', arguments: '{}' })
    // The elapsed time is measured between the call and its result; a fake
    // clock is the only way to say "this one took 18 seconds" deterministically.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 18_200))
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'slow' }, content: [{ type: 'text', text: 'ok', toolCallId: 'slow' }] },
    })
    emit('tool/call', { turn: 1, callId: 'fast', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'fast' }, content: [{ type: 'text', text: 'ok', toolCallId: 'fast' }] },
    })
    vi.useRealTimers()

    await vi.waitFor(() => {
      expect(events(harness).filter((e) => e.type === 'TOOL_CALL_RESULT')).toHaveLength(2)
    })
    const results = events(harness)
      .filter((e) => e.type === 'TOOL_CALL_RESULT')
      .map((e) => (e.content.content as { code: string }).code)
    expect(results[0]).toContain('18.2s')
    // A sub-second call says nothing rather than "0ms" — the noise is worse
    // than the silence, and the line stays where a reader expects the output.
    expect(results[1]).not.toContain('⏱')
    expect(results[1]).toBe('ok')
    await harness.dispose()
  })

  it('names the slowest step in the closing line, which lives in the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '跑两个命令' } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"build"}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'done', toolCallId: 'c1' }] },
    })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{"command":"test"}' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 252_000))
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'pass', toolCallId: 'c2' }] },
    })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '结论。' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    vi.useRealTimers()

    // The closing line goes to the chat, not the thinking area: the platform
    // hides the process when a run ends, so a line written there would vanish.
    await vi.waitFor(() => {
      const texts = harness.fake.sent.map((m) => (m.input as { markdown?: string }).markdown ?? '')
      expect(texts.some((t) => t.includes('本轮完成'))).toBe(true)
    })
    const closing = harness.fake.sent
      .map((m) => (m.input as { markdown?: string }).markdown ?? '')
      .find((text) => text.includes('本轮完成'))!
    expect(closing).toContain('2 次工具调用')
    // The total says how long; naming the slowest says where the time went.
    expect(closing).toContain('最慢')
    expect(closing).toContain('4 分 12 秒')
    await harness.dispose()
  })

  it('shows a tool result as its head, not as the whole output', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'c1' }, content: [{ type: 'text', text: output, toolCallId: 'c1' }] },
    })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_RESULT')).toBeDefined() })
    const code = (contentOf(harness, 'TOOL_CALL_RESULT') as { content: { code: string } }).content.code
    expect(code).toContain('line 0')
    expect(code).toContain('共 40 行')
    expect(code).not.toContain('line 39')
    await harness.dispose()
  })

  it('says the turn is over, in a message that stays', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '结论。' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThan(0) })
    await vi.waitFor(() => { expect(harness.fake.sent.length).toBe(2) })
    const texts = harness.fake.sent.map((m) => (m.input as { markdown?: string }).markdown ?? '')
    // The closing line is a message of its own, not part of the process the
    // platform hides when the run ends.
    expect(texts.some((t) => t.includes('本轮完成') && t.includes('2 次工具调用'))).toBe(true)
    await harness.dispose()
  })

  it('labels a subagent delegation distinctly from a local tool call', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'subagent', arguments: '{"description":"调研","prompt":"...","run_in_background":true}' })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_START')).toBeDefined() })
    // The delegation reads as a subagent activity, not a bare tool name.
    expect(contentOf(harness, 'TOOL_CALL_START')).toMatchObject({
      toolCallId: 'c1', toolCallName: 'subagent',
    })
    expect(contentOf(harness, 'TOOL_CALL_START').title).toContain('🧑💻')
    await harness.dispose()
  })

  it("renders a tool's output as a code block", async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('tool/result', {
      turn: 1,
      message: {
        source: { callId: 'c1' },
        content: [{ type: 'text', text: 'total 24', toolCallId: 'c1' }],
      },
    })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_RESULT')).toBeDefined() })
    expect(contentOf(harness, 'TOOL_CALL_RESULT')).toMatchObject({
      toolCallId: 'c1', role: 'tool', content: { type: 'code', code: 'total 24' },
    })
    await harness.dispose()
  })

  it('sends the answer as an ordinary message, never into the process', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想一下' } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '你好！' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The platform reserves the process for thinking; the answer is its own message.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '你好！')).toBe(true)
    })
    expect(events(harness).map((e) => e.type)).not.toContain('TEXT_MESSAGE_CONTENT')
    await harness.dispose()
  })

  it('answers a many-step turn once, with the narration in the process', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // An agentic turn narrates between tool calls: every one of these commits
    // used to become its own reply, which is a wall of them for one question.
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '先做整体探索。' }] } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '继续看核心文档。' }] } })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '分析完成，结论如下。' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(harness.fake.sent.length).toBeGreaterThanOrEqual(1) })
    // The chat carries the text the turn ended on, once.
    const answer = harness.fake.sent
      .map((m) => (m.input as { markdown?: string }).markdown ?? '')
      .find((t) => t === '分析完成，结论如下。')
    expect(answer).toBe('分析完成，结论如下。')
    // The narration it replaced is in the process instead; writes are queued,
    // so this is where the queue has drained.
    await vi.waitFor(() => {
      // 按 messageId 排除每轮开头那行「模型 · 工作区」：它也是一条 TEXT_MESSAGE，
      // 但它是过程的开场白，不是 agent 的叙述。
      const narration = events(harness)
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT' && !String(e.content.messageId).startsWith(COT_BANNER_PREFIX))
        .map((e) => e.content.delta)
      expect(narration).toEqual(['先做整体探索。', '继续看核心文档。'])
    })
    await harness.dispose()
  })

  it('gives each narration its own id, so an earlier line is not edited into the first one', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // 叙述也挂在 messageId 上：同一个 id 再发一次就是「编辑那一条」，于是整轮的
    // 叙述都被并到第一段、贴在过程顶上。旧代码用 `run.pending.length` 当序号，
    // 可队列是异步排空的，到那一刻几乎永远是 0——一条轮里所有叙述共用一个 id。
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '先做整体探索。' }] } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '继续看核心文档。' }] } })
    emit('tool/call', { turn: 1, callId: 'c2', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '分析完成，结论如下。' }] } })

    await vi.waitFor(() => {
      const narration = events(harness)
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT' && !String(e.content.messageId).startsWith(COT_BANNER_PREFIX))
      expect(narration).toHaveLength(2)
    })
    const ids = events(harness)
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT' && !String(e.content.messageId).startsWith(COT_BANNER_PREFIX))
      .map((e) => e.content.messageId as string)
    expect(new Set(ids).size).toBe(2)
    await harness.dispose()
  })

  it('shows what a file write changed, not just a "wrote it" receipt', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    // 写文件的「结果」是它改了哪儿。工具自己那句回执（`Wrote 3 lines`）对读者
    // 没有信息量——真正的变更在参数里，所以要在调用时算好、结果时顶上。
    emit('tool/call', {
      turn: 1,
      callId: 'w1',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'src/a.ts', content: 'const a = 1\nconst b = 2' }),
    })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'w1' }, content: [{ type: 'text', text: 'Wrote 2 lines', toolCallId: 'w1' }] },
    })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_RESULT')).toBeDefined() })
    const code = (contentOf(harness, 'TOOL_CALL_RESULT') as { content: { code: string } }).content.code
    expect(code).toContain('src/a.ts')
    expect(code).toContain('+ const a = 1')
    expect(code).toContain('+ const b = 2')
    // 工具那句回执不再占掉这一格。
    expect(code).not.toContain('Wrote 2 lines')
    await harness.dispose()
  })

  it('renders an edit as a diff of the old and new lines', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('tool/call', {
      turn: 1,
      callId: 'e1',
      name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/b.ts', old_string: 'const a = 1', new_string: 'const a = 2' }),
    })
    emit('tool/result', {
      turn: 1,
      message: { source: { callId: 'e1' }, content: [{ type: 'text', text: 'Edited 1 line', toolCallId: 'e1' }] },
    })

    await vi.waitFor(() => { expect(contentOf(harness, 'TOOL_CALL_RESULT')).toBeDefined() })
    const code = (contentOf(harness, 'TOOL_CALL_RESULT') as { content: { code: string } }).content.code
    expect(code).toContain('- const a = 1')
    expect(code).toContain('+ const a = 2')
    await harness.dispose()
  })

  it('clips a change at a line boundary when it is too large for one event', async () => {
    // 一次事件的 JSON 内容上限是 4096 字符，换行/引号还要转义。超了必须在行边界
    // 上截断并说明，不能把事件撑到被服务端拒绝、也不能留半行误导读者。
    const content = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i}`).join('\n')
    const change = renderToolChange('write', JSON.stringify({ file_path: 'src/big.ts', content }), 3000)
    expect(change).toBeDefined()
    const code = change!
    expect(code).toContain('src/big.ts')
    expect(code).toContain('还有')
    expect(JSON.stringify(code).length).toBeLessThan(4096)
    // 每一行要么完整，要么是那句截断说明，不能出现半截代码。
    for (const line of code.split('\n').slice(1)) {
      expect(line === '' || line.startsWith('+ ') || line.startsWith('…（')).toBe(true)
    }
  })

  it('closes the run, ending an open thinking block first', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想到一半' } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(events(harness).map((e) => e.type)).toContain('RUN_FINISHED') })
    const written = events(harness).map((e) => e.type)
    expect(written.indexOf('REASONING_MESSAGE_END')).toBeLessThan(written.indexOf('RUN_FINISHED'))
    expect(contentOf(harness, 'RUN_FINISHED')).toMatchObject({ status: 'done' })
    await harness.dispose()
  })

  it('marks a failed turn as a failed run', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_MODEL', message: 'boom' } } })

    await vi.waitFor(() => { expect(contentOf(harness, 'RUN_ERROR')).toBeDefined() })
    expect(contentOf(harness, 'RUN_ERROR')).toMatchObject({ message: 'E_MODEL: boom' })
    // The chat is told too, by the answer half.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'text' in m.input && m.input.text.includes('E_MODEL'))).toBe(true)
    })
    await harness.dispose()
  })

  it('opens one process per turn', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    emit('step/start', { turn: 2, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(2) })
    await harness.dispose()
  })

  it('still answers when the platform refuses the process', async () => {
    const harness = await mountChannel()
    harness.fake.state.failCotCreate = true
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '想' } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The answer never depended on the thinking process existing.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
    })
    expect(harness.notices.some((line) => line.includes('outbound send failed'))).toBe(true)
    await harness.dispose()
  })

  it('asks the platform to drop the process when the run ends', async () => {
    const harness = await mountChannel({ hideProcessWhenDone: true })
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    expect(harness.fake.cots[0]!.hidden).toBe(true)
    await harness.dispose()
  })

  it('opens no process at all when it is switched off', async () => {
    const harness = await mountChannel({ showProcess: false })
    const emit = await chat(harness)
    emit('step/start', { turn: 1, step: 1 })
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '不该出现' } })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '答案' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // The answer still arrives; an empty process would be worse than none.
    await vi.waitFor(() => {
      expect(harness.fake.sent.some((m) => 'markdown' in m.input && m.input.markdown === '答案')).toBe(true)
    })
    expect(harness.fake.cots).toEqual([])
    await harness.dispose()
  })
})

describe('mid-turn re-aim (P141)', () => {
  it('keeps the running turn on its own target and hands the next turn to the follow-up', async () => {
    const harness = await mountChannel()
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    const emit = (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }

    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })
    expect(harness.fake.cots[0]!.replyTo).toBe('om_in_1')

    // A follow-up lands while turn 1 is still working: turn 1 keeps its target.
    await harness.fake.emitMessage(fakeMessage({ messageId: 'om_in_2', content: '这条是我的' }))
    await vi.waitFor(() => { expect(harness.agents.created[0]!.agent.followup).toHaveBeenCalledTimes(2) })
    emit('step/start', { turn: 2, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(2) })
    expect(harness.fake.cots[0]!.replyTo).toBe('om_in_1')
    expect(harness.fake.cots[1]!.replyTo).toBe('om_in_2')

    emit('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'answer-b' }] } })
    emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      expect(harness.fake.sent.some(s => String((s.input as { markdown?: string }).markdown ?? '').includes('answer-b'))).toBe(true)
    })
    await harness.dispose()
  })
})

describe('mid-turn messages (steering)', () => {
  /** Bind one chat and return an emitter for its session events. */
  async function chat(harness: Awaited<ReturnType<typeof mountChannel>>) {
    await harness.fake.emitMessage(fakeMessage())
    await vi.waitFor(() => { expect(harness.agents.created).toHaveLength(1) }, { timeout: 20_000, interval: 50 })
    const session = harness.agents.created[0]!.agent.session
    return (type: string, data: unknown) => { harness.ctx.emit('session/event', session, { type, data }) }
  }

  it('shows a message sent mid-turn, at the step that admitted it', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)

    emit('step/start', { turn: 1, step: 1 })
    emit('tool/call', { turn: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })

    // 用户在中途插话。宿主不立刻记录：它先进收件箱，在下一个 step 边界被
    // 接纳时才以 `user/message` 追加进会话日志——所以它夹在两步之间。
    emit('user/message', {
      id: 'um_1',
      role: 'user',
      content: [{ type: 'text', text: '改成先看测试' }],
      source: { kind: 'user' },
    })
    emit('step/start', { turn: 1, step: 2 })

    await vi.waitFor(() => {
      expect(harness.fake.cots[0]!.events.map(e => e.type)).toContain('TEXT_MESSAGE_CONTENT')
    })
    const list = harness.fake.cots[0]!.events
    // 按 role 找插话那条：每轮开头还有一行 banner（role 也是 assistant）。
    const start = list.findIndex(e => e.type === 'TEXT_MESSAGE_START' && (e.content as { role?: string }).role === 'user')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(list[start]!.content).toMatchObject({ role: 'user' })
    expect(list[start + 1]!.content).toMatchObject({ delta: '改成先看测试' })
    expect(list[start + 2]!.type).toBe('TEXT_MESSAGE_END')
    // 它必须排在插话之前那次工具调用之后，才看得出「因为这句话才转向」。
    const lastTool = list.map(e => e.type).lastIndexOf('TOOL_CALL_END')
    expect(lastTool).toBeLessThan(start)
    await harness.dispose()
  })

  it('leaves the message that opened the turn to the chat', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)

    // 开轮的那条消息在聊天里有自己的气泡，不该在思考区重复一遍。
    emit('user/message', {
      id: 'um_0',
      role: 'user',
      content: [{ type: 'text', text: '开轮的第一条' }],
      source: { kind: 'user' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(harness.fake.cots).toEqual([])
    await harness.dispose()
  })

  it('ignores the messages the host writes to itself', async () => {
    const harness = await mountChannel()
    const emit = await chat(harness)

    emit('step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(harness.fake.cots).toHaveLength(1) })

    // goal / 指令 / 上下文都是宿主自己写的，读者不会认成自己的话。
    emit('user/message', {
      id: 'um_goal',
      role: 'user',
      content: [{ type: 'text', text: '继续推进目标' }],
      source: { kind: 'goal' },
    })
    emit('user/message', {
      id: 'um_inst',
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>' }],
      source: { kind: 'agent-instructions' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    // 只看 role=user 的：每轮开头那行 banner 是 assistant，不算「宿主写的话」。
    const userStarts = harness.fake.cots[0]!.events
      .filter(e => e.type === 'TEXT_MESSAGE_START' && (e.content as { role?: string }).role === 'user')
    expect(userStarts).toEqual([])
    await harness.dispose()
  })

  it('opens every turn with the model and workspace it is running as', async () => {
    // 2026-11-11 操作者要求：思考那一刻用的模型和工作区要出现在每条 CoT 的开头，
    // 否则换过模型 / 刚绑过工作区之后，没法一眼确认刚才那轮跑在哪。
    //
    // 载体是一条独立的 assistant 文本，排在推理块前面；不塞假工具调用（那会
    // 让「第一条工具调用是哪个」整体错位），也不拼进推理块（时钟前缀是既有格式）。
    const harness = await mountChannel()
    const emit = await chat(harness)
    emit('assistant/chunk', { turn: 1, chunk: { type: 'reasoning-delta', text: '先看目录' } })

    await vi.waitFor(() => {
      expect(events(harness).map(e => e.type)).toContain('REASONING_MESSAGE_CONTENT')
    })
    const order = events(harness).map(e => e.type)
    // 按 messageId 认出 banner：它排在每轮最前，不靠「第几条 TEXT_MESSAGE」。
    const banner = events(harness).find(e => e.type === 'TEXT_MESSAGE_CONTENT'
      && String(e.content.messageId).startsWith(COT_BANNER_PREFIX))!
    // 测试部署配的是 test-provider/test-model，工作区取配置的 cwd。
    expect(String(banner.content.delta)).toContain('test-provider/test-model')
    expect(order.indexOf('TEXT_MESSAGE_CONTENT')).toBeLessThan(order.indexOf('REASONING_MESSAGE_CONTENT'))
    // 推理块自己的时钟前缀没被改动。
    const thought = events(harness).find(e => e.type === 'REASONING_MESSAGE_CONTENT')!
    expect(String(thought.content.delta)).toMatch(/^〔\d{2}:\d{2}:\d{2}〕 /)
    await harness.dispose()
  })

  it('renders the banner as 模型（档位）· 工作区, and says only what it knows', () => {
    // 路径包反引号不是装饰：这条文本按 Markdown 渲染，裸 `D:\Desktop` 的反斜杠
    // 会被当成转义吃掉，读者看到 `D:Desktop`（2026-11-11 现场）。
    expect(cotBannerText({ model: 'p/m', effort: 'high', workspace: 'D:\\Proj' })).toBe('p/m（high） · `D:\\Proj`')
    expect(cotBannerText({ model: 'p/m' })).toBe('p/m')
    // 什么都不知道时不写：空行比一行「未知」更扰乱阅读。
    expect(cotBannerText({})).toBe('')
  })
})
