/**
 * T-13 阶段三·第一步：**ingest 开关的接线级端到端**（真 cordis 运行时）。
 *
 * 两个方向各证一次：
 *   · `MSG9_INGEST=ledger` ⇒ 唤醒来自平台**账本**（临时 spool 追加一行 ⇒ 唤醒），
 *     而 self 路径**完全没跑**（state 里没有 watch_cursor、没有 daemon.json）；
 *   · 默认（不设 MSG9_INGEST）⇒ 还是 self：进程内 watcher 照旧 bootstrap 写自己的
 *     游标，而**账本消费者一个字节都不动**（没有 consumer 游标文件）。
 *
 * 环境全部临时化：MSG9_HOME（spool）、MSG9_DAEMON_HOME、MSG9_STATE_FILE 都在
 * mkdtemp 里 —— 绝不碰真实 `~/.msg9/**` / `~/.dsh/msg9-daemon/**`。
 *
 * Run: node tests/ingest-switch.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
process.env.MSG9_WATCH_MS = '1000'
process.env.MSG9_WATCH_BATCH_MS = '200'
// 这一轮**只**看账本路径：绝不让插件去找/起自研 daemon。
process.env.MSG9_WATCH_DAEMON = '0'
// 走进程内 watcher 的**轮询**分支（不试 /inbox/stream），让 self 方向的第一步落得可预测。
process.env.MSG9_WATCH_STREAM = '0'
delete process.env.MSG9_OWNER_KEY

const root = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-ingest-switch-'))
process.env.MSG9_HOME = join(root, 'msg9-home')
process.env.MSG9_DAEMON_HOME = join(root, 'msg9-daemon')
await mkdir(join(process.env.MSG9_HOME, 'spool'), { recursive: true })
await mkdir(process.env.MSG9_DAEMON_HOME, { recursive: true })

const LEDGER_ADDRESS = 'dsh-alpha@dsh.ice.msg9.io'
const SELF_ADDRESS = 'dsh-beta@dsh.ice.msg9.io'
const LEDGER_STATE = join(root, 'state-ledger.json')
const SELF_STATE = join(root, 'state-self.json')

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

console.log('dsh-msg9-kit ingest switch test:')

// ---------------------------------------------------------------- 假 msg9 服务

const mailbox = [] // `folder=all` 的返回（self 路径 bootstrap 用）
const received = [] // `folder=unprocessed` 的返回（ledger 路径取正文/对账用）
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fake')
  if (url.pathname === '/api/v1/inbox/messages') {
    const unprocessed = url.searchParams.get('folder') === 'unprocessed'
    const messages = unprocessed ? received : mailbox
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { messages, total: messages.length, unread_count: messages.length, next_cursor: 'cur-1' } }))
    return
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`

const { spoolDir, consumerCursorPath, DEFAULT_CONSUMER } = await import('../lib/index.js')
assert.equal(spoolDir(), join(process.env.MSG9_HOME, 'spool'), 'spoolDir() 必须吃 MSG9_HOME（否则就在碰真机目录）')

const ledgerLine = (messageId, receivedAt) =>
  `${JSON.stringify({ v: 1, type: 'new_message', address: LEDGER_ADDRESS, message_id: messageId, received_at: receivedAt })}\n`
const ledgerPath = join(spoolDir(), `${LEDGER_ADDRESS}.jsonl`)
const ledgerCursor = consumerCursorPath(LEDGER_ADDRESS, DEFAULT_CONSUMER, spoolDir())
const mail = (messageId, subject) => ({ message_id: messageId, from_address: 'peer@msg9.io', subject, body: { text: `body ${messageId}` }, created_at: '2026-10-07T01:00:00Z' })

let Context
try {
  ({ Context } = await import('@deepseek-ai/cordis'))
} catch {
  console.log('dsh-msg9-kit ingest switch test: skipped (@deepseek-ai/cordis not installed)')
  server.close()
  process.exit(0)
}
const plugin = await import('../lib/index.js')

/** 起一个真 cordis app（与 watch-integration.test.mjs 同一套替身服务）。 */
async function bootApp({ agentId, address, statePath, cwd, delivered }) {
  const agent = { id: agentId, followup: (m) => delivered.followup.push(m), inject: (m) => delivered.inject.push(m) }
  await writeFile(statePath, JSON.stringify({
    workspaces: { [agentId]: { address, api_key: 'msg9_sk_test', api_url: apiUrl, title: agentId, path: cwd } },
  }))
  process.env.MSG9_STATE_FILE = statePath
  const ctx = new Context()
  ctx.provide('tools', { register: () => {} })
  ctx.provide('commands', { register: () => {} })
  ctx.provide('sessions', { get: () => ({ header: { cwd } }) })
  ctx.provide('workspaceRegistry', { list: () => [{ id: agentId, title: agentId, path: cwd }], resolveByPath: async () => ({ sessionIds: [agentId] }) })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('agents', { get: (id) => (id === agentId ? agent : undefined), list: () => [agent] })
  await ctx.plugin(plugin)
  return ctx
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ======================================================= 方向一：ledger 模式

// 账本里先有一行「历史邮件」；服务器上它就是未处理的第一封。
await writeFile(ledgerPath, ledgerLine('m-old', '2026-10-07T00:00:00Z'), 'utf8')
received.push(mail('m-old', 'already here'))

process.env.MSG9_INGEST = 'ledger'
const ledgerDelivered = { followup: [], inject: [] }
await bootApp({ agentId: 'ws-ledger', address: LEDGER_ADDRESS, statePath: LEDGER_STATE, cwd: '/work/ledger', delivered: ledgerDelivered })

await check('ledger：第一轮只立基线（不把历史邮件倒进会话），且**不碰** state 的 self 游标', async () => {
  await wait(1_600)
  assert.equal(ledgerDelivered.followup.length, 0, '首次消费不唤醒历史邮件')
  assert.equal(ledgerDelivered.inject.length, 0)
  assert.equal(
    (await readFile(ledgerCursor, 'utf8')).trim(), 'm-old',
    `账本消费者的基线必须落到账本尾部（${ledgerCursor}）`,
  )
  const state = JSON.parse(await readFile(LEDGER_STATE, 'utf8'))
  assert.equal(state.workspaces['ws-ledger'].watch_cursor, undefined, 'ledger 模式下 self 的 watch_cursor 一个字节都不该被写')
  assert.equal(existsSync(join(process.env.MSG9_DAEMON_HOME, 'daemon.json')), false, 'ledger 模式不启动自研 daemon（否则就是第二个唤醒来源）')
})

await check('ledger：临时 spool 追加一行 ⇒ 唤醒被触发（账本是触发源）', async () => {
  await appendFile(ledgerPath, ledgerLine('m-new', '2026-10-07T02:00:00Z'))
  received.push(mail('m-new', 'fresh via ledger'))
  await wait(2_600)
  assert.equal(ledgerDelivered.followup.length, 1, `账本追加一行必须唤醒一次（实际 ${ledgerDelivered.followup.length}）`)
  assert.match(ledgerDelivered.followup[0].content[0].text, /fresh via ledger/, '唤醒里带的是服务器上的真邮件')
  assert.equal(ledgerDelivered.followup[0].source.kind, 'plugin:msg9-kit')
  assert.equal((await readFile(ledgerCursor, 'utf8')).trim(), 'm-new', '投递确认后才推进我们自己的游标')
  const state = JSON.parse(await readFile(LEDGER_STATE, 'utf8'))
  assert.equal(state.workspaces['ws-ledger'].watch_cursor, undefined, 'self 路径始终没跑')
})

// ======================================================== 方向二：默认 self

await check('默认（不设 MSG9_INGEST）：还是 self —— 自研路径照旧，账本消费者一个字节都不动', async () => {
  delete process.env.MSG9_INGEST
  mailbox.push(mail('self-old', 'preexisting'))
  const selfDelivered = { followup: [], inject: [] }
  await bootApp({ agentId: 'ws-self', address: SELF_ADDRESS, statePath: SELF_STATE, cwd: '/work/self', delivered: selfDelivered })
  await wait(2_600)
  const state = JSON.parse(await readFile(SELF_STATE, 'utf8'))
  assert.ok(state.workspaces['ws-self'].watch_cursor, 'self 路径照旧 bootstrap：写自己的 watch_cursor（改前行为）')
  assert.equal(
    existsSync(consumerCursorPath(SELF_ADDRESS, DEFAULT_CONSUMER, spoolDir())), false,
    '默认没切到 ledger：绝不创建账本消费者游标',
  )
  assert.equal(selfDelivered.followup.length, 0, 'bootstrap 不唤醒历史邮件（改前的语义）')
})

server.close()
console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0

// 后台的定时器（self 轮询 / 账本循环）会挂住事件循环；断言已完成。
setTimeout(() => process.exit(process.exitCode ?? 0), 100)
