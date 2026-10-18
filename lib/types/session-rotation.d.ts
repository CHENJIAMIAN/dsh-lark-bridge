/**
 * Session rotations: `/new` moves a conversation to a fresh session while the
 * previous one stays stored. The mapping must survive a restart, so the store
 * keeps `conversationKey → current session id` in the harness home; a
 * conversation with no recorded rotation resolves to its original, derived id.
 * @module dsh-lark-bridge/session-rotation
 */
/** The read/write seam {@link createRotationStore} satisfies. */
export interface RotationStore {
    /**
     * The session id one conversation currently runs on.
     * @param key - a conversation key from `conversationKey`.
     * @returns the rotated id, or undefined when the conversation never rotated.
     */
    current(key: string): string | undefined;
    /**
     * Persist the conversation's new session id.
     * @param key - a conversation key.
     * @param sessionId - the freshly created session id.
     */
    record(key: string, sessionId: string): void;
}
/**
 * The harness home the rotation file lives in: `DSH_HOME` when set, else
 * `~/.dsh`. Local on purpose — a rotation names an id on this machine.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export declare function rotationHome(home?: string): string;
/**
 * Path of the rotation file.
 * @param home - override for tests.
 * @returns the file path.
 */
export declare function rotationPath(home?: string): string;
/**
 * The next rotated session id for one conversation: the derived id plus a
 * sortable stamp, so every rotation is a fresh id and the original remains
 * addressable for history lookups.
 * @param baseSessionId - the conversation's derived id (from `sessionIdFor`).
 * @param now - clock override for tests.
 * @returns the new session id.
 */
export declare function rotatedSessionId(baseSessionId: string, now?: number): string;
/**
 * A JSON-backed {@link RotationStore}, cached in memory. A missing or
 * unparsable file reads as "no rotations"; writes go through a rename so a
 * crash mid-write cannot truncate the map.
 * @param home - override for tests.
 * @returns the store.
 */
export declare function createRotationStore(home?: string): RotationStore;
//# sourceMappingURL=session-rotation.d.ts.map