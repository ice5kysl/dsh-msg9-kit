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
  source: { kind: 'plugin'; plugin: string; form: 'notice'; summary: string }
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
    source: { kind: 'plugin', plugin: 'msg9-kit', form: 'notice', summary: truncate(summary, 120) },
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
}

export function createWatchRuntime(): WatchRuntime {
  return { agentBudgets: new Map(), inboxBudgets: new Map(), batches: new Map() }
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
  if (windowMs <= 0) return deliverBatch(deps, rt, key, inbox, messages)
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
  await deliverBatch(deps, rt, key, inbox, messages)
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

async function deliverBatch(deps: WatchDeps, rt: WatchRuntime, key: string, inbox: LiveInbox, messages: InboxMessage[]): Promise<void> {
  // v1.13 alignment + v1.20 hardening: a message already closed ANYWHERE
  // (panel, this agent via tools, another client) must not wake anyone again.
  // The cursor tracks "notified", not "handled", so the server decides here.
  const actionable = await onlyUnprocessed(deps, inbox, messages)
  if (actionable.length === 0) return

  // Sticky target: notices keep going to the session they went to last time
  // while it stays alive, instead of drifting to whatever session is newest.
  let agent: WatchAgent | undefined
  if (inbox.last_wake_agent_id && deps.resolveAgentById) {
    agent = deps.resolveAgentById(inbox.last_wake_agent_id)
  }
  if (!agent) {
    agent = await deps.resolveAgent({ key, inbox })
    if (agent) await deps.setWatchState(key, { last_wake_agent_id: agent.id })
  }
  if (!agent) return // no live session: the mail waits for the next session start

  const { text, summary } = renderMailNotice(inbox.address, actionable)
  const message = pluginNotice(deps.uuid(), text, summary)
  const agentBudget = rt.agentBudgets.get(agent.id) ?? new WakeBudget()
  rt.agentBudgets.set(agent.id, agentBudget)
  const inboxBudget = rt.inboxBudgets.get(inbox.address) ?? new WakeBudget()
  rt.inboxBudgets.set(inbox.address, inboxBudget)
  // Wake only when BOTH budgets allow: one busy session cannot be pinned, and
  // N sessions of one workspace cannot multiply the allowance.
  const decision = agentBudget.decide(deps.now()) === 'wake' && inboxBudget.decide(deps.now()) === 'wake' ? 'wake' : 'inject'
  if (decision === 'wake') {
    agent.followup(message)
    deps.log(`watch: woke ${agent.id} with ${actionable.length} new mail(s) for ${inbox.address}`)
  } else {
    agent.inject(message)
    deps.log(`watch: wake budget spent for ${agent.id}/${inbox.address}; injected ${actionable.length} mail(s) as context`)
  }
}
