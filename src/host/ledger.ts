/**
 * 平台 daemon 账本（spool ledger）的消费者骨架 —— 纯函数优先。
 *
 * 背景（T-13 二期第一阶段）：平台自带的 `msg9 daemon` 已经把「新邮件通知」
 * 逐行写进 `~/.msg9/spool/<address>.jsonl`，本机订阅者可以连
 * `~/.msg9/daemon.sock` 收门铃 —— 但**门铃是 best-effort，账本才是真相源**。
 * 所以自研 daemon 退化成消费者时，消费的是这个账本，而不是门铃。
 *
 * 契约（来自 `msg9 daemon --help` 的原文，已逐条核对）：
 *
 *   1. 一行一个事件，**不含正文**，实测形如（v1.41.8，本机 9 个账本全部同形）：
 *      `{"v":1,"type":"new_message","address":"…","message_id":"…","received_at":"RFC3339Nano"}`
 *      ⇒ 没有序号（`tenant_seq` 只在租户级门铃流上），所以游标**不能**是行号/偏移；
 *   2. 消费者用**自己的**游标文件 `spool/<address>.<consumer>.cursor`，**只有消费者写**；
 *   3. 平台 `msg9 daemon compact` 的口径是「cut point 取所有消费者游标的**最小值**，
 *      并保留最小消费者的 **anchor line**，以便下次压缩还能定位它」——
 *      加上二进制里的字符串 `cursor of consumer %q not in ledger (id %s)`，
 *      可判定 **游标文件里放的就是一个 message_id**（锚点），不是行号/偏移/JSON。
 *      本模块按这个格式读写，绝不自造第二种格式（两套契约 = 两份真相）。
 *   4. 重连只回放 500 事件/租户，超窗的门铃行**永久没了**，但信不丢（服务器 inbox
 *      是真相源）⇒ 长断线/锚点丢失时走 **inbox unread 补齐**，不要指望流重放。
 *   5. ⚠️ **账本不是按 `received_at` 有序追加的**（T-45 实弹彩排在真实数据上量的：
 *      16 份账本里 **8 份有"回填块"**、**9 份的末行是迟到补写**，最长的补写比
 *      `received_at` 晚了 **7.65 天**）。平台 daemon 重启时会把错过的历史**回填**
 *      进账本，于是文件里常见「一串最新事件 + 一整块更早的旧事件」这种形状。
 *      ⇒ **文件顺序才是游标语义**（锚点 = 文件里最后一次出现的那个 id），时间顺序
 *      只用来排序通知；任何"按时间切一刀再拿游标跳过去"的做法都会真的丢信
 *      （文件序在锚点之后、但时间上更早的行会被跳过）。正因为如此，大批积压的
 *      分流靠 **文件序前 N 条**（`limit` / `maxPerRound`），而不是时间窗口。
 *
 * 因此本模块的四件事：
 *   - `parseLedgerLines` 容错解析（坏行跳过并计数，**绝不抛**）；
 *   - `selectFreshEvents` 按锚点顺序取新事件，**同一 message_id 只叫一次**（幂等）；
 *   - `computeCursorLag` / `readConsumerLag` 暴露「consumer cursor 滞后秒数」
 *     （msg9_status 要显示的那一项）；
 *   - `decideTopUp` 决定何时走 inbox 补齐（滞后超阈值 / 锚点丢失 / daemon 掉线 / 显式调用）。
 *
 * 本阶段**只交付骨架**：没有任何调用方会切到它（投递路径仍是 `watch.ts`），
 * `~/.msg9/**` 也不会被它写入 —— 只有测试里的临时目录会。
 *
 * @module dsh-msg9-kit/ledger
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InboxMessage } from './api.ts'
import { msg9Home } from './credentials.ts'

/** 账本行的协议版本（实测 `v:1`）。 */
export const LEDGER_SCHEMA_VERSION = 1

/**
 * 本 kit 的消费者名。**不能含 `.` 或 `/`**：平台从文件名尾部切
 * `<address>.<consumer>.cursor`，名字里有 `.` 会让平台认不出这是谁的游标
 * ——表现是「compact 静默跳过我们的账本」，不报错、不断言、只是永远不压缩。
 */
export const DEFAULT_CONSUMER = 'dsh-msg9-kit'

/**
 * 触发 inbox 补齐的滞后阈值（默认 5 分钟）。
 *
 * 口径是**「账本里最新未消费事件距今多久」**（`CursorLag.lag_seconds`），
 * 不是「距上次确认多久」：后者在一个安静信箱上天然是几天，拿它做判据会
 * 每隔一轮就白跑一次补齐。5min 远大于正常轮询间隔（30s）与进程重启（秒级），
 * 又远小于「一封急信该等多久」。
 */
export const DEFAULT_LAG_TOPUP_MS = 5 * 60_000

/** 进程内去重环容量（跨进程由锚点兜底，见 `selectFreshEvents` 的说明）。 */
export const SEEN_RING_CAP = 200

/**
 * 空账本的**哨兵游标**（T-46 ①）。
 *
 * 为什么需要它：账本文件是**平台 daemon 收到第一封信时才创建**的，而我们的
 * 基线游标 = 「账本里最后一次出现的 message_id」。空账本 ⇒ 没有任何
 * `message_id` 可写 ⇒ `commit()` 什么也写不出来 ⇒ **下一轮还是"没有游标"** ⇒
 * 永远停在 bootstrap，而那封让文件出现的信正好落在基线位置上，被静默吞掉
 * （T-45 §5c 实测：任何"还没有账本"的地址，第一封信不响、且没有任何日志）。
 *
 * 哨兵给出一个**明确的位置**：「文件起点之前」。它：
 *   - 让 `commit()` 有东西可写 ⇒ 基线立得起来，下一封信是"新事件"而不是"历史"；
 *   - 在 `selectFreshEvents` 里被解释成 `anchor_index = -1`（所有行都在它之后）；
 *   - 长得**不可能是** msg9 的 message_id（真实 id 形如 `msg_xxx`），所以永远不会
 *     意外命中某一行；`readConsumerLag` 也不会把它当成"锚点丢失"。
 *
 * ⚠️ 取舍（写清楚，不藏着）：平台 `msg9 daemon compact` 会把消费者游标当成
 * 账本里的 anchor line 来定位。哨兵**不在**账本里，所以压缩时平台可能认不出
 * 我们的位置。这条风险是**可控**的：① 哨兵只在"账本里一行都没有"时存在，
 * 平台压缩一个空账本没有任何可压的行；② 第一行一进账本，本消费者就会在同一
 * 轮里把它读成 fresh 并立刻改写游标为那个真实 id（最长一个轮询间隔）。
 * 另一条路（把"基线轮打一次 `folder=unprocessed` 对账"当**主**修法）不采用：
 * ① 基线轮**只立基线、不投递**是既有不变量 —— 拿服务器那一页去投递，等于把历史
 * 倒进会话，正是 bootstrap 禁止的事；② "有历史的账本首轮零 REST"是已测性质
 * （cutover.test ⑥ 钉着 `unprocessedCalls === 0`），改成基线轮一律打会把它换掉、
 * 且每个地址多付一次调用。
 * 本项目的组合是：**哨兵做机制**（第一封信不再被吞），**只在"空账本/无账本"**
 * 这一种基线轮额外对账一次、**只观测不投递** —— 把"这一轮跳过了几封"写进日志
 * （见 `watch.ts` 的 tick）。有历史的账本基线轮仍然是零 REST。
 */
export const EMPTY_LEDGER_CURSOR = 'msg9-ledger:empty'

/** 这个游标是不是空账本哨兵（不是真实 message_id）。 */
export function isEmptyLedgerCursor(anchor: string | undefined): boolean {
  return anchor === EMPTY_LEDGER_CURSOR
}

/**
 * 单轮**唤醒上限**（T-46 ③）：一次 poll 最多把多少条账本事件 / 多少封补齐邮件
 * 交给会话，剩下的**下一轮**再来。
 *
 * 依据（T-45 实测）：账本会**回填**，所以游标停在断档前最后一行时，
 * `dsh@msg9.ice` 一次冒出 127 条 fresh（lag 7.72d）、`kimi@msg9.ice` 150 条 ——
 * 一次性把几天前的旧信全丢进会话（而且每条都要去服务器取正文）。
 * 20 是"正常收信量（个位数）之上、一次性灌爆之下"的保守值：正常信箱永远碰不到
 * 这个上限（碰到也只是分两轮，不丢信）。
 */
export const DEFAULT_MAX_PER_ROUND = 20

// ------------------------------------------------------------------ 目录/路径

/** 账本目录：`~/.msg9/spool`（MSG9_HOME 可覆盖，测试用临时目录）。 */
export function spoolDir(): string {
  return join(msg9Home(), 'spool')
}

/** 某地址的账本文件：`spool/<address>.jsonl`。 */
export function ledgerPath(address: string, spool = spoolDir()): string {
  return join(spool, `${address}.jsonl`)
}

/** 本消费者的游标文件：`spool/<address>.<consumer>.cursor`。 */
export function consumerCursorPath(address: string, consumer = DEFAULT_CONSUMER, spool = spoolDir()): string {
  assertConsumerName(consumer)
  return join(spool, `${address}.${consumer}.cursor`)
}

/** 消费者名必须能作为文件名的最后一段被平台切出来。 */
export function assertConsumerName(consumer: string): void {
  if (!consumer || consumer.includes('.') || consumer.includes('/') || consumer.includes('\\')) {
    throw new Error(
      `msg9 ledger: consumer name must be non-empty and free of "." / "/" (the platform splits it out of <address>.<consumer>.cursor): ${JSON.stringify(consumer)}`,
    )
  }
}

// ------------------------------------------------------------------ 行解析

/** 一条账本事件（无正文，只有「谁的信到了」）。 */
export interface LedgerEvent {
  /** 账本格式版本（缺失记 0，不当坏行）。 */
  v: number
  type: string
  address: string
  message_id: string
  received_at: string
  /** `received_at` 的 epoch ms；不可解析 = NaN（不抛，排序时按 0 处理）。 */
  received_ms: number
}

export interface LedgerParse {
  events: LedgerEvent[]
  /** 空行/纯空白行（正常现象：追加写被中断只会在尾部留半个 JSON，不会留空行）。 */
  blank_lines: number
  /** 坏行：不是 JSON、不是对象、或缺 `message_id` —— 跳过并计数。 */
  bad_lines: number
}

/**
 * 解析一行账本。空行/坏行一律返回 `undefined`（**绝不抛**）：
 * 追加写的文件在崩溃点可能留半行，一行坏账不能让整个消费者瞎掉。
 */
export function parseLedgerLine(line: string): LedgerEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const row = parsed as Record<string, unknown>
  const messageId = row.message_id
  if (typeof messageId !== 'string' || messageId === '') return undefined
  const receivedAt = typeof row.received_at === 'string' ? row.received_at : ''
  return {
    v: typeof row.v === 'number' ? row.v : 0,
    type: typeof row.type === 'string' ? row.type : '',
    address: typeof row.address === 'string' ? row.address : '',
    message_id: messageId,
    received_at: receivedAt,
    received_ms: Date.parse(receivedAt),
  }
}

/** 解析整份账本文本（坏行跳过并计数）。 */
export function parseLedgerLines(text: string): LedgerParse {
  const events: LedgerEvent[] = []
  let blank_lines = 0
  let bad_lines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      blank_lines += 1
      continue
    }
    const event = parseLedgerLine(line)
    if (!event) {
      bad_lines += 1
      continue
    }
    events.push(event)
  }
  return { events, blank_lines, bad_lines }
}

/** 读账本的结果：解析计数 + **文件本身在不在**（不存在 = 平台还没为它写过第一行）。 */
export interface LedgerRead extends LedgerParse {
  /**
   * 账本文件是否存在。
   *
   * 为什么值得单独带出来：**"文件不存在"与"文件存在但一行都没有"是同一个空账本，
   * 却又是两种不同的现实**（前者 = 这个地址还没收到过信，后者 = 收到过但账本被清空/
   * truncate 过），日志里要能分开说；空账本基线的哨兵逻辑两者都要覆盖。
   */
  exists: boolean
}

/** 读账本文件：不存在 = 空账本（正常状态），其余 IO 错误照实抛。 */
export async function readLedger(path: string): Promise<LedgerRead> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], blank_lines: 0, bad_lines: 0, exists: false }
    throw error
  }
  return { ...parseLedgerLines(raw), exists: true }
}

// ------------------------------------------------------------------ 游标 IO

/**
 * 读本消费者的游标 = 锚点 message_id。
 *
 * 读不出来（文件不存在/不可读/内容为空）一律视作**没有游标**：
 * 后续会走 bootstrap 基线（不唤醒历史邮件），而不是把整本账本当成新信播报。
 */
export async function readConsumerCursor(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const anchor = raw.trim()
    return anchor || undefined
  } catch {
    return undefined
  }
}

/**
 * 写游标（原子：写临时文件 + rename，0600）。
 *
 * 写**裸 message_id + 换行**，与平台 compact 的定位口径一致（见模块头注释）。
 * 只在投递确认后调用 —— 「游标只在消费方确认后推进」是账本契约的一部分。
 */
export async function writeConsumerCursor(path: string, messageId: string): Promise<void> {
  const anchor = messageId.trim()
  if (!anchor) throw new Error('msg9 ledger: refusing to write an empty consumer cursor')
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temp, `${anchor}\n`, { mode: 0o600 })
  await rename(temp, path)
}

// ------------------------------------------------------------ 幂等消费（纯）

export interface SelectFreshOptions {
  /** 我们已确认到的锚点 message_id；缺省 = 首次消费（bootstrap）。 */
  anchor?: string
  /**
   * 已确认过的 message_id（进程内去重环）。
   *
   * 为什么锚点之外还需要它：锚点是「最后确认的那条**行**」，而账本里同一个
   * message_id 可以出现多次 —— 平台自己的 DM-2 就写明「没有凭据过滤时，
   * N 个 daemon 会把同一封信 ledger N 次」。锚点只能挡住它**之前**的副本。
   * 跨进程重启后这个环是空的，兜底交给服务器真相（唤醒路径本就要用
   * `folder=unprocessed` 复核，见 watch.ts 的 onlyUnprocessed）。
   */
  seen?: Iterable<string>
  /**
   * 单轮上限（T-46 ③）：只取**文件序前 N 条**候选事件，剩下的下一轮再来。
   *
   * 为什么是"文件序前 N 条"而不是"received_at 最早的 N 条"：账本不保证有序
   * （模块头契约 5），游标要推进到一个**文件里确定存在的位置**。按时间挑最老的
   * N 条会让游标跳到文件中间，把「文件序在锚点之后、但时间上更早」的那些行
   * **永久跳过** —— 那是真丢信。按文件序切则天然安全：游标 = 第 N 条，
   * 其余行仍在游标之后，下一轮照常被选中。
   *
   * 缺省/非法值 = 不限（`readConsumerLag` 这类只读观测必须看到**真实**积压）。
   */
  limit?: number
}

export interface FreshSelection {
  /** 本次要叫醒的新事件（按 received_at 升序，同 id 只留最早一条）。 */
  fresh: LedgerEvent[]
  /** 调用方给的**当前**锚点（原样带回；用于区分「没游标」与「锚点找不到」）。 */
  anchor?: string
  /** 锚点在账本里的位置（取**最后一次**出现，跳过同 id 的重复副本）。 */
  anchor_index?: number
  /** 有游标、但锚点已不在账本里（被压缩掉/换过消费者名）⇒ 只能走补齐。 */
  anchor_found: boolean
  /** 锚点之后的事件条数（含重复），即「未消费积压」—— **不受 `limit` 影响**。 */
  unconsumed: number
  /** 被去重丢掉的事件数（锚点之前的副本不计入）。 */
  duplicates: number
  /** 因为单轮上限而**推到下一轮**的事件条数（0 = 没触发上限）。 */
  deferred: number
  /** 本批确认后应写入游标的 message_id（没有新行时 = 原锚点）。 */
  next_anchor?: string
}

/**
 * 从账本尾部取「锚点之后」的新事件，并保证**同一 message_id 只出现一次**。
 *
 * 顺序：先定位锚点（同 id 取最后一次），再扫它之后的行，逐条过 `seen` 与本批
 * 已发集合；最后按 `received_at` 升序返回（乱序追加也按时间讲，`renderMailNotice`
 * 同样会再排一次）。**乱序事件不丢** —— 只有「同一个 id」才被去重，时间上的
 * 先后不是丢弃理由。
 *
 * 空账本哨兵（`EMPTY_LEDGER_CURSOR`）被解释成「文件起点之前」：所有行都在它之后，
 * 并且 `anchor_found: true`（位置是明确的，不是"找不到"）。
 */
export function selectFreshEvents(events: readonly LedgerEvent[], options: SelectFreshOptions = {}): FreshSelection {
  const anchor = options.anchor
  let anchorIndex: number | undefined
  if (anchor) {
    if (isEmptyLedgerCursor(anchor)) {
      // 空账本基线：站在第 0 行之前（索引 -1），于是 `slice(0)` = 全部事件。
      anchorIndex = -1
    } else {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.message_id === anchor) {
          anchorIndex = index
          break
        }
      }
    }
  }
  const allCandidates = anchorIndex === undefined ? [...events] : events.slice(anchorIndex + 1)
  // 单轮上限只裁剪"这一轮要处理的窗口"，**不改变 `unconsumed`**（那是真实积压，
  // 滞后判据与状态展示都要它）。非正数/非有限值一律当"不限"。
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : undefined
  const candidates = limit === undefined ? allCandidates : allCandidates.slice(0, limit)
  const seen = new Set<string>(options.seen ?? [])
  const fresh: LedgerEvent[] = []
  for (const event of candidates) {
    if (seen.has(event.message_id)) continue
    seen.add(event.message_id)
    fresh.push(event)
  }
  fresh.sort((a, b) => (Number.isFinite(a.received_ms) ? a.received_ms : 0) - (Number.isFinite(b.received_ms) ? b.received_ms : 0))
  const last = candidates[candidates.length - 1]
  return {
    fresh,
    ...(anchor === undefined ? {} : { anchor }),
    anchor_index: anchorIndex,
    anchor_found: anchor !== undefined && anchorIndex !== undefined,
    unconsumed: allCandidates.length,
    duplicates: candidates.length - fresh.length,
    deferred: allCandidates.length - candidates.length,
    next_anchor: last?.message_id ?? anchor,
  }
}

/** 把已确认的 id 并进去重环（保留最近 `cap` 个）。 */
export function mergeSeenIds(existing: readonly string[], acked: readonly string[], cap = SEEN_RING_CAP): string[] {
  const seen = new Set(existing)
  const merged = [...existing]
  for (const id of acked) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

// ------------------------------------------------------------------ 滞后观测

export interface CursorLag {
  anchor_message_id: string
  /** 锚点是否还能在账本里定位（false ⇒ 别猜位置，直接走 inbox 补齐）。 */
  anchor_found: boolean
  /** 账本里锚点之后的事件条数。 */
  unconsumed: number
  /**
   * **滞后秒数**：账本里**最老**的未消费事件距今多久（= 最早那封信在我们这儿
   * 干等了多久）。已跟上 = 0。取「最老」而不是「最新」：判据要的是「我们落后
   * 了多久」，取最新会把一次 10 分钟的停摆误算成 1 分钟。
   */
  lag_seconds: number
  /**
   * 距我们最后一次确认过去了多久。**安静信箱上天然很大**（几天也正常），
   * 只作展示，不作判据 —— 否则每个空闲信箱都会周期性白跑补齐。
   */
  cursor_age_seconds?: number
}

/**
 * 由「账本 + 选择结果」算滞后。
 *
 * 口径是**当前游标**（`selection.anchor`，不是 `next_anchor`）：滞后描述的是
 * 「我们现在站在哪儿、还欠多少」。没有游标（首次消费）时返回 `undefined` ——
 * 尚未建立位置，谈不上滞后，也不该被当成「滞后无穷大」。
 */
export function computeCursorLag(events: readonly LedgerEvent[], selection: FreshSelection, nowMs: number): CursorLag | undefined {
  const anchor = selection.anchor
  if (anchor === undefined) return undefined
  if (!selection.anchor_found) {
    return { anchor_message_id: anchor, anchor_found: false, unconsumed: selection.unconsumed, lag_seconds: 0 }
  }
  const anchorEvent = selection.anchor_index === undefined ? undefined : events[selection.anchor_index]
  const unconsumedEvents = selection.unconsumed > 0 ? events.slice(events.length - selection.unconsumed) : []
  const oldestUnconsumed = unconsumedEvents.reduce<LedgerEvent | undefined>(
    (oldest, event) => (oldest === undefined || (Number.isFinite(event.received_ms) && event.received_ms < oldest.received_ms) ? event : oldest),
    undefined,
  )
  const lagMs = oldestUnconsumed && Number.isFinite(oldestUnconsumed.received_ms) ? Math.max(0, nowMs - oldestUnconsumed.received_ms) : 0
  const cursorAgeMs = anchorEvent && Number.isFinite(anchorEvent.received_ms) ? Math.max(0, nowMs - anchorEvent.received_ms) : undefined
  return {
    anchor_message_id: anchor,
    anchor_found: true,
    unconsumed: selection.unconsumed,
    lag_seconds: Math.round(lagMs / 1000),
    ...(cursorAgeMs === undefined ? {} : { cursor_age_seconds: Math.round(cursorAgeMs / 1000) }),
  }
}

// ------------------------------------------------------------------ 补齐判据

export type TopUpReason = 'explicit' | 'anchor-lost' | 'lag' | 'daemon-down' | 'daemon-disconnected'
/**
 * 平台 daemon 健康 —— **两条正交轴**（T-46 ②）。
 *
 *   - **进程轴**：`last_beat` 还新不新鲜 ⇒ `up` / `dead`（进程没了）；
 *   - **连接轴**：这个地址的租户/票据**连没连上** ⇒ `disconnected`
 *     （进程活得好好的，但这个租户的流连不上 ⇒ **它的信不会进账本**）。
 *
 * T-45 的盲区正是这里：原实现只看 `stalled`，于是一条 `connected:false`
 * （真实数据里 3 条：`kimi.code` / `dsh@kimi.ice.msg9.io` / `cc-dsh-audit@ccd.ice.msg9.io`）
 * 照样报 `up` ⇒ `decideTopUp` 完全看不见 ⇒ 切到 ledger 后那些地址
 * **既没有唤醒来源、也没有任何告警**。
 */
export type DaemonHealth = 'up' | 'stalled' | 'disconnected' | 'dead' | 'unknown'

export interface TopUpInput {
  /** 我们的游标文件是否存在且非空。 */
  hasCursor: boolean
  /** 游标里的 message_id 是否还能在账本里定位。 */
  anchorFound: boolean
  /** `CursorLag.lag_seconds`。 */
  lagSeconds?: number
  lagThresholdMs?: number
  /** 平台 daemon 健康（两条正交轴的另一半；阶段二接 .daemon-status）。 */
  daemon?: DaemonHealth
  /** 显式调用（例如会话启动）：无条件补齐。 */
  force?: boolean
}

export interface TopUpDecision {
  topUp: boolean
  reason?: TopUpReason
  /** 首次消费：只建立基线，**不唤醒历史邮件**（与现有 watcher 的 bootstrap 一致）。 */
  bootstrap?: boolean
  detail?: string
}

/**
 * 何时走 inbox unread 补齐。
 *
 * 判据顺序（先到先判）：
 *   1. `force` ⇒ 显式补齐；
 *   2. 没有游标 ⇒ **bootstrap，不补齐**：首次消费只把基线立到账本尾部，
 *      与现有进程内 watcher 的首次观测行为一致（绝不能把历史邮件倒进会话）；
 *   3. 有游标但锚点不在账本里 ⇒ 补齐（位置不可信，别拿账本猜）；
 *   4. daemon 说它 stalled/dead ⇒ 补齐：**它掉线期间到达的信根本没进账本**，
 *      账本自身的滞后必然显示为 0，这条判据是唯一能覆盖该缺口的东西；
 *   4b. daemon 说它 `disconnected`（进程活着、但**这个租户/票据连不上**）⇒ 同样补齐：
 *      连不上的租户的信同样不会进账本，与掉线是同一个缺口（T-46 ②）。
 *   5. 滞后超过阈值 ⇒ 补齐。
 *
 * 阈值 `<= 0` = 关闭「按滞后触发」（与 state.ts 里 orphanPendingTtlMs 的口径一致：
 * 写 0 的人想要的是「别动」，不是「每次都触发」）。
 */
export function decideTopUp(input: TopUpInput): TopUpDecision {
  if (input.force) return { topUp: true, reason: 'explicit' }
  if (!input.hasCursor) {
    return { topUp: false, bootstrap: true, detail: 'no consumer cursor yet: establish the baseline, never announce history' }
  }
  if (!input.anchorFound) return { topUp: true, reason: 'anchor-lost', detail: 'the cursor anchor is no longer in the ledger' }
  if (input.daemon === 'stalled' || input.daemon === 'dead') {
    return { topUp: true, reason: 'daemon-down', detail: `platform daemon reports ${input.daemon}` }
  }
  if (input.daemon === 'disconnected') {
    return {
      topUp: true,
      reason: 'daemon-disconnected',
      detail: 'the platform daemon is alive but this tenant/ticket is NOT connected — nothing is ledgered for it',
    }
  }
  const threshold = input.lagThresholdMs ?? DEFAULT_LAG_TOPUP_MS
  if (threshold > 0 && typeof input.lagSeconds === 'number' && Number.isFinite(input.lagSeconds) && input.lagSeconds * 1000 > threshold) {
    return { topUp: true, reason: 'lag', detail: `cursor lag ${input.lagSeconds}s > ${Math.round(threshold / 1000)}s` }
  }
  return { topUp: false }
}

/** 从补齐结果里挑出**还没确认过**的邮件（同 id 只留一条，保序）。 */
export function selectTopUpMessages(messages: readonly InboxMessage[], seen: Iterable<string> = []): InboxMessage[] {
  const known = new Set(seen)
  const picked: InboxMessage[] = []
  for (const message of messages) {
    const id = message?.message_id
    if (typeof id !== 'string' || id === '' || known.has(id)) continue
    known.add(id)
    picked.push(message)
  }
  return picked
}

// ------------------------------------------------------------------ 消费者

export interface LedgerConsumerDeps {
  address: string
  consumer?: string
  /** spool 目录覆盖（测试用临时目录）。 */
  spoolDir?: string
  now?(): number
  lagThresholdMs?: number
  /** 单轮唤醒上限（默认 `DEFAULT_MAX_PER_ROUND`；见那里对依据的说明）。 */
  maxPerRound?: number
  /** 补齐来源：**inbox unread**（`listInbox(api, key, { folder: 'unread' })`）。 */
  fetchUnread?(): Promise<InboxMessage[]>
  /** 阶段二接 `~/.msg9/spool/.daemon-status[-<scope>].json`；缺省 unknown。 */
  daemonHealth?(): Promise<DaemonHealth>
  log?(message: string): void
}

export interface LedgerPoll {
  /** 本次要叫醒的账本事件。**首次消费（无游标）恒为空** —— 见 `baseline`。 */
  fresh: LedgerEvent[]
  /**
   * 首次消费：本轮只建立基线（把游标定位到账本尾部），不唤醒历史邮件。
   * 与 `watch.ts` 的 bootstrap 同一条规矩（`the first peek must not dump the
   * mailbox history into the session`），也是**不变量**：没有游标 ⇒ 账本事件
   * 一律不唤醒，要么什么都不说，要么由 `force` 走 inbox 补齐。
   *
   * ⚠️ T-46 ① 起有一个**例外**：账本里**一行都没有**时，基线写的是
   * `EMPTY_LEDGER_CURSOR` 哨兵（"文件起点之前"），于是**让文件第一次出现的
   * 那封信**是"新事件"而不是"历史" —— 这正是修掉"第一封信静默被吞"的地方。
   * 有历史的账本（≥1 行）行为一字未改。
   */
  baseline: boolean
  top_up: TopUpDecision
  /** 补齐取回、且还没确认过的邮件（未接线时为空数组）。 */
  top_up_messages: InboxMessage[]
  lag?: CursorLag
  duplicates: number
  bad_lines: number
  /** 账本里的事件条数（空账本 = 0；`baseline` 与日志都用它说明"本轮 N 条不唤醒"）。 */
  ledger_events: number
  /** 账本文件在不在（不存在 = 平台还没为这个地址写过第一行）。 */
  ledger_exists: boolean
  /** 因为单轮上限被推到下一轮的事件条数。 */
  deferred: number
  ledger_path: string
  cursor_path: string
  /**
   * 推进游标。**只在 `fresh` / `top_up_messages` 都投递确认之后调用**；
   * 幂等（重复调用只写一次），失败不回滚已投递的通知。
   * `baseline` 轮也必须 commit（否则基线永远立不起来、下轮还是首次消费）。
   */
  commit(): Promise<void>
}

export interface LedgerConsumer {
  /** 跑一轮：读账本 + 游标 → 选新事件 → 判补齐 → 交回待确认的一批。 */
  pollOnce(options?: { force?: boolean }): Promise<LedgerPoll>
}

/**
 * 建一个账本消费者。
 *
 * 明确的**不变量**：`pollOnce` 绝不写游标；只有 `commit()` 写。所以调用方
 * 「没有活会话 ⇒ 不 commit」就等于「没有活会话 ⇒ 不推进游标 ⇒ 下轮重投」，
 * 与自研 daemon 的 409 ⇒ pending ⇒ register 后重投是同一条语义。
 */
export function createLedgerConsumer(deps: LedgerConsumerDeps): LedgerConsumer {
  const consumer = deps.consumer ?? DEFAULT_CONSUMER
  const spool = deps.spoolDir ?? spoolDir()
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? (() => {})
  const lagThresholdMs = deps.lagThresholdMs ?? DEFAULT_LAG_TOPUP_MS
  const maxPerRound = deps.maxPerRound ?? DEFAULT_MAX_PER_ROUND
  const ledger = ledgerPath(deps.address, spool)
  const cursorFile = consumerCursorPath(deps.address, consumer, spool)
  let seen: string[] = []

  return {
    async pollOnce(options = {}) {
      const parsed = await readLedger(ledger)
      const anchor = await readConsumerCursor(cursorFile)
      const baseline = anchor === undefined
      // 单轮上限**只在非基线轮**生效：基线轮的目的是把位置钉到文件尾部，
      // 一旦在这里裁剪，`next_anchor` 会停在文件中间 ⇒ 下一轮把剩下的历史
      // 当成"新信"倒进会话（那是历史倾倒，不是分流）。
      const selection = selectFreshEvents(parsed.events, {
        ...(anchor === undefined ? {} : { anchor }),
        seen,
        ...(baseline ? {} : { limit: maxPerRound }),
      })
      // 首次消费不报历史：滞后观测也就无从谈起（没有可比的锚点）。
      const lag = baseline ? undefined : computeCursorLag(parsed.events, selection, now())
      // T-46 ①：空账本 ⇒ 本轮是**哨兵基线**（下一封信就唤醒），而不是"永远 bootstrap"。
      const emptyLedgerBaseline = baseline && parsed.events.length === 0
      if (emptyLedgerBaseline) {
        log(
          `msg9 ledger: ${deps.address}: ${parsed.exists ? 'the ledger file is EMPTY' : 'there is NO ledger file yet'} — ` +
            `establishing an empty-ledger baseline (sentinel cursor "${EMPTY_LEDGER_CURSOR}" = "before the first line"), ` +
            `nothing to announce this round; the next mail to arrive WILL wake. ` +
            `（账本为空/无账本 ⇒ 已立哨兵基线，本轮 0 条不唤醒；下一封信会正常唤醒。）`,
        )
      }
      if (selection.deferred > 0) {
        log(
          `msg9 ledger: ${deps.address}: per-round wake cap is ${maxPerRound}; ` +
            `${selection.deferred} event(s) deferred to the next round (nothing is dropped).`,
        )
      }
      let daemon: DaemonHealth = 'unknown'
      if (deps.daemonHealth) {
        try {
          daemon = await deps.daemonHealth()
        } catch (error) {
          log(`msg9 ledger: daemon health unavailable (${(error as Error)?.message ?? String(error)})`)
        }
      }
      const topUp = decideTopUp({
        hasCursor: !baseline,
        anchorFound: selection.anchor_found,
        ...(lag === undefined ? {} : { lagSeconds: lag.lag_seconds }),
        lagThresholdMs,
        daemon,
        ...(options.force === undefined ? {} : { force: options.force }),
      })
      if (parsed.bad_lines > 0) log(`msg9 ledger: skipped ${parsed.bad_lines} bad line(s) in ${ledger}`)

      let topUpMessages: InboxMessage[] = []
      if (topUp.topUp && deps.fetchUnread) {
        try {
          // 补齐要排除「本轮已经拿到手上的」：去重环 + 当前锚点 + 本批账本事件。
          // 不排除的话同一封信会同时出现在 fresh 与 top_up_messages 里
          // （服务器 unprocessed 复核能兜住，但骨架不该自己制造重复）。
          const exclude = new Set<string>(seen)
          if (anchor !== undefined) exclude.add(anchor)
          for (const event of selection.fresh) exclude.add(event.message_id)
          const picked = selectTopUpMessages(await deps.fetchUnread(), exclude)
          // 单轮上限（T-46 ③）：剩下的**留在服务器上**（不进去重环、不推游标），
          // 下一轮还会被同一页取回来 —— 这就是"剩余下轮"，不是丢弃。
          topUpMessages = picked.slice(0, maxPerRound)
          log(
            `msg9 ledger: top-up (${topUp.reason}) fetched ${topUpMessages.length} unconfirmed mail(s)` +
              (picked.length > topUpMessages.length ? `; ${picked.length - topUpMessages.length} more deferred to the next round (cap ${maxPerRound})` : ''),
          )
        } catch (error) {
          // 补齐失败不致命：账本这一批照投，下轮再补（信在服务器，不丢）。
          log(`msg9 ledger: top-up failed (${(error as Error)?.message ?? String(error)}); ledger batch still delivered`)
        }
      }

      const fresh = baseline ? [] : selection.fresh
      let committed = false
      // 去重环用 **selection.fresh**（含 baseline 轮）而不是对外返回的 `fresh`：
      // 基线轮不唤醒任何人，但那批 id 必须进环 —— 否则它们日后被重复 ledger
      // （追在锚点之后）时会以「新信」的身份再叫一次。单轮上限只影响这一批的
      // 大小：被推到下一轮的那些**不在** acked 里，下轮照常被选中。
      const ackedIds = [...selection.fresh.map((event) => event.message_id), ...topUpMessages.map((message) => message.message_id)]
      return {
        fresh,
        baseline,
        top_up: topUp,
        top_up_messages: topUpMessages,
        ...(lag === undefined ? {} : { lag }),
        duplicates: selection.duplicates,
        bad_lines: parsed.bad_lines,
        ledger_events: parsed.events.length,
        ledger_exists: parsed.exists,
        deferred: selection.deferred,
        ledger_path: ledger,
        cursor_path: cursorFile,
        async commit() {
          if (committed) return
          committed = true
          // 顺序：先记去重环，再落游标 —— 游标写失败时至少本进程内不会重复叫。
          seen = mergeSeenIds(seen, ackedIds)
          // 游标写什么：
          //   ① 有下一行（非空账本 / 已有积压）⇒ 那一行的 message_id（与平台 compact 同口径）；
          //   ② 空账本基线 ⇒ **哨兵**（"文件起点之前"）—— 不写的话基线永远立不起来，
          //      而账本文件恰恰是收到第一封信时才创建的（T-45 §5c / T-46 ①）。
          const anchorToWrite = selection.next_anchor ?? (emptyLedgerBaseline ? EMPTY_LEDGER_CURSOR : undefined)
          if (anchorToWrite) await writeConsumerCursor(cursorFile, anchorToWrite)
        },
      }
    },
  }
}

/**
 * 只读的滞后观测 —— **`msg9_status` 要显示的那一项**。
 *
 * 刻意做成独立函数（不经过 `createLedgerConsumer`）：状态查询不该有副作用、
 * 不该建去重环、更不该写任何文件。
 */
export async function readConsumerLag(
  address: string,
  consumer = DEFAULT_CONSUMER,
  options: { spoolDir?: string; now?: number } = {},
): Promise<CursorLag | undefined> {
  const spool = options.spoolDir ?? spoolDir()
  const parsed = await readLedger(ledgerPath(address, spool))
  const anchor = await readConsumerCursor(consumerCursorPath(address, consumer, spool))
  if (anchor === undefined) return undefined
  // 只读路径没有去重环（也就没有「已确认」集合）：用空集合选一次，
  // 只为了拿到锚点位置与未消费积压 —— 幂等的判断不在这里做。
  const selection = selectFreshEvents(parsed.events, { anchor })
  return computeCursorLag(parsed.events, selection, options.now ?? Date.now())
}
