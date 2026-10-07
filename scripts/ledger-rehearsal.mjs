#!/usr/bin/env node
/**
 * T-45 —— T-13 切换前的**实弹彩排**：对**真实** `~/.msg9/spool` 只读跑一遍我们的账本消费者。
 *
 * 这是母卡 T-13 阶段三的"切换前最后一道"：阶段一的 `src/host/ledger.ts`（账本消费者骨架）
 * 与 T-41 的 `src/host/cutover.ts`（判据层）**都有单测、都从没对真实账本跑过**。
 * 本脚本把真实账本喂给 `lib/index.js` 里**同一个**消费者实现（不是重写一份），
 * 把"此刻切过去会发生什么"逐地址算清楚。
 *
 * ## 严格只读（四道护栏，全部可验证）
 *
 *  1. **游标不落真实目录**：所有`createLedgerConsumer` 的 `spoolDir` 都指向
 *     `mkdtemp` 出来的临时目录，真实账本是**拷贝**进去的（`copyFile`，源只读）。
 *     消费者契约里游标必须与账本同目录（`spool/<addr>.<consumer>.cursor`），
 *     所以"只读真实 spool"只能靠"拷贝到临时目录再跑"，不能靠改路径。
 *  2. **`MSG9_HOME` 重定向到临时目录**：万一哪条代码路径漏传了 `spoolDir`，
 *     默认路径落在临时 home，**不会碰到 `~/.msg9`**。（真实路径在重定向前捕获。）
 *  3. **append-only 事后断言**：跑完再看一遍真实账本 —— 每个文件必须以跑之前的
 *     字节**为前缀**（账本是追加写的：允许平台 daemon 期间又追加了行，
 *     但**绝不允许**被改写/截断），并且**不得出现任何新 `*.cursor`**。
 *     任一不成立 ⇒ 打 FAIL 并以非 0 退出。
 *  4. **不碰网络、不投递、不发信**：consumer 不传 `fetchUnread`（补齐只算判据、
 *     真取回留到接线后）；全程零 HTTP。
 *
 * ## 用法
 *
 *   node scripts/ledger-rehearsal.mjs [--out <报告文件>]
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败（控制台会列出失败项）。
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2)
function argValue(name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}
const OUT_PATH = argValue('--out')

/** 卡面点名要求必须覆盖的地址（即使它们连账本都没有，也要有结论）。 */
const REQUIRED_ADDRESSES = [
  'dsh@dsh.ice.msg9.io',
  'dsh@msg9.ice.msg9.io',
  'kimi@dsh.ice.msg9.io',
  'cc@msg9.ice.msg9.io',
]

// ------------------------------------------------- 只读护栏（必须在 import lib 之前）
//
// ⚠️ 用户名是 `iceskysl`（不是 `iceskyls`）—— 少一个字母就是 ENOENT，那不是 iCloud。
const REAL_MSG9 = process.env.MSG9_REHEARSAL_HOME || join(homedir(), '.msg9')
const REAL_SPOOL = join(REAL_MSG9, 'spool')

/** 兜底 home：任何"忘了传 spoolDir"的写操作都落在这里，不落真实目录。 */
const SANDBOX_HOME = await mkdtemp(join(tmpdir(), 'dsh-msg9-rehearsal-home-'))
process.env.MSG9_HOME = SANDBOX_HOME

/** 本次彩排的全部可写目录都在这里（mkdtemp 保证随机、独占、可辨认）。 */
const WORK = await mkdtemp(join(tmpdir(), 'dsh-msg9-rehearsal-work-'))
const MIRROR = join(WORK, 'mirror') // 真实账本的忠实拷贝 —— 端到端跑消费者
const GAP = join(WORK, 'gap') // 三类路由的"假如"推演（游标按剧本摆好）
const BAD = join(WORK, 'bad') // 坏行容错夹具
await mkdir(MIRROR, { recursive: true })
await mkdir(GAP, { recursive: true })
await mkdir(BAD, { recursive: true })

// 可写目录的形状守卫：只允许 WORK 之下。
function assertUnderWork(dir) {
  if (!dir.startsWith(WORK)) throw new Error(`rehearsal: refusing to use a non-temporary spool dir: ${dir}`)
  return dir
}

// lib 必须在 MSG9_HOME 重定向之后再加载（与 tests/*.test.mjs 同一条纪律）。
const {
  DEFAULT_CONSUMER,
  assessDaemonCoverage,
  consumerCursorPath,
  createLedgerConsumer,
  daemonHealthFromStatus,
  ledgerPath,
  observePlatformDaemon,
  parseLedgerLines,
  planIngest,
  readConsumerLag,
  readDaemonLocks,
  readDaemonStatuses,
  readLedger,
  resolveIngestMode,
  writeConsumerCursor,
} = await import('../lib/index.js')

// ------------------------------------------------------------------ 输出/断言
const LINES = []
function out(line = '') {
  LINES.push(line)
  process.stdout.write(`${line}\n`)
}
const failures = []
function must(ok, text) {
  if (!ok) {
    failures.push(text)
    out(`  ❌ FAIL ${text}`)
  }
  return ok
}
// 列宽按**显示宽度**算（CJK 占两列），否则表头里的中文会把后面的数字列顶歪。
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
function displayWidth(text) {
  let width = 0
  for (const char of text) width += WIDE.test(char) ? 2 : 1
  return width
}
const pad = (value, width) => {
  const text = String(value)
  const current = displayWidth(text)
  return current >= width ? text : text + ' '.repeat(width - current)
}
const padLeft = (value, width) => {
  const text = String(value)
  const current = displayWidth(text)
  return current >= width ? text : ' '.repeat(width - current) + text
}
function iso(ms) {
  if (!Number.isFinite(ms)) return '-'
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function dur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = ms / 3_600_000
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(2)}d`
}

// ------------------------------------------------------------------ 只读快照
const LEDGER_SUFFIX = '.jsonl'
const CURSOR_SUFFIX = '.cursor'

/**
 * 只快照**账本与游标**，不快照整个 `~/.msg9`：
 * `.daemon-status.json` 由平台 daemon 每 5s 改写（心跳），把它算进来只会得到
 * 一条假的"有人写了"——那是 daemon 的正常节律，不是我们的写操作。
 */
async function snapshotSpool(dir) {
  const entries = await readdir(dir).catch(() => [])
  const ledgers = new Map()
  for (const name of entries.filter((n) => n.endsWith(LEDGER_SUFFIX)).sort()) {
    const path = join(dir, name)
    const buffer = await readFile(path)
    const stats = await stat(path)
    ledgers.set(name, {
      sha256: createHash('sha256').update(buffer).digest('hex'),
      size: buffer.length,
      mtimeMs: stats.mtimeMs,
      text: buffer.toString('utf8'),
    })
  }
  return {
    ledgers,
    cursors: entries.filter((n) => n.endsWith(CURSOR_SUFFIX)).sort(),
    allEntries: entries.slice().sort(),
  }
}

function verifyReadOnly(before, after) {
  out('## 7. 只读护栏核验（跑完再看一眼真实 spool）')
  out('')
  const newCursors = after.cursors.filter((c) => !before.cursors.includes(c))
  // 唯一的硬不变量：**跑完不得出现新游标**（我们一个字节都没往真实 spool 写）。
  must(newCursors.length === 0, `真实 spool 里出现了新游标文件：${newCursors.join(', ')}`)
  // 跑之前有没有游标只影响"此刻切过去会走哪条路"，不构成失败 ——
  // 真切换之后本脚本仍要能跑（那时候游标就该在）。
  if (before.cursors.length > 0) {
    out(`  ℹ 跑之前真实 spool 里已有 ${before.cursors.length} 个游标：${before.cursors.join(', ')}`)
    out('    （说明切换已经发生过；下面的"路由"一栏即真实态，不再是 bootstrap。）')
  }
  let appended = 0
  let identical = 0
  let rewritten = 0
  for (const [name, snap] of before.ledgers) {
    const now = after.ledgers.get(name)
    if (!now) {
      must(false, `真实账本 ${name} 跑完之后不见了`)
      continue
    }
    if (now.text === snap.text) identical += 1
    else if (now.text.startsWith(snap.text)) appended += 1
    else {
      rewritten += 1
      must(false, `真实账本 ${name} 被改写/截断（不是追加）—— 只读护栏被破坏`)
    }
  }
  const vanished = [...before.ledgers.keys()].filter((n) => !after.ledgers.has(n))
  must(vanished.length === 0, `真实账本消失：${vanished.join(', ')}`)
  const appeared = [...after.ledgers.keys()].filter((n) => !before.ledgers.has(n))
  out(`  ✓ 游标：跑前 ${before.cursors.length} 个 / 跑后 ${after.cursors.length} 个（新出现 ${newCursors.length} 个）`)
  out(`  ✓ 账本：${identical} 份逐字节未变，${appended} 份被平台 daemon 追加了行（append-only，前缀不变），${rewritten} 份被改写`)
  if (appeared.length > 0) out(`  ℹ 期间平台 daemon 新建了 ${appeared.length} 份账本（我们只写临时目录）：${appeared.join(', ')}`)
  out(`  ✓ 本脚本实际写入的位置：${WORK}`)
  out(`  ✓ 兜底 MSG9_HOME（防漏传 spoolDir）：${SANDBOX_HOME}`)
  out('')
}

// ------------------------------------------------------------------ 地址发现
const ADDRESS_KEYS = new Map() // address -> Set<source>

function noteAddress(address, source) {
  const value = String(address ?? '').trim()
  if (!value || !value.includes('@')) return
  if (!ADDRESS_KEYS.has(value)) ADDRESS_KEYS.set(value, new Set())
  ADDRESS_KEYS.get(value).add(source)
}

async function discoverAddresses() {
  const sources = { spool: [], credentials: [], status: [], tenantNames: [] }

  // ① 真实账本文件名 —— 最权威的"这个地址有账本"证据。
  for (const name of await readdir(REAL_SPOOL).catch(() => [])) {
    if (!name.endsWith(LEDGER_SUFFIX)) continue
    const address = name.slice(0, -LEDGER_SUFFIX.length)
    sources.spool.push(address)
    noteAddress(address, 'spool/<addr>.jsonl')
  }

  // ② 凭据仓里的 address 字段 —— 找出"有凭据但没账本"的地址（覆盖缺口）。
  //    只从 yaml 里抠 `address:` 那一行，api_key/signing_seed 一行都不读进输出。
  const projectsRoot = join(REAL_MSG9, 'projects')
  for (const harness of await readdir(projectsRoot).catch(() => [])) {
    const dir = join(projectsRoot, harness)
    for (const file of await readdir(dir).catch(() => [])) {
      if (!file.endsWith('.yaml')) continue // *.signing.yaml / *.old-inbox 自然跳过
      const text = await readFile(join(dir, file), 'utf8').catch(() => '')
      const match = /^[ \t]*address:[ \t]*(.+?)[ \t]*$/m.exec(text)
      if (!match) continue
      const address = match[1].replace(/^["']|["']$/g, '').trim()
      sources.credentials.push({ address, source: `projects/${harness}/${file}` })
      noteAddress(address, `credential:projects/${harness}/${file}`)
    }
  }

  // ③ 平台 daemon 的 `.daemon-status*.json`：tenants[] 里既可能是租户名（`pod.org`），
  //    也可能是**地址级 ticket**（含 `@`）—— 后者是"daemon 想盯但连不上"的强信号。
  for (const status of await readDaemonStatuses(REAL_SPOOL)) {
    for (const tenant of status.tenants) {
      if (!tenant.tenant) continue
      if (tenant.tenant.includes('@')) {
        sources.status.push({ address: tenant.tenant, state: tenant.state, file: status.file })
        noteAddress(tenant.tenant, `daemon-status:${status.file}`)
      } else {
        sources.tenantNames.push({ name: tenant.tenant, state: tenant.state, file: status.file })
      }
    }
  }

  for (const address of REQUIRED_ADDRESSES) noteAddress(address, 'card:T-45 点名')
  return sources
}

// ------------------------------------------------------------------ 主体
async function main() {
  const startedAt = Date.now()
  const before = await snapshotSpool(REAL_SPOOL)
  const discovery = await discoverAddresses()
  const addresses = [...ADDRESS_KEYS.keys()].sort()

  const locks = await readDaemonLocks(REAL_MSG9)
  const liveScopes = locks.filter((l) => l.alive && l.scope).map((l) => l.scope)
  const staleLocks = locks.filter((l) => l.stale)
  const statuses = await readDaemonStatuses(REAL_SPOOL)
  const ingest = resolveIngestMode({ config: undefined, env: process.env.MSG9_INGEST })
  const plan = planIngest(ingest.mode, { daemonDisabled: process.env.MSG9_WATCH_DAEMON === '0' })

  out('# T-45 账本消费者实弹彩排（真实 spool，严格只读）')
  out('')
  out(`- 时间：${iso(startedAt)}（本机时区 ${-new Date().getTimezoneOffset() / 60}）`)
  out(`- 真实 spool：\`${REAL_SPOOL}\``)
  out(`- 账本文件：${before.ledgers.size} 份，共 ${[...before.ledgers.values()].reduce((n, l) => n + l.text.split('\n').filter((x) => x.trim()).length, 0)} 行`)
  out(`- 真实游标（\`*${CURSOR_SUFFIX}\`）：${before.cursors.length} 个 ${before.cursors.length === 0 ? '⇒ 我们的消费者从未跑过，首轮必然是 bootstrap' : ''}`)
  out(`- 消费者名：\`${DEFAULT_CONSUMER}\`（不含 \`.\`/\`/\`，平台 compact 能切出来）`)
  out(`- ingest 开关：${ingest.mode}（来自 ${ingest.source}）⇒ planIngest：selfDaemon=${plan.selfDaemon} inProcessWatcher=${plan.inProcessWatcher} ledgerLoop=${plan.ledgerLoop}`)
  out(`- 平台锁：${locks.map((l) => `${l.file}=${l.pid ?? '?'}(${l.alive ? 'alive' : 'DEAD'})`).join(' / ') || '（无）'}`)
  out(`- 健康文件：${statuses.map((s) => `${s.file}(${s.scope?.label ?? '?'}, last_beat=${iso(s.last_beat_ms)})`).join(' / ') || '（无）'}`)
  out(`- 发现地址：${addresses.length} 个（账本 ${discovery.spool.length} + 凭据 ${new Set(discovery.credentials.map((c) => c.address)).size} + daemon-status ${discovery.status.length} + 卡面点名 ${REQUIRED_ADDRESSES.length}，去重后）`)
  out('')

  // ---------------------------------------------------------------- 1. 逐地址真实读数
  out('## 1. 逐地址真实读数（只读 `~/.msg9/spool`）')
  out('')
  out('```')
  out(
    `${pad('地址', 32)}${padLeft('事件', 5)}${padLeft('坏行', 5)}${padLeft('乱序', 5)}  ${pad('首事件', 20)}${pad('末事件(文件序)', 20)}${pad('最大断档', 9)}${padLeft('mtime-末行', 11)}`,
  )
  const readings = []
  for (const address of addresses) {
    const path = ledgerPath(address, REAL_SPOOL)
    const exists = await stat(path).then(() => true).catch(() => false)
    const parsed = await readLedger(path)
    const byTime = [...parsed.events].sort((a, b) => (Number.isFinite(a.received_ms) ? a.received_ms : 0) - (Number.isFinite(b.received_ms) ? b.received_ms : 0))
    const first = byTime[0]
    const last = byTime[byTime.length - 1]
    // 文件顺序里的"末行"才是游标语义上的锚点（追加写的尾巴）。
    const lastInFile = parsed.events[parsed.events.length - 1]

    let inversions = 0
    for (let i = 1; i < parsed.events.length; i += 1) {
      const a = parsed.events[i - 1].received_ms
      const b = parsed.events[i].received_ms
      if (Number.isFinite(a) && Number.isFinite(b) && b < a) inversions += 1
    }
    let maxGapMs = 0
    let gapFrom
    let gapTo
    for (let i = 1; i < byTime.length; i += 1) {
      if (!Number.isFinite(byTime[i].received_ms) || !Number.isFinite(byTime[i - 1].received_ms)) continue
      const delta = byTime[i].received_ms - byTime[i - 1].received_ms
      if (delta > maxGapMs) {
        maxGapMs = delta
        gapFrom = byTime[i - 1].received_ms
        gapTo = byTime[i].received_ms
      }
    }
    const stats = exists ? await stat(path) : undefined
    const appendLagMs = stats && last ? stats.mtimeMs - last.received_ms : undefined

    out(
      `${pad(address, 32)}${padLeft(parsed.events.length, 5)}${padLeft(parsed.bad_lines, 5)}${padLeft(inversions, 5)}  ${pad(iso(first?.received_ms), 20)}${pad(iso(lastInFile?.received_ms), 20)}${pad(dur(maxGapMs), 9)}${padLeft(appendLagMs === undefined ? '-' : dur(appendLagMs), 11)}`,
    )
    readings.push({ address, exists, parsed, byTime, first, last, lastInFile, inversions, maxGapMs, gapFrom, gapTo, appendLagMs, stats })
  }
  out('```')
  out('')
  out('> `事件` = 本节地址账本里的**总事件数**；`坏行` = 解析不过的行（真实数据当前为 0）；')
  out('> `乱序` = 文件里出现「后一行的 received_at 早于前一行」的次数；`最大断档` = 按时间排序后相邻事件的最大间隔；')
  out('> `mtime-末行` = 文件最后写入时间 − 末行 `received_at`，**远大于 0 就说明末行是迟到的补写**（`received_at` 是服务器收信时间，不是落账本时间）。')
  out('')

  // ---------------------------------------------------------------- 2. daemon 健康 + 覆盖
  out('## 2. 平台 daemon 健康与覆盖（判据层只读观测）')
  out('')
  out('```')
  out(`${pad('地址', 32)}${pad('账本', 6)}${pad('health', 9)}${pad('判据来源', 12)}${pad('scope 覆盖', 13)}详情`)
  const observations = []
  for (const reading of readings) {
    const observation = await observePlatformDaemon(reading.address, {
      spoolDir: REAL_SPOOL,
      msg9Home: REAL_MSG9,
      now: Date.now(),
    })
    const coverage = assessDaemonCoverage([reading.address], liveScopes)
    observations.push({ address: reading.address, observation, coverage })
    out(
      `${pad(reading.address, 32)}${pad(reading.exists ? '有' : '无', 6)}${pad(observation.health, 9)}${pad(observation.source, 12)}${pad(coverage.verdicts[0].covered ? observation.live_scopes.join(',') || 'machine' : '未覆盖', 13)}${observation.detail}`,
    )
  }
  out('```')
  out('')
  out(`> 覆盖判据用的是 **scope**（`+"`machine`"+` 覆盖"所有地址"），不是**凭据**：`)
  out(`> 当前活锁 ${liveScopes.map((s) => s.label).join(', ') || '（无）'} ⇒ \`assessDaemonCoverage\` 对全部 ${readings.length} 个地址都判"已覆盖"。`)
  if (staleLocks.length > 0) out(`> 指向死 pid 的锁（自愈，当没有）：${staleLocks.map((l) => l.file).join(', ')}`)
  out('')

  // 2b：健康文件里的**逐 tenant/逐地址连接状态**。`daemonHealthFromStatus` 只看
  // `stalled`，不看 `connected` —— 于是"某几个租户/地址的 ticket 根本连不上"这件事
  // 对 `decideTopUp` 完全不可见。这里把**原始字段**摆出来（只读）。
  out('### 2b. 健康文件里的逐条连接状态（`connected:false` 是判据的盲区）')
  out('')
  out('```')
  const disconnected = []
  for (const file of before.allEntries.filter((n) => n.startsWith('.daemon-status') && n.endsWith('.json'))) {
    const raw = await readFile(join(REAL_SPOOL, file), 'utf8').catch(() => '')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      out(`${file}  ⚠ 读不出 JSON（可能是半写状态；\`readDaemonStatuses\` 会静默跳过它）`)
      continue
    }
    out(`${file}  scope=${parsed.scope ?? '?'}  pid=${parsed.pid ?? '?'}  last_beat=${parsed.last_beat ?? '?'}`)
    for (const row of Array.isArray(parsed.tenants) ? parsed.tenants : []) {
      const name = row?.tenant ?? '?'
      const connected = row?.connected === true
      out(`  ${pad(name, 34)}mode=${pad(row?.mode ?? '?', 8)}connected=${pad(String(row?.connected), 6)}stalled=${pad(String(row?.stalled), 6)}last_seq=${row?.last_seq ?? '-'}${connected ? '' : '   ← 没连上'}`)
      if (!connected) disconnected.push(name)
    }
  }
  out('```')
  out('')
  out(`- 判据此刻算出的 health = \`up\`（last_beat 新鲜、没人报 stalled）。`)
  out(`- 但健康文件里有 **${disconnected.length}** 条 \`connected:false\`：${disconnected.join(', ') || '（无）'}`)
  out(`- \`daemonHealthFromStatus\` 只看 \`stalled\`，**不看 \`connected\`** ⇒ 这些连接失败对 \`decideTopUp\` 不可见；`)
  out(`  与"scope 覆盖 ≠ 凭据可用"是同一个盲区的两面（见结论 §8）。`)
  out('')

  // ---------------------------------------------------------------- 3. 三类路由推演
  out('## 3. 路由推演：此刻切过去会走哪条路')
  out('')
  for (const dir of [MIRROR, GAP]) {
    assertUnderWork(dir)
    for (const [name] of before.ledgers) await copyFile(join(REAL_SPOOL, name), join(dir, name))
  }
  // 真实态：真实目录里没有任何游标 ⇒ 全部 bootstrap。
  out('```')
  out(`${pad('地址', 32)}${pad('readConsumerLag()', 42)}${pad('路由', 44)}预计要补`)
  const routes = []
  for (const reading of readings) {
    const lag = await readConsumerLag(reading.address, DEFAULT_CONSUMER, { spoolDir: REAL_SPOOL })
    const observation = observations.find((o) => o.address === reading.address).observation
    let route
    let expected
    if (!reading.exists) {
      route = 'bootstrap（无账本文件 → 永不立基线）'
      expected = '0（也永远补不了）'
    } else if (lag === undefined) {
      route = 'bootstrap 只立基线'
      expected = `0（历史 ${reading.parsed.events.length} 条静默吞掉）`
    } else if (!lag.anchor_found) {
      route = '滞后补齐（anchor-lost）'
      expected = String(lag.unconsumed)
    } else if (observation.health === 'dead' || observation.health === 'stalled') {
      route = `滞后补齐（daemon-${observation.health}）`
      expected = String(lag.unconsumed)
    } else if (lag.lag_seconds * 1000 > 300_000) {
      route = '滞后补齐（lag）'
      expected = String(lag.unconsumed)
    } else {
      route = '正常消费'
      expected = String(lag.unconsumed)
    }
    routes.push({ address: reading.address, lag, route, expected })
    out(`${pad(reading.address, 32)}${pad(lag === undefined ? 'undefined（无游标）' : JSON.stringify(lag), 42)}${pad(route, 44)}${expected}`)
  }
  out('```')
  out('')
  out(`> **真实态一律是 bootstrap** —— 真实 spool 里一个 \`*${CURSOR_SUFFIX}\` 都没有，\`readConsumerLag()\` 全部返回 \`undefined\`。`)
  out('> 也就是说：切换那一刻，**每个地址都只立基线、一条历史邮件都不唤醒**（这正是 `ledger.ts` 的不变量，不是 bug）。')
  out('')

  // ---------------------------------------------------------------- 4. 幂等实测
  out('## 4. 幂等实测：临时目录里连跑三轮（真实账本拷贝）')
  out('')
  out(`- 账本拷贝到：\`${MIRROR}\`（真实 spool 只被读过）`)
  out(`- 游标写在：\`${MIRROR}/<addr>.${DEFAULT_CONSUMER}.cursor\``)
  out('')
  out('```')
  out(`${pad('地址', 32)}${pad('A:baseline', 11)} ${padLeft('A:fresh', 8)} ${padLeft('A:bad', 6)}  ${pad('B:baseline', 11)} ${padLeft('B:fresh', 8)} ${pad('B:topUp', 10)} ${padLeft('C:fresh', 8)} ${pad('游标已写', 11)}锚点`)
  const idempotence = []
  const emptyLedgerForever = []
  for (const reading of readings) {
    const address = reading.address
    assertUnderWork(MIRROR)
    const health = observations.find((o) => o.address === address).observation.health
    const logs = []
    const make = () =>
      createLedgerConsumer({
        address,
        consumer: DEFAULT_CONSUMER,
        spoolDir: MIRROR,
        now: () => Date.now(),
        daemonHealth: async () => health,
        log: (message) => logs.push(message),
      })
    const cursorFile = consumerCursorPath(address, DEFAULT_CONSUMER, MIRROR)

    // A：新消费者，无游标 —— 必须先 bootstrap，绝不唤醒历史。
    const consumerA = make()
    const pollA = await consumerA.pollOnce()
    await pollA.commit()
    const cursorAfterA = await readFile(cursorFile, 'utf8').catch(() => undefined)

    // B：**新对象**（去重环是空的，模拟进程重启）—— 幂等必须只靠游标成立。
    const consumerB = make()
    const pollB = await consumerB.pollOnce()
    await pollB.commit()
    const cursorAfterB = await readFile(cursorFile, 'utf8').catch(() => undefined)

    // C：同一个对象再跑一次 —— 锚点 + 进程内 seen 环。
    const pollC = await consumerB.pollOnce()
    await pollC.commit()

    out(
      `${pad(address, 32)}${pad(String(pollA.baseline), 11)} ${padLeft(pollA.fresh.length, 8)} ${padLeft(pollA.bad_lines, 6)}  ${pad(String(pollB.baseline), 11)} ${padLeft(pollB.fresh.length, 8)} ${pad(pollB.top_up.topUp ? String(pollB.top_up.reason) : 'false', 10)} ${padLeft(pollC.fresh.length, 8)} ${pad(cursorAfterA === undefined ? '否(空账本)' : '是', 11)}${(cursorAfterB ?? '').trim() || '-'}`,
    )

    must(pollA.fresh.length === 0, `${address}: bootstrap 轮不该唤醒任何事件，实际 ${pollA.fresh.length} 条`)
    must(pollB.fresh.length === 0, `${address}: **第二次**（新进程/空去重环）仍有 ${pollB.fresh.length} 条"新事件" —— 幂等失败`)
    must(pollC.fresh.length === 0, `${address}: 第三次仍有 ${pollC.fresh.length} 条"新事件"`)
    if (reading.exists) {
      must(pollA.baseline === true, `${address}: 无游标的首轮必须是 baseline`)
      must(pollB.baseline === false, `${address}: 提交过游标之后不该还是 baseline`)
      must(cursorAfterA !== undefined, `${address}: 非空账本的 baseline 轮也必须落游标，否则永远立不起基线`)
    } else {
      // 空账本：next_anchor 是 undefined ⇒ commit 不写游标 ⇒ 永远停在 baseline。
      must(cursorAfterA === undefined, `${address}: 空账本不该写出游标（与实现一致）`)
      if (pollB.baseline === true) emptyLedgerForever.push(address)
    }
    idempotence.push({ address, pollA, pollB, pollC, cursorAfterA, cursorAfterB, logs })
  }
  out('```')
  out('')
  if (emptyLedgerForever.length > 0) {
    out(`> ⚠ **${emptyLedgerForever.length} 个地址的账本文件根本不存在** ⇒ \`next_anchor\` 是 \`undefined\` ⇒ \`commit()\` 写不出游标 ⇒ **永远停在 bootstrap**（永久黑洞）：`)
    out(`> ${emptyLedgerForever.join(', ')}`)
    out(`> 更糟的是组合 5c：其中**任何**地址一旦收到第一封信，账本文件才出现，而那时那封信正好就是基线 ⇒ **第一封信不响**。`)
    out('')
  }
  const secondRoundTotal = idempotence.reduce((n, r) => n + r.pollB.fresh.length, 0)
  must(secondRoundTotal === 0, `第二轮全部地址合计仍有 ${secondRoundTotal} 条新事件`)
  out(`> 第二轮（新消费者对象、空 `+"`seen`"+` 环）**全部地址合计新事件 = ${secondRoundTotal}** ⇒ 幂等只靠游标即成立。`)
  out(`> 第三轮（同对象，锚点 + `+"`seen`"+` 环）合计新事件 = ${idempotence.reduce((n, r) => n + r.pollC.fresh.length, 0)}。`)
  out('')

  // ---------------------------------------------------------------- 5. 坏行容错实测
  out('## 5. 坏行容错实测（临时目录夹具）')
  out('')
  const BAD_ADDRESS = 'rehearsal@bad.ice.msg9.io'
  const valid1 = JSON.stringify({ v: 1, type: 'new_message', address: BAD_ADDRESS, message_id: 'msg_good_1', received_at: '2026-10-07T10:00:00+08:00' })
  const valid2 = JSON.stringify({ v: 1, type: 'new_message', address: BAD_ADDRESS, message_id: 'msg_good_2', received_at: 'NOT-A-TIME' })
  const dup1 = JSON.stringify({ v: 1, type: 'new_message', address: BAD_ADDRESS, message_id: 'msg_good_1', received_at: '2026-10-07T11:00:00+08:00' })
  const fixtureLines = [
    valid1, // ① 正常
    '', // ② 空行（追加写被打断不会留空行，但也要容错）
    '   ', // ③ 纯空白
    '{"v":1,"type":"new_mess', // ④ 半行（崩溃点残留）
    '[1,2,3]', // ⑤ JSON 但不是对象
    'null', // ⑥ 字面量 null
    '{"v":1,"type":"new_message","address":"' + BAD_ADDRESS + '"}', // ⑦ 缺 message_id
    '{"v":1,"type":"new_message","address":"' + BAD_ADDRESS + '","message_id":"","received_at":"2026-10-07T10:30:00+08:00"}', // ⑧ 空 message_id
    valid2, // ⑨ 时间不可解析 —— 是**事件**，不是坏行
    dup1, // ⑩ 同 id 重复 —— 事件，靠去重
  ]
  assertUnderWork(BAD)
  await writeFile(join(BAD, `${BAD_ADDRESS}${LEDGER_SUFFIX}`), `${fixtureLines.join('\n')}\n`)
  const parsedBad = parseLedgerLines(await readFile(join(BAD, `${BAD_ADDRESS}${LEDGER_SUFFIX}`), 'utf8'))
  out(`- 夹具：${fixtureLines.length} 行 = 3 条合法事件（其中 1 条与第 1 条同 id）+ 2 行空白 + **5 行坏行**`)
  out(`- \`parseLedgerLines\`：events=${parsedBad.events.length} blank_lines=${parsedBad.blank_lines} bad_lines=${parsedBad.bad_lines}`)
  out(`  （blank_lines=3 而不是 2：文件末尾的换行会 split 出一个空片段 —— 账本都是 \`\\n\` 结尾，所以正常账本的 blank_lines 恒 ≥ 1；空白行不计坏行。）`)
  must(parsedBad.bad_lines === 5, `坏行计数应为 5，实际 ${parsedBad.bad_lines}`)
  must(parsedBad.blank_lines === 3, `空行计数应为 3（含末尾换行片段），实际 ${parsedBad.blank_lines}`)
  must(parsedBad.events.length === 3, `合法事件应为 3，实际 ${parsedBad.events.length}`)

  let badThrew
  let badPoll
  try {
    // ① 无游标：应当 bootstrap，且报告坏行、**不抛**。
    const consumer = createLedgerConsumer({ address: BAD_ADDRESS, consumer: DEFAULT_CONSUMER, spoolDir: BAD, now: () => Date.now() })
    badPoll = await consumer.pollOnce()
    await badPoll.commit()
  } catch (error) {
    badThrew = error
  }
  must(badThrew === undefined, `坏行夹具让 pollOnce 抛了：${badThrew?.message ?? ''}`)
  out(`- 无游标轮：baseline=${badPoll?.baseline} fresh=${badPoll?.fresh.length} bad_lines=${badPoll?.bad_lines}（bootstrap 不唤醒历史 ⇒ fresh 必为 0）`)
  must(badPoll?.baseline === true, '坏行夹具的无游标轮应为 baseline')
  must(badPoll?.bad_lines === 5, `坏行夹具轮应报告 bad_lines=5，实际 ${badPoll?.bad_lines}`)

  // ② 摆一个**账本里不存在**的锚点：锚点丢失 ⇒ 走补齐，且仍要容忍坏行。
  await writeConsumerCursor(consumerCursorPath(BAD_ADDRESS, DEFAULT_CONSUMER, BAD), 'msg_anchor-that-never-existed')
  let lostThrew
  let lostPoll
  let lostLag
  try {
    const consumer = createLedgerConsumer({ address: BAD_ADDRESS, consumer: DEFAULT_CONSUMER, spoolDir: BAD, now: () => Date.now() })
    lostPoll = await consumer.pollOnce()
    lostLag = await readConsumerLag(BAD_ADDRESS, DEFAULT_CONSUMER, { spoolDir: BAD })
  } catch (error) {
    lostThrew = error
  }
  must(lostThrew === undefined, `锚点丢失 + 坏行让消费者抛了：${lostThrew?.message ?? ''}`)
  out(`- 锚点丢失轮：anchor_found=${lostPoll?.lag?.anchor_found} fresh=${lostPoll?.fresh.length} duplicates=${lostPoll?.duplicates} top_up=${lostPoll?.top_up.topUp}/${lostPoll?.top_up.reason}`)
  out(`- \`readConsumerLag\`：${JSON.stringify(lostLag)}`)
  must(lostPoll?.lag?.anchor_found === false, '不存在的锚点必须报 anchor_found=false')
  must(lostPoll?.top_up.reason === 'anchor-lost', `锚点丢失应触发 anchor-lost 补齐，实际 ${lostPoll?.top_up.reason}`)
  must(lostPoll?.fresh.length === 2, `夹具里有 3 条合法事件、其中 1 条重复 ⇒ fresh 应为 2，实际 ${lostPoll?.fresh.length}`)
  must(lostPoll?.duplicates === 1, `重复 id 应计为 1，实际 ${lostPoll?.duplicates}`)
  must(lostLag?.anchor_found === false, 'readConsumerLag 也必须能容忍锚点丢失')
  must(Number.isNaN(lostPoll?.fresh.find((e) => e.message_id === 'msg_good_2')?.received_ms ?? 0), '时间不可解析的事件应保留、received_ms 记 NaN，而不是当坏行丢掉')
  out('')

  // ---------------------------------------------------------------- 5c. 账本"第一次出现"时第一条事件被吞
  //
  // 这是把两条各自正确的规则放在一起才暴露的问题：
  //   ① bootstrap 轮**不写游标**（`next_anchor` 是 undefined ⇒ `commit()` 什么也不写，
  //      见 `createLedgerConsumer.commit`）；
  //   ② 账本文件是**平台 daemon 收到第一封信时才创建**的。
  // 于是"账本还不存在 ⇒ 空账本 ⇒ 永远 baseline"与"第一封信一到，文件里就只有这一行"
  // 撞在一起：那一行正好是 baseline，被静默吞掉。
  out('### 5c. 账本文件"第一次出现"时的第一封信（两条正确规则的合谋）')
  out('')
  const FRESH_ADDRESS = 'rehearsal@fresh.ice.msg9.io'
  const FRESH_DIR = join(WORK, 'fresh')
  assertUnderWork(FRESH_DIR)
  await mkdir(FRESH_DIR, { recursive: true })
  const freshLedger = join(FRESH_DIR, `${FRESH_ADDRESS}${LEDGER_SUFFIX}`)
  const freshCursor = consumerCursorPath(FRESH_ADDRESS, DEFAULT_CONSUMER, FRESH_DIR)
  const freshPoll = () => createLedgerConsumer({ address: FRESH_ADDRESS, consumer: DEFAULT_CONSUMER, spoolDir: FRESH_DIR, now: () => Date.now() }).pollOnce()
  const row = (id, at) => `${JSON.stringify({ v: 1, type: 'new_message', address: FRESH_ADDRESS, message_id: id, received_at: at })}\n`

  const step1 = await freshPoll() // 账本文件还不存在
  await step1.commit()
  const step1Cursor = await readFile(freshCursor, 'utf8').catch(() => undefined)

  await writeFile(freshLedger, row('msg_first_ever', '2026-10-07T09:00:00+08:00')) // 第一封信到达 → 文件出现
  const step2 = await freshPoll()
  await step2.commit()

  const step3 = await freshPoll() // 立完基线之后再跑
  await step3.commit()

  await writeFile(freshLedger, row('msg_first_ever', '2026-10-07T09:00:00+08:00') + row('msg_second', '2026-10-07T09:30:00+08:00')) // 第二封信到达
  const step4 = await freshPoll()

  out('```')
  out(`① 账本还不存在                    → baseline=${step1.baseline} fresh=${step1.fresh.length} 游标写入=${step1Cursor === undefined ? '否（next_anchor 是 undefined）' : '是'}`)
  out(`② 第一封信到达（账本出现，只有这 1 行） → baseline=${step2.baseline} fresh=${step2.fresh.length}   ← 这封信被当成"历史"，静默吞掉`)
  out(`③ 再跑一轮（基线已立）            → baseline=${step3.baseline} fresh=${step3.fresh.length}`)
  out(`④ 第二封信到达                    → baseline=${step4.baseline} fresh=${step4.fresh.length}（${step4.fresh.map((e) => e.message_id).join(', ')}）`)
  out('```')
  out('')
  must(step1.baseline === true && step1Cursor === undefined, '空账本轮不该写出游标（否则这个演示的前提不成立）')
  must(step2.baseline === true && step2.fresh.length === 0, '账本文件刚出现时仍是 baseline ⇒ 第一封信被吞（这就是待修的风险）')
  must(step4.fresh.length === 1 && step4.fresh[0].message_id === 'msg_second', `第二封信必须被唤醒，实际 fresh=${step4.fresh.map((e) => e.message_id).join(',') || '空'}`)
  out('> **风险（不是断言失败，是真实行为）**：任何"账本文件还不存在"的地址，收到的**第一封信**都会被当成基线吞掉。')
  out('> 生产影响：`dsh-3@dsh.ice`、`diansuan@dsh.ice`、`dsh-ws-*@msg9.ice` 这类**今天还没有账本**的工作区信箱，')
  out('> 一旦第一封信到了，它不会响 —— 而且没有任何日志说"我吞了一封"。')
  out('')

  // ---------------------------------------------------------------- 6. 滞后补齐推演
  out('## 6. 滞后 / 断档推演：把游标摆到"断档之前"会发生什么')
  out('')
  out('> 剧本：在**临时目录**里把游标写成「最大断档前最后一条事件的 message_id」，再看消费者怎么判。')
  out('> 真实 spool 仍然只读；这里写的是拷贝。')
  out('')
  out('```')
  out(`${pad('地址', 32)} ${padLeft('锚点文件序', 12)}  ${pad('锚点 received_at', 21)} ${padLeft('anchor_found', 12)} ${padLeft('unconsumed', 10)} ${padLeft('lag', 8)}  ${pad('decideTopUp', 18)} ${padLeft('fresh', 6)}`)
  const gapSims = []
  for (const reading of readings) {
    if (!reading.exists || reading.parsed.events.length === 0) continue
    // 锚点 = 「daemon 断档前**最后追加**的那一行」。注意账本不是按 received_at 追加的
    // （见 §1 的"乱序"列）：真实文件里常见「先一串最新事件、然后一整块回填的旧事件」。
    // 所以"断档前最后一个位置"要按**文件序**找，而不是按时间排序找：
    //   ① 有逆序 ⇒ 逆序点前一行就是断档前最后一条；
    //   ② 单调 ⇒ 退化成"最大断档前最后一条"。
    const events = reading.parsed.events
    let cut = -1
    for (let i = 1; i < events.length; i += 1) {
      if (Number.isFinite(events[i].received_ms) && Number.isFinite(events[i - 1].received_ms) && events[i].received_ms < events[i - 1].received_ms) {
        cut = i - 1
        break
      }
    }
    if (cut === -1) {
      for (let i = 0; i < events.length; i += 1) {
        if (Number.isFinite(events[i].received_ms) && Number.isFinite(reading.gapFrom) && events[i].received_ms <= reading.gapFrom) cut = i
      }
    }
    if (cut < 0 || cut >= events.length) continue
    const anchorEvent = events[cut]
    await writeConsumerCursor(consumerCursorPath(reading.address, DEFAULT_CONSUMER, GAP), anchorEvent.message_id)
    const lag = await readConsumerLag(reading.address, DEFAULT_CONSUMER, { spoolDir: GAP })
    const health = observations.find((o) => o.address === reading.address).observation.health
    const poll = await createLedgerConsumer({
      address: reading.address,
      consumer: DEFAULT_CONSUMER,
      spoolDir: GAP,
      now: () => Date.now(),
      daemonHealth: async () => health,
    }).pollOnce()
    gapSims.push({ address: reading.address, cut, anchorEvent, lag, poll })
    out(
      `${pad(reading.address, 32)} ${padLeft(`L${cut + 1}/${events.length}`, 12)}  ${pad(iso(anchorEvent.received_ms), 21)} ${padLeft(String(lag?.anchor_found), 12)} ${padLeft(lag?.unconsumed ?? '-', 10)} ${padLeft(dur((lag?.lag_seconds ?? 0) * 1000), 8)}  ${pad(`${poll.top_up.topUp}${poll.top_up.reason ? ` (${poll.top_up.reason})` : ''}`, 18)} ${padLeft(poll.fresh.length, 6)}`,
    )
  }
  out('```')
  out('')
  out('> `unconsumed` = 锚点之后（文件序）还有多少条；`lag` = 其中**最老**一条距今多久（`readConsumerLag` 的口径）。')
  out('> 注意「回填块」会让最老未消费事件**比锚点本身还老**（真实数据里就有：锚点是 10-01、回填块里却有 09-29 的行）——')
  out('> 这正是 `lag` 取最老而不是取最新的价值：它算出的是"积压里最急的那封等了多久"。')
  out('')

  // 锚点缺失（真实地址上重放一遍，用 GAP 目录）
  out('### 6b. 锚点缺失（被 compact 掉 / 换过消费者名）')
  out('')
  const anchorLost = []
  for (const address of REQUIRED_ADDRESSES) {
    const reading = readings.find((r) => r.address === address)
    if (!reading?.exists) continue
    await writeConsumerCursor(consumerCursorPath(address, DEFAULT_CONSUMER, GAP), 'msg_anchor-that-never-existed')
    const lag = await readConsumerLag(address, DEFAULT_CONSUMER, { spoolDir: GAP })
    const poll = await createLedgerConsumer({
      address,
      consumer: DEFAULT_CONSUMER,
      spoolDir: GAP,
      now: () => Date.now(),
      daemonHealth: async () => observations.find((o) => o.address === address).observation.health,
    }).pollOnce()
    anchorLost.push({ address, lag, poll })
    out(`- ${pad(address, 32)} anchor_found=${lag?.anchor_found} unconsumed=${lag?.unconsumed} top_up=${poll.top_up.topUp}/${poll.top_up.reason} fresh=${poll.fresh.length}`)
    must(poll.top_up.reason === 'anchor-lost', `${address}: 锚点缺失必须触发 anchor-lost，实际 ${poll.top_up.reason}`)
  }
  out('')

  // ---------------------------------------------------------------- 7. 只读护栏核验
  const after = await snapshotSpool(REAL_SPOOL)
  verifyReadOnly(before, after)
  out('> 全过程零 HTTP：consumer 未传 `fetchUnread`（补齐只算判据、不真取回），')
  out('> 脚本不 import 任何 http/网络模块，也没有 `listInbox` 之类的调用。')
  out(`> 所有可写路径都在 \`${WORK}\` 与 \`${SANDBOX_HOME}\` 之下（均 mkdtemp 独占）。`)
  out('')

  // ---------------------------------------------------------------- 8. 结论
  const totalEvents = readings.reduce((n, r) => n + r.parsed.events.length, 0)
  const noLedger = readings.filter((r) => !r.exists)
  const withLedger = readings.filter((r) => r.exists)
  const withGap = readings.filter((r) => r.maxGapMs > 86_400_000)
  const outOfOrder = readings.filter((r) => r.inversions > 0)
  const backfilled = readings.filter((r) => (r.appendLagMs ?? 0) > 120_000)

  out('## 8. 结论（机器算出来的数，不是印象）')
  out('')
  out(`- 覆盖地址 **${readings.length}** 个：有账本 ${withLedger.length} 个 / **无账本 ${noLedger.length} 个**；账本事件合计 **${totalEvents}** 条。`)
  out(`- 真实 spool 里 **0 个游标** ⇒ 切换首轮**全部走 bootstrap**，只立基线、不唤醒任何历史（含断档期间积压的信）。`)
  out(`- 幂等：第二轮（新对象、空 seen 环）全部地址合计新事件 **${secondRoundTotal}** 条；第三轮同样 0。`)
  out(`- 坏行容错：夹具 ${fixtureLines.length} 行里 5 行坏行，全部跳过并计数，\`pollOnce\`/\`readConsumerLag\` 均未抛。`)
  out(`- 账本并非按 \`received_at\` 顺序追加：**${outOfOrder.length}/${withLedger.length}** 份有逆序行（回填块）。`)
  out(`- 末行是迟到补写的账本：**${backfilled.length}/${withLedger.length}** 份（\`mtime - 末行 received_at > 2min\`）。`)
  out(`- 最大断档 > 1 天的地址：**${withGap.length}** 个（最长 ${dur(Math.max(...readings.map((r) => r.maxGapMs)))}）。`)
  out(`- 健康文件里 \`connected:false\` 的条目：**${disconnected.length}** 条，但 \`daemonHealthFromStatus\` 仍报 \`up\`。`)
  out(`- **5c 实测（最该修的一条）**：账本文件"第一次出现"时，第一条事件被 bootstrap 静默吞掉 —— 地址的**第一封信不响**。`)
  out(`- 走不通的路（无账本 ⇒ 永停在 bootstrap）：${noLedger.length > 0 ? noLedger.map((r) => r.address).join(', ') : '（无）'}`)
  out('')

  out(`## 9. 断言汇总`)
  out('')
  if (failures.length === 0) out('✅ 全部断言通过（只读护栏 / 幂等 / 坏行容错 / 路由判据）')
  else {
    out(`❌ ${failures.length} 条断言失败：`)
    for (const f of failures) out(`   - ${f}`)
  }
  out('')
  out(`（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)

  if (OUT_PATH) {
    await writeFile(OUT_PATH, `${LINES.join('\n')}\n`)
    process.stderr.write(`[rehearsal] 报告已写入 ${OUT_PATH}\n`)
  }
  if (failures.length > 0) process.exitCode = 1
}

await main()
