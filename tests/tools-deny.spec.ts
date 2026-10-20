import { describe, expect, it } from 'vitest'
import { runCommandLine, TOOLS_COMMAND } from '../src/commands.ts'
import type { HostAgent } from '../src/host.ts'

/**
 * The listing answers "what can this machine do", and a tool someone
 * switched off is not something it can do. Listing it beside the ones
 * that are answers a different question.
 */
describe('the available list leaves out the tools that are switched off', () => {
  it('does not offer a denied tool as available', async () => {
    const tools = {
      schemas: () => [
        { name: 'bash', description: 'Run a shell command' },
        { name: 'read_file', description: 'Read a file' },
      ],
    }
    const denied = new Set(['bash'])
    const outcome = await runCommandLine(
      `/${TOOLS_COMMAND}`,
      { session: { id: 'ses_1' } } as unknown as HostAgent,
      undefined,
      new AbortController().signal,
      undefined, undefined, undefined, denied,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      tools,
    )
    expect(outcome.resolved).toBe(true)
    const reply = outcome.reply ?? ''
    // The denied tool is still named in the deny list above.
    expect(reply).toContain('当前禁用')
    // But it is not offered as available: the offer is the section that
    // follows the deny list.
    const offer = reply.slice(reply.indexOf('可用（'))
    expect(offer).not.toContain('`bash`')
    expect(offer).toContain('`read_file`')
  })
})
