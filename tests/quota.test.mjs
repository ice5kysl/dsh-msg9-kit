/**
 * T-23 —— 客户端省配额两条的回归套件。
 *
 * 背景（msg9 PO 从**生产访问日志**里数出来的事实）：我们 `lib/index.js` 的请求
 * 模式里有两条是自己制造的重复请求 ——
 *
 *   ① `GET /api/v1/inbox/messages?folder=all&limit=1`  **3380 次/天**
 *      = 一边用 `/inbox/stream` 长轮询，一边又对**每个信箱**各打一次未读轮询；
 *   ② `GET /api/v1/resolve/iceskyls@msg9.io`             **591 次/天**
 *      = 同一个地址在热路径上被反复解析，而这个记录几乎不变。
 *
 * 平台按 **IP 200 次/分钟**限流（实测连"收一封信"都会被 429 挡回），所以这两条
 * 直接对应可观测的限流告警。
 *
 * 本套件锁三件事：
 *   A. **省配额**：推送通道已经带回的未读数，绝不再单独轮询一次（0 次 REST）；
 *   B. **同义化契约**（v1.41.5 T-74）：同一个页面的字段，无论从 REST 还是从
 *      stream 取，徽章结果必须**完全一致** —— 断言契约本身，而不只是"看起来对"；
 *   C. **兜底不许省**："没收到唤醒 ≠ 没有信"：通道断了 / 快照过期 / 本地快照
 *      读不到，都必须立刻退回服务器直查，而不是拿旧读数糊弄。
 * 外加 /resolve 缓存的命中、过期、失败不缓存、阳性才缓存、LRU 与 apiUrl 隔离。
 *
 * 风格照抄 tests/host-fixes.test.mjs / client.test.mjs：fake msg9 server +
 * 直接驱动 lib 里导出的可测接缝。Run: node tests/quota.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const scratch = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-quota-'))
process.env.MSG9_STATE_FILE = join(scratch, 'state.json')
process.env.MSG9_HOME = join(scratch, 'msg9-home')
// 本套件只驱动进程内的接缝：绝不去找机器级 daemon（更不许 spawn 一个）。
process.env.MSG9_WATCH_DAEMON = '0'
delete process.env.MSG9_OWNER_KEY

const {
  INBOX_SNAPSHOT_MAX_AGE_MS,
  RESOLVE_CACHE_TTL_MS,
  clearInboxSnapshot,
  clearResolveCache,
  computeUnread,
  createDaemonClient,
  createRegistry,
  createResolveCache,
  createWatchRuntime,
  defaultEngineConfig,
  inboxSnapshotKeys,
  invalidateUnreadCache,
  noteInboxSnapshot,
  openDaemonStore,
  resetInboxSnapshots,
  resolveAddress,
  resolveCacheStats,
  startControlServer,
  streamInboxLoop,
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

const SIGNAL = new AbortController().signal
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- fake msg9

const seen = { resolve: [], inbox: [] }
function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake')
  if (req.method === 'GET' && url.pathname === '/api/v1/resolve/') return reply(res, 200, { code: 0, data: {} })
  if (req.method === 'GET' && url.pathname.startsWith('/api/v1/resolve/')) {
    const address = decodeURIComponent(url.pathname.slice('/api/v1/resolve/'.length))
    seen.resolve.push(address)
    return reply(res, 200, { code: 0, data: { address, exists: true, inbox_url: 'http://fake/inbox', public_key: 'pk' } })
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/inbox/messages') {
    seen.inbox.push(url.searchParams.get('folder'))
    return reply(res, 200, { code: 0, data: { messages: [], total: 9, unread_count: 3, next_cursor: 'c-rest' } })
  }
  return reply(res, 404, { code: 40400, message: 'not found' })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`

// ------------------------------------------------------------- 未读接缝工具

const KEYS = ['ws-a', 'ws-b']

/** computeUnread 的最小 deps + 一个按 api_key 记账的 listInbox。 */
function unreadDeps({ keys = KEYS, page = { unread_count: 3, total: 9, messages: [] }, extra = {} } = {}) {
  const calls = []
  const workspaces = {}
  for (const key of keys) {
    workspaces[key] = { address: `${key}@msg9.io`, api_key: `sk-${key}`, api_url: apiUrl, title: key, path: `/w/${key}` }
  }
  const deps = {
    loadState: async () => ({ workspaces }),
    resolveCredentials: async (key) => workspaces[key],
    api: {
      listInbox: async (_url, apiKey, query) => {
        calls.push({ key: apiKey, query })
        return typeof page === 'function' ? page(apiKey) : page
      },
    },
    log: () => {},
    ...extra,
  }
  return { calls, deps, workspaces }
}

/** 每项都用同一个起点：清空 REST 缓存 + 全部推送快照。 */
function resetUnread() {
  invalidateUnreadCache()
  resetInboxSnapshots()
}

const shape = (view) => ({
  unread: Object.fromEntries(Object.entries(view.byKey).sort()),
  total: Object.fromEntries(Object.entries(view.totalByKey).sort()),
})

console.log('dsh-msg9-kit quota (T-23) test:')

// ============================================================ A. 未读：省配额

await check('A1: 推送页带回的未读 ⇒ 徽章 0 次 REST（同一件事不再做两遍）', async () => {
  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() })
  noteInboxSnapshot('ws-b', { unread: 0, total: 2, at: Date.now() })
  const { calls, deps } = unreadDeps()
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.equal(calls.length, 0, `推送页已经带了未读，不该再打 folder=all&limit=1（实际 ${calls.length} 次）`)
  assert.equal(view.total, 5)
  assert.deepEqual(view.byKey, { 'ws-a': 5, 'ws-b': 0 })
  assert.deepEqual(view.totalByKey, { 'ws-a': 9, 'ws-b': 2 })
  assert.deepEqual(view.sourceByKey, { 'ws-a': 'stream', 'ws-b': 'stream' })
})

await check('A2: 真实 streamInboxLoop 的页会喂进快照（"从流事件取"的端到端接缝）', async () => {
  resetUnread()
  const rt = createWatchRuntime()
  const state = { workspaces: { 'ws-a': { address: 'ws-a@msg9.io', api_key: 'sk-ws-a', api_url: apiUrl, watch_cursor: 'c-seed' } } }
  const controller = new AbortController()
  let streamCalls = 0
  let snapshots = 0
  await streamInboxLoop({
    loadState: async () => state,
    setWatchState: async () => {},
    listInbox: async () => ({ messages: [], total: 0, unread_count: 0 }),
    resolveAgent: () => undefined,
    onEvent: () => {},
    onInboxSnapshot: (key, snapshot) => {
      snapshots += 1
      noteInboxSnapshot(key, snapshot)
    },
    uuid: () => 'u-1',
    now: () => Date.now(),
    log: () => {},
    sleep: async () => {},
    streamInbox: async () => {
      streamCalls += 1
      // 第二轮才 abort：循环在 `signal.aborted` 时会在登记快照**之前**返回，
      // 第一轮必须完整走完才能证明"页 → 快照"这条线是通的。
      if (streamCalls >= 2) controller.abort()
      return { messages: [], total: 12, unread_count: 4, next_cursor: 'c-2' }
    },
  }, rt, 'ws-a', controller.signal)

  assert.equal(snapshots, 1, '恰好登记了一次快照（abort 的那轮不登记）')
  assert.deepEqual(inboxSnapshotKeys(), ['ws-a'])
  const { calls, deps } = unreadDeps({ keys: ['ws-a'] })
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.equal(calls.length, 0, '流跑过之后，徽章不该再打 REST')
  assert.equal(view.byKey['ws-a'], 4)
  assert.equal(view.totalByKey['ws-a'], 12)
  assert.equal(view.sourceByKey['ws-a'], 'stream')
})

await check('A3: 同义化契约（T-74）—— 同一个页面的字段，两条来源必须给出同一个徽章', async () => {
  // 服务端在一次返回里同时给出 unread_count / total；REST 与 stream 现在是同名字段同义。
  const page = { unread_count: 5, total: 9, messages: [] }
  resetUnread()
  const rest = unreadDeps({ keys: ['ws-a'], page })
  const viaRest = await computeUnread(rest.deps, SIGNAL, { ttlMs: 0 })
  assert.deepEqual(rest.calls.map((c) => c.query), [{ folder: 'all', limit: 1 }], 'REST 路径只打一次 folder=all&limit=1')

  resetUnread()
  noteInboxSnapshot('ws-a', { unread: page.unread_count, total: page.total, at: Date.now() })
  const stream = unreadDeps({ keys: ['ws-a'], page })
  const viaStream = await computeUnread(stream.deps, SIGNAL, { ttlMs: 0 })

  assert.equal(stream.calls.length, 0)
  assert.deepEqual(shape(viaStream), shape(viaRest), '同一页的两条来源必须给出同一个徽章（同义化契约）')
  assert.deepEqual(shape(viaRest), { unread: { 'ws-a': 5 }, total: { 'ws-a': 9 } })
})

await check('A4: 只有缺快照的信箱才走 REST（N 个信箱只付缺的那几个）', async () => {
  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() })
  const { calls, deps } = unreadDeps()
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.deepEqual(calls.map((c) => c.key), ['sk-ws-b'], '只对没有快照的信箱打上游')
  assert.deepEqual(view.sourceByKey, { 'ws-a': 'stream', 'ws-b': 'rest' })
})

await check('A5: 本机 daemon 的快照同样免 REST，且比更旧的流快照更新时以它为准', async () => {
  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() - 5_000 })
  const { calls, deps } = unreadDeps({
    keys: ['ws-a'],
    extra: { readLocalSnapshots: async () => ({ 'ws-a': { unread: 7, total: 11, at: Date.now() } }) },
  })
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.equal(calls.length, 0, 'daemon 已经付过配额的读数，不该再打一次上游')
  assert.equal(view.byKey['ws-a'], 7)
  assert.equal(view.sourceByKey['ws-a'], 'local')
})

await check('A6: daemon 快照读不到 ⇒ 退回 REST，徽章不许因此变瞎', async () => {
  resetUnread()
  const { calls, deps } = unreadDeps({
    keys: ['ws-a'],
    page: { unread_count: 3, total: 9, messages: [] },
    extra: { readLocalSnapshots: async () => { throw new Error('daemon unreachable') } },
  })
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.equal(calls.length, 1, '本地快照失败必须落回服务器直查')
  assert.equal(view.byKey['ws-a'], 3)
  assert.equal(view.sourceByKey['ws-a'], 'rest')
})

// ====================================================== C. 兜底不许一起省掉

await check('C1: 通道结束（clearInboxSnapshot）⇒ 立刻退回 REST', async () => {
  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() })
  clearInboxSnapshot('ws-a')
  const { calls, deps } = unreadDeps({ keys: ['ws-a'] })
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.equal(calls.length, 1, '订阅流断了必须有兜底：退回服务器直查')
  assert.equal(view.sourceByKey['ws-a'], 'rest')
  assert.equal(view.byKey['ws-a'], 3, '拿服务器真值，不是死通道的旧读数')
})

await check('C2: 快照超过可信年龄 ⇒ 退回 REST；年龄内仍然免 REST（边界都测）', async () => {
  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() - (INBOX_SNAPSHOT_MAX_AGE_MS + 1_000) })
  const stale = unreadDeps({ keys: ['ws-a'] })
  await computeUnread(stale.deps, SIGNAL, { ttlMs: 0 })
  assert.equal(stale.calls.length, 1, '过期快照不许继续喂徽章')

  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() - (INBOX_SNAPSHOT_MAX_AGE_MS - 5_000) })
  const fresh = unreadDeps({ keys: ['ws-a'] })
  const view = await computeUnread(fresh.deps, SIGNAL, { ttlMs: 0 })
  assert.equal(fresh.calls.length, 0, '年龄内的快照继续免 REST')
  assert.equal(view.byKey['ws-a'], 5)
})

await check('C3: 客户端断开时的空壳页（无 unread_count / total）绝不清零徽章', async () => {
  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() })
  // /inbox/stream 的 ctx.Done() 分支只回 messages + next_cursor —— 两个字段都缺席。
  noteInboxSnapshot('ws-a', { unread: undefined, total: undefined, at: Date.now() })
  const { calls, deps } = unreadDeps({ keys: ['ws-a'] })
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.equal(calls.length, 0)
  assert.equal(view.byKey['ws-a'], 5, '缺字段 = 不知道，不是 0')
  assert.equal(view.totalByKey['ws-a'], 9)
})

await check('C4: since 模式的页不许把"窗口命中数"当信箱大小（只喂 unread）', async () => {
  resetUnread()
  // 先有一次 offset 观测，拿到真正的信箱大小
  noteInboxSnapshot('ws-a', { unread: 4, total: 9, at: Date.now() })
  // 再来一次 since 模式的轮询页：只有 unread 是可信的
  noteInboxSnapshot('ws-a', { unread: 5, at: Date.now() })
  const { calls, deps } = unreadDeps({ keys: ['ws-a'] })
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.equal(calls.length, 0)
  assert.equal(view.byKey['ws-a'], 5, 'unread 用最新的读数')
  assert.equal(view.totalByKey['ws-a'], 9, '信箱大小沿用上一次可信的 offset 观测')
})

await check('C5: 失效是按 key 的 —— 刚标已读的那个信箱立刻走 REST，别的信箱不受影响', async () => {
  resetUnread()
  noteInboxSnapshot('ws-a', { unread: 5, total: 9, at: Date.now() })
  noteInboxSnapshot('ws-b', { unread: 2, total: 4, at: Date.now() })
  invalidateUnreadCache('ws-a') // 面板在 ws-a 上点了一次「已读」
  const { calls, deps } = unreadDeps()
  const view = await computeUnread(deps, SIGNAL, { ttlMs: 0 })
  assert.deepEqual(calls.map((c) => c.key), ['sk-ws-a'], '只有被作废的那个信箱重新直查')
  assert.equal(view.sourceByKey['ws-a'], 'rest')
  assert.equal(view.sourceByKey['ws-b'], 'stream', 'ws-b 的快照不受影响（否则一次已读要付 N 次配额）')
  assert.deepEqual(shape(view), { unread: { 'ws-a': 3, 'ws-b': 2 }, total: { 'ws-a': 9, 'ws-b': 4 } })
})

await check('C6: 真实 HTTP 兜底路径仍然可用（没有推送通道时的老行为没坏）', async () => {
  resetUnread()
  seen.inbox.length = 0
  const { defaultBridgeDeps } = await import('../lib/index.js')
  const realApi = defaultBridgeDeps({ logger: () => ({ info() {}, warn() {}, error() {} }) }).api
  const { deps } = unreadDeps({ keys: ['ws-a'] })
  const view = await computeUnread({ ...deps, api: realApi }, SIGNAL, { ttlMs: 0 })
  assert.deepEqual(seen.inbox, ['all'], '兜底确实打了真实上游，且只打一次')
  assert.equal(view.byKey['ws-a'], 3)
  assert.equal(view.totalByKey['ws-a'], 9)
})

// ============================================================ B. /resolve 缓存

await check('B1: 真实 /resolve 路径 —— 同一地址解析 3 次只打 1 次上游', async () => {
  clearResolveCache()
  seen.resolve.length = 0
  const before = resolveCacheStats()
  for (let i = 0; i < 3; i += 1) await resolveAddress(apiUrl, 'iceskysl@msg9.io')
  const after = resolveCacheStats()
  assert.deepEqual(seen.resolve, ['iceskysl@msg9.io'], '上游只被问了一次')
  assert.equal(after.misses - before.misses, 1, '一次未命中')
  assert.equal(after.hits - before.hits, 2, '两次命中缓存')
})

await check('B2: 不同地址各自解析（缓存不串味）；不同 apiUrl 也不串味', async () => {
  clearResolveCache()
  seen.resolve.length = 0
  await resolveAddress(apiUrl, 'a@msg9.io')
  await resolveAddress(apiUrl, 'b@msg9.io')
  await resolveAddress(apiUrl, 'a@msg9.io')
  assert.deepEqual(seen.resolve, ['a@msg9.io', 'b@msg9.io'], '两个地址各打一次，重复的命中缓存')

  // apiUrl 是缓存键的一部分：同一个地址在另一个平台上必须重新解析。
  // （用注入 load 断言，避免测试依赖第二个真实服务器。）
  const loads = []
  const cache = createResolveCache({ load: async (url, address) => { loads.push(`${url}|${address}`); return { address, exists: true } } })
  await cache.resolve('http://a.invalid', 'x@msg9.io')
  await cache.resolve('http://a.invalid', 'x@msg9.io')
  await cache.resolve('http://b.invalid', 'x@msg9.io')
  assert.deepEqual(loads, ['http://a.invalid|x@msg9.io', 'http://b.invalid|x@msg9.io'], '不同 apiUrl 不许互相命中')
})

await check('B3: TTL 到期重新拉；TTL 内命中（用注入时钟，不靠 sleep）', async () => {
  let clock = 1_000_000
  let loads = 0
  const cache = createResolveCache({
    ttlMs: 300_000,
    now: () => clock,
    load: async (_url, address) => { loads += 1; return { address, exists: true } },
  })
  await cache.resolve('http://x', 'a@msg9.io')
  clock += 299_000
  await cache.resolve('http://x', 'a@msg9.io')
  assert.equal(loads, 1, 'TTL 内命中')
  clock += 2_000 // 累计 301s > 300s
  await cache.resolve('http://x', 'a@msg9.io')
  assert.equal(loads, 2, 'TTL 到期必须重新拉（陈旧上界是 5 分钟，不是无限）')
  assert.equal(cache.stats().hits, 1)
  assert.equal(cache.stats().misses, 2)
})

await check('B4: 失败不缓存 —— 上游 500 之后下一次仍然真问（不许把错误钉住）', async () => {
  let loads = 0
  const cache = createResolveCache({
    load: async () => { loads += 1; throw new Error('upstream 500') },
  })
  await assert.rejects(() => cache.resolve('http://x', 'a@msg9.io'), /upstream 500/)
  await assert.rejects(() => cache.resolve('http://x', 'a@msg9.io'), /upstream 500/)
  assert.equal(loads, 2, '抛错的结果一次都不许进缓存')
  assert.equal(cache.stats().size, 0)
})

await check('B5: exists:false 不缓存 —— 刚建好的地址不会被"不存在"钉住', async () => {
  let loads = 0
  let exists = false
  const cache = createResolveCache({
    load: async (_url, address) => { loads += 1; return { address, exists } },
  })
  await cache.resolve('http://x', 'new@msg9.io')
  exists = true // 对端刚注册好
  const record = await cache.resolve('http://x', 'new@msg9.io')
  assert.equal(loads, 2, '负结果不进缓存（否则静默解析不到，正是"发错地址不报错"那类事故）')
  assert.equal(record.exists, true, '第二次拿到的是刚建好的真值')
  assert.equal(cache.stats().size, 1, '正结果才留下')
})

await check('B6: LRU 容量上限 —— 超出后淘汰最久未用的那条', async () => {
  const loads = []
  const cache = createResolveCache({
    max: 2,
    load: async (_url, address) => { loads.push(address); return { address, exists: true } },
  })
  await cache.resolve('http://x', 'a')
  await cache.resolve('http://x', 'b')
  await cache.resolve('http://x', 'a') // a 变热
  await cache.resolve('http://x', 'c') // 淘汰最久未用的 b
  assert.equal(cache.stats().size, 2)
  await cache.resolve('http://x', 'a') // 仍命中
  await cache.resolve('http://x', 'b') // b 被淘汰过 ⇒ 重新拉
  assert.deepEqual(loads, ['a', 'b', 'c', 'b'], 'LRU：热的留下，被淘汰的重拉')
})

await check('B7: 默认 TTL 有界：≥ 卡上的 5 分钟下限，且不许变成"永不过期"', async () => {
  // 下界 = 卡上的要求（≥5 分钟）；上界 = 对端换 key / 重挂之后最多被藏这么久。
  // 上界这条同样重要：MAX_SAFE_INTEGER 的 TTL 会让"缓存"变成"钉死"。
  assert.ok(RESOLVE_CACHE_TTL_MS >= 300_000, `TTL 必须 ≥ 5 分钟，实际 ${RESOLVE_CACHE_TTL_MS}ms`)
  assert.ok(RESOLVE_CACHE_TTL_MS <= 3_600_000, `TTL 必须 ≤ 1 小时（否则记录变了就被藏住），实际 ${RESOLVE_CACHE_TTL_MS}ms`)

  // 行为面：默认那条缓存的 TTL **就是**这个常数（不能是另一套悄悄生效的值）。
  let clock = 0
  let loads = 0
  const cache = createResolveCache({ now: () => clock, load: async (_url, address) => { loads += 1; return { address, exists: true } } })
  await cache.resolve('http://x', 'a@msg9.io')
  clock += RESOLVE_CACHE_TTL_MS - 1_000
  await cache.resolve('http://x', 'a@msg9.io')
  assert.equal(loads, 1, '默认 TTL 内命中')
  // 把时钟推到"远超任何有界 TTL"仍然命中 ⇒ 说明这个 TTL 根本不是有界的
  clock += 24 * 60 * 60_000
  await cache.resolve('http://x', 'a@msg9.io')
  assert.equal(loads, 2, 'TTL 到期必须重新拉 —— 缓存不许是"永不过期"')
})

// ==================================================== D. daemon 侧（推送通道持有者）

await check('D1: daemon 引擎把 fetch 页里的未读记下来，供 /unread 读走', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-quota-daemon-'))
  const store = await openDaemonStore(home)
  const registry = createRegistry()
  const ws = {
    sent: [],
    lastFrameAt: Date.now(),
    ontext: undefined,
    onclose: undefined,
    onerror: undefined,
    sendText(data) { ws.sent.push(data) },
    close() { ws.onclose?.(1000, '') },
    destroy() { ws.onclose?.(1006, 'abnormal closure') },
  }
  let fetchCalls = 0
  const { createEngine, DAEMON_PROTOCOL } = await import('../lib/index.js')
  const engine = createEngine({
    store,
    registry,
    config: {
      ...defaultEngineConfig(),
      // 首扫（offset 模式，total 可信）之后，让安全网很快再跳一次（since 模式）。
      safetyNetMs: 60,
      reconcileMs: 600_000,
      pendingSweepMs: 600_000,
      wsWatchdogMs: 600_000,
      batchWindowMs: 40,
    },
    log: () => {},
    uuid: (() => { let n = 0; return () => `uuid-${(n += 1)}` })(),
    now: () => Date.now(),
    listInbox: async (_url, _key, query) => {
      fetchCalls += 1
      if (!query.since) {
        // bootstrap / offset 模式：total 是 folder 全量 ⇒ 记下来
        return { messages: [{ message_id: 'm0', from_address: 'p@msg9.io', created_at: '2026-09-29T00:00:00.000Z' }], next_cursor: 'C1', has_more: false, unread_count: 4, total: 7 }
      }
      // since 模式：unread 可信，**total 是窗口命中数（999），绝不许当信箱大小**
      return { messages: [], next_cursor: 'C2', has_more: false, unread_count: 5, total: 999 }
    },
    issueWsTicket: async () => ({ ticket: 'ticket-1' }),
    wsConnect: async () => ws,
    deliverPost: async () => {},
    sleep,
    enumerate: async () => [{ project_key: 'pk-1', address: 'a@msg9.io', api_key: 'k', api_url: 'http://fake' }],
  })
  try {
    await engine.start()
    registry.upsert({
      instance_id: 'inst-1', pid: 4242, dsh_home: '/h', port: 4321,
      deliver_token: 'tok-1', protocol: DAEMON_PROTOCOL,
      workspaces: [{ project_key: 'pk-1', key: 'ws-a', title: 'a', path: '/a' }],
    }, Date.now())
    // 首扫的读数先到位（unread 4 / total 7）
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const rows = engine.unreadSnapshot()
      if (rows.length === 1 && rows[0].unread === 5) break
      await sleep(20)
    }
    const rows = engine.unreadSnapshot()
    assert.equal(rows.length, 1, `一个信箱一条读数，实际 ${JSON.stringify(rows)}`)
    assert.equal(rows[0].project_key, 'pk-1')
    assert.equal(rows[0].address, 'a@msg9.io')
    assert.equal(rows[0].unread, 5, 'since 那轮把 unread 从 4 更新到 5')
    assert.equal(rows[0].total, 7, 'since 模式的 total(999) 是窗口命中数，绝不许当信箱大小')
    assert.ok(fetchCalls >= 2, 'offset 与 since 两轮都跑过')
  } finally {
    await engine.stop()
  }
})

await check('D2: 控制面 GET /unread 带鉴权、返回引擎读数；无读数的信箱不出现', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-quota-ctl-'))
  const store = await openDaemonStore(home)
  const registry = createRegistry()
  const rows = [{ project_key: 'pk-1', address: 'a@msg9.io', unread: 4, total: 7, at: 1234 }]
  const fakeEngine = {
    start: async () => {}, stop: async () => {}, replayPending: () => {},
    status: () => [], unreadSnapshot: () => rows,
  }
  const handle = await startControlServer({
    store, registry, engine: fakeEngine, token: 'tok-secret', version: '0.0.0-test', protocol: 1,
    startedAt: new Date().toISOString(), log: () => {},
  })
  try {
    const url = `http://127.0.0.1:${handle.port}/unread`
    const unauthorized = await fetch(url)
    assert.equal(unauthorized.status, 401, '没有 token 不许读')
    const authorized = await fetch(url, { headers: { Authorization: 'Bearer tok-secret' } })
    assert.equal(authorized.status, 200)
    const body = await authorized.json()
    assert.deepEqual(body.data.inboxes, rows)
  } finally {
    await handle.close()
  }
})

await check('D3: daemonclient.readUnread 解析读数；老 daemon(404)/未连接 ⇒ 空数组（退回 REST 的判据）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-quota-client-'))
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(home, { recursive: true })

  // 一个最小可用的 daemon 控制面：/healthz + /register 是 start() 的握手，
  // /unread 才是被测对象。
  const good = createServer((req, res) => {
    if (req.url === '/healthz') return reply(res, 200, { ok: true, data: { status: 'ok' } })
    if (req.url === '/register') return reply(res, 200, { ok: true, data: { instance_id: 'x' } })
    if (req.url === '/unread') {
      return reply(res, 200, { ok: true, data: { inboxes: [
        { project_key: 'pk-1', address: 'a@msg9.io', unread: 4, total: 7, at: 111 },
        { project_key: 'pk-2', address: 'b@msg9.io' }, // 没有 unread ⇒ 丢弃
      ] } })
    }
    return reply(res, 404, { ok: false })
  })
  await new Promise((resolve) => good.listen(0, '127.0.0.1', resolve))
  const writeInfo = (port, version) => writeFile(join(home, 'daemon.json'), `${JSON.stringify({
    pid: process.pid, port, token: 'tok-1', started_at: new Date().toISOString(), version, protocol: 1,
  })}\n`)
  await writeInfo(good.address().port, '0.0.0-test')
  try {
    const client = createDaemonClient({ home, getPort: () => 0, getWorkspaces: async () => [], log: () => {}, spawnDaemon: () => {} })
    assert.deepEqual(await client.readUnread(), [], '还没 start：不猜，返回空数组')
    assert.equal(await client.start(), true, '握手成功（/healthz + /register）')
    const rows = await client.readUnread()
    assert.deepEqual(rows, [{ project_key: 'pk-1', address: 'a@msg9.io', unread: 4, total: 7, at: 111 }], '解析合法读数并丢掉无读数的行')
    await client.stop()

    // 老 daemon：没有 /unread ⇒ 404 ⇒ 空数组 ⇒ 调用方退回 REST
    const old = createServer((req, res) => {
      if (req.url === '/healthz') return reply(res, 200, { ok: true, data: { status: 'ok' } })
      if (req.url === '/register') return reply(res, 200, { ok: true, data: { instance_id: 'x' } })
      return reply(res, 404, { ok: false, error: { code: 'not-found', message: 'no route' } })
    })
    await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve))
    await writeInfo(old.address().port, '0.0.0-old')
    const oldClient = createDaemonClient({ home, getPort: () => 0, getWorkspaces: async () => [], log: () => {}, spawnDaemon: () => {} })
    assert.equal(await oldClient.start(), true)
    assert.deepEqual(await oldClient.readUnread(), [], '老 daemon 没有这条路由 ⇒ 空数组（调用方会退回 REST）')
    await oldClient.stop()
    old.close()
  } finally {
    good.close()
  }
})

console.log('')
if (failed > 0) {
  console.log(`❌ quota 套件失败 ${failed} 项`)
  process.exitCode = 1
} else {
  console.log('all quota checks passed')
}
server.close()
