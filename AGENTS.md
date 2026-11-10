# 给 agent 的项目约定

## 改完必须 `pnpm build`

`tsc` 只产中间产物，插件运行时加载的是 tsdown 打的 `lib/types-<hash>.js`。只跑
`pnpm typecheck` 等于没改。提交前跑 `pnpm test`，它含一道文档门禁（README 里的
测试数、命令表要与代码一致），数对不上会红。

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
  用 `updateCardById(cardId, json, sequence)`（sequence 严格递增）可做**真正的原地更新**。
  桥的控制台已走这条路；发卡用 `port.createCard` + `send({cardId})`，刷新用
  `port.updateCardById`，回调字段是 `formValue`。
- **判断卡片渲染是否正常只能让人看截图，别拿 `GET /im/v1/messages` 取回的 `body.content` 当依据——2.0 卡片那里存的只是给旧客户端的兜底文本。**
- **`port.updateCard(messageId, card)` 对 1.0 interactive 消息无效**：它 resolves 不报错，
  但客户端不重绘。它面向的是 `createCard` 建出来的 CardKit 2.0 card entity。表现是「第一张卡
  正常，之后每次 `/console` 和每次切换都石沉大海」，以及「选完又闪回旧值」。
  要刷新就**发一张新卡**，别指望原地更新。

## 重启宿主

不要自行重启。构建完停下，报「已构建，等你发话重启」。用户说重启后再执行
`Start-ScheduledTask -TaskPath '\Codex\' -TaskName 'DSH重启-多选卡验证'`（延迟 20 秒，
日志在 `D:\CodexWork\dsh-restart-20261021\restart-delayed.log`）。
