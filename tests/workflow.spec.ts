import { describe, expect, it } from 'vitest'
import { workflowLogLine } from '../src/workflow.ts'

/**
 * The workflow module keeps only the event shapes and the narration line;
 * progress moved to a card (`tests/workflow-card.spec.ts`).
 */
describe('workflow narration', () => {
  it('renders a narration line', () => {
    expect(workflowLogLine('正在读 68 个 chunk')).toBe('📝 正在读 68 个 chunk')
  })
})
