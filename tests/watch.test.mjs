/**
 * Unit tests for the new-mail watcher (src/host/watch.ts).
 *
 * The watcher core is dependency-injected, so this file drives it with fakes:
 * a state object, a stubbed listInbox, and a recording fake agent. Covers the
 * cursor lifecycle (bootstrap vs incremental), dedupe, the wake budget, and
 * failure isolation. Run: node tests/watch.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import {
  StreamUnsupportedError,
  WakeBudget,
  assertObservedWakeSources,
  assertSingleWakeSource,
  createWatchRuntime,
  deliverBatch,
  flushBatch,
  planIngest,
  plannedWakeSources,
  pluginNotice,
  pollOnce,
  renderMailNotice,
  streamInboxLoop,
  unseenMessages,
} from '../lib/index.js'

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

const INBOX = {
  address: 'dsh-alpha-1a2b@msg9.io',
  api_key: 'msg9_sk_a',
  api_url: 'http://fake',
  title: 'alpha',
  path: '/work/a',
}

function mail(id, extra = {}) {
  return { message_id: id, from_address: 'peer@msg9.io', subject: `s-${id}`, body: { text: `body ${id}` }, ...extra }
}

/** Fake deps: a state object plus recording spies. */
function makeDeps({ state, pages = [], unprocessedPages, agent, batchWindowMs = 0 } = {}) {
  const delivered = { followup: [], inject: [] }
  // v1.20: deliverBatch reconciles against folder=unprocessed. Default keeps the
  // pre-v1.20 semantics (whatever the page carried minus its processed_at rows);
  // pass unprocessedPages to simulate the server disagreeing with the payload.
  const seen = []
  /** T-54：把"投递路径上到底打了几次 folder=unprocessed"变成可观测事实。 */
  const calls = { unprocessed: 0 }
  const fakeAgent = agent === null
    ? undefined
    : {
        id: 'sess-1',
        followup: (message) => delivered.followup.push(message),
        inject: (message) => delivered.inject.push(message),
        ...(agent ?? {}),
      }
  const deps = {
    loadState: async () => state,
    setWatchState: async (key, patch) => Object.assign(state.workspaces[key], patch),
    listInbox: async (_url, _key, query = {}) => {
      if (query && query.folder === 'unprocessed') {
        calls.unprocessed += 1
        if (unprocessedPages) {
          const queued = unprocessedPages.shift()
          if (queued instanceof Error) throw queued
          return queued ?? { messages: [] }
        }
        return { messages: seen.filter((message) => !message.processed_at) }
      }
      const page = pages.shift()
      if (page instanceof Error) throw page
      const resolved = page ?? { messages: [] }
      if (Array.isArray(resolved.messages)) seen.push(...resolved.messages)
      return resolved
    },
    resolveAgent: () => fakeAgent,
    batchWindowMs,
    uuid: (() => { let n = 0; return () => `uuid-${(n += 1)}` })(),
    now: () => 1_000_000,
    log: () => {},
  }
  return { deps, delivered, state, seen, calls }
}

console.log('dsh-msg9-kit watcher test:')

await check('incremental poll delivers fresh mail and advances the watcher cursor only', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, cursor: 'TOOL-CURSOR', watch_cursor: 'W1' } } }
  const { deps, delivered } = makeDeps({
    state,
    pages: [{ messages: [mail('m2'), mail('m1')], next_cursor: 'W2' }],
  })
  await pollOnce(deps, createWatchRuntime())

  assert.equal(delivered.followup.length, 1)
  assert.match(delivered.followup[0].content[0].text, /m2/)
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W2', 'watcher cursor advanced')
  assert.equal(state.workspaces['ws-a'].watch_last_message_id, 'm2')
  assert.equal(state.workspaces['ws-a'].cursor, 'TOOL-CURSOR', "the tool's cursor is never touched")
})

await check('first poll bootstraps silently: baseline recorded, nothing delivered', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX } } }
  const { deps, delivered } = makeDeps({
    state,
    pages: [{ messages: [mail('m9'), mail('m8')], next_cursor: 'W1' }],
  })
  await pollOnce(deps, createWatchRuntime())

  assert.equal(delivered.followup.length, 0)
  assert.equal(delivered.inject.length, 0)
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W1')
  assert.equal(state.workspaces['ws-a'].watch_last_message_id, 'm9')
})

await check('no-cursor fallback: only messages newer than the baseline are delivered', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_last_message_id: 'm5' } } }
  const { deps, delivered } = makeDeps({
    state,
    pages: [{ messages: [mail('m7'), mail('m6'), mail('m5'), mail('m4')] }], // no next_cursor
  })
  await pollOnce(deps, createWatchRuntime())

  assert.equal(delivered.followup.length, 1)
  assert.match(delivered.followup[0].content[0].text, /收到 2 封/)
  assert.equal(state.workspaces['ws-a'].watch_last_message_id, 'm7')
})

await check('wake budget: 3 followups then context-only inject, recovering after the window', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W' } } }
  const page = () => ({ messages: [mail(`m${Math.random()}`)], next_cursor: 'W' })
  const { deps, delivered } = makeDeps({ state, pages: [page(), page(), page(), page(), page()] })
  const budgets = createWatchRuntime()

  for (let i = 0; i < 4; i += 1) await pollOnce(deps, budgets)
  assert.equal(delivered.followup.length, 3, 'budget allows three wakeups')
  assert.equal(delivered.inject.length, 1, 'the fourth degrades to inject')

  // Slide the window: enough time passes, the next mail wakes again.
  const later = 1_000_000 + 31 * 60_000
  deps.now = () => later
  await pollOnce(deps, budgets)
  assert.equal(delivered.followup.length, 4)
})

await check('no live agent: mail waits silently (no throw, no delivery)', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W' } } }
  const { deps, delivered } = makeDeps({ state, pages: [{ messages: [mail('m1')], next_cursor: 'W2' }], agent: null })
  await pollOnce(deps, createWatchRuntime())
  assert.equal(delivered.followup.length, 0)
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W2', 'cursor still advances — no re-delivery storm later')
})

await check('one failing inbox never blocks the others', async () => {
  const state = {
    workspaces: {
      'ws-a': { ...INBOX, watch_cursor: 'W' },
      'ws-b': { ...INBOX, address: 'dsh-beta@msg9.io', watch_cursor: 'W' },
    },
  }
  const { deps, delivered } = makeDeps({
    state,
    pages: [new Error('upstream wedged'), { messages: [mail('m1')], next_cursor: 'W2' }],
  })
  await pollOnce(deps, createWatchRuntime())
  assert.equal(delivered.followup.length, 1)
  assert.match(delivered.followup[0].content[0].text, /dsh-beta@msg9\.io/)
})

// ---------------------------------------------------------------- stream mode

/** Fake stream deps: poll pages for bootstrap, stream pages for the loop. */
function makeStreamDeps({ state, pollPages = [], streamPages = [], agent } = {}) {
  const { deps, delivered, seen } = makeDeps({ state, pages: pollPages, agent })
  const controller = new AbortController()
  const sleeps = []
  const streamDeps = {
    ...deps,
    streamInbox: async () => {
      const page = streamPages.shift()
      if (page instanceof Error) throw page
      if (!page) {
        controller.abort()
        return { messages: [] }
      }
      if (Array.isArray(page.messages)) seen.push(...page.messages)
      return page
    },
    sleep: async (ms) => { sleeps.push(ms) },
  }
  return { streamDeps, delivered, state, controller, sleeps }
}

await check('stream loop delivers fresh mail and advances the watcher cursor', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, cursor: 'TOOL-CURSOR', watch_cursor: 'W1' } } }
  const { streamDeps, delivered, controller } = makeStreamDeps({
    state,
    streamPages: [{ messages: [mail('m2')], next_cursor: 'W2' }],
  })
  await streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal)

  assert.equal(delivered.followup.length, 1)
  assert.match(delivered.followup[0].content[0].text, /m2/)
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W2')
  assert.equal(state.workspaces['ws-a'].cursor, 'TOOL-CURSOR', "the tool's cursor is never touched")
})

await check('stream loop bootstraps silently through the poll path first', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX } } }
  const { streamDeps, delivered, controller } = makeStreamDeps({
    state,
    pollPages: [{ messages: [mail('m9')], next_cursor: 'W1' }],
    streamPages: [{ messages: [] }],
  })
  await streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal)

  assert.equal(delivered.followup.length, 0, 'bootstrap announces nothing')
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W1')
})

await check('stream loop: HTTP 404 means the server has no stream endpoint', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const gone = Object.assign(new Error('not found'), { status: 404 })
  const { streamDeps, controller } = makeStreamDeps({ state, streamPages: [gone] })
  await assert.rejects(
    streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal),
    (error) => error instanceof StreamUnsupportedError,
  )
})

await check('stream loop: bootstrap without next_cursor mints a cursor and enters stream mode', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_last_message_id: 'm9' } } }
  const { streamDeps, delivered, controller } = makeStreamDeps({
    state,
    pollPages: [{ messages: [mail('m9')] }], // no next_cursor — msg9 only issues one on `since` requests
    streamPages: [{ messages: [] }],
  })
  await streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal)

  const minted = state.workspaces['ws-a'].watch_cursor
  assert.ok(minted, 'a cursor was minted so /inbox/stream can start')
  assert.ok(Buffer.from(minted, 'base64url').toString('utf8').endsWith('|0'), 'minted cursor is a (time, 0) position')
  assert.equal(delivered.followup.length, 0, 'nothing newer than the baseline')
})

await check('stream loop: HTTP 400 (cursor shape rejected) also falls back', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const bad = Object.assign(new Error('invalid cursor'), { status: 400 })
  const { streamDeps, controller } = makeStreamDeps({ state, streamPages: [bad] })
  await assert.rejects(
    streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal),
    (error) => error instanceof StreamUnsupportedError,
  )
})

await check('processed mail never wakes anyone again (v1.13 alignment)', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const { deps, delivered } = makeDeps({
    state,
    pages: [{ messages: [mail('m-new'), mail('m-done', { processed_at: '2026-09-12T10:00:00Z' })], next_cursor: 'W2' }],
  })
  await pollOnce(deps, createWatchRuntime())

  assert.equal(delivered.followup.length, 1, 'only the unprocessed mail is delivered')
  assert.match(delivered.followup[0].content[0].text, /收到 1 封/)
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W2', 'cursor still advances past the processed one')

  const allDone = makeDeps({
    state: { workspaces: { 'ws-b': { ...INBOX, watch_cursor: 'W1' } } },
    pages: [{ messages: [mail('m-x', { processed_at: '2026-09-12T10:00:00Z' })], next_cursor: 'W2' }],
  })
  await pollOnce(allDone.deps, createWatchRuntime())
  assert.equal(allDone.delivered.followup.length, 0, 'an all-processed page wakes nobody')
})

await check('v1.20: payload 缺 processed_at 的幽灵信也不唤醒（按服务端 unprocessed 对账）', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  // 消息对象没有 processed_at（/inbox/stream 是精简投影），但服务端 unprocessed 为空
  const { deps, delivered } = makeDeps({
    state,
    pages: [{ messages: [mail('m-ghost')], next_cursor: 'W2' }],
    unprocessedPages: [{ messages: [] }],
  })
  await pollOnce(deps, createWatchRuntime())
  assert.equal(delivered.followup.length, 0, '服务端说没有未处理 → 不唤醒')

  // 对账失败时降级回 processed_at 过滤（不能退化成"全都唤醒"）
  const broken = makeDeps({
    state: { workspaces: { 'ws-b': { ...INBOX, watch_cursor: 'W1' } } },
    pages: [{ messages: [mail('m-ok'), mail('m-done2', { processed_at: '2026-09-12T10:00:00Z' })], next_cursor: 'W2' }],
    unprocessedPages: [new Error('unprocessed view 500')],
  })
  await pollOnce(broken.deps, createWatchRuntime())
  assert.equal(broken.delivered.followup.length, 1, '降级后仍只唤醒未处理的那封')
})

await check('T-54: 没有活会话时连 folder=unprocessed 对账都不打（那一次配额不该花）', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const { deps, delivered, calls } = makeDeps({
    state,
    pages: [{ messages: [mail('m-new')], next_cursor: 'W2' }],
    unprocessedPages: [{ messages: [mail('m-new')] }],
    agent: null, // 没有活会话：本批谁都唤不醒（信还在服务器 inbox 上）
  })
  await pollOnce(deps, createWatchRuntime())
  assert.equal(delivered.followup.length, 0, '没有活会话 ⇒ 一封都不投')
  assert.equal(delivered.inject.length, 0)
  assert.equal(calls.unprocessed, 0, '对账结论没有任何用处 ⇒ 一次上游调用都不该付')
})

await check('T-54: 有活会话时对账仍是每批 1 次（与批次内的封数无关）', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const batch = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'].map((id) => mail(id))
  const { deps, delivered, calls } = makeDeps({
    state,
    pages: [{ messages: batch, next_cursor: 'W2' }],
  })
  await pollOnce(deps, createWatchRuntime())
  assert.equal(delivered.followup.length, 1, '一个批次 ⇒ 一次通知')
  assert.equal(calls.unprocessed, 1, '5 封信也只有 1 次对账（批次口径，不随封数放大）')
})

await check('stream loop: a 429 honors Retry-After when present', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const limited = Object.assign(new Error('too many requests'), { status: 429, retryAfter: 17 })
  const { streamDeps, sleeps, controller } = makeStreamDeps({ state, streamPages: [limited] })
  streamDeps.sleep = async (ms) => { sleeps.push(ms); controller.abort() }
  await streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal)

  assert.deepEqual(sleeps, [17_000], 'the server-specified wait wins over the fallback')
})

await check('stream loop: a 429 backs off hard', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const limited = Object.assign(new Error('too many requests'), { status: 429 })
  const { streamDeps, sleeps, controller } = makeStreamDeps({ state, streamPages: [limited] })
  streamDeps.sleep = async (ms) => { sleeps.push(ms); controller.abort() }
  await streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal)

  assert.deepEqual(sleeps, [60_000], 'a 429 skips the gentle backoff steps')
})

await check('stream loop: a transient failure backs off and retries', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const { streamDeps, delivered, sleeps, controller } = makeStreamDeps({
    state,
    streamPages: [new Error('flaky upstream'), { messages: [mail('m3')], next_cursor: 'W2' }],
  })
  await streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal)

  assert.deepEqual(sleeps, [4000], 'first failure waits one backoff step')
  assert.equal(delivered.followup.length, 1, 'the retry still delivers')
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W2')
})

await check('stream loop ends when its inbox disappears', async () => {
  const state = { workspaces: {} }
  const { streamDeps, controller } = makeStreamDeps({ state })
  await streamInboxLoop(streamDeps, createWatchRuntime(), 'ws-a', controller.signal)
  // resolves without touching anything
})

await check('notify pause: mail is tracked silently, never delivered, no replay on resume', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const { deps, delivered } = makeDeps({ state, pages: [{ messages: [mail('m1')], next_cursor: 'W2' }] })
  let paused = true
  deps.isPaused = () => paused
  await pollOnce(deps, createWatchRuntime())

  assert.equal(delivered.followup.length, 0, 'paused: no wake')
  assert.equal(delivered.inject.length, 0, 'paused: no inject either')
  assert.equal(state.workspaces['ws-a'].watch_cursor, 'W2', 'cursor still advances (no replay later)')

  // Resume: only mail arriving AFTER the resume is delivered.
  paused = false
  deps.listInbox = async () => ({ messages: [mail('m2')], next_cursor: 'W3' })
  await pollOnce(deps, createWatchRuntime())
  assert.equal(delivered.followup.length, 1)
  assert.match(delivered.followup[0].content[0].text, /m2/, 'm2 arrives; m1 is not replayed')
  assert.ok(!delivered.followup[0].content[0].text.includes('m1'), 'm1 is not replayed')
})

await check('sticky target: notices keep going to the same session while it lives', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const agentA = { id: 'sess-a', followup: () => {}, inject: () => {} }
  const agentB = { id: 'sess-b', followup: () => {}, inject: () => {} }
  const { deps, delivered } = makeDeps({
    state,
    pages: [{ messages: [mail('m1')], next_cursor: 'W2' }],
    agent: { id: 'sess-a' },
  })
  let round = 0
  deps.resolveAgentById = (id) => (id === 'sess-a' ? agentA : undefined)
  const chosen = []
  deps.resolveAgent = () => {
    round += 1
    chosen.push(round)
    return round === 1 ? agentA : agentB // the "newest" session drifts to B
  }
  await pollOnce(deps, createWatchRuntime())
  assert.equal(state.workspaces['ws-a'].last_wake_agent_id, 'sess-a', 'the first target is remembered')

  deps.listInbox = async () => ({ messages: [mail('m2')], next_cursor: 'W3' })
  await pollOnce(deps, createWatchRuntime())
  assert.equal(chosen.length, 1, 'the second notice never re-resolves — it sticks to A')
})

await check('inbox budget: N sessions cannot multiply the wake allowance', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const delivered = { followup: [], inject: [] }
  let n = 0
  const { deps } = makeDeps({ state, pages: [] })
  deps.resolveAgent = () => {
    n += 1
    return { id: `sess-${n}`, followup: (m) => delivered.followup.push(m), inject: (m) => delivered.inject.push(m) }
  }
  const rt = createWatchRuntime()
  // v1.20: deliverBatch 会再按 folder=unprocessed 对账一次，所以同一轮的
  // 两次调用必须看到同一封（旧 stub 每次调用随机生成 id，现实中不存在这种分页）
  for (let i = 0; i < 4; i += 1) {
    const page = { messages: [mail(`m-budget-${i}`)], next_cursor: 'W' }
    deps.listInbox = async () => page
    await pollOnce(deps, rt)
  }
  assert.equal(delivered.followup.length, 3, 'the inbox budget caps at 3 even with a fresh session each time')
  assert.equal(delivered.inject.length, 1, 'the fourth degrades to inject')
})

await check('batch window: a flurry lands as ONE wake, chronological, threads marked', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const { deps, delivered } = makeDeps({ state, pages: [], batchWindowMs: 12_000 })
  const rt = createWatchRuntime()
  // Three mails arrive back-to-back (the third is the correction of the first).
  const corrections = [
    mail('m1', { created_at: '2026-09-12T10:00:00Z', correlation_id: 't-1' }),
    mail('m2', { created_at: '2026-09-12T10:00:20Z', correlation_id: 't-2' }),
    mail('m3', { created_at: '2026-09-12T10:00:40Z', correlation_id: 't-1' }),
  ]
  deps.listInbox = async () => ({ messages: [corrections.shift()], next_cursor: 'W' })
  await pollOnce(deps, rt)
  await pollOnce(deps, rt)
  await pollOnce(deps, rt)
  assert.equal(delivered.followup.length, 0, 'nothing is delivered mid-flurry')

  await flushBatch(deps, rt, 'ws-a', state.workspaces['ws-a'])
  assert.equal(delivered.followup.length, 1, 'the whole flurry is ONE wake')
  const text = delivered.followup[0].content[0].text
  assert.ok(text.indexOf('m1') < text.indexOf('m2') && text.indexOf('m2') < text.indexOf('m3'), 'chronological order')
  assert.match(text, /\[线程\]/, 'the correction thread is marked')
  assert.match(text, /folder=unprocessed/, 'the CTA points at unprocessed')
})

await check('renderMailNotice and helpers', () => {
  const many = [mail('m1'), mail('m2'), mail('m3'), mail('m4'), mail('m5'), mail('m6'), mail('m7')]
  const { text, summary } = renderMailNotice('dsh-a@msg9.io', many)
  assert.match(text, /dsh-a@msg9\.io/)
  assert.match(text, /收到 7 封/)
  assert.match(text, /另外 2 封/, 'only the first 5 are listed, the rest summarized')
  assert.match(text, /folder=unprocessed/)
  assert.ok(summary.length <= 120)

  const notice = pluginNotice('id-1', 'text', 's')
  assert.equal(notice.role, 'user')
  // v4 producer-owned source kind — matches dsh's v3→v4 migrator output for
  // the retired { kind: 'plugin', plugin: 'msg9-kit' } wrapper; 'plugin' and
  // '' are the only rejected kinds.
  assert.equal(notice.source.kind, 'plugin:msg9-kit')
  assert.equal('plugin' in notice.source, false)

  assert.deepEqual(unseenMessages([mail('a'), mail('b'), mail('c')], 'b').map((m) => m.message_id), ['a'])
  assert.deepEqual(unseenMessages([mail('a')], undefined).length, 1)
  // Baseline id scrolled off: the timestamp baseline decides — old mail is
  // never re-announced, genuinely new mail still is.
  const withTime = [
    mail('new', { created_at: '2026-09-12T13:00:00Z' }),
    mail('old', { created_at: '2026-09-12T12:00:00Z' }),
  ]
  assert.deepEqual(
    unseenMessages(withTime, 'missing-id', '2026-09-12T12:30:00Z').map((m) => m.message_id),
    ['new'],
    'missing id falls back to the time baseline',
  )
  assert.equal(unseenMessages(withTime, 'missing-id').length, 2, 'no time baseline keeps the legacy behavior')

  const budget = new WakeBudget(2, 1000)
  assert.equal(budget.decide(0), 'wake')
  assert.equal(budget.decide(100), 'wake')
  assert.equal(budget.decide(200), 'inject')
  assert.equal(budget.decide(1101), 'wake', 'oldest wake slides out of the window')
})

// ---------------------------------------------------------------------- T-67
// 同一条信被唤醒两次（重复门铃）。
//
// 现场归因（2026-10-10，真实数据）：
//   · 账本 679 条事件 / 679 个不同 message_id，跨账本重复 0 ⇒ 平台没重投 ✓
//   · 卡面假设的「账本消费者 + 独立兜底路径各响一次」**在代码里不存在**：
//     unread 补齐就发生在同一轮 `pollOnce` 里，`planLedgerBatch` 按 message_id
//     合并去重（见 tests/ledger.test.mjs），所以它是**同一个** `deliverBatch` 调用；
//   · 真正响两次的是**两个 host 进程**（桌面宿主 + `dsh web`）：同一个
//     `state.json`、同一个 `spool/<address>.dsh-msg9-kit.cursor`，各自一轮消费，
//     各自唤醒**自己进程里的活会话**（lsof 实证：两个进程各持一个本 workspace 的
//     session.lock）。这条 2:1 的比值在 `ingest=ledger` 之前（self 模式）就已存在。
//
// 所以这一组断言分两层：
//   A. **本进程内**「同一 message_id 只准醒一次」——本次实现落的闸门；
//   B. 跨进程那一层**不是**这个去重环能覆盖的，用一条显式的"已知边界"断言记下来，
//      免得有人以为 A 已经把现场那条 2:1 修掉了。

await check('T-67 观测：唤醒出口一行一封，字段足够只靠日志回答"是谁响的"', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const logs = []
  const { deps } = makeDeps({ state, pages: [] })
  deps.log = (message) => logs.push(message)
  const message = mail('m-obs')
  deps.listInbox = async (_url, _key, query = {}) => (query.folder === 'unprocessed' ? { messages: [message] } : { messages: [] })

  await deliverBatch(deps, createWatchRuntime(), 'ws-a', state.workspaces['ws-a'], [message], {
    source: 'ledger-consumer',
    originOf: () => 'ledger',
  })

  const line = logs.find((entry) => entry.startsWith('msg9 wake:'))
  assert.ok(line, `唤醒出口必须打观测行；实际日志：${JSON.stringify(logs)}`)
  for (const field of [
    'source=ledger-consumer',
    'origin=ledger',
    'message_id=m-obs',
    `address=${INBOX.address}`,
    'announced=no',
    `pid=${process.pid}`,
    'session=sess-1',
    'decision=wake',
  ]) {
    assert.ok(line.includes(field), `观测行缺少 ${field}：${line}`)
  }
  assert.match(line, /at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, '时间戳必须是 ISO8601')
})

await check('T-67 去重：同一 message_id 经两条唤醒路径 ⇒ 只唤醒一次（跨路径共享同一个环）', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const logs = []
  const { deps, delivered } = makeDeps({ state, pages: [] })
  deps.log = (message) => logs.push(message)
  const message = mail('m-dup')
  deps.listInbox = async (_url, _key, query = {}) => (query.folder === 'unprocessed' ? { messages: [message] } : { messages: [] })

  const rt = createWatchRuntime()
  const inbox = state.workspaces['ws-a']
  // 路径①：账本消费者（ledger 分支的出口）
  const first = await deliverBatch(deps, rt, 'ws-a', inbox, [message], {
    source: 'ledger-consumer',
    originOf: () => 'ledger',
  })
  // 路径②：进程内 watcher（self 分支 / 兜底那一类）——**同一封信**
  const second = await deliverBatch(deps, rt, 'ws-a', inbox, [message], {
    source: 'in-process-watcher',
    originOf: () => 'inbox-page',
  })

  assert.equal(first, true, '第一次有活会话收下')
  assert.equal(delivered.followup.length + delivered.inject.length, 1, '同一 message_id 只准唤醒一次')
  assert.equal(delivered.followup.length, 1)
  // 第二次必须是「被拦下」，而且要留痕 —— 不许静默
  assert.equal(second, true, '第二次也要返回 true：有活会话收下了，账本游标必须能前进（false 会永远重投同一批）')
  const skipped = logs.filter((entry) => entry.startsWith('msg9 wake:') && entry.includes('announced=yes'))
  assert.equal(skipped.length, 1, `第二次要被观测到；实际：${JSON.stringify(logs.filter((l) => l.startsWith('msg9 wake:')))}`)
  assert.match(skipped[0], /decision=skip/)
  assert.match(skipped[0], /source=in-process-watcher/)
  assert.match(skipped[0], /message_id=m-dup/)
})

await check('T-67 去重不吞信：没有活会话（返回 false）的一轮绝不进环', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const message = mail('m-nowake')
  const { deps, delivered } = makeDeps({ state, pages: [], agent: null })
  deps.listInbox = async (_url, _key, query = {}) => (query.folder === 'unprocessed' ? { messages: [message] } : { messages: [] })
  const rt = createWatchRuntime()

  const missed = await deliverBatch(deps, rt, 'ws-a', state.workspaces['ws-a'], [message], { source: 'ledger-consumer' })
  assert.equal(missed, false, '没有活会话 ⇒ 不投递')
  assert.equal(rt.announced.has('m-nowake'), false, '没投出去的信绝不能进去重环（否则会被永久静默吞掉）')

  // 会话来了：同一封信必须仍然叫得醒（这就是"没有活会话 ⇒ 不 commit ⇒ 下轮重投"）
  deps.resolveAgent = () => ({ id: 'sess-late', followup: (m) => delivered.followup.push(m), inject: (m) => delivered.inject.push(m) })
  const later = await deliverBatch(deps, rt, 'ws-a', state.workspaces['ws-a'], [message], { source: 'ledger-consumer' })
  assert.equal(later, true)
  assert.equal(delivered.followup.length, 1, '重投的那一封必须真的醒一次')
})

await check('T-67 判据：assertObservedWakeSources / assertSingleWakeSource 现在也校验运行时来源', () => {
  const ledger = planIngest('ledger')
  assert.deepEqual(plannedWakeSources(ledger), ['ledger-consumer'], 'ledger 计划只允许账本消费者')
  assert.doesNotThrow(() => assertObservedWakeSources(['ledger-consumer'], plannedWakeSources(ledger)))
  assert.throws(
    () => assertObservedWakeSources(['ledger-consumer', 'in-process-watcher'], plannedWakeSources(ledger)),
    /actually FIRED/,
    '账本模式下别的来源也响了 ⇒ 必须抓出来',
  )
  assert.throws(
    () => assertObservedWakeSources(['in-process-watcher'], plannedWakeSources(ledger)),
    /actually FIRED/,
  )
  // 计划守卫吃进运行时观测：计划对、实际错 ⇒ 也要抛
  assert.equal(assertSingleWakeSource(ledger, false, { observed: ['ledger-consumer'] }), 'ledger-consumer')
  assert.throws(
    () => assertSingleWakeSource(ledger, false, { observed: ['ledger-consumer', 'self-daemon'] }),
    /actually FIRED/,
  )

  const self = planIngest('self')
  assert.deepEqual(plannedWakeSources(self).sort(), ['in-process-watcher', 'self-daemon'], 'self 计划允许的是一对互斥来源')
  assert.doesNotThrow(() => assertObservedWakeSources(['in-process-watcher'], plannedWakeSources(self)))
})

await check('T-67 判据接线：运行时真的响了两条来源 ⇒ 响亮记违反，但不杀循环', async () => {
  const state = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const logs = []
  const { deps, delivered } = makeDeps({ state, pages: [] })
  deps.log = (message) => logs.push(message)
  const first = mail('m-v1')
  const second = mail('m-v2')
  deps.listInbox = async (_url, _key, query = {}) => (
    query.folder === 'unprocessed' ? { messages: [first, second] } : { messages: [] }
  )
  // 计划说只允许账本消费者（ledger 模式）
  const rt = createWatchRuntime({ allowedWakeSources: plannedWakeSources(planIngest('ledger')) })

  await deliverBatch(deps, rt, 'ws-a', state.workspaces['ws-a'], [first], { source: 'ledger-consumer' })
  assert.equal(rt.wakeViolation, undefined, '第一条合法来源不该触发违反')
  // 另一条来源也响了 —— 这正是 T-67 要抓的形态
  await deliverBatch(deps, rt, 'ws-a', state.workspaces['ws-a'], [second], { source: 'in-process-watcher' })

  assert.ok(rt.wakeViolation, '运行时违反必须被记录')
  assert.match(rt.wakeViolation, /actually FIRED/)
  assert.ok(logs.some((entry) => entry.startsWith('msg9 wake: VIOLATION')), '违反必须响亮地进日志')
  assert.equal(delivered.followup.length, 2, '记违反不等于把信扔掉 —— 投递照旧')
})

await check('T-67 已知边界：两个 runtime（＝两个 host 进程）各自去重 ⇒ 同一封信仍各响一次', async () => {
  // 现场那条 2:1 的机制：桌面宿主与 `dsh web` 是两个进程、同一个 state.json、
  // 同一个 `spool/<address>.dsh-msg9-kit.cursor`，各跑一轮消费、各唤醒自己进程里
  // 的活会话。进程内去重环不跨进程 ⇒ 这一条**预期仍然重复**。
  //
  // ⚠️ 这张断言是**已知边界**的记录，不是"正确行为"：它红了，说明有人把跨进程
  // 互斥补上了（那是好事）—— 请同时更新 T-67 的卡与这条断言，别直接删掉了事。
  const sharedState = { workspaces: { 'ws-a': { ...INBOX, watch_cursor: 'W1' } } }
  const message = mail('m-cross')
  const runtimes = [createWatchRuntime(), createWatchRuntime()]
  const delivered = []

  for (const rt of runtimes) {
    const { deps, delivered: sink } = makeDeps({ state: sharedState, pages: [] })
    deps.listInbox = async (_url, _key, query = {}) => (query.folder === 'unprocessed' ? { messages: [message] } : { messages: [] })
    await deliverBatch(deps, rt, 'ws-a', sharedState.workspaces['ws-a'], [message], { source: 'ledger-consumer' })
    delivered.push(sink.followup.length + sink.inject.length)
  }

  assert.deepEqual(delivered, [1, 1], '两个进程各响一次 —— 这就是现场看到的重复门铃')
})

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
