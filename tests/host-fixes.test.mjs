/**
 * Host-side regression tests for the 2026-09-13 fix batch:
 *
 *   H1  bridge 鉴权看连接来源（remoteAddress），Host 头只做辅助；[::1] 无端口同源
 *   H2  state.json 跨进程文件锁（O_EXCL + stale 检测 + 响亮报错）
 *   #3  msg9_rotate 只回写 api_key，不盖旧 cursor/marks/watch_*
 *   #4  /unread：TTL 缓存 + in-flight 合并 + 部分失败沿用上轮快照
 *   #5  轮询防重入（createNonReentrant）
 *   #6  轮询模式 429 读 Retry-After 退避
 *   #7  owner 探测失败有 ~60s 负缓存
 *   #8  迁移顺序：转发成功后才替换 state，失败中止并保留旧配置
 *   #9  bootstrap 分支补记 watch_last_seen_at
 *
 * 模式仿照 tests/client.test.mjs / tests/smoke.test.mjs：fake msg9 server +
 * 直接驱动 lib 里导出的可测接缝。Run: node tests/host-fixes.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-hostfix-'))
process.env.MSG9_STATE_FILE = join(stateDir, 'state.json')
process.env.MSG9_HOME = join(stateDir, 'msg9-home')
delete process.env.MSG9_OWNER_KEY

const {
  apply,
  createMsg9Bridge,
  createNonReentrant,
  createWatchRuntime,
  computeUnread,
  invalidateUnreadCache,
  isTrustedRequest,
  migrateInbox,
  ownerContext,
  pollOnce,
  readProjectCredentials,
  readSigningSeed,
  resolveCredentials,
  saveOwner,
  upsertWorkspaceInbox,
} = await import('../lib/index.js')

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

const readState = async () => JSON.parse(await readFile(process.env.MSG9_STATE_FILE, 'utf8'))
const writeState = async (state) => writeFile(process.env.MSG9_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)

// ---------------------------------------------------------------- fake msg9

const mode = { forwardingFails: false }
const seen = { ownerMe: 0, ownerMeBad: 0, rotate: [], forwarding: [], disabled: [], moveMail: [], order: [] }

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake')
  const path = url.pathname
  const auth = req.headers.authorization || ''

  if (req.method === 'GET' && path === '/api/v1/owner/me') {
    if (auth === 'Bearer msg9_tk_bad') {
      seen.ownerMeBad += 1
      return reply(res, 401, { code: 40100, message: 'invalid owner key' })
    }
    seen.ownerMe += 1
    return reply(res, 200, { code: 0, data: { id: 'own_1', name: 'dsh', slug: 'vme', mail_domain: 'msg9.io', address_domain: 'vme.msg9.io' } })
  }
  if (req.method === 'POST' && path === '/api/v1/owner/agents') {
    const body = await readBody(req)
    seen.order.push('provision')
    return reply(res, 200, { code: 0, data: { created: [{ address: `${body.addresses[0]}@vme.msg9.io`, api_key: 'msg9_sk_migrated' }], errors: [] } })
  }
  if (req.method === 'PUT' && path === '/api/v1/agent/signing-key') {
    seen.order.push('signing-key')
    return reply(res, 200, { code: 0, data: { key_id: 'kid_fake', first_time: true } })
  }
  if (req.method === 'PUT' && path === '/api/v1/agent/forwarding') {
    const body = await readBody(req)
    seen.order.push('forwarding')
    if (mode.forwardingFails) return reply(res, 500, { code: 50000, message: 'forwarding broken' })
    seen.forwarding.push({ auth, target: body.target })
    return reply(res, 200, { code: 0, data: { target: body.target } })
  }
  if (req.method === 'POST' && /^\/api\/v1\/owner\/agents\/.+\/move-mail$/.test(path)) {
    seen.order.push('move-mail')
    seen.moveMail.push(decodeURIComponent(path.split('/')[5]))
    return reply(res, 200, { code: 0, data: { moved: 2 } })
  }
  if (req.method === 'POST' && /^\/api\/v1\/owner\/agents\/.+\/disable$/.test(path)) {
    seen.order.push('disable')
    seen.disabled.push(decodeURIComponent(path.split('/')[5]))
    return reply(res, 200, { code: 0, data: { status: 'suspended' } })
  }
  if (req.method === 'POST' && /^\/api\/v1\/owner\/agents\/.+\/rotate-key$/.test(path)) {
    seen.rotate.push(decodeURIComponent(path.split('/')[5]))
    return reply(res, 200, { code: 0, data: { api_key: `msg9_sk_rotated_${seen.rotate.length}` } })
  }
  return reply(res, 404, { code: 40400, message: 'not found' })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`

console.log('dsh-msg9-kit host-fixes test:')

// ------------------------------------------------------------- H1: 鉴权来源

function fakeReq({ headers = {}, remoteAddress } = {}) {
  return {
    headers,
    // 测试替身没有 socket 时退回旧的 Host 判定；给了 remoteAddress 就必须是 loopback。
    ...(remoteAddress ? { socket: { remoteAddress } } : {}),
  }
}

await check('H1: 无 Origin 时看连接来源，伪造 Host 不再放行', () => {
  // 非 loopback 连接：Host 写得再乖也拒
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '127.0.0.1:3080' }, remoteAddress: '8.8.8.8' })), false)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: 'localhost:3080' }, remoteAddress: '10.0.0.5' })), false)
  // loopback 连接 + loopback Host：放行（含 ::1 与 IPv4-mapped）
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '127.0.0.1:3080' }, remoteAddress: '127.0.0.1' })), true)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: 'localhost:3080' }, remoteAddress: '::1' })), true)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: 'localhost:3080' }, remoteAddress: '::ffff:127.0.0.1' })), true)
  // Host 辅助校验仍在：loopback 连接但 Host 指外站也拒
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: 'evil.example' }, remoteAddress: '127.0.0.1' })), false)
  // 无 socket 信息的注入替身：保持旧的 Host-only 行为（测试/内部调用）
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '127.0.0.1:3080' } })), true)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: 'evil.example:80' } })), false)
})

await check('H1: 同源检查修好 [::1] 无端口的边角', () => {
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '[::1]', origin: 'http://[::1]' } })), true)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '[::1]:3080', origin: 'http://[::1]:3080' } })), true)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '[::1]:3080', origin: 'http://[::1]:9999' } })), false)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '[::1]', origin: 'http://evil.example' } })), false)
})

await check('H1: 真实 socket 下伪造 Host 被 403（端到端）', async () => {
  const bridge = createMsg9Bridge({
    api: {},
    loadState: async () => ({ workspaces: {} }),
    stateFilePath: () => process.env.MSG9_STATE_FILE,
    defaultApiUrl: () => apiUrl,
    ensureInbox: async () => { throw new Error('not needed') },
    listWorkspaces: () => [],
    matchWorkspaceByPath: () => undefined,
    log: () => {},
  })
  const http = createServer((req, res) => void bridge.handle(req, res))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  const call = (headers) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/dsh-msg9/unread', headers }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', reject)
    req.end()
  })
  try {
    // 本机连接 + 伪造的外站 Host：必须 403（修复前会 200，直接读未读数）
    const forged = await call({ host: 'evil.example' })
    assert.equal(forged.status, 403, JSON.stringify(forged))
    const legit = await call({ host: `127.0.0.1:${port}` })
    assert.equal(legit.status, 200, JSON.stringify(legit))
  } finally {
    http.close()
  }
})

// ---------------------------------------------------------- H2: state 文件锁

/** 造一个属于别的（活的）进程的锁文件。 */
async function plantLock(pid) {
  await writeFile(`${process.env.MSG9_STATE_FILE}.lock`, JSON.stringify({ pid, at: new Date().toISOString() }))
}

await check('H2: 持锁进程死后（stale 锁），写入等待并继续', async () => {
  await writeState({ workspaces: { 'ws-keep': { address: 'a@msg9.io', api_key: 'msg9_sk_keep', api_url: apiUrl, title: 'keep', path: '/k' } } })
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'])
  await plantLock(child.pid)
  const started = Date.now()
  await upsertWorkspaceInbox('ws-new', { address: 'b@msg9.io', api_key: 'msg9_sk_new', api_url: apiUrl, title: 'new', path: '/n' })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 900, `应该等到锁进程退出（实际 ${elapsed}ms）`)
  const saved = await readState()
  assert.equal(saved.workspaces['ws-new'].api_key, 'msg9_sk_new')
  assert.equal(saved.workspaces['ws-keep'].api_key, 'msg9_sk_keep', '合并写入不覆盖别的信箱')
})

await check('H2: 活锁等不到就响亮报错，不静默覆盖', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
  await plantLock(child.pid)
  try {
    await assert.rejects(
      upsertWorkspaceInbox('ws-x', { address: 'x@msg9.io', api_key: 'msg9_sk_x', api_url: apiUrl, title: 'x', path: '/x' }),
      /locked by another process/,
    )
    const saved = await readState()
    assert.equal(saved.workspaces['ws-x'], undefined, '拿不到锁就什么都不写')
  } finally {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
})

await check('H2: 超龄锁文件（mtime > 30s）直接拆除', async () => {
  await plantLock(process.pid) // 自己的 pid：不算"别的活进程"，靠 mtime 判 stale
  const old = new Date(Date.now() - 60_000)
  await utimes(`${process.env.MSG9_STATE_FILE}.lock`, old, old)
  const started = Date.now()
  await upsertWorkspaceInbox('ws-y', { address: 'y@msg9.io', api_key: 'msg9_sk_y', api_url: apiUrl, title: 'y', path: '/y' })
  assert.ok(Date.now() - started < 2000, 'stale 锁不应等待')
  assert.equal((await readState()).workspaces['ws-y'].api_key, 'msg9_sk_y')
})

// ------------------------------------------- #3: msg9_rotate 只回写 api_key

await check('#3: msg9_rotate 不盖旧 cursor/marks/watch_*', async () => {
  await writeState({
    owner: { api_key: 'msg9_tk_good', api_url: apiUrl, slug: null, address_domain: null },
    workspaces: {
      'ws-b': {
        address: 'dsh-beta-1a2b@msg9.io', api_key: 'msg9_sk_old', api_url: apiUrl,
        title: 'Beta Repo', path: '/work/b',
        cursor: 'C1', watch_cursor: 'W1', watch_last_message_id: 'm9',
        watch_last_seen_at: '2026-09-13T01:00:00Z',
        marks: { m1: { read_by: 'agent' } },
        signing_seed: 'c2VlZA==',
      },
    },
  })
  const tools = []
  apply({
    logger: () => ({ info: () => {} }),
    tools: { register: (tool) => tools.push(tool) },
    commands: { register: () => {} },
    sessions: { get: (id) => (id === 'sess-b' ? { header: { cwd: '/work/b' } } : undefined) },
    inject: (deps, callback) => {
      const [dep] = [...deps]
      if (dep === 'workspaceRegistry') {
        return callback({ workspaceRegistry: { list: () => [{ id: 'ws-b', title: 'Beta Repo', path: '/work/b' }] } })
      }
      return callback({})
    },
  })
  const rotate = tools.find((entry) => entry.name === 'msg9_rotate')
  const text = await rotate.execute({}, { agent: { id: 'sess-b' } })
  assert.ok(text.includes('Rotated the key'), text)

  const resolved = await resolveCredentials('ws-b')
  assert.equal(resolved.api_key, 'msg9_sk_rotated_1', '新 key 已保存（凭据仓）')
  assert.equal(resolved.signing_seed, 'c2VlZA==', '签名种子保留')
  const saved = (await readState()).workspaces['ws-b']
  assert.equal(saved.api_key, undefined, 'state.json 不存 key')
  assert.equal(saved.cursor, 'C1', 'cursor 不被快照盖旧')
  assert.equal(saved.watch_cursor, 'W1', 'watch_cursor 保留')
  assert.equal(saved.watch_last_seen_at, '2026-09-13T01:00:00Z', 'watch_last_seen_at 保留')
  assert.deepEqual(saved.marks, { m1: { read_by: 'agent' } }, 'marks 保留')
})

// ------------------------------------- #4: /unread 缓存 + 合并 + 失败沿用快照

function unreadDeps(pages) {
  // pages: (key) => page | Error — 每次调用按 key 取
  const calls = []
  const state = {
    workspaces: {
      'ws-u-a': { address: 'ua@msg9.io', api_key: 'k1', api_url: apiUrl, title: 'a', path: '/a' },
      'ws-u-b': { address: 'ub@msg9.io', api_key: 'k2', api_url: apiUrl, title: 'b', path: '/b' },
    },
  }
  return {
    calls,
    deps: {
      loadState: async () => state,
      resolveCredentials: async (key) => state.workspaces[key],
      api: {
        listInbox: async (_url, key) => {
          calls.push(key)
          const page = pages(key === 'k1' ? 'ws-u-a' : 'ws-u-b')
          if (page instanceof Error) throw page
          return page
        },
      },
    },
  }
}
const SIGNAL = new AbortController().signal

await check('#4: TTL 缓存 + in-flight 合并，不再每个标签页各打一轮', async () => {
  invalidateUnreadCache()
  const { calls, deps } = unreadDeps(() => ({ unread_count: 3, total: 9, messages: [] }))
  const first = await computeUnread(deps, SIGNAL)
  assert.equal(first.total, 6)
  assert.equal(calls.length, 2, '两个信箱各一次')
  const second = await computeUnread(deps, SIGNAL)
  assert.equal(calls.length, 2, 'TTL 内不再打上游')
  assert.deepEqual(second, first)
  // 并发合并：ttlMs 0 强制过期，但 in-flight 仍只打一轮
  const [a, b] = await Promise.all([
    computeUnread(deps, SIGNAL, { ttlMs: 0 }),
    computeUnread(deps, SIGNAL, { ttlMs: 0 }),
  ])
  assert.equal(calls.length, 4, '两个并发调用合并成一轮')
  assert.deepEqual(a, b)
})

await check('#4: 部分信箱失败时沿用上轮快照，不再静默缺 key', async () => {
  invalidateUnreadCache()
  let failing = false
  const { deps } = unreadDeps((key) => {
    if (failing && key === 'ws-u-b') return new Error('upstream 500')
    return { unread_count: key === 'ws-u-a' ? 5 : 7, total: 10, messages: [] }
  })
  await computeUnread(deps, SIGNAL, { ttlMs: 0 }) // 快照: a=5 b=7
  failing = true
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.ok('ws-u-b' in view.byKey, '失败的信箱不丢 key')
  assert.equal(view.byKey['ws-u-b'], 7, '沿用上轮快照的未读数')
  assert.equal(view.byKey['ws-u-a'], 5, '成功的信箱用新值')
  assert.equal(view.total, 12)
})

// --------------------------------------------------- #5: 轮询防重入

await check('#5: createNonReentrant 上一轮没完就跳过本轮', async () => {
  let ran = 0
  let release
  const tick = createNonReentrant(() => new Promise((resolve) => {
    ran += 1
    release = resolve
  }))
  tick()
  tick() // 上一轮 pending：必须被跳过
  tick()
  assert.equal(ran, 1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  tick()
  assert.equal(ran, 2, '上一轮结束后恢复正常')
})

// --------------------------------------------------- #6: 轮询 429 看 Retry-After

function pollDeps(error) {
  const sleeps = []
  const state = { workspaces: { 'ws-p': { address: 'p@msg9.io', api_key: 'k', api_url: apiUrl, title: 'p', path: '/p', watch_cursor: 'W' } } }
  return {
    sleeps,
    deps: {
      loadState: async () => state,
      setWatchState: async () => {},
      listInbox: async () => { throw error },
      resolveAgent: () => undefined,
      sleep: async (ms) => { sleeps.push(ms) },
      uuid: () => 'u-1',
      now: () => 0,
      log: () => {},
    },
  }
}

await check('#6: 轮询模式 429 读 Retry-After 退避', async () => {
  const withHeader = pollDeps(Object.assign(new Error('too many requests'), { status: 429, retryAfter: 17 }))
  await pollOnce(withHeader.deps, createWatchRuntime())
  assert.deepEqual(withHeader.sleeps, [17_000], '服务端指定的等待优先')

  const bare = pollDeps(Object.assign(new Error('too many requests'), { status: 429 }))
  await pollOnce(bare.deps, createWatchRuntime())
  assert.deepEqual(bare.sleeps, [60_000], '没有 Retry-After 就退 60s')

  const other = pollDeps(Object.assign(new Error('boom'), { status: 500 }))
  await pollOnce(other.deps, createWatchRuntime())
  assert.deepEqual(other.sleeps, [], '非 429 不退避')
})

// --------------------------------------------------- #7: owner 探测负缓存

await check('#7: owner 探测失败有一分钟负缓存', async () => {
  // 失效的 key 直接放凭据仓（state 只留元数据，slug 未探测 → 触发惰性探测）
  await writeState({ workspaces: {} })
  await saveOwner({ api_key: 'msg9_tk_bad', api_url: apiUrl })
  const before = seen.ownerMeBad
  const first = await ownerContext()
  const second = await ownerContext()
  assert.equal(seen.ownerMeBad, before + 1, '第二次调用命中负缓存，不再白打 /owner/me')
  assert.equal(first.owner.api_key, 'msg9_tk_bad', '探测失败不影响返回已保存的 owner')
  assert.equal(second.owner.slug, undefined, '未探测的状态保持原样')
})

// --------------------------------------------------- #8: 迁移顺序

const MIG_WS = { key: 'ws-m', title: 'migrate-me', path: '/work/m' }
const OLD_INBOX = {
  address: 'dsh-migrate-me-9z8y@msg9.io', api_key: 'msg9_sk_legacy', api_url: apiUrl,
  title: 'migrate-me', path: '/work/m', cursor: 'OLDC',
}

async function seedMigrationState() {
  // 凭据仓为准：清掉上一个夹具留下的 tenant key，让本夹具的遗留 key 走迁移。
  await rm(join(process.env.MSG9_HOME, 'tenants', 'dsh.key'), { force: true })
  await writeState({
    owner: { api_key: 'msg9_tk_good', api_url: apiUrl, slug: 'vme', mail_domain: 'msg9.io', address_domain: 'vme.msg9.io' },
    workspaces: { 'ws-m': { ...OLD_INBOX } },
  })
}

await check('#8: 转发失败则中止迁移，state 仍指向旧信箱', async () => {
  await seedMigrationState()
  mode.forwardingFails = true
  seen.order.length = 0
  try {
    await assert.rejects(
      migrateInbox(MIG_WS, OLD_INBOX, 'msg9_tk_old'),
      /forwarding|转发/,
    )
    assert.deepEqual(seen.order, ['provision', 'signing-key', 'forwarding'], '到转发为止，没有后续步骤')
    const entry = (await readState()).workspaces['ws-m']
    assert.equal(entry.cursor, 'OLDC', '旧 cursor 不动')
    // 旧凭据原样保留（惰性迁移已把它们挪进凭据仓，activate 没有执行）。
    const kept = await readProjectCredentials(entry.project_key)
    assert.equal(kept.address, OLD_INBOX.address, '凭据仓仍指向旧信箱')
    assert.equal(kept.api_key, OLD_INBOX.api_key, '旧 key 原样保留')
    assert.equal(seen.moveMail.length, 0)
    assert.equal(seen.disabled.length, 0)
  } finally {
    mode.forwardingFails = false
  }
})

await check('#8: 转发成功后（且先于搬信/停用）才替换 state', async () => {
  await seedMigrationState()
  seen.order.length = 0
  const result = await migrateInbox(MIG_WS, OLD_INBOX, 'msg9_tk_old')
  assert.equal(result.forwarding, true)
  assert.equal(result.movedMail, 2)
  assert.equal(result.oldDisabled, true)
  assert.deepEqual(seen.order, ['provision', 'signing-key', 'forwarding', 'move-mail', 'disable'])
  assert.equal(seen.forwarding.at(-1).auth, `Bearer ${OLD_INBOX.api_key}`, '转发用旧信箱自己的 key 设置')
  assert.equal(seen.forwarding.at(-1).target, result.inbox.address)
  const entry = (await readState()).workspaces['ws-m']
  assert.ok(entry.project_key, 'state 只留 project_key 引用')
  assert.equal(entry.api_key, undefined, 'state.json 不存 key')
  assert.equal(entry.cursor, undefined, '旧 cursor 不随迁（属于旧信箱的流）')
  const creds = await readProjectCredentials(entry.project_key)
  assert.equal(creds.address, result.inbox.address, '凭据仓换成新信箱')
  assert.equal(creds.api_key, 'msg9_sk_migrated')
  assert.ok(await readSigningSeed(entry.project_key), '签名种子随替换落凭据仓')
})

// --------------------------------------- #9: bootstrap 补记 watch_last_seen_at

await check('#9: bootstrap 分支同时记录 id 与时间基线', async () => {
  const state = {
    workspaces: {
      'ws-w': { address: 'w@msg9.io', api_key: 'k', api_url: apiUrl, title: 'w', path: '/w' },
    },
  }
  const deps = {
    loadState: async () => state,
    setWatchState: async (key, patch) => Object.assign(state.workspaces[key], patch),
    listInbox: async () => ({
      messages: [{ message_id: 'm9', from_address: 'peer@msg9.io', created_at: '2026-09-13T02:00:00Z' }],
      next_cursor: 'W1',
    }),
    resolveAgent: () => undefined,
    uuid: () => 'u-1',
    now: () => 0,
    log: () => {},
  }
  await pollOnce(deps, createWatchRuntime())
  const inbox = state.workspaces['ws-w']
  assert.equal(inbox.watch_cursor, 'W1')
  assert.equal(inbox.watch_last_message_id, 'm9')
  assert.equal(inbox.watch_last_seen_at, '2026-09-13T02:00:00Z', '时间基线一起落库（id 滚出页面后防重复播报）')
})

server.close()
console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
