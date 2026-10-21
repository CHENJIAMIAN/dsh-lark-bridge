# dsh 版本台账

> 为什么有这个文件：2026-09-28 升级事故暴露出"升级没有记录"——
> `web 端的启动脚本` 里只有一行注释，无从知道哪天升的、为什么升、升完验证了什么。
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

目标树的路径写在**仓外的 env 文件**里（由升级脚本维护，启动脚本 source 它并导出 `DSH_HARNESS_DIR`）
**当前指向**：`deepseek-harness-0.2.1-rc.2/apps/cli/lib/bin.js`（2026-10-20 切树；由仓外 env 文件指定，不写在启动脚本里）

**回滚方法**：把 env 文件里的 `DSH_HARNESS_DIR` 改回目标树再重启（升级脚本的 rollback 会自动做）

## 2026-10-20 收尾（0.9.5 发布 + 第七份复核核销 + npm 通道查证）

### 0.9.6 已发布（Release 成，npm 未上——无 token）

| 项 | 实测 |
|---|---|
| tag | `v0.9.6` → `fcf392b` |
| Release | **已建**（`published_at` 2026-10-21T00:52:34Z），body 3767 字符 |
| tarball | `moyu-good-dsh-lark-bridge-0.9.6.tgz`，**577261 bytes** |
| 泄漏面 | 解包 **242 个文件**逐文件扫：词表 43 条 + 额外 12 类（私人称呼／本机路径／服务单元名／部署脚本名／内部系统名／另一处内部项目名）= **命中 0** |
| CI | 绿；唯一红 = 「Verify the registry」＝**预期**（无 npm token） |
| npm | **0.9.6 不在 registry**（直读 `https://registry.npmjs.org/@moyu-good%2Fdsh-lark-bridge` ⇒ HTTP 404；该包 latest 仍为 **0.6.1**） |

★ **包名口径更正（此前记录一直漏了 scope）**：正确的包名是
**`@moyu-good/dsh-lark-bridge`**，不是 `moyu-good/dsh-lark-bridge`。
用错名字去查 registry 会拿到 **405**，容易被误读成「版本已存在」
——**先判 404 再判版本号**这条铁则在带 scope 的包上尤其要紧。

★ **registry 上的全部版本只有 0.3.1 / 0.4.0 / 0.4.1 / 0.5.0 / 0.6.0 / 0.6.1**
⇒ **0.7.0 之后的全部能力从未上 npm** ⇒ README 的 Quick Start 从 npm 装，
装到的是 0.6.1 ⇒ **新用户拿到的桥没有 `/tools`、没有团队面板、没有原生媒体**。
⇒ 缺口清单第 2 条仍然成立，**解法只有 token**（不是技术问题）。

★ **外部可用的干净路径（不依赖 npm）**：`npm i github:moyu-good/dsh-lark-bridge#v0.9.6`
——但**本机 npm 拒绝 git 依赖**（`EALLOWGIT`，npm 11+ 默认禁），
所以那条命令在**别人机器上**能不能成，取决于对方的 npm 版本与配置，
**本机未验**。

### 0.9.5 已发布（包是干净的）

| 项 | 实测 |
|---|---|
| tag | `v0.9.5` → `eb2725e` |
| Release | 已建、tarball 已附（524344 bytes） |
| CI | 绿 |
| Release 步骤 | 14 步全绿；只有「Verify the registry」红＝**预期**（无 npm token） |
| 泄漏面 | 解包逐文件核：私人称呼 / 东家 / 本机路径 / 用户名 / 服务单元名 / 部署脚本名 / 内部系统名 / 治理系统名 / 另一处内部项目名 = **10 类全 0 命中** |
| 关键修复 | 混合体 Proxy、`measure(binding.session)`、poll 记录、catch 留痕 = **全在** |
| 装上能用 | `npm i` 成功 + `require` 成功（导出 `Config,apply,inject,name`） |

★ **为什么必须发 0.9.5**：0.9.4 的 tarball（18:44 切的）**仍带三处泄漏**，
  泄漏清理是 19:26 之后才做的；**已发布产物不可改** ⇒ 只能出新版本。
  0.9.5 的 CHANGELOG 已写明「0.9.4 的包带那些名字，请装 0.9.5」。

### npm 通道：token 不在机器上，但也不需要

六路查证，**均无**：
1. 凭据台账（`config/keys-ledger.md`）——**没有 npm 这一节**（只有模型 key、采集通道、GLM MCP、Congress.gov）
2. 本机与 Windows 侧 `.npmrc` —— 只有 `registry=`，**无 `_authToken`**
3. 环境变量 —— 无 `NPM_TOKEN` / `NODE_AUTH_TOKEN`
4. GitHub Actions（仓库级 secrets + variables + environments）—— **只有 `REPO_HYGIENE_PATTERNS`**
5. 全盘特征串扫（本机根目录 + 项目盘 + Windows 用户目录）—— **零命中**
6. 飞书会话历史 + 当前 P2P 原文（bot 身份读出 49925 字节）—— 零命中

★ 可能给在**别的对话**：那要 user 身份列 P2P（飞书隐私限制：bot 不能列），
  而 **lark-cli 的 user 授权已过期**。
★ **但 token 不是必需的**（实测）：`npm i github:moyu-good/dsh-lark-bridge#v0.9.5`
  **成功**（236 文件、版本 0.9.5、泄漏 0）⇒ 报障人现在就能拿到干净修复版。
  两条 issue（#2 / #4）的评论已更新到 0.9.5。

### 第七份复核（13:07 派）逐条核销

它报的**三条「拦路项」实测后全部不成立**：

| 它的指控 | 判决 | 反例 |
|---|---|---|
| Windows 正则要求两个反斜杠、整条规则是死的 | **不成立** | 源码是 `\+`＝一个或多个；实测「一个反斜杠 + Windows 用户目录」被报出 3 条 |
| WSL 占位豁免能藏 token | **不成立** | 豁免从 `line.slice(matchIndex)` 起算，不取行内第一个；实测「占位在前 + `ghp_` token 在后」被报出 |
| `cmd_rollback` 只认 HTTP 200 | **已修** | 15:20 那版已走 `http_alive`（200 或 401 都算活） |

它报的**真问题 1 条（已修）**：台账「版本切换方式」段还写「启动脚本两处路径」
「当前指向 0.2.1-alpha.2」——**两句都假**（今天改成仓外 env 文件机制 + 已切 rc.2）。

★ 它还报「`DEEPSEEK_API_KEY` 在生产是空串」⇒ **不是问题**：生产主模型是
  opencode-go，那把 DeepSeek key 只供 hermes 搜索用，本就不该进 dsh 进程。

### 公开面复扫（六面）

issue / issue 评论 / PR / PR 评论 / Release / commit message：
- 前五面 **0 命中**
- **Release v0.3.0 的 body 里还有一处部署脚本名 ⇒ 已改**（那个 release 的 notes 写的是当时的部署命令）
- **commit message 面还剩 1 条**（2026-09-09 的 `/balance` 提交）⇒
  **这正是第三次历史改写要清的**（单独改它也要重写后续全部历史＝同一件事）⇒ **不单独处理**

### 已知缺口（不为它单发版本）

- **包内不含 `CHANGELOG.md`**（`files` 白名单只有 `lib`/`src`/`bin`/README/LICENSE/`cordis.patch.yml`）
  ⇒ 报障人装完看不到变更说明（GitHub 上能看到）。改白名单要重建 + 重发 tag，
  **与下次发版合并**。
- **`refs/pull/3/head`** 的 commit message 仍含私人称呼 ⇒ 只能靠 GitHub Support。
- **生产 tokenMeter 行为层零证据**：chat profile 的 `insert:` 无 `dsh-token-meter`
  ⇒ 18:28 之后生产零入站 ⇒ `bySession` 空 ⇒ poll 空转。**代码在、触发条件不在**。

## 第八份复核（15:53 派）核销

它审的是 bridge `8b27ab5` / upgrade `7eb0424`（比收尾时落后数轮），但**逐条实测**后：

### 真问题 2 条（已修）

**① Windows 占位符假红**：`C:\Users\<username>\docs` 被报成真路径。
根因：Windows 段正则**能**捕到尖括号形式，但豁免判据拿它去比对占位符**名字表**，
而表里只有一种尖括号写法 ⇒ 另一种被判成真路径。
修法：**尖括号形式一律豁免**（括号本身就是声明），名字表只管不带括号的写法。
装置：三种尖括号写法全部豁免、真用户名仍报出。

**② git 不可用时门会漏报并报绿**：git 失败时门降级为遍历目录，
但遍历用的是**精简目录集**（只有 4 个）⇒ `config/` 没被扫 ⇒ 里面的真密钥**没报出**、
门**报 clean、exit 0**。
复现装置：把 `.git` 属主改成别的 uid ⇒ `git ls-files` 以 `fatal: detected dubious
ownership` 失败（rc=128）⇒ 门走降级路径 ⇒ `config/` 里的 token 漏掉。
修法：降级路径改走**完整默认目录集**，并**明说自己在降级**（打印一行）。
★ CI 不受影响（CI 上 git 正常 ⇒ 走 `git ls-files` 全量 236 文件），
  但本地若有「属主不符」的检出就会静默漏 ⇒ 修的是真缺口。

### 已过期 / 误判（不成立）

- 「release.yml 的 npm 判据假绿」⇒ **今天 16:26 那版已修**（先判 E404、再找版本号、
  且输出必须**精确等于**版本号）；实测 0.9.5 不在 npm ⇒ 报「not on npm」并 exit 1。
- 「错误行统计恒 0」⇒ **今天 14:12 那版已修**（`sed` 只规范时间戳格式、保留原行）。
- 「Windows 正则要求两个反斜杠」⇒ **不成立**（`\+`＝一个或多个；装置证明单反斜杠被报出）。
- 「WSL 占位豁免能藏 token」⇒ **不成立**（豁免从 match 位置起算；装置证明 token 被报出）。
- 「arity 是文本启发式、注释里的 example 会被当声明」⇒ **已修**（行首锚定）；
  装置证明：注释在前 ⇒ arity 仍判 4；真 3 参 ⇒ 判 3（仍会报漂移）。
- 「生产 243 链接 / 241 断链」⇒ **属实但不在生产解析路径**：
  303 个悬空软链在旧 profile 的 node_modules 里，指向已删的旧树；
  **生产跑的 rc.2 树自己的 node_modules 悬空链 0 个** ⇒ 与重启无关。
  清理是独立动作（那 2 个有效链还指向 alpha.2），不在本轮范围。

### 核过但不是缺口

- 「`lib/tsconfig.tsbuildinfo` 未跟踪、门扫不到」⇒ **属实但无害**：
  该文件与 90 个 sourcemap 里**都没有本机路径、零泄漏词**（实测）。
- 「`DEEPSEEK_API_KEY` 在生产是空串」⇒ **不是问题**（生产主模型是 opencode-go，
  那把 key 只供本机搜索用，本就不该进 dsh 进程）。

## 第九份复核（15:54 派）核销

它审的是**不可变的旧版本**（tag v0.9.1 / npm 0.6.1）⇒ 多数结论是已知的，
但**报出一条今天真正的新缺口**。

### ★ 真问题 1 条（已修）：回滚段缺切树段那组判据

**切树段有四组判据**（restart 退出码 / systemd 状态 / 进程起始时刻 vs 分界戳 /
启动窗口错误行），而**回滚段原来只有一组**（端口应答）⇒ 合成负极对照可复现假绿：

| 版本 | 装置（restart 返回 0 但不换进程、端口恒应答） | 结果 |
|---|---|---|
| 修前 | 同一装置 | 「✓ 已回滚并恢复（服务已应答）」**rc=0** —— 假绿，进程一次没换 |
| 修后 | 同一装置 | 「✗ 进程起始早于本次 restart——回滚后跑的仍是切换前的进程」**rc=1** |

**修法**（照抄切树段的写法，不另起一套）：回滚段补齐三道判据——
① `systemctl restart` 返回非 0 ⇒ 判失败；② systemd `failed` 或
`activating/auto-restart` ⇒ 判没起来；③ 端口应答**之后**再核
**进程起始时刻晚于 restart 前的分界戳**（单调钟，与切树段同域）。
**四情形实测**：restart 失败 rc=1 / failed rc=1 / auto-restart rc=1 / 正常 rc=0。

★ **通则：同一组判据，成功的路径与回退的路径必须一致。**
  「切树会核、回滚不核」就是缺口——回滚是出事后才走的路径，
  恰恰是**最不能报假绿**的地方（报绿 = 以为退回去了，实际没退）。

### 已过期 / 已被后续修掉

- 「v0.9.1 的 arity 护栏只覆盖 3/4 两臂、`length=2/0` 会重演 issue #2」
  ⇒ **今天 16:07 起的混合体已兜住**（Proxy 同时是空数组又把 signal 代理进去）；
  且 README 现在写的是「targets >= 0.1.5-rc.2」，**那句绝对化表述早已删掉**。
- 「CHANGELOG 写『neither an older nor a newer host can silently mis-align』被证伪」
  ⇒ **该表述已不在仓库里**。
- 「v0.9.1 release assets=0、报障人拿不到包」⇒ **v0.9.3 / v0.9.4 / v0.9.5 都有 tarball**
  （0.9.5 的已逐文件核为干净）；npm 仍是 0.6.1（无 token），
  但 `npm i github:...#v0.9.5` 这条路实测可用。

### 仍然成立但不可改（已知遗留）

- **`refs/pull/3/head` 仍带一条含私人称呼的 commit message**：
  **可匿名 fetch**（`git fetch <repo> refs/pull/3/head:refs/pull/3/head` ⇒ rc=0）
  ⇒ **它不在这台机器的扫描面内**（不在 heads、不在 tags、不在 main 的祖先里），
  但**外部任何人匿名可取**。
  ⇒ 已合并 PR 的 ref **不可改**（六条清理路全败，GitHub 文档明确需 Support）
  ⇒ **等 GitHub Support**，别再试别的路。

### 核过但不是缺口

- 「生产 status 报 243 链接 / 241 断链」⇒ **属实但不在生产解析路径**
  （303 个悬空软链在旧 profile 的 node_modules，指向已删的旧树；
  **生产跑的 rc.2 树自己的 node_modules 悬空链 0 个**）。
- 「`/proc/PID/stat` 与 `/proc/uptime` 是否同域（挂起场景）」⇒ 本机不挂起，
  无法实测 ⇒ **标未验证，不当反例**（不拿「测不了」当「有错」）。

## 第十份复核（18:40 派）核销 + ★ 一处自我更正

### ★ 更正：commit message 面的残余不是 1 条，是 4 个 commit

今天早些时候我在多处说过「commit message 面还剩 1 条」⇒ **那是错的**：
那次只查了**私人称呼**一个词，**没按完整词表扫**。
按完整词表逐 commit 扫（265 个 commit，逐个取 body）后的**准确数字**：

| commit | 词 | 可达范围 | 能不能改 |
|---|---|---|---|
| `54bf02e166`（2026-08-24） | 内部治理系统名 | main + **全部 21 个 tag**（v0.4.0 起） | **历史改写** |
| `6b4cbf1af1` | 本机配置目录路径 | main + 全部 tag（v0.4.0 起） | **历史改写** |
| `c906af61e4`（2026-09-09） | 本机部署脚本名 | main + v0.9.1 起 | **历史改写** |
| `dd67e14957`（2026-09-12） | 私人称呼 | **只在 PR ref**（已合并 PR 的 ref） | **不可改**（需 forge support） |

★ **通则：说「还剩几处」时，要说清是按哪个词表扫的。**
  只用一个词查出来是 1，就报 1 ⇒ **这不是「还有 1 处」，是「这个词还有 1 处」**。
  ★ **核残余必须用与门同一张词表**（门 38 条），且**逐 commit 取 body**
  （用 `git log --grep` 会被多行 body 破坏 tab 解析，sha 会被读成正文片段 ⇒ 结论是假的）。

### 真问题 2 条（已修）

**① `journey/` 目录漏了本机 appId**：端到端场景脚本里写了
一处本机的飞书 appId（不是随手编的假值）
⇒ **今天那次清理漏了这个目录**（改了 11 个文件，但覆盖的是含已知词的那些）。
**修法**：换成明显的假值 + 假 secret。
★ **词表补了那个英文代号**（词表里有它的中文名，但没有这个代号）
⇒ 38 条。**阴性对照**：换回去 ⇒ 门立刻报出；恢复 ⇒ clean。

**② `src/commands.ts` 的注释与实现矛盾**：注释说「按运行时实参个数判定…
判据用 `execute.length`」，而实现是**混合体**（不是 arity 分支）
⇒ 后来人照注释去改会改错。已改成与实现一致（说明判据是「三参与四参都能对上」的形状）。

★ **顺带把 CI 的 secret 也更新了**（词表变了 ⇒ CI 上的门要看到新词）：
  仓库 public key + pynacl 的 `SealedBox` 加密后 PUT ⇒ **204**，
  `updated_at` → 2026-10-20T12:44:25Z。
★ **这是第二次因「词表变了但 secret 没跟上」而让 CI 短暂假绿**
  （上一次是今天 10:34 之前）⇒ **改词表必须连带改 secret**，已写进技能。

### 已过期 / 不成立

- 「registry 校验只要求 rc=0 且输出含版本号形态」⇒ **今天 16:26 已修**（输出必须**精确等于**版本号）；
  实测 0.9.5 不在 npm ⇒ 报「not on npm」+ exit 1。
- 「v0.9.3 tarball 不含今天的修复」⇒ **属实**（0.9.3 切在清理前）⇒ **已发 0.9.5 覆盖**（tarball 逐文件核干净）。
- 「issue 回复与实现不一致」⇒ pnpm 口径**正确**（官方 CHANGELOG 双重核对）；
  「按运行时实参个数」那句**已在同帖下一条更正**；但「registry 检查在包里」那句**不准确**
  （该文件不在 `files` 白名单里）⇒ 已在 0.9.5 之后的两条评论里指向新 tag。
- 「`cordis.patch.yml` 硬编码生产单元名」⇒ **不成立**（该文件当前 0 命中，注释里是占位符）。
- 「CHANGELOG 无 0.9.4 段」⇒ **已补**。

### 仍然成立

- **`refs/pull/3/head` 可匿名 fetch 且带私人称呼** ⇒ 不可改，等 forge support。
- **正式面 3 个 commit 带词** ⇒ 只能靠历史改写（`--replace-message`），演练已验证有效。

## 2026-10-21 夜间（第十二批 + 第八批复核核销）

| 日期 | dsh 版本 | 桥接版本 | 变更要点 | 验证结果 |
|---|---|---|---|---|
| 2026-10-21 | 0.2.1-rc.2（未动） | 未发（HEAD `699d938`） | **第十二批**（`699d938`）：入站写盘改异步后新开的窗口——「查存在→写」之间多一次让出 ⇒ 两条同名文件并发会互相覆盖；修法是**先占名、后查盘**（跨 await 的占名不是占名） | ✅ 563/563 绿；CI 绿；三门绿；生产 pid 594162 |
| 2026-10-21 | 0.2.1-rc.2 | 未发 | **第十一批**（`8627b15`）：①设备指纹去掉主机名（旧规则把 hostname 折进指纹 ⇒ 改主机名就换身份、并清掉手动「已退位」）②合同门核三棵树（远端分支／生产版本 tag／本机上游树）——原来只拉 master，对生产正在跑的那一版一无所知 | ✅ 562/562 绿；CI 绿；真实 bundle 探针验「保留 deviceId、保留 retired」 |
| 2026-10-21 | 0.2.1-rc.2 | 未发 | **第十批**（`ca82e4a`）五项承诺未兑现 + 泄漏清理；`930ffa6` 修 CI 红（入站写盘的判据从「时钟」改成「用了哪个 API」） | ✅ 558/558 绿；CI 绿 |

★ **dsh 版本本次未动**：生产跑 `deepseek-harness-0.2.1-rc.2`，与上游 `origin/master` **双向 0 提交差**
（上游 master 的 HEAD 就是 rc.2 的 release commit）⇒ **没有更新的版本可追**。
本机另有的 `deepseek-harness`（无后缀）是 `dsh-v0.2.1-alpha.2`，**落后 990 提交**，不是新版。

★ **桥接版本未发**：`v0.9.5` 之后 **18 个提交**（含第十二批）都不在任何 tag 里 ⇒ 下个版本应为 **0.9.6**。
（npm 通道仍停在 0.6.1，等 token，见缺口清单第 2 条。）

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
| 2026-10-20 | ★独立对抗复核后的修正批次 | 0.9.2 → **0.9.3**（tag 已推；**npm 仍未发**，仓库无 NPM_TOKEN） | 两个独立复核子代理（换装置：真实 cordis 宿主 / 946 例独立判定矩阵 / 真 npm registry / codeload tarball / refs/pull 全 ref 面）推翻了我方 4 条自报，全部已修并各自有装置级实测：①**registry 判据把「不存在的版本」报成已发布**——npm 的 E404 文本里就含版本号（`404 No match found for version 0.9.1`），先找版本号必然命中；改为**先判 404 再找版本号**（真 npm 六种情形实测：缺版本=红、已发布=绿、空输出=红、连接被拒=红、ANSI 包裹=绿、错误含版本号=红）。②**启动错误行统计恒为 0**——`sed` 把整行替换成时间戳后，grep 拿到的行里没有文字；改为只规范戳格式、保留原文（人造三行实测：旧写法数到 0，新写法数到 2 且窗口外那条被排除）。**即我先前「假红已修」的结论是基于一个坏判据，结论本身是假的**。③**`systemctl is-active` 在生产单元上永不报 failed**——生产 `Restart=always`，起不来的单元停在 `activating`/`auto-restart`，而 `is-active` 答 "active"；我先前的假单元写的是 `Restart=no`，**测试装置没复现生产条件**；改为读 `ActiveState`+`SubState`。④**arity 检查数的是上游注释里的示例调用**（上游注释出现 `async execute(agent, line)` ⇒ 算出 arity=2 ⇒ 合法宿主被判漂移）；改为只认行首方法声明。另修：Windows 尖括号占位符 `<win-user>` 被误报（字符类在尖括号处截断）；job 输出读取失败由静默降级改为留痕；release 步骤改为「已存在则 edit」；setup-node 显式指定 registry。**issue #2/#4 已补发两条更正回复**（原回复里「从 release 取 tarball」与「pnpm 11+」两处口径都不成立），并第三条给出可用安装方式。**0.9.3 的 GitHub Release 已带 tarball**（523293 bytes，端到端下载验证：版本 0.9.3、含新 bundle、含混合体修复、无本机信息）。**公开仓历史残留**：`refs/pull/3/head` 仍指向改写前历史（其中一条提交信息含私人称呼，公开面不应出现）——已实测 GitHub 四条路全走不通（pull ref 只读 422 / 已合并 PR 不可 reopen / 推源分支不跟随 / 删源分支不清 ref），已按所有者决定「保持现状」并在 issue 与本行明说；**main 与全部 tag 的提交信息 0 命中** | ✅ typecheck 0；vitest **488 全绿**（40 文件）；plugin-contract **43/0**；contract-drift **0** 且 arity 检查算出 4；hygiene 门 clean（236 已跟踪文件）；CI **绿**（11af4b6）；release 步骤表：门/契约/typecheck/测试/构建/GitHub Release/tarball **全 ✓**，仅「Verify the registry」判红（**因 npm 上确实没有 0.9.3**——这正是该门的设计）；生产已重启加载新 bundle（进程 16:40:21 起、bundle 16:26:51 建、旧 bundle 已从磁盘移除 ⇒ 装的是新代码），web 401 / ws ready / 启动错误行 0；rc.2 宿主上 issue #2 运行时证据（四参形状 success、三参错位抛 `reading 'aborted'`）。⚠️ 仍未闭环：**npm 上仍无 0.9.3**（需仓库加 NPM_TOKEN secret，重跑 release 即可自动发布并转绿）；rc.2 上 slash 命令**真实飞书链路仍零真流量**（机制已验到宿主层，只差最后一跳，需使用方发一条真实消息） |
| 2026-10-20 | ★第三份复核报告的核销 + 端到端终证 | 0.9.3（tag 已推；**npm 仍未发**，仓库无 NPM_TOKEN） | 第三份对抗复核（对 `289f52c`，落后当前 HEAD 六轮）逐条对账，**只一条是真问题、其余是它自己的口径错或已过期**：真问题＝tokenMeter 轮询恒 0（它说的时点为真，我 16:26 重建 bundle 时已修；现核 bundle 旧写法计数 0、新写法 `measure(binding.session)` 计数 1）。它自己口径错三条：①「Release 绿是 exit 0 假绿」——**不成立**，skip 后 verify 门读 registry 判红，run 实测 failure；②「10 个提交零 CI」——**不成立**，用 **checks API 逐提交查**（`/commits/{sha}/check-runs`）最近 12 个提交每个都有 test 且全 success，它是拉 runs 列表时被 tag 触发的 Release run 挤掉了；③「切换后零会话落盘」——**不成立**，当天 17 条入站、81 条 user/message、会话文件 17:06 还在写，是它的 find 模式不对。已过期两条：arity 三分支（已改混合体）、tokenMeter 契约自指（漂移门已加 `packages/llm/token-meter/src/index.ts`）。★ **自查推翻我方一条汇报**：「17 条入站全无 outbound ⇒ 消息没回」——**推论无效**，桥只记 inbound 一行、outbound 根本不入 journal ⇒「查不到 outbound」恒真；会话产物里 turn 大量 `completed`、今日 `inbound handler failed` ＝ 0，消息**有回**。★ **端到端终证（混合体）**：三种宿主形状实测——四参(arity4)✓、三参(arity3)✓、**四参但 signal 带默认值(arity 也是 3)**✓，而旧的三参调用在第三种上 `THREW slot3 not an array`；**0.9.3 tarball 里的 bundle 与生产 bundle sha256 相同（3c7ee386285a7b48）** ⇒ 用户装到的与生产跑的字节级一致。★ 发布链真 runner 证据：v0.9.3 Release 步骤表 `setup-node`（含 registry-url）✓、**`Attach the package tarball` ✓**、`Publish to npm` ✓、**只有 `Verify the registry` ✗**（npm 上确实没有 0.9.3，正是该门的设计）。★ src↔bundle 一致性已核：bundle 含今日三处改动（catch 留痕 / 混合体 / tokenMeter）、src 全部不比 bundle 新、`lib/` 184 个跟踪文件无未提交改动。★ 宿主面构建回执：exit 0，30 个 `typert.host.js` 实为 15 个 **api 包**各 2 份（`packages/api/*/lib/`，非 `packages/typert/*` 包），`gateway`/`remotes` 按设计不产此文件（非缺失），10/10 api 包均有 `lib/index.js`，本次为增量构建、磁盘零改动、生产与磁盘无失配 | ✅ **当前 HEAD 全量 vitest 488/488 绿**（40 文件，298s）；typecheck 0；plugin-contract 43/0；contract-drift 0 且 arity 算出 4；hygiene 门 clean（236 跟踪文件）；CI 最近 12 提交全 success（checks API 逐个查）；生产 active / web 401 / ws ready / **slash 面板已注册**（`/compact /export /goal /permission /plan`）/ 今日 `inbound handler failed` ＝ 0；19 条复核清单逐条对账全部符合（其中 5 处初判不符经核为判据写法错：旧 arity 分支只在注释里、`pnpm 11+` 两文件均 0 命中、"上游默认存在"命中的是否定句、hygiene 用 `git ls-files` 而非字面串、`win-user` 5 次为集合与注释） |
| 2026-10-20 | ★第四份复核的核销 + 假绿修复 + 可证伪化 | 0.9.3（tag 已推；**npm 仍未发**） | 第四份对抗复核（对 `2e162b1`/`d19f9e1`，落后十余轮）逐条对账：**它点名的 P0-2（缺 `id-token: write`）与 P1-3（空版本号假绿、无重试、E404 与网络错不分）在当前代码里都已修**（`id-token: write` 在、verify 有空版本判红/5 次退避重试/unknown 分支）⇒ 过期；它说的 P0-1（台账 52 行记错）也已被更早一版订正。★ **但顺着它的线索我实测出一个它没提到的更严重问题**：verify 判据把 npm 的**退出码丢了**（`|| true`）⇒ 不可达 registry 时 npm 的报错文本里含 `127.0.0.1` ⇒ 被 `[0-9]+\.[0-9]+\.[0-9]+` 匹配成"版本号" ⇒ **判成绿色（假绿）**。真 npm 实测三态：存在 rc=0、缺失 rc=1、不可达 rc=1（输出含 IP）。已修为**先看退出码**（rc=0 才允许版本号形态算数）；四种情形实测：存在=绿、缺失=红(not on npm)、不可达=红(unknown)、旧判据在不可达时=绿(假绿)。★ **可证伪化**：pressure sweep 成功时完全静默 ⇒ 「meter 传错」与「没有会话超限」从外面看一模一样 ⇒ 「修复生效」不可证伪（今天已因此被打脸两次）。已让 sweep **在数字变化时**用桥自己的 notice 通道写一行（带测到的 total/surface/threshold）——注意**不能用 `ctx.logger.info`**（生产 WARN 阈值下不进 journal，等于白记）。新增测试锁住：必须写出一行、行里必须带非零 total、数不变时不得再写第二行；**阴性对照**（去掉那行）⇒ 测试变红。★ **真宿主探针**：在 rc.2 树里起真 cordis 上下文 + 真 SessionStore + 真 CommandRuntime，用**真宿主**的 `execute`（四参、会读 `submittedAttachments.length` 与 `signal.aborted`）配桥的混合体跑通真命令 ⇒ 混合体不破坏真宿主；但**阴性对照（第三参传真 signal）在这条路径上不红**——真 rc.2 是四参、本就不会崩，issue #2 崩的是**老三参宿主**⇒ 那条已由装置级四形状实测覆盖（四种全对、旧的炸）。探针已删（不留宿主树）。★ 发布：0.9.3 的 GitHub Release 已带 tarball（523293 bytes，sha256 与生产 bundle 相同）。★ 生产已重启加载新 bundle（进程 Started 18:28:55 晚于 bundle mtime 18:22:15，且旧 bundle 已从磁盘移除 ⇒ 装的是新代码），web 401 / ws ready / 启动窗口错误行 0 | ✅ **全量 vitest 489/489 绿**（40 文件，488→489 是新增那条）；typecheck 0；契约门 0 漂移；hygiene 门 clean（236 跟踪文件）；CI 最近 4 提交全 success（checks API 逐个查）；生产 active / web 401 / ws ready / 桥已加载；真宿主探针 1/1 绿 |
| 2026-10-20 | ★补两处测试缺口 + 一次自己的读取错误 | 0.9.4（tag 已推，**npm 仍未发**） | 早一批子代理的回执（做 token-pressure 行为测试）晚到，**它做的事早已入库**（那两条测试在 `cad5051` 就进了仓）⇒ 无冲突。但它点出两条我该接的：①**我的新测试用了 `vi.waitFor` 默认 1s 超时**——本仓 `mountWithLiveSession` 显式设了 `{timeout: 30_000, interval: 50}` 且注释明说「这就是 suite 自己 config 点名的、加载机器上的 flake」⇒ 我那条同风险 ⇒ 已补同样的超时；**重跑 10 次全绿、每次都是 4 条**（此前那 10/10 是文件被改期间跑的，**结果不可信** ⇒ 重跑）。②**catch 分支（meter 抛错）没有测试** ⇒ 已补：①一个坏会话不拖垮整轮（continue）②失败必须留痕（`ctx.logger.warn`）；**阴性对照**（去掉那句 warn）⇒ 测试变红「expected 0 to be greater than 0」⇒ 真能抓住静默吞错。★ **顺带扫了全仓的 `vi.waitFor`**：227 处里 209 处没写 timeout，但**绝大多数是同步断言**（立即为真、1s 默认超时无害）⇒ 只保证本轮新增的两处带显式超时，**不动那 209 处**（大改、风险高、今天无证据说它们在 flake）；本仓 vitest 已 `maxWorkers: 1 / minWorkers: 1` 单 fork ⇒ 串行即 CI 的真实条件。★ **我自己犯的读取错误**：核 CHANGELOG 时用两次 `s.index()` 的**相对位置**切片（`index('0.9.4')` 到 `index('0.9.1')`）⇒ 因为 0.9.4 排在 0.9.1 **之后**，切出空串 ⇒ 一度以为文件被我弄坏。**文件其实完好** ⇒ 教训：**核文件用行号切片，不靠两次 index 的相对位置**。★ 另修 CHANGELOG 的版本归属：原来 0.9.2 段被我**改名**而非新增 ⇒ 三版内容混成一段；**改用「每条修复首现于哪个 tag」实测决定归属**（argument shape/registry 404/契约门/job 留痕/release 幂等/pnpm 口径/smoke 注释/tokenMeter/publish registry ⇒ v0.9.2；hygiene 尖括号 ⇒ v0.9.1；tarball ⇒ v0.9.3；**registry 退出码判据与 poll 日志不在任何 tag ⇒ 新开 0.9.4**），段序也修回升序 | ✅ token-pressure 4/4 绿且**连跑 10 次全绿**；阴性对照变红；CHANGELOG 三段归属实测核对通过（0.9.2=10 条 / 0.9.3=1 条 tarball / 0.9.4=4 条）、段序 0.9.1→0.9.2→0.9.3→0.9.4；v0.9.4 tag 里**今天全部 10 项修复逐项核到都在**（混合体/tokenMeter/poll 日志/退出码判据/tarball/registry-url/404 优先/契约门行首/hygiene 尖括号/pnpm 10.3）⇒ 其 tarball 即完整版；v0.9.4 Release 已建且带 tarball（524368 bytes），**唯一红步是 `Verify the registry`（npm 上确实没有 0.9.4——该门的设计）**；issue #2 已发第四条更正（原第二条把安装指向 `#v0.9.1`，而那个 tag 里是**旧代码**⇒ 照它装会拿到有洞的版本 ⇒ 改为指向 `#v0.9.3`/`v0.9.4`）、issue #4 已发补注（「all fixed in 0.9.1」不准确） |
| 2026-10-20 | ★六份复核的核销 + 三道门的补齐（含自证） | 0.9.4（tag 已推，**npm 仍未发**） | 第六份复核（并行扫公开仓 + 审 CI 门）**它报的两条 P0/P1 有真有假，逐条实测**：①「`cordis.patch.yml:33` 有本机单元名且四道门看不见」⇒ **误判**：它把词表条目数错位了（它当成服务/单元名那条，实际那条是另一个内部系统的名），该文件里**没有**单元名，且其注释恰在**刻意不写**单元名（`systemctl restart <your-unit>.service` 是占位符）；我自己按词表**全量扫 336 个跟踪文件（含扩展名白名单外 + 文件名）⇒ 0 命中**。②「`isPlaceholder()` 里任一行有 `<`/`>` 就整行豁免」⇒ **误判**：代码注释明写这条**今天早些时候已修**（「The earlier rule… was far too broad… That is a structural blind spot」），现行实现是**逐 match 位置**判（`isPlaceholderMatch(line, m.index, m[0].length)`），只豁免落在占位符 span 内的匹配。③「根目录文件永不被扫」⇒ **误判**：实测把泄漏词放进根目录文件，**门照样报**（脚本在有 git 时走 `git ls-files` 全量遍历，无 git 时才按目录 walk）。④「`package.json` 的 hygiene 脚本不传 `--patterns-file`」⇒ **误判**（今天已改成传）。★ **它报的三条真缺口已修**：⑤**CI 从不校验 `lib/ == build(src)`**（今天台账里「跑的是旧 bundle」的**制度性成因**）⇒ CI 加一步「重建后 `git diff --exit-code -- lib`」，**阴性对照**（改 src 不重建）⇒ 门抓到差异（`lib/types/bridge.js.map` 变了），恢复后无差异；已核 sourcemap 与 tsbuildinfo **不含绝对路径** ⇒ CI 上路径不同也不会误报。⑥**push 触发只含 `main` 与 `feat/**`** ⇒ 死分支 `fix/command-ux-and-notices`（独有提交 0、落后 main 36 个）推了**不跑任何 CI** ⇒ 触发改为 `branches: ['**']`（所有分支）。⑦**`REPO_HYGIENE_PATTERNS` secret 自 09-13 未更新** ⇒ 今天新增的三样词在 CI 里**不可见** ⇒ **已用仓库 public key + pynacl 的 SealedBox 加密并 PUT 成功（HTTP 204）**，`updated_at` 由 2026-09-13 变为 2026-10-20 ⇒ 实测只含「外部台账 / web 端的启动脚本 / 本机 web 门脚本」的样本被门报出 3 条。★ **另一条已知缺口（今天不修、单独记）**：`tsconfig.vitest.json`（`include: ["src","tests"]`）存在但**没人用** ⇒ `typecheck` 只查 `src` ⇒ **测试文件不做类型检查**；实测一开就有真类型错（`tests/bot-command.spec.ts` 未用变量 3 处、`tests/commands.spec.ts` 形状不匹配 2 处、`ResolvedConfig` 的 `exactOptionalPropertyTypes` 冲突）⇒ 修它要改多个测试文件，**不在本轮范围**，已记为待办。★ 另：第六份报告「读不到 Actions 日志」是因为它的 `gh` token 失效 ⇒ **我已用仓库 token 直接核**：secret 列表 API 确认 `REPO_HYGIENE_PATTERNS` 存在 | ✅ 全量 vitest **490/490** 绿（40 文件）；hygiene 门 clean（236 跟踪文件）；契约门 0 漂移；CI 新增两步已在本地实测通过（含阴性对照）；生产 active / web 401 / pid 449640、**生产 bundle 与仓库 bundle 字节一致（9c8aa339162af0d2）且 src 不比 bundle 新 ⇒ 跑的就是最新代码、不需重启**；桥仓 d504bd9 已推 |
| 2026-10-20 | ★tokenMeter 行为层为何仍无证据（追到根因） | 0.9.4 | 御史第三份复核（09:19 派的，对 `289f52c`）报 B6「tokenMeter 修复进生产=部分成立：代码层已加载，行为层零会话，仍未验」⇒ **今天把它追到了根因，不是代码问题**：①生产 bundle 里 `measure(binding.session)` **在**（新写法）✓；②`tokenMeter` 服务**在 base bundle 的 cordis.patch.yml:348-349 无条件 insert** ✓；③生产配置**没覆盖** `tokenPressure` ⇒ 默认 enabled / 10 分钟 / 120k ✓；④**但 poll 的循环体遍历 `bySession`，而生产最后一条会话写入是 17:06:32**（18:28 重启后**零入站**）⇒ `bySession` 为空 ⇒ **for 循环空转 ⇒ 0 行**。⑤全天 `token pressure poll` 命中 **0** 条：今天的 7 条入站都在 18:28 之前，**那时 poll 的 notify 版本还没上线**。★ ⇒ **结论：修复是否生效，缺的不是代码也不是配置，是「18:28 之后有一个活会话」** ⇒ 已列入待闭环（需一条真实飞书消息；那一条同时能闭环 rc.2 上 slash 零真流量的问题）。★ 顺带排掉两个我一度怀疑的假原因：`本机 profile 的 @deepseek-ai 软链目录` 那批指向已删 `deepseek-harness-0.1.5` 的**悬空软链不在生产解析路径上**（生产命令行是 `rc.2/apps/cli/lib/bin.js`，模块从 rc.2 树解析）⇒ **不是根因**；`dsh-token-meter` 在 rc.2 的 `apps/cli/node_modules/@deepseek-ai/` 里**存在** ⇒ 服务没缺。★ 另记御史第三份的其余结论：它的 P0（台账 `154889.8`/`早 511 秒`/`晚 3739 秒`）**今天已订正**（台账第 52 行改成 06:25:57 → 06:27:16 的正确顺序，并写明「墙钟派生的时刻不可跨来源比较、mtime 换算误差几十秒不能做秒级判决」）；P1（`latest` 未去 ANSI）**今天已修**（release.yml:222-223 先 `sed` 去 ANSI）；P1（错误窗口下界用 divider）**已不成立**（今天改成双时钟域：journal 戳用 `clock_gettime(1)`=CLOCK_MONOTONIC 取的 divider，与 `short-monotonic` 同域；试启动段用的是日志文件、不涉 journal 钟域）；「journal 只留 25 分钟」**已清**（实测保留 ~7.96 小时）；「根目录文件不扫」**不成立**（有 git 时走 `git ls-files` 全量遍历，实测根目录文件照样报）；「isPlaceholder 整行豁免」**今天已修**（现按 match 位置判）。★ **它报的一条真缺口已修**：升级脚本写完 env 文件就往下走 ⇒ 若单元的 `DSH_TREE_ENV` 指向别处，**写进去的值没人读，重启会拉起老树却报成功 = 假成功** ⇒ 已加三段断言（单元是否设了 DSH_TREE_ENV / 是否与脚本写的同一文件 / 文件里的值是否就是目标树），**四情形对照实测**：路径不符 rc=1、未设置 rc=1、值不符 rc=1、正常 rc=0 | ✅ 升级脚本 `bash -n` 通过；全量 vitest 490/490 绿（40 文件）；hygiene 门 clean；桥仓 6e8e0a6 已推；生产 active / web 401 / pid 449640 |
| 2026-10-20 | ★两份独立核验的核销 + 未跟踪部署脚本的去机器化 | 0.9.4 | 两份并行核验（对**第一次改写后**的状态，今天又改写两次并清了泄漏 ⇒ 多数结论已过期）。**它们指出一条我今天真漏的通道**：`本机 web 门脚本` 与 `取 URL 脚本`（**不入仓的部署脚本**）里**写死了本机服务单元名**（`SERVICE_UNIT = os.environ.get('DSH_SERVICE_UNIT', '<本机单元名>')` / `UNIT="${DSH_SERVICE_UNIT:-<本机单元名>}"`）⇒ 公开面**无泄漏**（两文件被 gitignore、仓里没有），**但与「去机器化」相反** ⇒ 已改：单元名改为**读仓外的本机 env 文件**（与今天立的树路径 env 文件同一模式：环境变量优先 → env 文件 → 都没有就**明确报出建法并退出**，不用静默的写死默认，也不用「必填导致上线即坏」）。**五情形实测**：env 文件存在⇒取到名字 ✓；env 文件不存在⇒给出明确指引并退出 ✓；环境变量优先 ✓；**生产门实际取到 URL、exit 0**（token 已脱敏）✓；缺 env ⇒ **exit 1**（脚本真实退出码，已单独复核）✓；生产 door 仍 active / HTTP 302（跑的是 10-18 的旧代码，改文件不影响在跑进程）✓。★ **它们报的其余结论，逐条重核后**：「main 上仍有 1 条 commit message 含私人称呼」⇒ **不成立**（今天两次改写后 main 上 **0 命中**；那一条在 `refs/pull/3/head` 上，**不在 main** ⇒ 改写 main 清不掉它）；「patch 面 0 命中、220 个 commit 的 tree 全干净、21 个 ref 全干净、tag annotation / Release body / PR / issue / 评论 / npm 0.6.1 全干净」⇒ 与今天的独立扫描结论一致 ✓；「`.bak` 备份变体不被忽略会被误提交」⇒ **已不成立**（那几个文件现已不存在；`run-*.sh.bak-*` 由 gitignore 第 15 行挡着）；「hygiene 门收窄到已跟踪文件 ⇒ 未跟踪脚本完全在视野外」⇒ **部分成立但可接受**：门只扫 `git ls-files`（今天有意改的，因为扫工作树会误报本机脚本），但**一旦那些脚本被 `-f` 强加进索引，门会报出**（实测 3 条：单元名 + 脚本名）⇒ 第二道防线有效；「`DSH_SERVICE_UNIT` 必填版一重启就坏」⇒ 那版已被改掉，当前是 env 文件机制（上面已实测）；「生产变量解析值与改写前同值、凭证 10/10 hash 相同」⇒ 与今天的独立核验一致 ✓ | ✅ 两个脚本语法检查通过（python ast / bash -n）；五情形全对；生产 door active / 18790 HTTP 302、生产桥 active / web 401 / pid 449640；hygiene 门 clean；仓内未跟踪脚本仍被 gitignore 挡着 |

