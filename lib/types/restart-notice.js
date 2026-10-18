/**
 * Restart completion notice. `/restart` has to answer before the process dies,
 * so the chat normally never hears when the service actually came back — and
 * "did it restart at all, and when?" is the first thing the operator asks.
 * The command leaves a small record naming the requesting chat; the next boot
 * finds the record and posts one restored line with the wall-clock time and
 * the total downtime, then clears it.
 * @module dsh-lark-bridge/restart-notice
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
/** How long a request stays eligible for a notice after the restart fires. */
export const NOTICE_TTL_MS = 15 * 60 * 1000;
/**
 * The harness home the record lives in: `DSH_HOME` when set, else `~/.dsh`.
 * Local on purpose — the notice serves the machine whose process restarted.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export function restartNoticeHome(home) {
    return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh');
}
/**
 * Path of the pending-restart record.
 * @param home - override for tests.
 * @returns the record file path.
 */
export function restartNoticePath(home) {
    return path.join(restartNoticeHome(home), '.restart-notice.json');
}
/**
 * Record one restart request. Best effort: a restart must never be blocked by
 * a failed bookkeeping write.
 * @param chatId - the chat to notify on the next boot.
 * @param home - override for tests.
 * @returns true when the record was written.
 */
export function writeRestartRequest(chatId, home) {
    try {
        const file = restartNoticePath(home);
        // The home directory usually exists on a live deployment, but a first run
        // (or a moved DSH_HOME) must not silently lose the restored notice.
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ chatId, requestedAt: Date.now() }), 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Read the record, dropping one that outlived its TTL (an old restart is old
 * news — this also covers a restart that never came back).
 * @param home - override for tests.
 * @param now - clock override for tests.
 * @returns the request, or null when none is pending.
 */
export function readRestartRequest(home, now = Date.now()) {
    let raw;
    try {
        raw = readFileSync(restartNoticePath(home), 'utf8');
    }
    catch {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (typeof value.chatId !== 'string' || value.chatId === '' || typeof value.requestedAt !== 'number') {
            rmSync(restartNoticePath(home), { force: true });
            return null;
        }
        const request = { chatId: value.chatId, requestedAt: value.requestedAt };
        const age = now - request.requestedAt;
        if (age > NOTICE_TTL_MS || age < -60_000) {
            rmSync(restartNoticePath(home), { force: true });
            return null;
        }
        return request;
    }
    catch {
        rmSync(restartNoticePath(home), { force: true });
        return null;
    }
}
/**
 * Drop the pending record once its notice has been delivered.
 * @param home - override for tests.
 */
export function clearRestartRequest(home) {
    rmSync(restartNoticePath(home), { force: true });
}
/**
 * The restored line: when the service came back and how long it was away.
 * @param request - the pending request.
 * @param now - delivery time, milliseconds.
 * @returns markdown for the chat.
 */
export function restartNoticeLine(request, now = Date.now()) {
    const at = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
    const seconds = Math.max(0, Math.round((now - request.requestedAt) / 1000));
    const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
    return `✅ 重启完成：服务已于 ${at} 恢复，本次重启共约 ${duration}（自 /restart 起算）。`;
}
/**
 * Deliver the pending notice once, if any: reads, sends, clears.
 * @param port - the channel's outbound surface.
 * @param report - operator log for a failed delivery (the record is kept for retry).
 * @param options - home/time overrides for tests.
 * @returns 'sent' when this call delivered it, 'none' without a record, 'retry' on a failed send.
 */
export async function deliverRestartNotice(port, report, options = {}) {
    const request = readRestartRequest(options.home, options.now ?? Date.now());
    if (request === null)
        return 'none';
    try {
        await port.send(request.chatId, { markdown: restartNoticeLine(request, options.now ?? Date.now()) });
    }
    catch (error) {
        report(`dsh-lark-bridge: restart notice delivery failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
        return 'retry';
    }
    clearRestartRequest(options.home);
    return 'sent';
}
/**
 * Boot-side delivery loop: the transport is usually still connecting right
 * after a restart, so attempts repeat until the notice is delivered, the
 * attempts run out, or the record goes stale. The timer is unref'd — it must
 * never hold the process open on its own.
 * @param port - the channel's outbound surface.
 * @param report - operator log sink.
 * @param options - home/interval/attempt overrides for tests.
 * @returns a stopper that cancels the loop.
 */
export function scheduleRestartNotice(port, report, options = {}) {
    const intervalMs = options.intervalMs ?? 15_000;
    const maxAttempts = options.maxAttempts ?? 20;
    let attempts = 0;
    let stopped = false;
    let inFlight = false;
    let timer;
    const stop = () => {
        stopped = true;
        if (timer !== undefined)
            clearInterval(timer);
    };
    const tick = () => {
        // A slow send must not overlap the next tick: without this guard an
        // interval shorter than one delivery posted the notice several times.
        if (stopped || inFlight)
            return;
        inFlight = true;
        attempts += 1;
        void deliverRestartNotice(port, report, options.home === undefined ? {} : { home: options.home }).then((result) => {
            inFlight = false;
            if (result === 'retry' && attempts < maxAttempts)
                return;
            stop();
        }, () => { inFlight = false; stop(); });
    };
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    tick();
    return stop;
}
//# sourceMappingURL=restart-notice.js.map