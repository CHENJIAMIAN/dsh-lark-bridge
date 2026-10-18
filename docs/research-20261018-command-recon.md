# dsh 引擎（0.2.1-alpha.2）与 dsh-lark-bridge 命令现状侦察

- 日期：2026-10-18（JST）· 全程只读（唯一写入=本报告；飞书凭据仅用于换取 token 实查，未打印、未落盘）
- 对象：引擎树 `<ENGINE_TREE>`、桥 `<REPO>`
- 结论速览：引擎命令 = compact/goal/plan/feedback/export/permission 六个；**无 new/reset/clear 类命令**；桥的 `/new`（及 `/clear`）是「文案已承诺、两边均未实现」；线上飞书面板 23 条命令中无 new。

---

## 1. 引擎 `/compact` 实现（packages/compaction/command-compact）

### 注册
- `ctx.commands.register({ definitionId: '@deepseek-ai/dsh-command-compact', name: 'compact', description: 'Compact older conversation history', handler })` — `src/index.ts:101-106`（LIFO 排空：注销前先等已启动 handler 结算，:97-100）。

### 返回给用户的结果结构（CommandResult = `{kind:'success'|'error', text, sourceEventSeq?}`）
- 成功：`text = "Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens)."`，并带 `sourceEventSeq = result.summarySeq`（呈现层据此归并到 compaction/summary）— `src/index.ts:69-73`。
- 无可压缩历史：`{kind:'success', text:'No compactable history yet.'}`（compactNow 返回 null 时）— `src/index.ts:68`。
  - null 的来源：`compactNow` 选范围返回 null（`compaction-basic/src/index.ts:394-399`）→ `selectCompactableRange` 的三处 null：无计价节点（`region.ts:123`）、保留尾覆盖全表面（`region.ts:141`）、工具调用对无法平衡到可切点（`region.ts:148`）。
- 带参数：`{kind:'error', text:'Usage: /compact (no arguments)'}` — `src/index.ts:63-64`。
- 预期失败的错误码映射（expectedFailure，全部 kind:'error'）— `src/index.ts:24-56`：
  - `busy` → "Compaction is unavailable because this process has an active compaction, or the agent is not idle."（:26-30）
  - `cancelled` → "Compaction cancelled."（:31-32）
  - `changed` → "The history selected for compaction changed before it could be replaced. …"（:33-37）
  - `summary` → "Compaction could not produce a useful summary. …"（:38-42）
  - `commit` → "Compaction did not finish cleanly; …"（:43-47）
  - `persistence` → "Compaction finished, but the session could not be saved."（:48-52）
- 取消：`invocation.signal.aborted` → 'Compaction cancelled.' — `src/index.ts:75`。
- 非预期异常不吞：直接 rethrow — `src/index.ts:76-77`。

### 会话事件
- `command/run` → handler → `command/done`（均 log-only，配对 commandId；done 携带 kind/text/sourceEventSeq）— 由 `commands.execute` 发出：`packages/interaction/commands/src/index.ts:373-386`；事件 schema：`packages/interaction/commands/src/types.ts:105-117`。
- `compaction/start`（含 `sourceCommandId`、`turn: number|null`；手动=null）、`compaction/summary`（summary、shadowedRange/Seqs/TokenCount、provider/model、usage…）、`compaction/end`（error? 释放锁）、`compaction/prune` — `packages/compaction/compaction/src/types.ts:24, 34-67, 72, 82-89`；替换内容由紧随 summary 的 `user/message` 承载（相邻性契约，types.ts:26-33）。
- 事务形态（先标记后执行）：同步 append `compaction/start` → 摘要 → 重验 → append `compaction/summary`+替换 → 恰好一次 `compaction/end` 尝试 — `compaction-basic/src/region.ts:157-171`；手动入口 `compactNow` 全貌 — `compaction-basic/src/index.ts:383-435`。

### 运行中轮次时的排队语义
- 轮次运行中：`compactNow` 先走 `agent.runMaintenance` — `compaction-basic/src/index.ts:390`；`runMaintenance` 在非 idle 时**同步抛** `agent "<id>" already has active work` — `packages/core/agent-loop/src/agent.ts:183-184`；compactNow 将其包成 `ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work')` — `compaction-basic/src/index.ts:428-434`。
- 已有活动压缩（durable 锁）：`"${stage}: compaction already in progress; the session compaction lock is already active"` — `compaction-basic/src/region.ts:313-319`；manual 且 openTurn 非空：'manual compaction: the session already has an open turn' — `region.ts:193-195`。
- 压缩运行期间用户提交的提示词**仍按 FIFO 被接纳**，仅在持久检查点与 idle 任务结算后启动；`/compact` 命令本身不排队（busy 直接拒绝）— `compaction/src/index.ts:142-151`、`command-compact/README.zh.md:69, 91, 140, 152`。
- maintenance 期间的 wake 请求被 latch，结算后重放 — `agent.ts:200, 214-223`。
- 取消包装：agent 信号中止 → `ManualCompactionError('cancelled', …)` — `compaction-basic/src/index.ts:417-422`。

---

## 2. 引擎命令全集（`ctx.commands.register` 调用点）

| 命令 | 包 | 注册位置 |
|---|---|---|
| compact | packages/compaction/command-compact | `src/index.ts:101-106` |
| goal | packages/goal/command-goal | `src/index.ts:191-197`（input: `[<objective>|clear|edit…]`，attachments:true）|
| plan | packages/plan/plan-mode | `src/index.ts:230-235`（`ctx.inject(['commands'])` 子级）|
| feedback | packages/feedback/command-feedback | `src/index.ts:119-126`（recordInput:false）|
| export | packages/session-query/session-log-export | `src/index.ts:79-86`（Web-only）|
| permission | packages/interaction/permission-presets | `src/index.ts:256-264`（`ctx.inject(['commands'])`）|

- 全套清单由客户端测试枚举印证：`[compact, export, feedback, goal, permission, plan]` — `packages/client/ui-commands/tests/service.client.spec.ts:325, 362-367`。
- 非宿主命令一例（供区分）：client 侧 FileCommandRegistry 的 `file` 输入动作 — `packages/client/ui-conversation/src/client/apply.ts:271-280`，不在 commands 注册表。
- **无「新会话/重置/清空」类命令**：全树搜 `name: 'new'|'reset'|'clear'`、`CommandDefinitionId('@deepseek-ai/dsh-(new|reset|clear)…)` 均无命中（仅无关测试字符串）。引擎命令层不存在 new/reset/clear。

---

## 3. 会话创建能力（宿主侧）

### 桥的入口（ladder）
- `SessionLadder = {lookup, resume, create}` — `dsh-lark-bridge/src/session.ts:86-113`；acquire 走 lookup→resume→create 三级（`session.ts:222-245`）。
- 实现：`lookup = agents.get`；`resume = agents.resume({resumeSessionId, agentOptions, setup})`；`create = agents.create({sessionId, meta{cwd, agentPreset}, agentOptions, setup})` — `bridge.ts:1087-1139`（create 后被记入 `freshlyCreated`，:1084-1085, 1123）。

### 引擎核心（cordis service）
- `ctx.sessions.create(id?, options?)` — `packages/core/session/src/index.ts:1110`；`prepare`：省略 id ⇒ 铸 `session-${++counter}`（带碰撞循环 `while (this.store.has(...))`）— `index.ts:1144-1146`；显式 id 且内存中已存在 ⇒ `throw new Error('session "…" already exists')` — `index.ts:1150`。

### Session Controller（Web/API 宿主）
- Remote `create` — `packages/api/session-controller/src/index.ts:280-282` → `SessionCommandController.create` — `src/commands.ts:105`。
- **受支持的新 id 生成**：`request.sessionId ?? brandString('session-' + randomUUID())` — `commands.ts:109`。
- 显式 id + **磁盘已有会话 ⇒ 不碰撞**：`createOrAdopt` 用 `sessionQuery.observeSession` 探测，命中即 `agents.resume`（adopt 语义）— `src/agent.ts:457-477`；仅当 cwd 不符（`ApiSessionCwdConflict`，定义 agent.ts:30-43，抛点 463-465）／preset 不符（`ApiSessionPresetConflict`，45-48）／subagent 归属（23-28, 452-453）时报错；磁盘无记录才 `agents.create` — agent.ts:480-494。
- 客户端：`ClientSessions.create({workspaceId?, cwd?, sessionId?})` — `src/client/sessions/service.ts:434` → `manager.create` — `src/client/sessions/manager.ts:508-519` → `remote.session.create`。

### 对桥的含义（事实性）
- 桥 id 由 `conversationKey` 确定性拼接：`feishu-<chatId>[:threadId|senderId]` — `dsh-lark-bridge/src/session.ts:21, 43-72`；**无轮换机制**（同 key 永远同一 id）。
- 要开「新会话」，桥需自己换新 id（或 key 加后缀）后走 `agents.create`（宿主层接受任意新 id；见 bridge.ts:1107-1134）。引擎层可借的现成做法：session-controller 的 `session-<randomUUID>`（commands.ts:109）或 core store 的 `session-<n>`（index.ts:1144-1146）。

---

## 4. 线上面板实查（飞书 Open API）

- 凭据：`部署侧 env 文件` 的 `FEISHU_APP_ID/FEISHU_APP_SECRET` → tenant_access_token（token 未打印；len=42）。
- `GET https://open.feishu.cn/open-apis/application/v7/app_slash_commands?page_size=50` → `code 0`，**23 条**（23<50，无 has_more）：
  `plan, permission, goal, export, compact, restart, manual, balance, plugins, ws, skills, context, model, config, audit, jobs, schedules, tools, sessions, preset, help, stop, feedback`
- 重点核对：
  - **new：不在**（面板没有）。
  - **compact：在**（desc「压缩较早的对话历史」，command_id 7697980937857944569）。
  - **restart：在**（desc「重启服务进程（需部署侧配置）」，command_id 7683766432865209323）。
- 时间戳（JST）：compact/plan/permission/goal/export 的 create/update_time = **2026-10-18 21:17:37**（最新一批，即引擎命令刚被同步进面板）；restart=2026-09-10 13:58；其余=2026-08-16 10:16。
- 面板同步器：`dsh-lark-bridge/src/slash-panel.ts`（reconcile：建缺、删多余；:1-14 说明了从 additive-only 改为 reconcile 的原因）。

---

## 5. dsh-upgrade.sh 与 compact_dingze.py

### dsh-upgrade.sh（`<PROJECT>/部署侧脚本 dsh-upgrade.sh`）
- 用途：把本地 dsh 引擎切到指定上游版本。形态=**换树**（上游包不发 npm，profile 依赖是运行时从 CLI 那棵树软链进来；升级=建新树→改启动脚本指向→重启，依赖自动跟随）— 头部注释 :4-8。
- 子命令：`check / prepare <tag> / switch <tag> / rollback / status` — :11-15, 207-213。
- 关键机制：prepare 建 worktree+装依赖+构建+体检（不动生产）— :69-90；switch 先备份（WPS 云盘）→ smoke_test（换端口+剥飞书凭据+占位抓取 key）→ sed 改 launcher 的 `exec node .../lib/bin.js` → systemctl 重启 → 终检，失败自动 rollback — :124-168；state 文件 `<DSH_HOME>/.upgrade-state` — :32, 143-145。
- 2026-10-10 四处修复：`bin_of` 双布局（老树 `lib/bin.js`／新树 `apps/cli/lib/bin.js`）— :35-38；`http_alive` 401 兼容（web 门要 token，401 也算活）— :39-41；`smoke_test` 重写（后台起+轮询，旧版三处坏）— :92-121；`prev_label` 只从 `exec node` 行取（防命中注释里的旧版本号）— :141-143。
- 与人工五步 SOP 的关系：SOP 在 `dsh-lark-bridge/docs/dsh升级SOP.md`（`部署侧 SOP 注册表:118-126`，状态「现行」）。SOP 五步=①contract-drift 门禁 ②改 `run-dsh-web.sh` 路径 ③typecheck ④npm test ⑤build+restart+**真发一条飞书消息**（SOP:14-35）；三道闸门+人工闸门见 SOP:37-46。关系=**互补**：脚本是 SOP 中「切树/重启/回滚」环节的自动化并强化（备份、试启动 smoke、终检、rollback），SOP 的桥侧三门禁（契约漂移/类型检查/行为测试）与人工真实验证仍由人工执行；脚本不改桥代码、不跑桥测试。

### compact_dingze.py（同目录）
- 一句话：**《通用bot定则》瘦身脚本**——去重（重复章节号，如两个「〇之七」）、删已失效条目、清空目录、按主题归并，只做减法不加新规矩 — :1-12, 23-45（用 `_winpath.resolve` 做跨运行时路径）。

---

## 6. 桥 `/compact` 精确链路与压缩文案

### 链路（飞书 → 引擎 → 飞书）
1. `bridge.ts:1424` `isCommandLine(msg.content)` → `1427-1455` `runCommandLine(...)`。
2. runCommandLine 桥自带命令均不匹配 `compact` ⇒ 兜底 `commands.execute(agent, trimmed, [], signal)` — `src/commands.ts:340`（`333-335` 是 commands 未组合的告警分支；注释 336-339 说明四参形态的坑）。
3. 引擎 `Commands.execute` — `packages/interaction/commands/src/index.ts:361-431`：解析失败/未知名返回 `undefined`（:367-370）；发 `command/run`（:373-378）→ 跑 handler（:424-425）→ 发 `command/done` 并返回 `{commandId, result}`（:379-388）。
4. `command-compact` 的 `executeCompact` — `src/index.ts:59-79` → `ctx.compaction.compactNow(agent, signal, commandId)` — `compaction-basic/src/index.ts:383-435` → `agent.runMaintenance` — `agent.ts:183`。
5. 回桥：`result.kind==='error'` ⇒ `⚠️ \`/compact\` 执行失败：<text>`（commands.ts:345）；成功 ⇒ `reply = result.text ?? ''`（commands.ts:360）；`execution === undefined` ⇒ `⚠️ 未知命令…`（commands.ts:341-343）。

### 「成功但 result.text 为空时跳过发送」位置（bridge.ts:1462-1464，10 行上下文）
```
1456        // A /preset switch changed this session's composition contract; the
1457        // cached composition would resume the OLD preset, so drop it and let
1458        // the next acquire compose from the remembered choice.
1459        if (sessionPresets.get(sessionId) !== presetBefore) {
1460          compositions.delete(sessionId)
1461        }
1462        if (outcome.reply !== '') {
1463          await replay.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure)
1464        }
1465        // An interactive outcome (the account switcher) rides a card; the
1466        // empty reply says the card IS the whole answer.
1467        if (outcome.card !== undefined) {
1468          await replay.send(binding.chatId, { card: outcome.card }).catch(reportSendFailure)
1469        }
1470        return
```
（注释 1465-1466 说明空 reply 的语义：命令自己的事件已把故事讲完，无需回显。）

### 压缩发飞书的消息文案（事件驱动；bridge.ts:2054-2067）
- `start`：内联字面量 `📦 上下文较长，正在压缩（较早内容将被摘要）…` — `bridge.ts:2057-2058`（**无独立行函数**）。
- `summary`：`compactionSummaryLine` — `notices.ts:155-162` → `📦 上下文压缩完成，释放约 {shadowedTokenCount} tokens` + 摘要文本前 200 字预览；调用点 `bridge.ts:2059-2060`。
- `prune`：`compactionPruneLine` — `notices.ts:169-174` → `🗑️ 已修剪 {n} 条旧消息（释放约 {tokens} tokens）`；调用点 `bridge.ts:2061-2062`。
- `end`：**仅错误时**发 `⚠️ 上下文压缩失败：{error}` — `bridge.ts:2063-2066`；成功 end 不发言。
- 事件判别：`host.ts:661-686`（isCompactionStart/End/Summary/PruneEvent，按 `event.type` 直判；与 turn 无关，手动压缩的 turn:null 标记同样触发）。
- 注：`grep compactionStartLine|compactionEndLine` 无命中——start 是内联字面量、end 只处理 `error` 字段，确无行函数。

### 附：`/new`（与 `/clear`）的「文案已承诺、实现不存在」
- 承诺文案：`commands.ts:430`（/sessions 尾部「发消息即继续最近的会话；`/new` 开新会话」）、`commands.ts:725`（/model 切换提示）、`commands.ts:912`（/preset 失败提示）；`user-guide.ts:24`（速查表列 `/clear` 清上下文 · `/new` 新会话）。
- 实际执行 `/new`：runCommandLine 无匹配 → `commands.execute` → 引擎无 `new` 命令 → 返回 undefined → `⚠️ 未知命令 \`/new\`…`（commands.ts:341-343）。线上 23 条面板中亦无 new/clear。
