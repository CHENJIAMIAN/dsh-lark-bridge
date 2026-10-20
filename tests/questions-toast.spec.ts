/**
 * The question card's click response is a behaviour contract with Feishu:
 * the card callback carries `{ toast: { type, content } }`, and the SDK
 * forwards whatever the handler returns VERBATIM (its `CardActionResponse` is
 * `Record<string, unknown>`). A bare string type-checks and then renders
 * nothing, so the clicker gets no feedback at all — this pins the object
 * shape, not the source that produces it.
 */

import { describe, expect, it } from 'vitest'
import { createQuestionProvider, QUESTION_ACTION } from '../src/questions.ts'

/** A minimal fake port recording sends. */
function fakePort() {
  const sent: { chatId: string; card: object }[] = []
  return {
    sent,
    async send(chatId: string, input: { card: object }) {
      sent.push({ chatId, card: input.card })
      return { messageId: `om_${sent.length}` }
    },
  }
}

/** Yield one microtask so the awaited send inside ask() settles. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Every button value on a rendered card. */
function buttonValues(card: object): unknown[] {
  const elements = (card as { elements?: { actions?: { value: unknown }[] }[] }).elements ?? []
  return elements.flatMap(e => e.actions?.map(a => a.value) ?? [])
}

describe('question card click response', () => {
  it('carries the SDK toast object, not a bare string', async () => {
    const port = fakePort()
    const { provider, handleCardAction } = createQuestionProvider(port as never, () => ({ chatId: 'oc_chat_1' }))
    const promise = provider.ask({
      questions: [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A 方案' }, { label: 'B 方案' }] }],
      agent: { session: { id: 'ses_1' } },
    })
    await tick()
    const id = (buttonValues(port.sent[0]!.card)[0] as { id: string }).id

    const response = handleCardAction({
      action: { value: { kind: QUESTION_ACTION, id, option: 'A 方案' } },
    } as never) as { toast: unknown }

    // Exactly what the SDK documents (`dist/index.d.mts`):
    // `{ toast: { type: 'success' | 'info' | 'error' | 'warning' | 'loading',
    //            content: string } }`.
    expect(response).toEqual({ toast: { type: 'success', content: '回答已提交' } })
    // Spelled out separately: the failing shape this guards against is a
    // STRING toast, which the platform drops silently.
    expect(typeof response.toast).toBe('object')
    expect(JSON.parse(JSON.stringify(response))).toEqual({
      toast: { type: 'success', content: '回答已提交' },
    })

    // Settle the pending ask so the test leaks no promise.
    await promise
  })
})
