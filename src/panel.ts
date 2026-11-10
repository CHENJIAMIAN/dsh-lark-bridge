/**
 * The console card: the bridge's own operations as things you press.
 *
 * Feishu slash commands are fine once you know them and miserable before that —
 * nobody discovers `/ws use <dir>` by looking at a chat. A card can show the
 * current state and offer the change next to it, which is the whole point of
 * this module.
 *
 * What a card can do is narrower than it looks, and the design follows from it:
 *
 * - A card is static. It changes only when the bridge sends a new one, so every
 *   interaction is "submit → bridge rewrites the card → you see the new state".
 * - `form` may only sit at the card root, so each control group is its own form
 *   with its own submit button. Nothing nests.
 * - A form submission reports the button that submitted it (`action.name`) and
 *   the field values (`action.formValue`), which is exactly the identity the
 *   dispatcher needs.
 *
 * The sections below are rendered by one loop that knows nothing about models or
 * workspaces. Adding an operation means adding a section, not editing the card.
 * @module dsh-lark-bridge/panel
 */

import type { ModelEntry } from './model-catalog.ts'

/** The card-button / form-submit payload the console uses. */
export const PANEL_ACTION = 'dsh-lark-bridge/panel'

/** Prefix of a form submit button's `name`, carrying which section it submits. */
export const PANEL_SUBMIT_PREFIX = 'panel-submit-'

/** One console interaction, as the card reports it. */
export interface PanelActionValue {
  /** Section that owns the control. */
  readonly section: string
  /** What the section should do with it. */
  readonly op: string
  /** The chosen value, when the control carries one. */
  readonly value?: string
}

/**
 * Narrow an arbitrary card-action value to this plugin's console payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function panelActionValue(value: unknown): PanelActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== PANEL_ACTION) return undefined
  if (typeof record.section !== 'string' || typeof record.op !== 'string') return undefined
  return {
    section: record.section,
    op: record.op,
    ...typeof record.value === 'string' ? { value: record.value } : {},
  }
}

/** The action payload a control embeds. */
function actionValue(section: string, op: string, value?: string): object {
  return { kind: PANEL_ACTION, section, op, ...value === undefined ? {} : { value } }
}

/** Everything one rendering of the console needs to draw itself. */
export interface PanelView {
  /** Session the card acts on. */
  readonly sessionId: string
  /** The active `provider/model`, as a selection key. */
  readonly currentModel: string
  /** Models the host can route to, in menu order. */
  readonly models: readonly ModelEntry[]
  /** Directory this session actually runs in, when known. */
  readonly currentWorkspace: string
  /**
   * The chat's workspace binding — where the NEXT session starts.
   *
   * Shown separately from {@link currentWorkspace} only when the two differ:
   * after a pick the running session stays where it was until `/new`.
   */
  readonly boundWorkspace?: string
  /** Registered workspaces, as display paths. */
  readonly workspaces: readonly string[]
  /** Context usage, when the meter can read it. */
  readonly contextUsed?: number
  /** Context window, when the host reports one. */
  readonly contextWindow?: number
  /**
   * Failure lines for the diagnostics section, when this card is reporting a
   * failed operation rather than showing the console. Absent on a normal card.
   */
  readonly diagnostics?: readonly string[]
}

/** A group of card elements contributed by one section. */
export interface PanelSectionRender {
  /** Section id, used to route its actions back. */
  readonly id: string
  /** Elements appended to the card body, in order. */
  readonly elements: object[]
}

/** A `plain_text` element: the only text form untrusted values may take. */
function plainText(content: string): object {
  return { tag: 'plain_text', content }
}

/**
 * A small explanatory line.
 *
 * **Not `tag: 'note'`.** schema 2.0 dropped that tag, and cardkit rejects the
 * WHOLE card rather than the one element: `code=200861 … unsupported tag note`,
 * with `card_id: ""` in the response body. The SDK only reads `data.card_id`,
 * so the caller sees the useless `cardkit.card.create returned no card_id
 * (code=unknown)` — the platform's real error never surfaces. A `div` holding
 * `plain_text` is the shape this card already uses elsewhere and 2.0 accepts.
 * @param content - the line to show.
 * @returns a body element.
 */
function hint(content: string): object {
  return { tag: 'div', text: plainText(content) }
}

/** `45,000 / 128,000（35%）` — a usage figure a reader can judge at a glance. */
function describeUsage(used: number | undefined, window: number | undefined): string {
  if (used === undefined) return '上下文不可读'
  const count = used.toLocaleString('en-US')
  if (window === undefined || window <= 0) return `上下文约 ${count}`
  const percent = Math.min(100, Math.round((used / window) * 100))
  return `上下文约 ${count} / ${window.toLocaleString('en-US')}（${percent}%）`
}

/**
 * The model section: a dropdown plus its own submit button.
 *
 * `select_static` keeps the options off the card face — twenty models as twenty
 * buttons is a wall, and the reader only needs to see the one that is active.
 * @param view - the state being rendered.
 * @returns the section's elements.
 */
/** How many options a dropdown will offer before it is truncated. */
export const PANEL_CHOICES_MAX = 40

/**
 * The model section: a form holding one dropdown and its submit button.
 *
 * CardKit 2.0 gives us a `form` container, which JSON 1.0 did not have. That is
 * what makes a dropdown submit its value through `formValue` instead of needing
 * the 1.0 `behaviors` callback workaround. Every interactive child needs a
 * unique `name` across the whole card, hence the `panel-…` prefixes.
 * @param view - the state being rendered.
 * @returns the section's elements.
 */
function modelSection(view: PanelView): PanelSectionRender {
  const activeEntry = view.models.find(entry => `${entry.provider}/${entry.id}` === view.currentModel)
  const label = activeEntry === undefined ? view.currentModel : `${activeEntry.providerName} · ${activeEntry.name}`
  const elements: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `**模型**　${label}` } },
  ]
  if (view.models.length === 0) {
    elements.push(hint('宿主没有报出可用的模型目录。'))
    return { id: 'model', elements }
  }
  const options = view.models.slice(0, PANEL_CHOICES_MAX).map(entry => ({
    text: plainText(`${entry.providerName} · ${entry.name}`),
    value: `${entry.provider}/${entry.id}`,
  }))
  // `initial_option` is the option's DISPLAY TEXT, not its `value`. Passing a
  // `provider/model` (or an index the client ignores) leaves the dropdown
  // showing the first option while the header shows a different model —
  // exactly the "model looks wrong" report. Only set it when the current
  // model is actually among the offered options.
  const activeInList = options.some(option => option.value === view.currentModel)
  elements.push({
    tag: 'form',
    name: 'panel-model-form',
    direction: 'horizontal',
    vertical_spacing: 'small',
    elements: [
      {
        tag: 'select_static',
        name: 'panel-model',
        type: 'default',
        width: 'fill',
        // Must stay false: a required control makes the client swallow the
        // submission instead of reporting it.
        required: false,
        ...activeInList ? { initial_option: label } : {},
        placeholder: plainText('选择模型'),
        options,
      },
      {
        tag: 'button',
        name: `${PANEL_SUBMIT_PREFIX}model`,
        form_action_type: 'submit',
        type: 'primary',
        text: plainText('切换'),
      },
    ],
  })
  return { id: 'model', elements }
}

/**
 * The workspace section: a dropdown of registered directories.
 *
 * Same shape as the model section on purpose — a reader who learned one learned
 * both. An empty registry still shows the current directory, so the card never
 * says it knows nothing about where sessions land.
 * @param view - the state being rendered.
 * @returns the section's elements.
 */
function workspaceSection(view: PanelView): PanelSectionRender {
  // The headline names the directory the CURRENT session runs in — a fact.
  // The binding is a different fact (`/new` lands there) and gets its own line,
  // so the card never claims this conversation has already moved.
  const elements: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `**工作区**　\`${view.currentWorkspace}\`` } },
  ]
  const pending = view.boundWorkspace !== undefined && view.boundWorkspace !== view.currentWorkspace
    ? view.boundWorkspace
    : undefined
  if (pending !== undefined) {
    elements.push(hint(`已绑定 ${pending}，发 /new 后新会话在此目录`))
  }
  if (view.workspaces.length === 0) {
    elements.push(hint('还没有注册过其他工作区。用 /ws 注册一个。'))
    return { id: 'workspace', elements }
  }
  const options = view.workspaces.slice(0, PANEL_CHOICES_MAX).map(path => ({
    text: plainText(path),
    value: path,
  }))
  const currentInList = options.some(option => option.value === view.currentWorkspace)
  elements.push({
    tag: 'form',
    name: 'panel-workspace-form',
    direction: 'horizontal',
    vertical_spacing: 'small',
    elements: [
      {
        tag: 'select_static',
        name: 'panel-workspace',
        type: 'default',
        width: 'fill',
        required: false,
        ...currentInList ? { initial_option: view.currentWorkspace } : {},
        placeholder: plainText('选择工作区'),
        options,
      },
      {
        tag: 'button',
        name: `${PANEL_SUBMIT_PREFIX}workspace`,
        form_action_type: 'submit',
        type: 'primary',
        text: plainText('绑定'),
      },
    ],
  })
  // 和 `bind_workspace` 一致：只写绑定，不替用户把当前对话切掉。不说清这一句，
  // 点完看不出变化就会被当成「切了没反应」。
  elements.push(hint('绑定后发 /new 开新会话生效'))
  return { id: 'workspace', elements }
}

/**
 * The action row: things that are pressed rather than chosen.
 *
 * 「新建会话」 replays a `/new` through the ordinary inbound path rather than
 * calling anything directly — `/new` is a HOST command, and the bridge's only
 * entry point into command execution is a message. Replaying keeps the argument
 * plumbing, authorization and device checks that a direct call would have to
 * reconstruct. The synthetic message carries no `om_` id, so the bridge does not
 * try to reply into a thread that does not exist.
 *
 * 「刷新」 exists because the card is a snapshot: a reader who watched a turn
 * finish has no other way to make it re-read the state. Both are safe to press —
 * neither destroys anything.
 * @param _view - the state being rendered (unused; kept for section symmetry).
 * @returns the section's elements.
 */
function actionsSection(_view: PanelView): PanelSectionRender {
  const button = (name: string, op: string, text: string): object => ({
    tag: 'button',
    name,
    text: plainText(text),
    type: 'default',
    value: actionValue('actions', op),
  })
  return {
    id: 'actions',
    elements: [{
      tag: 'column_set',
      horizontal_spacing: 'small',
      columns: [
        { tag: 'column', width: 'auto', elements: [button('panel-refresh', 'refresh', '🔄 刷新')] },
        { tag: 'column', width: 'auto', elements: [button('panel-new-session', 'new-session', '✨ 新建会话')] },
      ],
    }],
  }
}

/**
 * The diagnostics section: what the last card operation actually returned.
 *
 * Exists because "the card never appeared" is the one failure a card cannot
 * report about itself — there is nothing on screen to press. When `/console`
 * fails, the bridge sends a plain-text message that carries this section's data
 * as a card, so the platform's own error code and log id are readable in the
 * chat instead of being swallowed by the caller's `catch`.
 * @param view - the state being rendered.
 * @returns the section's elements.
 */
function diagnosticsSection(view: PanelView): PanelSectionRender {
  const lines = view.diagnostics ?? []
  const elements: object[] = [
    { tag: 'div', text: { tag: 'lark_md', content: `**诊断**　最近一次卡片操作` } },
  ]
  if (lines.length === 0) {
    elements.push(hint('没有记录到失败的卡片操作。'))
    return { id: 'diagnostics', elements }
  }
  for (const line of lines) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: line } })
  }
  return { id: 'diagnostics', elements }
}

/** The sections this card is made of, in display order. */
export const PANEL_SECTIONS = [modelSection, workspaceSection, actionsSection] as const

/** The sections a failure report shows: the error, then what was being done. */
export const PANEL_FAILURE_SECTIONS = [diagnosticsSection, modelSection, workspaceSection] as const

/**
 * Build the console card for one view of the state.
 *
 * CardKit 2.0, sent as a managed card entity (`port.createCard` + `cardId`),
 * which is the only way to get real in-place updates via `updateCardById`.
 * This same package's question cards already ship 2.0 forms, so the structure
 * here mirrors theirs rather than guessing at it.
 * @param view - the state as last read.
 * @returns a Feishu card object.
 */
export function panelCard(view: PanelView): object {
  const elements: object[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `会话 \`${view.sessionId}\`\n${describeUsage(view.contextUsed, view.contextWindow)}` },
    },
  ]
  // A failure report leads with the failure: the reader asked for a console and
  // did not get one, so the reason outranks the model and workspace rows.
  const sections = view.diagnostics === undefined ? PANEL_SECTIONS : PANEL_FAILURE_SECTIONS
  sections.forEach((section, index) => {
    if (index > 0) elements.push({ tag: 'hr' })
    elements.push(...section(view).elements)
  })
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      template: view.diagnostics === undefined ? 'blue' : 'red',
      title: plainText(view.diagnostics === undefined ? '🎛 DSH 控制台' : '⚠️ DSH 控制台打不开'),
    },
    body: { elements },
  }
}

/** One chat's managed card entity and the sequence its next update must carry. */
export interface ConsoleEntityState {
  readonly cardId: string
  readonly sequence: number
}

/**
 * The card entity each chat owns, with strictly increasing update sequences.
 *
 * `cardkit.v1.card.update` rejects a sequence that is not greater than the last
 * one accepted, so the counter has to live exactly as long as the entity.
 * Keeping it in one place also makes the two decisions — "no entity yet, create
 * one" and "entity exists, update it" — impossible to get out of sync.
 */
export function createConsoleCardStore(): {
  /** The next action for a chat, given its current state. */
  planFor(chatId: string): { readonly kind: 'create' } | { readonly kind: 'update'; readonly cardId: string; readonly sequence: number }
  /** Record a newly created entity. */
  created(chatId: string, cardId: string): void
  /** Record a successful update (only then may the sequence advance). */
  updated(chatId: string, sequence: number): void
  /** Drop a stale entity so the next call creates a fresh one. */
  forget(chatId: string): void
} {
  const byChat = new Map<string, ConsoleEntityState>()
  return {
    planFor(chatId) {
      const entity = byChat.get(chatId)
      if (entity === undefined) return { kind: 'create' }
      // Sequence 0 is the creation itself; the first update must be 1.
      return { kind: 'update', cardId: entity.cardId, sequence: entity.sequence + 1 }
    },
    created(chatId, cardId) {
      byChat.set(chatId, { cardId, sequence: 0 })
    },
    updated(chatId, sequence) {
      const entity = byChat.get(chatId)
      if (entity === undefined) return
      // A failed update must not advance the counter: the next attempt has to
      // reuse this sequence or Feishu will reject it forever.
      byChat.set(chatId, { cardId: entity.cardId, sequence })
    },
    forget(chatId) {
      byChat.delete(chatId)
    },
  }
}

/**
 * Identify a 2.0 form submit from its button `name`.
 *
 * A `form_action_type: 'submit'` button does NOT echo its `value` back — the
 * callback carries `action.name` (the button's unique name) and the form's
 * fields under `action.formValue`. This package's question cards are built on
 * exactly that contract. Reading only `action.value` here is why both dropdowns
 * looked like they could not switch at all: the callback arrived but nothing
 * recognised it.
 * @param name - `action.name` as the channel SDK hands it over.
 * @returns the section/op the submit means, or undefined for other buttons.
 */
export function panelSubmitAction(name: string | undefined): PanelActionValue | undefined {
  if (name === undefined || !name.startsWith(PANEL_SUBMIT_PREFIX)) return undefined
  const section = name.slice(PANEL_SUBMIT_PREFIX.length)
  if (section !== 'model' && section !== 'workspace') return undefined
  return { section, op: 'set' }
}

/**
 * The value one submitted form carries.
 *
 * A section's form holds exactly one input control, so the sole value is that
 * control's answer whatever its name turned out to be. But the VALUE SHAPE is
 * not guaranteed: this package's proven 2.0 question card sees a multi-select
 * report an array while a text input reports a string. Accept both — reading
 * only strings here would leave a dropdown submission empty with no error at
 * all, which is exactly the "the switch does nothing" failure this bridge has
 * already paid for once.
 * @param formValue - `action.formValue` as the channel SDK hands it over.
 * @returns the value, or undefined when nothing was submitted.
 */
export function panelFormValue(formValue: Record<string, unknown> | undefined): string | undefined {
  if (formValue === undefined) return undefined
  for (const value of Object.values(formValue)) {
    if (typeof value === 'string' && value !== '') return value
    if (Array.isArray(value)) {
      const first = value.find((item): item is string => typeof item === 'string' && item !== '')
      if (first !== undefined) return first
    }
  }
  return undefined
}

/**
 * Everything one card interaction reported, reduced to the value it carries.
 *
 * Two places to look, because the platform has two:
 *
 * - `formValue` — the whole set of interactive values, which is what a JSON 2.0
 *   `form` submit produces.
 * - `option` — the chosen option of ONE component, which is what a bare
 *   `select_static` reports when no form wraps it (and JSON 1.0 has no form).
 *
 * Reading only `formValue` would leave every dropdown submission empty on a 1.0
 * card, and the failure would look like "the switch does nothing" rather than
 * like a field name being wrong.
 * @param action - the card action's payload fields.
 * @returns the chosen value, or undefined when the click carried none.
 */
export function panelSubmitted(action: {
  readonly formValue?: Record<string, unknown> | undefined
  readonly option?: string | undefined
}): string | undefined {
  return panelFormValue(action.formValue) ?? (typeof action.option === 'string' && action.option !== '' ? action.option : undefined)
}

/**
 * What one console interaction asks the bridge to do.
 *
 * Kept as data rather than as side effects so the routing decision is testable
 * without a live host: the question "does a submitted model actually become a
 * set-model effect, and does a malformed one become an error" is a pure question,
 * and it is the half that tends to be wrong.
 */
export type PanelEffect =
  | { readonly kind: 'set-model'; readonly provider: string; readonly model: string }
  | { readonly kind: 'set-workspace'; readonly path: string }
  | { readonly kind: 'new-session' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Turn one card interaction into the effect it means.
 *
 * Every refusal names what was wrong, because a button that silently does
 * nothing is indistinguishable from a bridge that is broken.
 * @param action - the parsed button/form payload.
 * @param submitted - the value its form carried, when it was a form submit.
 * @returns the effect the bridge should perform.
 */
export function resolvePanelAction(action: PanelActionValue, submitted: string | undefined): PanelEffect {
  if (action.section === 'actions') {
    if (action.op === 'refresh') return { kind: 'refresh' }
    if (action.op === 'new-session') return { kind: 'new-session' }
    return { kind: 'invalid', reason: `不认识的动作 ${action.op}` }
  }
  if (action.section === 'model' && action.op === 'set') {
    if (submitted === undefined) return { kind: 'invalid', reason: '没有拿到选择的模型' }
    // `provider/model`, split at the FIRST slash: model ids may contain slashes
    // (`openrouter/anthropic/claude-…`), provider routes may not.
    const slash = submitted.indexOf('/')
    if (slash <= 0 || slash === submitted.length - 1) {
      return { kind: 'invalid', reason: '这个模型标识看不懂' }
    }
    return {
      kind: 'set-model',
      provider: submitted.slice(0, slash),
      model: submitted.slice(slash + 1),
    }
  }
  if (action.section === 'workspace' && action.op === 'set') {
    if (submitted === undefined) return { kind: 'invalid', reason: '没有拿到选择的工作区' }
    return { kind: 'set-workspace', path: submitted }
  }
  return { kind: 'invalid', reason: `不认识的面板节 ${action.section}` }
}
