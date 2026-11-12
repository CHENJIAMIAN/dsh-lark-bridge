# 给 agent 的项目约定

## 改完必须 `pnpm build`

`tsc` 只产中间产物，插件运行时加载的是 tsdown 打的 `lib/types-<hash>.js`。只跑
`pnpm typecheck` 等于没改。提交前跑 `pnpm test`，它含一道文档门禁（README 里的
测试数、命令表要与代码一致），数对不上会红。

## 预命令不进普通入站路径

`/new` `/clear` `/stop` `/ws use` 这些在 `handleMessage` 里**提前 return**，走不到
后面那段给 `pendingSessionCwd` 赋值的代码。于是任何「让 ladder 自己去查目录」的
写法对它们都等于没写——`ladder.create` 会静默退回部署 cwd。

2026-11-11 的现场：群绑定在 `dsh-lark-bridge`，发多少次 `/new` 都还在 `D:\Desktop`，
因为它靠 `pendingSessionCwd.get(...)` 取目录，而那张表只有普通消息才填。

**规矩：预命令需要的一切上下文，在调用它的地方先取好、显式传进去**，别指望下层
去查一个只有别的路径才写的表。`rotate(msg, cwd)` / `create(sessionId, cwd?)` 就是
按这条长出来的。

## 目录：`meta.cwd` 是出身，不是现状

宿主**挪得动运行中的会话**。`ctx.get('workingDirectory').set(agent, dir)` 会追加一条
durable 的 `working-directory/change`、给模型注入一条「目录变了」通知，而 AGENTS.md
加载器（`dsh-agent-instructions`）每次组装提示词都重读 `workingDirectory.ensure()`。
所以 `/ws use` 和面板的「切换工作区」现在都是**就地切换**，不再要求 `/new`。

读目录一律走 `workingDirectoryOf(session)`：
- `session.meta.cwd` 是**不可变**的原始项目目录，切过就是旧值——拿它当「当前目录」
  会让 CoT banner 和控制台卡片显示错的路径（这一整轮 bug 就是从这句错注释长出来的）；
- 服务缺席时（组合里没加载该插件）才退回 `meta.cwd`，并用 `canSwitchLive: false`
  让卡片如实说「发 /new 生效」，不要谎称已经切换。

`ctx.get('workingDirectory', false)` 用**非严格**取值：严格模式在 providing fiber
不是 ACTIVE 时返回 undefined，能力完全正常的宿主会被读成「不支持」。

## 思考强度只能改「选择」，不能改「请求」

宿主 0.2.2 的 `agent-loop` 在每一步准备阶段用 `agent.model.current()` 把
`selection` 固定下来，随后**硬校验** `agent/request` 瀑布的返回值必须与它逐字段
相等：

```
proposed reasoning effort "adapter default" after step preparation fixed "off";
use agent.model.select() before step preparation
```

所以在 `agent/request` 里改 `reasoningEffort`（或 provider/model）会让整轮
`UNKNOWN`。2026-11-11 现场：用户把强度从 low 切到 off，只有 off 炸——因为 off
当时是靠「在瀑布里删掉 reasoning 字段」实现的，准备阶段说 off、请求里却是
adapter default，两边不一致。

**规矩：档位只通过落盘的 `model/selection` 事件生效**（`effortOverrides.set()`
已经在写），宿主下一步准备阶段自己就读到了。瀑布里只剩路由覆盖，而且它必须与
那条事件同源。

`off` 的正确编码是**选择里不带 `reasoningEffort`**（宿主支持「没有 effort 的
选择」，其 `AgentModel.current()` 注释写明 adapter 默认的 effort 会被省略），
不是把 `off` 这个名字交给适配器查表——magpie 会把该档渲染成 `"none"`，上游不认。

## 飞书卡片：必须让平台校验，不能只靠单元测试

**单元测试只能证明"我写的字段我自己读得回来"，证明不了"飞书认不认这些字段"。**
这个仓里已经因此踩过三次：

| 写错的东西 | 飞书报的错 |
|---|---|
| `select_static` 用 `selected` 设默认值 | `unknown property, property: selected` |
| `select_static` 带 `required` | `10002: required is not allowed` |
| 把带 `schema: "2.0"` 的 JSON 直接塞进 `content` 发 | 消息体只剩兜底文本；2.0 必须走 `cardkit.v1.card.create` + `card_id` 引用 |

### 验证办法

把卡片的真实 JSON 直接打给飞书，再**取回消息体**看服务端有没有降级：

```powershell
# 1. 用 vitest 跑一个临时 spec，把 panelCard() 的输出写到文件
# 2. POST /open-apis/im/v1/messages?receive_id_type=chat_id
#    body = { receive_id = <chat>, msg_type = 'interactive', content = <card json> }
# 3. GET /open-apis/im/v1/messages/<message_id>，读 data.items[0].body.content
# 4. body 里出现「请升级」= 有标签被降级（仅对 1.0 卡片成立）
```

对 **1.0 卡片**有效：内容本来就存在消息体里，取回的是完整 elements；
能告诉你「哪个字段被拒」，但判断不了「用户看到什么」。

token：`POST /open-apis/auth/v3/tenant_access_token/internal`，appId/appSecret 从
`~/.dsh/profiles/lark/cordis.patch.yml` 读。

### 1.0 与 2.0 的已知差异

- **`select_static` 的 `initial_option` 要传选项的显示文本，不是 `value`**；用 `initial_index`（1-based，0=不选）更稳，别靠字符串匹配。
- 1.0 的 `select_static` **不接受 `required`**。
- 取值字段也不同：2.0 的 form 提交报 `formValue`，1.0 的裸 select 报 `option`。
  桥用 `panelSubmitted()` 两个都认——只读一个，症状会是"点了没反应"。
- **2.0 卡片是可用的**，但要走正确发法：先 `POST /open-apis/cardkit/v1/cards`
  （body `{type:'card_json', data:'<2.0 JSON 字符串>'}`）拿 `card_id`，再发
  `msg_type=interactive`、`content` 为 `{type:'card', data:{card_id}}`。
  回调字段是 `formValue`。
- **`updateCardById` 刷新的是 entity，不产生新消息——用户主动要的东西必须发新卡。**
  `cardkit.v1.card.update` 返回 `code=0 success`，`/im/v1/messages` 里一条新消息都没有。
  所以「用户发一条命令、要一张卡」这种交互只有 `createCard` + `send({cardId})` 一定会让他看见；
  原地更新只适合"他刚点了这张卡上的按钮、正盯着它"的场景。
  2026-11-10 的 `/console` 连续三次无响应就是这么来的：日志里
  `console card updated in place (seq 5/6/7)` 三条全部成功，而操作者屏幕上什么都没变，
  他只能判断「机器人没反应」。控制台现在改成**每次发新卡 + `recallMessage` 撤回上一张**，
  聊天里始终只留一张；`/console` 的 send/create 每一步独立 try，失败会直接回消息带飞书错误码。
- **`port.updateCard(messageId, card)` 对 1.0 interactive 消息无效**：它 resolves 不报错，
  但客户端不重绘。它面向的是 `createCard` 建出来的 CardKit 2.0 card entity。
  要刷新就**发一张新卡**，别指望原地更新。
- **2.0 不支持 `tag: 'note'`（以及一批 1.0 元素），而且拒绝是整卡级的。**
  `{ tag: 'note', elements: [...] }` 让 cardkit 回 `code=200861 … unsupported tag note`、
  `data.card_id: ""`；SDK 只读 `data.card_id`，于是调用方看到的永远是一句
  `cardkit.card.create returned no card_id (code=unknown)`——**服务端的真实错误码被吞掉**，
  2026-11-10 因此把一次字段错误误判成网络抖动，查了半小时。
  提示行改用 `div` + `plain_text`（见 `panel.ts` 的 `hint()`），别再用 `note`。
  排查这类问题的正确姿势：把 `panelCard()` 的真实 JSON 直接 POST `cardkit/v1/cards` 读返回体，
  一次就能看到是哪个元素、哪个 tag 被拒。

## 思考过程的能力边界：租户级灰度，别当公开 API 用

接口 `/open-apis/im/v1/message_cot` 是**租户级灰度能力**，主要在 ByteDance 租户可用
（第三方实现 `@open-aiden/dsh-lark-bridge` 原话：当前使用「ByteDance 租户接口」，
其他租户可能直接用不了）。判断依据是 2026-11-12 的一轮核查：

- 开放平台公开文档**查不到**：`/document/server-docs/im-v1/message_cot/*` 各路径全 404，
  `site:open.feishu.cn` 与 larkoffice 国际站均无命中；
- 官方 SDK `@larksuiteoapi/node-sdk` **不收录**方法，所以 `runtime.ts` 只能拿
  `rawClient` 直接打 REST —— 同类情况的还有 slash 命令面板接口；
- 但 GitHub 上至少四个互不相关的项目在用（botmux、csgclaw、Kinasha/open-aiden、
  本仓），说明接口真实且成熟，不是漏洞。

由此得到的硬结论：**换租户、换应用、换客户端都可能突然不可用**，所以创建 COT 失败
必须降级为普通回复，不能连带把答案也吞掉。客户端门槛（第三方口径，未从官方证实）：
桌面端 7.70+、移动端 7.74+。

事件名（`REASONING_*` / `TOOL_CALL_*` / `TEXT_MESSAGE_*` / `RUN_*`）沿用第三方开放协议
**AG-UI**（docs.ag-ui.com，非飞书官方），字段语义以 AG-UI spec 为准；但飞书侧的限制
（一次最多 50 条、单条 4096 字符、`messageId` 归属与渲染位置）**以实测为准**，spec
不保证飞书实现完全一致。

## 思考过程：一段思考 = 一个 messageId，各自 START/END

飞书原生思考过程（`message_cot`）里，一段 `REASONING_MESSAGE_START …_CONTENT …_END`
渲染在它的 **START 时刻**那个位置；工具调用夹在中间就是「思考 工具 思考」。

所以**绝对不能整轮只用一个 reasoning messageId、只 START 一次**：后续所有思考都落到
开头那一段上，读者看到的就是「思考全堆在上面、工具全在下面」。2026-11-12 我这么
「优化」过一次，正好复现了这个现象。

判断依据不是猜：往群里发一条合成 cot（`REASONING → TOOL_CALL → REASONING`，
每段独立 id），让操作者看 ①②③ 是否按序 —— 按序即证明平台支持交错，问题只在本端
事件序列。合成 cot 的脚本在 `D:\CodexWork\feishu-cot-probe\probe-many.ps1`
（注意官方上限：**一次 append 最多 50 个事件**，超过回 `the max len is 50`）。

## 写文件的过程要给出「改了什么」

思考区里一个写文件的工具结果，如果只显示工具自己的回执（`Wrote 3 lines`），读者
还得去翻会话记录才知道改了哪几行。所以 `renderToolChange()`（`src/cot.ts`）在**调用
那一刻**从参数里算出变更：`old/new` 型渲染成 `- 旧行 / + 新行`，`content` 型渲染成
`+ 行`，开头带路径与行数；结果事件优先用它，工具回执不再占这一格。

两条硬约束：
- **一次事件的 JSON 上限是 4096 字符**，换行和引号都要转义，按字符数估算会低估——
  用 `fitCode()` 量序列化后的长度；
- **只在行边界截断**，末尾写明「还有 N 行，完整内容见会话记录」。半行代码比不显示
  更容易误导。

## 问询卡：原文优先，别按字数截

提问正文、选项 label、选项说明一律**原文送达**，不做按字数的截断（2026-11-12 运营方：
「不要做限制，飞书支持多长就搞多长，维护原文非常重要」）。旧实现有
`OPTION_LABEL_MAX_CHARS = 40` / `QUESTION_DETAIL_MAX_CHARS = 400`，读者看到的是被砍
成「…」的半句话，而且会误以为是模型输出的。

唯一的截断是**整卡预算**（`fitCardPayload`，`src/questions.ts`）：

- 上限不是文档写的 30KB。**实测 `im/v1/messages` 的 `interactive` content 是 150KB**：
  149.3KB 接受，151.3KB 起回 `230025 the length of the message content reaches its limit`。
  实现取 140KB 留余量。
- 超限时从最长的文本开始收，短按钮词（「跳过」「确认选择」）永不牺牲；
- 每一处用**二分**求还能留多少字。拿字节差当字符数砍会出事——中文一字 3 字节，
  超 100KB 按差砍就是把整段削没；二分期间也必须始终基于原文重试，否则最窄那轮
  试探会把结果带到终点、截断说明也会丢。这两点当天各踩了一次。

## 重启宿主

不要自行重启。构建完停下，报「已构建，等你发话重启」。用户说重启后再执行
`Start-ScheduledTask -TaskPath '\Codex\' -TaskName 'DSH重启-多选卡验证'`（延迟 20 秒，
日志在 `D:\CodexWork\dsh-restart-20261021\restart-delayed.log`）。
