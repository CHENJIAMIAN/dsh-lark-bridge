/**
 * Native Feishu capabilities as agent-callable tools.
 *
 * The bridge already renders the agent TO the human; this module lets the
 * agent act on Feishu itself — proactive messages into the current (or any
 * known) chat, and the app's own cloud-drive space as a durable scratchpad.
 * Both ride capabilities the channel already owns: outbound transport for
 * messages, the FeishuCloud client (built for fleet arbitration/migration)
 * for the drive. Tools follow the `send_file` factory pattern: plain
 * definition objects, the outcome in the result, never a throw across the
 * tool boundary.
 * @module dsh-lark-bridge/feishu-tools
 */
import type { ModelEntry } from './model-catalog.ts';
import type { OutboundPort } from './outbound.ts';
import type { FeishuCredentials, FetchImpl } from './sync/feishu-cloud.ts';
/** Tool names, exported for tests and deny-list references. */
export declare const FEISHU_NOTIFY_TOOL = "feishu_notify";
export declare const FEISHU_DRIVE_WRITE_TOOL = "feishu_drive_write";
export declare const FEISHU_DRIVE_READ_TOOL = "feishu_drive_read";
export declare const FEISHU_DRIVE_LIST_TOOL = "feishu_drive_list";
export declare const BIND_WORKSPACE_TOOL = "bind_workspace";
export declare const SWITCH_MODEL_TOOL = "switch_model";
/** Capabilities the bridge injects at registration time. */
export interface FeishuToolDeps {
    /** Replay-wrapped outbound transport (queued across connection gaps). */
    readonly port: OutboundPort;
    /** Session id → chat id, so `feishu_notify` defaults to the current chat. */
    readonly chatOfSession: (sessionId: string) => string | undefined;
    /** Credentials for the drive tools; absent → those tools explain why. */
    readonly credentials: FeishuCredentials | undefined;
    /** HTTP seam for the drive client; injectable for tests. */
    readonly fetchImpl?: FetchImpl | undefined;
    /**
     * Bind this chat to a project directory (durable, per chat), or clear it with
     * `null`. Absent → `bind_workspace` explains that this deployment cannot.
     */
    readonly bindChatCwd?: (chatId: string, dir: string | null) => Promise<void>;
    /** The directory this chat's next session starts in. */
    readonly chatCwd?: (chatId: string) => Promise<string>;
    /**
     * 本会话的模型切换（`switch_model`）。
     *
     * 只动**本会话**的 route，写法和 `/think` 一致（`model/selection` 事件），
     * 对下一步请求就生效；不碰部署默认——那是 `/model` 的语义，会影响新会话。
     * 宿主没组合 llm 运行时就没有这份能力，工具会说明原因。
     */
    readonly modelSwitch?: ModelSwitchDeps;
}
/** `switch_model` 需要的那一小块能力。 */
export interface ModelSwitchDeps {
    /** 当前可路由的模型清单。 */
    readonly list: () => Promise<readonly ModelEntry[]>;
    /** 本会话此刻真正会发出去的 route（已含 override）。 */
    readonly current: (sessionId: string) => {
        readonly provider?: string;
        readonly model?: string;
    };
    /** 该 route 声明的思考强度档位；空数组表示模型没声明。 */
    readonly levels: (provider: string | undefined, model: string | undefined) => Promise<readonly string[]>;
    /** 写入本会话的选择（与 `/think` 同一条路径）。 */
    readonly apply: (sessionId: string, selection: {
        provider?: string;
        model?: string;
        reasoningEffort?: string;
    }) => void;
    /** 回到部署默认：丢掉本会话的 override。 */
    readonly reset: (sessionId: string) => void;
}
/**
 * The four definitions. `exec.agent.session.id` names the chat for
 * `feishu_notify` the same way `send_file` resolves its delivery target.
 */
export declare function createFeishuTools(deps: FeishuToolDeps): object[];
/** The prompt section text for the tools above (composeChatAgent registers it). */
export declare function feishuToolsPromptSection(): string;
//# sourceMappingURL=feishu-tools.d.ts.map