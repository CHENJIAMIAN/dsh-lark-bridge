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
import type { ModelEntry } from './model-catalog.ts';
/** The card-button / form-submit payload the console uses. */
export declare const PANEL_ACTION = "dsh-lark-bridge/panel";
/** One console interaction, as the card reports it. */
export interface PanelActionValue {
    /** Section that owns the control. */
    readonly section: string;
    /** What the section should do with it. */
    readonly op: string;
    /** The chosen value, when the control carries one. */
    readonly value?: string;
}
/**
 * Narrow an arbitrary card-action value to this plugin's console payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export declare function panelActionValue(value: unknown): PanelActionValue | undefined;
/** Everything one rendering of the console needs to draw itself. */
export interface PanelView {
    /** Session the card acts on. */
    readonly sessionId: string;
    /** The active `provider/model`, as a selection key. */
    readonly currentModel: string;
    /** Models the host can route to, in menu order. */
    readonly models: readonly ModelEntry[];
    /** Directory the next session would land in. */
    readonly currentWorkspace: string;
    /** Registered workspaces, as display paths. */
    readonly workspaces: readonly string[];
    /** Context usage, when the meter can read it. */
    readonly contextUsed?: number;
    /** Context window, when the host reports one. */
    readonly contextWindow?: number;
}
/** A group of card elements contributed by one section. */
export interface PanelSectionRender {
    /** Section id, used to route its actions back. */
    readonly id: string;
    /** Elements appended to the card body, in order. */
    readonly elements: object[];
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
export declare const PANEL_CHOICES_MAX = 40;
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
declare function modelSection(view: PanelView): PanelSectionRender;
/**
 * The workspace section: a dropdown of registered directories.
 *
 * Same shape as the model section on purpose — a reader who learned one learned
 * both. An empty registry still shows the current directory, so the card never
 * says it knows nothing about where sessions land.
 * @param view - the state being rendered.
 * @returns the section's elements.
 */
declare function workspaceSection(view: PanelView): PanelSectionRender;
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
declare function actionsSection(_view: PanelView): PanelSectionRender;
/** The sections this card is made of, in display order. */
export declare const PANEL_SECTIONS: readonly [typeof modelSection, typeof workspaceSection, typeof actionsSection];
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
export declare function panelCard(view: PanelView): object;
/** One chat's managed card entity and the sequence its next update must carry. */
export interface ConsoleEntityState {
    readonly cardId: string;
    readonly sequence: number;
}
/**
 * The card entity each chat owns, with strictly increasing update sequences.
 *
 * `cardkit.v1.card.update` rejects a sequence that is not greater than the last
 * one accepted, so the counter has to live exactly as long as the entity.
 * Keeping it in one place also makes the two decisions — "no entity yet, create
 * one" and "entity exists, update it" — impossible to get out of sync.
 */
export declare function createConsoleCardStore(): {
    /** The next action for a chat, given its current state. */
    planFor(chatId: string): {
        readonly kind: 'create';
    } | {
        readonly kind: 'update';
        readonly cardId: string;
        readonly sequence: number;
    };
    /** Record a newly created entity. */
    created(chatId: string, cardId: string): void;
    /** Record a successful update (only then may the sequence advance). */
    updated(chatId: string, sequence: number): void;
    /** Drop a stale entity so the next call creates a fresh one. */
    forget(chatId: string): void;
};
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
export declare function panelFormValue(formValue: Record<string, unknown> | undefined): string | undefined;
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
export declare function panelSubmitted(action: {
    readonly formValue?: Record<string, unknown> | undefined;
    readonly option?: string | undefined;
}): string | undefined;
/**
 * What one console interaction asks the bridge to do.
 *
 * Kept as data rather than as side effects so the routing decision is testable
 * without a live host: the question "does a submitted model actually become a
 * set-model effect, and does a malformed one become an error" is a pure question,
 * and it is the half that tends to be wrong.
 */
export type PanelEffect = {
    readonly kind: 'set-model';
    readonly provider: string;
    readonly model: string;
} | {
    readonly kind: 'set-workspace';
    readonly path: string;
} | {
    readonly kind: 'new-session';
} | {
    readonly kind: 'refresh';
} | {
    readonly kind: 'invalid';
    readonly reason: string;
};
/**
 * Turn one card interaction into the effect it means.
 *
 * Every refusal names what was wrong, because a button that silently does
 * nothing is indistinguishable from a bridge that is broken.
 * @param action - the parsed button/form payload.
 * @param submitted - the value its form carried, when it was a form submit.
 * @returns the effect the bridge should perform.
 */
export declare function resolvePanelAction(action: PanelActionValue, submitted: string | undefined): PanelEffect;
export {};
//# sourceMappingURL=panel.d.ts.map