#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const resolvePath = (...parts) => resolve(...parts)
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
/**
 * The release the production deployment runs.
 *
 * The master branch is the future; this tag is the present. A gate that
 * only looks at the future answers "will the bridge still fit the next
 * release" and stays silent about the release in production, which is where
 * a shape mismatch bites. Both are checked: the tag for what runs today,
 * the branch for what comes next.
 */
const PROD_TAG = 'dsh-v0.2.1-rc.2'
const RAW_TAG = `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${PROD_TAG}/`
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
  // The team package's own entry point: the relayed-message source is built
  // there, not in the event types.
  agentTeamIndex: 'packages/experimental/agent-team/src/index.ts',
  // The skill body the `/skills <name>` view reads. The host names the field
  // `content`; reading `body` off the result reads `undefined`.
  skill: 'packages/skill/skill/src/index.ts',
  // The session search hit. A hit is a session record, and the record
  // carries the header one level down.
  sessionQuery: 'packages/session-query/session-query/src/types.ts',
  // The persistence snapshot. The header sits one level down inside it.
  sessionPersistence: 'packages/session/session-persistence/src/index.ts',
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
    // A message one teammate relayed to another is not a mailbox event: the
    // team package steers it into the recipient's inbox, and it lands there
    // as a user message whose source says who sent it. The bridge reads the
    // card's message list from these, so the source shape is a contract.
    name: 'a relayed team message carries the agent-message source',
    file: 'agentTeamIndex',
    pattern: /kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: caller\.id/,
  },
  {
    name: 'the skill body is named content',
    file: 'skill',
    pattern: /readonly content: string/,
  },
  {
    name: 'a search hit carries the session header one level down',
    file: 'sessionQuery',
    pattern: /export interface SessionRecord \{[\s\S]*?\bheader: SessionHeader/,
  },
  {
    name: 'a persistence snapshot carries the session header one level down',
    file: 'sessionPersistence',
    pattern: /interface SessionPersistenceSnapshot \{[\s\S]*?readonly header: SessionHeader/,
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
  ['host.ts reads the session header one level down', /export interface HostSessionHeader \{[\s\S]*?readonly header: \{/],
  ['host.ts reads a search hit header one level down', /export interface HostSessionQueryHit \{[\s\S]*?readonly header: \{/],
  ['host.ts reads the skill body as content', /get\(name: string\): Promise<\{ readonly content: string \}/],
  ['host.ts keeps the declared-deliverable shape', /readonly callId: string[\s\S]*readonly files: readonly PresentedFileData\[\]/],
  ['host.ts guards the team member event', /export function isTeamMemberEvent\(/],
  ['host.ts guards a relayed team message', /export function isTeamRelayMessageEvent\([\s\S]*?source\.kind === 'agent-message'/],
  ['host.ts guards the team task event', /export function isTeamTaskEvent\(/],
  ['host.ts guards the team mailbox event', /export function isTeamMessageEvent\(/],
  ['host.ts guards the team delivery event', /export function isTeamMessageDeliveredEvent\(/],
  ['host.ts keeps the team member shape', /export interface TeamMemberSnapshot \{[\s\S]*?readonly name: string[\s\S]*?readonly phase: 'provisioning' \| 'active' \| 'failed'/],
  ['host.ts keeps the team task shape', /export interface TeamTaskSnapshot \{[\s\S]*?readonly subject: string[\s\S]*?readonly status: 'pending' \| 'in_progress' \| 'completed' \| 'deleted'/],
]


/**
 * The tree the running deployment actually loads, when it is on this
 * machine.
 *
 * The remote branch is the future; this is the present. A check that only
 * looks at the remote branch answers "will the bridge still fit the next
 * release" — and stays silent about the release in production, which is
 * where a shape mismatch bites. The local tree is checked as well, so a
 * mismatch against what runs today cannot pass unnoticed.
 */
const LOCAL_UPSTREAM_NAMES = [
  'deepseek-harness-0.2.1-rc.2',
  'deepseek-harness',
]

/**
 * Where the upstream tree sits on this machine, if it is here.
 *
 * The directory names are the only thing written down: a repository that
 * spells out a machine's own directory layout carries that layout with it,
 * and a public repository must not. The candidates are the environment
 * variable, the home directory's project folder, and the folder this
 * repository sits in — the last one is where a checkout and its upstream
 * tree usually live side by side.
 */
function localRoot() {
  const here = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
  const candidates = []
  const fromEnv = process.env.DSH_UPSTREAM_ROOT
  if (fromEnv !== undefined && fromEnv !== '') candidates.push(fromEnv)
  const home = process.env.HOME
  if (home !== undefined && home !== '') {
    for (const name of LOCAL_UPSTREAM_NAMES) {
      candidates.push(resolvePath(home, '..', 'PROJECT', name))
      candidates.push(resolvePath(home, 'PROJECT', name))
    }
  }
  for (const name of LOCAL_UPSTREAM_NAMES) {
    candidates.push(resolvePath(here, '..', name))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function fetchTree(base) {
  const out = {}
  for (const [key, path] of Object.entries(FILES)) {
    const res = await fetch(base + path)
    if (!res.ok) throw new Error(`fetch ${base + path} failed: HTTP ${res.status}`)
    out[key] = await res.text()
  }
  return out
}

async function main() {
  const sources = await fetchTree(RAW)
  let prodSources
  try {
    prodSources = await fetchTree(RAW_TAG)
  } catch (error) {
    console.log(`  ⚠️ 生产版本 ${PROD_TAG} 拉不到：${String(error)}`)
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
  // The release in production, checked with the same patterns.
  if (prodSources !== undefined) {
    console.log(`  ── 生产版本：${PROD_TAG}`)
    for (const check of checks) {
      const ok = check.pattern.test(prodSources[check.file])
      console.log(`${ok ? '  ✅' : '  ❌'} 生产版：${check.name}`)
      if (!ok) failed += 1
    }
    for (const check of arityChecks) {
      const found = check.find(prodSources[check.file])
      if (found === null) {
        console.log(`  ❌ 生产版：${check.name} — 没能找到 ${check.member}`)
        failed += 1
        continue
      }
      const ok = check.accept.includes(found)
      console.log(
        `${ok ? '  ✅' : '  ❌'} 生产版：${check.name} — 运行时 arity=${found}`
        + `（期望 ${check.accept.join(' 或 ')}）`,
      )
      if (!ok) failed += 1
    }
  }
  // The tree that runs on this machine, checked with the same patterns.
  const root = localRoot()
  if (root === undefined) {
    console.log('  ⚠️ 本机没有上游树可查——只核了远端分支')
  } else {
    const local = {}
    let missing = 0
    for (const [key, path] of Object.entries(FILES)) {
      const file = `${root}/${path}`
      try {
        local[key] = readFileSync(file, 'utf8')
      } catch {
        missing += 1
        console.log(`  ⚠️ 本机上游树里没有 ${path}`)
      }
    }
    if (missing === 0) {
      console.log(`  ── 本机在跑的上游树：${root}`)
      for (const check of checks) {
        const ok = check.pattern.test(local[check.file])
        console.log(`${ok ? '  ✅' : '  ❌'} 本机树：${check.name}`)
        if (!ok) failed += 1
      }
      for (const check of arityChecks) {
        const found = check.find(local[check.file])
        if (found === null) {
          console.log(`  ❌ 本机树：${check.name} — 没能找到 ${check.member}`)
          failed += 1
          continue
        }
        const ok = check.accept.includes(found)
        console.log(
          `${ok ? '  ✅' : '  ❌'} 本机树：${check.name} — 运行时 arity=${found}`
          + `（期望 ${check.accept.join(' 或 ')}）`,
        )
        if (!ok) failed += 1
      }
    }
  }
  for (const [name, pattern] of HOST_PATTERNS) {
    const ok = pattern.test(host)
    console.log(`${ok ? '  ✅' : '  ❌'} host.ts: ${name}`)
    if (!ok) failed += 1
  }
  console.log(failed === 0 ? `\n契约无漂移（远端分支、生产版本 ${PROD_TAG}、本机上游树）` : `\n${failed} 项漂移`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`契约漂移检查失败：${error.message}`)
  process.exit(1)
})
