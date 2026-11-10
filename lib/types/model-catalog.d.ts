/**
 * The live model catalogue behind `/model`.
 *
 * The host already knows which provider routes exist (`llm.listProviders()`) and
 * each adapter knows what it serves (`llm.listModels(provider)`). The bridge used
 * to ignore both and print a hand-written `modelCatalog` list instead — which is
 * why `/model` could not answer "what models are available" on a deployment that
 * never filled that list in.
 *
 * Two things make this less trivial than it reads:
 *
 * - Discovery can be slow or unavailable. An adapter that has to call the
 *   provider's API may hang, and one dead provider must not cost the reader the
 *   other providers' lists. So each provider is settled independently and a
 *   failure simply contributes nothing.
 * - The numbered menu has to stay usable. A reader picks by number, so the
 *   numbering has to be stable between "show" and "switch" — which means the
 *   listing is cached, briefly, rather than re-queried on every keystroke.
 * @module dsh-lark-bridge/model-catalog
 */
import type { HostLlm } from './host.ts';
/** One selectable model, flattened with the provider it belongs to. */
export interface ModelEntry {
    /** Route key used in a selection. */
    readonly provider: string;
    /** Human-readable provider name, for grouping. */
    readonly providerName: string;
    /** Exact model id passed to the adapter. */
    readonly id: string;
    /** Human-readable model name. */
    readonly name: string;
    /** Optional one-line distinction. */
    readonly description?: string;
}
/** How long one discovery result is reused by the numbered menu. */
export declare const CATALOG_TTL_MS: number;
/** The most models one reply may list before it is truncated. */
export declare const CATALOG_MAX_ROWS = 40;
/**
 * Discover every model the host can route to.
 *
 * Providers are queried in parallel and settled independently: a provider whose
 * discovery throws, times out, or returns nothing is dropped without affecting
 * the rest.
 * @param llm - the host llm runtime, when composed.
 * @param now - current time, for the cache.
 * @returns the flattened catalogue, empty when the host exposes no listing.
 */
export declare function discoverModels(llm: HostLlm | undefined, now?: number): Promise<readonly ModelEntry[]>;
/**
 * The catalogue most recently discovered, if it is still fresh.
 *
 * The numbered menu reads this rather than rediscovering: the list a reader is
 * looking at is the list their number must resolve against.
 * @param now - current time.
 * @returns the cached entries, or undefined when none is fresh.
 */
export declare function cachedModels(now?: number): readonly ModelEntry[] | undefined;
/**
 * Resolve one 1-based menu number against the cached catalogue.
 * @param index - the number the reader typed, 1-based.
 * @returns the entry it names, or undefined when the number is out of range.
 */
export declare function modelByNumber(index: number): ModelEntry | undefined;
/**
 * Render the catalogue as a numbered menu grouped by provider.
 * @param entries - what discovery returned.
 * @param current - the active `provider/model`, marked in the list.
 * @param maxRows - how many models to list before truncating.
 * @returns markdown for the chat.
 */
export declare function formatModelCatalog(entries: readonly ModelEntry[], current: string, maxRows?: number): string;
//# sourceMappingURL=model-catalog.d.ts.map