/**
 * T-13 阶段三·第一步：共存交接的三条**机器可判**边界 + ingest 开关骨架 + 死 pid 自愈。
 *
 * 本套件只碰**临时目录**（MSG9_HOME / MSG9_DAEMON_HOME 都指向 mkdtemp），
 * 绝不读写真实的 `~/.msg9/**` 或 `~/.dsh/msg9-daemon/**`。
 *
 * 覆盖：
 *   ① 停 daemon → 发信 → 重启必须补上（不许丢唤醒）；
 *   ② `scope` 是**选择器**、不是**身份**（grep 式断言，对着真实文件跑）；
 *   ③ flat 信箱（无 pod）必须有默认 scope 的 daemon 值守（没覆盖 ⇒ 明确告警）；
 *   ④ ingest 开关：默认 self、值写错回落 self、唤醒来源恰好一个；
 *   ⑤ 死 pid 自愈（只读、容错、不拒绝启动）；
 *   ⑥ ledger 分支端到端（临时 spool 追加一行 ⇒ 唤醒被触发）。
 *
 * Run: node tests/cutover.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// spoolDir()/msg9Home()/daemonHome() 的默认值都走环境变量 —— 测试里全部指向临时目录。
process.env.MSG9_HOME = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-home-'))
process.env.MSG9_DAEMON_HOME = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-daemon-'))

const {
  // ingest 开关
  DEFAULT_INGEST,
  INGEST_ENV,
  assertSingleWakeSource,
  planIngest,
  resolveIngestMode,
  resolveWakeSources,
  // --scope 选择器
  SCOPE_CONTRACT,
  addressTenant,
  daemonScopeCovers,
  parseScopeFlag,
  scopeFlagForAddress,
  scopeNeededFor,
  tryParseScopeFlag,
  // 覆盖 / 健康观测
  DEFAULT_DAEMON_STALE_MS,
  assessDaemonCoverage,
  daemonHealthFromStatus,
  observePlatformDaemon,
  platformDaemonHealth,
  readDaemonLocks,
  readDaemonStatuses,
  relevantStatusTenants,
  scopeFromStatusFile,
  // 死 pid 自愈
  isPidAlive,
  readDaemonPidState,
  // 账本分支
  createLedgerConsumer,
  createLedgerIngest,
  createWatchRuntime,
  planLedgerBatch,
  DEFAULT_CONSUMER,
  EMPTY_LEDGER_CURSOR,
  consumerCursorPath,
  ledgerPath,
  readConsumerCursor,
  writeConsumerCursor,
  // 自研 daemon 的持久化（造死 pid 夹具用）
  createDaemonClient,
  daemonHome,
  writeDaemonInfo,
} = await import('../lib/index.js')

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

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

const ADDRESS = 'dsh@test.msg9.io'
const CONSUMER = 'cutover-test'
// 「断档期补齐」那条路用自己的消费者名：per-consumer 游标互不干扰（本用例顺手实证）。
const OUTAGE_CONSUMER = 'cutover-outage'

async function tempSpool() {
  return mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-spool-'))
}

/** 造一行账本事件：形状与本机实测的 spool 行完全一致。 */
function ledgerLine(messageId, receivedAt, extra = {}) {
  return JSON.stringify({ v: 1, type: 'new_message', address: ADDRESS, message_id: messageId, received_at: receivedAt, ...extra })
}

/** 一条「服务器上的」邮件（unprocessed 页里的形状）。 */
function mail(messageId, extra = {}) {
  return { message_id: messageId, from_address: 'peer@msg9.io', subject: `subject ${messageId}`, body: { text: `body ${messageId}` }, ...extra }
}

/** 一个**肯定不存在**的 pid（超过任何平台的 pid 上限）。 */
const DEAD_PID = 99999999

console.log('dsh-msg9-kit cutover test:')

// ============================================================ ① 停 daemon → 重启

await check('① 停 daemon → 发信 → 重启必须补上：断档期间走 unread 补齐，重启后账本补齐', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  // 两条路各用**自己的** consumer 游标（这也是"per-consumer 游标互不干扰"的实证）。
  const outageConsumerPath = consumerCursorPath(ADDRESS, OUTAGE_CONSUMER, dir)
  // 时钟取在 m2 到达后 2 分钟（< 5 分钟阈值）：这样「不再补齐」只可能由 daemon
  // 健康这一条解释，而不是被滞后判据顺带覆盖。
  const now = Date.parse('2026-10-07T00:12:00Z')

  // 断档前：m1 已经确认（两条路的游标都落在 m1）。
  await writeFile(file, `${ledgerLine('m1', '2026-10-07T00:00:00Z')}\n`, 'utf8')
  await writeConsumerCursor(cursorFile, 'm1')
  await writeConsumerCursor(outageConsumerPath, 'm1')

  // ---- 断档中：daemon 停了，m2 到了服务器但**没进账本**（账本零滞后！）----
  const outage = createLedgerConsumer({
    address: ADDRESS, consumer: OUTAGE_CONSUMER, spoolDir: dir, now: () => now,
    daemonHealth: async () => 'dead',
    fetchUnread: async () => [mail('m1'), mail('m2')],
  })
  const down = await outage.pollOnce()
  assert.equal(down.lag.lag_seconds, 0, '账本没长 ⇒ 滞后是 0，这就是「滞后」判据覆盖不到的缺口')
  assert.equal(down.top_up.topUp, true, '必须有别的判据兜住它')
  assert.equal(down.top_up.reason, 'daemon-down', '判据是 daemon 健康：dead/stalled ⇒ 补齐')
  assert.deepEqual(down.top_up_messages.map((m) => m.message_id), ['m2'], '掉线期间到的 m2 必须被补上 ⇒ 唤醒没丢')
  await down.commit()

  // ---- daemon 重启：它按自己的租户游标回放，m2 终于进了账本 ----
  await appendFile(file, `${ledgerLine('m2', '2026-10-07T00:10:00Z')}\n`)

  // (a) **同一个进程**：m2 刚刚已经用 unread 补齐过了，现在账本又重放它一次
  //     ⇒ 绝不能再叫一次（进程内去重环 + 本轮的 seen 判据）。
  const replay = await outage.pollOnce()
  assert.deepEqual(replay.fresh, [], '断档期已补齐过的 m2，在账本重放时不再唤醒一次')
  assert.equal(replay.duplicates, 1, '同 id 去重计数为 1（这就是"补齐 + 账本"两条来源的合流点）')
  await replay.commit()
  assert.equal((await readFile(outageConsumerPath, 'utf8')).trim(), 'm2', '这条路的游标也只在确认后推进')

  // (b) 新进程（去重环是空的，模拟插件重启）⇒ 账本里的 m2 照投 ⇒ **补上了**（不许丢）。
  const restarted = createLedgerConsumer({ address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => now, daemonHealth: async () => 'up' })
  const up = await restarted.pollOnce()
  assert.deepEqual(up.fresh.map((e) => e.message_id), ['m2'], '重启后账本里那行必须被投（不许丢唤醒）')
  assert.equal(up.top_up.topUp, false, 'daemon 回来了、账本也跟上了 ⇒ 不再补齐（不做无谓的 API 调用）')
  await up.commit()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm2', '确认后才推进游标')

  // (c) 重启但**没有**任何补齐（unread 也拿不到）：账本这一行仍然保证不丢 —— 这就是
  //     "最长断线也要由账本兜底"的那一条（与 500 事件回放上限无关：账本文件在本地）。
  const noTopUp = createLedgerConsumer({
    address: ADDRESS, consumer: CONSUMER, spoolDir: dir, now: () => now,
    daemonHealth: async () => 'up',
    fetchUnread: async () => { throw new Error('unread unreachable') },
  })
  await appendFile(file, `${ledgerLine('m3', '2026-10-07T00:20:00Z')}\n`)
  const noTopUpPoll = await noTopUp.pollOnce()
  assert.deepEqual(noTopUpPoll.fresh.map((e) => e.message_id), ['m3'], '补齐失败也不能丢掉账本这一批')
})

// ===================================================== ② scope 是选择器不是身份

await check('② scope 契约原文（选择器语义 + 别的形状一律拒绝）', async () => {
  assert.ok(SCOPE_CONTRACT.includes('--scope tenant:<pod>.<org>'), '契约里必须有这个精确取值')
  assert.ok(SCOPE_CONTRACT.includes('watches only'), '契约：只盯该租户的凭据（选择器）')
  assert.ok(/rejected/.test(SCOPE_CONTRACT), '契约：别的形状一律被拒绝')
  assert.ok(/never silently degrades/.test(SCOPE_CONTRACT), '契约：绝不静默降级成"盯全部"')
  assert.ok(!/identity/i.test(SCOPE_CONTRACT), '契约里不许把 scope 说成身份')

  // 解析器与平台同一条规矩：拒绝，不猜。
  assert.deepEqual(parseScopeFlag(undefined), { kind: 'machine', label: 'machine' }, '省略 --scope = 盯全部（默认/machine scope）')
  assert.deepEqual(parseScopeFlag('  '), { kind: 'machine', label: 'machine' })
  assert.deepEqual(parseScopeFlag('tenant:dsh.ice'), { kind: 'tenant', pod: 'dsh', org: 'ice', label: 'tenant:dsh.ice' })
  for (const bad of ['tenant:dsh', 'tenant:.ice', 'tenant:dsh.', 'pod.dsh', 'tenant:dsh.ice.msg9.io', 'machine', 'all', 42, {}]) {
    assert.throws(() => parseScopeFlag(bad), /msg9 scope/, `${JSON.stringify(bad)} 必须被拒绝（绝不静默降级）`)
    assert.equal(tryParseScopeFlag(bad), undefined, `容错版对 ${JSON.stringify(bad)} 返回 undefined，不抛`)
  }
})

await check('② grep 式断言：文档/注释里不许把 scope 写成"租户身份"', async () => {
  // 把规矩变成**可判据**：逐行扫真实文件，命中的行必须同行带否定。
  const NEGATIONS = /不是|不许|不对|绝不|永不|而非|not |never|≠/
  const IDENTITY = /身份|identit/i
  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
        await walk(full)
      } else if (entry.name.endsWith('.ts')) {
        files.push(full)
      }
    }
  }
  await walk(join(REPO, 'src'))
  for (const name of await readdir(join(REPO, 'docs'))) if (name.endsWith('.md')) files.push(join(REPO, 'docs', name))
  for (const name of await readdir(REPO)) if (/^README.*\.md$/.test(name)) files.push(join(REPO, name))
  assert.ok(files.length > 20, `要扫的文件太少（${files.length}）—— 路径算错了`)

  const violations = []
  let mentions = 0
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      if (!/scope/i.test(line)) return
      mentions += 1
      if (!IDENTITY.test(line)) return
      if (NEGATIONS.test(line)) return
      violations.push(`${file.slice(REPO.length + 1)}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.ok(mentions > 20, `提到 scope 的行太少（${mentions}）—— 断言扫错了文件`)
  assert.deepEqual(violations, [], `scope 被写成"租户身份"（同行没有否定）：\n${violations.join('\n')}`)

  // 正向：契约的**选择器**语义必须在仓库里有明确声明（否则这条规矩会随文档漂移）。
  const cutoverSrc = await readFile(join(REPO, 'src/host/cutover.ts'), 'utf8')
  assert.ok(/盯\*\*哪些凭据\*\*/.test(cutoverSrc) || cutoverSrc.includes('盯哪些凭据') || cutoverSrc.includes('盯**哪些凭据**'), 'cutover.ts 必须声明 scope 是「盯哪些凭据」的选择器')
  assert.ok(cutoverSrc.includes('选择器'), 'cutover.ts 必须写明 scope 是选择器')
  const doc = await readFile(join(REPO, 'docs/COEXISTENCE-HANDOVER.md'), 'utf8')
  assert.ok(doc.includes('--scope tenant:<pod>.<org>'), '交接清单里必须有契约原文里的取值')
  assert.ok(doc.includes('选择器') && doc.includes('盯哪些凭据'), '交接清单必须声明 scope 的选择器语义')
  assert.ok(/不是\*\*身份\*\*|不是\*\*「我是谁」/.test(doc) || doc.includes('不是**身份**'), '交接清单必须明确"不是身份"')
})

// ============================================== ③ flat 信箱必须有默认 scope 值守

await check('③ flat 信箱（无 pod）只能由默认 scope 值守：没覆盖 ⇒ 明确告警（可判据）', async () => {
  // 地址形态：pod 形态 vs 扁平形态。
  assert.deepEqual(addressTenant('dsh@dsh.ice.msg9.io'), { kind: 'pod', pod: 'dsh', org: 'ice' })
  assert.deepEqual(addressTenant('kimi@mum.ice.msg9.io'), { kind: 'pod', pod: 'mum', org: 'ice' })
  assert.deepEqual(addressTenant('dsh@msg9.io'), { kind: 'flat' }, '没有 pod 段 ⇒ flat')
  assert.deepEqual(addressTenant('dsh@dsh-alpha.msg9.io'), { kind: 'flat' }, '只有一段 head ⇒ 扁平常量域，不是 pod')
  assert.deepEqual(addressTenant('dsh@dsh.ice.msg9.io', { org: 'other' }), { kind: 'flat' }, 'org 不符 ⇒ 不属于该 org')

  assert.equal(scopeNeededFor('dsh@dsh.ice.msg9.io'), 'tenant')
  assert.equal(scopeNeededFor('dsh@msg9.io'), 'machine', 'flat 只能靠默认（machine）scope')
  assert.equal(scopeFlagForAddress('dsh@dsh.ice.msg9.io'), 'tenant:dsh.ice')
  assert.equal(scopeFlagForAddress('dsh@msg9.io'), undefined, 'flat 没有可用的 --scope 取值')

  const tenantScope = parseScopeFlag('tenant:dsh.ice')
  const machineScope = parseScopeFlag(undefined)
  assert.equal(daemonScopeCovers(tenantScope, 'dsh@dsh.ice.msg9.io'), true)
  assert.equal(daemonScopeCovers(tenantScope, 'kimi@dsh.ice.msg9.io'), true, '同租户的其他 agent 也盯')
  assert.equal(daemonScopeCovers(tenantScope, 'dsh@msg9.io'), false, '**tenant scope 永远盯不到 flat 地址**')
  assert.equal(daemonScopeCovers(tenantScope, 'dsh@other.ice.msg9.io'), false, '别的 pod 不盯')
  assert.equal(daemonScopeCovers(machineScope, 'dsh@msg9.io'), true, '默认 scope 盯全部（含 flat）')

  // 只有 tenant scope 在跑：flat 地址没覆盖 ⇒ 必须出告警。
  const report = assessDaemonCoverage(['dsh@dsh.ice.msg9.io', 'dsh@msg9.io'], [tenantScope])
  assert.deepEqual(report.uncovered, ['dsh@msg9.io'])
  assert.equal(report.warnings.length, 1)
  assert.equal(report.warnings[0].code, 'no-daemon-coverage')
  assert.equal(report.warnings[0].flat, true)
  assert.ok(report.warnings[0].text.includes('dsh@msg9.io'), '告警必须点名那个地址')
  assert.ok(/no daemon covers/.test(report.warnings[0].text) && report.warnings[0].text.includes('没有任何 daemon 覆盖'), '告警文案必须明确（可判据）')
  const flatVerdict = report.verdicts.find((v) => v.address === 'dsh@msg9.io')
  assert.equal(flatVerdict.needs, 'machine')
  assert.equal(flatVerdict.covered, false)

  // 默认 scope 的 daemon 在跑 ⇒ 两个地址都被覆盖、零告警。
  const good = assessDaemonCoverage(['dsh@dsh.ice.msg9.io', 'dsh@msg9.io'], [tenantScope, machineScope])
  assert.deepEqual(good.uncovered, [])
  assert.deepEqual(good.warnings, [])
  assert.deepEqual(good.verdicts.find((v) => v.address === 'dsh@dsh.ice.msg9.io').covered_by.map((s) => s.label), ['tenant:dsh.ice', 'machine'])
})

await check('③ 死 pid 的锁不算"有人值守"：flat 地址该报警就得报警', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-locks-'))
  await writeFile(join(home, 'daemon.lock.machine-TEST'), `${DEAD_PID}\n`, 'utf8')
  const afterDead = await readDaemonLocks(home)
  assert.deepEqual(afterDead.map((lock) => ({ level: lock.level, id: lock.id, alive: lock.alive, stale: lock.stale })), [
    { level: 'machine', id: 'TEST', alive: false, stale: true },
  ])
  const scopesFromDead = afterDead.filter((lock) => lock.alive && lock.scope).map((lock) => lock.scope)
  const reportDead = assessDaemonCoverage(['dsh@msg9.io'], scopesFromDead, { staleLocks: afterDead.filter((l) => l.stale).map((l) => l.file) })
  assert.deepEqual(reportDead.uncovered, ['dsh@msg9.io'], '死 pid 的锁 ⇒ 这个地址其实没人值守')
  assert.deepEqual(reportDead.stale_locks, ['daemon.lock.machine-TEST'])

  // 换成活 pid（本进程）⇒ 同一条锁立刻算"有人值守"。
  await writeFile(join(home, 'daemon.lock.machine-TEST'), `${process.pid}\n`, 'utf8')
  const afterAlive = await readDaemonLocks(home)
  assert.equal(afterAlive[0].alive, true)
  assert.equal(afterAlive[0].stale, false)
  assert.deepEqual(afterAlive[0].scope, { kind: 'machine', label: 'machine' })
  const reportAlive = assessDaemonCoverage(['dsh@msg9.io'], afterAlive.map((lock) => lock.scope))
  assert.deepEqual(reportAlive.uncovered, [])
})

// ===================================================== ④ ingest 开关（默认 self）

await check('④ 默认值断言：不配置就是 self（默认行为一字不改）', async () => {
  assert.equal(DEFAULT_INGEST, 'self')
  assert.equal(INGEST_ENV, 'MSG9_INGEST')
  const byDefault = resolveIngestMode({})
  assert.deepEqual(byDefault, { mode: 'self', source: 'default' })
  assert.deepEqual(resolveIngestMode({ env: undefined }), { mode: 'self', source: 'default' })
  assert.deepEqual(resolveIngestMode({ env: '' }), { mode: 'self', source: 'default' })
  assert.equal(resolveIngestMode({ config: 'ledger' }).mode, 'ledger', '显式配置才切')
  assert.deepEqual(resolveIngestMode({ config: 'ledger' }), { mode: 'ledger', source: 'config' })
  assert.deepEqual(resolveIngestMode({ env: 'ledger' }), { mode: 'ledger', source: 'env' })
  assert.equal(resolveIngestMode({ config: 'self', env: 'ledger' }).mode, 'self', '配置优先于环境变量')

  // 值写错 ⇒ **回落 self** 并给 warning（绝不静默换掉唤醒路径）。
  for (const bad of ['ledger2', 'SELF ', 'true', 1, {}]) {
    const resolution = resolveIngestMode({ config: bad })
    assert.equal(resolution.mode, 'self', `${JSON.stringify(bad)} 必须回落 self`)
    if (typeof bad === 'string' && bad.trim().toLowerCase() === 'self') continue
    assert.ok(resolution.warning && resolution.warning.includes('keeping the default'), `值写错必须给出 warning：${JSON.stringify(bad)}`)
  }
  const misspelled = resolveIngestMode({ env: 'ledgr' })
  assert.equal(misspelled.mode, 'self')
  assert.match(misspelled.warning, /MSG9_INGEST="ledgr"/)

  // 大小写/空白容错，但整词必须对得上。
  assert.equal(resolveIngestMode({ config: ' LEDGER ' }).mode, 'ledger')
})

await check('④ self 的接线计划与改前逐项一致；ledger 只剩一个唤醒来源', async () => {
  const self = planIngest('self')
  assert.deepEqual(self, { mode: 'self', selfDaemon: true, inProcessWatcher: true, ledgerLoop: false }, 'self = 改前的两条候补来源')
  assert.deepEqual(planIngest(), self, '缺省参数就是 self')
  assert.deepEqual(planIngest('self', { daemonDisabled: true }), { mode: 'self', selfDaemon: false, inProcessWatcher: true, ledgerLoop: false }, 'MSG9_WATCH_DAEMON=0 时与改前一致')
  const ledger = planIngest('ledger')
  assert.deepEqual(ledger, { mode: 'ledger', selfDaemon: false, inProcessWatcher: false, ledgerLoop: true })

  // **不变量**：同一时刻只能有一个唤醒来源。self 的两条互斥（daemon-first 的既有语义）。
  assert.deepEqual(resolveWakeSources(self, true), ['self-daemon'])
  assert.deepEqual(resolveWakeSources(self, false), ['in-process-watcher'])
  assert.deepEqual(resolveWakeSources(ledger, false), ['ledger-consumer'])
  assert.deepEqual(resolveWakeSources(ledger, true), ['ledger-consumer'], '自研 daemon 连上了也不许喂唤醒（双唤醒噪声）')
  assert.equal(assertSingleWakeSource(self, true), 'self-daemon')
  assert.equal(assertSingleWakeSource(self, false), 'in-process-watcher')
  assert.equal(assertSingleWakeSource(ledger, true), 'ledger-consumer')
  assert.equal(assertSingleWakeSource(ledger, false, { watchDisabled: false }), 'ledger-consumer')

  // 守卫真的会拦：一个"两条来源都要"的计划必须抛错。
  const broken = { mode: 'ledger', selfDaemon: false, inProcessWatcher: true, ledgerLoop: true }
  assert.throws(() => assertSingleWakeSource(broken, false), /exactly ONE wake source/)
  const none = { mode: 'self', selfDaemon: false, inProcessWatcher: false, ledgerLoop: false }
  assert.throws(() => assertSingleWakeSource(none, false), /got 0/)
  assert.equal(assertSingleWakeSource(none, false, { watchDisabled: true }), 'ledger-consumer', 'MSG9_WATCH=0 刻意的零来源是唯一例外')
})

// ============================================================ ⑤ 死 pid 自愈

await check('⑤ 死 pid 自愈：daemon.json 指向死 pid ⇒ 当它没有（不拒绝启动、不改文件）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-deadpid-'))
  const path = join(home, 'daemon.json')

  // 没有文件：不是错误。
  const missing = await readDaemonPidState(home)
  assert.equal(missing.present, false)
  assert.equal(missing.usable, false)

  // 坏内容：也不是错误。
  await writeFile(path, '{ not json', 'utf8')
  assert.equal((await readDaemonPidState(home)).present, false)

  // 指向死 pid：present 但不可用 —— **只读判断，绝不改用户文件**。
  const deadInfo = { pid: DEAD_PID, port: 1, token: 'tok', started_at: '2026-10-01T00:00:00Z', version: 'test', protocol: 1 }
  await writeDaemonInfo(deadInfo, home)
  const before = await readFile(path, 'utf8')
  const dead = await readDaemonPidState(home)
  assert.equal(dead.present, true)
  assert.equal(dead.pid, DEAD_PID)
  assert.equal(dead.alive, false)
  assert.equal(dead.usable, false, '死 pid ⇒ 这份记录当它没有')
  assert.match(dead.detail, /dead pid/)
  assert.equal(await readFile(path, 'utf8'), before, '死 pid 自愈绝不能改用户文件')

  // 活 pid（本进程）：可用。
  await writeDaemonInfo({ ...deadInfo, pid: process.pid }, home)
  const alive = await readDaemonPidState(home)
  assert.equal(alive.alive, true)
  assert.equal(alive.usable, true)

  // pid 判活的口径：ESRCH 才叫死，非整数/非正数不可信。
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(DEAD_PID), false)
  for (const bad of [0, -1, 'abc', null, undefined, 1.5]) assert.equal(isPidAlive(bad), false, `${JSON.stringify(bad)} 不是合法 pid`)

  // 「不能因此拒绝启动」：切换路径带着这份死记录也必须照常启动（而且会去 spawn 新的）。
  await writeDaemonInfo(deadInfo, home)
  let spawns = 0
  const client = createDaemonClient({
    home,
    getPort: () => 0,
    getWorkspaces: async () => [],
    log: () => {},
    spawnDaemon: () => { spawns += 1 }, // 不真的起进程，只记「尝试过」
    bootTimeoutMs: 200,
  })
  const started = await client.start()
  assert.equal(started, false, '没有 daemon 起来 ⇒ start() 回落 false（进程内 watcher 接上）')
  assert.equal(spawns, 1, '死 pid 没让它拒绝启动：它跳过死记录去 spawn 了一个新的')
  await client.stop()
  assert.equal(daemonHome(), process.env.MSG9_DAEMON_HOME, 'daemonHome() 必须吃 MSG9_DAEMON_HOME（测试不能碰真机目录）')
})

await check('⑤ 平台侧健康观测（只读）：活锁/死锁、健康文件两条正交轴', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-health-home-'))
  const spool = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-health-spool-'))
  const now = Date.parse('2026-10-07T12:00:00Z')

  // 什么都没有 ⇒ dead（这正是本机的实测状态：平台锁指向死 pid、没有健康文件）。
  const none = await observePlatformDaemon('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(none.health, 'dead')
  assert.equal(none.source, 'none')
  assert.equal(await platformDaemonHealth('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now }), 'dead')

  // 死 pid 的锁 ⇒ 还是 dead，但要把 stale 锁报出来（留证）。
  await writeFile(join(home, 'daemon.lock.machine-TEST'), `${DEAD_PID}\n`, 'utf8')
  const stale = await observePlatformDaemon('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(stale.health, 'dead')
  assert.deepEqual(stale.stale_locks, ['daemon.lock.machine-TEST'])
  assert.match(stale.detail, /dead pids/)

  // 活锁 + 没有健康文件 ⇒ unknown（daemon 在值班，只是没写状态文件 ⇒ 不猜）。
  await writeFile(join(home, 'daemon.lock.machine-TEST'), `${process.pid}\n`, 'utf8')
  const live = await observePlatformDaemon('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(live.health, 'unknown')
  assert.equal(live.source, 'lock')

  // 没有覆盖该地址的活锁（tenant scope 盯不到 flat 地址）⇒ dead。
  await writeFile(join(home, 'daemon.lock.tenant-dsh.ice'), `${process.pid}\n`, 'utf8')
  const tenantOnly = await observePlatformDaemon('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(tenantOnly.health, 'unknown', 'machine 锁仍在，flat 地址被它覆盖')
  await writeFile(join(home, 'daemon.lock.machine-TEST'), '', 'utf8') // 内容不是 pid ⇒ 不可信 ⇒ 不算覆盖
  const unreadableLock = await observePlatformDaemon('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(unreadableLock.health, 'dead', '内容不是 pid 的锁不足以证明有人值守')

  // 健康文件：新鲜 ⇒ up；stalled ⇒ stalled；过期 ⇒ dead；没字段 ⇒ unknown。
  assert.equal(daemonHealthFromStatus(undefined, { now }), 'unknown')
  assert.equal(daemonHealthFromStatus({ file: 'x', last_beat_ms: now - 1_000, tenants: [] }, { now }), 'up')
  assert.equal(daemonHealthFromStatus({ file: 'x', last_beat_ms: now - 1_000, tenants: [{ tenant: 'ice', state: 'stalled' }] }, { now }), 'stalled')
  // T-46 ④：默认阈值从 15s（=3 拍）放宽到 DEFAULT_DAEMON_STALE_MS（=9 拍）。
  assert.equal(DEFAULT_DAEMON_STALE_MS, 45_000, '默认按 9×5s 心跳取值（保守侧）')
  assert.equal(daemonHealthFromStatus({ file: 'x', last_beat_ms: now - 20_000, tenants: [] }, { now }), 'up', '20s（4 拍）在保守默认下**不再**误判 dead')
  assert.equal(daemonHealthFromStatus({ file: 'x', last_beat_ms: now - 90_000, tenants: [] }, { now }), 'dead')
  assert.equal(
    daemonHealthFromStatus({ file: 'x', last_beat_ms: now - 20_000, tenants: [] }, { now, staleMs: 15_000 }),
    'dead',
    '阈值仍然可配：显式传 15s 就回到改前的口径',
  )
  assert.equal(daemonHealthFromStatus({ file: 'x', tenants: [] }, { now }), 'unknown')
  assert.equal(scopeFromStatusFile('.daemon-status.json').kind, 'machine')
  assert.deepEqual(scopeFromStatusFile('.daemon-status-tenant-dsh.ice.json'), { kind: 'tenant', pod: 'dsh', org: 'ice', label: 'tenant:dsh.ice' })
  assert.equal(scopeFromStatusFile('.daemon-status-weird.json'), undefined)

  await writeFile(join(spool, '.daemon-status.json'), JSON.stringify({
    last_beat: new Date(now - 1_000).toISOString(),
    tenants: [{ tenant: 'ice', state: 'connected' }],
  }), 'utf8')
  const statuses = await readDaemonStatuses(spool)
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].last_beat_ms, now - 1_000, 'RFC3339 的心跳要能解析成 ms')
  assert.equal((await observePlatformDaemon('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now })).health, 'up')

  await writeFile(join(spool, '.daemon-status.json'), JSON.stringify({ last_beat: now - 90_000, tenants: [] }), 'utf8')
  const expired = await observePlatformDaemon('dsh@msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(expired.health, 'dead', '心跳过期 ⇒ 进程没了 ⇒ 补齐（这条判据覆盖"掉线期间没进账本"的缺口）')
  assert.equal(expired.source, 'status')
})

// ================================================= ⑥ ledger 分支端到端（模块级）

await check('⑥ ledger 接入：临时 spool 追加一行 ⇒ 唤醒被触发（且只触发一次）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  const now = Date.parse('2026-10-07T02:00:00Z')

  await writeFile(file, `${ledgerLine('m1', '2026-10-07T01:00:00Z')}\n`, 'utf8')

  const followups = []
  const snapshots = []
  let unprocessedCalls = 0
  let unprocessed = [mail('m1', { created_at: '2026-10-07T01:00:00Z' })]
  const agent = { id: 'sess-1', followup: (m) => followups.push(m), inject: (m) => snapshots.push(m) }
  const deps = {
    loadState: async () => ({ workspaces: {} }),
    setWatchState: async () => {},
    listInbox: async () => {
      unprocessedCalls += 1
      return { messages: unprocessed, unread_count: unprocessed.length }
    },
    resolveAgent: () => agent,
    onInboxSnapshot: (key, snapshot) => snapshots.push({ key, ...snapshot }),
    uuid: () => `u-${followups.length + 1}`,
    now: () => now,
    log: () => {},
  }
  const rt = createWatchRuntime()
  const inbox = { address: ADDRESS, api_key: 'k', api_url: 'http://fake', title: 't', path: '/w' }
  const ingest = createLedgerIngest(deps, rt, 'ws-a', inbox, {
    consumer: CONSUMER,
    spoolDir: dir,
    lagThresholdMs: 0, // 关掉滞后判据：本用例只看「账本追加一行 ⇒ 唤醒」
    daemonHealth: async () => 'up',
  })

  // 第一轮：没有游标 ⇒ 只立基线，绝不把历史邮件倒进会话。
  await ingest.tick()
  assert.equal(followups.length, 0, '首次消费不唤醒')
  assert.equal(unprocessedCalls, 0, '基线轮连 REST 都不打（账本就是触发源）')
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm1', '基线落到账本尾部')

  // 追加一行 + 服务器把正文交出来 ⇒ 唤醒。
  await appendFile(file, `${ledgerLine('m2', '2026-10-07T01:10:00Z')}\n`)
  unprocessed = [mail('m1', { created_at: '2026-10-07T01:00:00Z' }), mail('m2', { created_at: '2026-10-07T01:10:00Z' })]
  await ingest.tick()
  assert.equal(followups.length, 1, '账本追加一行 ⇒ 唤醒被触发')
  assert.match(followups[0].content[0].text, /peer@msg9\.io/, '唤醒里带的是服务器上的真邮件（正文来自 folder=unprocessed）')
  assert.match(followups[0].content[0].text, /subject m2/)
  assert.equal(unprocessedCalls, 1, '一轮只打一次 REST')
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm2', '投递确认后才推进游标')
  assert.equal(ingest.last.freshEvents, 1, '这一轮的账本新事件就是 1 条（滞后观测的输入）')
  assert.equal(ingest.last.lagSeconds, 3000, '投递前它落后了 m2 的 50 分钟（时钟同源，可判据）')

  // 再跑一轮：不重复唤醒，且滞后归零。
  await ingest.tick()
  assert.equal(followups.length, 1, '重复轮次不放大')
  assert.equal(ingest.last.lagSeconds, 0, '跟上之后滞后是 0')

  // 徽章顺带被喂了地址级 unread（省掉一次 REST）。
  assert.ok(snapshots.some((s) => s.key === 'ws-a' && s.unread === 2), `onInboxSnapshot 必须拿到 unread：${JSON.stringify(snapshots)}`)
})

await check('⑥ ledger 补齐：账本零滞后但 daemon 掉了 ⇒ 走 inbox unread（唤醒不丢）', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const now = Date.parse('2026-10-07T03:00:00Z')
  await writeFile(file, `${ledgerLine('m1', '2026-10-07T02:00:00Z')}\n`, 'utf8')
  await writeConsumerCursor(consumerCursorPath(ADDRESS, CONSUMER, dir), 'm1')

  const followups = []
  const agent = { id: 's', followup: (m) => followups.push(m), inject: () => {} }
  const deps = {
    loadState: async () => ({ workspaces: {} }),
    setWatchState: async () => {},
    // daemon 掉线期间到的 m9 只在服务器上（账本里根本没有它）。
    listInbox: async () => ({ messages: [mail('m1'), mail('m9', { created_at: '2026-10-07T02:30:00Z' })], unread_count: 1 }),
    resolveAgent: () => agent,
    uuid: () => `u-${followups.length + 1}`,
    now: () => now,
    log: () => {},
  }
  const ingest = createLedgerIngest(deps, createWatchRuntime(), 'ws-a', { address: ADDRESS, api_key: 'k', api_url: 'http://fake' }, {
    consumer: CONSUMER,
    spoolDir: dir,
    daemonHealth: async () => 'dead',
  })
  await ingest.tick()
  assert.equal(followups.length, 1, '账本没长也要把掉线期间的信叫醒')
  assert.match(followups[0].content[0].text, /subject m9/)
  assert.equal(ingest.last.toppedUp, 1)
  assert.equal(ingest.last.freshEvents, 0)
})

await check('⑥ ledger 的三条不 commit 边界：取不到页 / 没有活会话 / 已暂停', async () => {
  const dir = await tempSpool()
  const file = ledgerPath(ADDRESS, dir)
  const cursorFile = consumerCursorPath(ADDRESS, CONSUMER, dir)
  await writeFile(file, `${ledgerLine('m1', '2026-10-07T01:00:00Z')}\n`, 'utf8')
  await writeConsumerCursor(cursorFile, 'm1')
  await appendFile(file, `${ledgerLine('m2', '2026-10-07T01:10:00Z')}\n`)

  const base = {
    loadState: async () => ({ workspaces: {} }),
    setWatchState: async () => {},
    listInbox: async () => { throw new Error('upstream 500') },
    resolveAgent: () => undefined,
    uuid: () => 'u',
    now: () => Date.parse('2026-10-07T01:20:00Z'),
    log: () => {},
  }
  // (a) 取不到 unprocessed 页 ⇒ 不 commit（下一轮重投）。
  const offline = createLedgerIngest(base, createWatchRuntime(), 'ws-a', { address: ADDRESS, api_key: 'k', api_url: 'http://fake' }, { consumer: CONSUMER, spoolDir: dir, daemonHealth: async () => 'up' })
  await offline.tick()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm1', '取不到正文 ⇒ 游标不动（信在服务器，不丢）')

  // (b) 有正文但没有活会话 ⇒ 不 commit（与 daemon 的 409 ⇒ pending 同义）。
  const page = [mail('m1'), mail('m2')]
  const noSession = createLedgerIngest({ ...base, listInbox: async () => ({ messages: page, unread_count: 1 }) }, createWatchRuntime(), 'ws-a', { address: ADDRESS, api_key: 'k', api_url: 'http://fake' }, { consumer: CONSUMER, spoolDir: dir, daemonHealth: async () => 'up' })
  await noSession.tick()
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm1', '没有活会话 ⇒ 不推进游标 ⇒ 下轮重投')

  // (c) 通知已暂停 ⇒ 跟踪但不投递（推进游标，绝不回放）。
  const followups = []
  const agent = { id: 's', followup: (m) => followups.push(m), inject: () => {} }
  const paused = createLedgerIngest(
    { ...base, listInbox: async () => ({ messages: page, unread_count: 1 }), resolveAgent: () => agent, isPaused: () => true },
    createWatchRuntime(), 'ws-a', { address: ADDRESS, api_key: 'k', api_url: 'http://fake' },
    { consumer: CONSUMER, spoolDir: dir, daemonHealth: async () => 'up' },
  )
  await paused.tick()
  assert.equal(followups.length, 0, '暂停期间不投递')
  assert.equal((await readFile(cursorFile, 'utf8')).trim(), 'm2', '但游标推进（与 self 路径同义：不会事后回放）')

  // (d) 恢复后：账本已经跨过去 ⇒ 不再旧事重提。
  await paused.tick()
  assert.equal(followups.length, 0)
})

await check('⑥ planLedgerBatch：账本事件 → 真邮件（对账掉已闭环的、去重、失败就重试）', async () => {
  const poll = { fresh: [{ message_id: 'm2' }, { message_id: 'm3' }], top_up_messages: [mail('m9'), mail('m2')] }
  // 页取不到 ⇒ retry（绝不 commit）。
  assert.deepEqual(planLedgerBatch(poll, undefined), { deliver: [], topped_up: [], reconciled_away: [], retry: true, fresh_events: 2 })
  // m3 已经不在 unprocessed 页 ⇒ 已在别处闭环（对账掉）；m9 是补齐带上来的。
  const plan = planLedgerBatch(poll, [mail('m2'), mail('m9')])
  assert.deepEqual(plan.deliver.map((m) => m.message_id), ['m2', 'm9'])
  assert.deepEqual(plan.reconciled_away, ['m3'])
  assert.deepEqual(plan.topped_up, ['m9'])
  assert.equal(plan.retry, false)
  assert.equal(plan.fresh_events, 2)
  // 账本说有的，服务器全说"已经处理完了" ⇒ 没什么可投，但也不算重试。
  const allGone = planLedgerBatch({ fresh: [{ message_id: 'm2' }], top_up_messages: [] }, [])
  assert.deepEqual(allGone.deliver, [])
  assert.deepEqual(allGone.reconciled_away, ['m2'])
  assert.equal(allGone.retry, false)
})

await check('⑥ 空账本基线（T-46①）：立哨兵 + **只对账不投递**，日志说清"本轮 N 封不唤醒"；第一封信随后必须唤醒', async () => {
  const dir = await tempSpool()
  const now = Date.parse('2026-10-07T02:00:00Z')
  const logs = []
  const followups = []
  let unprocessedCalls = 0
  const agent = { id: 's1', followup: (message) => followups.push(message), inject: () => {} }
  const deps = {
    loadState: async () => ({ workspaces: {} }),
    setWatchState: async () => {},
    listInbox: async () => {
      unprocessedCalls += 1
      return { messages: [mail('old-1'), mail('old-2')], unread_count: 2 }
    },
    resolveAgent: () => agent,
    uuid: () => 'u-empty-baseline',
    now: () => now,
    log: (message) => logs.push(message),
  }
  const ingest = createLedgerIngest(deps, createWatchRuntime(), 'ws-a', { address: ADDRESS, api_key: 'k', api_url: 'http://fake' }, {
    consumer: CONSUMER,
    spoolDir: dir,
    daemonHealth: async () => 'up',
  })

  // 账本文件还不存在（平台 daemon 收到第一封信才创建它）。
  await ingest.tick()
  assert.equal(followups.length, 0, '空账本基线**绝不投递**（第一次观测不许把历史倒进会话）')
  assert.equal(unprocessedCalls, 1, '空账本基线额外对账一次 —— 只为可观测（有历史的账本仍然是零 REST）')
  assert.equal(
    (await readFile(consumerCursorPath(ADDRESS, CONSUMER, dir), 'utf8')).trim(),
    EMPTY_LEDGER_CURSOR,
    '空账本基线落哨兵 ⇒ 不再"永远 bootstrap"',
  )
  assert.ok(
    logs.some((message) => message.includes('不唤醒') && message.includes('2 封')),
    `日志必须说清"本轮几封不唤醒"（这件事不许再静默）：${JSON.stringify(logs)}`,
  )

  // 第一封信到达 ⇒ 账本文件第一次出现 ⇒ 必须唤醒（T-46 ① 的核心）。
  await writeFile(ledgerPath(ADDRESS, dir), `${ledgerLine('m-new', '2026-10-07T01:59:00Z')}\n`, 'utf8')
  unprocessedCalls = 0
  deps.listInbox = async () => {
    unprocessedCalls += 1
    return { messages: [mail('m-new', { created_at: '2026-10-07T01:59:00Z' })], unread_count: 1 }
  }
  await ingest.tick()
  assert.equal(followups.length, 1, '**账本文件刚出现的那第一封信必须唤醒**（改前它被当成基线吞掉）')
  assert.match(followups[0].content[0].text, /subject m-new/)
  assert.equal(unprocessedCalls, 1, '真正投递的那一轮仍然只打一次 REST')
  assert.equal((await readFile(consumerCursorPath(ADDRESS, CONSUMER, dir), 'utf8')).trim(), 'm-new', '游标从哨兵推进到真实 id')
})

// ============================================= ⑦ T-46② scope 覆盖 ≠ 凭据可用

await check('⑦ T-46②：connected:false 必须被健康判定看见（进程活着 ≠ 这个租户连得上）', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const spool = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-status-'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cutover-statushome-'))
  await writeFile(join(home, 'daemon.lock.machine-TEST'), `${process.pid}\n`, 'utf8')
  // 形状照抄真实 `.daemon-status.json`（本机 2026-10-07）：一份文件里既有
  // `connected:true` 的租户、也有 `connected:false` 的租户与票据。
  await writeFile(join(spool, '.daemon-status.json'), JSON.stringify({
    scope: 'machine-Jiker',
    pid: 68736,
    last_beat: new Date(now - 1_000).toISOString(),
    tenants: [
      { tenant: 'msg9.ice', mode: 'stream', connected: true, stalled: false },
      { tenant: 'kimi.code', mode: 'stream', connected: false, stalled: false },
      { tenant: 'dsh@kimi.ice.msg9.io', mode: 'ticket', connected: false, stalled: false },
      { tenant: 'mum.ice', mode: 'stream', connected: false, stalled: true },
    ],
  }), 'utf8')

  const [status] = await readDaemonStatuses(spool)
  const stateOf = (name) => status.tenants.find((row) => row.tenant === name)?.state
  assert.equal(stateOf('msg9.ice'), 'connected')
  assert.equal(stateOf('kimi.code'), 'disconnected', '**显式 connected:false 不能再落到 unknown**（改前就是这里看不到的）')
  assert.equal(stateOf('dsh@kimi.ice.msg9.io'), 'disconnected')
  assert.equal(stateOf('mum.ice'), 'stalled')

  const opts = { now }
  const statusOf = (address) => daemonHealthFromStatus(status, { ...opts, address })
  // 连接轴必须**按地址**看：同一份文件里，好的租户不许被坏的拖下水。
  assert.equal(statusOf('dsh@msg9.ice.msg9.io'), 'up', 'msg9.ice 是好的 ⇒ up（改前也是 up，但改前所有地址都恒为 up）')
  assert.equal(statusOf('kimi@kimi.code.msg9.io'), 'disconnected', '租户行 connected:false ⇒ 该租户的地址都看得见')
  assert.equal(statusOf('dsh@kimi.ice.msg9.io'), 'disconnected', '**地址级票据行优先**：它比租户行更具体')
  assert.equal(statusOf('kimi@mum.ice.msg9.io'), 'stalled', 'stalled 仍然报 stalled')
  assert.equal(daemonHealthFromStatus(status, opts), 'stalled', '不传 address ⇒ 退回整份文件的聚合判断（改前行为）')
  assert.deepEqual(relevantStatusTenants(status.tenants, 'dsh@kimi.ice.msg9.io').map((row) => row.tenant), ['dsh@kimi.ice.msg9.io'])

  // 端到端：`observePlatformDaemon` 也必须按地址给结论（否则 decideTopUp 还是瞎的）。
  const disconnected = await observePlatformDaemon('dsh@kimi.ice.msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(disconnected.health, 'disconnected')
  assert.equal(disconnected.source, 'status')
  const healthy = await observePlatformDaemon('dsh@msg9.ice.msg9.io', { spoolDir: spool, msg9Home: home, now })
  assert.equal(healthy.health, 'up', '同一个活 daemon 下，另一个地址照样是 up（不许一刀切）')
  // 心跳新鲜但 20s 前 ⇒ 保守默认（45s）不判死（T-46 ④）。
  await writeFile(join(spool, '.daemon-status.json'), JSON.stringify({
    last_beat: new Date(now - 20_000).toISOString(),
    tenants: [{ tenant: 'msg9.ice', connected: true }],
  }), 'utf8')
  assert.equal((await observePlatformDaemon('dsh@msg9.ice.msg9.io', { spoolDir: spool, msg9Home: home, now })).health, 'up')
})

await check('⑦b T-46②：assessDaemonCoverage 把"连接轴 + 凭据轴"接进来，并**显式告警**没有唤醒来源的地址', async () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  const machine = parseScopeFlag(undefined)
  const status = {
    file: '.daemon-status.json',
    scope: machine,
    last_beat_ms: now - 1_000,
    tenants: [
      { tenant: 'msg9.ice', state: 'connected' },
      { tenant: 'dsh@kimi.ice.msg9.io', state: 'disconnected' },
    ],
  }
  const addresses = ['dsh@msg9.ice.msg9.io', 'dsh@kimi.ice.msg9.io', 'ghost@ghost.ice.msg9.io']
  const report = assessDaemonCoverage(addresses, [machine], {
    statuses: [status],
    credentialed: ['dsh@msg9.ice.msg9.io', 'dsh@kimi.ice.msg9.io'],
  })
  const verdict = (address) => report.verdicts.find((row) => row.address === address)

  assert.equal(verdict('dsh@msg9.ice.msg9.io').wake_source, 'ledger')
  assert.equal(verdict('dsh@msg9.ice.msg9.io').connection, 'connected')
  assert.equal(verdict('dsh@msg9.ice.msg9.io').credential, 'present')

  // ⚠️ 核心断言：scope 说"已覆盖"，但连接轴是断的 ⇒ 必须判 top-up-only + 告警。
  assert.equal(verdict('dsh@kimi.ice.msg9.io').covered, true, 'scope 轴确实覆盖（活锁是 machine）')
  assert.equal(verdict('dsh@kimi.ice.msg9.io').connection, 'disconnected')
  assert.equal(verdict('dsh@kimi.ice.msg9.io').wake_source, 'top-up-only')
  const noWake = report.warnings.find((warning) => warning.address === 'dsh@kimi.ice.msg9.io')
  assert.equal(noWake.code, 'no-wake-source', '必须产出**显式**告警（改前这里一条告警都没有）')
  assert.ok(noWake.text.includes('dsh@kimi.ice.msg9.io') && noWake.text.includes('inbox'), `告警要说清兜底是什么：${noWake.text}`)

  // 凭据轴兜底：本机没有凭据的地址 ⇒ 与"没有 scope 覆盖"同级。
  assert.equal(verdict('ghost@ghost.ice.msg9.io').credential, 'absent')
  assert.equal(verdict('ghost@ghost.ice.msg9.io').wake_source, 'none')
  assert.deepEqual(report.uncovered, ['ghost@ghost.ice.msg9.io'])
  assert.equal(report.warnings.find((warning) => warning.address === 'ghost@ghost.ice.msg9.io').code, 'no-daemon-coverage')
  assert.ok(report.warnings.find((warning) => warning.address === 'ghost@ghost.ice.msg9.io').text.includes('credential'))

  // 有健康文件、但一条都没提到它 ⇒ "无法确认"（不许假装已覆盖）。
  const unmentioned = assessDaemonCoverage(['nobody@nowhere.ice.msg9.io'], [machine], { statuses: [status] })
  assert.equal(unmentioned.verdicts[0].connection, 'unreported')
  assert.equal(unmentioned.verdicts[0].wake_source, 'unconfirmed')
  assert.equal(unmentioned.warnings[0].code, 'wake-source-unconfirmed')

  // 不传 statuses / credentialed ⇒ 与改前逐字一致（纯 scope 判定，零告警）。
  const legacy = assessDaemonCoverage(['ghost@ghost.ice.msg9.io'], [machine])
  assert.deepEqual(legacy.warnings, [])
  assert.equal(legacy.verdicts[0].wake_source, 'ledger')
  assert.equal(legacy.verdicts[0].credential, 'unknown')
})

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
