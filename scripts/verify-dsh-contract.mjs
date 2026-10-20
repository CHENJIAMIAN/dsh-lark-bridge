#!/usr/bin/env node
/**
 * Contract drift gate: verifies that the structural copies in src/host.ts still
 * mirror the live DeepSeek Harness upstream branch. The bridge intentionally does
 * NOT import host source packages, so a host rename/removal would otherwise
 * break at runtime instead of in CI.
 *
 * Usage: node scripts/verify-dsh-contract.mjs
 * Exit 1 on drift or fetch failure.
 */

const RAW = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/'
const FILES = {
  agent: 'packages/core/agent/src/runtime-types.ts',
  goal: 'packages/goal/goal/src/domain.ts',
  subagent: 'packages/subagent/subagent/src/types.ts',
  workflow: 'packages/workflow/workflow/src/index.ts',
  jobs: 'packages/jobs/jobs/src/index.ts',
  jobsTypes: 'packages/jobs/jobs/src/types.ts',
  feedback: 'packages/feedback/message-feedback/src/types.ts',
  presetRegistry: 'packages/preset/agent-preset-registry/src/index.ts',
  commands: 'packages/interaction/commands/src/index.ts',
  tokenMeter: 'packages/llm/token-meter/src/index.ts',
  // The declared-deliverable event: the host tells the channel which files
  // a turn produced. The bridge delivers them to the chat, so the shape
  // below is a contract it depends on.
  toolPresent: 'packages/deliverables/tool-present/src/types.ts',
  // The team events: one roster, one task board, and a mailbox. The bridge
  // renders a fleet panel from them.
  agentTeam: 'packages/experimental/agent-team/src/types.ts',
}

const checks = [
  {
    name: 'declared deliverables carry turn, callId and files',
    file: 'toolPresent',
    pattern: /'deliverables\/presented': \{ turn: number; callId: ToolCallId; files: PresentedFile\[\] \}/,
  },
  {
    name: 'a declared file carries a path and an optional description',
    file: 'toolPresent',
    pattern: /export interface PresentedFile \{[\s\S]*?\bpath: string[\s\S]*?\bdescription\?: string[\s\S]*?\}/,
  },
  {
    name: 'team events stay version 2 with snapshot payloads',
    file: 'agentTeam',
    pattern: /'team\/member': \{ version: 2; teamId: TeamId; member: TeamMemberSnapshot \}/,
  },
  {
    name: 'the team task event stays version 2',
    file: 'agentTeam',
    pattern: /'team\/task': \{ version: 2; teamId: TeamId; task: TeamTaskSnapshot \}/,
  },
  {
    name: 'the team mailbox events stay version 2',
    file: 'agentTeam',
    pattern: /'team\/message\/queued': \{ version: 2; teamId: TeamId; message: TeamMessageSnapshot \}/,
  },
  {
    name: 'the team member snapshot keeps its name and phase',
    file: 'agentTeam',
    pattern: /export interface TeamMemberSnapshot \{[\s\S]*?readonly name: string[\s\S]*?readonly phase: TeamMemberPhase[\s\S]*?\}/,
  },
  {
    name: 'the team task snapshot keeps its subject and status',
    file: 'agentTeam',
    pattern: /export interface TeamTaskSnapshot \{[\s\S]*?readonly subject: string[\s\S]*?readonly status: TeamTaskStatus[\s\S]*?\}/,
  },
  {
    name: 'Agent.cancel keeps the options signature',
    file: 'agent',
    pattern: /cancel\(cause: AgentCancelCause, options\?: CancelOptions\): void/,
  },
  {
    name: 'agent/status payload shape',
    file: 'agent',
    pattern: /'agent\/status'\(this: Scoped<Agent>, payload: \{ agent: Agent; status: AgentStatus \}\): void/,
  },
  {
    name: 'Goal clear tombstone survives',
    file: 'goal',
    pattern: /readonly cleared: GoalRef/,
  },
  {
    name: 'Subagent stop reasons stay completed|aborted|error|max-tokens',
    file: 'subagent',
    pattern: /completed: 'completed'[\s\S]*aborted: 'aborted'[\s\S]*error: 'error'[\s\S]*'max-tokens': 'max-tokens'/,
  },
  {
    name: 'agent-preset registry exposes acquireScope (0.1.7 rename of standingKeyFor)',
    file: 'presetRegistry',
    pattern: /acquireScope\(id\?: string\): Promise</,
  },
  {
    name: 'agent-preset registry still exposes resolve+mount',
    file: 'presetRegistry',
    pattern: /resolve\(id\?: string\): Promise[\s\S]*mount\(ctx: Context, id\?: string\): Promise/,
  },
  {
    name: 'workflow/log is a two-argument event',
    file: 'workflow',
    pattern: /'workflow\/log'\(info: WorkflowRunInfo, message: string\): void/,
  },
  {
    name: 'workflow/phase is a two-argument event',
    file: 'workflow',
    pattern: /'workflow\/phase'\(info: WorkflowRunInfo, title: string\): void/,
  },
  {
    name: 'jobs exposes the events stream with subscribe (0.1.7 replacement for onJobDone)',
    file: 'jobs',
    pattern: /abstract readonly events: JobEvents/,
  },
  {
    name: 'jobs settled event carries awaited (dup-report guard)',
    file: 'jobsTypes',
    // `awaited` sits after `job`/`cause` and a doc block (measured 467 chars
    // upstream), so match a window rather than requiring adjacency.
    pattern: /readonly type: 'settled'[\s\S]{0,800}readonly awaited: boolean/,
  },
  {
    name: 'jobs list(caller) takes a SessionId',
    file: 'jobs',
    pattern: /abstract list\(caller\?: SessionId\): JobView\[\]/,
  },
  {
    name: 'jobs readAt is the non-consuming read',
    file: 'jobs',
    // Completion notices pull output with this one: `read()` consumes the ring
    // and advances the model cursor, so a notice using it would steal bytes the
    // agent still expects to see.
    pattern: /abstract readAt\(id: JobId, from: number, caller\?: SessionId\): JobOutputRead/,
  },
  {
    name: 'message feedback put request keeps its fields',
    file: 'feedback',
    pattern: /readonly sessionId: SessionId[\s\S]*readonly messageId: MessageId[\s\S]*readonly rating: MessageFeedbackRating[\s\S]*readonly ifVersion: MessageFeedbackVersion \| null/,
  },
  {
    // The commands service is where issue #2 lived: upstream inserted the
    // `submittedAttachments` slot in front of `signal`, and the bridge's
    // hard-coded three-argument call put the signal in the attachments slot
    // (the host then threw on `signal.aborted`). The contract gate had no
    // entry for this service at all — the exact gap the bug fell through.
    name: 'commands.execute keeps the attachments slot before signal',
    file: 'commands',
    pattern: /async execute\(\s*agent: Agent,\s*line: string,\s*submittedAttachments: readonly CommandSubmitAttachment\[\],\s*signal: AbortSignal,?\s*\): Promise<CommandExecution \| undefined>/,
  },
  {
    // The token meter prices a context by replaying the session's event log,
    // so it takes the SESSION, not the session id. The bridge once handed it
    // `{ id }`, and the meter then replayed nothing, reported zero tokens for
    // every session, and the context-pressure warning never fired — silently,
    // with no error to catch. Assert the upstream shape so the next change
    // fails in CI rather than in production.
    name: 'tokenMeter.measure takes the session, not the session id',
    file: 'tokenMeter',
    pattern: /measure\(session: Session, requestHeader\?: EpochHeader\): TokenMeasurement/,
  },
]

/**
 * Checks that count a method's arguments the way JavaScript does at runtime.
 *
 * The text of a signature can stay the same while the value the bridge reads
 * at runtime changes: `execute(agent, line, attachments, signal = new
 * AbortController().signal)` still matches a pattern that looks for the four
 * parameters, but its `.length` is 3, because JavaScript counts only the
 * parameters before the first default. The bridge reads that length to decide
 * between calling with three arguments and with four, so a default added
 * upstream would silently change the call shape — which is exactly how issue
 * #2 happened.
 *
 * A default is therefore counted here, the same way JavaScript counts it, and
 * the result is compared against the shapes the bridge knows how to call.
 */
const arityChecks = [
  {
    name: 'commands.execute 的运行时参数个数',
    file: 'commands',
    member: 'execute',
    // Only four. A length of three is ambiguous here: it is either a host
    // that never had an attachments slot, or a host that has one and gives
    // the signal a default value — and the second reading is the one that
    // broke issue #2, because the bridge would then put the signal into
    // the attachments slot. The bridge's own call is pinned to the
    // four-argument shape, so a host that reports three is drift.
    accept: [4],
    find(source) {
      // The method, not a mention of it: a comment in the upstream source
      // that shows an example call would otherwise be counted as the
      // signature, and a legal host would be reported as drifted.
      const match = /^[ \t]*(?:public |private |protected )?async execute\(([^)]*)\)/m.exec(source)
      if (match === null) return null
      const params = match[1]
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
      // JavaScript counts only the parameters before the first default.
      const firstDefault = params.findIndex((part) => part.includes('='))
      return firstDefault === -1 ? params.length : firstDefault
    },
  },
]

/**
 * Checks against the bridge's own `src/host.ts`.
 *
 * These are not drift checks: the file they read is the one they protect,
 * so they can only catch a local edit that broke the declared shape. The
 * checks that actually watch upstream are the ones above, which read the
 * upstream source. The name says "mirrors" because each entry states what
 * upstream declares, but the thing being compared is local to both sides
 * of the assertion.
 */
const HOST_PATTERNS = [
  ['HostAgent.cancel mirrors options', /cancel\(cause: string, options\?: \{ readonly keepInbox\?: boolean \}\): void/],
  ['GoalChangeData carries cleared tombstone', /readonly cleared\?: \{ readonly id: string; readonly revision\?: number \}/],
  ['SubagentEndData stopReason union', /readonly stopReason: 'completed' \| 'aborted' \| 'error' \| 'max-tokens'/],
  ['workflow/log declared structurally', /'workflow\/log'\(info: WorkflowRunInfoData, message: string\): void/],
  ['workflow/phase declared structurally', /'workflow\/phase'\(info: WorkflowRunInfoData, title: string\): void/],
  ['AgentStatusData mirrors { agent, status }', /readonly agent: \{ readonly id: string \}/],
  ['HostJobs mirrors events.subscribe', /readonly events: HostJobEvents/],
  ['HostJobs mirrors list(caller)', /list\(caller\?: string\): readonly HostJobSnapshot\[\]/],
  ['HostJobs mirrors readAt', /readAt\(id: string, from: number, caller\?: string\): HostJobOutputRead/],
  ['HostJobSnapshot mirrors output coordinates', /readonly output\?: \{[\s\S]*readonly total: number[\s\S]*readonly earliest: number/],
  ['HostMessageFeedback mirrors put', /put\(request: \{[\s\S]*readonly sessionId: string[\s\S]*readonly rating: 'positive' \| 'negative'/],
  ['host.ts guards the declared-deliverable event', /export function isPresentedEvent\(/],
  ['host.ts keeps the declared-deliverable shape', /readonly callId: string[\s\S]*readonly files: readonly PresentedFileData\[\]/],
]


async function main() {
  const sources = {}
  for (const [key, path] of Object.entries(FILES)) {
    const res = await fetch(RAW + path)
    if (!res.ok) throw new Error(`fetch ${path} failed: HTTP ${res.status}`)
    sources[key] = await res.text()
  }
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../src/host.ts', import.meta.url), 'utf8')

  let failed = 0
  for (const check of checks) {
    const ok = check.pattern.test(sources[check.file])
    console.log(`${ok ? '  ✅' : '  ❌'} ${check.name}`)
    if (!ok) failed += 1
  }
  for (const check of arityChecks) {
    const found = check.find(sources[check.file])
    if (found === null) {
      console.log(`  ❌ ${check.name} — 没能从上游源码里找到 ${check.member}`)
      failed += 1
      continue
    }
    const ok = check.accept.includes(found)
    console.log(
      `${ok ? '  ✅' : '  ❌'} ${check.name} — 运行时 arity=${found}`
      + `（桥按此选三参/四参；期望 ${check.accept.join(' 或 ')}）`,
    )
    if (!ok) failed += 1
  }
  for (const [name, pattern] of HOST_PATTERNS) {
    const ok = pattern.test(host)
    console.log(`${ok ? '  ✅' : '  ❌'} host.ts: ${name}`)
    if (!ok) failed += 1
  }
  console.log(failed === 0 ? '\n契约无漂移（dsh 上游 master）' : `\n${failed} 项漂移`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`契约漂移检查失败：${error.message}`)
  process.exit(1)
})
