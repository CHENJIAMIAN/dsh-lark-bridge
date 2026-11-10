import { describe, expect, it } from 'vitest'
import { PANEL_ACTION, panelActionValue, panelCard, panelFormValue } from '../src/panel.ts'
import type { PanelView } from '../src/panel.ts'

const VIEW: PanelView = {
  sessionId: 'feishu-oc_a:r1',
  currentModel: 'deepseek/v4',
  models: [
    { provider: 'deepseek', providerName: 'DeepSeek', id: 'v4', name: 'V4' },
    { provider: 'deepseek', providerName: 'DeepSeek', id: 'flash', name: 'Flash' },
  ],
  currentWorkspace: 'D:\\Proj',
  workspaces: ['D:\\Proj', 'D:\\Other'],
  contextUsed: 45_000,
}

/** Walk every element the card carries, forms included. */
function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    node.forEach(child => walk(child, out))
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  out.push(node as Record<string, unknown>)
  walk(Object.values(node as Record<string, unknown>), out)
  return out
}

describe('console card', () => {
  it('uses CardKit 2.0, which the form controls require', () => {
    const card = panelCard(VIEW) as Record<string, unknown>
    expect(card.schema).toBe('2.0')
  })

  it('puts the model and workspace dropdowns in their own forms', () => {
    const forms = walk(panelCard(VIEW)).filter(node => node.tag === 'form')
    // A form may only sit at the card root and cannot nest, so each control
    // group needs its own — one form holding both would be invalid.
    expect(forms).toHaveLength(2)
    expect(forms.map(form => form.name)).toEqual(['panel-model', 'panel-workspace'])
  })

  it('preselects the active model and workspace', () => {
    const selects = walk(panelCard(VIEW)).filter(node => node.tag === 'select_static')
    expect(selects).toHaveLength(2)
    expect(selects[0]!.selected).toBe('deepseek/v4')
    expect(selects[1]!.selected).toBe('D:\\Proj')
  })

  it('offers refresh and new-session as pressable actions', () => {
    const ops = walk(panelCard(VIEW))
      .filter(node => node.tag === 'button')
      .map(node => ((node.value ?? {}) as Record<string, unknown>).op)
    expect(ops).toContain('refresh')
    expect(ops).toContain('new-session')
  })

  it('marks every submit button with this plugin\'s action kind', () => {
    const buttons = walk(panelCard(VIEW)).filter(node => node.tag === 'button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      const value = (button.value ?? {}) as Record<string, unknown>
      expect(value.kind).toBe(PANEL_ACTION)
    }
  })

  it('shows the context figure with a percentage', () => {
    const card = panelCard({ ...VIEW, contextUsed: 45_000, contextWindow: 128_000 })
    expect(JSON.stringify(card)).toContain('35%')
  })

  it('degrades honestly when the model catalogue is empty', () => {
    const text = JSON.stringify(panelCard({ ...VIEW, models: [] }))
    // No dropdown to offer, so say so rather than showing an empty one.
    expect(text).toContain('没有报出可用的模型目录')
  })

  it('degrades honestly when no workspace is registered', () => {
    const text = JSON.stringify(panelCard({ ...VIEW, workspaces: [] }))
    expect(text).toContain('还没有注册过其他工作区')
  })

  it('says the context is unreadable instead of showing zero', () => {
    const text = JSON.stringify(panelCard({ ...VIEW, contextUsed: undefined }))
    expect(text).toContain('上下文不可读')
  })
})

describe('console action values', () => {
  it('parses this plugin\'s own payload', () => {
    expect(panelActionValue({ kind: PANEL_ACTION, section: 'model', op: 'set' }))
      .toEqual({ section: 'model', op: 'set' })
  })

  it('carries a value when one is present', () => {
    expect(panelActionValue({ kind: PANEL_ACTION, section: 'actions', op: 'refresh', value: 'x' })?.value).toBe('x')
  })

  it('ignores foreign card actions', () => {
    expect(panelActionValue({ kind: 'something-else' })).toBeUndefined()
    expect(panelActionValue(undefined)).toBeUndefined()
    expect(panelActionValue({ kind: PANEL_ACTION })).toBeUndefined()
  })

  it('takes the one submitted value out of a form result', () => {
    expect(panelFormValue({ model: 'deepseek/v4' })).toBe('deepseek/v4')
    expect(panelFormValue({ model: '' })).toBeUndefined()
    expect(panelFormValue(undefined)).toBeUndefined()
  })
})
