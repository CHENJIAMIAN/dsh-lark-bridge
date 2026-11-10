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
/** The card-button / form-submit payload the console uses. */
export const PANEL_ACTION = 'dsh-lark-bridge/panel';
/**
 * Narrow an arbitrary card-action value to this plugin's console payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function panelActionValue(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    if (record.kind !== PANEL_ACTION)
        return undefined;
    if (typeof record.section !== 'string' || typeof record.op !== 'string')
        return undefined;
    return {
        section: record.section,
        op: record.op,
        ...typeof record.value === 'string' ? { value: record.value } : {},
    };
}
/** The action payload a control embeds. */
function actionValue(section, op, value) {
    return { kind: PANEL_ACTION, section, op, ...value === undefined ? {} : { value } };
}
/** A `plain_text` element: the only text form untrusted values may take. */
function plainText(content) {
    return { tag: 'plain_text', content };
}
/** `45,000 / 128,000（35%）` — a usage figure a reader can judge at a glance. */
function describeUsage(used, window) {
    if (used === undefined)
        return '上下文不可读';
    const count = used.toLocaleString('en-US');
    if (window === undefined || window <= 0)
        return `上下文约 ${count}`;
    const percent = Math.min(100, Math.round((used / window) * 100));
    return `上下文约 ${count} / ${window.toLocaleString('en-US')}（${percent}%）`;
}
/**
 * The model section: a dropdown plus its own submit button.
 *
 * `select_static` keeps the options off the card face — twenty models as twenty
 * buttons is a wall, and the reader only needs to see the one that is active.
 * @param view - the state being rendered.
 * @returns the section's elements.
 */
function modelSection(view) {
    const options = view.models.map(entry => ({
        text: plainText(`${entry.providerName} · ${entry.name}`),
        value: `${entry.provider}/${entry.id}`,
    }));
    const active = options.find(option => option.value === view.currentModel);
    const elements = [
        { tag: 'div', text: { tag: 'lark_md', content: `**模型**　\`${view.currentModel}\`` } },
    ];
    if (options.length === 0) {
        elements.push({ tag: 'note', elements: [plainText('宿主没有报出可用的模型目录。')] });
        return { id: 'model', elements };
    }
    elements.push({
        tag: 'form',
        name: 'panel-model',
        direction: 'horizontal',
        vertical_spacing: 'small',
        elements: [
            {
                tag: 'select_static',
                name: 'model',
                type: 'default',
                width: 'fill',
                required: false,
                ...active === undefined ? {} : { initial_option: active.value },
                placeholder: plainText('选择模型'),
                options,
            },
            {
                tag: 'button',
                name: 'panel:model',
                form_action_type: 'submit',
                type: 'primary',
                text: plainText('切换'),
                value: actionValue('model', 'set'),
            },
        ],
    });
    return { id: 'model', elements };
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
function workspaceSection(view) {
    const elements = [
        { tag: 'div', text: { tag: 'lark_md', content: `**工作区**　\`${view.currentWorkspace}\`` } },
    ];
    if (view.workspaces.length === 0) {
        elements.push({ tag: 'note', elements: [plainText('还没有注册过其他工作区。用 /ws 注册一个。')] });
        return { id: 'workspace', elements };
    }
    const options = view.workspaces.map(path => ({ text: plainText(path), value: path }));
    const active = options.find(option => option.value === view.currentWorkspace);
    elements.push({
        tag: 'form',
        name: 'panel-workspace',
        direction: 'horizontal',
        vertical_spacing: 'small',
        elements: [
            {
                tag: 'select_static',
                name: 'workspace',
                type: 'default',
                width: 'fill',
                required: false,
                ...active === undefined ? {} : { initial_option: active.value },
                placeholder: plainText('选择工作区'),
                options,
            },
            {
                tag: 'button',
                name: 'panel:workspace',
                form_action_type: 'submit',
                type: 'primary',
                text: plainText('切换'),
                value: actionValue('workspace', 'set'),
            },
        ],
    });
    return { id: 'workspace', elements };
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
function actionsSection(_view) {
    const button = (op, text) => ({
        tag: 'button',
        text: plainText(text),
        type: 'default',
        value: actionValue('actions', op),
    });
    return {
        id: 'actions',
        elements: [{
                tag: 'column_set',
                horizontal_spacing: 'small',
                columns: [
                    { tag: 'column', width: 'auto', elements: [button('refresh', '🔄 刷新')] },
                    { tag: 'column', width: 'auto', elements: [button('new-session', '✨ 新建会话')] },
                ],
            }],
    };
}
/** The sections this card is made of, in display order. */
export const PANEL_SECTIONS = [modelSection, workspaceSection, actionsSection];
/**
 * Build the console card for one view of the state.
 *
 * JSON 1.0, not CardKit 2.0 — and that is not timidity. A 2.0 card renders as
 * 「请升级至最新版本客户端，以查看内容」 on clients that predate it, which is
 * worse than a plain card: the reader believes the bot is broken. `form`,
 * `select_static` and `column_set` all exist in 1.0, so there is nothing here
 * that needs 2.0 in the first place.
 * @param view - the state as last read.
 * @returns a Feishu card object.
 */
export function panelCard(view) {
    const elements = [
        {
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `会话 \`${view.sessionId}\`\n${describeUsage(view.contextUsed, view.contextWindow)}`,
            },
        },
    ];
    PANEL_SECTIONS.forEach((section, index) => {
        if (index > 0)
            elements.push({ tag: 'hr' });
        elements.push(...section(view).elements);
    });
    return {
        config: { wide_screen_mode: true },
        header: { template: 'blue', title: plainText('🎛 DSH 控制台') },
        elements,
    };
}
/**
 * The value one submitted form carries.
 *
 * A section's form holds exactly one control, so the sole submitted value is
 * that control's answer whatever its name turned out to be.
 * @param formValue - `action.formValue` as the channel SDK hands it over.
 * @returns the value, or undefined when nothing was submitted.
 */
export function panelFormValue(formValue) {
    if (formValue === undefined)
        return undefined;
    for (const value of Object.values(formValue)) {
        if (typeof value === 'string' && value !== '')
            return value;
    }
    return undefined;
}
/**
 * Turn one card interaction into the effect it means.
 *
 * Every refusal names what was wrong, because a button that silently does
 * nothing is indistinguishable from a bridge that is broken.
 * @param action - the parsed button/form payload.
 * @param submitted - the value its form carried, when it was a form submit.
 * @returns the effect the bridge should perform.
 */
export function resolvePanelAction(action, submitted) {
    if (action.section === 'actions') {
        if (action.op === 'refresh')
            return { kind: 'refresh' };
        if (action.op === 'new-session')
            return { kind: 'new-session' };
        return { kind: 'invalid', reason: `不认识的动作 ${action.op}` };
    }
    if (action.section === 'model' && action.op === 'set') {
        if (submitted === undefined)
            return { kind: 'invalid', reason: '没有拿到选择的模型' };
        // `provider/model`, split at the FIRST slash: model ids may contain slashes
        // (`openrouter/anthropic/claude-…`), provider routes may not.
        const slash = submitted.indexOf('/');
        if (slash <= 0 || slash === submitted.length - 1) {
            return { kind: 'invalid', reason: '这个模型标识看不懂' };
        }
        return {
            kind: 'set-model',
            provider: submitted.slice(0, slash),
            model: submitted.slice(slash + 1),
        };
    }
    if (action.section === 'workspace' && action.op === 'set') {
        if (submitted === undefined)
            return { kind: 'invalid', reason: '没有拿到选择的工作区' };
        return { kind: 'set-workspace', path: submitted };
    }
    return { kind: 'invalid', reason: `不认识的面板节 ${action.section}` };
}
//# sourceMappingURL=panel.js.map