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

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake')
  bump(bucketOf(req, url))

  // 未读轮询 / 列表：unread_count 与 total 是 REST 的同名字段
  if (req.method === 'GET' && url.pathname === '/api/v1/inbox/messages') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(envelope({
      messages: [],
      total: 9,
      unread_count: 3,
      ...(url.searchParams.has('since') ? {} : { next_cursor: 'c-rest' }),
    }))
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
  const headline = data.unreadPollRequests ?? data.resolveRequests
  console.log(`    ⇒ 关键计数 = ${headline}\n`)
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[probe] 写入 ${jsonOut}`)
}

server.close()
