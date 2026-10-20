/**
 * 真链路冒烟测试（无人工介入）——直接对运行中的 dsh 桥进程做端到端验证：
 * 1) 面板命令清单（飞书开放平台 API 直查，应含 /skills /model /ws）
 * 2) dump-config 组合树应含 terminal/code-runtime 插件
 * 3) systemd 服务 active
 * 用法: node scripts/smoke-live.mjs
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// 部署方的 systemd 单元名——各机器不同，用环境变量覆盖。
const SERVICE = process.env.BRIDGE_SERVICE ?? 'dsh-lark-bridge'

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// 1) systemd 服务
const active = (() => {
  try { return execSync(`systemctl is-active ${SERVICE}`, { encoding: 'utf8' }).trim() === 'active' }
  catch { return false }
})()
check(`${SERVICE} 服务 active`, active)

// 2) 组合树含新插件
const HARNESS_CLI = process.env.DSH_HARNESS_CLI
const tree = HARNESS_CLI
  ? execSync(`node ${HARNESS_CLI} --profile chat --dump-config 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 60_000 })
  : ''
if (!HARNESS_CLI) console.log('· DSH_HARNESS_CLI 未设置，跳过组合树检查')
// code-runtime-worker-thread: 上游已从组合树移除（0.2.1-alpha.2 起就没有），
// 留着这一项只会把"包被重命名/移除"误报成部署回归。
for (const pkg of ['dsh-terminal', 'dsh-terminal-bash', 'tool-terminal']) {
  check(`组合树含 ${pkg}`, tree.includes(pkg))
}
// mcp-client: 本部署的组合树带 dsh-mcp-client（MCP 子服务支持）。这来自
// chat/web profile 自己的 insert，不是上游默认——上游 0.2.1-rc.2 全仓只有
// 技能模板提到它。判据按"应当存在"检查；要断言"不在"必须显式声明。
if (process.env.SMOKE_EXPECT_MCP === '0') {
  check('组合树不含 mcp-client（显式声明 SMOKE_EXPECT_MCP=0）', !tree.includes('mcp-client'))
} else {
  check('组合树含 dsh-mcp-client', tree.includes('dsh-mcp-client'))
}

// 3) 飞书面板命令清单
// 凭证来源优先级：环境变量 > DSH_ENV_FILE 指向的 dotenv 文件；都不在则跳过面板检查
let env = process.env.FEISHU_APP_ID ? '' : undefined
if (env === undefined && process.env.DSH_ENV_FILE) env = readFileSync(process.env.DSH_ENV_FILE, 'utf8')
const get = k => (env ? env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] : process.env[k])
const appId = get('FEISHU_APP_ID'); const appSecret = get('FEISHU_APP_SECRET')
const token = JSON.parse(execSync(
  `curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal -H 'Content-Type: application/json' -d '{"app_id":"${appId}","app_secret":"${appSecret}"}'`,
  { encoding: 'utf8' })).tenant_access_token
const panel = JSON.parse(execSync(
  `curl -s "https://open.feishu.cn/open-apis/application/v7/app_slash_commands?page_size=50" -H "Authorization: Bearer ${token}"`,
  { encoding: 'utf8' }))
const names = (panel.data?.items ?? []).map(c => c.command)
check('面板含 /skills', names.includes('skills'), names.join(' '))
check('面板含 /model', names.includes('model'))
check('面板含 /ws', names.includes('ws'))

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
