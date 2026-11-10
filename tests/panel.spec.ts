import { describe, expect, it } from 'vitest'
import { createConsoleCardStore, PANEL_ACTION, PANEL_SUBMIT_PREFIX, panelActionValue, panelCard, panelFormValue, panelSubmitted, panelSubmitAction, resolvePanelAction } from '../src/panel.ts'
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
  it('is a CardKit 2.0 card, which managed entities require', () => {
    const card = panelCard(VIEW) as Record<string, unknown>
    expect(card.schema).toBe('2.0')
    expect(card.body).toHaveProperty('elements')
  })

  it('uses no tag that schema 2.0 rejects', () => {
    // 2026-11-10 现场：给提示行用了 `tag: 'note'`，cardkit 直接拒绝整张卡——
    // `code=200861 … unsupported tag note`、`card_id: ""`。SDK 只读 `data.card_id`，
    // 于是调用方看到的全是 `returned no card_id (code=unknown)`，服务端真正的错误码
    // 一次都没露出来，排查因此绕了一大圈。整卡级拒绝意味着任何一个元素写错都致命。
    const tags = walk(panelCard(VIEW))
      .map(node => node.tag)
      .filter((tag): tag is string => typeof tag === 'string')
    expect(tags).not.toContain('note')
  })

  it('puts each dropdown in its own form with a submit button', () => {
    // 2.0 has a form container, so a dropdown reports through formValue`r
    // instead of the 1.0 ehaviors callback workaround.
    const nodes = walk(panelCard(VIEW))
    const forms = nodes.filter(node => node.tag === 'form')
    expect(forms).toHaveLength(2)
    for (const form of forms) {
      const children = (form.elements ?? []) as Record<string, unknown>[]
      expect(children.some(item => item.tag === 'select_static')).toBe(true)
      expect(children.some(item => item.tag === 'button' && item.form_action_type === 'submit')).toBe(true)
    }
    const names = nodes.filter(node => typeof node.name === 'string').map(node => node.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('preselects the active model and workspace', () => {
    const selects = walk(panelCard(VIEW)).filter(node => node.tag === 'select_static')
    expect(selects[0]!.initial_option).toBe('DeepSeek · V4')
    expect(selects[1]!.initial_option).toBe('D:\\Proj')
  })

  it('leaves the dropdown unselected when the current value is not offered', () => {
    // Passing a value absent from the options would silently pre-select the
    // first one, showing a model that is not the one in use.
    const selects = walk(panelCard({ ...VIEW, currentModel: 'other/x' })).filter(node => node.tag === 'select_static')
    expect(selects[0]!.initial_option).toBeUndefined()
  })

  it('offers refresh and new-session as pressable actions', () => {
    const ops = walk(panelCard(VIEW))
      .filter(node => node.tag === 'button')
      .map(node => ((node.value ?? {}) as Record<string, unknown>).op)
    expect(ops).toContain('refresh')
    expect(ops).toContain('new-session')
  })

  it('marks every plain button with this plugin\'s action kind', () => {
    const buttons = walk(panelCard(VIEW)).filter(node => node.tag === 'button')
    expect(buttons.length).toBeGreaterThan(0)
    // Form submit buttons are identified by `name`, not `value` — see the
    // dedicated test below. Only the plain buttons carry the action payload.
    for (const button of buttons) {
      if (button.form_action_type === 'submit') continue
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

describe('console action dispatch', () => {
  const action = (section: string, op: string) => ({ section, op })

  it('turns the refresh button into a refresh', () => {
    expect(resolvePanelAction(action('actions', 'refresh'), undefined)).toEqual({ kind: 'refresh' })
  })

  it('turns the new-session button into a new session', () => {
    expect(resolvePanelAction(action('actions', 'new-session'), undefined)).toEqual({ kind: 'new-session' })
  })

  it('splits a model route at the first slash only', () => {
    // Model ids may contain slashes (`openrouter/anthropic/claude-…`), provider
    // routes may not — splitting anywhere else would truncate the model.
    expect(resolvePanelAction(action('model', 'set'), 'openrouter/anthropic/claude')).toEqual({
      kind: 'set-model',
      provider: 'openrouter',
      model: 'anthropic/claude',
    })
  })

  it('refuses a model switch with no selection', () => {
    const effect = resolvePanelAction(action('model', 'set'), undefined)
    expect(effect.kind).toBe('invalid')
  })

  it('refuses a model value it cannot split', () => {
    expect(resolvePanelAction(action('model', 'set'), 'no-slash').kind).toBe('invalid')
    expect(resolvePanelAction(action('model', 'set'), 'trailing/').kind).toBe('invalid')
  })

  it('turns a workspace selection into a binding write', () => {
    expect(resolvePanelAction(action('workspace', 'set'), 'D:\\Proj')).toEqual({
      kind: 'set-workspace',
      path: 'D:\\Proj',
    })
  })

  it('says on the workspace section that the binding lands on the next /new', () => {
    // 和 `bind_workspace` 同一行为：点了不会当场换目录，卡片上必须写明，
    // 否则「点完没变化」会被读成桥坏了。
    const text = JSON.stringify(panelCard(VIEW))
    expect(text).toContain('绑定后发 /new')
  })

  it('refuses unknown sections and operations instead of doing nothing', () => {
    // A silent no-op is indistinguishable from a broken bridge, so every
    // unrecognised combination has to come back as an explicit refusal.
    expect(resolvePanelAction(action('nope', 'set'), 'x').kind).toBe('invalid')
    expect(resolvePanelAction(action('actions', 'nope'), undefined).kind).toBe('invalid')
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

  it('accepts an array value, the shape a select control may report', () => {
    // The proven 2.0 question card in this package sees multi-selects report
    // arrays. Reading only strings would silently drop the submission.
    expect(panelFormValue({ model: ['deepseek/v4'] })).toBe('deepseek/v4')
    expect(panelFormValue({ model: ['', 'deepseek/v4'] })).toBe('deepseek/v4')
    expect(panelFormValue({ model: [] })).toBeUndefined()
    expect(panelFormValue({ model: [42] })).toBeUndefined()
  })

  it('reads a bare select from option, which is how 1.0 reports it', () => {
    // JSON 1.0 has no form, so a dropdown submits as option rather than as a
    // field of formValue. Reading only the latter left every switch empty.
    expect(panelSubmitted({ option: 'p/m' })).toBe('p/m')
    expect(panelSubmitted({ formValue: { model: 'p/m2' } })).toBe('p/m2')
    expect(panelSubmitted({ option: '' })).toBeUndefined()
    expect(panelSubmitted({})).toBeUndefined()
  })
  it('parses a submit button name into its section action', () => {
    expect(panelSubmitAction(`${PANEL_SUBMIT_PREFIX}model`)).toEqual({ section: 'model', op: 'set' })
    expect(panelSubmitAction(`${PANEL_SUBMIT_PREFIX}workspace`)).toEqual({ section: 'workspace', op: 'set' })
    expect(panelSubmitAction('panel-refresh')).toBeUndefined()
    expect(panelSubmitAction(undefined)).toBeUndefined()
    expect(panelSubmitAction(`${PANEL_SUBMIT_PREFIX}nope`)).toBeUndefined()
  })
})

describe('console card entity lifecycle', () => {
  it('creates first, then always updates in place', () => {
    const store = createConsoleCardStore()
    expect(store.planFor('chat')).toEqual({ kind: 'create' })
    store.created('chat', 'card-1')
    expect(store.planFor('chat')).toEqual({ kind: 'update', cardId: 'card-1', sequence: 1 })
    store.updated('chat', 1)
    expect(store.planFor('chat')).toEqual({ kind: 'update', cardId: 'card-1', sequence: 2 })
  })

  it('keeps sequences strictly increasing', () => {
    const store = createConsoleCardStore()
    store.created('chat', 'card-1')
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      const plan = store.planFor('chat')
      if (plan.kind !== 'update') throw new Error('expected an update')
      seen.push(plan.sequence)
      store.updated('chat', plan.sequence)
    }
    expect(seen).toEqual([1, 2, 3, 4, 5])
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
    }
  })

  it('does not advance the sequence when an update was never confirmed', () => {
    // A failed update must be retried with the SAME sequence, or Feishu keeps
    // rejecting it as stale forever.
    const store = createConsoleCardStore()
    store.created('chat', 'card-1')
    expect(store.planFor('chat')).toEqual({ kind: 'update', cardId: 'card-1', sequence: 1 })
    expect(store.planFor('chat')).toEqual({ kind: 'update', cardId: 'card-1', sequence: 1 })
  })

  it('recreates after a stale entity is forgotten', () => {
    const store = createConsoleCardStore()
    store.created('chat', 'card-1')
    store.updated('chat', 1)
    store.forget('chat')
    expect(store.planFor('chat')).toEqual({ kind: 'create' })
    store.created('chat', 'card-2')
    expect(store.planFor('chat')).toEqual({ kind: 'update', cardId: 'card-2', sequence: 1 })
  })

  it('names each submit button so a 2.0 form callback can be identified', () => {
    // A form submit does NOT echo the button's `value`: it reports `action.name`
    // and the fields under `formValue`. Without these names the callback is
    // unrecognisable and both dropdowns look like they cannot switch.
    const submits = walk(panelCard(VIEW))
      .filter(node => node.tag === 'button' && node.form_action_type === 'submit')
    expect(submits.map(button => button.name)).toEqual([
      `${PANEL_SUBMIT_PREFIX}model`,
      `${PANEL_SUBMIT_PREFIX}workspace`,
    ])
    for (const button of submits) expect(button.value).toBeUndefined()
  })

  it('keeps chats independent', () => {
    const store = createConsoleCardStore()
    store.created('a', 'card-a')
    store.updated('a', 1)
    expect(store.planFor('b')).toEqual({ kind: 'create' })
    expect(store.planFor('a')).toEqual({ kind: 'update', cardId: 'card-a', sequence: 2 })
  })
})
