/**
 * The thinking process as a native CoT message.
 *
 * Feishu carries an agent's process as its own message, driven by AG-UI events,
 * and renders it the way the platform's own agents look: reasoning streams into
 * a thinking area, each tool call gets an icon and a title, each result gets a
 * code block. That vocabulary lines up with the host's session events almost
 * one to one, so this renderer translates rather than draws — and the final
 * answer goes where the platform says it belongs, in an ordinary message.
 * @module dsh-lark-bridge/cot
 */
import type { OutboundRenderer, ToolPresentation } from './outbound.ts';
import type { Limits } from './config.ts';
/** One AG-UI event, as the write API takes it. */
export interface CotEvent {
    readonly event_type: string;
    /** The event's own fields, JSON-encoded; the API caps one at 4096 characters. */
    readonly content: string;
    /** Milliseconds, as a string, used by the client to order events. */
    readonly timestamp: string;
}
/** A created thinking process, addressed by both ids on every write. */
export interface CotHandle {
    readonly cotId: string;
    readonly messageId: string;
}
/** The CoT operations this renderer drives. */
export interface CotPort {
    /** Open a thinking process in one chat, optionally aimed at the message that asked. */
    createCot(chatId: string, options: {
        replyTo?: string;
        hidden: boolean;
    }): Promise<CotHandle>;
    /** Append events to one thinking process, in order. */
    writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void>;
}
/**
 * Summarise one tool call's arguments for the chat.
 *
 * @param argumentsJson - the arguments as the host delivered them.
 * @param maxValueChars - how much of one kept value to show.
 * @returns a short description of what the call was for.
 */
export declare function summariseArguments(argumentsJson: string, maxValueChars?: number): string;
/**
 * What a file-writing tool call actually changed, for the thinking area.
 *
 * 写文件、改文件的过程，「改了哪儿」才是读者要的信息：只回一句 `已写入` 等于
 * 让人去翻会话记录。所以这里把改动本身渲染出来——改文件用 `- 旧行 / + 新行`
 * 的 diff 形状，整份写入用 `+ 行`（没有旧内容可比时，全文就是这次改动）。
 *
 * 只认得出参数形状的工具才走这条路：`old_string/new_string`（edit 类）与
 * `content`（write 类）。认不出来的返回 undefined，调用方照旧走结果摘要。
 * @param name - the tool's name.
 * @param argumentsJson - the call's arguments, as the host delivered them.
 * @param maxChars - how much of the change the thinking area shows.
 * @returns the change as a code block's body, or undefined when this is not a file change.
 */
export declare function renderToolChange(name: string, argumentsJson: string, maxChars?: number): string | undefined;
/** Options for {@link createCotRenderer}. */
export interface CotRendererOptions {
    /** Whether the agent's reasoning and tool calls appear at all. */
    readonly showProcess: boolean;
    /** Whether the platform hides the process once the run finishes. */
    readonly hidden: boolean;
    /** The tool's own label and kind for one call. */
    readonly presentCall: ToolPresentation;
    /** Report a handled failure to the operator. */
    readonly onFailure: (error: unknown) => void;
    /** Renders the answer itself; the thinking process deliberately carries none. */
    readonly answer: OutboundRenderer;
    /** Elision budgets for reasoning, arguments and results; defaults when absent. */
    readonly limits?: Limits;
    /**
     * What this run is actually running as, read at the moment the run opens.
     *
     * A reader watching a process scroll past cannot tell which model produced it
     * or which directory it is working in — and after a mid-conversation switch
     * those are exactly the two facts worth confirming. It is a callback, not a
     * value: the renderer is built once per chat and outlives many model or
     * workspace changes.
     */
    readonly banner?: () => CotBanner | undefined;
}
/** One run's opening summary: what produced it, and where. */
export interface CotBanner {
    /** `provider/model` as the next request will send it. */
    readonly model?: string;
    /** The reasoning effort in force, when one is set. */
    readonly effort?: string;
    /** The directory this session runs in. */
    readonly workspace?: string;
}
/** The id prefix the banner's text message carries, so consumers can tell it apart. */
export declare const COT_BANNER_PREFIX = "banner-";
/**
 * The banner line: `模型（档位） \`工作区\``, as much of it as is known.
 *
 * **Windows 路径必须包在反引号里。** 这条文本走的是 TEXT_MESSAGE 的 delta，
 * 客户端按 Markdown 渲染：裸写 `D:\Desktop` 时反斜杠会被当成转义符吃掉，读者
 * 看到的是 `D:Desktop`（2026-11-11 操作者现场报的就是这个）。行内代码不做转义，
 * 路径原样显示，也顺便和模型名区分开。
 * @param banner - what the run is running as.
 * @returns the line, or '' when nothing is known.
 */
export declare function cotBannerText(banner: CotBanner): string;
/**
 * Renderer that shows the process as a native CoT message and leaves the answer
 * to `answer`. Falling back is the caller's job: when {@link CotPort.createCot}
 * rejects, this renderer reports it and the turn still answers, because the
 * answer never depended on the thinking process existing.
 * @param port - the CoT operations.
 * @param chatId - the owned chat.
 * @param options - what to show, and where the answer goes.
 * @returns the renderer.
 */
export declare function createCotRenderer(port: CotPort, chatId: string, options: CotRendererOptions): OutboundRenderer;
//# sourceMappingURL=cot.d.ts.map