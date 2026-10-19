# dsh 版本台账

> 为什么有这个文件：2026-09-28 升级事故暴露出"升级没有记录"——
> `run-dsh-web.sh` 里只有一行注释，无从知道哪天升的、为什么升、升完验证了什么。
> 此后**每次升级追加一行**，作为回溯依据。

## 台账

| 日期 | dsh 版本 | 桥接版本 | 变更要点 | 验证结果 |
|---|---|---|---|---|
| 2026-08-19 | 0.1.0-rc.8 | — | 上游 `141eb6fe`（merge release/dsh-0.1.0-rc.8） | 契约漂移门禁 green |
| 2026-08-21 | （同上） | 0.9.0 | 桥接主体开发；建立 `verify-dsh-contract.mjs` 门禁（6 文件 22 项） | 22 项通过 |
| 2026-09-14 | 0.1.1 | — | 0.1.1 退役归档（`deepseek-harness-0.1.1-retired-20260914`） | — |
| 2026-09-28 | 0.1.5-rc.2 → **0.1.7-rc.2** | 0.9.0 | 运营指令「升最新的」。**升级当时未跑任何验证** | ❌ **生产会话创建失败**：`presets.standingKeyFor is not a function` |
| 2026-09-28 | 0.1.7-rc.2（保持） | 0.9.0 | **修复适配**：①`standingKeyFor`→`acquireScope`（含租约释放）②`onJobDone`→`events.subscribe`（含 `awaited` 去重）③补齐门禁校验 ④新增反向排查脚本 | ✅ 类型检查通过；431 项测试通过；门禁 24 项无漂移 |

## 版本切换方式

`run-dsh-web.sh` 两处路径指向目标版本的 `lib/bin.js`。
**当前指向**：`deepseek-harness-0.2.1-alpha.2/apps/cli/lib/bin.js`（2026-10-10 起；位于项目父目录 `<PROJECT>/` 下）

**回滚方法**：两处路径改回 `deepseek-harness-0.1.5/lib/bin.js`（0.1.5 目录仍在，回滚可行）

## 目录清单

| 版本 | 路径 | 状态 |
|---|---|---|
| 0.1.1 | `deepseek-harness-0.1.1-retired-20260914/` | 已退役归档 |
| 0.1.5-rc.2 | `deepseek-harness-0.1.5/` | 保留（回滚目标） |
| 0.1.7-rc.2 | `deepseek-harness-0.1.7-rc.2/` | 保留（回滚参考） |
| 0.2.0-rc.2 | `deepseek-harness-0.2.0-rc.2/` | 保留 |
| 0.2.1-alpha.2 | `deepseek-harness-0.2.1-alpha.2/` | 保留（回滚目标） |
| **0.2.1-rc.2** | `deepseek-harness-0.2.1-rc.2/` | **在用**（2026-10-20 起） |

## 记录格式

每次升级追加一行，**四个字段必填**：日期 / 版本 / 变更要点 / 验证结果。
验证结果写**命令与结论**（如 `contract-drift 24 项 green / npm test 431 pass`），
不写"已验证"这种无信息量的话。

## 补记（2026-10-18）

| 日期 | 版本 | 桥版本 | 变更要点 | 验证结果 |
|---|---|---|---|---|
| 2026-10-10 | 0.1.7-rc.2 → **0.2.0-rc.2** | 0.9.0 | 走 dsh-upgrade.sh 切树（当日两次升级之一） | ⚠️ 升级当时未记录验证（2026-10-18 补记） |
| 2026-10-10 | 0.2.0-rc.2 → **0.2.1-alpha.2** | 0.9.0 | 同上；生产至今运行此版 | ⚠️ 未记录（同上） |
| 2026-10-18 | 0.2.1-alpha.2（保持） | 0.9.0 | 桥侧补验 + 命令 UX 修复批次 | ✅ contract-drift 无漂移（上游 master）；typecheck ✅；vitest **449 全绿**（39 文件）；实发消息待验 |
| 2026-10-20 | 0.2.1-alpha.2 → **0.2.1-rc.2** | 0.9.1（tag 已推，**npm 未发**） | 走 dsh-upgrade.sh 切树（上游最新 rc）。桥侧同步修了 issue #2 的 arity 错位（按运行时实参个数调用，不再写死形状）与 issue #4 的 pnpm 安装说明 | ⚠️ contract-drift 2 项漂移（类型层：host.ts 的 jobs.list/readAt 仍用旧签名，运行时等价）；typecheck ✅；vitest **479 全绿**（39 文件）；试启动 HTTP 401 / 错误行 0；切换后 HTTP 200 / 启动错误行 0；实发飞书消息待验 |
| 2026-10-20 | 桥侧 issue 处置 | 0.9.1（tag v0.9.1，GitHub Release 已建） | issue #2（斜杠命令 arity 错位）已修：按运行时实参个数调用 + 命令错误面从「无法启动会话」拆成「命令执行失败」+ 契约门新增 commands.execute 上游比对；issue #4（pnpm 安装门）已修：README 改为 allowBuilds/protobufjs:false 并补「必须重跑同一条命令」；发布通道补 npm publish 步骤 | ✅ typecheck 0；vitest **479 全绿**（39 文件）；plugin-contract **43/0**；contract-drift **0**（对上游 master）；CI **绿**（此前自 9-27 连续失败近一月，根因=契约测试断言过期）；Release 绿；反向验证：改回硬编码三参 → 护栏测试变红；⚠️ **npm 上仍无 0.9.1**——仓库未配 NPM_TOKEN secret，publish 步骤跳过；两个 issue 已回复但**保持 open**，待 registry 真正更新后再关 |
| 2026-10-20 | 0.2.1-rc.2 补构建 | 0.9.1 | 切到 rc.2 后重启暴露：host 面独有的 `typert.host.js` 未生成（只构建了 client 面）⇒ typert-loader 报 25 个贡献者注册失败（51 错误行）。补跑 `tsdown --env.DSH_BUILD_FACE host` 出 30 份产物 | ✅ 重启后启动错误行 **0**；真链路冒烟全过（服务 active / 组合树 4 项 / 面板 19 命令）；升级脚本同批修：构建不再 `|| true` 吞错、探针窗口 200s→900s、体检改查产物文件 |
| 2026-10-20 | 御史复核后修正 | 0.9.1 | 独立对抗复核（换装置：真实 cordis 服务 / 真实 TokenMeter+Session / 干净 HEAD 副本）推翻了本轮一条自报：**tokenMeter 恒为 0 的静默 bug**（上游 `measure(session: Session)` 要 session 对象，桥传 `{id}` ⇒ 重放循环读不到事件 ⇒ 恒 0 且不抛错 ⇒ 上下文压力告警永不触发；`/context` 走的是正确形状所以一直正常）。已修：`HostSession` 补 `seq`/`eventAt()`、`measure(binding.session)`、契约测试不再认证错形状、上游签名纳入契约门、单测锁形状。另修：arity 未知形状不再静默默认四参（`length===2` 会原样复现 issue #2）⇒ 改为显式告警。**已重建 bundle 并重启**（只跑 tsc 不会改生产行为） | ✅ typecheck 0；vitest **480 全绿**（39 文件）；plugin-contract **43/0**；contract-drift **0**；生产 bundle 内 `measure({id})` 计数 **0**、新修复计数 1；重启后启动错误行 **0**；阴性对照：把声明改回错形状 → 契约测试 42/1 变红。⚠️ 口径订正：御史指出「24h 错误行 0」只对当前 boot 为真（24h 窗口实有 98 条，全在 03:03/04:17 两次坏启动）；且 rc.2 切换后**零会话产物、零命令执行**——slash 命令的真实执行路径在生产上一次都没被真流量跑过 |
