/**
 * 平台账本（spool）消费者骨架的测试 —— T-13 二期第一阶段。
 *
 * 只测我们自己的骨架：账本/游标都造在**临时目录**里，不连 ~/.msg9/daemon.sock、
 * 不碰真实 spool、不起平台 daemon（本阶段明确不做这些）。
 *
 * 覆盖卡面要求的四条：① 坏行容错 ② 幂等（重复事件只唤醒一次）
 * ③ 游标滞后计算 ④ 补齐路径触发条件。
 *
 * T-46 追加（切换前的三条必修 + 一项调参）：
 *   ⑤ 空账本/无账本 ⇒ 哨兵游标（第一封信不再被静默吞掉）+ 日志；
 *   ⑥ 乱序/回填账本 ⇒ 单轮唤醒上限（文件序前 N 条，剩余下轮，绝不丢）；
 *   ⑦ `connected:false` ⇒ `decideTopUp` 必须看得见（reason=daemon-disconnected）。
 *
 * Run: node tests/ledger.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// spoolDir() 的默认值走 MSG9_HOME —— 测试里指向临时目录，绝不读真实 ~/.msg9。
process.env.MSG9_HOME = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-ledger-home-'))

const {
  DEFAULT_CONSUMER,
  DEFAULT_MAX_PER_ROUND,
  EMPTY_LEDGER_CURSOR,
  assertConsumerName,
  computeCursorLag,
  consumerCursorPath,
  createLedgerConsumer,
  decideTopUp,
  isEmptyLedgerCursor,
  ledgerPath,
  parseLedgerLine,
  parseLedgerLines,
  readConsumerCursor,
  readConsumerLag,
  readLedger,
  selectFreshEvents,
  selectTopUpMessages,
  writeConsumerCursor,
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

async function tempSpool() {
  return mkdtemp(join(tmpdir(), 'dsh-msg9-kit-ledger-'))
}

/** 造一行账本事件：形状与本机实测的 spool 行完全一致。 */
function ledgerLine(messageId, receivedAt, extra = {}) {
  return JSON.stringify({
    v: 1,
    type: 'new_message',
    address: 'dsh@test.msg9.io',
    message_id: messageId,
    received_at: receivedAt,
    ...extra,
  })
}

async function writeLedgerFile(path, lines) {
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

/** 造一条「账本事件」对象（纯函数测试用）。 */
function ev(messageId, receivedAt) {
  return parseLedgerLine(ledgerLine(messageId, receivedAt))
}

const ADDRESS = 'dsh@test.msg9.io'
const CONSUMER = 'mut'

console.log('dsh-msg9-kit ledger test:')

// ---------------------------------------------------------------- ① 坏行容错

await check('parseLedgerLines: 坏行跳过并计数，绝不抛', async () => {
  const text = [
    ledgerLine('m1', '2026-10-01T09:00:00+08:00'),
    '',
    '   ',
    'not json at all',
    '{"address":"dsh@test.msg9.io"}', // 缺 message_id
    '[1,2,3]', // 不是对象
    '"just a string"',
    'null',
    '{"message_id":""}', // 空 id
    ledgerLine('m2', '2026-10-01T09:05:00+08:00'),
  ].join('\n')

  const parsed = parseLedgerLines(text)
  assert.deepEqual(parsed.events.map((e) => e.message_id), ['m1', 'm2'])
  assert.equal(parsed.bad_lines, 6, '坏行要计数（含缺 id / 非对象 / 空 id）')
  assert.equal(parsed.blank_lines, 2, '空行是正常现象，单独计数')
})

await check('parseLedgerLines: 空账本 / 半个 JSON（追加写崩溃点）都不抛', async () => {
  assert.deepEqual(parseLedgerLines('').events, [])
  assert.equal(parseLedgerLines('').bad_lines, 0)
  // 崩溃点留半行：后半截是坏行，前面的好行照用。
  const half = `${ledgerLine('m1', '2026-10-01T09:00:00Z')}\n{"v":1,"type":"new_mes`
  const parsed = parseLedgerLines(half)
  assert.deepEqual(parsed.events.map((e) => e.message_id), ['m1'])
  assert.equal(parsed.bad_lines, 1)
})

await check('parseLedgerLine: 真实账本行的形状（v/type/address/message_id/received_at，无正文）', async () => {
  const event = parseLedgerLine('{"v":1,"type":"new_message","address":"dsh@dsh.ice.msg9.io","message_id":"msg_adoLkvc4Vn5Z","received_at":"2026-09-30T09:08:04.564565069+08:00"}')
  assert.equal(event.v, 1)
  assert.equal(event.type, 'new_message')
  assert.equal(event.address, 'dsh@dsh.ice.msg9.io')
  assert.equal(event.message_id, 'msg_adoLkvc4Vn5Z')
  assert.equal(event.received_at, '2026-09-30T09:08:04.564565069+08:00')
  assert.equal(event.received_ms, Date.parse('2026-09-30T09:08:04.564565069+08:00'), '带偏移的纳秒时间戳要能解析')
  assert.equal(ledgerLine('m', 'x').includes('body'), false)
})

await check('readLedger: 不存在的账本 = 空账本（不是错误）', async () => {
  const dir = await tempSpool()
  const { readLedger } = await import('../lib/index.js')
  const parsed = await readLedger(ledgerPath(ADDRESS, dir))
  assert.deepEqual(parsed.events, [])
  assert.equal(parsed.bad_lines, 0)
})

// -------------------------------------------------------------- ② 幂等消费

await check('selectFreshEvents: 同一个 message_id 一次消费窗口内只出现一次', async () => {
  const events = [
    ev('m1', '2026-10-01T09:00:00Z'),
    ev('m2', '2026-10-01T09:01:00Z'),
    ev('m1', '2026-10-01T09:00:00Z'), // 同一封信被 ledger 两次（DM-2：多个 daemon 同盯一个凭据）
  ]
  const selection = selectFreshEvents(events)
  assert.deepEqual(selection.fresh.map((e) => e.message_id), ['m1', 'm2'])
  assert.equal(selection.duplicates, 1)
  assert.equal(selection.unconsumed, 3, '未消费条数含重复（它就是账本里的行数）')
})

await check('selectFreshEvents: 锚点取【最后一次】出现，锚点自己的重复副本不再叫', async () => {
  const events = [
    ev('m1', '2026-10-01T09:00:00Z'),
    ev('m2', '2026-10-01T09:01:00Z'),
    ev('m1', '2026-10-01T09:00:00Z'),
    ev('m2', '2026-10-01T09:01:00Z'),
    ev('m3', '2026-10-01T09:02:00Z'),
  ]
  const selection = selectFreshEvents(events, { anchor: 'm2' })
  assert.equal(selection.anchor_index, 3, '锚点定位到第二次出现')
  assert.deepEqual(selection.fresh.map((e) => e.message_id), ['m3'])
  assert.equal(selection.next_anchor, 'm3')
  assert.equal(selection.anchor_found, true)
})

await check('selectFreshEvents: 乱序追加不丢（按 received_at 升序交回，同 id 仍只留一条）', async () => {
  const events = [
    ev('m2', '2026-10-01T09:10:00Z'),
    ev('m3', '2026-10-01T09:05:00Z'), // 比上一行更早（乱序）
    ev('m3', '2026-10-01T09:05:00Z'),
  ]
  const selection = selectFreshEvents(events)
  assert.deepEqual(selection.fresh.map((e) => e.message_id), ['m3', 'm2'], '时间升序；乱序事件不丢')
})

await check('幂等：两轮消费 + commit，重复事件只唤醒一次', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const now = Date.parse('2026-10-01T09:30:00Z')
  const consumer = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => now })

  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T09:00:00Z'), ledgerLine('m2', '2026-10-01T09:01:00Z')])

  // 第一轮：没有游标 ⇒ 只立基线，绝不把历史邮件倒进会话。
  const first = await consumer.pollOnce()
  assert.equal(first.baseline, true)
  assert.deepEqual(first.fresh, [], '首次消费不报历史')
  assert.equal(first.top_up.topUp, false)
  assert.equal(first.top_up.bootstrap, true)
  await first.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm2', '基线落到账本尾部')

  // 第二轮：真新信 ⇒ 叫一次。
  await appendFile(file, `${ledgerLine('m3', '2026-10-01T09:20:00Z')}\n`)
  const second = await consumer.pollOnce()
  assert.equal(second.baseline, false)
  assert.deepEqual(second.fresh.map((e) => e.message_id), ['m3'])
  await second.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm3')

  // 第三轮：同一个 m1 又被 ledger 一次（在锚点之后）⇒ 不能再叫。
  await appendFile(file, `${ledgerLine('m1', '2026-10-01T09:00:00Z')}\n`)
  const third = await consumer.pollOnce()
  assert.deepEqual(third.fresh, [], '已确认过的 id 不再唤醒')
  assert.equal(third.duplicates, 1)
  await third.commit()
})

await check('幂等：重复轮次里账本没长 ⇒ fresh 恒为空（重复 poll 不放大）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const consumer = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => Date.parse('2026-10-01T09:30:00Z') })
  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T09:00:00Z')])

  const baseline = await consumer.pollOnce()
  await baseline.commit()
  for (let round = 0; round < 3; round += 1) {
    const poll = await consumer.pollOnce()
    assert.deepEqual(poll.fresh, [], `第 ${round + 2} 轮不该再有新事件`)
    await poll.commit()
  }
})

await check('已知边界（写进文档，不假装解决）：进程重启后「锚点之后的同 id 重复」只由服务器 unprocessed 兜底', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T09:00:00Z'), ledgerLine('m2', '2026-10-01T09:01:00Z')])
  await writeConsumerCursor(cursorFile, 'm2')
  await appendFile(file, `${ledgerLine('m1', '2026-10-01T09:00:00Z')}\n`)

  // 新进程 = 空的进程内去重环；锚点只能挡住它**之前**的副本。
  const restarted = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => Date.parse('2026-10-01T09:30:00Z') })
  const poll = await restarted.pollOnce()
  assert.deepEqual(poll.fresh.map((e) => e.message_id), ['m1'], '锚点之后的重复会被当成新事件（本骨架的已知边界）')
  // ⇒ 真正的兜底是唤醒路径上的 folder=unprocessed 复核（watch.ts 的 onlyUnprocessed，v1.20），
  //    以及去重环持久化（留给阶段二）。这条断言是为了不让边界悄悄漂移。
})

// -------------------------------------------------------------- ③ 滞后计算

await check('computeCursorLag: 已跟上 = 0；积压 = 最老那封的年龄；另给 cursor_age', async () => {
  const events = [
    ev('m1', '2026-10-01T00:00:00Z'),
    ev('m2', '2026-10-01T00:10:00Z'),
    ev('m3', '2026-10-01T00:20:00Z'),
  ]
  const now = Date.parse('2026-10-01T00:25:00Z')

  const caughtUp = computeCursorLag(events, selectFreshEvents(events, { anchor: 'm3' }), now)
  assert.equal(caughtUp.lag_seconds, 0, '游标在账本尾部 ⇒ 滞后 0')
  assert.equal(caughtUp.unconsumed, 0)
  assert.equal(caughtUp.cursor_age_seconds, 300, '距最后一次确认 5 分钟')
  assert.equal(caughtUp.anchor_found, true)

  const behind = computeCursorLag(events, selectFreshEvents(events, { anchor: 'm1' }), now)
  assert.equal(behind.unconsumed, 2)
  assert.equal(behind.lag_seconds, 900, '最老的未消费事件（m2，00:10）距今 15 分钟 —— 取最老而不是最新')
  assert.equal(behind.cursor_age_seconds, 1500)
})

await check('computeCursorLag: 没有锚点 = undefined；锚点不在账本 = anchor_found:false', async () => {
  const events = [ev('m1', '2026-10-01T00:00:00Z')]
  assert.equal(computeCursorLag(events, selectFreshEvents(events), Date.now()), undefined, '没游标就没有「滞后」可言')

  const lost = computeCursorLag(events, selectFreshEvents(events, { anchor: 'm-GONE' }), Date.parse('2026-10-01T01:00:00Z'))
  assert.equal(lost.anchor_found, false)
  assert.equal(lost.anchor_message_id, 'm-GONE')
})

await check('游标文件：裸 message_id（平台 compact 靠它定位），阈值内原子写，消费者名不许带点', async () => {
  const dir = await tempSpool()
  const file = consumerCursorPath(ADDRESS, CONSUMER, dir)
  assert.ok(file.endsWith(`${ADDRESS}.${CONSUMER}.cursor`), `游标文件名必须是 <address>.<consumer>.cursor：${file}`)
  assert.equal(DEFAULT_CONSUMER.includes('.'), false, '默认消费者名不能含点（否则平台切不出是谁的游标）')

  await writeConsumerCursor(file, '  msg_x  ')
  assert.equal(await readFile(file, 'utf8'), 'msg_x\n', '裸 id + 换行，不是 JSON（compact 用字符串定位 anchor line）')
  assert.equal(await readConsumerCursor(file), 'msg_x')
  assert.equal(existsSync(`${file}.tmp-${process.pid}`), false, '不留临时文件')

  assert.throws(() => assertConsumerName('a.b'), /consumer name/)
  assert.throws(() => assertConsumerName('a/b'), /consumer name/)
  assert.throws(() => assertConsumerName(''), /consumer name/)
  await assert.rejects(() => writeConsumerCursor(file, '   '), /empty consumer cursor/)
})

await check('readConsumerLag: 只读（不改任何文件），并向 msg9_status 交出滞后秒数', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const events = [ledgerLine('m1', '2026-10-01T00:00:00Z'), ledgerLine('m2', '2026-10-01T00:20:00Z')]

  await writeLedgerFile(file, events)
  assert.equal(await readConsumerLag(ADDRESS, CONSUMER, { spoolDir: dir }), undefined, '没游标 ⇒ undefined（尚未建立基线）')
  assert.equal(existsSync(cursorFile), false, '只读路径绝不创建游标文件')

  await writeConsumerCursor(cursorFile, 'm1')
  const lag = await readConsumerLag(ADDRESS, CONSUMER, { spoolDir: dir, now: Date.parse('2026-10-01T00:25:00Z') })
  assert.equal(lag.lag_seconds, 300, 'm2 已经等了 5 分钟')
  assert.equal(lag.unconsumed, 1)
  assert.equal(lag.anchor_message_id, 'm1')
})

// -------------------------------------------------------------- ④ 补齐判据

await check('decideTopUp: 判据表（显式 / bootstrap / 锚点丢失 / daemon 掉线 / 滞后阈值）', async () => {
  const base = { hasCursor: true, anchorFound: true, lagSeconds: 0 }

  assert.deepEqual(decideTopUp({ ...base, force: true }).reason, 'explicit')

  const bootstrap = decideTopUp({ hasCursor: false, anchorFound: false })
  assert.equal(bootstrap.topUp, false, '首次消费不补齐，只立基线')
  assert.equal(bootstrap.bootstrap, true)

  assert.equal(decideTopUp({ ...base, anchorFound: false }).reason, 'anchor-lost')
  assert.equal(decideTopUp({ ...base, daemon: 'stalled' }).reason, 'daemon-down')
  assert.equal(decideTopUp({ ...base, daemon: 'dead' }).reason, 'daemon-down')
  assert.equal(decideTopUp({ ...base, daemon: 'disconnected' }).reason, 'daemon-disconnected', 'T-46②：connected:false 与掉线是同一个缺口')
  assert.equal(decideTopUp({ ...base, daemon: 'up' }).topUp, false)
  assert.equal(decideTopUp({ ...base, daemon: 'unknown' }).topUp, false, '健康未知就不猜，只按滞后判')

  const threshold = 5 * 60_000
  assert.equal(decideTopUp({ ...base, lagSeconds: 299, lagThresholdMs: threshold }).topUp, false, '阈值内不触发')
  assert.equal(decideTopUp({ ...base, lagSeconds: 301, lagThresholdMs: threshold }).reason, 'lag', '超阈值触发')
  assert.equal(decideTopUp({ ...base, lagSeconds: 99999, lagThresholdMs: 0 }).topUp, false, '阈值 0 = 关闭「按滞后触发」')
  assert.equal(decideTopUp({ ...base, lagSeconds: undefined, lagThresholdMs: threshold }).topUp, false)
})

await check('selectTopUpMessages: 只挑没确认过的，同 id 只留一条', async () => {
  const messages = [{ message_id: 'm1' }, { message_id: 'm1' }, { message_id: 'm9' }, { message_id: '' }, { message_id: undefined }]
  assert.deepEqual(selectTopUpMessages(messages, ['m1']).map((m) => m.message_id), ['m9'])
  assert.deepEqual(selectTopUpMessages(messages).map((m) => m.message_id), ['m1', 'm9'])
})

await check('补齐路径：滞后超阈值 ⇒ 自动走 inbox unread，且只取没确认过的', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const now = Date.parse('2026-10-01T00:30:00Z')
  let fetches = 0

  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T00:00:00Z')])
  await writeConsumerCursor(cursorFile, 'm1')
  // 账本里有一封 20 分钟前的信没消费 —— 说明我们离开过，账本可能还缺行（daemon 离线期间不进账本）。
  await appendFile(file, `${ledgerLine('m2', '2026-10-01T00:10:00Z')}\n`)

  const consumer = createLedgerConsumer({
    address: ADDRESS,
    consumer: CONSUMER,
    spoolDir: dir,
    now: () => now,
    lagThresholdMs: 5 * 60_000,
    fetchUnread: async () => {
      fetches += 1
      return [{ message_id: 'm1' }, { message_id: 'm2' }, { message_id: 'm-offline' }]
    },
  })

  const poll = await consumer.pollOnce()
  assert.equal(poll.lag.lag_seconds, 1200, '滞后 20 分钟')
  assert.equal(poll.top_up.reason, 'lag')
  assert.equal(fetches, 1, '补齐被调用了一次')
  assert.deepEqual(poll.fresh.map((e) => e.message_id), ['m2'])
  assert.deepEqual(poll.top_up_messages.map((m) => m.message_id), ['m-offline'], 'm1（已确认）与 m2（本批账本事件）都不重复取')
  await poll.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm2', 'commit 后游标推进到本批最后一条账本事件')
})

await check('补齐路径：没有触发条件时绝不调 fetchUnread（不做无谓的 API 调用）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  let fetches = 0
  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T00:00:00Z')])
  await writeConsumerCursor(cursorFile, 'm1')

  const consumer = createLedgerConsumer({
    address: ADDRESS,
    consumer: CONSUMER,
    spoolDir: dir,
    now: () => Date.parse('2026-10-01T00:00:30Z'),
    fetchUnread: async () => {
      fetches += 1
      return []
    },
  })
  const poll = await consumer.pollOnce()
  assert.equal(poll.top_up.topUp, false)
  assert.equal(poll.lag.lag_seconds, 0)
  assert.equal(fetches, 0)
})

await check('补齐路径：daemon 报 stalled ⇒ 即便账本零滞后也补齐（它掉线期间的信根本没进账本）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T00:00:00Z')])
  await writeConsumerCursor(cursorFile, 'm1')

  const consumer = createLedgerConsumer({
    address: ADDRESS,
    consumer: CONSUMER,
    spoolDir: dir,
    now: () => Date.parse('2026-10-01T00:00:01Z'),
    lagThresholdMs: 0, // 关掉滞后判据，只剩 daemon 健康这一条
    daemonHealth: async () => 'stalled',
    fetchUnread: async () => [{ message_id: 'm-never-ledgered' }],
  })
  const poll = await consumer.pollOnce()
  assert.equal(poll.top_up.reason, 'daemon-down')
  assert.deepEqual(poll.top_up_messages.map((m) => m.message_id), ['m-never-ledgered'])
})

await check('补齐路径：锚点不在账本（被压缩/换了消费者名）⇒ 不猜位置，直接补齐', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  await writeLedgerFile(file, [ledgerLine('m5', '2026-10-01T00:00:00Z')])
  await writeConsumerCursor(cursorFile, 'm-GONE')

  const consumer = createLedgerConsumer({
    address: ADDRESS,
    consumer: CONSUMER,
    spoolDir: dir,
    now: () => Date.parse('2026-10-01T00:00:01Z'),
    fetchUnread: async () => [{ message_id: 'm5' }],
  })
  const poll = await consumer.pollOnce()
  assert.equal(poll.top_up.reason, 'anchor-lost')
  assert.equal(poll.lag.anchor_found, false)
  assert.deepEqual(poll.fresh.map((e) => e.message_id), ['m5'], '账本里的 m5 仍然照投（不因为锚点丢了就丢信）')
})

await check('补齐路径：只有 commit 才推进游标（没有活会话 ⇒ 不 commit ⇒ 下轮重投）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const consumer = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => Date.parse('2026-10-01T00:10:00Z') })

  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T00:00:00Z')])
  const baseline = await consumer.pollOnce()
  await baseline.commit()

  await appendFile(file, `${ledgerLine('m2', '2026-10-01T00:05:00Z')}\n`)
  const parked = await consumer.pollOnce() // 模拟「409 无活会话」：拿到批次但不 commit
  assert.deepEqual(parked.fresh.map((e) => e.message_id), ['m2'])
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm1', 'pollOnce 绝不写游标')

  const retried = await consumer.pollOnce()
  assert.deepEqual(retried.fresh.map((e) => e.message_id), ['m2'], '同一封信重投（而不是被跳过）')
  await retried.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm2', '确认后才推进')
})

await check('坏行 + 消费：一条坏账不能让消费者瞎掉（照投好行，计数上报）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  await writeConsumerCursor(cursorFile, 'm0')
  await writeLedgerFile(file, [
    ledgerLine('m0', '2026-10-01T00:00:00Z'),
    '{"v":1,"type":"new_mes', // 崩溃点半行
    ledgerLine('m1', '2026-10-01T00:01:00Z'),
  ])

  const consumer = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => Date.parse('2026-10-01T00:02:00Z') })
  const poll = await consumer.pollOnce()
  assert.equal(poll.bad_lines, 1)
  assert.deepEqual(poll.fresh.map((e) => e.message_id), ['m1'])
  await poll.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm1', '锚点跨过坏行前进（信不因为通知行坏了而丢：服务器才是真相源）')
})

// ======================================================================
// T-46 ⑤：空账本 / 无账本 ⇒ 哨兵游标（第一封信不再被静默吞掉）
// ======================================================================

await check('⑤ T-46①：账本文件还不存在 ⇒ 落**哨兵游标**（不再"永远 bootstrap"）；第一封信必须被唤醒', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const logs = []
  const now = () => Date.parse('2026-10-01T09:30:00Z')
  const make = () => createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now, log: (message) => logs.push(message) })

  // ① 账本文件还不存在（平台 daemon 收到第一封信才创建它）。
  const consumer = make()
  const step1 = await consumer.pollOnce()
  assert.equal(step1.baseline, true, '没有游标 ⇒ 首轮仍是 bootstrap（不变量）')
  assert.equal(step1.ledger_exists, false, 'poll 必须告诉我们账本文件在不在')
  assert.equal(step1.ledger_events, 0)
  assert.deepEqual(step1.fresh, [], '空账本没有历史可报')
  await step1.commit()
  assert.equal(
    (await readFile(cursorFile, 'utf8')).trim(),
    EMPTY_LEDGER_CURSOR,
    '**空账本基线必须写出哨兵游标** —— 否则 commit 无字可写、下一轮还是 bootstrap',
  )
  assert.equal(await readConsumerCursor(cursorFile), EMPTY_LEDGER_CURSOR)
  assert.equal(isEmptyLedgerCursor(EMPTY_LEDGER_CURSOR), true)
  assert.equal(isEmptyLedgerCursor('msg_first_ever'), false)
  assert.ok(
    logs.some((message) => message.includes('哨兵基线') && message.includes(ADDRESS)),
    `空账本必须留下日志（这件事不许再静默）：${JSON.stringify(logs)}`,
  )

  // ② **第一封信到达** ⇒ 账本文件第一次出现，而且文件里只有这一行。
  //    T-45 §5c 实测的缺陷正是这里：这一行被当成"基线历史"静默吞掉。
  await writeFile(file, `${ledgerLine('msg_first_ever', '2026-10-01T09:00:00Z')}\n`, 'utf8')
  const step2 = await consumer.pollOnce()
  assert.equal(step2.baseline, false, '哨兵之后不再是首次消费')
  assert.deepEqual(step2.fresh.map((event) => event.message_id), ['msg_first_ever'], '**第一封信不许被吞**')
  await step2.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'msg_first_ever', '真实 id 覆盖哨兵')

  // ③ 第二封照常唤醒（哨兵只影响"文件起点"这一次）。
  await appendFile(file, `${ledgerLine('msg_second', '2026-10-01T09:05:00Z')}\n`)
  const step3 = await consumer.pollOnce()
  assert.deepEqual(step3.fresh.map((event) => event.message_id), ['msg_second'])
})

await check('⑤b 哨兵 = "文件起点之前"：既不是锚点丢失（不白跑补齐），也不吞掉后来的行', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const now = Date.parse('2026-10-01T09:30:00Z')

  // 空账本 + 哨兵：位置是明确的、没有积压 ⇒ 不该触发 anchor-lost 补齐。
  await writeConsumerCursor(cursorFile, EMPTY_LEDGER_CURSOR)
  const parsed = await readLedger(file)
  assert.equal(parsed.exists, false, 'readLedger 把"文件不存在"与"文件为空"都当空账本，但如实报告 exists')
  const empty = selectFreshEvents(parsed.events, { anchor: EMPTY_LEDGER_CURSOR })
  assert.equal(empty.anchor_found, true, '哨兵是**明确的位置**，不是"找不到的锚点"')
  assert.equal(empty.unconsumed, 0)
  assert.equal(empty.next_anchor, EMPTY_LEDGER_CURSOR, '没有新行 ⇒ 游标原地不动（还是哨兵）')
  assert.equal(
    decideTopUp({ hasCursor: true, anchorFound: empty.anchor_found, lagSeconds: 0, lagThresholdMs: 5 * 60_000 }).topUp,
    false,
    '哨兵 + 空账本不许被当成"锚点丢失"（否则每轮白跑一次补齐）',
  )
  const emptyLag = await readConsumerLag(ADDRESS, CONSUMER, { spoolDir: dir, now })
  assert.equal(emptyLag.anchor_found, true)
  assert.equal(emptyLag.lag_seconds, 0)

  // 后来一行到了：哨兵语义 = 所有行都在它之后 ⇒ 滞后 = 最老那一行的年龄。
  await writeFile(file, `${ledgerLine('m1', '2026-10-01T09:00:00Z')}\n`, 'utf8')
  const lag = await readConsumerLag(ADDRESS, CONSUMER, { spoolDir: dir, now })
  assert.equal(lag.anchor_found, true)
  assert.equal(lag.unconsumed, 1)
  assert.equal(lag.lag_seconds, 1800, '哨兵之后那行等了 30 分钟 —— 补齐判据必须看得见它')

  // 文件存在但 0 行（被 truncate 过）走同一条路。
  const dir2 = await tempSpool()
  const file2 = ledgerPath(ADDRESS, dir2)
  await writeFile(file2, '', 'utf8')
  const consumer = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir2, now: () => now })
  const poll = await consumer.pollOnce()
  assert.equal(poll.ledger_exists, true, '文件在')
  assert.equal(poll.ledger_events, 0, '但一行都没有')
  await poll.commit()
  assert.equal((await readFile(consumerCursorPath(ADDRESS, CONSUMER, dir2), 'utf8')).trim(), EMPTY_LEDGER_CURSOR)
})

// ======================================================================
// T-46 ⑥：账本不是按 received_at 有序追加 ⇒ 单轮唤醒上限（剩余下轮）
// ======================================================================

/** 真实形状：一行"断档前最后的"，后面跟着一整块**更早的**回填事件（逆序）。 */
function backfilledLines(count, anchorAt = '2026-10-07T09:00:00Z') {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `msg_back_${String(index).padStart(2, '0')}`,
    at: new Date(Date.parse('2026-09-25T00:00:00Z') - index * 60_000).toISOString(),
  }))
  return { rows, lines: [ledgerLine('msg_anchor', anchorAt), ...rows.map((row) => ledgerLine(row.id, row.at))] }
}

await check('⑥ T-46③：回填块（30 条逆序积压）⇒ 单轮只交 20 条（按**文件序**切），剩余下轮，一条不丢', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const { rows, lines } = backfilledLines(30)
  await writeLedgerFile(file, lines)
  await writeConsumerCursor(cursorFile, 'msg_anchor')
  const consumer = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => Date.parse('2026-10-07T12:00:00Z') })

  const first = await consumer.pollOnce()
  assert.equal(first.fresh.length, DEFAULT_MAX_PER_ROUND, `一轮最多 ${DEFAULT_MAX_PER_ROUND} 条（默认单轮上限）`)
  assert.equal(first.deferred, 10, '剩下 10 条推到下一轮')
  assert.equal(first.lag.unconsumed, 30, 'unconsumed 报的是**真实积压**，不被上限裁剪')
  assert.equal(first.fresh[0].message_id, rows[19].id, '交回的是"文件序前 20 条"里时间最早的那条（批内仍按 received_at 升序）')
  await first.commit()
  assert.equal(
    (await readFile(cursorFile, 'utf8')).trim(),
    rows[19].id,
    '游标推进到**文件序**第 20 条 —— 按时间挑"最老 20 条"会把文件序在它之后的行永久跳过（真丢信）',
  )

  const second = await consumer.pollOnce()
  assert.equal(second.fresh.length, 10, '下一轮接着来')
  assert.equal(second.deferred, 0)
  assert.equal(second.lag.unconsumed, 10)
  await second.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), rows[29].id)

  const third = await consumer.pollOnce()
  assert.deepEqual(third.fresh, [], '第三轮干净了')
  assert.deepEqual(
    [...first.fresh, ...second.fresh].map((event) => event.message_id).sort(),
    rows.map((row) => row.id).sort(),
    '两轮合起来 = 全部 30 条：**一条不丢、一条不重**',
  )
})

await check('⑥b 单轮上限**不作用于基线轮**（否则剩下的历史会被当成新信倒进会话）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const { rows, lines } = backfilledLines(30)
  await writeLedgerFile(file, lines)
  const consumer = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => Date.parse('2026-10-07T12:00:00Z') })

  const baseline = await consumer.pollOnce()
  assert.equal(baseline.baseline, true)
  assert.deepEqual(baseline.fresh, [], '基线轮一条都不唤醒')
  await baseline.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), rows[29].id, '基线必须落到**文件末尾**（不是第 20 条）')
  const after = await consumer.pollOnce()
  assert.deepEqual(after.fresh, [], '基线之后没有新信 ⇒ 一条都不唤醒（30 条历史没有被倒出来）')
})

await check('⑥c 单轮上限也管住补齐批次：没交回的那些留在服务器上，下轮还取得到', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T00:00:00Z')])
  await writeConsumerCursor(cursorFile, 'm1')
  const page = Array.from({ length: 30 }, (_, index) => ({ message_id: `up_${index}` }))
  const consumer = createLedgerConsumer({
    address: ADDRESS,
    consumer: CONSUMER,
    spoolDir: dir,
    now: () => Date.parse('2026-10-01T00:00:01Z'),
    lagThresholdMs: 0,
    maxPerRound: 5,
    daemonHealth: async () => 'stalled',
    fetchUnread: async () => page,
  })
  const poll = await consumer.pollOnce()
  assert.equal(poll.top_up.reason, 'daemon-down')
  assert.deepEqual(poll.top_up_messages.map((message) => message.message_id), ['up_0', 'up_1', 'up_2', 'up_3', 'up_4'], '补齐也只交回 5 封')
  await poll.commit()
  const again = await consumer.pollOnce()
  assert.deepEqual(
    again.top_up_messages.map((message) => message.message_id),
    ['up_5', 'up_6', 'up_7', 'up_8', 'up_9'],
    '上一轮没交回的**不在去重环里** ⇒ 下轮接着取（不是丢弃）',
  )
})

// ======================================================================
// T-46 ⑦：connected:false（进程活着、租户连不上）必须被 decideTopUp 看见
// ======================================================================

await check('⑦ T-46②：daemon 报 disconnected ⇒ 账本零滞后也要走 inbox 补齐（那些信根本没进账本）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  await writeLedgerFile(file, [ledgerLine('m1', '2026-10-01T00:00:00Z')])
  await writeConsumerCursor(cursorFile, 'm1')

  const consumer = createLedgerConsumer({
    address: ADDRESS,
    consumer: CONSUMER,
    spoolDir: dir,
    now: () => Date.parse('2026-10-01T00:00:01Z'),
    lagThresholdMs: 0, // 关掉滞后判据：只剩"连接断了"这一条
    daemonHealth: async () => 'disconnected',
    fetchUnread: async () => [{ message_id: 'm-never-ledgered' }],
  })
  const poll = await consumer.pollOnce()
  assert.equal(poll.lag.lag_seconds, 0, '账本没长 ⇒ 滞后必然是 0（这就是滞后判据覆盖不到的缺口）')
  assert.equal(poll.top_up.topUp, true, '连不上的租户的信不会进账本 ⇒ 必须补齐')
  assert.equal(poll.top_up.reason, 'daemon-disconnected')
  assert.deepEqual(poll.top_up_messages.map((message) => message.message_id), ['m-never-ledgered'])
})

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
