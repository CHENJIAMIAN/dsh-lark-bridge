import { describe, expect, it } from 'vitest'
import { WORKFLOW_TOOL_NAME, workflowLogLine, workflowNameFromArguments } from '../src/workflow.ts'

/**
 * The workflow module keeps the event shapes, the narration line, and the
 * pieces the bridge needs before a run exists. Progress itself lives on a card
 * (`tests/workflow-card.spec.ts`).
 */
describe('workflow narration', () => {
  it('renders a narration line', () => {
    expect(workflowLogLine('正在读 68 个 chunk')).toBe('📝 正在读 68 个 chunk')
  })
})

describe('workflow call arguments', () => {
  it('names the run from meta.name', () => {
    expect(workflowNameFromArguments(JSON.stringify({ meta: { name: 'scan-pitfalls-batch' }, script: 'x' })))
      .toBe('scan-pitfalls-batch')
  })

  it('trims the name', () => {
    expect(workflowNameFromArguments(JSON.stringify({ meta: { name: '  scan  ' } }))).toBe('scan')
  })

  it('degrades to a neutral label rather than throwing', () => {
    // The arguments are model-produced: unparseable JSON is a real possibility,
    // and it must not throw into the session event stream.
    expect(workflowNameFromArguments('{not json')).toBe('未命名')
    expect(workflowNameFromArguments('null')).toBe('未命名')
    expect(workflowNameFromArguments(JSON.stringify({ meta: {} }))).toBe('未命名')
    expect(workflowNameFromArguments(JSON.stringify({ meta: { name: '   ' } }))).toBe('未命名')
    expect(workflowNameFromArguments(JSON.stringify({ meta: { name: 42 } }))).toBe('未命名')
  })

  it('knows the tool it belongs to', () => {
    expect(WORKFLOW_TOOL_NAME).toBe('workflow')
  })
})
