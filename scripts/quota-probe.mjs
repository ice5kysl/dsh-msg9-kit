#!/usr/bin/env node
/**
 * T-23 配额探针：**按请求路径计数**，量「改之前 / 改之后」的 msg9 上行请求。
 *
 * 为什么需要它：msg9 平台按 **IP 200 次/分钟**限流，而这台机器上跑着好几个
 * 消费者（平台 daemon + 我们的插件 + harness CLI）。我们自己在 `lib/index.js`
 * 里制造的重复请求有两条（msg9 PO 从生产访问日志里数出来的）：
 *
 *   GET /api/v1/inbox/messages?folder=all&limit=1   → 3380 次  （per-inbox 未读轮询）
 *   GET /api/v1/resolve/<addr>                      →  591 次  （同一地址反复解析）
 *
 * 本探针把**真实代码路径**跑在一个**会计数的假 msg9 服务器**上，所以数字是
 * 数出来的，不是估的；同一份脚本在改动前后各跑一次即可对照（脚本对"新导出"
 * 用 `??` 兜底，因此旧产物也能跑）。
 *
 * 三个场景（固定工作量，不是墙上时间）：
 *
 *   S1 「进程内 stream 在跑」：先让每个信箱各收 2 个 stream 页（喂未读快照），
 *       再跑 1 小时的徽章对账 = 30 轮 × 28 信箱。
 *       对账轮之间用 `ttlMs: 0` 强制过期 —— 生产上两轮相隔 120s，远超 10s TTL，
 *       所以这就是"缓存已过期"的忠实模型（**不**调用 invalidateUnreadCache：
 *       那代表"本地发生了写操作"，而本场景是纯空闲一小时）。
 *   S2 「daemon 拥有推送通道」：同样 30 轮对账，未读由本地 daemon 快照提供
 *       （`readLocalSnapshots`；旧代码不认识这个字段，于是退回 REST 轮询）。
 *   S3 「/resolve 热路径」：22 次同一地址 + 8 个不同地址（面板/Agent 的真实形态）。
 *
 * T-54 追加三个场景（**只在自研 daemon / 进程内 watcher 的投递路径上**，与上面三个
 * 徽章场景互不干扰）：`onlyUnprocessed`（v1.20 的权威对账）到底花掉多少次 API：
 *
 *   S4 「daemon 批次对账，大积压」：真实 `createEngine` 跑一批投递，服务端
 *       `folder=unprocessed` 有 250 封（3 页）。改前 = 每批翻到最后一页（3 次），
 *       改后 = 本批 id 已在第一页就早停（1 次）。
 *   S5 「没有活会话的一批」：真实 `deliverBatch`（进程内 watcher 的最内层），
 *       `resolveAgent` 返回 undefined ⇒ 本批谁都唤不醒。改前 = 每批照样对账（1 次），
 *       改后 = 0 次。
 *   S6 「有活会话的一批」：同一路径、每批 5 封 —— 证明对账是**每批 1 次**，
 *       不随批次内的封数放大（这条改前改后应当相同，是"必要性"的对照）。
 *
 * 用法：node scripts/quota-probe.mjs [--json <out.json>] [--label 改前|改后]
 */

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
// 绝不碰真实 ~/.dsh：state/凭据都指向临时目录（探针只调用 api.*，不读状态文件）
const scratch = mkdtempSync(join(tmpdir(), 'dsh-msg9-quota-probe-'))
process.env.MSG9_STATE_FILE = join(scratch, 'state.json')
process.env.MSG9_HOME = join(scratch, 'msg9-home')

const args = process.argv.slice(2)
const labelIndex = args.indexOf('--label')
const label = labelIndex >= 0 ? args[labelIndex + 1] : 'unlabeled'
const jsonIndex = args.indexOf('--json')
const jsonOut = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined

const INBOXES = Number(process.env.PROBE_INBOXES ?? 28)
/** 1 小时的徽章对账：生产 120s 一跳 ⇒ 30 轮。 */
const RECONCILE_PASSES = 30
const HOT_ADDRESS = 'iceskysl@msg9.io'
const HOT_LOOKUPS = 22
const COLD_LOOKUPS = 8

// --------------------------------------------------------------- 计数假服务器

/** path 分组：只保留语义上不同的查询维度（folder/limit/since）。 */
function bucketOf(req, url) {
  const params = ['folder', 'limit', 'since'].filter((k) => url.searchParams.has(k))
  const q = params.length > 0
    ? `?${params.map((k) => (k === 'since' ? 'since=<cursor>' : `${k}=${url.searchParams.get(k)}`)).join('&')}`
    : ''
  return `${req.method} ${url.pathname}${q}`
}

const counts = new Map()
const bump = (bucket) => counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
const resetCounts = () => counts.clear()
const table = () => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
const countsFor = (prefix) => table().reduce((sum, [bucket, n]) => (bucket.startsWith(prefix) ? sum + n : sum), 0)

const envelope = (data) => JSON.stringify({ code: 0, message: 'ok', data })

/**
 * S4/S5/S6 的可编程投递页（S1–S3 一字不用，保持原口径）。
 *   · bootstrap：无 `since` 的 `folder=all` 页（首观测留基线用）；
 *   · since：带游标的那一页（新到的信从这里来）；
 *   · unprocessedRows：`folder=unprocessed` 的全量行，按 offset/limit 切片
 *     —— 与真服务端同形（`created_at DESC`，本批的信在最前）。
 */
const delivery = {
  bootstrap: null,
  since: null,
  unprocessedRows: [],
}

function send(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(envelope(data))
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake')
  bump(bucketOf(req, url))

  // 未读轮询 / 列表：unread_count 与 total 是 REST 的同名字段
  if (req.method === 'GET' && url.pathname === '/api/v1/inbox/messages') {
    const folder = url.searchParams.get('folder')
    if (folder === 'unprocessed') {
      const offset = Number(url.searchParams.get('offset') ?? 0) || 0
      const limit = Number(url.searchParams.get('limit') ?? 100) || 100
      const rows = delivery.unprocessedRows.slice(offset, offset + limit)
      // unread_count 是地址级的（与查询无关）；total = 该 folder 的命中数
      return send(res, { messages: rows, total: delivery.unprocessedRows.length, unread_count: rows.length })
    }
    if (url.searchParams.has('since') && delivery.since) return send(res, delivery.since)
    if (!url.searchParams.has('since') && !url.searchParams.has('offset') && delivery.bootstrap) return send(res, delivery.bootstrap)
    return send(res, {
      messages: [],
      total: 9,
      unread_count: 3,
      ...(url.searchParams.has('since') ? {} : { next_cursor: 'c-rest' }),
    })
  }

  // 长轮询：v1.41.5 T-74 之后 Total 与 REST 同义，且每条返回路径都带 unread_count
  if (req.method === 'GET' && url.pathname === '/api/v1/inbox/stream') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(envelope({ messages: [], total: 9, unread_count: 3, next_cursor: 'c-stream' }))
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/v1/resolve/')) {
    const address = decodeURIComponent(url.pathname.slice('/api/v1/resolve/'.length))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(envelope({ address, exists: true, inbox_url: 'http://fake/inbox', public_key: 'pk' }))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 40400, message: 'not found' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`

// --------------------------------------------------------------- 被测代码路径

const mod = await import('../lib/index.js')
const { computeUnread, defaultBridgeDeps, streamInboxLoop, createWatchRuntime } = mod
// 新导出：旧产物没有 ⇒ 兜底成 no-op，同一份脚本两边都能跑
const noteInboxSnapshot = mod.noteInboxSnapshot ?? (() => {})
const resetInboxSnapshots = mod.resetInboxSnapshots ?? (() => {})

const SIGNAL = new AbortController().signal
const keys = Array.from({ length: INBOXES }, (_, i) => `ws-${String(i).padStart(2, '0')}`)

/** defaultBridgeDeps 要一个 cordis Context；探针只用它的 api.*，给个最小壳。 */
const fakeCtx = { logger: () => ({ info() {}, warn() {}, error() {} }) }
const realApi = defaultBridgeDeps(fakeCtx).api

function stateWith(cursor) {
  const workspaces = {}
  for (const key of keys) {
    workspaces[key] = {
      address: `${key}@msg9.io`,
      api_key: `sk-${key}`,
      api_url: apiUrl,
      title: key,
      path: `/w/${key}`,
      ...(cursor ? { watch_cursor: cursor } : {}),
    }
  }
  return { workspaces }
}

/** computeUnread 的最小 deps：真 api.listInbox 打到计数假服务器。 */
function unreadDeps(extra = {}) {
  const state = stateWith()
  return {
    loadState: async () => state,
    resolveCredentials: async (key) => state.workspaces[key],
    api: { listInbox: realApi.listInbox },
    ...extra,
  }
}

/**
 * 进程内 watcher 的推送阶段：每个信箱跑 2 轮 stream 长轮询（真实 streamInboxLoop），
 * 页里带着 unread_count/total —— 改后的代码会把它记成未读快照。
 */
async function runStreamPhase(iterations = 2) {
  const rt = createWatchRuntime()
  const state = stateWith('c-seed')
  const base = {
    loadState: async () => state,
    setWatchState: async () => {},
    listInbox: async () => ({ messages: [], total: 9, unread_count: 3 }),
    resolveAgent: () => undefined,
    onEvent: () => {},
    onInboxSnapshot: (key, snapshot) => noteInboxSnapshot(key, snapshot),
    uuid: () => `id-${Math.random()}`,
    now: () => Date.now(),
    log: () => {},
    sleep: async () => {},
    // 真的打 HTTP，好让假服务器数到它（而不是本地假造一个计数）
    streamInbox: async (url, apiKey, _query, signal) => {
      const response = await fetch(`${url}/api/v1/inbox/stream?wait=1`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      })
      return (await response.json()).data
    },
  }
  await Promise.all(keys.map(async (key) => {
    const controller = new AbortController()
    let calls = 0
    const deps = {
      ...base,
      streamInbox: async (...callArgs) => {
        const page = await base.streamInbox(...callArgs)
        calls += 1
        if (calls >= iterations) controller.abort()
        return page
      },
    }
    await streamInboxLoop(deps, rt, key, controller.signal)
  }))
}

async function reconcileHour(extraDeps) {
  for (let pass = 0; pass < RECONCILE_PASSES; pass += 1) {
    await computeUnread(unreadDeps(extraDeps), SIGNAL, { ttlMs: 0 })
  }
  return {
    requests: Object.fromEntries(table()),
    unreadPollRequests: countsFor('GET /api/v1/inbox/messages?folder=all&limit=1'),
  }
}

// --------------------------------------------------------------------- 场景

const report = { label, inboxes: INBOXES, reconcilePasses: RECONCILE_PASSES, scenarios: {} }

// S1：进程内 stream 在跑 + 1 小时对账（未读快照由 stream 页喂）
resetInboxSnapshots()
resetCounts()
await runStreamPhase(2)
const pushPhase = Object.fromEntries(table())
resetCounts()
const s1 = await reconcileHour()
report.scenarios.S1_in_process_stream = {
  pushPhaseRequests: pushPhase,
  reconcilePhaseRequests: s1.requests,
  unreadPollRequests: s1.unreadPollRequests,
  streamRequests: countsFor('GET /api/v1/inbox/stream'),
}

// S2：daemon 拥有推送通道 —— 未读由本地快照提供（旧代码不认识 ⇒ 退回 REST 轮询）
resetInboxSnapshots()
const snapshotRow = Object.fromEntries(keys.map((key) => [key, { unread: 3, total: 9, at: Date.now() }]))
resetCounts()
const s2 = await reconcileHour({ readLocalSnapshots: async () => snapshotRow })
report.scenarios.S2_daemon_snapshot = {
  reconcilePhaseRequests: s2.requests,
  unreadPollRequests: s2.unreadPollRequests,
}

// S3：/resolve 热路径
resetCounts()
for (let i = 0; i < HOT_LOOKUPS; i += 1) await realApi.resolveAddress(apiUrl, HOT_ADDRESS)
for (let i = 0; i < COLD_LOOKUPS; i += 1) await realApi.resolveAddress(apiUrl, `peer-${i}@msg9.io`)
report.scenarios.S3_resolve_hot_path = {
  lookups: HOT_LOOKUPS + COLD_LOOKUPS,
  requests: Object.fromEntries(table()),
  resolveRequests: countsFor('GET /api/v1/resolve/'),
}

// S7（T-54 ②）：`ingest: 'ledger'`（**计划中的默认**）下没有任何快照来源 ——
// 自研 daemon 与进程内 watcher 都不启动（planIngest 的单一唤醒来源约束），账本
// 消费者只为"有事件/需补齐"的信箱取那一页 unprocessed ⇒ **安静的信箱没有快照**
// ⇒ 徽章对账（120s 一跳）对每个信箱各退一次 REST 直查 = 28 × 30 = 840 次/小时。
// 这正是 `T-23` 砍掉的 840 以另一种形态回来，也是"平台侧帧自带未读数"能省掉的那一层。
resetInboxSnapshots()
resetCounts()
const s7 = await reconcileHour()
report.scenarios.S7_ledger_mode_without_snapshot_source = {
  reconcilePhaseRequests: s7.requests,
  unreadPollRequests: s7.unreadPollRequests,
}

// ------------------------------------------- S4/S5/S6：投递路径的 v1.20 对账口径

const { createEngine, createRegistry, defaultEngineConfig, openDaemonStore, deliverBatch, DAEMON_PROTOCOL } = mod

const UNPROCESSED_BUCKET = 'GET /api/v1/inbox/messages?folder=unprocessed'
const mailRow = (id) => ({
  message_id: id,
  from_address: 'peer@msg9.io',
  subject: `s-${id}`,
  body: { text: `body ${id}` },
  created_at: new Date(Date.UTC(2026, 9, 7, 0, 0, 0)).toISOString(),
})

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`[probe] timed out waiting for ${what}`)
}

/**
 * S4：真实 `createEngine`（自研 daemon 的核心）跑一批投递，服务端未处理积压 250 封。
 * 只数 `folder=unprocessed` 那一条路径 —— 这就是 v1.20 权威对账的全部配额。
 */
const BACKLOG = Number(process.env.PROBE_BACKLOG ?? 250)

async function runDaemonReconcile() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-msg9-probe-daemon-'))
  const store = await openDaemonStore(home)
  const registry = createRegistry()
  const delivered = []
  const ws = {
    sent: [],
    lastFrameAt: Date.now(),
    isClosed: false,
    ontext: undefined,
    onerror: undefined,
    onclose: undefined,
    sendText(data) { this.sent.push(data) },
    close() { this.onclose?.(1000, '') },
    destroy() { this.onclose?.(1006, 'probe') },
  }
  const engine = createEngine({
    store,
    registry,
    config: {
      ...defaultEngineConfig(),
      batchWindowMs: 20,
      batchMaxWaitMs: 200,
      // 场景只关心"一批投递"，其余定时器全部推远（安全网/看门狗/重扫不掺进来）
      reconcileMs: 3_600_000,
      safetyNetMs: 3_600_000,
      pendingSweepMs: 3_600_000,
      wsWatchdogMs: 3_600_000,
    },
    log: () => {},
    uuid: (() => { let n = 0; return () => `probe-uuid-${(n += 1)}` })(),
    now: () => Date.now(),
    // 真的打 HTTP（假服务器会计数），不是本地造一个数字
    listInbox: (url, apiKey, query) => realApi.listInbox(url, apiKey, query),
    issueWsTicket: async () => ({ ticket: 'probe-ticket' }),
    wsConnect: async () => ws,
    deliverPost: async (_target, body) => { delivered.push(body) },
    sleep: async () => {},
    enumerate: async () => [{ project_key: 'pk-probe', address: 'probe@msg9.io', api_key: 'sk-probe', api_url: apiUrl }],
  })
  await engine.start()
  registry.upsert({
    instance_id: 'probe-inst', pid: process.pid, dsh_home: '/tmp', port: 4321,
    deliver_token: 'probe-token', protocol: DAEMON_PROTOCOL,
    workspaces: [{ project_key: 'pk-probe', key: 'ws-probe', title: 'probe', path: '/probe' }],
  }, Date.now())
  await waitFor(() => store.get().inboxes['pk-probe']?.watch_cursor === 'C1', 'daemon bootstrap baseline')
  resetCounts()
  ws.ontext(JSON.stringify({ type: 'new_message', message: { message_id: 'm-1' } }))
  await waitFor(() => delivered.length === 1, 'daemon batch delivery')
  const result = {
    batches: 1,
    mailsPerBatch: 2,
    backlog: delivery.unprocessedRows.length,
    delivered: delivered.length,
    requests: Object.fromEntries(table()),
    unprocessedRequests: countsFor(UNPROCESSED_BUCKET),
  }
  await engine.stop()
  return result
}

// 服务端未处理积压：本批的两封在**第一页最前**（真服务端 `created_at DESC` 就是
// 这个形状），后面 248 封是历史积压 ⇒ 改前每批要翻到最后一页才能确认。
delivery.bootstrap = { messages: [mailRow('seed')], total: 9, unread_count: 3, next_cursor: 'C1', has_more: false }
delivery.since = { messages: [mailRow('m-1'), mailRow('m-2')], total: 9, unread_count: 3, next_cursor: 'C2', has_more: false }
delivery.unprocessedRows = [
  mailRow('m-2'), mailRow('m-1'),
  ...Array.from({ length: Math.max(0, BACKLOG - 2) }, (_, i) => mailRow(`old-${i}`)),
]
report.scenarios.S4_daemon_batch_reconcile = await runDaemonReconcile()

/**
 * S5/S6：进程内 watcher 的最内层 `deliverBatch`（self 路径真实代码）。
 * S5 = 没有活会话（`resolveAgent` 返回 undefined）：本批谁都唤不醒；
 * S6 = 有活会话，每批 5 封：证明对账是"每批一次"，与封数无关。
 */
async function runWatcherBatches({ batches, mailsPerBatch, agent }) {
  const rt = createWatchRuntime()
  const inbox = { address: 'ws-00@msg9.io', api_key: 'sk-ws-00', api_url: apiUrl }
  const messages = Array.from({ length: mailsPerBatch }, (_, i) => mailRow(`w-${i}`))
  const deps = {
    loadState: async () => stateWith(),
    setWatchState: async () => {},
    listInbox: (url, apiKey, query) => realApi.listInbox(url, apiKey, query),
    resolveAgent: () => agent,
    uuid: (() => { let n = 0; return () => `probe-notice-${(n += 1)}` })(),
    now: () => Date.now(),
    log: () => {},
  }
  resetCounts()
  for (let i = 0; i < batches; i += 1) {
    await deliverBatch(deps, rt, 'ws-00', inbox, messages)
  }
  const delivered = agent ? agent.calls : 0
  return {
    batches,
    mailsPerBatch,
    deliveredNotices: delivered,
    requests: Object.fromEntries(table()),
    unprocessedRequests: countsFor(UNPROCESSED_BUCKET),
    unprocessedRowsOnServer: delivery.unprocessedRows.length,
  }
}

// 对账要能"看到"这批信 ⇒ 未处理页里必须有它们（S5/S6 用同一页）。
delivery.unprocessedRows = [mailRow('w-0'), mailRow('w-1'), mailRow('w-2'), mailRow('w-3'), mailRow('w-4')]

const noSessionAgent = undefined
report.scenarios.S5_watcher_no_live_session = await runWatcherBatches({
  batches: Number(process.env.PROBE_BATCHES ?? 20),
  mailsPerBatch: 5,
  agent: noSessionAgent,
})

const liveAgent = (() => {
  const agent = { id: 'sess-probe', calls: 0, followup() { this.calls += 1 }, inject() { this.calls += 1 } }
  return agent
})()
report.scenarios.S6_watcher_live_session = await runWatcherBatches({
  batches: Number(process.env.PROBE_BATCHES ?? 20),
  mailsPerBatch: 5,
  agent: liveAgent,
})

// ------------------------------------------------------------------ 输出

console.log(`\n=== T-23 配额探针（${label}）· ${INBOXES} 个信箱 · 对账 ${RECONCILE_PASSES} 轮/小时 ===\n`)
for (const [name, data] of Object.entries(report.scenarios)) {
  console.log(`— ${name}`)
  for (const [bucket, n] of Object.entries(data.pushPhaseRequests ?? {})) {
    console.log(`    [push] ${String(n).padStart(6)}  ${bucket}`)
  }
  for (const [bucket, n] of Object.entries(data.reconcilePhaseRequests ?? data.requests ?? {})) {
    console.log(`    [req ] ${String(n).padStart(6)}  ${bucket}`)
  }
  const headline = data.unreadPollRequests ?? data.resolveRequests ?? data.unprocessedRequests
  console.log(`    ⇒ 关键计数 = ${headline}\n`)
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[probe] 写入 ${jsonOut}`)
}

server.close()
