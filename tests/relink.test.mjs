/**
 * 重挂（把信箱记录改挂到另一个工作区）的回归测试。
 *
 * 场景（真实存在，不是假想）：工作区 a 开在目录 a1（已有信箱），后来 a1 被移到 a2。
 * dsh 的工作区身份是**规范化路径**（`@deepseek-ai/dsh-workspace`：
 * "uniqueness is string equality of canonicalized paths"，且没有"改路径"操作），
 * 所以 a2 会成为一条**新 id**，而旧 id 连同死路径永远留在注册表里 —— 信箱记录
 * 于是挂在了"已经不存在的工作区"上。重挂就是把这个记录改挂到新 id。
 *
 * 关键约束：这是**纯本地动作**。每条断言都盯着一个必须成立的边界：
 *
 *   R1  候选只列"目录存在、且还没有记录"的工作区；标题相同的排最前
 *   R2  重挂后 state 键换掉，而记录的**其余字段一字不动**
 *       （游标、监听基线、已读标记、project_key 全跟着走）—— 这正是它比
 *       "移除 + 重开"好的地方
 *   R3  凭据文件**字节不变**（重挂不该碰它；文件名用的是 project_key，与 id 无关）
 *   R4  全程 **0 次远端调用**（用一个"一被调用就抛错"的 api 桩证明）
 *   R5  目标已有记录 ⇒ 409，且**状态一字未动**（绝不覆盖，否则挤掉另一个信箱）
 *   R6  源目录**还在** ⇒ 409（不许把好端端的信箱挂走）
 *   R7  目标不在注册表 / 目标目录不存在 / 源==目标 ⇒ 拒绝
 *
 * Run: node tests/relink.test.mjs   (or: npm test)
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const root = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-relink-'))
process.env.MSG9_STATE_FILE = join(root, 'state.json')
process.env.MSG9_HOME = join(root, 'msg9-home')
delete process.env.MSG9_OWNER_KEY

const {
  createMsg9Bridge,
  defaultBridgeDeps,
  loadState,
  stateFilePath,
} = await import('../lib/index.js')

// --------------------------------------------------------------- 夹具

const oldDir = join(root, 'gone-dir')          // 故意不创建 —— "搬走了"
const newDir = join(root, 'new-dir')           // 搬走后的新位置
const otherDir = join(root, 'other-dir')       // 另一个已有信箱的工作区
const bareDir = join(root, 'bare-dir')         // 目录存在、还没有信箱 ⇒ 合资格
await mkdir(newDir, { recursive: true })
await mkdir(otherDir, { recursive: true })
await mkdir(bareDir, { recursive: true })

const workspaces = [
  { id: 'ws-old', title: 'Proj', path: oldDir },
  { id: 'ws-new', title: 'Proj', path: newDir },
  { id: 'ws-other', title: 'Other', path: otherDir },
  { id: 'ws-bare', title: 'Another', path: bareDir },
]

const credPath = join(process.env.MSG9_HOME, 'projects', 'dsh', 'proj-abc123.yaml')
const credBytes = 'address: proj@dsh.ice.msg9.io\napi_key: msg9_sk_do_not_touch\n'

/** 源记录：字段尽量全，用来证明"其余字段一字不动"。 */
const sourceRecord = {
  project_key: 'proj-abc123',
  preferred_address: 'proj',
  title: 'Proj',
  path: oldDir,
  cursor: 'CUR-42',
  last_message_id: 'm-42',
  watch_cursor: 'WATCH-7',
  watch_last_message_id: 'wm-7',
  watch_last_seen_at: '2026-09-30T00:00:00.000Z',
  last_wake_agent_id: 'agent-9',
  marks: { 'm-1': { read_by: 'human', read_at: '2026-09-30T00:00:00.000Z' } },
}

async function seedState(extra = {}) {
  await mkdir(join(process.env.MSG9_HOME, 'projects', 'dsh'), { recursive: true })
  await writeFile(credPath, credBytes)
  // state 文件就是裸 JSON（见 store.ts 的 saveState），直接写即可 ——
  // 这样夹具不依赖 lib 是否导出 saveState。
  await writeFile(stateFilePath(), `${JSON.stringify({
    workspaces: {
      'ws-old': structuredClone(sourceRecord),
      'ws-other': { project_key: 'other-def456', title: 'Other', path: otherDir },
      ...extra,
    },
  }, null, 2)}\n`)
}

// --------------------------------------------------------- bridge 装配

/** 一被调用就抛错的 api 桩：用它证明重挂全程不碰远端。 */
function makeDeps() {
  const host = {
    logger: () => ({ info: () => {} }),
    workspaceRegistry: { list: () => workspaces },
  }
  const calls = []
  const defaults = defaultBridgeDeps(host)
  const api = Object.fromEntries(Object.keys(defaults.api).map((name) => [name, async (...args) => {
    calls.push({ name, args })
    throw new Error(`unexpected remote call: ${name}`)
  }]))
  return { deps: defaultBridgeDeps(host, { api }), calls }
}

function fakeReq({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  return {
    status: 0,
    body: undefined,
    headersSent: false,
    // bridge 会订阅 'close' 以便调用方断开时中止上游请求
    on() {},
    once() {},
    removeListener() {},
    writeHead(status) { this.status = status; this.headersSent = true },
    setHeader() {},
    end(payload) { this.body = payload },
  }
}

async function call(deps, { method = 'GET', url, body }) {
  const res = fakeRes()
  await createMsg9Bridge(deps).handle(fakeReq({ method, url, body }), res)
  let payload
  try { payload = JSON.parse(res.body ?? '{}') } catch { payload = { raw: res.body } }
  return { status: res.status, payload }
}

// ------------------------------------------------------------- 断言器

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

// ------------------------------------------------------------------ R1

await check('R1：候选只列"目录存在且还没有记录"的工作区，标题相同的排最前', async () => {
  await seedState()
  const { deps } = makeDeps()
  const { status, payload } = await call(deps, { url: '/dsh-msg9/relink-targets?key=ws-old' })
  assert.equal(status, 200)
  const keys = payload.data.targets.map((t) => t.key)
  // ws-new 标题同为 Proj ⇒ 必须排第一
  assert.equal(keys[0], 'ws-new', 'same-title target first')
  assert.ok(keys.includes('ws-bare'), 'bare workspace is eligible')
  // 已被占用的目标必须排除（重挂不允许覆盖）
  assert.ok(!keys.includes('ws-other'), 'occupied target excluded')
  assert.ok(!keys.includes('ws-old'), 'source excluded')
  // 目录不存在的目标必须排除
  assert.ok(!keys.some((k) => k === 'ws-old'))
  const target = payload.data.targets[0]
  assert.equal(target.same_title, true)
  assert.equal(target.path, newDir)
})

// ------------------------------------------------------------------ R2/R3/R4

await check('R2/R3/R4：重挂成功；记录其余字段一字不动；凭据字节不变；0 次远端调用', async () => {
  await seedState()
  const { deps, calls } = makeDeps()
  const before = JSON.parse(JSON.stringify((await loadState()).workspaces['ws-old']))

  const { status, payload } = await call(deps, {
    method: 'POST',
    url: '/dsh-msg9/relink-workspace',
    body: { from_key: 'ws-old', to_key: 'ws-new' },
  })
  assert.equal(status, 200, JSON.stringify(payload))
  assert.equal(payload.data.remote_untouched, true)
  assert.equal(payload.data.credentials_untouched, true)
  assert.equal(payload.data.path, newDir)

  const state = await loadState()
  assert.equal(state.workspaces['ws-old'], undefined, '旧键已消失')
  const moved = state.workspaces['ws-new']
  assert.ok(moved, '新键上有记录')
  // ★ 除了 path，其余字段必须与搬之前**逐字段相同**（游标/监听基线/已读标记）
  assert.deepEqual(moved, { ...before, path: newDir }, '除 path 外一字不动')

  // 凭据文件字节不变（重挂不碰凭据；文件名用 project_key，与 workspace id 无关）
  assert.equal(await readFile(credPath, 'utf8'), credBytes, 'credential file untouched')

  // 0 次远端调用 —— 这个桩一被调用就抛错，能走到这里本身就是证据
  assert.deepEqual(calls, [], 'no remote call at all')
})

// ------------------------------------------------------------------ R5

await check('R5：目标已有记录 ⇒ 409，且状态一字未动（绝不覆盖）', async () => {
  await seedState()
  const { deps, calls } = makeDeps()
  const before = JSON.stringify((await loadState()).workspaces)

  const { status, payload } = await call(deps, {
    method: 'POST',
    url: '/dsh-msg9/relink-workspace',
    body: { from_key: 'ws-old', to_key: 'ws-other' },
  })
  assert.equal(status, 409, JSON.stringify(payload))
  assert.match(String(payload.error?.code ?? payload.error ?? ''), /target-taken/)
  assert.equal(JSON.stringify((await loadState()).workspaces), before, '状态必须一字未动')
  assert.deepEqual(calls, [], 'no remote call')
})

// ------------------------------------------------------------------ R6

await check('R6：源目录还在 ⇒ 409（不许把好端端的信箱挂走）', async () => {
  // ws-other 的目录存在，把它当"源"去重挂 ⇒ 必须拒绝
  await seedState()
  const { deps } = makeDeps()
  const { status, payload } = await call(deps, {
    method: 'POST',
    url: '/dsh-msg9/relink-workspace',
    body: { from_key: 'ws-other', to_key: 'ws-bare' },
  })
  assert.equal(status, 409, JSON.stringify(payload))
  assert.match(String(payload.error?.code ?? payload.error ?? ''), /source-alive/)
  const state = await loadState()
  assert.ok(state.workspaces['ws-other'], '源记录必须原封不动')
  assert.equal(state.workspaces['ws-bare'], undefined, '目标不得被写入')
})

// ------------------------------------------------------------------ R7

await check('R7：目标不在注册表 / 目标目录不存在 / 源==目标 ⇒ 拒绝', async () => {
  await seedState()
  const { deps } = makeDeps()
  const post = (body) => call(deps, { method: 'POST', url: '/dsh-msg9/relink-workspace', body })

  // 目标不在注册表
  const a = await post({ from_key: 'ws-old', to_key: 'ws-nowhere' })
  assert.equal(a.status, 400, JSON.stringify(a.payload))
  assert.match(String(a.payload.error?.code ?? ''), /unknown-target/)

  // 源不在 state
  const b = await post({ from_key: 'ws-nowhere', to_key: 'ws-bare' })
  assert.equal(b.status, 404, JSON.stringify(b.payload))
  assert.match(String(b.payload.error?.code ?? ''), /unknown-workspace/)

  // 源 == 目标
  const c = await post({ from_key: 'ws-old', to_key: 'ws-old' })
  assert.equal(c.status, 400, JSON.stringify(c.payload))
  assert.match(String(c.payload.error?.code ?? ''), /same-workspace/)

  // 目标目录不存在：注册表里加一条死路径的目标
  workspaces.push({ id: 'ws-dead', title: 'Dead', path: join(root, 'never-created') })
  const d = await post({ from_key: 'ws-old', to_key: 'ws-dead' })
  assert.equal(d.status, 409, JSON.stringify(d.payload))
  assert.match(String(d.payload.error?.code ?? ''), /target-path-missing/)
  workspaces.pop()

  // 缺字段
  const e = await post({ from_key: 'ws-old' })
  assert.equal(e.status, 400, JSON.stringify(e.payload))
})

// ---------------------------------------------------- 开通的目录硬护栏
//
// 2026-09-30 真事故：界面对"目录已不存在"的僵尸行也画了「开通」按钮，
// 点下去**真的在 ORG 里建出了远端 Agent 信箱**（jev@dsh.ice.msg9.io），
// 而那个工作区的目录 /Users/iceskyls/OPC/Jev 早就不在了。
// 界面隐藏按钮只是减少误触，**护栏必须在服务端** —— 下面这两条就是钉它。

await check('G1：目录已不存在的工作区，开通一律 409（服务端硬护栏，且不碰远端）', async () => {
  await seedState()
  const { deps, calls } = makeDeps()
  const post = (url, body) => call(deps, { method: 'POST', url, body })

  // ws-old 的目录是故意没创建的（模拟"仓库搬走了"）
  const a = await post('/dsh-msg9/open-pod', { key: 'ws-old' })
  assert.equal(a.status, 409, JSON.stringify(a.payload))
  assert.match(String(a.payload.error?.code ?? ''), /workspace-dir-missing/)

  const b = await post('/dsh-msg9/provision', { key: 'ws-old' })
  assert.equal(b.status, 409, JSON.stringify(b.payload))
  assert.match(String(b.payload.error?.code ?? ''), /workspace-dir-missing/)

  // 关键：被拒之后**一次远端调用都没有发生**（桩一被调用就抛错）
  assert.deepEqual(calls, [], 'no remote call at all')

  // 而且没有凭空写出凭据/记录
  const state = await loadState()
  assert.equal(state.workspaces['ws-old'].project_key, 'proj-abc123', '记录未被改写')
})

await check('G2：目录存在的工作区照常可以走开通路径（护栏不误伤）', async () => {
  await seedState()
  const { deps } = makeDeps()
  // ws-bare 的目录存在、且没有记录 ⇒ 不该被 workspace-dir-missing 拦掉
  const res = await call(deps, {
    method: 'POST',
    url: '/dsh-msg9/open-pod',
    body: { key: 'ws-bare' },
  })
  assert.notEqual(res.status, 409, JSON.stringify(res.payload))
  assert.doesNotMatch(String(res.payload.error?.code ?? ''), /workspace-dir-missing/)
})

// --------------------------------------------------------------- 汇总

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
if (failed > 0) process.exitCode = 1
