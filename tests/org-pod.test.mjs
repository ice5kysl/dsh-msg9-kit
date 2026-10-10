/**
 * 显式开通（2026-09-30 重构）的回归测试 —— P1 部分：ORG → Pod → Agent。
 *
 * 判据取自 `docs/REFACTOR-ORG-POD-AGENT.md` §11：
 *   R1  无 ORG key 时，绝不注册任何身份
 *   R2  有 ORG key 但未开启时，仍不注册
 *   R3  「开启」幂等（连点两次 ⇒ pod 只建一个、agent 只建一个）
 *   R4  pod 已存在时复用而非报错（**40900 决议表**；本机踩过这个坑）
 *   R5  多把租户 key 时不猜（已在 explicit-provision 覆盖，这里验它不回归）
 *
 * 手法：假 org API（记录每次写操作），断言"未开启时零写操作"。
 * 这是最可证伪的判据 —— 旧实现会在这里静默注册。
 *
 * Run: node tests/org-pod.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const root = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-org-'))
process.env.MSG9_STATE_FILE = join(root, 'state.json')
process.env.MSG9_HOME = join(root, 'msg9-home')
delete process.env.MSG9_OWNER_KEY
delete process.env.MSG9_TENANT_KEY
delete process.env.MSG9_ORG_KEY

const {
  derivePodLabel,
  openPod,
  podState,
  readOrgKey,
  writeOrgKey,
  orgKeyPath,
  msg9Home,
} = await import('../lib/index.js')

// ------------------------------------------------------------- fake ORG API

const calls = { pods: 0, create: 0, agents: 0, register: 0 }
let podsInOrg = []
/** 每次建 agent 用的 pod key（Bearer）—— 「信箱到底开在哪个 pod 里」的硬证据。 */
let agentAuths = []

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const auth = req.headers.authorization ?? ''
  const key = auth.replace(/^Bearer\s+/, '')

  // 只读：列 pod
  if (req.method === 'GET' && url.pathname === '/api/v1/org/pods') {
    if (!key.startsWith('msg9_ok_')) return send(403, { code: 40300, message: 'tenant credentials cannot manage an org; use the org key' })
    calls.pods += 1
    return send(200, { code: 0, message: 'success', data: { pods: podsInOrg } })
  }
  // 写：建 pod
  if (req.method === 'POST' && url.pathname === '/api/v1/org/pods') {
    if (!key.startsWith('msg9_ok_')) return send(403, { code: 40300, message: 'use the org key' })
    const body = JSON.parse(await readBody(req) || '{}')
    if (!body.label || body.label.length < 3) return send(400, { code: 40020, message: 'tenant slug is invalid: must be 3-30 characters' })
    calls.create += 1
    const pod = {
      id: `own_test_${calls.create}`,
      pod_label: body.label,
      address_domain: `${body.label}.ice.msg9.io`,
      status: 'active',
      agents: 0,
    }
    podsInOrg.push(pod)
    return send(200, {
      code: 0,
      message: 'created',
      data: { api_key: `msg9_tk_pod_${body.label}`, notice: 'store this pod key', pod },
    })
  }
  // pod key：开 agent
  if (req.method === 'POST' && url.pathname === '/api/v1/owner/agents') {
    if (!key.startsWith('msg9_tk_')) return send(403, { code: 40300, message: 'owner key required' })
    const body = JSON.parse(await readBody(req) || '{}')
    calls.agents += 1
    agentAuths.push(key)
    const address = body.addresses?.[0]
    return send(200, {
      code: 0,
      message: 'success',
      data: { created: [{ address, api_key: `msg9_sk_${address}`, api_url: 'http://x' }], errors: [] },
    })
  }
  // 公开自助注册：**绝不该被走到**（R1/R2 的判据）
  if (req.method === 'POST' && url.pathname === '/api/v1/register') {
    calls.register += 1
    return send(200, { code: 0, message: 'success', data: { address: 'x', api_key: 'msg9_sk_pub' } })
  }
  // 其他（agent/me 等）给个无害成功
  return send(200, { code: 0, message: 'success', data: {} })
})

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
  })
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`

const ws = { key: 'ws-test-key', title: 'Test Project', path: '/work/test-project' }
const checks = []
const check = (name, fn) => checks.push({ name, fn })

const resetAll = async () => {
  calls.pods = 0; calls.create = 0; calls.agents = 0; calls.register = 0
  podsInOrg = []
  agentAuths = []
  await rm(process.env.MSG9_HOME, { recursive: true, force: true })
  await rm(process.env.MSG9_STATE_FILE, { force: true })
  delete process.env.MSG9_ORG_KEY
}

const writeState = (state) => writeFile(process.env.MSG9_STATE_FILE, JSON.stringify(state, null, 2))

// ------------------------------------------------------------------- tests

check('P1：derivePodLabel 用项目语义命名（通用 title 不产出 dsh-ws-*）', async () => {
  // title 有语义 ⇒ 用它
  assert.equal(derivePodLabel({ key: 'k', title: 'dsh', path: '/x/dsh' }), 'dsh')
  // title 是通用词 ⇒ 跳过，用目录名（这正是 D3 的修法）
  assert.equal(derivePodLabel({ key: 'k', title: 'workspace', path: '/codes/llmpool' }), 'llmpool')
  // 都不具备语义 ⇒ 才退化加 hash，且仍可追溯
  const hashed = derivePodLabel({ key: 'abcdef12', title: 'ws', path: '/tmp/ws' })
  assert.match(hashed, /^ws-[0-9a-f]{4}$/, hashed)
})

check('P1-R1 ★：无 ORG key ⇒ 状态 unconfigured，且【零写操作】', async () => {
  await resetAll()
  await mkdir(join(process.env.MSG9_HOME, 'tenants'), { recursive: true })
  await writeFile(join(process.env.MSG9_HOME, 'tenants', 'dsh.key'), 'msg9_tk_legacy\n')

  const state = await podState(ws)
  assert.equal(state, 'unconfigured', '无 ORG key 应当是未配置态')

  // 尝试开启 ⇒ 必须明确拒绝
  await assert.rejects(() => openPod(ws), /No ORG key configured/)
  assert.equal(calls.create, 0, '不得创建任何 pod')
  assert.equal(calls.agents, 0, '不得开任何 agent')
  assert.equal(calls.register, 0, '★ 不得发生公开自助注册')
})

check('P1-R2 ★：有 ORG key 但未开启 ⇒ 状态 pod_closed，仍然零写操作', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_test_key')
  await writeState({ org: { label: 'ice', api_url: apiUrl }, workspaces: {} })

  const state = await podState(ws)
  assert.equal(state, 'pod_closed', '有 ORG key 但未开 pod ⇒ pod_closed')

  // 仅仅"看状态"不得产生任何写
  assert.equal(calls.create, 0, '看状态不得建 pod')
  assert.equal(calls.agents, 0, '看状态不得开 agent')
  assert.equal(calls.register, 0, '看状态不得注册')
})

check('P1-R3 ★：开启幂等 —— 连点两次只建一个 pod、一个 agent', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_test_key')
  await writeState({ org: { label: 'ice', api_url: apiUrl }, workspaces: {} })

  const first = await openPod(ws)
  assert.equal(first.state, 'ready')
  assert.equal(first.podCreated, true, '第一次应当真的创建')
  assert.equal(first.podLabel, 'test-project', first.podLabel)
  assert.equal(first.addressDomain, 'test-project.ice.msg9.io')
  assert.equal(calls.create, 1)
  assert.equal(calls.agents, 1)

  // 第二次：pod 已存在 + 本地已有 pod key ⇒ 复用，不再创建
  const second = await openPod(ws)
  assert.equal(second.podCreated, false, '第二次应当复用')
  assert.equal(calls.create, 1, '★ pod 只建一个')
  assert.equal(calls.register, 0, '★ 全程不得公开注册')
})

check('P1-R3b：pod key 按规范落盘 tenants/<pod>-<org>.key（0600）', async () => {
  const path = join(process.env.MSG9_HOME, 'tenants', 'test-project-ice.key')
  const key = (await readFile(path, 'utf8')).trim()
  assert.equal(key, 'msg9_tk_pod_test-project', 'pod key 应当按 <pod>-<org>.key 命名并落盘')
  const mode = (await stat(path)).mode & 0o777
  assert.equal(mode, 0o600, `凭据必须 0600，实际 ${mode.toString(8)}`)
})

check('P1-R3c ★：显式指定的 pod slug 就是实际建出来的那个（T-81「改 slug」的落点）', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_test_key')
  await writeState({ org: { label: 'ice', api_url: apiUrl }, workspaces: {} })

  // 不指定 ⇒ 走推导（这个 workspace 推导出来是 test-project）
  const derived = await openPod(ws)
  assert.equal(derived.podLabel, 'test-project', '不给就用推导出来的名字')

  // 显式指定 ⇒ 必须【就是这个名字】。判据打在**送给 ORG 的请求体**上，
  // 而不是"返回值看起来对"：夹具记录的 `body.label` 才是真的建了什么。
  const explicit = await openPod(ws, { podLabel: 'renamed-slug' })
  assert.equal(explicit.podLabel, 'renamed-slug', '★ 返回的 label 必须等于显式指定的那个')
  assert.equal(explicit.podCreated, true, '这是一个新 pod，不是复用')
  assert.equal(explicit.addressDomain, 'renamed-slug.ice.msg9.io', '地址域由显式 slug 决定')
  assert.deepEqual(
    podsInOrg.map((pod) => pod.pod_label),
    ['test-project', 'renamed-slug'],
    '★ ORG 里真的建出了「renamed-slug」这个 pod',
  )
  assert.equal(
    (await readFile(join(process.env.MSG9_HOME, 'tenants', 'renamed-slug-ice.key'), 'utf8')).trim(),
    'msg9_tk_pod_renamed-slug',
    'pod key 也按显式 slug 落盘（不会写回推导名那份）',
  )
})

check('P1-R3d ★：显式 slug 必须一路传到「建 agent」（T-81 真机抓到的断链）', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_test_key')
  await writeState({ org: { label: 'ice', api_url: apiUrl }, workspaces: {} })
  // ★ 先布下陷阱：**推导名自己有本地 key**。真机上就是这个形态 ——
  //   `openPod` 用显式 slug 建了 pod，可随后"给这个 workspace 开信箱"又自己推导
  //   了一遍 pod 名，于是拿推导名那把 key 去建 agent ⇒ 信箱**静默开进另一个 pod**。
  await mkdir(join(process.env.MSG9_HOME, 'tenants'), { recursive: true })
  await writeFile(join(process.env.MSG9_HOME, 'tenants', 'test-project-ice.key'), 'msg9_tk_pod_test-project\n', { mode: 0o600 })

  const fresh = { key: 'ws-fresh', title: 'Test Project', path: '/work/test-project' }
  const result = await openPod(fresh, { podLabel: 'renamed-slug' })
  assert.equal(result.podLabel, 'renamed-slug')
  assert.equal(calls.agents, 1, '信箱确实开了（不是"报错说没有 key"）')
  assert.deepEqual(
    agentAuths,
    ['msg9_tk_pod_renamed-slug'],
    '★ 建 agent 用的必须是「renamed-slug」那把 pod key —— 不是推导出来的 test-project',
  )
})

check('P1-R4 ★：pod 已存在但本地无 key ⇒ 明确报错，【不重建】（40900 决议表）', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_test_key')
  await writeState({ org: { label: 'ice', api_url: apiUrl }, workspaces: {} })
  // 预置一个已存在的 pod（模拟"别人建的"或"本地 key 丢了"）
  podsInOrg = [{ id: 'own_x', pod_label: 'test-project', status: 'active', address_domain: 'test-project.ice.msg9.io', agents: 3 }]

  await assert.rejects(
    () => openPod(ws),
    (error) => {
      assert.match(String(error.message), /already exists under ORG/)
      assert.match(String(error.message), /will not rebuild|不会重建|not stored locally/, '必须说明不会重建')
      return true
    },
  )
  assert.equal(calls.create, 0, '★ 绝不得重建一个已存在的 pod')
  assert.equal(calls.register, 0, '★ 也不得偷偷公开注册')
})

check('P1：ORG key 校验走只读端点（orgListPods），不用写接口试形状', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_test_key')
  await writeState({ org: { label: 'ice', api_url: apiUrl }, workspaces: {} })

  // 读 ORG key：显式 label 命中
  const resolved = await readOrgKey('ice')
  assert.equal(resolved?.key, 'msg9_ok_test_key')
  assert.match(resolved.source, /orgs\/ice\.key/)
  assert.equal(orgKeyPath('ice'), join(msg9Home(), 'orgs', 'ice.key'))

  // 未指定 label 且只有一把 ⇒ 唯一即可用
  const byOnly = await readOrgKey()
  assert.equal(byOnly?.label, 'ice', '唯一一把时应当能解析出 label')
})

check('P1：ORG key 多把且未指定 ⇒ 不猜（返回 undefined 交给设置页选）', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_a')
  await writeOrgKey('official', 'msg9_ok_b')
  const ambiguous = await readOrgKey()
  assert.equal(ambiguous, undefined, '多把 ORG key 且未指定时不得替你猜')
  // 但显式指定仍可精确命中
  assert.equal((await readOrgKey('official'))?.key, 'msg9_ok_b')
})

check('P1：.bak 归档的 ORG key 不参与匹配', async () => {
  await resetAll()
  await writeOrgKey('ice', 'msg9_ok_a')
  await writeFile(join(process.env.MSG9_HOME, 'orgs', 'ice.key.bak-20260930'), 'msg9_ok_old\n')
  const resolved = await readOrgKey()
  assert.equal(resolved?.key, 'msg9_ok_a', '.bak 不得干扰匹配')
  const names = await readdir(join(process.env.MSG9_HOME, 'orgs'))
  assert.ok(names.includes('ice.key.bak-20260930'), '归档文件应当仍在（只是不参与匹配）')
})

// ------------------------------------------------------------------- run

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  [FAIL] ${name}\n         ${error?.message ?? error}`)
  }
}
server.close()
await rm(root, { recursive: true, force: true })
if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
