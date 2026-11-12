/**
 * The bridge's own state that has to survive a restart.
 *
 * 宿主持久的是**会话**（历史、模型选择、目标），桥自己那一层却全在内存里：等回答
 * 的提问、等确认的审批、`/tools disable` 的运行时禁用、各类卡片的消息 id、正在
 * 进行中的流式卡、以及「哪一轮被重启打断」。重启一次，这些就都消失，用户的感受
 * 是「问题点了没反应」「卡片不刷新了」「我禁掉的工具又回来了」。
 *
 * 这个模块只负责**存**，不负责怎么用：一个原子写的 JSON，读坏当空，条目带 24 小时
 * 过期（过期的待回答不该在第二天突然能点）。用它的地方在 `bridge.ts` 与
 * `questions.ts`。
 * @module dsh-lark-bridge/restart-state
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
/** How long an entry stays usable. A day-old pending question is not answerable. */
export const RESTART_STATE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The harness home this file lives in: `DSH_HOME` when set, else `~/.dsh`.
 * @param home - override for tests.
 * @returns the directory path (not created here).
 */
export function restartStateHome(home) {
    return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), '.dsh');
}
/**
 * Path of the state file.
 * @param home - override for tests.
 * @returns the file path.
 */
export function restartStateFile(home) {
    return path.join(restartStateHome(home), 'lark-bridge-restart.json');
}
/**
 * Read the persisted state, dropping anything stale or malformed.
 * @param file - the state file.
 * @returns the fresh state; empty when the file is missing or corrupt.
 */
function readState(file) {
    const cutoff = Date.now() - RESTART_STATE_TTL_MS;
    const fresh = (stamp) => {
        if (typeof stamp !== 'string')
            return false;
        const at = Date.parse(stamp);
        return Number.isFinite(at) && at >= cutoff;
    };
    let stored;
    try {
        stored = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        // A missing or corrupt file is the normal first-boot state, not an error:
        // a boot that cannot parse this must still start the bridge.
        return { questions: [], approvals: [], turns: [], cards: [], deniedTools: [] };
    }
    const list = (value) => (Array.isArray(value) ? value : []);
    const questions = list(stored.questions).filter((row) => {
        if (typeof row !== 'object' || row === null)
            return false;
        const entry = row;
        return typeof entry.token === 'string'
            && typeof entry.chatId === 'string'
            && typeof entry.sessionId === 'string'
            && Array.isArray(entry.questions)
            && fresh(entry.askedAt);
    });
    const approvals = list(stored.approvals).filter((row) => {
        if (typeof row !== 'object' || row === null)
            return false;
        const entry = row;
        return typeof entry.id === 'string'
            && typeof entry.chatId === 'string'
            && typeof entry.sessionId === 'string'
            && typeof entry.title === 'string'
            && fresh(entry.askedAt);
    });
    const turns = list(stored.turns).filter((row) => {
        if (typeof row !== 'object' || row === null)
            return false;
        const entry = row;
        return typeof entry.chatId === 'string'
            && typeof entry.sessionId === 'string'
            && typeof entry.turn === 'number'
            && fresh(entry.startedAt);
    });
    const cards = list(stored.cards).filter((row) => {
        if (typeof row !== 'object' || row === null)
            return false;
        const entry = row;
        return typeof entry.chatId === 'string'
            && typeof entry.kind === 'string'
            && typeof entry.messageId === 'string'
            && fresh(entry.updatedAt);
    });
    const deniedTools = list(stored.deniedTools).filter((row) => typeof row === 'string');
    return { questions, approvals, turns, cards, deniedTools };
}
/**
 * Write one state atomically.
 *
 * 写临时文件再 rename：半截写坏的文件会让下次开机读成空、悄悄丢掉所有待回答，
 * 而这正是这个模块要防的那类故障。
 * @param file - the state file.
 * @param state - what to write.
 * @returns whether it reached disk; the in-memory copy stays either way.
 */
function writeState(file, state) {
    try {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8');
        renameSync(tmp, file);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Build the store the bridge drives.
 * @param home - harness home override (tests).
 * @returns the store.
 */
export function createRestartStore(home) {
    const file = restartStateFile(home);
    let cache;
    const current = () => (cache ??= readState(file));
    const commit = (next) => {
        cache = next;
        writeState(file, next);
    };
    return {
        load() {
            return current();
        },
        rememberQuestion(question) {
            const state = current();
            commit({ ...state, questions: [question, ...state.questions.filter(row => row.token !== question.token)] });
        },
        forgetQuestion(token) {
            const state = current();
            if (!state.questions.some(row => row.token === token))
                return;
            commit({ ...state, questions: state.questions.filter(row => row.token !== token) });
        },
        rememberApproval(approval) {
            const state = current();
            commit({ ...state, approvals: [approval, ...state.approvals.filter(row => row.id !== approval.id)] });
        },
        forgetApproval(id) {
            const state = current();
            if (!state.approvals.some(row => row.id === id))
                return;
            commit({ ...state, approvals: state.approvals.filter(row => row.id !== id) });
        },
        rememberDeniedTools(tools) {
            const state = current();
            commit({ ...state, deniedTools: [...tools] });
        },
        startTurn(turn) {
            const state = current();
            commit({ ...state, turns: [turn, ...state.turns.filter(row => row.chatId !== turn.chatId)] });
        },
        endTurn(chatId) {
            const state = current();
            if (!state.turns.some(row => row.chatId === chatId))
                return;
            commit({ ...state, turns: state.turns.filter(row => row.chatId !== chatId) });
        },
        rememberCard(card) {
            const state = current();
            const rest = state.cards.filter(row => !(row.chatId === card.chatId && row.kind === card.kind));
            commit({ ...state, cards: [card, ...rest] });
        },
        forgetCard(chatId, kind) {
            const state = current();
            if (!state.cards.some(row => row.chatId === chatId && row.kind === kind))
                return;
            commit({ ...state, cards: state.cards.filter(row => !(row.chatId === chatId && row.kind === kind)) });
        },
    };
}
//# sourceMappingURL=restart-state.js.map