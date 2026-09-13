/**
 * Watcher integration test against the REAL cordis runtime.
 *
 * The watcher's cordis wiring once died silently: reading a service the plugin
 * never injected (`ctx.interval`) throws "cannot get property without inject"
 * and cordis disposed the fiber before the first poll. This test boots a real
 * cordis app with the optional services provided (agents, workspaceRegistry,
 * systemPrompt, webServer), lets the watcher bootstrap against a fake msg9
 * server, then delivers a second mail and asserts the agent gets woken with a
 * followup notice. Run: node tests/watch-integration.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
process.env.MSG9_WATCH_MS = '1000'
// The batch window must fit the 1.8s assertion windows below.
process.env.MSG9_WATCH_BATCH_MS = '200'
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-watchit-'))
process.env.MSG9_STATE_FILE = join(stateDir, 'state.json')
delete process.env.MSG9_OWNER_KEY

// ------------------------------------------------------------- fake msg9

const mailbox = [
  { message_id: 'm-old', from_address: 'peer@msg9.io', subject: 'already here', body: { text: 'old mail' } },
]
// Mail that arrives AFTER boot: the stream endpoint drains this (a real server
// answers `since` incrementally — the watcher only ever sees fresh mail).
const fresh = []
// v1.20: the watcher reconciles the wake decision against `folder=unprocessed`
// (server truth). Model that faithfully: everything that ever arrived and was
// never marked processed. Otherwise the fake server would answer the reconcile
// with a stale mailbox and the watcher would (correctly) stay silent.
const received = [...mailbox]
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake')
  if (req.method === 'GET' && url.pathname === '/api/v1/inbox/stream') {
    const since = url.searchParams.get('since')
    if (!since) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end('{"code":40007,"message":"invalid cursor"}')
      return
    }
    const msgs = fresh.splice(0)
    received.push(...msgs)
    // Pace the long poll a little, or an instant empty answer spins the loop.
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { messages: msgs, total: msgs.length, unread_count: msgs.length, next_cursor: since } }))
    }, 150)
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/inbox/messages') {
    const unprocessed = url.searchParams.get('folder') === 'unprocessed'
    const messages = unprocessed ? received : mailbox
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { messages, total: messages.length, unread_count: messages.length } }))
    return
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`

await writeFile(process.env.MSG9_STATE_FILE, JSON.stringify({
  workspaces: {
    'ws-a': { address: 'dsh-alpha@msg9.io', api_key: 'msg9_sk_a', api_url: apiUrl, title: 'alpha', path: '/work/a' },
  },
}))

let Context
try {
  ({ Context } = await import('@deepseek-ai/cordis'))
} catch {
  console.log('dsh-msg9-kit watcher integration test: skipped (@deepseek-ai/cordis not installed)')
  process.exit(0)
}
const plugin = await import('../lib/index.js')

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

console.log('dsh-msg9-kit watcher integration test:')

const delivered = { followup: [], inject: [] }
const fakeAgent = {
  id: 'sess-1',
  followup: (message) => delivered.followup.push(message),
  inject: (message) => delivered.inject.push(message),
}

const ctx = new Context()
ctx.provide('tools', { register: () => {} })
ctx.provide('commands', { register: () => {} })
ctx.provide('sessions', { get: () => ({ header: { cwd: '/work/a' } }) })
ctx.provide('workspaceRegistry', {
  list: () => [{ id: 'ws-a', title: 'alpha', path: '/work/a' }],
  resolveByPath: async () => ({ sessionIds: ['sess-1'] }),
})
ctx.provide('webServer', { register: () => () => {} })
ctx.provide('systemPrompt', { section: () => () => {} })
ctx.provide('agents', { get: () => fakeAgent, list: () => [fakeAgent] })

await ctx.plugin(plugin)
const readInbox = async () => (JSON.parse(await readFile(process.env.MSG9_STATE_FILE, 'utf8'))).workspaces['ws-a']

await check('bootstrap poll records the baseline without waking anyone', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  const inbox = await readInbox()
  assert.equal(inbox.watch_last_message_id, 'm-old', 'baseline recorded')
  assert.equal(delivered.followup.length, 0, 'no wake for pre-existing mail')
  assert.equal(delivered.inject.length, 0)
})

await check('a mail arriving after the baseline wakes the live agent', async () => {
  fresh.push({ message_id: 'm-new', from_address: 'boss@msg9.io', subject: 'fresh', body: { text: 'wake up' } })
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  const inbox = await readInbox()
  assert.equal(inbox.watch_last_message_id, 'm-new')
  assert.equal(delivered.followup.length, 1, 'agent woken with a followup')
  assert.match(delivered.followup[0].content[0].text, /boss@msg9\.io/)
  assert.equal(delivered.followup[0].source.plugin, 'msg9-kit')
})

server.close()
console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0

// The watcher interval keeps the event loop alive; assertions are done.
setTimeout(() => process.exit(process.exitCode ?? 0), 100)
