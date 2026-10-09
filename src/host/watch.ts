/**
 * New-mail watcher — the push half of the mailbox.
 *
 * The agent loop is turn-based: without a trigger it never thinks of checking
 * msg9. This module polls every provisioned inbox on an interval and, when
 * new mail arrives, delivers a plugin notice into the workspace's live
 * session:
 *
 *   - `agent.followup()` — queue a turn and wake the driver (costs tokens),
 *     capped by a storm budget so a busy inbox cannot pin the agent;
 *   - `agent.inject()` — context only, once the budget is spent.
 *
 * The watcher keeps its OWN cursor (`watch_cursor` / `watch_last_message_id`
 * in the state file): a background peek must never advance the tool's cursor,
 * or the next `msg9_inbox` call would report nothing new.
 *
 * The cordis wiring lives in `index.ts`; everything here is
 * dependency-injected so the logic runs against fakes in tests.
 *
 * @module dsh-msg9-kit/watch
 */

import type { InboxMessage, InboxPage } from './api.ts'
import { bodyText, truncate } from '../shared/message.ts'
import type { LiveInbox, State } from './store.ts'
import { DEFAULT_LAG_TOPUP_MS, createLedgerConsumer, type DaemonHealth } from './ledger.ts'
import { assertObservedWakeSources, planLedgerBatch, type WakeSource } from './cutover.ts'

/** The live-agent face the watcher delivers to (subset of dsh's agent). */
export interface WatchAgent {
  readonly id: string
  followup(message: WatchMessage): void
  inject(message: WatchMessage): void
}

/** A model-facing message (the UserMessage shape dsh expects). */
export interface WatchMessage {
  role: 'user'
  id: string
  content: { type: 'text'; text: string }[]
  /** v4 producer-owned source: dsh's persistence layer refuses the retired
   *  `kind: 'plugin'` wrapper — the producer kind is `plugin:<name>`, exactly
   *  what dsh's own v3→v4 migrator generates for this source. */
  source: { kind: 'plugin:msg9-kit'; form: 'notice'; summary: string }
}

export interface WatchDeps {
  loadState(): Promise<State>
  setWatchState(key: string, patch: { watch_cursor?: string; watch_last_message_id?: string; watch_last_seen_at?: string; last_wake_agent_id?: string }): Promise<void>
  listInbox(apiUrl: string, apiKey: string, query: { folder?: string; limit?: number; since?: string }): Promise<InboxPage>
  /** The workspace's live agent, if any (delivery is skipped when offline). */
  resolveAgent(workspace: { key: string; inbox: LiveInbox }): WatchAgent | undefined | Promise<WatchAgent | undefined>
  /** Sticky-target lookup: is this session still alive? */
  resolveAgentById?(id: string): WatchAgent | undefined
  /** SSE invalidation hook: fired when fresh mail is SEEN (before delivery). */
  onEvent?(event: string): void
  /**
   * T-23：把这轮 fetch 里**已经拿到的**未读读数交出去（徽章用它，就不必再对
   * 每个信箱各打一次 `folder=all&limit=1` —— msg9 PO 从生产日志里数出这块
   * 3380 次/天，而推送页本来就带着同一个 `unread_count`）。
   *
   * ⚠️ `total` **只在该查询确实是"folder 全量命中数"时才传**：`since` 模式下的
   * `total` 是"游标之后的行数"（服务端 DEF-020），当信箱大小用是错的。
   */
  onInboxSnapshot?(key: string, snapshot: { unread?: number; total?: number; at?: number }): void
  /** Notification mute: while true, mail is tracked but never delivered. */
  isPaused?(): boolean | Promise<boolean>
  /** Coalescing window for related mails (default 12s; 0 disables batching). */
  batchWindowMs?: number
  /** 退避等待（429 时）；缺省用 defaultSleep。 */
  sleep?(ms: number): Promise<void>
  /** Stable id source for messages (crypto.randomUUID in production). */
  uuid(): string
  now(): number
  log(message: string): void
}

/** Build the plugin notice dsh's agent contract expects (UserMessage). */
export function pluginNotice(uuid: string, text: string, summary: string): WatchMessage {
  return {
    role: 'user',
    id: uuid,
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:msg9-kit', form: 'notice', summary: truncate(summary, 120) },
  }
}

/** Render the new-mail notice: chronological (a correction follows its
 *  original), threads marked, one call to action — check the UNPROCESSED. */
export function renderMailNotice(address: string, messages: InboxMessage[]): { text: string; summary: string } {
  const ordered = [...messages].sort((a, b) => {
    const at = Date.parse(a.created_at ?? '') || 0
    const bt = Date.parse(b.created_at ?? '') || 0
    return at - bt
  })
  const threadSizes = new Map<string, number>()
  for (const message of ordered) {
    if (message.correlation_id) threadSizes.set(message.correlation_id, (threadSizes.get(message.correlation_id) ?? 0) + 1)
  }
  const shown = ordered.slice(0, 5)
  const lines = shown.map((message, index) => {
    const subject = message.subject ? `「${message.subject}」` : ''
    const preview = truncate(bodyText(message), 90)
    const thread = message.correlation_id && (threadSizes.get(message.correlation_id) ?? 0) > 1 ? ' [线程]' : ''
    return `${index + 1}. ${message.from_address} ${subject}${thread}${preview ? `：${preview}` : ''}`
  })
  const more = ordered.length > shown.length ? `\n…以及另外 ${ordered.length - shown.length} 封。` : ''
  const first = ordered[0]
  return {
    text:
      `[msg9 新邮件] 你的 inbox ${address} 收到 ${ordered.length} 封新邮件：\n` +
      lines.join('\n') + more +
      `\n请调用 msg9_inbox（folder=unprocessed）查看未处理的并逐一闭环（回复带 reply_to；已在别处处理过的不会再出现）。`,
    summary: first ? `new msg9 mail from ${first.from_address}` : 'new msg9 mail',
  }
}

/**
 * Storm budget: at most `maxWakes` followup-wakes per `windowMs` per agent.
 * Beyond that, mail degrades to context-only injection until the window
 * slides past the oldest wake.
 */
export class WakeBudget {
  private wakes: number[] = []
  constructor(
    readonly maxWakes = 3,
    readonly windowMs = 30 * 60_000,
  ) {}
  /** 'wake' and record, or 'inject' once the window is full. */
  decide(now: number): 'wake' | 'inject' {
    this.wakes = this.wakes.filter((at) => now - at < this.windowMs)
    if (this.wakes.length >= this.maxWakes) return 'inject'
    this.wakes.push(now)
    return 'wake'
  }
}

/**
 * The watcher's mutable runtime: per-AGENT wake budgets (one busy session
 * cannot be pinned), per-INBOX wake budgets (N sessions of one workspace
 * cannot multiply the allowance), and the coalescing batches (a flurry of
 * related mails — e.g. a correction following a mistake — lands as ONE
 * interruption, in chronological order).
 */
export interface WatchRuntime {
  agentBudgets: Map<string, WakeBudget>
  inboxBudgets: Map<string, WakeBudget>
  batches: Map<string, { messages: Map<string, InboxMessage>; timer?: ReturnType<typeof setTimeout> }>
  /**
   * T-67：**本会话（进程）已经唤醒过**的 message_id —— 跨路径共享的去重环。
   *
   * 为什么放在这里：唤醒是不可撤销的副作用（`followup` 会真的开一轮、花钱），
   * 而 `deliverBatch` 是**所有**唤醒路径唯一的出口。所以"同一封信被响应两次"
   * 这件事只可能在**出口之前**被拦下来，且必须被**所有路径共享**地拦。
   *
   * ⚠️ 边界（说清楚，免得被当成万能药）：它是**进程内**的。桌面宿主与 `dsh web`
   * 是两个进程，各有一份；**跨进程**的重复不在这一层 —— T-67 的现场观测结论是
   * 「同一条信被两个 host 进程各响一次」，那一层要的是跨进程互斥，不是这个环。
   */
  announced: Set<string>
  /** T-67：本进程**实际触发过**的唤醒来源（运行时观测，区别于接线计划）。 */
  wakeSources: Set<WakeSource>
  /** T-67：这份接线计划允许的来源；缺省（undefined）表示不做运行时校验。 */
  allowedWakeSources?: readonly WakeSource[]
  /** T-67：运行时实际违反「只有一个唤醒来源」时的原文（诊断 / 测试用）。 */
  wakeViolation?: string
}

/** T-67：去重环的容量（与账本 `SEEN_RING_CAP` 同量级，超出按插入序淘汰最老的）。 */
export const ANNOUNCED_RING_CAP = 500

export function createWatchRuntime(options: { allowedWakeSources?: readonly WakeSource[] } = {}): WatchRuntime {
  return {
    agentBudgets: new Map(),
    inboxBudgets: new Map(),
    batches: new Map(),
    announced: new Set(),
    wakeSources: new Set(),
    ...(options.allowedWakeSources ? { allowedWakeSources: options.allowedWakeSources } : {}),
  }
}

/** 记一笔"这封信在本会话里叫过了"。环满就按插入序淘汰最老的。 */
function noteAnnounced(rt: WatchRuntime, messageId: string): void {
  rt.announced.add(messageId)
  while (rt.announced.size > ANNOUNCED_RING_CAP) {
    const oldest = rt.announced.values().next().value
    if (oldest === undefined) break
    rt.announced.delete(oldest)
  }
}

/**
 * T-67 的**唤醒出口观测行**（结构化、一行一封、可 grep）。
 *
 * 卡面要求的五件事逐项对应：
 *   · 唤醒来源  → `source`（`ledger-consumer` / `in-process-watcher` / `self-daemon`）
 *                 + `origin`（同一来源内部的来路：`ledger` / `unread-top-up` / `inbox-page`）
 *   · message_id → `message_id`
 *   · address    → `address`
 *   · 已通知过   → `announced=yes|no`（本进程的去重环里有没有它）
 *   · 时间戳     → `at`（ISO8601）
 * 另外补两个**归因必需**的字段：
 *   · `pid` —— 现场那条 2:1 的关键：同一条信被**两个 host 进程**各响一次，只报
 *     `source` 是看不出来的（两个进程报的是同一个 source、同一个 message_id）；
 *   · `session` —— 醒的是哪个会话（同一个 workspace 可以有两个活会话）。
 */
export function wakeLine(entry: {
  source: WakeSource
  origin: string
  address: string
  messageId: string
  /** 本进程的去重环里有没有它（卡面的「已通知过=是/否」）。 */
  announced: boolean
  agent: string
  decision: 'wake' | 'inject' | 'skip'
  at: number
}): string {
  return 'msg9 wake:'
    + ` source=${entry.source}`
    + ` origin=${entry.origin}`
    + ` message_id=${entry.messageId}`
    + ` address=${entry.address}`
    + ` announced=${entry.announced ? 'yes' : 'no'}`
    + ` pid=${process.pid}`
    + ` session=${entry.agent}`
    + ` decision=${entry.decision}`
    + ` at=${new Date(entry.at).toISOString()}`
}

/**
 * T-67：记下"这次是谁响的"，并按计划校验。
 *
 * 生产里**只记日志、绝不抛**：投递本身是好事，为了"来源不合法"把信扔掉或把循环
 * 炸掉（unhandledRejection 会带走宿主）都是更坏的失败。判据仍然只有一条
 * （`assertObservedWakeSources`），这里只是把它的抛错包成一行响亮的日志。
 */
function noteWakeSource(rt: WatchRuntime, source: WakeSource, log: (message: string) => void): void {
  rt.wakeSources.add(source)
  if (!rt.allowedWakeSources) return
  try {
    assertObservedWakeSources(rt.wakeSources, rt.allowedWakeSources)
  } catch (error) {
    rt.wakeViolation = (error as Error).message
    log(`msg9 wake: VIOLATION ${rt.wakeViolation}`)
  }
}

/** Drop messages the watcher already reported (bootstrap baseline filter). */
export function unseenMessages(messages: InboxMessage[], lastSeenId: string | undefined, lastSeenAt?: string): InboxMessage[] {
  if (!lastSeenId) return messages
  const index = messages.findIndex((message) => message.message_id === lastSeenId)
  if (index !== -1) return messages.slice(0, index)
  // The baseline id scrolled off the page (or the state was rebuilt): never
  // dump the whole page as "new" — fall back to the timestamp baseline, so
  // already-announced mail can never be re-announced (the P4 duplicate wakes).
  if (lastSeenAt) {
    const baseline = Date.parse(lastSeenAt)
    if (Number.isFinite(baseline)) {
      return messages.filter((message) => {
        const created = Date.parse(message.created_at ?? '')
        return Number.isFinite(created) ? created > baseline : true
      })
    }
  }
  return messages
}

/**
 * 防重入守卫：setInterval 不等待上一轮的异步任务，而单轮 poll 可能挂 30s
 * （上游超时），间隔更短时会自我重叠。上一轮没完就跳过本轮。
 */
export function createNonReentrant(task: () => Promise<void>): () => void {
  let running = false
  return () => {
    if (running) return
    running = true
    void task().finally(() => {
      running = false
    })
  }
}

/** One poll across every provisioned inbox. Never throws. */
export async function pollOnce(deps: WatchDeps, rt: WatchRuntime): Promise<void> {
  const state = await deps.loadState()
  for (const [key, inbox] of Object.entries(state.workspaces)) {
    // state.json 迁移后不再存密钥：生产接线（index.ts）的 loadState 会经
    // resolveCredentials 回填；测试替身直接给完整 inbox。缺身份/密钥的
    // entry（凭据丢失）跳过，不当作致命错误。
    if (!inbox.api_key || !inbox.api_url || !inbox.address) continue
    try {
      await pollInbox(deps, rt, key, inbox as LiveInbox)
    } catch (error) {
      deps.log(`watch poll failed for ${key}: ${(error as Error)?.message ?? String(error)}`)
      // v1.17 对齐 stream 模式：429 要读 Retry-After 退避，而不是下个周期
      // 又立刻打一轮（单请求可挂 30s，叠加轮询间隔也救不了放大）。
      const status = (error as { status?: unknown })?.status
      if (status === 429) {
        const serverWait = (error as { retryAfter?: unknown })?.retryAfter
        const backoff = typeof serverWait === 'number' && serverWait > 0 ? serverWait * 1000 : 60_000
        deps.log(`watch poll rate-limited for ${key}; backing off ${backoff / 1000}s`)
        await (deps.sleep ?? defaultSleep)(backoff)
      }
    }
  }
}

/** The stream endpoint is missing (old server): caller falls back to polling. */
export class StreamUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamUnsupportedError'
  }
}

/** Extra dependencies of the long-poll watcher (WatchDeps + stream + sleep). */
export interface StreamWatchDeps extends WatchDeps {
  streamInbox(apiUrl: string, apiKey: string, query: { since?: string; wait?: number }, signal?: AbortSignal): Promise<InboxPage>
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** Abort-aware setTimeout (production default for StreamWatchDeps.sleep). */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Mint a "from this moment on" cursor in msg9's wire format
 * (base64url(RFC3339Nano|id), see backend/internal/pkg/cursor). /inbox/stream
 * REQUIRES a cursor, but msg9 only issues one on `since` requests — a quiet
 * inbox would otherwise never reach stream mode. The server treats any
 * well-formed (time, id) pair as a position and echoes it back, so the next
 * pass enters stream mode with no history dump.
 */
export function mintStreamCursor(at: Date): string {
  return Buffer.from(`${at.toISOString()}|0`, 'utf8').toString('base64url')
}

/**
 * Near-real-time loop for ONE inbox: long-poll /inbox/stream, deliver fresh
 * mail, repeat. Bootstrap (no watch cursor) reuses pollInbox's baseline logic
 * so the first pass announces nothing, exactly like interval mode.
 *
 * Exits when the inbox disappears (migration/rotation replaces it — the
 * supervisor starts a fresh loop), when aborted, or by throwing
 * StreamUnsupportedError when the server has no /inbox/stream (or no longer
 * accepts our cursor shape).
 */
export async function streamInboxLoop(
  deps: StreamWatchDeps,
  rt: WatchRuntime,
  key: string,
  signal: AbortSignal,
): Promise<void> {
  let failures = 0
  while (!signal.aborted) {
    const state = await deps.loadState()
    const raw = state.workspaces[key]
    if (!raw?.api_key || !raw.api_url || !raw.address) return
    const inbox = raw as LiveInbox
    try {
      if (!inbox.watch_cursor) {
        await pollInbox(deps, rt, key, inbox)
        const after = await deps.loadState()
        if (!after.workspaces[key]?.watch_cursor) {
          await deps.setWatchState(key, { watch_cursor: mintStreamCursor(new Date(deps.now())) })
        }
        continue
      }
      const page = await deps.streamInbox(inbox.api_url, inbox.api_key, { since: inbox.watch_cursor, wait: 25 }, signal)
      failures = 0
      if (signal.aborted) return
      // T-23：这一页同时带回了 `unread_count` 与（T-74 之后与 REST 同义的）`total`
      // —— 徽章直接用它，不必再单独轮询每个信箱。客户端断开时的空壳页两个字段
      // 都没有，交给 noteInboxSnapshot 的"缺字段就不写"规则处理（徽章不得被清零）。
      deps.onInboxSnapshot?.(key, { unread: page.unread_count, total: page.total, at: deps.now() })
      if (page.next_cursor) await deps.setWatchState(key, { watch_cursor: page.next_cursor })
      const fresh = page.messages ?? []
      if (fresh.length === 0) continue
      await deps.setWatchState(key, {
        watch_last_message_id: fresh[0]!.message_id,
        ...(fresh[0]!.created_at ? { watch_last_seen_at: fresh[0]!.created_at } : {}),
      })
      deps.onEvent?.('mail')
      await enqueueDelivery(deps, rt, key, inbox, fresh)
    } catch (error) {
      if (signal.aborted) return
      const status = (error as { status?: unknown })?.status
      // 404/501: the endpoint does not exist. 400: the server no longer
      // accepts our cursor shape. Either way, interval polling is the answer.
      if (status === 400 || status === 404 || status === 501) {
        throw new StreamUnsupportedError(`/inbox/stream answered HTTP ${status}`)
      }
      failures += 1
      // v1.17: honor the server's Retry-After when present; otherwise a 429
      // skips the gentle steps, anything else backs off exponentially.
      const serverWait = (error as { retryAfter?: unknown })?.retryAfter
      const backoff = typeof serverWait === 'number' && serverWait > 0
        ? serverWait * 1000
        : status === 429 ? 60_000 : Math.min(30_000, 2_000 * 2 ** Math.min(failures, 4))
      deps.log(`watch stream failed for ${key}: ${(error as Error)?.message ?? String(error)}; retry in ${backoff / 1000}s`)
      await deps.sleep(backoff, signal)
    }
  }
}

async function pollInbox(deps: WatchDeps, rt: WatchRuntime, key: string, inbox: LiveInbox): Promise<void> {
  const since = inbox.watch_cursor
  if (since) {
    const page = await deps.listInbox(inbox.api_url, inbox.api_key, { folder: 'all', limit: 20, since })
    // T-23：`unread_count` 是地址级的（与查询无关，服务端 CountUnread(address)），
    // 任何一页都可以拿来喂徽章；**`total` 在这里不可信**（since 模式 = 游标之后的
    // 命中数），所以刻意不传。
    deps.onInboxSnapshot?.(key, { unread: page.unread_count, at: deps.now() })
    if (page.next_cursor) await deps.setWatchState(key, { watch_cursor: page.next_cursor })
    const fresh = page.messages ?? []
    if (fresh.length > 0) await deps.setWatchState(key, {
      watch_last_message_id: fresh[0]!.message_id,
      ...(fresh[0]!.created_at ? { watch_last_seen_at: fresh[0]!.created_at } : {}),
    })
    if (fresh.length > 0) deps.onEvent?.('mail')
    if (fresh.length > 0) await enqueueDelivery(deps, rt, key, inbox, fresh)
    return
  }

  // No cursor yet: peek the newest page without advancing anything, and use
  // the newest message id as the baseline — announcing nothing the first time,
  // exactly like msg9_inbox's bootstrap.
  const page = await deps.listInbox(inbox.api_url, inbox.api_key, { folder: 'all', limit: 20 })
  // T-23：offset 模式（无 since）的 `total` 就是 folder 全量命中数，和 REST 的
  // `folder=all&limit=1` 同义 —— 连同 unread_count 一起喂徽章。
  deps.onInboxSnapshot?.(key, { unread: page.unread_count, total: page.total, at: deps.now() })
  const all = page.messages ?? []
  if (page.next_cursor) {
    await deps.setWatchState(key, { watch_cursor: page.next_cursor })
    // 时间基线与 id 基线一起记：id 滚出页面后靠它防止重复播报（与下方
    // 无 next_cursor 的分支保持一致）。
    if (all[0]) await deps.setWatchState(key, {
      watch_last_message_id: all[0].message_id,
      ...(all[0].created_at ? { watch_last_seen_at: all[0].created_at } : {}),
    })
    return
  }
  const fresh = unseenMessages(all, inbox.watch_last_message_id, inbox.watch_last_seen_at)
  if (all[0]) await deps.setWatchState(key, {
    watch_last_message_id: all[0].message_id,
    ...(all[0].created_at ? { watch_last_seen_at: all[0].created_at } : {}),
  })
  // Only announce when a baseline already exists: the very first peek must not
  // dump the mailbox history into the session.
  if (inbox.watch_last_message_id && fresh.length > 0) deps.onEvent?.('mail')
  if (inbox.watch_last_message_id && fresh.length > 0) await enqueueDelivery(deps, rt, key, inbox, fresh)
}

/**
 * Coalescing intake: fresh mail lands in the inbox's batch and (re)arms a
 * short window. A flurry of related mails — a correction chasing a mistake —
 * becomes ONE interruption, delivered whole. The mute check happens here so
 * paused mail is tracked (cursor already advanced) but never replayed later.
 */
async function enqueueDelivery(deps: WatchDeps, rt: WatchRuntime, key: string, inbox: LiveInbox, messages: InboxMessage[]): Promise<void> {
  if (await deps.isPaused?.()) {
    deps.log(`watch: notify paused — ${messages.length} mail(s) for ${inbox.address} tracked silently`)
    return
  }
  const windowMs = deps.batchWindowMs ?? 12_000
  if (windowMs <= 0) {
    // deliverBatch 现在会回一个「活会话收下了吗」的布尔（账本路径要拿它决定
    // 是否推进游标）；这里仍然只关心投递本身。T-67：出处 = 进程内 watcher。
    await deliverBatch(deps, rt, key, inbox, messages, { source: 'in-process-watcher' })
    return
  }
  const batch = rt.batches.get(key) ?? { messages: new Map<string, InboxMessage>() }
  for (const message of messages) batch.messages.set(message.message_id, message)
  rt.batches.set(key, batch)
  if (batch.timer) clearTimeout(batch.timer)
  batch.timer = setTimeout(() => void flushBatch(deps, rt, key, inbox), windowMs)
}

/** Deliver the coalesced batch of one inbox (also the batching test's entry). */
export async function flushBatch(deps: WatchDeps, rt: WatchRuntime, key: string, inbox: LiveInbox): Promise<void> {
  const batch = rt.batches.get(key)
  if (!batch) return
  if (batch.timer) clearTimeout(batch.timer)
  rt.batches.delete(key)
  const messages = [...batch.messages.values()].sort((a, b) => {
    const at = Date.parse(a.created_at ?? '') || 0
    const bt = Date.parse(b.created_at ?? '') || 0
    return at - bt
  })
  // T-67：出处 = 进程内 watcher（合批只改时机，不改唤醒来源）。
  await deliverBatch(deps, rt, key, inbox, messages, { source: 'in-process-watcher' })
}

/**
 * v1.20: never trust the payload for the wake decision.
 *
 * `/inbox/stream` is a slim projection — a message the panel (or this agent via
 * tools) already closed can arrive WITHOUT `processed_at`, which is exactly the
 * ghost wake we reproduced live on 2026-09-13 (msg_nX5n6PHyzgCo woke again
 * minutes after msg9_done, while `folder=unprocessed` was already empty).
 *
 * So reconcile against the server's own unprocessed view (the single source of
 * truth) and only fall back to the local `processed_at` filter when that call
 * fails — a broken reconcile must degrade to the old behaviour, never to
 * "wake for everything".
 */
export async function onlyUnprocessed(
  deps: WatchDeps,
  inbox: LiveInbox,
  messages: InboxMessage[],
): Promise<InboxMessage[]> {
  if (messages.length === 0) return messages
  try {
    const page = await deps.listInbox(inbox.api_url, inbox.api_key, { folder: 'unprocessed', limit: 100 })
    const live = new Set((page.messages ?? []).map((message) => message.message_id))
    const kept = messages.filter((message) => live.has(message.message_id))
    if (kept.length < messages.length) {
      deps.log(`watch: skipped ${messages.length - kept.length} mail(s) already closed server-side for ${inbox.address}`)
    }
    return kept
  } catch (error) {
    deps.log(`watch: unprocessed reconcile failed for ${inbox.address} (${(error as Error)?.message ?? String(error)}); falling back to processed_at`)
    return messages.filter((message) => !message.processed_at)
  }
}

/**
 * 这一批该叫醒谁：**粘性目标优先** —— 通知继续送到上次那个会话，只要它还活着，
 * 而不是漂到"最新的那个会话"。
 *
 * 纯本地查，**0 次上游调用**。**不落盘**：什么时候把粘性目标写下去由调用方决定
 * —— `deliverBatch` 要等对账确认"真的要投"才写（与改前同一时机），
 * `deliverDaemonBatch` 没有对账这一步，拿到就写。
 */
async function findWakeTarget(
  deps: Pick<WatchDeps, 'resolveAgent' | 'resolveAgentById'>,
  key: string,
  inbox: LiveInbox,
): Promise<{ agent: WatchAgent; sticky: boolean } | undefined> {
  if (inbox.last_wake_agent_id && deps.resolveAgentById) {
    const sticky = deps.resolveAgentById(inbox.last_wake_agent_id)
    if (sticky) return { agent: sticky, sticky: true }
  }
  const agent = await deps.resolveAgent({ key, inbox })
  return agent ? { agent, sticky: false } : undefined
}

/**
 * T-67：一次投递的**出处**（只用于观测与去重，不改变任何投递语义）。
 */
export interface WakeDeliveryOptions {
  /** 跳过 `folder=unprocessed` 复核（账本路径已经用同一页做过权威对账）。 */
  reconcile?: boolean
  /** 这一批的**唤醒来源**（与接线计划里的同一个枚举）。缺省按进程内 watcher 记。 */
  source?: WakeSource
  /** 逐封的**来路**（`ledger` / `unread-top-up` / `inbox-page`）——只写进观测行。 */
  originOf?(message: InboxMessage): string
}

/**
 * The last mile: reconcile, resolve the session, spend the budgets, deliver.
 *
 * Returns whether a live session ACCEPTED the batch — the ledger ingest needs
 * that answer to decide whether the consumer cursor may advance (no live
 * session ⇒ do not commit ⇒ retry next tick, exactly like the daemon's
 * 409 ⇒ pending semantics).
 *
 * `options.reconcile: false` skips the `folder=unprocessed` re-check: the
 * ledger path already built this batch FROM that very page, so a second call
 * would only repeat the same truth for another unit of quota.
 *
 * T-54（省配额二轮，**批次口径**）：先问"有没有活会话"（纯本地查），再决定要不要
 * 付那一次对账调用。没有活会话 ⇒ 这一批谁都唤不醒（信仍在服务器 inbox 上，等下一次
 * 会话建立后由 `msg9_inbox` / 下一批兜底）⇒ 对账结论**没有任何用处**，那次 API
 * 不该花。对账本身一个字没动：它仍然决定哪些信可以唤醒（v1.20 的幂等语义），
 * 只是不再为"注定不投递的一批"付费。
 *
 * T-67：**所有唤醒路径的唯一出口**，所以"同一封信只准醒一次"也在这里落地
 * （`rt.announced` 去重环 + 一行观测日志）。
 */
export async function deliverBatch(
  deps: WatchDeps,
  rt: WatchRuntime,
  key: string,
  inbox: LiveInbox,
  messages: InboxMessage[],
  options: WakeDeliveryOptions = {},
): Promise<boolean> {
  const source: WakeSource = options.source ?? 'in-process-watcher'
  const originOf = options.originOf ?? (() => 'inbox-page')
  // Sticky target: notices keep going to the session they went to last time
  // while it stays alive, instead of drifting to whatever session is newest.
  // 先做这一步（纯本地查）再看要不要付对账 —— 没有活会话时那一次调用不该花。
  const target = await findWakeTarget(deps, key, inbox)
  if (!target) return false // no live session: the mail waits for the next session start

  const actionable = options.reconcile === false ? messages : await onlyUnprocessed(deps, inbox, messages)
  if (actionable.length === 0) return false

  const agent = target.agent
  // T-67：**唤醒前查一次**。去重键是 message_id，环由所有路径共享，所以"账本消费者
  // 响一次 + 兜底路径再响一次"这种形态在这一行就被拦下（不管是谁先谁后）。
  const repeat = actionable.filter((message) => rt.announced.has(message.message_id))
  const fresh = actionable.filter((message) => !rt.announced.has(message.message_id))
  for (const message of repeat) {
    deps.log(wakeLine({
      source, origin: originOf(message), address: inbox.address, messageId: message.message_id,
      announced: true, agent: agent.id, decision: 'skip', at: deps.now(),
    }))
  }
  if (fresh.length === 0) {
    // 这一批**一封都不该再叫**（全都唤醒过本会话）。返回 true，而不是 false：
    // 有活会话确实收下了，"没有新东西要说"也是一种收下。返回 false 会让账本路径
    // 永不 commit ⇒ 下一轮把同一批再读一遍 ⇒ 空转到天荒地老。
    return true
  }

  // 真的要投了才把粘性目标落下（与改前同一时机：对账没过就不记）。
  if (!target.sticky) await deps.setWatchState(key, { last_wake_agent_id: agent.id })

  const { text, summary } = renderMailNotice(inbox.address, fresh)
  const message = pluginNotice(deps.uuid(), text, summary)
  const agentBudget = rt.agentBudgets.get(agent.id) ?? new WakeBudget()
  rt.agentBudgets.set(agent.id, agentBudget)
  const inboxBudget = rt.inboxBudgets.get(inbox.address) ?? new WakeBudget()
  rt.inboxBudgets.set(inbox.address, inboxBudget)
  // Wake only when BOTH budgets allow: one busy session cannot be pinned, and
  // N sessions of one workspace cannot multiply the allowance.
  const decision = agentBudget.decide(deps.now()) === 'wake' && inboxBudget.decide(deps.now()) === 'wake' ? 'wake' : 'inject'
  // 先记去重环再投递：投递是同步的，但"记"必须发生在**任何**后续观察之前，
  // 否则同一次事件里第二次进来还会看到"没叫过"。
  for (const mail of fresh) noteAnnounced(rt, mail.message_id)
  noteWakeSource(rt, source, deps.log)
  if (decision === 'wake') {
    agent.followup(message)
    deps.log(`watch: woke ${agent.id} with ${fresh.length} new mail(s) for ${inbox.address}`)
  } else {
    agent.inject(message)
    deps.log(`watch: wake budget spent for ${agent.id}/${inbox.address}; injected ${fresh.length} mail(s) as context`)
  }
  // T-67 观测行：一封一行 —— "到底是谁响了第二次"必须能只靠日志回答，
  // 而不是靠推断（这是这张卡的起因）。
  for (const mail of fresh) {
    deps.log(wakeLine({
      source, origin: originOf(mail), address: inbox.address, messageId: mail.message_id,
      announced: false, agent: agent.id, decision, at: deps.now(),
    }))
  }
  return true
}

// ------------------------------------------------------------ ledger ingest

/**
 * T-13 阶段三：`ingest: 'ledger'` 分支的投递循环（**默认关**，见 cutover.ts）。
 *
 * 与 self 路径的差别只有「触发源」：唤醒不再来自自研 daemon 的 WS/REST 推送，
 * 而来自**平台账本** `~/.msg9/spool/<address>.jsonl`（门铃 best-effort，账本是
 * 真相源）。最后一段投递（对账 → 找活会话 → 风暴预算 → followup/inject）
 * 复用同一个 `deliverBatch`，所以两条路径的语义、预算、粘性目标完全一致。
 *
 * 三条纪律：
 *   1. **只有一个唤醒来源**：ledger 模式下自研 daemon 与进程内 watcher 都不启动
 *      （由 index.ts 按 `planIngest` 分支，不靠"跑起来再看"）；
 *   2. **一轮最多一次 REST**：账本行没有正文（契约第 1 条），正文必须去 server
 *      拿；我们用**同一页** `folder=unprocessed` 既当正文来源，又当 v1.20 的权威
 *      对账（已在别处闭环的信不在这一页里 ⇒ 不唤醒）；
 *   3. **取不到那一页 ⇒ 绝不 commit**：游标不推进，下一轮重投。宁可重复一次，
 *      也不静默吞掉唤醒。
 *
 * T-46 ① 的例外（**只在空账本/无账本时**）：基线轮本来一次 REST 都不打。但
 * "账本文件还不存在"的地址恰恰是**第一封信会被静默吞掉**的那一群，所以这一种
 * 基线轮额外打一次 `folder=unprocessed` —— **只为了可观测**（把"服务器上还有
 * N 封未处理、本轮一封都不唤醒"写进日志），**绝不投递**（bootstrap 不变量：
 * 第一次观测不许把历史邮件倒进会话）。有历史的账本行为一字未改（仍然是零 REST）。
 */
export interface LedgerIngestOptions {
  /** 我们自己的 consumer 名（默认 `ledger.ts` 的 `DEFAULT_CONSUMER`）。 */
  consumer?: string
  /** spool 目录覆盖（测试传临时目录；生产用默认 `~/.msg9/spool`）。 */
  spoolDir?: string
  /** 滞后补齐阈值（默认 5 分钟，与阶段一骨架同源）。 */
  lagThresholdMs?: number
  /** 单轮唤醒上限（默认 `DEFAULT_MAX_PER_ROUND` = 20，见那里对依据的说明）。 */
  maxPerRound?: number
  /** 平台 daemon 健康（只读观测）；缺省 unknown ⇒ 只按滞后判。 */
  daemonHealth?(): Promise<DaemonHealth>
  /** 每轮 unprocessed 页的条数上限（默认 100）。 */
  unprocessedLimit?: number
}

export interface LedgerIngest {
  /** 跑一轮：读账本 + 游标 → 取正文对账 → 投递 → 确认后才 commit。 */
  tick(): Promise<void>
  /** 最近一轮的只读观测（诊断/测试用）。 */
  readonly last: {
    lagSeconds?: number
    freshEvents: number
    toppedUp: number
    reconciledAway: number
    /** 上一轮因为单轮唤醒上限被推到下一轮的事件数（T-46 ③）。 */
    deferred: number
  }
}

export function createLedgerIngest(
  deps: WatchDeps,
  rt: WatchRuntime,
  key: string,
  inbox: LiveInbox,
  options: LedgerIngestOptions = {},
): LedgerIngest {
  const log = deps.log
  const limit = options.unprocessedLimit ?? 100
  // 阶段一骨架的默认阈值（5 分钟）—— 在这里显式展开，免得"默认值藏在两处"。
  const lagThresholdMs = options.lagThresholdMs ?? DEFAULT_LAG_TOPUP_MS
  const last: LedgerIngest['last'] = { freshEvents: 0, toppedUp: 0, reconciledAway: 0, deferred: 0 }
  let pagePromise: Promise<InboxMessage[] | undefined> | undefined

  /** 本轮那一页 `folder=unprocessed` —— **一轮只付一次 API 调用**。 */
  const unprocessedOnce = (): Promise<InboxMessage[] | undefined> => {
    pagePromise ??= (async () => {
      try {
        const page = await deps.listInbox(inbox.api_url, inbox.api_key, { folder: 'unprocessed', limit })
        // `unread_count` 是**地址级**的（与查询无关）⇒ 顺手喂徽章，省掉一次 REST。
        // 这里 `total` 是 folder=unprocessed 的命中数，不是信箱大小 ⇒ 刻意不传。
        deps.onInboxSnapshot?.(key, { unread: page.unread_count, at: deps.now() })
        return page.messages ?? []
      } catch (error) {
        log(`msg9 ledger: unprocessed fetch failed for ${inbox.address} (${(error as Error)?.message ?? String(error)})`)
        return undefined
      }
    })()
    return pagePromise
  }

  const consumer = createLedgerConsumer({
    address: inbox.address,
    ...(options.consumer === undefined ? {} : { consumer: options.consumer }),
    ...(options.spoolDir === undefined ? {} : { spoolDir: options.spoolDir }),
    lagThresholdMs,
    ...(options.maxPerRound === undefined ? {} : { maxPerRound: options.maxPerRound }),
    // 补齐来源与投递来源是**同一页**（见上面第 2 条）。
    fetchUnread: async () => {
      const page = await unprocessedOnce()
      if (!page) throw new Error('unprocessed page unavailable')
      return page
    },
    ...(options.daemonHealth === undefined ? {} : { daemonHealth: options.daemonHealth }),
    // 时钟与 watcher 同源：滞后判据必须可注入（测试要确定，生产是 Date.now）。
    now: () => deps.now(),
    log,
  })

  return {
    last,
    async tick() {
      pagePromise = undefined
      const poll = await consumer.pollOnce()
      if (poll.baseline) {
        // 与 self 路径同一条规矩：第一次观测只立基线，绝不把历史邮件倒进会话。
        await poll.commit()
        if (poll.ledger_events === 0) {
          // T-46 ①：**空账本/无账本**的基线轮额外对账一次 —— 只为把"不再静默"
          // 落到实处：这一轮到底有多少封服务器上未处理的信被跳过。
          // ⚠️ 只观测，不投递（bootstrap 不变量）。`unprocessedOnce` 会缓存这一页，
          // 所以即便后面还有别的分支用到它，也仍然只有一次 REST。
          const page = await unprocessedOnce()
          const pending = page === undefined ? undefined : page.length
          log(
            `msg9 ledger: baseline established for ${inbox.address} → ${poll.ledger_path} ` +
              `(ledger ${poll.ledger_exists ? 'file is empty' : 'file does not exist yet'}; sentinel cursor written —— ` +
              `${pending === undefined ? 'server unprocessed count unavailable' : `${pending} unprocessed mail(s) on the server`} ` +
              `are NOT announced this round; the next arrival will wake. ` +
              `账本为空/无账本 ⇒ 已立哨兵基线，本轮${pending === undefined ? '（未处理数取不到）' : ` ${pending} 封`}不唤醒。)`,
          )
          return
        }
        log(`msg9 ledger: baseline established for ${inbox.address} → ${poll.ledger_path} (ledger already has ${poll.ledger_events} event(s); none of them is announced)`)
        return
      }
      last.lagSeconds = poll.lag?.lag_seconds
      last.deferred = poll.deferred
      const needed = poll.fresh.length > 0 || poll.top_up.topUp
      const page = needed ? await unprocessedOnce() : []
      const plan = planLedgerBatch(poll, page)
      last.freshEvents = plan.fresh_events
      last.toppedUp = plan.topped_up.length
      last.reconciledAway = plan.reconciled_away.length

      if (plan.retry) {
        // 取不到 unprocessed 页：游标不动，下一轮重投（信在服务器，不丢）。
        log(`msg9 ledger: ${plan.fresh_events} ledger event(s) for ${inbox.address} stay unconfirmed (retry next tick)`)
        return
      }
      if (plan.deliver.length === 0) {
        if (plan.fresh_events > 0 || poll.top_up.topUp) {
          // 账本说有，但服务器说"已经没有未处理的了" ⇒ 已在别处闭环：跨过去，不唤醒。
          if (plan.reconciled_away.length > 0) {
            log(`msg9 ledger: skipped ${plan.reconciled_away.length} mail(s) already closed server-side for ${inbox.address}`)
          }
          await poll.commit()
        }
        return
      }
      if (await deps.isPaused?.()) {
        // 与 self 路径同义：暂停期间照样跟踪（推进游标），但绝不投递、也不回放。
        log(`msg9 ledger: notify paused — ${plan.deliver.length} mail(s) for ${inbox.address} tracked silently`)
        await poll.commit()
        return
      }
      // reconcile:false —— 这一批就来自 folder=unprocessed 那一页（权威对账已完成）。
      // T-67：出处逐封标清 —— `ledger`（账本里有这一行）还是 `unread-top-up`
      // （账本没跟上、由 unread 补齐捞回来的）。两者**同属** `ledger-consumer`
      // 这一次消费轮，不是两条唤醒路径（`planLedgerBatch` 已按 message_id 合并去重）。
      const toppedUp = new Set(plan.topped_up)
      const delivered = await deliverBatch(deps, rt, key, inbox, plan.deliver, {
        reconcile: false,
        source: 'ledger-consumer',
        originOf: (message) => (toppedUp.has(message.message_id) ? 'unread-top-up' : 'ledger'),
      })
      if (!delivered) {
        // 没有活会话：**不 commit** ⇒ 下一轮重投（与自研 daemon 的 409 ⇒ pending 同义）。
        log(`msg9 ledger: no live session for ${inbox.address}; ${plan.deliver.length} mail(s) wait for the next tick`)
        return
      }
      await poll.commit()
    },
  }
}

export interface LedgerIngestLoop {
  readonly ingest: LedgerIngest
  stop(): void
}

/**
 * 把一个地址的账本消费者挂在定时器上（与 self 路径的轮询同节奏，间隔由调用方给）。
 * 第一轮**立刻**跑（建立基线），不等一个间隔；防重入与 self 路径同一个守卫。
 */
export function startLedgerIngestLoop(
  deps: WatchDeps,
  rt: WatchRuntime,
  key: string,
  inbox: LiveInbox,
  options: LedgerIngestOptions & { intervalMs: number },
): LedgerIngestLoop {
  const ingest = createLedgerIngest(deps, rt, key, inbox, options)
  const tick = createNonReentrant(() => ingest.tick())
  const timer = setInterval(tick, Math.max(1_000, options.intervalMs))
  void tick()
  return {
    ingest,
    stop() {
      clearInterval(timer)
    },
  }
}

// ------------------------------------------------------------- daemon delivery

/** A batch the watcher daemon pushes to POST /dsh-msg9/deliver (the wire shape
 *  of the daemon's DeliverBody — mirrored here because daemon/engine.ts already
 *  imports THIS module, so the type cannot flow the other way). */
export interface DaemonDelivery {
  inbox: string
  project_key: string
  messages: InboxMessage[]
  mode: 'followup' | 'inject'
  /** The daemon's storm budget was spent: this batch is context-only. */
  downgraded?: boolean
}

/** The last-mile dependencies of a daemon delivery (a subset of WatchDeps). */
export interface DaemonDeliverDeps {
  /** The workspace's live agent, if any (same semantics as WatchDeps.resolveAgent). */
  resolveAgent(workspace: { key: string; inbox: LiveInbox }): WatchAgent | undefined | Promise<WatchAgent | undefined>
  /** Sticky-target lookup: is this session still alive? */
  resolveAgentById?(id: string): WatchAgent | undefined
  /** Persist the sticky delivery target (watch.ts's own setWatchState). */
  setWatchState(key: string, patch: { last_wake_agent_id?: string }): Promise<void>
  uuid(): string
  log(message: string): void
}

/**
 * The LAST MILE of a daemon-coalesced batch: resolve the workspace's live
 * session and push the notice. The daemon already did the cursor work, the
 * unprocessed reconcile, the coalescing window and the storm budget — the
 * plugin must NOT re-budget here (a second budget would double-count wakes
 * the daemon already paid for). `mode` is honored verbatim: 'followup' wakes,
 * 'inject' is context-only; a `downgraded` batch carries a visible trace in
 * the notice so a silent budget overrun is never invisible to the agent.
 *
 * Returns false when no live session exists: the daemon turns that (HTTP 409)
 * into a pending-queue entry and redelivers on the next register/heartbeat.
 */
export async function deliverDaemonBatch(
  deps: DaemonDeliverDeps,
  key: string,
  inbox: LiveInbox,
  body: DaemonDelivery,
  /** T-67：可选 ——给了就参与「同一封信只准醒一次」的去重与观测。 */
  rt?: WatchRuntime,
): Promise<boolean> {
  const all = body.messages.filter((message) => message && typeof message.message_id === 'string')
  if (all.length === 0) return true

  // Sticky target, same rule (and the same helper) as deliverBatch: notices keep
  // going to the session they went to last time while it stays alive. 这条路径
  // 没有"投递前的对账"那一步 ⇒ 拿到目标就把粘性记下来（与改前一致）。
  const target = await findWakeTarget(deps, key, inbox)
  if (!target) return false

  const address = body.inbox || inbox.address
  // T-67：与 deliverBatch 同一条去重环（"跨路径共享"就是靠共用 `rt` 实现的）。
  const duplicate = rt ? all.filter((message) => rt.announced.has(message.message_id)) : []
  const messages = rt ? all.filter((message) => !rt.announced.has(message.message_id)) : all
  for (const mail of duplicate) {
    deps.log(wakeLine({
      source: 'self-daemon', origin: 'daemon', address, messageId: mail.message_id,
      announced: true, agent: target.agent.id, decision: 'skip', at: Date.now(),
    }))
  }
  if (messages.length === 0) {
    // 整批都唤醒过本会话：有活会话收下了（返回 true，daemon 不会重投）。
    return true
  }

  if (!target.sticky) await deps.setWatchState(key, { last_wake_agent_id: target.agent.id })
  const agent = target.agent

  const rendered = renderMailNotice(address, messages)
  const text = body.downgraded
    ? `${rendered.text}\n（本批为降级投递：唤醒预算已用尽，仅注入上下文，不会主动唤醒会话。 / downgraded delivery: the wake budget was spent, so this batch is context-only.）`
    : rendered.text
  const message = pluginNotice(deps.uuid(), text, rendered.summary)
  if (rt) {
    for (const mail of messages) noteAnnounced(rt, mail.message_id)
    noteWakeSource(rt, 'self-daemon', deps.log)
  }
  const decision = body.mode === 'followup' ? 'wake' : 'inject'
  if (body.mode === 'followup') {
    agent.followup(message)
    deps.log(`watch: daemon delivered ${messages.length} mail(s) for ${address} to ${agent.id} (followup)`)
  } else {
    agent.inject(message)
    deps.log(`watch: daemon delivered ${messages.length} mail(s) for ${address} to ${agent.id} (inject${body.downgraded ? ', downgraded' : ''})`)
  }
  for (const mail of messages) {
    deps.log(wakeLine({
      source: 'self-daemon', origin: 'daemon', address, messageId: mail.message_id,
      announced: false, agent: agent.id, decision, at: Date.now(),
    }))
  }
  return true
}
