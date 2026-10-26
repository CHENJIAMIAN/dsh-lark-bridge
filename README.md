<p align="center">
  <a href="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml"><img src="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-594%20passing-brightgreen" alt="tests">
  <a href="https://dshbase.com/plugins/moyu-good-dsh-lark-bridge/"><img src="https://img.shields.io/badge/dshbase-verified-blue" alt="dshbase verified"></a>
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
  <img src="https://img.shields.io/badge/transport-WebSocket%20long--connection-orange" alt="transport">
  <img src="https://img.shields.io/badge/fleet-web%20%7C%20desktop%20%7C%20CLI-7c5cff" alt="fleet">
</p>

<h1 align="center">🕊️ dsh-lark-bridge</h1>

<p align="center">
  <b>Run a full DeepSeek Harness coding agent inside Feishu / Lark</b><br/>
  <i>Native thinking process · approval cards · web/desktop/CLI fleet sync · one-tap
  account switching · balance &amp; peak/off-peak awareness — no public webhook URL needed.</i>
</p>

<p align="center">
  <a href="README.zh.md">中文文档</a> ·
  <a href="#-quick-start-in-60-seconds">Quick Start</a> ·
  <a href="#-use-it-like-a-user">User Guide</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-extend-it">Extend It</a> ·
  <a href="#-faq">FAQ</a>
</p>

---

## 🖼️ Screenshots

<p align="center">
  <a href="docs/assets/shot1.png"><img src="docs/assets/shot1.png" width="360" alt="Balance, account card, ack & thinking (illustrative)"></a>
  <a href="docs/assets/shot2.png"><img src="docs/assets/shot2.png" width="360" alt="/manual guide and the device fleet roster (illustrative)"></a>
</p>
<p align="center">
  <sub>Illustrative Feishu-style renders. Left: <code>/balance</code> (live balance + peak/off-peak phase), the <code>/bot account</code> switcher card, task ack and the thinking state. Right: <code>/manual</code> — the full in-chat user guide — and the <code>/bot devices</code> fleet roster.</sub>
</p>

## 🤔 What is this?

`dsh-lark-bridge` is a **Feishu/Lark IM channel for DeepSeek Harness** — a plugin that makes
your coding agent work right inside a chat. Each conversation (DM or group) drives its own
dsh agent, and everything the desktop UI shows lives in the chat:

- 🧠 **Native thinking process** — reasoning renders as Feishu's own "thinking" message;
  tool calls with icons, results showing their first few lines (the whole output stays
  in the session log). No black box.
- 🏁 **Every turn says it is over** — a turn ends with one plain line: how many tool
  calls it made and how long it took, so nothing has to be counted by hand.
- ✅ **Interactive approval cards** — risky operations become Allow-once / Deny cards,
  decision and decider written back.
- 🎯 **Live goal & todo cards** — long-running tasks update a card in real time instead of
  going silent; goals auto-resume after restarts.
- 🔌 **WebSocket long connection** — no public callback URL, no reverse proxy.
- 🌐 **Three-surface fleet sync** — web (browser), desktop (DSH Desktop) and the CLI share one `~/.dsh` session library; cloud arbitration keyed per ENDPOINT (`deviceId:form:profile`) means exactly one surface replies, and if the active one goes silent the fleet elects a successor automatically.
- 🔄 **One-tap account switching** — `/bot account` renders an interactive card of saved Feishu-app credentials; two taps to switch, synced to every surface.
- 💰 **Balance & peak/off-peak awareness** — `/balance` queries the DeepSeek open-platform balance live (per currency, timestamped); the model prompt carries the peak/off-peak tariff table so deferrable heavy work lands in the half-price windows.
- 📖 **`/manual` in chat** — the full eight-section user guide, one command away.

Feishu is the carrier; the work is still done by DeepSeek Harness itself.

## 🚀 Quick Start in 60 Seconds

**Prerequisites:** Node 22.19+ or 24+ (as `engines.node` requires), [pnpm](https://pnpm.io/installation) (recommended, see note), a DeepSeek API key, and the Feishu app on your phone.

**Harness version:** **DeepSeek Harness >= 0.1.7** — 0.2.1-rc.2 is the tree this bridge is
developed and run against. 0.1.7 is a hard floor, not a preference: it renamed
`agentPresets.standingKeyFor` to `acquireScope` (which returns a lease, held for the session's
lifetime) and replaced `jobs.onJobDone` with the `jobs.events` stream, and the bridge calls
`acquireScope` with no fallback — on a 0.1.5 host, composing a preset session throws. (0.1.5 is
where the user-questions seam moved to the `user-questions/request` waterfall; see the CHANGELOG
for that note.)

```sh
# 1. install the plugin into a dsh profile & boot (pnpm — ~20s, parallel install)
pnpm dlx @deepseek-ai/dsh plugin --profile web add @moyu-good/dsh-lark-bridge \
  && pnpm dlx @deepseek-ai/dsh web

# 2. a QR code prints → scan it with Feishu
#    (this creates the app + event subscription automatically)

# 3. open the dsh console → Settings → Models → paste your DeepSeek API key

# 4. DM the bot, or @ it in a group. That's it.
```

> [!NOTE]
> **First-time `plugin add` fails once** with
> `ERR_PNPM_IGNORED_BUILDS ... protobufjs` — pnpm blocks dependency build
> scripts unless they are approved, and an unreviewed one makes the install
> exit non-zero (`strictDepBuilds`, on by default since pnpm 10.3). The blocked
> script belongs to `protobufjs` (a Feishu SDK dependency); it only prints a
> version-scheme warning, writes no file and reaches no network.
> Open `<your-home>/.dsh/profiles/web/pnpm-workspace.yaml` and set
> `protobufjs: false` under `allowBuilds` — after the failed install pnpm
> writes a line there whose value is the literal text
> `set this to true or false`, which is not a boolean, so replace it. `false`
> is the right value: it declines the script, and the script has nothing to
> do. This is a one-time step per profile.
>
> **Re-run the same command after editing.** The failed install leaves the
> profile half-configured — the plugin's bundles are not merged when the
> install exits non-zero — so the file edit alone does not finish the job.
>
> `allowBuilds` (since pnpm 10.26) is the only key pnpm reads for this —
> `onlyBuiltDependencies` and the other legacy build keys were removed in pnpm
> 11. It lives in the
> **installing** profile's `pnpm-workspace.yaml`, not in this package, because
> the approval belongs to whoever runs the install.
>
> The upstream dsh CLI prints a pointer to this file only for git-hosted
> plugins; an npm-published plugin like this one gets no such hint, which is
> why the step is documented here.

> [!TIP]
> Not sure what the bot can do? Send it **`/manual`** — the full eight-section user
> guide arrives right in the chat. `/help` lists every command. The only skill you
> need is "say what you want".

> [!WARNING]
> **Use pnpm, not bare npx/npm, to run the upstream dsh CLI.** Measured on the
> same machine: `pnpm dlx` installs dsh's dependency tree (197 packages,
> ~250 MB) in **~20 s** including downloads, while `npx`/`npm install` takes
> **~25 minutes** (npm's serial reify) even with a warm cache — and on
> machines with ≤4 GB RAM the npm process itself dies with
> "JavaScript heap out of memory" mid-install. If you must use npm, pre-set
> `NODE_OPTIONS=--max-old-space-size=2048`.
>
> **Do NOT** `npm i -g dsh-lark-bridge` — that name on npm belongs to an
> unrelated project. This plugin is published as **`@moyu-good/dsh-lark-bridge`**
> (the GitHub source also works, but installing a git-hosted plugin makes pnpm
> block its `prepare` script until you whitelist it under `allowBuilds` in the
> profile's `pnpm-workspace.yaml` — the registry package needs no build at all).

Daily ops: run `pnpm dlx @deepseek-ai/dsh web` again (subsequent runs hit the
pnpm store, so they're fast), or host it under systemd/supervisor.
The package ships **prebuilt** (`lib/` committed) — nothing compiles on install.

## 📦 Moving to a new machine

The bridge carries its own migration path — on the old machine:

```text
/bot export include-secrets --to-feishu   # uploads to the app's own Feishu drive
/bot export include-secrets               # or a local file, credentials masked
```

The Feishu route needs no copying at all: the file lands in the app's own
cloud space (visible only to this app), and the new machine pulls it with
`/bot import --from-feishu`. For the local-file route, copy the printed file
(the sync directory, e.g. `~/.dsh/dsh-lark-bridge/migrate.json`) to the same
path on the new machine, install the plugin there (Quick Start above), then:

```text
/bot import                       # preview: settings + plugin plan + warnings
/bot import apply                 # execute (add --from-feishu for the cloud slot)
```

What travels: shared settings and per-profile plugin lists (installed through
the upstream CLI, so cross-platform moves just work). What never travels:
peer heartbeats, control tokens, `node_modules`, session history.

Session history lives under `~/.dsh` (upstream-owned). To carry it across,
copy the session directories only:

```text
~/.dsh/sessions/     # the conversations themselves
~/.dsh/storages/     # session projection cache and workspace index
```

Do **not** copy the whole of `~/.dsh`. `~/.dsh/dsh-lark-bridge/device-state.json`
holds this machine's `deviceId` and its retired flag: a copy would give the
new machine the old machine's identity (both would answer the same chat) and
could bring the retired flag along, so the new machine would greet every
message with a one-line notice instead of running the agent. The migration
file above never contains that state — it is per-machine by design.

**Device lifecycle**: every machine mints a stable `deviceId` on first boot
(`/bot devices` shows the roster: this machine, heartbeat-live peers, the
cloud-active endpoint, and migration provenance). Instead of stopping the old
service by hand, retire it — `/bot retire` on the old machine puts it out of
the reply path (messages get a one-line notice, not an agent turn; the flag
is per-machine local state and is never synced), and `/bot activate` brings
it back — and when the cloud carrier is available it also claims the active
slot, so other machines stand down on their next message. Every live machine
renews its presence in the cloud ledger each minute; if the active machine
goessilent, the freshest machine with the smallest deviceId is elected
automatically on the next inbound message. `/bot name <readable-name>` names
a device for the roster.

## 🗨️ Use it like a user

- **Just say what you want**: "why are the tests failing in this project?" — drag files and
  images straight into the chat.
- **Three surfaces, one conversation**: the web UI listens on `http://127.0.0.1:18787`, but
  each launch mints a new token, so a browser without the cookie gets 401. Open the
  `dsh web: http://127.0.0.1:18787/?token=…` line the launcher prints once — that sets a
  long-lived cookie, after which the plain address works (same session library as the Feishu
  side); once DSH Desktop runs the plugin it joins the same fleet. Exactly one surface replies;
  `/bot devices` shows who.
- **Switch Feishu apps in two taps**: `/bot account` → tap **Use** on the card → `/restart`.
- **Guidance is built in**: new chats get a short starter guide; `/manual` is the full one;
  `/balance` is the wallet.

The complete handbook lives at [`docs/用户手册.md`](docs/用户手册.md) (Chinese; `/manual` serves the same content in chat).

## ✨ Features

Highlights — the ones other bridges don't have:

| | |
|---|---|
| 🧠 **Native Feishu CoT** | Reasoning renders as the platform's own thinking message (`cot`), typewriter card fallback (`stream`) |
| 📋 **Approval cards + decider trail** | Click to decide; who decided is written back |
| 🎯 **Live goal / todo cards + auto-resume** | Phase changes stream into chat; `autoResumeGoals` re-arms after restarts |
| ✋ **Mid-turn steering** | A message sent while a turn runs follows `busyPolicy`: `queue` (default) waits its turn, `steer` takes over at the next step boundary without discarding the work, `inject` adds context without waking the driver |
| 🔍 **Session history search** | `/sessions <keyword>` full-text search over this chat's stored history |
| 🌐 **Bilingual slash panel** | English on international Lark, Chinese on domestic Feishu — auto |
| 🌐 **Three-surface fleet sync** | web/desktop/CLI share one session library; per-endpoint cloud arbitration (`deviceId:form:profile`) — no double replies, automatic failover election |
| 🔄 **Interactive account switcher** | `/bot account` stores/switches/forgets Feishu-app credentials from a card; shared settings push it to every surface |
| 💰 **Balance & peak/off-peak awareness** | `/balance` live DeepSeek balance (per currency, timestamped); the prompt embeds the tariff table so batch work lands in half-price windows |
| 🛠️ **Native Feishu agent tools** | `feishu_notify` proactive messages, `feishu_drive_*` cloud-drive scratchpad reachable from any device |
| 🖥️ **Self-healing slash panel** | the panel has a single writer (the arbitration-active endpoint), bilingual, kept in step with what actually runs |
| 🧰 **Capability inventory** | `/tools` lists what this deployment can actually do — the visible tools and the MCP servers it talks to, not only what someone switched off |
| 🎙️ **Media delivered in kind** | an ogg or opus recording arrives as a voice note and an mp4 or m4v clip as a video — playable in the chat, not a download link (the extension decides, and a named `kind` can narrow it but never widen it). A format the chat cannot carry in that shape arrives as a file, and the result says so |
| 👥 **Team panel** | when the host runs a team, one card shows the members, the shared tasks and the messages passed between them, updated in place; a delegation is also announced in the chat, with progress on a 30-second window |

<details>
<summary><b>All capabilities</b></summary>

| | |
|---|---|
| 🗂️ One agent per conversation | `sessionScope`: whole chat / topic thread / single sender; sessions persist across restarts |
| ✅ Live reactions | `OK` → `THINKING` → `DONE`/`ERROR`, states replace each other, configurable |
| 📦 Compaction transparency | "Compacting…" → summary + released tokens; prunes report trimmed count |
| 🧑💻 Subagent fan-out | Workflow runs stream as text lines: run start, child open/end, run end |
| ⏰ Scheduled reminders | `/schedules` view (compose `@deepseek-ai/dsh-schedule` for the model-side tools) |
| ⚙️ Background job notifications | `run_in_background` jobs announce their terminal outcome |
| 🧩 Skill ecosystem surface | `/skills` lists workspace skills, `/skills <name>` peeks at one |
| 🤖 Model switching | `/model <provider>/<model>` through the host `saveSelection` seam (persistent) |
| 🖥️ PC-parity tooling | Compose `dsh-terminal*` / `code-runtime-worker-thread` / `dsh-mcp-client` → persistent PTY, Code Mode, external MCP servers |
| 🗺️ Workspace visibility | `/ws` lists workspaces and marks where new sessions land |
| 🖼️ Image input (opt-in) | `attachImages` passes chat images to the model |
| 📎 File delivery | Agent `send_file` delivers artifacts with caption (default-deny local dirs) |
| 🔑 QR onboarding | First boot prints a QR; scanning creates the app with event subscription |
| 🔒 Authorization narrowing | `senderAllowlist` / `groupAllowlist` / `approvers` |
| 🧩 Chronicle hook | `chronicleEndpoint`: fire-and-forget POST per accepted inbound **user** message — payload is `source`/`text`/`chatId`, and the bridge's replies never go to the ledger |
| 🛡️ Deep dsh adaptation | Everything through host service contracts — self-contained, no host source needed |

</details>

### vs. other Feishu/Lark bridges

> **Verification basis**: re-checked against each project's public README on 2026-09-09
> (links under Listings & Community). "Not found" means not seen in public docs — not proof
> of absence. Different bets: dsh-im is a multi-platform gateway (8+ channels) where breadth
> is the point; this bridge bets on single-platform depth plus a multi-surface fleet.

| Capability | **dsh-lark-bridge** | xmanrui/dsh-im | omdsh-dev/dsh-lark | AX1202/ax-feishu-bridge |
|---|---|---|---|---|
| Positioning | Feishu depth + multi-surface fleet | Multi-platform gateway (Feishu/DingTalk/WeCom/WhatsApp/Discord/QQ…) | Feishu depth, multi-agent groups | Feishu × Pi agent |
| Thinking display | Feishu-native "thinking" message | Streaming card (thinking/tool progress) | Native (needs PC 7.70+/mobile 7.74+) | Streaming card output |
| Approvals | Cards + decider written back | Text reply (approve/deny) | Cards + decider resolution | Not documented |
| Live goal/todo cards | ✅ | Not found | Not found | Not found |
| Compaction transparency | ✅ (progress + freed tokens) | `/compact` command | `/compact` (host passthrough) | Not found |
| Multi-surface fleet + endpoint arbitration | ✅ shared library, automatic failover | DM text two-way sync (opt-in) | — | — |
| Interactive account switcher | ✅ two taps, propagates everywhere | — | — | — |
| Balance + peak/off-peak awareness | ✅ | — | — | — |
| Slash panel | Bilingual registration + active-writer self-heal | Native panel (`/repair` grants) | Host passthrough | Not found |


## 💬 Slash Commands

| Command | Description |
|---|---|
| `/stop` | Cancel the running turn |
| `/help` | Show this listing |
| `/manual` | The full user guide (start here if you're new) |
| `/balance` | DeepSeek API balance (with the live peak/off-peak phase) |
| `/preset` | View / switch agent preset (standard / code / minimal / cordis) |
| `/permission` | View / switch permission mode (host) |
| `/goal` | View / set the goal (host) |
| `/plan` | Enter / leave plan mode (host) |
| `/compact` | Compact older history (host) |
| `/sessions` | Search this chat's session history |
| `/tools` | View / deny / allow tools at runtime |
| `/skills` | List skills, or peek at one |
| `/model` | View / switch the default model |
| `/ws` | List registered workspaces |
| `/jobs` | This chat's background jobs |
| `/schedules` | This chat's scheduled reminders |
| `/context` | Current context token pressure |
| `/audit` | Operation audit summary |
| `/config` | The bridge's live configuration |
| `/feedback` | Rate the last answer |
| `/new` | Start a new session |
| `/plugins` | List deployed plugins and status |
| `/bot` | Bridge admin: status, settings, accounts, plugin sync, devices |
| `/restart` | Restart the host process (only when the deployment wires it) |

Set `locale: zh|en` to force a language; otherwise it follows the platform domain.

**`/bot` subcommands** (bridge admin): `set` / `unset` / `peers` / `sync-plugins` / **`account`** (save·use·forget, interactive card) / `export` / `import` / `devices` / `retire` / `activate` / `name`. The slash panel has a single writer — the arbitration-active endpoint — so it always matches what actually runs.

## ⚙️ Configuration

Essentials:

| Field | Default | Meaning |
|---|---|---|
| `appId`, `appSecret` | first-boot QR registration | Feishu/Lark app credentials |
| `cwd` | host process cwd | Absolute workspace directory for chat agents |
| `provider`, `model` | host default | Model routing for chat agents |
| `output` | `cot` | Native thinking message vs typewriter card |
| `requireMention` | `true` | In groups, respond only when @-mentioned |
| `outbound.allowedFileDirs` | unset → disabled | Local dirs `send_file` may read from |
| `chronicleEndpoint` | `''` | Optional external ledger: one POST per accepted inbound user message (`source`/`text`/`chatId`); the bridge's replies are not included |
| `announceSubagents` | `true` | Announce a delegation in the chat when it is made, with progress on a 30-second window; off leaves it to the team panel alone |

Full option reference: [README.zh.md 配置](README.zh.md#️-配置) · credentials resolve in three
layers (bundle patch config → settings document plugin section → first-boot QR registration).

<details>
<summary><b>Required app permissions (manual app creation)</b></summary>

| Scope | Needed for |
|---|---|
| `application:app_slash_command` (read + write) | Slash panel — without it sync fails with `99991672` |
| `im:message` / `im:message:readonly` | Send / read messages |
| `im:message.receive_v1` event | Receive messages (Events → long connection) |
| `im:resource` | Upload images and files |
| `im:chat:read` | Group info |
| `im:message.reactions:read` / `write_only` | Reaction feedback |

QR onboarding grants these automatically; manually created apps must publish a new
version after adding scopes. Panel sync runs on session create/resume — send the bot
one message after granting.

</details>

## 🧭 Architecture

```
Feishu / Lark ── WebSocket long connection ──►  dsh-lark-bridge (feishu-channel plugin
   (chat/approval/images)                        INSIDE the dsh process)
                                                      │  host service contracts:
                                                      │  agents / sessions / tools /
                                                      ▼  approval / goal / settings
                                              DeepSeek Harness itself
```

Any launcher works (shell, systemd, supervisor) — no dependency on any other agent framework.

## 🧩 Extend It

Three invariants keep the bridge maintainable:

1. **Grafted channel, not re-integration** — the bridge only normalizes messages; every
   capability comes from official opt-in dsh plugin families composed in your profile.
   Zero bridge code = zero upgrade cost when upstream ships features.
2. **Everything through host service contracts** — `agents`, `agentPresets`, `approval`,
   `goals`, `settings`… self-contained against published packages only.
3. **Every change archives a design card first** — see [`docs/design/`](docs/design/README.md);
   implementation notes are backfilled, and blocked investigations are archived as assets too.

**Repo map**

```
src/
  bridge.ts        message pipeline: normalize → authorize → ack → agent turn → render
  commands.ts      slash commands (i18n bilingual)
  cot.ts outbound.ts  thinking-process & answer rendering
  feishu-tools.ts    native Feishu agent tools (notify / cloud drive)
  sync/              dual-end sync: settings source of truth, peers, control API,
                     migration, account book, endpoint arbitration
  pricing.ts         live DeepSeek peak/off-peak phase
  user-guide.ts      single source of the /manual content
  chronicle.ts     inbound-message ledger hook (integration example; user text only)
  config.ts        schema + defaults
tests/             vitest suites (59) incl. harness-based fakes
scripts/           verify-dsh-contract.mjs — asserts no drift vs upstream master
plugin-contract-test.mjs   43 contract checks on the host contract surface
```

**Quality gates**

```sh
pnpm test                        # 594 unit/integration tests
node plugin-contract-test.mjs    # 43 host-contract checks
node scripts/verify-dsh-contract.mjs   # drift check against upstream master
pnpm typecheck && pnpm run build # tsc + tsdown (lib/ is committed)
```

CI runs all of the above on every push and pull request, with the upstream drift check
pinned to dsh master — if upstream changes a contract, the build tells you before users do.

**Adding a feature?** Write the design card first (template in `docs/design/`), implement,
backfill the change record. For an integration that only needs inbound message visibility, prefer
the `chronicleEndpoint` hook over modifying the pipeline — see `src/chronicle.ts` (it sends the
user's text, not the bridge's replies).

## 🧱 Development & MR Flow

`main` is the stable baseline and only receives **reviewed merge requests**. All development happens on feature branches (`feat/<name>`), never directly on `main`.

Per-MR checklist:
1. Branch from `main`; keep the change small and single-purpose.
2. Full quality gate green (`pnpm hygiene`, `pnpm test`, `node plugin-contract-test.mjs`, `node scripts/verify-dsh-contract.mjs`, `pnpm typecheck && pnpm build`).
3. Repo hygiene scan — `pnpm hygiene` — must exit 0. Deployment-specific terms go in a local `.leak-patterns` file (see `.leak-patterns.example`), never in the repo.
4. Reviewer approves → merge to `main` → deploy from `main`.
5. Production incidents revert on the spot (history stays in git); the reverted branch is rebased and re-MR'd with a fix.

Releases are tags. Pushing a `v*` tag runs the same gate as CI, verifies the tag matches `package.json`, and publishes the CHANGELOG section as the release notes — so a tag can never point at a commit that would have failed CI.

This is enforced because past direct-to-`main` experiments had to be rolled back as a multi-commit revert in one batch — feature branches keep `main` shippable at all times.

## 📦 Version & Release Policy

Two tracks, written down so nobody guesses:

- **preview track** — development/experimentation. Pull the latest upstream (GitHub releases including alpha/rc, or `master`) and the newest bridge features; breakage is expected here.
- **stable track** — production deployments. Pin the npm `latest` / release-candidate line. **Production never runs an `alpha`.**

### Moving to a new harness version

The bridge consumes the harness through the plugin seam, so a harness upgrade can
move the seam under it. The check is one command:

```sh
node scripts/verify-dsh-contract.mjs   # compares the bridge's host mirrors with upstream
```

It fetches the harness source it declares a contract against and fails when an
entry the bridge mirrors has moved or vanished — run it before and after an
upgrade. When it fails, the fix belongs in the bridge (`src/bridge.ts`,
`src/questions.ts`), not in a pin: the bridge follows the newest harness, and the
host-contract mirrors in those files are the single place that records what the
seam looked like when it was last verified.

Two rules keep the upgrade honest:
1. **Upgrade the engine by switching trees, not by layering one on top.** A dsh
   profile resolves the harness's own packages from the tree the CLI runs out of,
   so pointing the launcher at a new checkout is the whole switch. Side-by-side
   trees fight over the profile's `node_modules`.
2. **A profile declares only its own additions** (this bridge, extra plugins).
   Harness packages are not profile dependencies — declaring them pins the
   profile to a version and hides the seam behind a stale copy.

Promoting preview → stable requires the full quality gate to pass:
`pnpm test` → `node plugin-contract-test.mjs` → `node scripts/verify-dsh-contract.mjs` → `pnpm typecheck && pnpm run build` → live smoke.

## ❓ FAQ

<details>
<summary><b>Do I need a public IP or webhook?</b></summary>
No. The transport is a WebSocket long connection; the app must use long-connection event
subscription (self-built app).
</details>

<details>
<summary><b>Which models work?</b></summary>
Any model routable by your dsh deployment — the bridge is model-agnostic and `/model`
switches at runtime.
</details>

<details>
<summary><b>The agent says it sent a file but nothing arrives</b></summary>
File delivery is default-deny: configure <code>outbound.allowedFileDirs</code>. URLs and
raw buffers always work.
</details>

<details>
<summary><b>The slash panel is empty or partial after a restart</b></summary>
Boot registers constant commands; the full panel sync runs on the first message of a
session. Send the bot anything. If it stays empty, check the
<code>application:app_slash_command</code> scope and publish an app version.
</details>

<details>
<summary><b>Will multiple machines / surfaces double-reply?</b></summary>
No. Cloud arbitration is keyed per <b>endpoint</b> (<code>deviceId:form:profile</code>): exactly one surface
replies at any moment, and if the active one goes silent the freshest endpoints elect a
successor automatically on the next message.
</details>

<details>
<summary><b>How do I switch to a different Feishu app?</b></summary>
<code>/bot account save &lt;name&gt;</code> archives the current credentials; later <code>/bot account</code> and tap
<b>Use</b> on the card, then <code>/restart</code> (web) or restart Desktop. Multiple credential sets can
live side by side.
</details>

<details>
<summary><b>What survives a restart?</b></summary>
Sessions resume from their logs; active goals re-arm (<code>autoResumeGoals</code>);
permission and preset choices ride with the session state.
</details>

## 🌍 Listings & Community

Listed in the following directories (every link below was fetched and confirmed
reachable on 2026-10-21):

| Directory | How it is listed | Link |
|---|---|---|
| **dshbase** | issue (#59, closed) · **verified** (headless L3: install + load + Q&A) | [entry](https://dshbase.com/plugins/moyu-good-dsh-lark-bridge/) · [中文](https://dshbase.com/zh/plugins/moyu-good-dsh-lark-bridge/) |
| **awesome-dsh-plugin** | PR ([#2160](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2160), merged) | [list](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [card](https://awesome-dsh-plugin.com/p/moyu-good/dsh-lark-bridge/) |
| **dsh-market** (in-DSH market) | reads the `dsh-plugin-catalog` index — **no separate submission** | [site](https://dshmarket.com) · [card](https://dshmarket.com/p/moyu-good/dsh-lark-bridge/) |
| **dsh.so** | web form, **L5 runtime-verified** (0.2.1-rc.2) | [entry](https://www.dsh.so/artifact/dsh-lark-bridge-4/) |
| **dshfind** | automatic, by repository (Chinese community) | [entry](https://dshfind.com/zh/plugins/moyu-good/dsh-lark-bridge) |
| **dsh.directory** | issue, hand-reviewed (small and curated) | [entry](https://dsh.directory/plugins/moyu-good/dsh-lark-bridge) |
| **dsh-plugin.org** | automatic crawl (public repo + `dsh-plugin` topic + manual review) | [entry](https://dsh-plugin.org/plugins/moyu-good/dsh-lark-bridge/) |
| **dsh-suite** | issue ([#32](https://github.com/whyihaveyou/dsh-suite/issues/32), closed, orchestration) | [catalog](https://github.com/whyihaveyou/dsh-suite) |
| **deepseek404 plugin store** | automatic, aggregates GitHub | [entry](https://dsh.deepseek404.com/detail.php?id=moyu-good%2Fdsh-lark-bridge) |

**About the version numbers**: most of these directories read the version from npm,
and npm still serves `0.6.1` while this repository is at `v0.9.6` — so a directory
page will show a version behind the repository. **The repository tag is the truth.**
Install with `npm i github:moyu-good/dsh-lark-bridge#v0.9.6`, or take the tarball
from the release.

Issues and PRs welcome — design cards first, please.

## 📋 Known limitations

- Transport-level config (credentials, requireMention, allowlists) is read once at startup;
  other config edits hot-reload via dsh Config-only HMR (`/config` shows live values)
- Events during a long-connection outage are not replayed (no cursor); outbound sends are
  queued by the replay port
- `schedule_*` model tools need composing `@deepseek-ai/dsh-schedule` in your profile

## 🤝 Contributing

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to get a change in: the branch shape, the
  three layers of tests, and what a change has to come with.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability, and what counts as one.
  Please do not open a public issue for it.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — how people are expected to treat each other here.
- **Issue templates** — a bug report and a feature request, under
  [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE). A report that fills in the
  environment section is answered faster; a report that does not is usually a
  question about the host rather than about the bridge.

## 📄 License

BSD-3-Clause. Architecture inspired by [dsh-lark](https://github.com/Roy-oss1/dsh-lark) (also BSD-3-Clause).
