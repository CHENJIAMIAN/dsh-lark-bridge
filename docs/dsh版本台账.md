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
| 2026-10-20 | ★口径订正（含跨钟域教训） | 0.9.1 | 复核发现：bundle 于 06:25:57 重建，而当时的生产进程（pid 256800）**启动更早** ⇒ 跑的是旧 bundle，tokenMeter 修复**当时确实没进生产**，而上一条台账已按「已修」记录。已重启并复核（现 pid 273705）。 **判定方法（此处踩过坑，方法本身才是重点）**：①本机 realtime 相对 monotonic **慢约 9%**，且 systemd-resolved **每 30 秒**记一次 Clock change detected ⇒ **任何墙钟派生的时刻都不可用于跨来源比较**（本条第一版正是跨钟域比较，御史据此判「被推翻」——它的结论在它自己的换算下成立，但换算用了漂移的墙钟）。②**同域比较用 journal 自己给的单调戳**：`journalctl -o short-monotonic` 与 `/proc/PID/stat` 的 starttime 同属 monotonic 域。★ 但 bundle 的 mtime 只有墙钟，**换算成单调戳要用 realtime↔monotonic 插值，误差可达几十秒**，所以**不能拿它做秒级判决**——本条第一版正是这么算的，结论反了（御史据此判「被推翻」）。③**决定性证据是 journal 自己的墙钟**（同一来源，无跨域换算）：bundle mtime `06:25:57.178` ⇒ 进程 256800 的 `Started` 记录 `06:27:16` ⇒ **bundle 早 79 秒 ⇒ 那个进程装的就是新 bundle**；桥插件的首条业务日志同在 06:27:16。④journal 的 "Started" 是 systemd 在 **exec 完成后**写的，比进程起始晚几十毫秒，不能当进程起始用（实测 158563.670 vs 158563.702）。⑤★ **不可只用「bundle 内 grep 到新代码」下结论**：那只证明文件对，不证明跑着的进程用的是它；要同时看进程启动时刻与 bundle 重建时刻的先后。 | ✅ 生产已核：进程启动时刻晚于 bundle 重建时刻（journal 同源墙钟：06:27:16 > 06:25:57）；生产 bundle 内 `measure({id})` 计数 0 / `measure(binding.session)` 计数 1；启动错误行 **0**；control API 200 且 `bridgeVersion=0.9.1`、pid 与生产一致。⚠️ 仍未闭环：**rc.2 上 slash 命令真实执行路径至今零真流量**（agent 只在首条飞书消息时创建 ⇒ 切换后无任何会话产物，命令路径一次没跑过）——需由使用方发一条真实消息才能验 |
| 2026-10-20 | ★公开仓历史改写 + 门与发布通道加固 | 0.9.1（tag v0.9.1，**npm 未发**） | ①**历史改写两轮**：首轮只替换文件内容、**漏了 commit message 正文**（`dd67e149` 的提交信息里仍有私人称呼；子代理用 GitHub commit search API 独立抓出——作者自验只查了 patch 面，是盲区）；二轮加 `--replace-message` 补上。远端所有分支+tag 的 message/patch/tag 注释/对象库全量四项均 0 命中；本地 `.git` 删两个未推旧分支 + gc（495→2616 对象，13.6M→6.8M）。②**泄漏门 4 处**：Windows 用户路径正则只匹配双反斜杠（真实路径是单反斜杠 ⇒ 一条都报不出）；**旁门 A**「只看一行首个匹配，首个被豁免则整行跳过」；**旁门 B**「WSL 豁免按整行读用户段 ⇒ 行内任一占位符豁免该行所有 WSL 路径」；改为只扫 `git ls-files` 已跟踪文件（未跟踪的本机脚本不发布，本就该豁免）。③**发布门 2 处**：`npm view` 退出 0 但无输出 ⇒ 假绿（恰是该门要抓的那类错），改判「输出含版本号」并剥 ANSI；`gh release create` 不幂等（tag 被 force push 后重跑必报 `Release.tag_name already exists`），改为存在则 `edit`。④**契约门 1 处**：文本比对看不出「上游给 signal 加默认值」——文本一模一样但 JS `.length` 从 4 变 3 ⇒ 桥的调用形状会静默改变。新增 `arityChecks` 按 JS 规则数参数，要求 `commands.execute` 运行时 arity **必须是 4**（拒绝 3：三在此有歧义，「四参但 signal 带默认值」正是会把 signal 传进 attachments 槽的那一支）。⑤**生产侧升级门 6 处**（另一仓的运维脚本）：`pkill -f "port 18799"` 匹配整条命令行 ⇒ **把运行脚本的 shell 一起杀了**（输出停在「HTTP 000000 / 错误行 0」、升级被判失败，而 node 还在冷启动、约 3 分钟后才应答 ⇒ 白白放弃一次好升级）⇒ 改按监听端口找 PID；回滚只认 HTTP 200 ⇒ 本机 web 门无 token 返回 **401** ⇒ **回滚成功也报「仍不通」** ⇒ 改用 `http_alive`；分界戳取不到只告警后照样「✓ 切换完成」⇒ **核不了就当过了** ⇒ 改判失败；错误行统计只有下界没有上界 ⇒ 运行期错误被算成启动错误（**假红**：实测 client ready 后 48 秒一次 chronicle 超时被算成启动失败 ⇒ 门建议 rollback）⇒ 上界取本进程第一条 `client ready`；`systemctl restart` 对 ExecStart 不存在的单元**返回退出码 0** 而状态是 failed ⇒ 改用 `systemctl is-active` 判 failed 并立即回滚；状态文件 `ts` 未加引号 ⇒ 被 `.` source 时执行 `14:49:27` 报 command not found（每次回滚都犯）⇒ 加引号并迁移现存文件 | ✅ typecheck 0；vitest **488 全绿**（40 文件）；plugin-contract **43/0**；contract-drift **0**（对上游 master）且**新增 arity 检查 arity=4**；hygiene 门 clean（236 已跟踪文件）；CI **绿**；**完整 switch 实跑成功**（试启动过 → 改树指向 → 重启 → 分界戳/进程/窗口三项判据全对）；**失败路径实跑**（造 ExecStart 不存在的单元 ⇒ 旧版等 240 秒才判失败、新版 **0 秒**判出并回滚）；rc.2 宿主上 **issue #2 运行时证据**（真 host ctx + 真 command + 真 signal）：`execute.length=4`、四参形状返回 success、**三参错位抛 `Cannot read properties of undefined (reading 'aborted')`**；**公开仓远端新 clone 四项 0 命中**（message/patch/tag 注释/对象库全量）、fsck 完好、223 提交。⚠️ 仍未闭环：**npm 上仍无 0.9.1**（仓库未配 `NPM_TOKEN`）⇒ 报障人装到的仍是 0.6.1 的坏代码，两个 issue 只能继续 open；rc.2 上 slash 命令**真实飞书链路仍零真流量**（机制已验，只差最后一跳，需使用方发一条真实消息） |

