/**
 * Which overdue occurrences the bridge has already told the human about.
 *
 * The watchdog used to keep this in a plain in-memory Set. That survives a
 * long-running process but not a deploy: every restart re-announced the same
 * backlog, so a restart looked like "why is it telling me this again". A miss
 * is worth one notice per occurrence, not one per process lifetime.
 *
 * @module dsh-lark-bridge/overdue-seen
 */
/** Shape on disk: occurrence key -> when we first surfaced it. */
type Seen = Record<string, number>;
/** The harness home, matching the other bridge state files. */
export declare function seenHome(home?: string): string;
/** Where the notices are recorded. */
export declare function seenFile(home?: string): string;
/**
 * Read the recorded notices, dropping ones older than the retention window.
 * A missing or corrupt file reads as empty — a bad state file must never stop
 * the watchdog from noticing a real miss.
 * @param now - current epoch ms.
 * @param keepMs - how long a notice stays relevant.
 * @param home - override for tests.
 */
export declare function readSeen(now: number, keepMs: number, home?: string): Seen;
/**
 * Record one occurrence as surfaced. Atomic rename so a crash mid-write leaves
 * the previous file intact rather than a truncated one.
 * @param seen - the current notices.
 * @param key - the occurrence key (`id@scheduledAt`).
 * @param now - epoch ms to record.
 * @param home - override for tests.
 */
export declare function markSeen(seen: Seen, key: string, now: number, home?: string): void;
export {};
//# sourceMappingURL=overdue-seen.d.ts.map