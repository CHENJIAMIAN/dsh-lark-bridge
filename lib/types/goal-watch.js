/**
 * Which conversations still hold an active goal, kept across a host restart.
 *
 * A goal is durable in the session log, but its *continuation authority* is not:
 * after a restart the runtime leaves it `disarmed` and waits for the next human
 * message before re-arming. That is a deliberate safety default, and it is why
 * a long task silently stops being driven the moment the bridge is deployed to.
 *
 * The bridge cannot enumerate the host's goals — the service only answers
 * `get(agent)`, which needs an agent it has not opened yet. So the sessions that
 * matter are recorded here as they become active, and a boot reads this list
 * back to decide which ones to re-open and re-arm.
 *
 * The file is local on purpose: a session id names something on this machine.
 * @module dsh-lark-bridge/goal-watch
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
/** How long an entry survives without a refresh. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The harness home the watch file lives in: `DSH_HOME` when set, else `~/.dsh`.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export function goalWatchHome(home) {
    return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh');
}
/**
 * Path of the watch file.
 * @param home - override for tests.
 * @returns the file path.
 */
export function goalWatchFile(home) {
    return path.join(goalWatchHome(home), 'lark-bridge-goals.json');
}
/**
 * Build the watch store.
 * @param home - harness home override (tests).
 * @returns the store the bridge drives.
 */
export function createGoalWatch(home) {
    const file = goalWatchFile(home);
    let cache;
    const load = () => {
        if (cache !== undefined)
            return cache;
        try {
            const raw = readFileSync(file, 'utf8');
            const parsed = JSON.parse(raw);
            const rows = Array.isArray(parsed.goals) ? parsed.goals : [];
            const cutoff = Date.now() - STALE_MS;
            cache = rows.filter((row) => {
                if (typeof row !== 'object' || row === null)
                    return false;
                const entry = row;
                if (typeof entry.sessionId !== 'string' || typeof entry.chatId !== 'string')
                    return false;
                if (typeof entry.objective !== 'string' || typeof entry.seenAt !== 'string')
                    return false;
                const seen = Date.parse(entry.seenAt);
                return Number.isFinite(seen) && seen >= cutoff;
            });
        }
        catch {
            // A missing or corrupt file is the normal first-boot state, not an error.
            cache = [];
        }
        return cache;
    };
    const persist = (entries) => {
        cache = [...entries];
        try {
            mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ version: 1, goals: entries }, null, 2), 'utf8');
            // Atomic replace: a crash mid-write must not leave an unparseable file
            // that silently disables re-arming on the next boot.
            renameSync(tmp, file);
            return true;
        }
        catch {
            // The in-process cache still holds; only a restart would lose it.
            return false;
        }
    };
    return {
        remember(entry) {
            const now = new Date().toISOString();
            const next = load().filter(row => row.sessionId !== entry.sessionId);
            next.unshift({ ...entry, seenAt: now });
            persist(next);
        },
        forget(sessionId) {
            const current = load();
            if (!current.some(row => row.sessionId === sessionId))
                return;
            persist(current.filter(row => row.sessionId !== sessionId));
        },
        pending() {
            return [...load()].sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt));
        },
    };
}
//# sourceMappingURL=goal-watch.js.map