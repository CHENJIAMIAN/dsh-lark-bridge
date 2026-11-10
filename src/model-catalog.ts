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

import type { HostLlm } from './host.ts'

/** One selectable model, flattened with the provider it belongs to. */
export interface ModelEntry {
  /** Route key used in a selection. */
  readonly provider: string
  /** Human-readable provider name, for grouping. */
  readonly providerName: string
  /** Exact model id passed to the adapter. */
  readonly id: string
  /** Human-readable model name. */
  readonly name: string
  /** Optional one-line distinction. */
  readonly description?: string
}

/** How long one discovery result is reused by the numbered menu. */
export const CATALOG_TTL_MS = 5 * 60_000

/** How long a single provider may take before it is written off. */
const PER_PROVIDER_TIMEOUT_MS = 4_000

/** The most models one reply may list before it is truncated. */
export const CATALOG_MAX_ROWS = 40

/** What the last discovery produced, and when. */
interface Cached {
  readonly at: number
  readonly entries: readonly ModelEntry[]
}

let cache: Cached | undefined

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
export async function discoverModels(llm: HostLlm | undefined, now: number = Date.now()): Promise<readonly ModelEntry[]> {
  if (llm?.listProviders === undefined || llm.listModels === undefined) return []
  let providers: readonly { readonly id: string; readonly name: string }[]
  try {
    providers = llm.listProviders()
  } catch {
    return []
  }
  const perProvider = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await withTimeout(llm.listModels!(provider.id), PER_PROVIDER_TIMEOUT_MS)
      return models.map(model => ({
        provider: model.provider === '' ? provider.id : model.provider,
        providerName: provider.name === '' ? provider.id : provider.name,
        id: model.id,
        name: model.name === '' ? model.id : model.name,
        ...model.description === undefined ? {} : { description: model.description },
      }))
    } catch {
      // A dead or slow provider contributes nothing; the others still list.
      return []
    }
  }))
  const entries = perProvider.flat()
  cache = { at: now, entries }
  return entries
}

/**
 * The catalogue most recently discovered, if it is still fresh.
 *
 * The numbered menu reads this rather than rediscovering: the list a reader is
 * looking at is the list their number must resolve against.
 * @param now - current time.
 * @returns the cached entries, or undefined when none is fresh.
 */
export function cachedModels(now: number = Date.now()): readonly ModelEntry[] | undefined {
  if (cache === undefined) return undefined
  return now - cache.at > CATALOG_TTL_MS ? undefined : cache.entries
}

/**
 * Resolve one 1-based menu number against the cached catalogue.
 * @param index - the number the reader typed, 1-based.
 * @returns the entry it names, or undefined when the number is out of range.
 */
export function modelByNumber(index: number): ModelEntry | undefined {
  const entries = cachedModels()
  return entries?.[index - 1]
}

/**
 * Render the catalogue as a numbered menu grouped by provider.
 * @param entries - what discovery returned.
 * @param current - the active `provider/model`, marked in the list.
 * @param maxRows - how many models to list before truncating.
 * @returns markdown for the chat.
 */
export function formatModelCatalog(
  entries: readonly ModelEntry[],
  current: string,
  maxRows: number = CATALOG_MAX_ROWS,
): string {
  const shown = entries.slice(0, maxRows)
  const lines: string[] = []
  let lastProvider = ''
  shown.forEach((entry, i) => {
    if (entry.provider !== lastProvider) {
      if (lines.length > 0) lines.push('')
      lines.push(`**${entry.providerName}**`)
      lastProvider = entry.provider
    }
    const key = `${entry.provider}/${entry.id}`
    const mark = key === current ? ' ← 当前' : ''
    lines.push(`${i + 1}. ${entry.name}${mark}`)
  })
  const hidden = entries.length - shown.length
  const tail = hidden > 0 ? `\n\n… 还有 ${hidden} 个没列出` : ''
  return `**可用模型**（当前：\`${current}\`）\n\n${lines.join('\n')}${tail}\n\n切换：\`/model <编号>\` 或 \`/model <provider>/<model>\``
}

/** Reject after `ms`, so a hung discovery cannot stall the command. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}
