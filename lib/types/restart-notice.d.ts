/**
 * Restart completion notice. `/restart` has to answer before the process dies,
 * so the chat normally never hears when the service actually came back — and
 * "did it restart at all, and when?" is the first thing the operator asks.
 * The command leaves a small record naming the requesting chat; the next boot
 * finds the record and posts one restored line with the wall-clock time and
 * the total downtime, then clears it.
 * @module dsh-lark-bridge/restart-notice
 */
/** How long a request stays eligible for a notice after the restart fires. */
export declare const NOTICE_TTL_MS: number;
/** A minimal outbound surface; satisfied by the channel port. */
export interface RestartNoticePort {
    /**
     * Send one chat message.
     * @param chatId - target chat.
     * @param message - markdown body.
     * @returns once the transport accepted the message.
     */
    send(chatId: string, message: {
        markdown: string;
    }): Promise<unknown>;
}
/** One `/restart` request, as left on disk for the next boot. */
export interface RestartRequest {
    /** The chat that asked for the restart. */
    readonly chatId: string;
    /** Wall-clock milliseconds when the command ran. */
    readonly requestedAt: number;
}
/**
 * The harness home the record lives in: `DSH_HOME` when set, else `~/.dsh`.
 * Local on purpose — the notice serves the machine whose process restarted.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export declare function restartNoticeHome(home?: string): string;
/**
 * Path of the pending-restart record.
 * @param home - override for tests.
 * @returns the record file path.
 */
export declare function restartNoticePath(home?: string): string;
/**
 * Record one restart request. Best effort: a restart must never be blocked by
 * a failed bookkeeping write.
 * @param chatId - the chat to notify on the next boot.
 * @param home - override for tests.
 * @returns true when the record was written.
 */
export declare function writeRestartRequest(chatId: string, home?: string): boolean;
/**
 * Read the record, dropping one that outlived its TTL (an old restart is old
 * news — this also covers a restart that never came back).
 * @param home - override for tests.
 * @param now - clock override for tests.
 * @returns the request, or null when none is pending.
 */
export declare function readRestartRequest(home?: string, now?: number): RestartRequest | null;
/**
 * Drop the pending record once its notice has been delivered.
 * @param home - override for tests.
 */
export declare function clearRestartRequest(home?: string): void;
/**
 * The restored line: when the service came back and how long it was away.
 * @param request - the pending request.
 * @param now - delivery time, milliseconds.
 * @returns markdown for the chat.
 */
export declare function restartNoticeLine(request: RestartRequest, now?: number): string;
/**
 * Deliver the pending notice once, if any: reads, sends, clears.
 * @param port - the channel's outbound surface.
 * @param report - operator log for a failed delivery (the record is kept for retry).
 * @param options - home/time overrides for tests.
 * @returns 'sent' when this call delivered it, 'none' without a record, 'retry' on a failed send.
 */
export declare function deliverRestartNotice(port: RestartNoticePort, report: (line: string) => void, options?: {
    home?: string;
    now?: number;
}): Promise<'sent' | 'none' | 'retry'>;
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
export declare function scheduleRestartNotice(port: RestartNoticePort, report: (line: string) => void, options?: {
    home?: string;
    intervalMs?: number;
    maxAttempts?: number;
}): () => void;
//# sourceMappingURL=restart-notice.d.ts.map