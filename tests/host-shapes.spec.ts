import { describe, expect, it } from 'vitest'
import { runCommandLine, SESSIONS_COMMAND, SKILLS_COMMAND } from '../src/commands.ts'
import type { HostAgent, HostSessionPersistence, HostSessionQuery, HostSkills } from '../src/host.ts'

/**
 * The host's shapes are not the shapes a reading of the docs suggests.
 *
 * A session search hit is a session record, and the record carries the
 * header one level down. The persistence store hands back snapshots with
 * the same nesting. A skill's body is named `content`. Reading the flat
 * version of any of them yields `undefined`, and trimming that throws.
 *
 * These tests use the host's real shapes, so a bridge that reads the flat
 * version fails here instead of in a chat.
 */
describe('the session and skill shapes are the ones the host sends', () => {
  const AGENT = { session: { id: 'feishu-oc_chat_1' } } as unknown as HostAgent

  /** The command line's parameters, in the order it takes them. */
  function call(
    line: string,
    slots: {
      persistence?: HostSessionPersistence
      chatId?: string
      sessionQuery?: HostSessionQuery
      skills?: HostSkills
    } = {},
  ) {
    // The command line takes its collaborators as positional arguments, so
    // the slots are placed by name rather than counted.
    const args: unknown[] = [
      line, AGENT, undefined, new AbortController().signal,
      undefined, slots.persistence, slots.chatId,
      undefined, undefined, undefined, undefined, undefined,
      slots.sessionQuery,
      undefined, undefined, undefined, undefined, slots.skills,
    ]
    return runCommandLine(...(args as Parameters<typeof runCommandLine>))
  }

  it('lists a chat sessions from a snapshot with the header one level down', async () => {
    const store: HostSessionPersistence = {
      list: async () => [
        { header: { id: 'feishu-oc_chat_1', createdAt: 1_700_000_000_000 } },
        { header: { id: 'feishu-oc_chat_2', createdAt: 1_700_000_500_000 } },
      ],
    }
    const outcome = await call(`/${SESSIONS_COMMAND}`, { persistence: store, chatId: 'oc_chat_1' })
    expect(outcome.resolved).toBe(true)
    const reply = outcome.reply ?? ''
    // The other chat's session is excluded; this chat's own session is not.
    expect(reply).toContain('1 个')
    expect(reply).toContain('← 当前')
    expect(reply).not.toContain('undefined')
  })

  it('searches sessions from a hit whose header is one level down', async () => {
    const query: HostSessionQuery = {
      searchSessions: async () => ({
        items: [
          { header: { id: 'feishu-oc_chat_1', createdAt: 1_700_000_000_000 }, bestMatch: { snippet: '飞书桥的 i18n' } },
        ],
      }),
    }
    const outcome = await call(`/${SESSIONS_COMMAND} i18n`, { chatId: 'oc_chat_1', sessionQuery: query })
    expect(outcome.resolved).toBe(true)
    const reply = outcome.reply ?? ''
    expect(reply).toContain('飞书桥的 i18n')
    expect(reply).not.toContain('undefined')
  })

  it('shows one skill by the field the host names it', async () => {
    const skills: HostSkills = {
      list: async () => [],
      get: async (name: string) => (name === 'demo' ? { content: '这是技能正文' } : undefined),
    }
    const outcome = await call(`/${SKILLS_COMMAND} demo`, { skills })
    expect(outcome.resolved).toBe(true)
    expect(outcome.reply ?? '').toContain('这是技能正文')
  })
})
