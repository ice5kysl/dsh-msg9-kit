/**
 * Tests for the msg9 watcher daemon and its plugin-side client.
 *
 * No real daemon PROCESS is booted here: createDaemon (the guard-less core)
 * runs in-process against a temp MSG9_DAEMON_HOME, the engine is driven with
 * an in-memory fake WebSocket / deliverPost / issueWsTicket, and the wsclient
 * is exercised against a spec-faithful fake server (node:net + the exported
 * encodeFrame/FrameParser codec). Run: node tests/daemon.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Identity enumeration reads ~/.msg9/projects/dsh — point it at an empty temp
// dir so the in-process daemons below watch nothing.
process.env.MSG9_HOME = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-daemon-msg9home-'))

const {
  BridgeError,
  DAEMON_PROTOCOL,
  DeliverHttpError,
  FrameParser,
  INSTANCE_STALE_MS,
  OPCODES,
  acceptArchivedBatch,
  connectWebSocket,
  createDaemon,
  createDaemonClient,
  createEngine,
  createMsg9Bridge,
  createRegistry,
  defaultEngineConfig,
  deliverDaemonBatch,
  encodeFrame,
  isStalePidFile,
  openDaemonStore,
  readDaemonInfo,
  removeDaemonInfo,
  selectOrphanPending,
  writeDaemonInfo,
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

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'dsh-msg9-kit-daemon-'))
}

/**
 * 确定性等待：条件成立即返回，**到点用可读信息失败**。
 *
 * `what` 可以是字符串，也可以是**函数**（超时才求值）—— 后者用来在失败信息里
 * 带上"当时到底长什么样"（日志、计数器…），否则只能看到一句干巴巴的 timed out。
 */
async function waitFor(fn, timeoutMs = 3000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* not there yet */
    }
    if (Date.now() > deadline) {
      const detail = typeof what === 'function' ? what() : what
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${detail}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * 等一条日志出现。断言的对象是"日志留下了什么"时，就该等**日志本身**。
 *
 * 这正是 T-39 的 flake 根因：原来等的是 `pending.length === 0`，而 state 是在
 * `store.mutate(...)` 里先变空、日志在那次 mutate 的 await **之后**才写 ——
 * 两者之间就是一个抢跑窗口（实测 6 跑 2 败）。
 */
async function waitForLog(logs, pattern, what, timeoutMs = 3000) {
  return waitFor(
    () => logs.find((entry) => pattern.test(entry)),
    timeoutMs,
    // 函数：超时才求值，于是失败信息里是**当时**的日志，而不是调用时的空数组。
    () => `等日志 ${pattern}：${what}。当前日志：${JSON.stringify(logs)}`,
  )
}

/**
 * 等 daemon 真的跑够 `n` 轮**孤儿 pending 扫描**。
 *
 * 为什么负向断言必须用它：`sweepOrphanPending()` 每轮第一件事就是
 * `deps.registry.list()`（engine.ts 的启动门槛），所以给注册表包一层测试侧
 * 计数器，就能把"扫描跑了几轮"变成**可观测事实**。原来的 `sleep(200)` 是在猜：
 * 机器一忙、一轮都没跑到，负向断言就会"因为什么都没发生"而通过（假绿）。
 *
 * 计数器只在测试里，生产路径一行没动。
 */
async function waitForSweeps(counts, n, timeoutMs = 3000) {
  return waitFor(
    () => counts.listCalls >= n,
    timeoutMs,
    () => `只跑了 ${counts.listCalls}/${n} 轮孤儿扫描（reconcileMs 见 orphanCase）`,
  )
}

/** 注册表包装：只做**计数**，其余行为原样透传（生产代码不感知）。 */
function countRegistryLists(inner, counts) {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'list') {
        return () => {
          counts.listCalls += 1
          return target.list()
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function mail(id, extra = {}) {
  return {
    message_id: id,
    from_address: 'peer@msg9.io',
    subject: `s-${id}`,
    body: { text: `body ${id}` },
    created_at: '2026-09-29T00:00:00.000Z',
    ...extra,
  }
}

console.log('dsh-msg9-kit daemon test:')

// ------------------------------------------------------------------- state

await check('state: daemon.json roundtrip + pid-guarded removal', async () => {
  const home = await tempHome()
  const info = { pid: process.pid, port: 12345, token: 'tok', started_at: '2026-09-29T00:00:00Z', version: '0.0.0', protocol: DAEMON_PROTOCOL }
  await writeDaemonInfo(info, home)
  assert.deepEqual(await readDaemonInfo(home), info)

  await removeDaemonInfo(process.pid + 100000, home) // not ours → kept
  assert.ok(await readDaemonInfo(home), 'another pid must not remove daemon.json')
  await removeDaemonInfo(process.pid, home)
  assert.equal(await readDaemonInfo(home), undefined)
})

await check('state: stale pid detection (missing file, dead pid, live pid)', async () => {
  const home = await tempHome()
  const lock = join(home, 'daemon.start.lock')
  assert.equal(await isStalePidFile(lock), true, 'a missing lock is stale')

  await writeFile(lock, JSON.stringify({ pid: 99999999, at: new Date().toISOString() }))
  assert.equal(await isStalePidFile(lock), true, 'a dead pid is stale')

  await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  assert.equal(await isStalePidFile(lock), false, 'this live process is not stale')
})

await check('state: cursors and the pending queue survive a store reopen', async () => {
  const home = await tempHome()
  const store = await openDaemonStore(home)
  await store.mutate((state) => {
    state.inboxes['pk-1'] = { address: 'a@msg9.io', api_url: 'http://fake', watch_cursor: 'C7' }
    state.pending.push({
      id: 'p1', project_key: 'pk-1', messages: [mail('m1')], mode: 'followup',
      downgraded: false, enqueued_at: '2026-09-29T00:00:00Z', attempts: 0, next_retry_at: 0,
    })
  })
  const raw = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))
  assert.equal(raw.inboxes['pk-1'].watch_cursor, 'C7')
  assert.equal(raw.pending.length, 1)

  const reopened = await openDaemonStore(home)
  assert.equal(reopened.get().inboxes['pk-1'].watch_cursor, 'C7')
  assert.equal(reopened.get().pending[0].id, 'p1')
})

// ---------------------------------------------------------------- registry

await check('registry: upsert / touch / forProjectKey (last_seen wins) / remove', async () => {
  const registry = createRegistry()
  const row = { project_key: 'pk-1', key: 'ws-a', title: 'a', path: '/a' }
  registry.upsert({ instance_id: 'i1', pid: 1, dsh_home: '/h1', port: 100, deliver_token: 't1', protocol: 1, workspaces: [row] }, 1000)
  registry.upsert({ instance_id: 'i2', pid: 2, dsh_home: '/h2', port: 200, deliver_token: 't2', protocol: 1, workspaces: [row] }, 2000)

  assert.equal(registry.forProjectKey('pk-1').instance_id, 'i2', 'the most recent registration claims the key')
  assert.equal(registry.forProjectKey('nope'), undefined)

  assert.equal(registry.touch('i1', { port: 101 }, 3000), true)
  assert.equal(registry.get('i1').port, 101)
  assert.equal(registry.touch('ghost', {}, 3000), false)

  registry.remove('i2')
  assert.equal(registry.forProjectKey('pk-1').instance_id, 'i1', 'i1 takes over once i2 is gone')
})

// ------------------------------------------------------------------ engine

/** In-memory fake WsConnection; the engine assigns ontext/onclose/onerror. */
function fakeWs() {
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
  return ws
}

/**
 * Engine harness: one inbox (pk-1), a fake WS, and scripted listInbox pages.
 * `pages.since` is keyed by the cursor the engine passes; `pages.unprocessed`
 * answers the pre-delivery reconcile.
 */
async function makeEngine({ sincePages = {}, bootstrapPage, unprocessed = [], deliver, extraConfig = {}, wsConnect, logs } = {}) {
  const home = await tempHome()
  const store = await openDaemonStore(home)
  // 测试侧计数器：每轮孤儿扫描都会 `registry.list()` 一次（engine.ts 的启动门槛）
  // ⇒ 负向断言可以用 waitForSweeps(registryCounts, n) 证明"扫描真的跑过 n 轮"，
  // 而不是 `sleep(200)` 猜一把。注册表行为原样透传（生产代码不感知）。
  const registryCounts = { listCalls: 0 }
  const registry = countRegistryLists(createRegistry(), registryCounts)
  const ws = fakeWs()
  const delivered = []
  const listCalls = []
  const engine = createEngine({
    store,
    registry,
    config: {
      ...defaultEngineConfig(),
      batchWindowMs: 40,
      batchMaxWaitMs: 500,
      reconcileMs: 600_000,
      safetyNetMs: 600_000,
      pendingSweepMs: 600_000,
      wsWatchdogMs: 600_000,
      ...extraConfig,
    },
    log: (message) => { logs?.push(message) },
    uuid: (() => { let n = 0; return () => `uuid-${(n += 1)}` })(),
    now: () => Date.now(),
    listInbox: async (_url, _key, query) => {
      listCalls.push(query)
      if (query.folder === 'unprocessed') return { messages: unprocessed() }
      if (!query.since) return bootstrapPage
      const page = sincePages[query.since]
      if (!page) throw new Error(`unexpected since=${query.since}`)
      return typeof page === 'function' ? page() : page
    },
    issueWsTicket: async () => ({ ticket: 'ticket-1' }),
    wsConnect: wsConnect ?? (async () => ws),
    deliverPost: deliver ?? (async (target, body) => { delivered.push({ target, body }) }),
    sleep,
    enumerate: async () => [{ project_key: 'pk-1', address: 'a@msg9.io', api_key: 'k', api_url: 'http://fake' }],
  })
  const instance = {
    instance_id: 'inst-1', pid: 4242, dsh_home: '/h', port: 4321,
    deliver_token: 'tok-1', protocol: DAEMON_PROTOCOL,
    workspaces: [{ project_key: 'pk-1', key: 'ws-a', title: 'a', path: '/a' }],
  }
  return { engine, store, registry, registryCounts, ws, delivered, listCalls, instance, home }
}

await check('engine: new_message → ack → since fetch → coalesced delivery → cursor advance', async () => {
  const { engine, store, registry, ws, delivered, instance } = await makeEngine({
    bootstrapPage: { messages: [mail('m0')], next_cursor: 'C1', has_more: false },
    sincePages: { C1: { messages: [mail('m2')], next_cursor: 'C2', has_more: false } },
    unprocessed: () => [mail('m2')],
  })
  try {
    await engine.start()
    registry.upsert(instance, Date.now())
    // Boot: baseline only — the first observation announces nothing.
    await waitFor(() => ws.ontext && store.get().inboxes['pk-1']?.watch_cursor === 'C1')
    assert.equal(delivered.length, 0)

    ws.ontext(JSON.stringify({ type: 'new_message', message: { message_id: 'm2' } }))
    // The delivery ack (cursor advance + batch removal) lands a few disk
    // writes after deliverPost resolves — wait for the settled state, not the
    // bare delivery.
    await waitFor(() => delivered.length === 1 && !store.get().inboxes['pk-1']?.batch)

    const acks = ws.sent.map((data) => JSON.parse(data)).filter((event) => event.type === 'ack')
    assert.deepEqual(acks, [{ type: 'ack', message_id: 'm2' }], 'the WS push was acked')
    assert.equal(delivered[0].target.port, 4321)
    assert.equal(delivered[0].target.deliver_token, 'tok-1')
    assert.equal(delivered[0].body.project_key, 'pk-1')
    assert.equal(delivered[0].body.inbox, 'a@msg9.io')
    assert.equal(delivered[0].body.mode, 'followup')
    assert.equal(delivered[0].body.downgraded, undefined)
    assert.deepEqual(delivered[0].body.messages.map((message) => message.message_id), ['m2'])
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C2', 'cursor advanced only after the delivery ack')
    assert.equal(store.get().inboxes['pk-1'].batch, undefined, 'the batch is gone after a successful flush')
    assert.equal(store.get().pending.length, 0)
  } finally {
    await engine.stop()
  }
})

await check('engine: 409 (no live session) → pending → redelivered on register, then cursor advances', async () => {
  let calls = 0
  const delivered = []
  const { engine, store, registry, ws, instance } = await makeEngine({
    bootstrapPage: { messages: [mail('m0')], next_cursor: 'C1', has_more: false },
    sincePages: { C1: { messages: [mail('m2')], next_cursor: 'C2', has_more: false } },
    unprocessed: () => [mail('m2')],
    deliver: async (target, body) => {
      calls += 1
      if (calls === 1) throw new DeliverHttpError('instance reports no live session', 409, true)
      delivered.push({ target, body })
    },
  })
  try {
    await engine.start()
    registry.upsert(instance, Date.now())
    await waitFor(() => ws.ontext && store.get().inboxes['pk-1']?.watch_cursor === 'C1')

    ws.ontext(JSON.stringify({ type: 'new_message', message: { message_id: 'm2' } }))
    await waitFor(() => store.get().pending.length === 1)
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C1', 'a 409 never advances the cursor')
    assert.equal(store.get().pending[0].messages[0].message_id, 'm2')

    // The instance coming (back) online triggers the redelivery; the pending
    // removal + cursor commit land after deliverPost resolves.
    engine.replayPending()
    await waitFor(() => delivered.length === 1 && store.get().pending.length === 0)
    assert.equal(delivered[0].body.messages[0].message_id, 'm2')
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C2', 'the cursor catches up once the batch is acked')
  } finally {
    await engine.stop()
  }
})

await check('engine: notify_paused tracks silently (cursor advances, nothing delivered)', async () => {
  const logs = []
  const { engine, store, registry, ws, delivered, instance } = await makeEngine({
    bootstrapPage: { messages: [mail('m0')], next_cursor: 'C1', has_more: false },
    sincePages: { C1: { messages: [mail('m2')], next_cursor: 'C2', has_more: false } },
    unprocessed: () => [mail('m2')],
    logs,
  })
  try {
    await engine.start()
    registry.upsert(instance, Date.now())
    await waitFor(() => ws.ontext && store.get().inboxes['pk-1']?.watch_cursor === 'C1')
    await store.mutate((state) => {
      state.notify_paused = true
    })

    ws.ontext(JSON.stringify({ type: 'new_message', message: { message_id: 'm2' } }))
    // T-39：先等**这条路真的走完**（静音分支自己会留一行日志），再断言"什么都没投"。
    // 光靠 sleep 是在猜"取信那一步已经发生"，机器一慢断言就变成假绿。
    await waitForLog(logs, /notify paused .*tracked silently/, '静音分支必须跑完（游标已推进）')
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C2', '静音不影响跟踪：游标照常推进')
    assert.equal(delivered.length, 0)
    assert.equal(store.get().inboxes['pk-1'].batch, undefined)
    assert.equal(store.get().pending.length, 0)

    // 再等过 40ms 批次窗口：万一这条路径真的入队了，窗口内必然 flush（belt）。
    await sleep(150)
    assert.equal(delivered.length, 0, '静音期间一个批次都不许投出去')
    assert.equal(store.get().inboxes['pk-1'].batch, undefined)
  } finally {
    await engine.stop()
  }
})

// --------------------------------------------------- orphan pending (T-22)

/**
 * 注入真实事故的 state 形状：一个 project key 的批次压了很久投不出去。
 * `ageHours` = 批次年龄；`cursor` = 批次覆盖到的游标（归档时必须跨过去）。
 */
async function seedOrphanPending(store, { ageHours, cursor = 'C2' }) {
  await store.mutate((state) => {
    state.inboxes['pk-1'] = {
      address: 'a@msg9.io',
      api_url: 'http://fake',
      watch_cursor: 'C1',
      fetch_cursor: cursor,
      cursor_seq: 2,
      acked_seq: 1,
    }
    state.pending.push({
      id: 'orphan-1',
      project_key: 'pk-1',
      instance_id: 'inst-dead',
      messages: [mail('m2')],
      next_cursor: cursor,
      cursor_seq: 2,
      mode: 'followup',
      downgraded: false,
      enqueued_at: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
      attempts: 3,
      next_retry_at: 0,
    })
  })
}

function orphanCase({ logs }) {
  return makeEngine({
    bootstrapPage: { messages: [mail('m0')], next_cursor: 'C1', has_more: false },
    sincePages: { C2: { messages: [], next_cursor: 'C2', has_more: false } },
    // T-33 ①：归档扫描**不再**挂在 start() 的首扫上，只由 reconcile 跳驱动 ⇒
    // 测试把这一跳调快（默认 60s）才能观察归档；生产里首扫窗口因此不存在。
    extraConfig: { orphanPendingTtlMs: 24 * 3_600_000, reconcileMs: 120 },
    ...(logs ? { logs } : {}),
  })
}

await check('selectOrphanPending（纯函数）：只有「无 live 注册 + 超阈值」才归档', async () => {
  const now = Date.parse('2026-10-01T00:00:00.000Z')
  const item = (projectKey, enqueuedAt) => ({
    id: `p-${projectKey}-${enqueuedAt}`,
    project_key: projectKey,
    messages: [mail('m1')],
    mode: 'followup',
    downgraded: false,
    enqueued_at: enqueuedAt,
    attempts: 0,
    next_retry_at: 0,
  })
  const old = new Date(now - 25 * 3_600_000).toISOString()
  const young = new Date(now - 1 * 3_600_000).toISOString()
  const pending = [
    item('dead-old', old),
    item('dead-young', young),
    item('live-old', old),
    item('live-young', young),
  ]

  const { archive, keep } = selectOrphanPending(pending, {
    now,
    ttlMs: 24 * 3_600_000,
    isLive: (projectKey) => projectKey.startsWith('live'),
  })
  assert.deepEqual(archive.map((row) => row.project_key), ['dead-old'], '两条必须同时满足才归档')
  assert.deepEqual(keep.map((row) => row.project_key), ['dead-young', 'live-old', 'live-young'])

  // 保守边界：证明不了年龄就不动手；阈值 ≤ 0 = 关闭扫描（不是"全归档"）。
  assert.equal(
    selectOrphanPending([item('dead-old', '不是时间')], { now, ttlMs: 24 * 3_600_000, isLive: () => false }).archive.length,
    0,
    'enqueued_at 不可解析 ⇒ 保留',
  )
  assert.equal(
    selectOrphanPending(pending, { now, ttlMs: 0, isLive: () => false }).archive.length,
    0,
    'ttlMs ≤ 0 ⇒ 整个扫描关闭',
  )

  // 归档跨游标用的是与 ack 同一条单调规则：陈旧批次不许把游标拉回去。
  const inbox = { address: 'a@msg9.io', api_url: 'http://fake', watch_cursor: 'C5', fetch_cursor: 'C5', cursor_seq: 5, acked_seq: 5 }
  acceptArchivedBatch(inbox, { ...item('pk-x', old), next_cursor: 'C2', cursor_seq: 2 })
  assert.equal(inbox.watch_cursor, 'C5', '陈旧的归档批次不得回退游标')
  assert.equal(inbox.acked_seq, 5)

  const forward = { address: 'a@msg9.io', api_url: 'http://fake', watch_cursor: 'C1', fetch_cursor: 'C2', cursor_seq: 2, acked_seq: 1 }
  acceptArchivedBatch(forward, { ...item('pk-y', old), next_cursor: 'C2', cursor_seq: 2, messages: [mail('m2')] })
  assert.equal(forward.watch_cursor, 'C2', '归档必须把游标推到批次覆盖的位置')
  assert.equal(forward.acked_seq, 2)
  assert.deepEqual(forward.delivered_ids, ['m2'])
})

await check('orphan pending: 假死 key 的批次超阈值 ⇒ 归档 + 该地址游标能推进（唤醒不再哑）', async () => {
  const logs = []
  const { engine, store, registry, delivered, instance } = await orphanCase({ logs })
  await seedOrphanPending(store, { ageHours: 30 })
  // 注册过，但实例早已过期（心跳停了）—— 真实事故里的"死 key"。
  registry.upsert(instance, Date.now() - INSTANCE_STALE_MS - 60_000)
  try {
    // 归档现在发生在 reconcile 跳（orphanCase 里 120ms 一跳），不再是 start() 首扫。
    await engine.start()
    // ⚠️ T-39：**等日志本身**，不要等 `pending.length === 0`。
    // state 是在 `store.mutate(...)` 里先变空、日志在那次 mutate 的 await 之后才写
    // —— 中间正好是一个抢跑窗口（实测 6 跑 2 败，失败信息就是"日志里没有归档行"）。
    const line = await waitForLog(logs, /archived 1 orphan mail\(s\)/, '归档必须留下日志')
    // 归档的状态后果（游标跨过去）同样要有界等待，而不是假设"日志有了状态就一定有"。
    await waitFor(() => store.get().pending.length === 0, 3000, '归档后 pending 必须清空')
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C2', '归档后游标必须能越过钉住它的批次')
    assert.equal(store.get().inboxes['pk-1'].acked_seq, 2)
    assert.equal(delivered.length, 0, '死实例不该被投递')

    assert.match(line, /a@msg9\.io \(pk-1\)/, '日志要说清归档的是谁')
    assert.match(line, /no live instance for 30(\.\d+)?h \(> 24h reconnect budget\)/, '日志要说清为什么')
    assert.match(line, /batches \[orphan-1\]/, '日志必须带上批次 id（T-33 ②：事后追查归档了哪些批次）')
    assert.match(line, /mails \[m2\]/, '日志必须带上邮件 id 列表（否则只能拿服务器 inbox 反查）')
    assert.match(line, /cursor advanced to C2/)
  } finally {
    await engine.stop()
  }
})

await check('orphan pending ①：注册表构造性为空时绝不归档（daemon 重启窗口，实例随后注册也不得误伤）', async () => {
  // T-33 ① 的真实形态：daemon 重启后注册表是**内存**的、构造性为空（main.ts：
  // startControlServer → engine.start → 最后才写 daemon.json），而客户端最快也要
  // 等下一次心跳（45s）才会重新注册。旧实现把归档扫描挂在 start() 首扫上 ——
  // 那一刻 hasLiveRegistration 对一切 key 都是 false，于是一个**活着但没开会话**
  // 的实例（投递连续 409 ⇒ pending 隔夜压过 24h）会被整批归档：那些信从此不再
  // 唤醒任何人（服务器 inbox 里还在，只是本 daemon 的游标跨了过去）。
  const logs = []
  const { engine, store, registry, registryCounts, instance } = await orphanCase({ logs })
  await seedOrphanPending(store, { ageHours: 30 })
  try {
    await engine.start()
    // 注册表仍为空：跑够 3 轮扫描也不得动手 ——
    // "从没被填充过的注册表"不构成"这些 key 都死了"的证据。
    // 用 waitForSweeps 而不是 sleep：负向断言必须建立在"扫描**确实跑过** 3 轮"
    // 这个事实上，否则机器一忙就变成"什么都没发生所以通过"（假绿）。
    await waitForSweeps(registryCounts, 3)
    assert.ok(registryCounts.listCalls >= 3, `扫描必须真的跑过（实际 ${registryCounts.listCalls} 轮）`)
    assert.equal(store.get().pending.length, 1, '空注册表不是证据：>24h 的 pending 绝不能在启动窗口被归档')
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C1', '不得越过未投递的批次')
    assert.equal(logs.filter((entry) => /archived/.test(entry)).length, 0)

    // 实例随后注册（真实节奏：45s 心跳内重注册）⇒ live，同样不得归档。
    const before = registryCounts.listCalls
    registry.upsert(instance, Date.now())
    await waitForSweeps(registryCounts, before + 3)
    assert.equal(store.get().pending.length, 1, 'live 注册出现后，再老的 pending 也必须留给它投递')
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C1')
    assert.equal(logs.filter((entry) => /archived/.test(entry)).length, 0)
  } finally {
    await engine.stop()
  }
})

await check('orphan pending: 活跃实例的 pending 再老也不归档（live 注册是否定条件）', async () => {
  const logs = []
  const { engine, store, registry, registryCounts, instance } = await orphanCase({ logs })
  await seedOrphanPending(store, { ageHours: 30 })
  registry.upsert(instance, Date.now()) // 刚刚心跳过 ⇒ live
  try {
    await engine.start()
    await waitForSweeps(registryCounts, 3)
    assert.equal(store.get().pending.length, 1, '有 live 实例 ⇒ 不得归档')
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C1', '不得越过未投递的批次')
    assert.equal(logs.filter((entry) => /archived/.test(entry)).length, 0)
  } finally {
    await engine.stop()
  }
})

await check('orphan pending: 失活但未超阈值的批次不归档（正常重连窗口，本卡最关键的边界）', async () => {
  const logs = []
  const { engine, store, registry, registryCounts, instance } = await orphanCase({ logs })
  await seedOrphanPending(store, { ageHours: 2 }) // 2h < 24h：还在重连预算里
  registry.upsert(instance, Date.now() - INSTANCE_STALE_MS - 60_000)
  try {
    await engine.start()
    await waitForSweeps(registryCounts, 3)
    assert.equal(store.get().pending.length, 1, '未超阈值 ⇒ 必须留着等实例回来')
    assert.equal(store.get().inboxes['pk-1'].watch_cursor, 'C1', '重连窗口里游标必须原地等')
    assert.equal(logs.filter((entry) => /archived/.test(entry)).length, 0)
  } finally {
    await engine.stop()
  }
})

// ---------------------------------------------------------------- wsclient

await check('engine: close DURING catch-up still reconnects（丢唤醒竞态，外部巡检实测形态）', async () => {
  // 真故障形态：服务端在 catch-up 窗口内关连接（重启/发布）。旧实现把 waiter 挂在
  // catch-up **之后**，于是 releaseWs() 里的 waiter?.() 是空操作，循环永久 await
  // 一个没人 resolve 的 Promise —— 进程活着、/healthz 照旧 200、门铃永久哑掉。
  //
  // 旧测试从未演练这个窗口（fake listInbox 瞬间返回，close 永远落在停驻之后）。
  // 这里让**每一次**取信都慢 200ms（thenable 页面 + 任意游标的 Proxy），把
  // attach → waiter 之间的窗口撑开，再于窗口内关连接。
  let connects = 0
  let wsRef
  const logs = []
  const slow = () => {
    // 注意：thenable 必须 resolve 到一个**另一个**普通对象 —— 拿自己 resolve 会让
    // promise 自解析、永不 settle（我第一次就是这么写坏的，白查了半天）。
    const value = { messages: [], next_cursor: 'C1', has_more: false }
    return { ...value, then(resolve) { setTimeout(() => resolve(value), 200) } }
  }
  const { engine, registry, instance } = await makeEngine({
    bootstrapPage: slow(),
    sincePages: new Proxy({}, { get: () => async () => slow() }),
    extraConfig: { reconnectBaseMs: 20, reconnectMaxMs: 40, wsWatchdogMs: 600_000, safetyNetMs: 600_000 },
    logs,
    wsConnect: async () => {
      connects += 1
      const ws = fakeWs()
      ws.isClosed = false
      wsRef = ws
      if (connects === 1) setTimeout(() => ws.onclose?.(1006, 'server restart'), 40)
      return ws
    },
  })
  try {
    await engine.start()
    registry.upsert(instance, Date.now())
    // ★ 旧实现下 connects 会永久停在 1（waiter 空挂）
    await waitFor(() => connects >= 2, 4000)
    assert.ok(connects >= 2, `catch-up 期间断连必须重连，实际只连了 ${connects} 次`)
    assert.ok(
      logs.some((line) => /ws closed for pk-1/.test(line)),
      '断连必须留下日志（旧实现只有 onerror 记日志，静默失效因此 90 分钟无人知）',
    )
  } finally {
    await engine.stop()
  }
})

await check('engine: a socket that died BEFORE attach is reconciled instead of parked', async () => {
  // wsConnect() 与本引擎挂 handler 之间那一瞬也能死：close 事件早已烧过（当时还没
  // handler），引擎拿不到任何回调 —— 所以必须主动问一次 isClosed。
  let connects = 0
  const logs = []
  const { engine, registry, instance } = await makeEngine({
    bootstrapPage: { messages: [], next_cursor: 'C1', has_more: false },
    sincePages: { C1: { messages: [], next_cursor: 'C1', has_more: false } },
    extraConfig: { reconnectBaseMs: 20, reconnectMaxMs: 40, wsWatchdogMs: 600_000, safetyNetMs: 600_000 },
    logs,
    wsConnect: async () => {
      connects += 1
      const ws = fakeWs()
      ws.isClosed = connects === 1 // 第一条"出生即死"
      return ws
    },
  })
  try {
    await engine.start()
    registry.upsert(instance, Date.now())
    await waitFor(() => connects >= 2, 4000)
    assert.ok(connects >= 2, `出生即死的连接必须被对账并重连，实际只连了 ${connects} 次`)
    assert.ok(logs.some((line) => /already closed before attach/.test(line)), '这条对账要留痕')
  } finally {
    await engine.stop()
  }
})

await check('engine: WS「连着但不发帧」（活进程·死连接）→ 看门狗判死并重连', async () => {
  // 这是真实故障形态：服务端重启后 socket 还"开着"，但再也不推任何东西。
  // 若没有看门狗，进程会**一直活着、一声不响**——信照样进账本（真相源是 inbox），
  // 只是没人被叫醒。这是最难察觉的一类故障：不报错、不丢数据，只是静默失效。
  let connects = 0
  const logs = []
  const { engine, registry, instance, store } = await makeEngine({
    bootstrapPage: { messages: [], next_cursor: 'C1', has_more: false },
    extraConfig: { wsWatchdogMs: 80, reconnectBaseMs: 20, reconnectMaxMs: 40, safetyNetMs: 600_000 },
    logs,
    // 每次连接都返回一个"通但沉默"的 socket（永不发帧 ⇒ lastFrameAt 不再更新）
    wsConnect: async () => { connects += 1; return fakeWs() },
  })
  try {
    await engine.start()
    registry.upsert(instance, Date.now())
    await waitFor(() => store.get().inboxes['pk-1']?.watch_cursor === 'C1')
    assert.equal(connects, 1, '先建立一次连接')
    // ★ 关键断言：没有看门狗的话 connects 会一直停在 1
    await waitFor(() => connects >= 3, 4000)
    assert.ok(connects >= 3, `看门狗应反复判死重连，实际只连了 ${connects} 次`)
    assert.ok(
      logs.some((line) => /silent past the watchdog window/.test(line)),
      '判死必须留下日志（静默失效唯一能被发现的痕迹）',
    )
  } finally {
    await engine.stop()
  }
})

await check('engine: 门铃全程不响，安全网仍把信取回并投递（"门铃停了、信没丢"）', async () => {
  // 与上一条配对：上一条证明"会重连"，这一条证明**即使重连一直不成，信也不会丢** ——
  // 因为真相源是 inbox，安全网每 safetyNetMs 做一次按游标的完整回捞。
  const { engine, registry, instance, ws, delivered, store } = await makeEngine({
    bootstrapPage: { messages: [mail('m0')], next_cursor: 'C1', has_more: false },
    sincePages: { C1: { messages: [mail('m9')], next_cursor: 'C2', has_more: false } },
    unprocessed: () => [mail('m9')],
    extraConfig: { safetyNetMs: 60, wsWatchdogMs: 600_000, batchWindowMs: 20, batchMaxWaitMs: 200 },
  })
  try {
    await engine.start()
    registry.upsert(instance, Date.now())
    await waitFor(() => store.get().inboxes['pk-1']?.watch_cursor === 'C1')
    assert.equal(delivered.length, 0, '基线阶段不播报')
    // ★ 关键：**全程不调用 ws.ontext** —— 模拟"门铃一次都没响"
    assert.equal(ws.ontext !== undefined, true, 'WS 已接上，只是永远不推')
    await waitFor(() => delivered.length === 1, 4000)
    assert.deepEqual(
      delivered[0].body.messages.map((message) => message.message_id),
      ['m9'],
      '安全网按游标回捞到了 WS 从未推送的那封',
    )
  } finally {
    await engine.stop()
  }
})

await check('wsclient: handshake + text roundtrip + ping/pong + close (spec-faithful fake server)', async () => {
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  const acceptKey = (key) => createHash('sha1').update(key + WS_GUID).digest('base64')
  const serverReceived = []
  const sockets = new Set()

  const server = createTcpServer((socket) => {
    sockets.add(socket)
    const parser = new FrameParser()
    let head = Buffer.alloc(0)
    let handshaken = false
    const onFrames = (chunk) => {
      for (const frame of parser.push(chunk)) {
        serverReceived.push(frame)
        if (frame.opcode === OPCODES.TEXT) {
          socket.write(encodeFrame(OPCODES.TEXT, Buffer.from(`echo:${frame.payload.toString('utf8')}`), false))
        } else if (frame.opcode === OPCODES.PING) {
          socket.write(encodeFrame(OPCODES.PONG, frame.payload, false))
        } else if (frame.opcode === OPCODES.CLOSE) {
          socket.write(encodeFrame(OPCODES.CLOSE, frame.payload, false))
        }
      }
    }
    socket.on('data', (chunk) => {
      if (handshaken) return onFrames(chunk)
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      const request = head.subarray(0, end).toString('latin1')
      const key = /sec-websocket-key:\s*(\S+)/i.exec(request)?.[1]
      assert.ok(key, 'the handshake carries a Sec-WebSocket-Key')
      handshaken = true
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        'Sec-WebSocket-Protocol: msg9-l0\r\n' +
        '\r\n',
      )
      const rest = head.subarray(end + 4)
      if (rest.length > 0) onFrames(rest)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const ws = await connectWebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, {
      protocols: ['msg9-l0', 'ticket-1'],
      timeoutMs: 3000,
    })
    assert.equal(ws.protocol, 'msg9-l0', 'the negotiated subprotocol is reported')

    const texts = []
    ws.ontext = (data) => texts.push(data)
    const closed = new Promise((resolve) => {
      ws.onclose = (code, reason) => resolve({ code, reason })
    })

    ws.sendText('hello')
    await waitFor(() => texts.includes('echo:hello'))
    const helloFrame = serverReceived.find((frame) => frame.opcode === OPCODES.TEXT)
    assert.equal(helloFrame.payload.toString('utf8'), 'hello', 'the client frame was masked and decoded')

    // Server-initiated ping: the client must answer with a pong on its own.
    for (const socket of sockets) socket.write(encodeFrame(OPCODES.PING, Buffer.from('hb'), false))
    await waitFor(() => serverReceived.some((frame) => frame.opcode === OPCODES.PONG && frame.payload.toString('utf8') === 'hb'))

    ws.close(1000, 'bye')
    const { code } = await closed
    assert.equal(code, 1000, 'the close handshake completed')
    ws.destroy()
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

// ------------------------------------------------------- /dsh-msg9/deliver

await check('deliver endpoint: token auth (401), no live session (409), bad body (400), happy path (200)', async () => {
  const handled = []
  const bridge = createMsg9Bridge({
    api: {},
    loadState: async () => ({ workspaces: {} }),
    stateFilePath: () => '/tmp/unused-state.json',
    defaultApiUrl: () => 'http://fake',
    ensureInbox: async () => { throw new Error('unused in this test') },
    listWorkspaces: () => [],
    matchWorkspaceByPath: () => undefined,
    log: () => {},
    deliver: {
      token: () => 'tok-1',
      handle: async (body) => {
        handled.push(body)
        if (body.project_key === 'no-session') throw new BridgeError(409, 'no-live-session', 'no live session')
        return { delivered: body.messages.length, mode: body.mode }
      },
    },
  })
  const server = createHttpServer((req, res) => void bridge.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/dsh-msg9/deliver`

  const post = (body, token) => fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-msg9-daemon-token': token } : {}) },
    body: JSON.stringify(body),
  })
  const validBody = { inbox: 'a@msg9.io', project_key: 'pk-1', messages: [mail('m1')], mode: 'followup' }

  try {
    assert.equal((await post(validBody)).status, 401, 'no token → 401')
    assert.equal((await post(validBody, 'wrong')).status, 401, 'wrong token → 401')
    assert.equal((await post({ project_key: 'pk-1', messages: [] }, 'tok-1')).status, 400, 'missing mode → 400')
    assert.equal((await post({ ...validBody, project_key: 'no-session' }, 'tok-1')).status, 409, 'no live session → 409')

    const response = await post({ ...validBody, mode: 'inject', downgraded: true }, 'tok-1')
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.data, { delivered: 1, mode: 'inject' })
    const last = handled[handled.length - 1]
    assert.equal(last.mode, 'inject')
    assert.equal(last.downgraded, true)
    assert.equal(last.messages[0].message_id, 'm1')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ----------------------------------------------------- deliverDaemonBatch

function daemonBatchDeps(agent) {
  const delivered = { followup: [], inject: [] }
  const watchState = []
  const fakeAgent = agent === null ? undefined : {
    id: 'sess-1',
    followup: (message) => delivered.followup.push(message),
    inject: (message) => delivered.inject.push(message),
    ...(agent ?? {}),
  }
  return {
    delivered,
    watchState,
    deps: {
      resolveAgent: () => fakeAgent,
      resolveAgentById: () => undefined,
      setWatchState: async (_key, patch) => { watchState.push(patch) },
      uuid: () => 'uuid-1',
      log: () => {},
    },
  }
}

await check('deliverDaemonBatch: no live session → false (the daemon parks the batch)', async () => {
  const { deps } = daemonBatchDeps(null)
  const inbox = { address: 'a@msg9.io', api_key: 'k', api_url: 'http://fake', title: 'a', path: '/a' }
  const ok = await deliverDaemonBatch(deps, 'ws-a', inbox, {
    inbox: 'a@msg9.io', project_key: 'pk-1', messages: [mail('m1')], mode: 'followup',
  })
  assert.equal(ok, false)
})

await check('deliverDaemonBatch: followup wakes, sticky target recorded', async () => {
  const { deps, delivered, watchState } = daemonBatchDeps()
  const inbox = { address: 'a@msg9.io', api_key: 'k', api_url: 'http://fake', title: 'a', path: '/a' }
  const ok = await deliverDaemonBatch(deps, 'ws-a', inbox, {
    inbox: 'a@msg9.io', project_key: 'pk-1', messages: [mail('m1'), mail('m2')], mode: 'followup',
  })
  assert.equal(ok, true)
  assert.equal(delivered.followup.length, 1)
  assert.equal(delivered.inject.length, 0)
  assert.match(delivered.followup[0].content[0].text, /msg9 新邮件/)
  assert.deepEqual(watchState, [{ last_wake_agent_id: 'sess-1' }])
})

await check('deliverDaemonBatch: downgraded inject leaves a visible trace, no re-budgeting', async () => {
  const { deps, delivered } = daemonBatchDeps()
  const inbox = { address: 'a@msg9.io', api_key: 'k', api_url: 'http://fake', title: 'a', path: '/a' }
  const ok = await deliverDaemonBatch(deps, 'ws-a', inbox, {
    inbox: 'a@msg9.io', project_key: 'pk-1', messages: [mail('m1')], mode: 'inject', downgraded: true,
  })
  assert.equal(ok, true)
  assert.equal(delivered.followup.length, 0, 'the daemon already spent the budget — no wake here')
  assert.equal(delivered.inject.length, 1)
  assert.match(delivered.inject[0].content[0].text, /降级投递/)
})

// ------------------------------------------------------------- daemonclient

await check('daemonclient: registers against a live daemon, re-registers after unknown-instance', async () => {
  const home = await tempHome()
  const daemon = await createDaemon({ home, log: () => {} })
  let spawns = 0
  const client = createDaemonClient({
    home,
    getPort: () => 4321,
    getWorkspaces: async () => [{ project_key: 'pk-1', key: 'ws-a', title: 'a', path: '/a' }],
    dshHome: () => '/tmp/dsh-test-home',
    log: () => {},
    heartbeatMs: 60,
    spawnDaemon: () => { spawns += 1 },
  })
  try {
    assert.equal(await client.start(), true)
    assert.equal(spawns, 0, 'a healthy daemon.json is reused, never re-spawned')

    const registered = daemon.registry.get(client.instanceId)
    assert.ok(registered, 'the daemon knows this instance')
    assert.equal(registered.port, 4321)
    assert.equal(registered.deliver_token, client.deliverToken)
    assert.equal(registered.workspaces.length, 1)
    assert.equal(registered.workspaces[0].project_key, 'pk-1')

    // The daemon forgetting the instance (restart) must trigger a re-register.
    daemon.registry.remove(client.instanceId)
    await waitFor(() => daemon.registry.get(client.instanceId))
  } finally {
    await client.stop()
    await daemon.close()
  }
})

await check('daemonclient: 真实 spawn 必须留下 daemon.log（否则日志进 /dev/null，静默失效无从追查）', async () => {
  const home = await tempHome()
  const client = createDaemonClient({
    home,
    getPort: () => 0,
    getWorkspaces: async () => [],
    dshHome: () => '/tmp/dsh-test-home',
    log: () => {},
    heartbeatMs: 60_000,
    bootTimeoutMs: 100,
    // 真 spawn（不注入 spawnDaemon）：指向一个不存在的脚本，node 立刻退出 ——
    // 我们要断言的只是「日志文件被创建了」，而不是守护进程起来了。
    binPath: join(home, 'does-not-exist.mjs'),
  })
  await client.start().catch(() => {})
  assert.ok(
    existsSync(join(home, 'daemon.log')),
    'spawn 之后必须留下 daemon.log —— 这是 msg9 PO 那次 90 分钟静默卡死唯一的追查线索',
  )
})

await check('daemonclient: spawns the daemon when none is running and waits for it', async () => {
  const home = await tempHome()
  let spawned = 0
  let booted
  const client = createDaemonClient({
    home,
    getPort: () => 0,
    getWorkspaces: async () => [],
    dshHome: () => '/tmp/dsh-test-home',
    log: () => {},
    heartbeatMs: 60_000,
    bootTimeoutMs: 5000,
    spawnDaemon: () => {
      spawned += 1
      // The stand-in for the detached child process: an in-process daemon.
      void createDaemon({ home, log: () => {} }).then((handle) => { booted = handle })
    },
  })
  try {
    assert.equal(await client.start(), true)
    assert.equal(spawned, 1)
    assert.ok(booted, 'the spawned daemon came up')
    assert.ok(booted.registry.get(client.instanceId), 'registered with the spawned daemon')
  } finally {
    await client.stop()
    await booted?.close()
  }
})

await check('daemonclient: no daemon coming up → start() resolves false (fallback path)', async () => {
  const home = await tempHome()
  const client = createDaemonClient({
    home,
    getPort: () => 0,
    getWorkspaces: async () => [],
    dshHome: () => '/tmp/dsh-test-home',
    log: () => {},
    bootTimeoutMs: 400,
    spawnDaemon: () => { /* a spawn that never produces a daemon */ },
  })
  assert.equal(await client.start(), false)
  await client.stop()
})

console.log(failed === 0 ? 'all daemon tests passed' : `${failed} daemon test(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
