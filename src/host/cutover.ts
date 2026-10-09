/**
 * T-13 阶段三·第一步：**共存交接（coexistence handover）的判据层**。
 *
 * 现状是**双读共存**：平台 `msg9 daemon` 把每条新邮件通知逐行写进
 * `~/.msg9/spool/<address>.jsonl`（账本 = 真相源），我们的自研 daemon 仍在值班
 * 走 REST/WS 投递唤醒。两套 per-consumer 游标互不干扰，所以可以并存 —— 但
 * 「什么时候把 ingest 从 self 切到 ledger」不能靠手感，得有机器可判的边界。
 *
 * 本模块只做三件事，**全部是判据/观测，没有任何写操作**：
 *
 *   1. `ingest` 开关的解析与**唤醒来源唯一性**（`planIngest` /
 *      `resolveWakeSources` / `assertSingleWakeSource`）——默认 `self`，
 *      默认行为一字不改；切到 `ledger` 时自研 daemon 与进程内 watcher
 *      **都不再是唤醒来源**；
 *   2. `--scope` 的**选择器**语义：`tenant:<pod>.<org>` 是「这台 daemon 盯哪些
 *      凭据」的过滤器，**不是租户身份**。`parseScopeFlag` 按平台契约解析（别的
 *      形状一律拒绝，绝不静默降级成"盯全部"）；`addressTenant` /
 *      `daemonScopeCovers` / `assessDaemonCoverage` 判「某地址有没有 daemon
 *      覆盖」——flat 信箱（无 pod）只能由默认（machine）scope 的 daemon 值守；
 *   3. **死 pid 自愈**：`~/.dsh/msg9-daemon/daemon.json` 与平台
 *      `~/.msg9/daemon.lock.<level>-<id>` 都可能指向**已经死掉的 pid**
 *      （本机实测：平台锁 `machine-Jiker` 里写着 75656，进程早没了）——
 *      `isPidAlive` / `readDaemonPidState` / `readDaemonLocks` 把死 pid
 *      当成「没有这个 daemon」，**只读判断、容错、绝不改用户文件**，
 *      也绝不因此拒绝启动。
 *
 * 本机实测（2026-10-07，只读）：`~/.msg9/spool/*.jsonl` 最后一行停在
 * 2026-10-01T09:43，平台 daemon 已不在进程表里，锁文件 `machine-Jiker`
 * 指向死 pid 75656，且**没有任何** `.daemon-status*.json`、**没有任何**
 * `spool/*.cursor` ⇒ 我们的消费者从未跑过（首次消费 = bootstrap），
 * 「daemon 掉线期间到的信」只能靠 inbox unread 补齐。
 *
 * @module dsh-msg9-kit/cutover
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InboxMessage } from './api.ts'
import type { DaemonHealth, LedgerPoll } from './ledger.ts'
import { daemonHome, daemonInfoPath, readDaemonInfo, type DaemonInfo } from './daemon/state.ts'

// ---------------------------------------------------------------- ingest 开关

/** `ingest` 的取值。`self` = 改前的全部行为；`ledger` = 消费平台账本。 */
export type IngestMode = 'self' | 'ledger'

/** **默认关**：不写配置的人拿到的就是改前的行为。 */
export const DEFAULT_INGEST: IngestMode = 'self'

/** 环境变量名（配置缺省时的第二来源：运维临时切换/测试用）。 */
export const INGEST_ENV = 'MSG9_INGEST'

/** 唤醒来源。**同一时刻只能有一个生效** —— 双唤醒是这次切换最想避免的噪声。 */
export type WakeSource = 'self-daemon' | 'in-process-watcher' | 'ledger-consumer'

export interface IngestResolution {
  mode: IngestMode
  /** 这个值是从哪儿来的（配置 / 环境变量 / 默认值）。 */
  source: 'config' | 'env' | 'default'
  /** 值无法识别时原样留证（**回落到 self**，绝不因为写错而切到 ledger）。 */
  invalid?: string
  /** 给 `log` 用的一句话（值写错时非空）。 */
  warning?: string
}

function normalizeIngest(value: unknown): IngestMode | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'self' || trimmed === 'ledger') return trimmed
  return undefined
}

/**
 * 解析 `ingest`：**配置 > 环境变量 > 默认（self）**。
 *
 * 三条纪律：
 *   - 默认必须是 `self`（默认行为一字不改）；
 *   - 值不认识 ⇒ **回落 self** 并给出 warning（写错一个字母就把唤醒路径换掉，
 *     是最不该发生的静默切换）；
 *   - 永不抛错（切换开关坏掉不该让插件起不来）。
 */
export function resolveIngestMode(input: { config?: unknown; env?: unknown } = {}): IngestResolution {
  const fromConfig = normalizeIngest(input.config)
  if (fromConfig) return { mode: fromConfig, source: 'config' }
  if (input.config !== undefined && input.config !== null && input.config !== '') {
    return {
      mode: DEFAULT_INGEST,
      source: 'config',
      invalid: String(input.config),
      warning: `msg9 ingest: unrecognised config ingest=${JSON.stringify(input.config)}; keeping the default (${DEFAULT_INGEST}). Expected "self" or "ledger".`,
    }
  }
  const fromEnv = normalizeIngest(input.env)
  if (fromEnv) return { mode: fromEnv, source: 'env' }
  if (typeof input.env === 'string' && input.env.trim() !== '') {
    return {
      mode: DEFAULT_INGEST,
      source: 'env',
      invalid: input.env,
      warning: `msg9 ingest: unrecognised ${INGEST_ENV}=${JSON.stringify(input.env)}; keeping the default (${DEFAULT_INGEST}). Expected "self" or "ledger".`,
    }
  }
  return { mode: DEFAULT_INGEST, source: 'default' }
}

/** 「谁有资格当唤醒来源」。这是**接线计划**，不是运行时结果。 */
export interface IngestPlan {
  mode: IngestMode
  /** 自研 daemon 客户端：self 模式下它的投递就是唤醒来源，也是徽章快照来源。 */
  selfDaemon: boolean
  /** 进程内 watcher：`/inbox/stream` 长轮询（或 30s 轮询兜底）。 */
  inProcessWatcher: boolean
  /** 平台账本消费者循环（`spool/*.jsonl` + 我们自己的 consumer 游标）。 */
  ledgerLoop: boolean
}

/**
 * 接线计划。
 *
 * `self` 分支与改前**逐项一致**：`MSG9_WATCH_DAEMON !== '0'` 才有 daemon 客户端
 * （连上 ⇒ 本实例只当投递目标；连不上 ⇒ 退回进程内 watcher，见 index.ts 的
 * "never run both"）；`ledger` 分支两者都不再是唤醒来源。
 */
export function planIngest(mode: IngestMode = DEFAULT_INGEST, options: { daemonDisabled?: boolean } = {}): IngestPlan {
  if (mode === 'ledger') {
    return { mode: 'ledger', selfDaemon: false, inProcessWatcher: false, ledgerLoop: true }
  }
  return { mode: 'self', selfDaemon: !options.daemonDisabled, inProcessWatcher: true, ledgerLoop: false }
}

/**
 * 运行时**实际生效**的唤醒来源（每次切换路径都过这里）。
 *
 * self 模式的两条是**互斥**的：daemon 连上 ⇒ 只有它投递（本实例只当投递目标）；
 * 连不上 ⇒ 只有进程内 watcher。ledger 模式恒为账本消费者一条。
 */
export function resolveWakeSources(plan: IngestPlan, daemonConnected: boolean): WakeSource[] {
  const sources: WakeSource[] = []
  // ⚠️ 这里**不短路**：坏计划（例如 ledger 与进程内 watcher 同时为真）必须能被
  // `assertSingleWakeSource` 抓出来 —— 短路会让守卫永远看不到第二条来源。
  if (plan.ledgerLoop) sources.push('ledger-consumer')
  if (plan.selfDaemon && daemonConnected) sources.push('self-daemon')
  // self 模式的两条是互斥的：daemon 连上 ⇒ 进程内 watcher 不启动（改前的语义）。
  if (plan.inProcessWatcher && !daemonConnected) sources.push('in-process-watcher')
  return sources
}

/**
 * 一份计划**可能**用到的全部来源（把所有运行状态都展开）。
 *
 * `resolveWakeSources` 回答的是"此刻是谁"，这里回答的是"这份计划允许谁"——
 * 两者的差额就是**计划没料到的那条唤醒路径**（T-67 要抓的东西）。
 *
 * 实测取值：`ledger` ⇒ `['ledger-consumer']`（一个都没有）；
 * `self` ⇒ `['self-daemon', 'in-process-watcher']`（互斥的两条，掉线时交接）。
 */
export function plannedWakeSources(plan: IngestPlan): WakeSource[] {
  const out = new Set<WakeSource>()
  for (const daemonConnected of [true, false]) {
    for (const source of resolveWakeSources(plan, daemonConnected)) out.add(source)
  }
  return [...out]
}

/**
 * T-67：把「只有一个唤醒来源」从**接线计划**收紧到**运行时实际触发过**的来源。
 *
 * 为什么需要（这是 T-67 的现场教训）：`assertSingleWakeSource` 只校验
 * `resolveWakeSources(plan, …)` —— 也就是"我们**打算**让谁响" ✓。它从来没校验过
 * "**实际上**是谁响的" ✗：`deliverBatch` 被几条路径共用，任何一条被多接一次、
 * 或在计划之外被调用一次，计划那边**一个字都不会变**，守卫照样通过。
 *
 * 两条判据，都是"绝不该发生"：
 *   ① 响过的来源**超出了这份计划允许的集合** —— 例如 `ingest=ledger` 下账本消费者
 *      之外还有谁醒了（卡面要的那条："账本消费者活着时不得再走补齐唤醒"）；
 *   ② 响过的来源**不止一个** —— 同一个进程里两条唤醒路径同时在响。
 *
 * ⚠️ 本函数**只做判断**（抛错）。在后台循环里抛错会变成 unhandledRejection 并可能
 * 带走宿主进程，所以生产接线把它的判据包在 try 里**响亮地记日志**
 * （见 `watch.ts` 的 `noteWakeSource`），测试里则直接断言它抛。
 */
export function assertObservedWakeSources(observed: Iterable<WakeSource>, allowed: readonly WakeSource[]): void {
  const fired = [...new Set(observed)]
  if (fired.length === 0) return
  const outside = fired.filter((source) => !allowed.includes(source))
  if (outside.length > 0) {
    throw new Error(
      `msg9 ingest: wake source ${outside.join(', ')} actually FIRED but the plan allows only ` +
        `${allowed.join(', ') || 'none'} — a wake path is firing that the wiring did not plan for`,
    )
  }
  if (fired.length > 1) {
    throw new Error(
      `msg9 ingest: ${fired.length} wake sources actually FIRED (${fired.join(', ')}) — ` +
        'exactly ONE may ever fire in a process',
    )
  }
}

/**
 * 「唤醒来源恰好一个」这个不变量的**守卫**（可判据，不只是注释）。
 *
 * 唯一的例外是 watcher 被整体关掉（`MSG9_WATCH=0`）：那时候零个来源是刻意的。
 *
 * T-67 起额外接受 `observed`：把**运行时实际触发过**的来源一起校验，
 * 于是"计划对、实际错"这种形态再也躲不过这道门。
 */
export function assertSingleWakeSource(
  plan: IngestPlan,
  daemonConnected: boolean,
  options: { watchDisabled?: boolean; observed?: Iterable<WakeSource> } = {},
): WakeSource {
  const sources = resolveWakeSources(plan, daemonConnected)
  if (options.watchDisabled && sources.length === 0) return 'ledger-consumer'
  if (sources.length !== 1) {
    throw new Error(
      `msg9 ingest: expected exactly ONE wake source, got ${sources.length} (${sources.join(', ') || 'none'}) — mode=${plan.mode}`,
    )
  }
  if (options.observed) assertObservedWakeSources(options.observed, plannedWakeSources(plan))
  return sources[0]!
}

// ------------------------------------------------- 多宿主消费（T-73 的显式开关）

/** 开关的环境变量名（配置缺省时的第二来源；运维临时切换/测试用）。 */
export const SINGLE_HOST_CONSUMER_ENV = 'MSG9_SINGLE_HOST_CONSUMER'

/**
 * 「同一信箱只由一个宿主消费」的开关（**默认关**）。
 *
 * ⚠️ **默认必须是关**，这是 PO 2026-10-09 的产品裁决，不是偷懒：
 * 多个宿主各消费一份 ⇒ 通知**重复但不漏**（人在哪个宿主上都叫得到）；
 * 加上互斥 ⇒ **不重复但可能漏**（信只叫醒持锁宿主的会话，另一个宿主上的人不会被叫）。
 * **可见的重复**比**不可见的漏叫**好排查，所以默认保留前者。
 * 需要去重的人显式打开（代价见上），并且开关打开时每一条被跳过的唤醒都会进观测行
 * （`decision=skipped-lock-holder=<pid>`）—— 那是这个开关唯一的安全网。
 */
export interface SingleHostConsumerResolution {
  enabled: boolean
  /** 这个值是从哪儿来的（配置 / 环境变量 / 默认值）。 */
  source: 'config' | 'env' | 'default'
  /** 值无法识别时原样留证（**回落到关**）。 */
  invalid?: string
  /** 给 `log` 用的一句话（值写错时非空）。 */
  warning?: string
}

/** 认 `true/1/yes/on` 与 `false/0/no/off`；别的（含空串）当"没给值"。 */
function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(trimmed)) return true
  if (['0', 'false', 'no', 'off'].includes(trimmed)) return false
  return undefined
}

/**
 * 解析 `singleHostConsumer`：**配置 > 环境变量 > 默认（关）**。
 *
 * 与 `resolveIngestMode` 同一条纪律：值不认识就**回落默认（关）**并给 warning ——
 * 写错一个字母就静默打开跨进程互斥（进而可能漏叫）是最坏的结果。永不抛错。
 */
export function resolveSingleHostConsumer(input: { config?: unknown; env?: unknown } = {}): SingleHostConsumerResolution {
  const fromConfig = normalizeBoolean(input.config)
  if (fromConfig !== undefined) return { enabled: fromConfig, source: 'config' }
  if (input.config !== undefined && input.config !== null && input.config !== '') {
    return {
      enabled: false,
      source: 'config',
      invalid: String(input.config),
      warning: `msg9 single-host consumer: unrecognised config singleHostConsumer=${JSON.stringify(input.config)}; keeping the default (off — duplicates but nothing is missed). Expected true/false.`,
    }
  }
  const fromEnv = normalizeBoolean(input.env)
  if (fromEnv !== undefined) return { enabled: fromEnv, source: 'env' }
  if (typeof input.env === 'string' && input.env.trim() !== '') {
    return {
      enabled: false,
      source: 'env',
      invalid: input.env,
      warning: `msg9 single-host consumer: unrecognised ${SINGLE_HOST_CONSUMER_ENV}=${JSON.stringify(input.env)}; keeping the default (off — duplicates but nothing is missed). Expected true/false.`,
    }
  }
  return { enabled: false, source: 'default' }
}

// ------------------------------------------------------- --scope 是选择器

/**
 * 平台 `--scope` 的契约原文（`msg9 daemon --help`，本机 v1.41.8 逐字核对）。
 *
 * ⚠️ **`scope` 不是身份**：它是「这台 daemon 盯**哪些凭据**」的**选择器**。
 * 省略 = 盯全部凭据（machine 级）；`tenant:<pod>.<org>` = 只盯地址形如
 * `<agent>@<pod>.<org>.<base>` 的凭据。别的写法**一律被平台拒绝**（exit 2），
 * 绝不静默降级成"盯全部" —— 所以我们的解析器也必须拒绝，而不是猜。
 */
export const SCOPE_CONTRACT =
  '--scope tenant:<pod>.<org> watches only that tenant\'s agents; omit to watch all credentials ' +
  '(any other form is rejected — it never silently degrades to watching everything)'

export type DaemonScope =
  | { kind: 'machine'; label: string }
  | { kind: 'tenant'; pod: string; org: string; label: string }

/**
 * 解析一个 `--scope` 取值（**选择器**）。
 *
 * `undefined` / `null` / `''` ⇒ 默认 scope（machine，盯全部）。
 * `tenant:<pod>.<org>` ⇒ 只盯该租户。
 * 别的形状 ⇒ **抛错**（与平台同一条规矩：拒绝，不降级）。
 */
export function parseScopeFlag(raw: unknown): DaemonScope {
  if (raw === undefined || raw === null) return { kind: 'machine', label: 'machine' }
  if (typeof raw !== 'string') {
    throw new Error(`msg9 scope: expected a string, got ${typeof raw} (${SCOPE_CONTRACT})`)
  }
  const value = raw.trim()
  if (value === '') return { kind: 'machine', label: 'machine' }
  const match = /^tenant:([^.\s]+)\.([^.\s]+)$/.exec(value)
  if (!match) {
    throw new Error(`msg9 scope: ${JSON.stringify(raw)} is not a valid scope — ${SCOPE_CONTRACT}`)
  }
  const [, pod, org] = match
  return { kind: 'tenant', pod: pod!, org: org!, label: value }
}

/** 容错版：认不出来返回 `undefined`（读观测数据时不该因为一条坏记录就崩）。 */
export function tryParseScopeFlag(raw: unknown): DaemonScope | undefined {
  try {
    return parseScopeFlag(raw)
  } catch {
    return undefined
  }
}

/** 某地址属于哪个租户（`<pod>.<org>`）。flat = 没有 pod 归属。 */
export type AddressTenant = { kind: 'pod'; pod: string; org: string } | { kind: 'flat' }

/**
 * 从地址推导租户（**纯字符串**，与 http.ts 的 `podLabelFromAddress` 同一条口径：
 * 域里必须有 `<pod>.<org>.` 这一段；没有 ⇒ 没有 pod 归属）。
 *
 * 启发式：取域的**最后两段**当基础域（`msg9.io`），剩下的头部至少两段才算
 * pod 形态（头部就一段的是 `<something>.<base>`，属于扁平常量域；头部为空
 * 是 `<agent>@<base>`）。给了 `org` 就再核对一次，org 不符 = 不属于该 org。
 */
export function addressTenant(address: string, options: { org?: string } = {}): AddressTenant {
  const value = String(address ?? '').trim().toLowerCase()
  const at = value.lastIndexOf('@')
  const domain = at === -1 ? value : value.slice(at + 1)
  const labels = domain.split('.').filter((label) => label !== '')
  // 基础域 = 域的**最后两段**（`msg9.io` / `example.com`）；去掉它剩下的就是头部。
  // 头部空 = `<agent>@<base>`；头部一段 = `<常量>.<base>`（如 `dsh-alpha.msg9.io`）
  // —— 这两种都没有 pod 归属。头部 ≥ 两段 ⇒ `<pod>.<org>.…`。
  const head = labels.length > 2 ? labels.slice(0, labels.length - 2) : []
  if (head.length < 2) return { kind: 'flat' }
  const org = head[head.length - 1]!
  const pod = head[head.length - 2]!
  if (options.org && org !== options.org.toLowerCase()) return { kind: 'flat' }
  return { kind: 'pod', pod, org }
}

/** 该地址**需要**哪种 scope 才有 daemon 值守（flat 只能靠默认 scope）。 */
export function scopeNeededFor(address: string, options: { org?: string } = {}): 'machine' | 'tenant' {
  return addressTenant(address, options).kind === 'pod' ? 'tenant' : 'machine'
}

/** 给定地址，覆盖它需要的那条 `--scope`（flat ⇒ `undefined` = 只能用默认 scope）。 */
export function scopeFlagForAddress(address: string, options: { org?: string } = {}): string | undefined {
  const tenant = addressTenant(address, options)
  return tenant.kind === 'pod' ? `tenant:${tenant.pod}.${tenant.org}` : undefined
}

/** 这个 scope 的 daemon 盯不盯这个地址。 */
export function daemonScopeCovers(scope: DaemonScope, address: string, options: { org?: string } = {}): boolean {
  if (scope.kind === 'machine') return true
  const tenant = addressTenant(address, options)
  return tenant.kind === 'pod' && tenant.pod.toLowerCase() === scope.pod.toLowerCase() && tenant.org.toLowerCase() === scope.org.toLowerCase()
}

export interface CoverageVerdict {
  address: string
  tenant: AddressTenant
  /** 覆盖它的 scope（可能多条：machine + 精准 tenant）。 */
  covered_by: DaemonScope[]
  /**
   * scope 轴 + 凭据轴的合取：**"该有人盯它"**（不代表此刻真的盯得住）。
   * `credentialed` 没给（unknown）时，这一项就退化成纯粹的 scope 判定（改前行为）。
   */
  covered: boolean
  /** 该地址**需要**的 scope 种类。flat ⇒ machine（默认 scope）。 */
  needs: 'machine' | 'tenant'
  /** 它自己那条 `--scope` 取值（flat 没有）。 */
  scope_flag?: string
  /** 凭据轴：本机有没有它的凭据（平台 daemon 想盯也盯不了的情形）。 */
  credential: 'present' | 'absent' | 'unknown'
  /** 连接轴：健康文件里这个地址（或它的租户）此刻连没连上。 */
  connection: 'connected' | 'disconnected' | 'stalled' | 'unreported'
  /**
   * **唤醒来源**的最终裁决（T-46 ②）：
   *   - `ledger`：scope + 凭据 + 连接三轴都过 ⇒ 新邮件会进账本、会唤醒；
   *   - `top-up-only`：scope 覆盖，但连接轴是断的（`connected:false` / `stalled`）
   *     ⇒ 这个地址的信**不会进账本**，ledger 模式下唯一兜底是 inbox unread 补齐；
   *   - `unconfirmed`：有健康文件，但没有任何一条提到它/它的租户 ⇒ **无法确认**
   *     它真在被盯（不能假装"已覆盖"）；
   *   - `none`：没有 scope 覆盖，或者本机根本没有它的凭据 ⇒ **没有任何唤醒来源**。
   */
  wake_source: 'ledger' | 'top-up-only' | 'unconfirmed' | 'none'
  reason: string
}

export interface DaemonCoverageWarning {
  /** 稳定标识，便于判据与日志过滤。 */
  code: 'no-daemon-coverage' | 'no-wake-source' | 'wake-source-unconfirmed'
  address: string
  flat: boolean
  text: string
}

export interface DaemonCoverageReport {
  verdicts: CoverageVerdict[]
  /** 没有任何 daemon 覆盖的地址（判据 ③ 的输入）。 */
  uncovered: string[]
  warnings: DaemonCoverageWarning[]
  /** 认不出来的活锁（scope 名字不是已知形状）——保守地**不算覆盖**，但要报出来。 */
  unparsed_scopes: string[]
  /** 指向死 pid 的锁（自愈：当没有），留证用。 */
  stale_locks: string[]
}

/**
 * 判「这些地址有没有 daemon 值守」（判据 ③）。
 *
 * 关键点：**flat 信箱（无 pod）只能由默认 scope（machine，省略 `--scope`）的
 * daemon 覆盖** —— `tenant:<pod>.<org>` 的 daemon 按定义只盯那个租户，怎么也
 * 轮不到 `a@msg9.io` 这种没有 pod 的地址。没有覆盖 ⇒ 新邮件不会进账本，
 * 唯一兜底是 inbox unread 补齐。所以这里必须**明确报警**（可判据），
 * 而不是让"没覆盖"表现成"账本莫名不长了"。
 *
 * ⚠️ T-46 ② 补上的那一课：**scope 覆盖 ≠ 凭据可用 ≠ 连接可用**。活锁写着
 * `machine` 时，这一函数对**全部**地址都判"已覆盖"，而真实健康文件里
 * `kimi.code` / `dsh@kimi.ice.msg9.io` / `cc-dsh-audit@ccd.ice.msg9.io` 三条是
 * `connected:false` —— 这些地址的信根本不会进账本。所以：
 *   - 传了 `statuses` ⇒ 连接轴参与裁决（断连的地址判 `top-up-only` 并**显式告警**）；
 *   - 传了 `credentialed` ⇒ 凭据轴兜底（本机没有凭据的地址判 `none`）。
 * 两个可选参数都不传时，行为与改前**逐字一致**（纯 scope 判定）。
 */
export function assessDaemonCoverage(
  addresses: readonly string[],
  scopes: readonly DaemonScope[],
  options: {
    org?: string
    unparsedScopes?: readonly string[]
    staleLocks?: readonly string[]
    /**
     * 平台健康文件的只读读数（`.daemon-status*.json`）。给了它，覆盖判定就同时看
     * **连接轴**：scope 只说明"该盯"，`connected` 才说明"此刻盯得住"。
     */
    statuses?: readonly PlatformDaemonStatus[]
    /**
     * 本机**有凭据**的地址（凭据存在性兜底）。缺省 = 不知道，不参与判定；
     * 给了以后，不在列表里的地址一律判 `credential: 'absent'`。
     */
    credentialed?: readonly string[]
  } = {},
): DaemonCoverageReport {
  const verdicts: CoverageVerdict[] = []
  const uncovered: string[] = []
  const warnings: DaemonCoverageWarning[] = []
  const statuses = options.statuses ?? []
  const credentialed = options.credentialed === undefined ? undefined : new Set(options.credentialed.map((address) => address.trim().toLowerCase()))
  for (const address of addresses) {
    const tenant = addressTenant(address, options)
    const coveredBy = scopes.filter((scope) => daemonScopeCovers(scope, address, options))
    const needs = tenant.kind === 'pod' ? 'tenant' : 'machine'
    const scopeFlag = scopeForAddressTenant(tenant)
    const credential: CoverageVerdict['credential'] = credentialed === undefined ? 'unknown' : credentialed.has(address.trim().toLowerCase()) ? 'present' : 'absent'
    const connection = connectionAxis(address, statuses, options)
    const scopeCovered = coveredBy.length > 0
    // 凭据轴兜底：本机没有凭据 ⇒ 平台 daemon 想盯也盯不了（它不是"该盯没盯"，
    // 而是"根本没法盯"）⇒ 与没有 scope 覆盖同级。
    const covered = scopeCovered && credential !== 'absent'
    const wakeSource: CoverageVerdict['wake_source'] = !covered
      ? 'none'
      : connection === 'disconnected' || connection === 'stalled'
        ? 'top-up-only'
        : connection === 'unreported' && statuses.length > 0
          ? 'unconfirmed'
          : 'ledger'
    const reason = !scopeCovered
      ? tenant.kind === 'pod'
        ? `no daemon covers ${address}: it needs a default-scope daemon or one started with --scope ${scopeFlag}`
        : `no daemon covers ${address}: a flat mailbox (no pod) can only be watched by a default-scope (machine) daemon`
      : credential === 'absent'
        ? `no credential for ${address} on this machine: no daemon can watch it (it is not in the credentialed set)`
        : wakeSource === 'top-up-only'
          ? `scope covers ${address} (${coveredBy.map((scope) => scope.label).join(', ')}) but the platform daemon reports it ${connection}: nothing is ledgered for it; only inbox-unread top-up will wake it`
          : wakeSource === 'unconfirmed'
            ? `scope covers ${address} (${coveredBy.map((scope) => scope.label).join(', ')}) but no .daemon-status entry mentions it or its tenant: this wake source is unconfirmed`
            : `covered by ${coveredBy.map((scope) => scope.label).join(', ')}`
    verdicts.push({
      address,
      tenant,
      covered_by: coveredBy,
      covered,
      needs,
      ...(scopeFlag === undefined ? {} : { scope_flag: scopeFlag }),
      credential,
      connection,
      wake_source: wakeSource,
      reason,
    })
    if (wakeSource === 'ledger') continue
    if (wakeSource === 'none') uncovered.push(address)
    warnings.push(coverageWarning({ address, tenant, scopeFlag, coveredBy, credential, connection, wakeSource }))
  }
  return {
    verdicts,
    uncovered,
    warnings,
    unparsed_scopes: [...(options.unparsedScopes ?? [])],
    stale_locks: [...(options.staleLocks ?? [])],
  }
}

/** 一个地址在**连接轴**上的状态（只看覆盖它的健康文件）。 */
function connectionAxis(
  address: string,
  statuses: readonly PlatformDaemonStatus[],
  options: { org?: string },
): CoverageVerdict['connection'] {
  if (statuses.length === 0) return 'unreported'
  // scope 认不出来的健康文件（文件名不合契约）保守地算"可能覆盖"：宁可说
  // "连接存疑"，也不要因为一个坏文件名就假装这个地址没人管。
  const covering = statuses.filter((status) => status.scope === undefined || daemonScopeCovers(status.scope, address, options))
  const rows = covering.flatMap((status) => relevantStatusTenants(status.tenants, address, options.org))
  if (rows.length === 0) return 'unreported'
  if (rows.some((row) => row.state === 'stalled')) return 'stalled'
  if (rows.some((row) => row.state === 'disconnected')) return 'disconnected'
  return rows.some((row) => row.state === 'connected') ? 'connected' : 'unreported'
}

/** 每条告警只说**一件事**（每个地址最多一条），按严重程度取最重的那条。 */
function coverageWarning(input: {
  address: string
  tenant: AddressTenant
  scopeFlag: string | undefined
  coveredBy: readonly DaemonScope[]
  credential: CoverageVerdict['credential']
  connection: CoverageVerdict['connection']
  wakeSource: CoverageVerdict['wake_source']
}): DaemonCoverageWarning {
  const flat = input.tenant.kind === 'flat'
  const scopes = input.coveredBy.map((scope) => scope.label).join(', ')
  if (input.wakeSource === 'none') {
    return {
      code: 'no-daemon-coverage',
      address: input.address,
      flat,
      text:
        `msg9 cutover: no daemon covers ${input.address} — ${input.credential === 'absent'
          ? 'no credential for it exists on this machine'
          : flat
            ? 'flat mailbox (no pod): only a default-scope (machine) daemon can watch it'
            : `start one with --scope ${input.scopeFlag}`}. ` +
        `Nothing is ledgered for it; the only fallback is inbox-unread top-up.` +
        `（「${input.address}」没有任何 daemon 覆盖：新邮件不会进账本，只能靠 inbox unread 补齐。）`,
    }
  }
  if (input.wakeSource === 'top-up-only') {
    return {
      code: 'no-wake-source',
      address: input.address,
      flat,
      text:
        `msg9 cutover: ${input.address} is scope-covered (${scopes}) but the platform daemon reports it ${input.connection} — ` +
        `nothing is ledgered for it, so in ingest=ledger mode the ONLY wake source is inbox-unread top-up.` +
        `（「${input.address}」scope 上"已覆盖"，但该租户/票据连接状态是 ${input.connection}：它的信不会进账本，` +
        `切到 ledger 后唯一唤醒来源是 inbox unread 补齐。）`,
    }
  }
  return {
    code: 'wake-source-unconfirmed',
    address: input.address,
    flat,
    text:
      `msg9 cutover: ${input.address} is scope-covered (${scopes}) but no .daemon-status entry mentions it or its tenant — ` +
      `we cannot confirm that anything is ledgering for it.` +
      `（「${input.address}」scope 上"已覆盖"，但健康文件里没有任何一条提到它或它的租户 —— 无法确认它真在被盯。）`,
  }
}

function scopeForAddressTenant(tenant: AddressTenant): string | undefined {
  return tenant.kind === 'pod' ? `tenant:${tenant.pod}.${tenant.org}` : undefined
}

// --------------------------------------------------------------- 死 pid 自愈

/**
 * pid 还活着吗。
 *
 * `EPERM` 也算活着（别人家的进程，`kill(pid, 0)` 没有被授权而已）；
 * 只有 **`ESRCH`** 才敢说死了。判不出来（其它错误/非整数）⇒ 一律当**不可信**，
 * 调用方「有文件 + pid 不是我确定的死」时**不拒绝启动**。
 */
export function isPidAlive(pid: unknown): boolean {
  const value = typeof pid === 'number' ? pid : Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  if (value === process.pid) return true
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

export interface DaemonPidState {
  path: string
  present: boolean
  /** 文件里写的 pid（可解析时）。 */
  pid?: number
  /** pid 是不是活着的（`false` = 死了 ⇒ **当它没有**）。 */
  alive: boolean
  /** 有文件 + pid 活着 ⇒ 这份记录可用。 */
  usable: boolean
  info?: DaemonInfo
  detail: string
}

/**
 * 读 `~/.dsh/msg9-daemon/daemon.json`（**只读**）。
 *
 * 存在的意义是**死 pid 自愈**：文件可能指向一个早就不在的进程（历史 56926；
 * 平台侧的同类是本机 `daemon.lock.machine-Jiker` 里的 75656）—— 这种记录
 * 一律当「没有 daemon」，不探测、不报错、不拒绝启动；**绝不删除或改写用户的
 * 文件**（删是 daemon 自己的 `removeDaemonInfo` 的职责，且它按 pid 守卫）。
 */
export async function readDaemonPidState(home = daemonHome()): Promise<DaemonPidState> {
  const path = daemonInfoPath(home)
  const info = await readDaemonInfo(home)
  if (!info) {
    return { path, present: false, alive: false, usable: false, detail: `no usable daemon.json at ${path}` }
  }
  const alive = isPidAlive(info.pid)
  return {
    path,
    present: true,
    pid: info.pid,
    alive,
    usable: alive,
    info,
    detail: alive
      ? `daemon.json pid ${info.pid} is alive (port ${info.port})`
      : `daemon.json points at dead pid ${info.pid}; treating it as absent (a fresh daemon may be spawned)`,
  }
}

/** 一条平台锁的只读观测（`~/.msg9/daemon.lock.<level>-<id>`）。 */
export interface DaemonLock {
  path: string
  file: string
  level: string
  id: string
  /** 文件里写的 pid（可解析时）。 */
  pid?: number
  /** pid 活着 ⇒ 这条锁真的在值班。 */
  alive: boolean
  /** 认出来的 scope（`machine` / `tenant:<pod>.<org>`）；认不出来就缺席。 */
  scope?: DaemonScope
  /** 死 pid 的锁：**当没有**（自愈），留证在这条记录里。 */
  stale: boolean
}

/**
 * 读 `~/.msg9/daemon.lock.*`（**只读**）。
 *
 * 平台契约：「startup guard locks per scope, not globally」，锁文件名是
 * `<level>-<id>`（本机实测 `machine-Jiker`，内容是十进制 pid + 换行）。
 * **内容不是活 pid 的锁一律算 stale** —— 平台自己用 exit code 3 表示「这个
 * scope 已被活 daemon 占着」，所以死 pid 的锁不该被我们当成"有人值守"。
 */
export async function readDaemonLocks(msg9HomeDir: string): Promise<DaemonLock[]> {
  let entries: string[]
  try {
    entries = await readdir(msg9HomeDir)
  } catch {
    return []
  }
  const locks: DaemonLock[] = []
  for (const file of entries.filter((name) => name.startsWith('daemon.lock.')).sort()) {
    const path = join(msg9HomeDir, file)
    const suffix = file.slice('daemon.lock.'.length)
    const dash = suffix.indexOf('-')
    const level = dash === -1 ? suffix : suffix.slice(0, dash)
    const id = dash === -1 ? '' : suffix.slice(dash + 1)
    const raw = await readFile(path, 'utf8').catch(() => '')
    const pid = Number(raw.trim())
    const parsedPid = Number.isInteger(pid) && pid > 0 ? pid : undefined
    const alive = parsedPid !== undefined && isPidAlive(parsedPid)
    let scope: DaemonScope | undefined
    if (level === 'machine') scope = { kind: 'machine', label: 'machine' }
    else if (level === 'tenant') scope = tryParseScopeFlag(`tenant:${id}`)
    locks.push({
      path,
      file,
      level,
      id,
      ...(parsedPid === undefined ? {} : { pid: parsedPid }),
      alive,
      ...(scope === undefined ? {} : { scope }),
      stale: !alive,
    })
  }
  return locks
}

// ------------------------------------------------- 平台 daemon 健康（只读观测）

/** `.daemon-status*.json` 的一条只读读数（字段名按 --help 的措辞容错解析）。 */
export interface PlatformDaemonStatus {
  file: string
  scope?: DaemonScope
  /** `last_beat` 的 epoch ms（可解析时）。 */
  last_beat_ms?: number
  /**
   * 每个租户的连接状态。
   *
   *   - `connected`：`connected:true`（流/票据真的连着）；
   *   - `stalled`：`stalled:true`（daemon 自己说这个租户掉线 >60s）；
   *   - `disconnected`：**显式** `connected:false`（本机实测 3 条，见 T-46 ②）；
   *   - `unknown`：两个字段都没给（老版本/半写状态）——不猜。
   */
  tenants: { tenant?: string; state: 'connected' | 'stalled' | 'disconnected' | 'unknown' }[]
}

function numberField(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
      const at = Date.parse(value)
      if (Number.isFinite(at)) return at
    }
  }
  return undefined
}

/** `.daemon-status[-<scope>].json` 的文件名 → scope。认不出来返回 undefined。 */
export function scopeFromStatusFile(file: string): DaemonScope | undefined {
  const match = /^\.daemon-status(?:-(.+))?\.json$/.exec(file)
  if (!match) return undefined
  const suffix = match[1]
  if (!suffix) return { kind: 'machine', label: 'machine' }
  if (suffix === 'machine') return { kind: 'machine', label: 'machine' }
  const tenant = /^tenant[-:](.+)$/.exec(suffix)
  if (tenant?.[1]) return tryParseScopeFlag(`tenant:${tenant[1]}`)
  return undefined
}

/** 读 spool 目录里的健康文件（**只读**；没有就返回空数组，不是错误）。 */
export async function readDaemonStatuses(spoolDir: string): Promise<PlatformDaemonStatus[]> {
  let entries: string[]
  try {
    entries = await readdir(spoolDir)
  } catch {
    return []
  }
  const out: PlatformDaemonStatus[] = []
  for (const file of entries.filter((name) => name.startsWith('.daemon-status') && name.endsWith('.json')).sort()) {
    const raw = await readFile(join(spoolDir, file), 'utf8').catch(() => '')
    let parsed: Record<string, unknown>
    try {
      const value = JSON.parse(raw) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      parsed = value as Record<string, unknown>
    } catch {
      continue
    }
    const scope = scopeFromStatusFile(file)
    const lastBeat = numberField(parsed, ['last_beat', 'last_beat_at', 'beat_at', 'lastBeat', 'updated_at'])
    // 秒级时间戳（< 1e11）换算成 ms：平台很可能用 RFC3339，但我们两种都容错。
    const lastBeatMs = lastBeat === undefined ? undefined : lastBeat < 1e11 ? lastBeat * 1000 : lastBeat
    const rawTenants = parsed.tenants ?? parsed.connections ?? parsed.sessions
    const tenants: PlatformDaemonStatus['tenants'] = []
    if (Array.isArray(rawTenants)) {
      for (const row of rawTenants) {
        if (!row || typeof row !== 'object') continue
        const item = row as Record<string, unknown>
        const stalled = item.stalled === true || item.state === 'stalled' || item.status === 'stalled'
        const connected = item.connected === true || item.state === 'connected' || item.status === 'connected'
        // ⚠️ T-46 ②：**显式** `connected:false` 必须与"没有这个字段"分开。
        // 原来两者都落到 `unknown` ⇒ `daemonHealthFromStatus` 看不见断连，
        // 真实数据里 3 条连不上的租户/票据就这么静默了。
        const disconnected =
          item.connected === false || item.state === 'disconnected' || item.status === 'disconnected' || item.connected === 'false'
        tenants.push({
          ...(typeof item.tenant === 'string' ? { tenant: item.tenant } : typeof item.scope === 'string' ? { tenant: item.scope } : typeof item.address === 'string' ? { tenant: item.address } : {}),
          state: stalled ? 'stalled' : disconnected ? 'disconnected' : connected ? 'connected' : 'unknown',
        })
      }
    }
    out.push({
      file,
      ...(scope === undefined ? {} : { scope }),
      ...(lastBeatMs === undefined ? {} : { last_beat_ms: lastBeatMs }),
      tenants,
    })
  }
  return out
}

/**
 * 心跳过期阈值（T-46 ④）—— **保守侧**，可配（`options.staleMs`）。
 *
 * 依据：平台 daemon 的 `last_beat` 每 **5s** 写一次，所以 15s 只有 **3 拍**
 * 的余量 —— 一次 GC / 负载尖峰 / iCloud 拉回（本机实测过 439→0 的驱逐）
 * 就可能把它判成 `dead`，于是 `decideTopUp` 白跑一轮补齐。观测期内没误判，
 * 不代表不会；而 API 配额正是这一阶段要省的东西。
 * 45s = **9 拍**：容忍连续丢 8 拍，同时远小于"一封急信该等多久"。
 * 代价是真实死亡的检出延迟变大 —— 但我们的轮询间隔本身就是 30s
 *（`WATCH_POLL_MS`），补齐全靠下一轮 poll，秒级精度没有意义。
 */
export const DEFAULT_DAEMON_STALE_MS = 45_000

/**
 * 从健康文件的行里挑出**与这个地址有关**的那些（T-46 ②）。
 *
 * 平台按「租户」记行（`<pod>.<org>`，例如 `dsh.ice`），对**票据**模式则按
 * **完整地址**记行（实测 `dsh@kimi.ice.msg9.io`）。所以匹配要分两级、
 * **地址级优先**：票据行比租户行更具体（同一个 `kimi.ice` 租户下，
 * `dsh@kimi.ice` 的票据连不上，不代表 `kimi@kimi.ice` 也连不上）。
 * 一条都对不上（例如 flat 地址没有租户标签可对）⇒ 空数组 = "没有报道"。
 */
export function relevantStatusTenants(
  tenants: PlatformDaemonStatus['tenants'],
  address: string,
  org?: string,
): PlatformDaemonStatus['tenants'] {
  const wanted = address.trim().toLowerCase()
  const exact = tenants.filter((row) => typeof row.tenant === 'string' && row.tenant.trim().toLowerCase() === wanted)
  if (exact.length > 0) return exact
  const tenant = addressTenant(address, org === undefined ? {} : { org })
  if (tenant.kind !== 'pod') return []
  const label = `${tenant.pod}.${tenant.org}`
  return tenants.filter((row) => typeof row.tenant === 'string' && row.tenant.trim().toLowerCase() === label)
}

/**
 * 由健康文件判「进程还活着吗 / 连接还通吗」（**两条正交轴**）。
 *
 *   - **进程轴**：`last_beat` 超过 `staleMs`（默认 `DEFAULT_DAEMON_STALE_MS`）⇒ `dead`；
 *   - **连接轴**：有 `address` 时只看**与它有关**的行（`relevantStatusTenants`，
 *     地址级 ticket 优先）—— `stalled` / `connected:false` ⇒ 对应状态；
 *   - 新鲜、连接也 OK ⇒ `up`；没有 `last_beat` 字段 ⇒ `unknown`（**不猜**）。
 *
 * ⚠️ 不传 `address`（或该地址一条行都对不上）时退回**整份文件的聚合**判断，
 * 与改前逐字一致 —— 但**只有地址级判断才能区分"这个租户连不上"与"别的租户
 * 连不上"**：`decideTopUp` 之类按地址纠偏的调用方必须把 `address` 传进来，
 * 否则一条 `connected:false` 会让整份文件覆盖的所有地址都去补齐。
 */
export function daemonHealthFromStatus(
  status: PlatformDaemonStatus | undefined,
  options: { now: number; staleMs?: number; address?: string; org?: string },
): DaemonHealth {
  if (!status) return 'unknown'
  const staleMs = options.staleMs ?? DEFAULT_DAEMON_STALE_MS
  const relevant = options.address === undefined ? status.tenants : relevantStatusTenants(status.tenants, options.address, options.org)
  const connection = connectionHealth(relevant)
  if (status.last_beat_ms === undefined) {
    // 没有心跳字段：只有明确说 stalled / disconnected 才敢下结论（"进程活着"证不了）。
    return connection ?? 'unknown'
  }
  if (options.now - status.last_beat_ms > staleMs) return 'dead'
  return connection ?? 'up'
}

/** 一组行里的**最坏**连接状态（`stalled` > `disconnected` > `connected`）；都是 unknown ⇒ undefined。 */
function connectionHealth(rows: PlatformDaemonStatus['tenants']): DaemonHealth | undefined {
  if (rows.some((row) => row.state === 'stalled')) return 'stalled'
  if (rows.some((row) => row.state === 'disconnected')) return 'disconnected'
  return rows.some((row) => row.state === 'connected') ? 'up' : undefined
}

export interface PlatformDaemonObservation {
  health: DaemonHealth
  /** 判据来自哪儿：健康文件 / 活锁 / 什么都没有。 */
  source: 'status' | 'lock' | 'none'
  detail: string
  live_scopes: string[]
  stale_locks: string[]
}

/**
 * 某地址上的平台 daemon 健康（**只读**）。
 *
 * 顺序：① 有覆盖该地址的 `.daemon-status*.json` ⇒ 用它（`up`/`stalled`/`dead`/
 * `unknown`）；② 没有健康文件，但有覆盖该地址的**活锁** ⇒ `unknown`（daemon 在
 * 值班，只是没写状态文件 —— 老版本）；③ 连活锁都没有 ⇒ **`dead`**：
 * `decideTopUp` 会因此走 inbox unread 补齐，这正是「停 daemon → 发信 → 重启」
 * 那条边界里**不许丢唤醒**的机制（账本零滞后时它是唯一能覆盖缺口的判据）。
 */
export async function observePlatformDaemon(
  address: string,
  options: { spoolDir: string; msg9Home: string; now?: number; staleMs?: number; org?: string },
): Promise<PlatformDaemonObservation> {
  const now = options.now ?? Date.now()
  const statuses = await readDaemonStatuses(options.spoolDir)
  const locks = await readDaemonLocks(options.msg9Home)
  const liveScopes = locks.filter((lock) => lock.alive && lock.scope).map((lock) => lock.scope!)
  const staleLocks = locks.filter((lock) => lock.stale).map((lock) => lock.file)
  const liveLabels = liveScopes.map((scope) => scope.label)

  const matching = statuses.filter((status) => status.scope !== undefined && daemonScopeCovers(status.scope, address, options))
  // 精准的 tenant scope 优先于 machine scope（同一地址可能被两个 daemon 盯）。
  const best = matching.find((status) => status.scope!.kind === 'tenant') ?? matching[0]
  if (best) {
    // ⚠️ 必须把 **address** 交给健康判定（T-46 ②）：健康文件是**一份文件装多个租户**的，
    // 聚合判断会让"某个别的租户 connected:false"污染这个地址；反过来，少了它
    // "这个地址自己连不上"就永远看不见。
    const health = daemonHealthFromStatus(best, {
      now,
      ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
      address,
      ...(options.org === undefined ? {} : { org: options.org }),
    })
    return {
      health,
      source: 'status',
      detail: `${best.file} (${best.scope?.label ?? 'unknown scope'}) says ${health}`,
      live_scopes: liveLabels,
      stale_locks: staleLocks,
    }
  }

  const covering = liveScopes.filter((scope) => daemonScopeCovers(scope, address, options))
  if (covering.length > 0) {
    return {
      health: 'unknown',
      source: 'lock',
      detail: `live daemon lock(s) ${covering.map((scope) => scope.label).join(', ')} cover ${address}, but no .daemon-status file was found`,
      live_scopes: liveLabels,
      stale_locks: staleLocks,
    }
  }

  return {
    health: 'dead',
    source: 'none',
    detail:
      `no live daemon covers ${address}` +
      (staleLocks.length > 0 ? ` (stale lock(s) pointing at dead pids: ${staleLocks.join(', ')})` : ''),
    live_scopes: liveLabels,
    stale_locks: staleLocks,
  }
}

/** 便利包装：只要健康三个字。 */
export async function platformDaemonHealth(
  address: string,
  options: { spoolDir: string; msg9Home: string; now?: number; staleMs?: number; org?: string },
): Promise<DaemonHealth> {
  return (await observePlatformDaemon(address, options)).health
}

// ------------------------------------------------- ledger 分支的一批投递计划

export interface LedgerBatchPlan {
  /** 真正要投递的邮件（带正文，来自 server 的 unprocessed 页）。 */
  deliver: InboxMessage[]
  /** 补齐带上来的（不在本批账本事件里的）。 */
  topped_up: string[]
  /** 账本说有、但 unprocessed 页里已经没有了（已在别处闭环）——记数用。 */
  reconciled_away: string[]
  /** 取不到 unprocessed 页 ⇒ **不要 commit**，下一轮重投（信在服务器，不丢）。 */
  retry: boolean
  /** 账本里的新事件数（stalled 判据的观测值）。 */
  fresh_events: number
}

/**
 * 把「账本消费者这一轮的结果」接到「真实邮件」上（**纯函数**）。
 *
 * 为什么需要这一步：账本行**只有 message_id，没有正文**（契约第 1 条），所以
 * 「以账本为触发源」之后还得去 server 拿正文。我们只用**一次**
 * `folder=unprocessed` 调用同时做两件事：① 把 fresh 事件映射成真邮件；
 * ② 顺手当 v1.20 的权威对账（已在别处闭环的信不在这一页里 ⇒ 不唤醒）。
 *
 * `unprocessed === undefined` 表示这一页**取不到**（网络/鉴权失败）——
 * 那时候**绝不 commit**：账本游标不推进，下一轮重投。这就是"唤醒不许丢"的
 * 实现方式（宁可重复一次，也不静默吞掉）。
 */
export function planLedgerBatch(
  poll: Pick<LedgerPoll, 'fresh' | 'top_up_messages'>,
  unprocessed: readonly InboxMessage[] | undefined,
): LedgerBatchPlan {
  const freshEvents = poll.fresh.length
  if (unprocessed === undefined) {
    return { deliver: [], topped_up: [], reconciled_away: [], retry: true, fresh_events: freshEvents }
  }
  const byId = new Map<string, InboxMessage>()
  for (const message of unprocessed) {
    if (!message || typeof message.message_id !== 'string' || message.message_id === '') continue
    byId.set(message.message_id, message)
  }
  const deliver: InboxMessage[] = []
  const reconciledAway: string[] = []
  const seen = new Set<string>()
  for (const event of poll.fresh) {
    const message = byId.get(event.message_id)
    if (!message) {
      reconciledAway.push(event.message_id)
      continue
    }
    if (seen.has(message.message_id)) continue
    seen.add(message.message_id)
    deliver.push(message)
  }
  const toppedUp: string[] = []
  for (const message of poll.top_up_messages) {
    if (!message || typeof message.message_id !== 'string' || seen.has(message.message_id)) continue
    seen.add(message.message_id)
    toppedUp.push(message.message_id)
    deliver.push(message)
  }
  return { deliver, topped_up: toppedUp, reconciled_away: reconciledAway, retry: false, fresh_events: freshEvents }
}
