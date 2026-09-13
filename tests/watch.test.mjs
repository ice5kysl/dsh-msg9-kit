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
  createWatchRuntime,
  flushBatch,
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
  return { deps, delivered, state, seen }
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
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.plugin, 'msg9-kit')

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

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
