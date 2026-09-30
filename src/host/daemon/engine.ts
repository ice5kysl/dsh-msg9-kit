/**
 * The daemon's watch engine: one WebSocket per inbox plus the reliability
 * machinery the in-process watcher lacked.
 *
 * Per inbox (keyed by project_key):
 *   - connect: POST /api/v1/ws-ticket → WS /api/v1/ws (subprotocol
 *     `msg9-l0, <ticket>`); `new_message` events are acked and trigger a
 *     cursor-based fetch (the WS payload is only a hint — data always comes
 *     from listInbox, so a lost frame can never lose mail);
 *   - catch-up: WS never replays, so every (re)connect and a 120s safety-net
 *     timer re-fetch `since` the last cursor. Cursors are ALWAYS server-issued
 *     `next_cursor` values — never minted from the local clock;
 *   - coalesce: 12s aggregation window with a 60s max-wait ceiling (the
 *     starvation fix), persisted BEFORE flush so a crash cannot drop a batch;
 *   - deliver: POST /dsh-msg9/deliver on the owning dsh instance. The cursor
 *     advances ONLY after the instance acks; a 409 (no live session) moves the
 *     batch to the pending queue and it is redelivered when the instance
 *     next registers/heartbeats — the cursor never steps over it;
 *   - storm budget: 3 wakes / 30min per inbox; a degraded delivery carries
 *     `downgraded: true` so the plugin can leave a visible trace.
 *
 * @module dsh-msg9-kit/daemon/engine
 */

import { listInbox, type InboxMessage, type InboxPage } from '../api.ts'
import { WakeBudget, defaultSleep } from '../watch.ts'
import { connectWebSocket, type WsConnection } from './wsclient.ts'
import type { DaemonIdentity } from './identity.ts'
import {
  backoffMs,
  computeFlushAt,
  knownMessageIds,
  mergeDeliveredIds,
  type DaemonState,
  type DaemonStore,
  type PendingItem,
} from './state.ts'

// ------------------------------------------------------------------- registry

export interface WorkspaceRow {
  project_key: string
  key: string
  title: string
  path: string
}

/** One registered dsh instance (a plugin that accepts deliveries). */
export interface InstanceRegistration {
  instance_id: string
  pid: number
  dsh_home: string
  /** The plugin's web server port; 0 = not known yet (headless or startup). */
  port: number
  deliver_token: string
  protocol: number
  workspaces: WorkspaceRow[]
  registered_at: string
  last_seen: number
}

export interface Registry {
  upsert(reg: Omit<InstanceRegistration, 'registered_at' | 'last_seen'>, now: number): InstanceRegistration
  touch(instanceId: string, patch: { port?: number; workspaces?: WorkspaceRow[] }, now: number): boolean
  remove(instanceId: string): void
  get(instanceId: string): InstanceRegistration | undefined
  /** The instance that claims a project_key (last registration wins). */
  forProjectKey(projectKey: string): InstanceRegistration | undefined
  list(): InstanceRegistration[]
}

export function createRegistry(): Registry {
  const instances = new Map<string, InstanceRegistration>()
  return {
    upsert(reg, now) {
      const existing = instances.get(reg.instance_id)
      const record: InstanceRegistration = {
        ...reg,
        registered_at: existing?.registered_at ?? new Date(now).toISOString(),
        last_seen: now,
      }
      instances.set(reg.instance_id, record)
      return record
    },
    touch(instanceId, patch, now) {
      const existing = instances.get(instanceId)
      if (!existing) return false
      if (patch.port !== undefined && patch.port > 0) existing.port = patch.port
      if (patch.workspaces) existing.workspaces = patch.workspaces
      existing.last_seen = now
      return true
    },
    remove(instanceId) {
      instances.delete(instanceId)
    },
    get: (instanceId) => instances.get(instanceId),
    forProjectKey(projectKey) {
      let winner: InstanceRegistration | undefined
      for (const instance of instances.values()) {
        if (instance.workspaces.some((row) => row.project_key === projectKey)) {
          if (!winner || instance.last_seen >= winner.last_seen) winner = instance
        }
      }
      return winner
    },
    list: () => [...instances.values()],
  }
}

// -------------------------------------------------------------------- config

export interface EngineConfig {
  /** Identity re-enumeration cadence (adopts provisioned/rotated inboxes). */
  reconcileMs: number
  /** Per-inbox full cursor re-fetch, the WS silent-loss safety net. */
  safetyNetMs: number
  /** Coalescing window (re-armed per arrival, capped by batchMaxWaitMs). */
  batchWindowMs: number
  /** Hard flush ceiling: no mail waits longer than this. */
  batchMaxWaitMs: number
  deliverRetryBaseMs: number
  deliverRetryMaxMs: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  /** Silence longer than this means the WS is dead (server pings every 30s). */
  wsWatchdogMs: number
  /** Storm budget: followup wakes per window per inbox. */
  wakeMaxWakes: number
  wakeWindowMs: number
  /** Pending redelivery sweep cadence. */
  pendingSweepMs: number
  /** Bound per-inbox pending items (overflow is safe: cursor never advanced). */
  pendingCap: number
  fetchPageLimit: number
  fetchMaxPages: number
  unprocessedMaxPages: number
}

export function defaultEngineConfig(): EngineConfig {
  return {
    reconcileMs: 60_000,
    safetyNetMs: 120_000,
    batchWindowMs: 12_000,
    batchMaxWaitMs: 60_000,
    deliverRetryBaseMs: 2_000,
    deliverRetryMaxMs: 60_000,
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 30_000,
    wsWatchdogMs: 120_000,
    wakeMaxWakes: 3,
    wakeWindowMs: 30 * 60_000,
    pendingSweepMs: 60_000,
    pendingCap: 50,
    fetchPageLimit: 20,
    fetchMaxPages: 10,
    unprocessedMaxPages: 50,
  }
}

// ---------------------------------------------------------------------- deps

/** The delivery payload sent to a plugin's POST /dsh-msg9/deliver. */
export interface DeliverBody {
  inbox: string
  project_key: string
  messages: InboxMessage[]
  mode: 'followup' | 'inject'
  downgraded?: boolean
}

/** A transient delivery failure, or a semantic 409 (no live session). */
export class DeliverHttpError extends Error {
  constructor(message: string, readonly status: number | undefined, readonly noSession: boolean) {
    super(message)
    this.name = 'DeliverHttpError'
  }
}

export interface EngineDeps {
  store: DaemonStore
  registry: Registry
  config: EngineConfig
  log(message: string): void
  uuid(): string
  now(): number
  listInbox(apiUrl: string, apiKey: string, query: { folder?: string; limit?: number; offset?: number; since?: string }): Promise<InboxPage>
  issueWsTicket(apiUrl: string, apiKey: string, signal?: AbortSignal): Promise<{ ticket: string }>
  wsConnect(url: string, options: { protocols: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<WsConnection>
  deliverPost(target: { port: number; deliver_token: string }, body: DeliverBody, timeoutMs: number): Promise<void>
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  enumerate(): Promise<DaemonIdentity[]>
}

export interface InboxStatus {
  project_key: string
  address: string
  ws_connected: boolean
  has_cursor: boolean
  batch_size: number
  pending: number
}

export interface Engine {
  start(): Promise<void>
  stop(): Promise<void>
  /** Redeliver pending items (fire-and-forget; called on register/heartbeat). */
  replayPending(projectKey?: string): void
  status(): InboxStatus[]
}

/** msg9's WS endpoint for an API base URL (http→ws, https→wss). */
export function wsUrlFor(apiUrl: string): string {
  const url = new URL(`${apiUrl.replace(/\/+$/, '')}/api/v1/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

// -------------------------------------------------------------------- runner

class InboxRunner {
  /** Last FETCHED cursor (uncommitted); restored from state on boot. */
  private fetchCursor: string | undefined
  private ws: WsConnection | undefined
  private wsWaiter: (() => void) | undefined
  private watchdog: ReturnType<typeof setInterval> | undefined
  private safety: ReturnType<typeof setInterval> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private fetching = false
  private fetchAgain = false
  private flushing = false
  private stopped = false
  private readonly abort = new AbortController()
  private budget: WakeBudget

  constructor(
    private readonly projectKey: string,
    private readonly engine: EngineContext,
  ) {
    const { config } = engine.deps
    this.budget = new WakeBudget(config.wakeMaxWakes, config.wakeWindowMs)
  }

  get connected(): boolean {
    return this.ws !== undefined
  }

  start(): void {
    const state = this.engine.deps.store.get().inboxes[this.projectKey]
    this.fetchCursor = state?.fetch_cursor ?? state?.watch_cursor
    if (state?.batch) this.scheduleFlush() // crash recovery: deliver the persisted batch
    void this.loop()
    this.safety = setInterval(() => void this.fetchNew('safety-net'), this.engine.deps.config.safetyNetMs)
  }

  stop(): void {
    this.stopped = true
    this.abort.abort()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.safety) clearInterval(this.safety)
    if (this.watchdog) clearInterval(this.watchdog)
    this.ws?.destroy()
    this.releaseWs()
  }

  private log(message: string): void {
    this.engine.deps.log(message)
  }

  // ------------------------------------------------------------- ws loop

  private async loop(): Promise<void> {
    const { deps } = this.engine
    let failures = 0
    while (!this.abort.signal.aborted && !this.stopped) {
      const identity = this.engine.identities.get(this.projectKey)
      if (!identity) return
      try {
        const { ticket } = await deps.issueWsTicket(identity.api_url, identity.api_key, this.abort.signal)
        const ws = await deps.wsConnect(wsUrlFor(identity.api_url), {
          protocols: ['msg9-l0', ticket],
          timeoutMs: 10_000,
          signal: this.abort.signal,
        })
        if (this.abort.signal.aborted || this.stopped) {
          ws.destroy()
          return
        }
        // Arm the close-waiter BEFORE anything that can await. A close landing
        // during the catch-up window used to be a no-op (`wsWaiter` was still
        // undefined when `releaseWs()` ran), and this loop then awaited a
        // promise nobody would ever resolve: a PERMANENT, silent hang while
        // `/healthz` kept answering 200 (msg9 PO field report 2026-09-30 — 90
        // minutes of a dead doorbell, caught only by an external sweep).
        const closed = new Promise<void>((resolve) => {
          this.wsWaiter = resolve
        })
        this.attachWs(ws)
        failures = 0
        // WS is at-least-once and NEVER replays: catch up from the cursor.
        await this.fetchNew('catch-up')
        if (this.abort.signal.aborted || this.stopped) return
        // Released while catching up (close, error, or the watchdog firing):
        // the waiter is already resolved — go reconnect instead of parking.
        if (this.ws !== ws) continue
        await closed
      } catch (error) {
        if (this.abort.signal.aborted || this.stopped) return
        failures += 1
        const wait = backoffMs(failures, deps.config.reconnectBaseMs, deps.config.reconnectMaxMs)
        this.log(`msg9 daemon: ws for ${identity.address} failed: ${(error as Error)?.message ?? String(error)}; retry in ${Math.round(wait / 1000)}s`)
        await deps.sleep(wait, this.abort.signal)
      } finally {
        this.releaseWs()
      }
    }
  }

  private attachWs(ws: WsConnection): void {
    this.ws = ws
    ws.ontext = (data) => {
      let event: { type?: string; message?: { message_id?: string } }
      try {
        event = JSON.parse(data) as typeof event
      } catch {
        return
      }
      if (event?.type === 'ping') {
        ws.sendText('{"type":"pong"}')
        return
      }
      if (event?.type === 'new_message') {
        const messageId = event.message?.message_id
        if (typeof messageId === 'string' && messageId !== '') {
          ws.sendText(JSON.stringify({ type: 'ack', message_id: messageId }))
        }
        void this.fetchNew('ws-push')
      }
    }
    ws.onerror = (error) => {
      this.log(`msg9 daemon: ws error for ${this.projectKey}: ${error.message}`)
      ws.destroy()
    }
    ws.onclose = (code, reason) => {
      // Always say so: an unlogged close is why the hang above stayed invisible
      // for 90 minutes (the only log line was onerror).
      this.log(`msg9 daemon: ws closed for ${this.projectKey} (${code}${reason ? ` ${reason}` : ''}) — reconnecting`)
      this.releaseWs()
    }
    // The socket can die between wsConnect() and this very line; in that case
    // the close event has already fired with no handler attached, so reconcile
    // it here (idempotent: releaseWs on a released connection is a no-op).
    if (ws.isClosed) {
      this.log(`msg9 daemon: ws for ${this.projectKey} was already closed before attach — retrying`)
      this.releaseWs()
    }
    if (this.watchdog) clearInterval(this.watchdog)
    // 检查节奏**从阈值推导**，不再硬编码 15 秒。
    // 原来写死 15_000 时，"阈值"和"多久检查一次"是两个互不相关的旋钮：
    // 默认 120s 阈值 + 15s 节奏看着没问题，但**整条看门狗因此无法被测**
    // （测试只能把阈值设成 600s 等于关掉）—— 一道从未被验证过的安全机制，
    // 和不存在没有区别。默认值下节奏仍是 15s，行为不变。
    const watchdogMs = this.engine.deps.config.wsWatchdogMs
    const cadence = Math.max(50, Math.min(15_000, Math.floor(watchdogMs / 4)))
    this.watchdog = setInterval(() => {
      if (Date.now() - ws.lastFrameAt > watchdogMs) {
        this.log(`msg9 daemon: ws for ${this.projectKey} silent past the watchdog window; reconnecting`)
        ws.destroy()
      }
    }, cadence)
  }

  private releaseWs(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
    this.ws = undefined
    const waiter = this.wsWaiter
    this.wsWaiter = undefined
    waiter?.()
  }

  // ------------------------------------------------------------- fetching

  private identityAddress(): string {
    return this.engine.identities.get(this.projectKey)?.address ?? this.projectKey
  }

  /** Non-reentrant fetch; concurrent triggers collapse into one extra pass. */
  private async fetchNew(trigger: string): Promise<void> {
    if (this.stopped) return
    if (this.fetching) {
      this.fetchAgain = true
      return
    }
    this.fetching = true
    try {
      do {
        this.fetchAgain = false
        await this.fetchPass(trigger)
      } while (this.fetchAgain && !this.stopped)
    } catch (error) {
      this.log(`msg9 daemon: fetch failed for ${this.identityAddress()}: ${(error as Error)?.message ?? String(error)}`)
    } finally {
      this.fetching = false
    }
  }

  private async fetchPass(_trigger: string): Promise<void> {
    const { deps } = this.engine
    const identity = this.engine.identities.get(this.projectKey)
    if (!identity) return
    const inboxState = deps.store.get().inboxes[this.projectKey]
    const since = this.fetchCursor ?? inboxState?.fetch_cursor ?? inboxState?.watch_cursor
    if (!since) return this.bootstrap(identity, inboxState)

    let cursor = since
    const fresh: InboxMessage[] = []
    let lastCursor: string | undefined
    for (let page = 0; page < deps.config.fetchMaxPages; page += 1) {
      const result = await deps.listInbox(identity.api_url, identity.api_key, {
        folder: 'all',
        limit: deps.config.fetchPageLimit,
        since: cursor,
      })
      if (result.next_cursor) {
        lastCursor = result.next_cursor
        cursor = result.next_cursor
      }
      fresh.push(...(result.messages ?? []))
      if (!result.has_more) break
    }
    if (!lastCursor || lastCursor === since) {
      if (lastCursor) this.fetchCursor = lastCursor
      return
    }
    this.fetchCursor = lastCursor
    const seq = await this.noteFetchCursor(lastCursor, fresh)
    if (fresh.length === 0) return

    if (deps.store.get().notify_paused) {
      await this.commitCursor(seq, fresh.map((message) => message.message_id))
      this.log(`msg9 daemon: notify paused — ${fresh.length} mail(s) for ${identity.address} tracked silently`)
      return
    }
    await this.enqueue(fresh, lastCursor, seq)
  }

  /** Record the fetched (uncommitted) cursor + bump its monotonic sequence. */
  private async noteFetchCursor(cursor: string, fresh: InboxMessage[]): Promise<number> {
    const { deps } = this.engine
    let seq = 0
    await deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state)
      seq = (inbox.cursor_seq ?? 0) + 1
      inbox.cursor_seq = seq
      inbox.fetch_cursor = cursor
      const newest = fresh[fresh.length - 1]
      if (newest) {
        inbox.watch_last_message_id = newest.message_id
        if (newest.created_at) inbox.watch_last_seen_at = newest.created_at
      }
    })
    return seq
  }

  /** First observation: establish the baseline without announcing history. */
  private async bootstrap(identity: DaemonIdentity, inboxState: ReturnType<DaemonStore['get']>['inboxes'][string] | undefined): Promise<void> {
    const { deps } = this.engine
    const page = await deps.listInbox(identity.api_url, identity.api_key, { folder: 'all', limit: deps.config.fetchPageLimit })
    const messages = page.messages ?? []
    if (!page.next_cursor) {
      // Empty mailbox: the server issues no cursor until mail exists. Mark the
      // empty observation instead of minting a local position.
      if (!inboxState?.bootstrap_pending) {
        await deps.store.mutate((state) => {
          this.ensureInbox(state).bootstrap_pending = true
        })
      }
      return
    }
    this.fetchCursor = page.next_cursor

    if (inboxState?.bootstrap_pending) {
      // The mailbox was EMPTY at first observation: everything here arrived
      // afterwards and is genuinely new. Pull older pages too when the first
      // page is truncated (the plain list is newest-first).
      let all = messages
      const total = page.total ?? messages.length
      for (let extra = 0; all.length < total && extra < deps.config.fetchMaxPages; extra += 1) {
        const more = await deps.listInbox(identity.api_url, identity.api_key, {
          folder: 'all',
          limit: deps.config.fetchPageLimit,
          offset: all.length,
        })
        const rows = more.messages ?? []
        if (rows.length === 0) break
        all = all.concat(rows)
      }
      let seq = 0
      await deps.store.mutate((state) => {
        const inbox = this.ensureInbox(state)
        delete inbox.bootstrap_pending
        seq = (inbox.cursor_seq ?? 0) + 1
        inbox.cursor_seq = seq
        inbox.fetch_cursor = page.next_cursor
        if (messages[0]) {
          inbox.watch_last_message_id = messages[0].message_id
          if (messages[0].created_at) inbox.watch_last_seen_at = messages[0].created_at
        }
      })
      if (deps.store.get().notify_paused) {
        await this.commitCursor(seq, all.map((message) => message.message_id))
        this.log(`msg9 daemon: notify paused — ${all.length} mail(s) for ${identity.address} tracked silently`)
        return
      }
      await this.enqueue(all, page.next_cursor, seq)
      return
    }

    // First observation of a non-empty mailbox: baseline only, announce nothing.
    await deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state)
      delete inbox.bootstrap_pending
      inbox.watch_cursor = page.next_cursor
      inbox.fetch_cursor = page.next_cursor
      inbox.cursor_seq = (inbox.cursor_seq ?? 0) + 1
      inbox.acked_seq = inbox.cursor_seq
      if (messages[0]) {
        inbox.watch_last_message_id = messages[0].message_id
        if (messages[0].created_at) inbox.watch_last_seen_at = messages[0].created_at
      }
    })
  }

  private ensureInbox(state: DaemonState) {
    const identity = this.engine.identities.get(this.projectKey)
    const inbox = (state.inboxes[this.projectKey] ??= {
      address: identity?.address ?? '',
      api_url: identity?.api_url ?? '',
    })
    if (identity) {
      inbox.address = identity.address
      inbox.api_url = identity.api_url
    }
    return inbox
  }

  // -------------------------------------------------------- batch + flush

  private async enqueue(messages: InboxMessage[], nextCursor: string, seq: number): Promise<void> {
    const { deps } = this.engine
    let added = 0
    await deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state)
      const known = knownMessageIds(state, this.projectKey)
      const fresh = messages.filter((message) => message.message_id && !known.has(message.message_id))
      if (fresh.length === 0) return
      const nowMs = deps.now()
      const batch = (inbox.batch ??= {
        messages: [],
        first_queued_at: new Date(nowMs).toISOString(),
        deliver_after: nowMs + deps.config.batchWindowMs,
        max_wait_until: nowMs + deps.config.batchMaxWaitMs,
      })
      batch.messages.push(...fresh)
      batch.next_cursor = nextCursor
      batch.cursor_seq = seq
      // The window re-arms per arrival, but never past the max-wait ceiling.
      batch.deliver_after = computeFlushAt(batch, nowMs, deps.config.batchWindowMs)
      added = fresh.length
    })
    if (added > 0) this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.stopped) return
    const batch = this.engine.deps.store.get().inboxes[this.projectKey]?.batch
    if (!batch) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    const delay = Math.max(0, batch.deliver_after - this.engine.deps.now())
    this.flushTimer = setTimeout(() => void this.flush(), delay)
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.flushing) return
    this.flushing = true
    try {
      await this.flushPass()
    } catch (error) {
      this.log(`msg9 daemon: flush failed for ${this.identityAddress()}: ${(error as Error)?.message ?? String(error)}`)
    } finally {
      this.flushing = false
      // A batch that survived (transient delivery failure) stays scheduled.
      if (!this.stopped && this.engine.deps.store.get().inboxes[this.projectKey]?.batch && !this.retryTimer) {
        this.scheduleFlush()
      }
    }
  }

  private async flushPass(): Promise<void> {
    const { deps } = this.engine
    const identity = this.engine.identities.get(this.projectKey)
    const batch = deps.store.get().inboxes[this.projectKey]?.batch
    if (!identity || !batch) return
    if (batch.messages.length === 0) {
      await deps.store.mutate((state) => {
        delete this.ensureInbox(state).batch
      })
      return
    }

    // Reconcile against the server's unprocessed view (paged — no 100-cap):
    // mail already closed ANYWHERE must not wake anyone again.
    const actionable = await this.onlyUnprocessed(identity, batch.messages)
    if (actionable.length === 0) {
      this.log(`msg9 daemon: ${batch.messages.length} mail(s) for ${identity.address} already closed server-side; skipping delivery`)
      await this.ackBatch(batch.messages.map((message) => message.message_id), batch.next_cursor, batch.cursor_seq)
      return
    }

    const mode: 'followup' | 'inject' = this.budget.decide(deps.now()) === 'wake' ? 'followup' : 'inject'
    const body: DeliverBody = {
      inbox: identity.address,
      project_key: this.projectKey,
      messages: actionable,
      mode,
      ...(mode === 'inject' ? { downgraded: true } : {}),
    }

    const target = deps.registry.forProjectKey(this.projectKey)
    if (!target || target.port <= 0) {
      this.log(`msg9 daemon: no live instance for ${identity.address}; ${actionable.length} mail(s) queued for redelivery`)
      await this.toPending(undefined, body, batch.next_cursor, batch.cursor_seq)
      return
    }
    try {
      await deps.deliverPost(target, body, 15_000)
      await this.ackBatch(batch.messages.map((message) => message.message_id), batch.next_cursor, batch.cursor_seq)
      this.log(`msg9 daemon: delivered ${actionable.length} mail(s) for ${identity.address} to ${target.instance_id} (${mode}${body.downgraded ? ', downgraded' : ''})`)
    } catch (error) {
      if (error instanceof DeliverHttpError && error.noSession) {
        this.log(`msg9 daemon: ${target.instance_id} has no live session for ${identity.address}; ${actionable.length} mail(s) queued for redelivery`)
        await this.toPending(target.instance_id, body, batch.next_cursor, batch.cursor_seq)
        return
      }
      this.retryFailures += 1
      const wait = backoffMs(this.retryFailures, deps.config.deliverRetryBaseMs, deps.config.deliverRetryMaxMs)
      this.log(`msg9 daemon: deliver to ${target.instance_id} failed (${(error as Error)?.message ?? String(error)}); retry in ${Math.round(wait / 1000)}s`)
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        void this.flush()
      }, wait)
    }
  }

  private retryFailures = 0

  /** Cursor advance happens HERE — after the ack — never earlier. */
  private async ackBatch(messageIds: string[], nextCursor: string | undefined, seq: number | undefined): Promise<void> {
    this.retryFailures = 0
    await this.commitCursor(seq, messageIds, nextCursor)
    await this.engine.deps.store.mutate((state) => {
      const inbox = state.inboxes[this.projectKey]
      if (inbox) delete inbox.batch
    })
  }

  private async commitCursor(seq: number | undefined, messageIds: string[], cursor?: string): Promise<void> {
    await this.engine.deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state)
      const atSeq = seq ?? inbox.cursor_seq ?? 0
      // Monotonic: a stale pending item must never regress the cursor.
      if (atSeq >= (inbox.acked_seq ?? 0)) {
        if (cursor) inbox.watch_cursor = cursor
        else if (inbox.fetch_cursor) inbox.watch_cursor = inbox.fetch_cursor
        inbox.acked_seq = atSeq
      }
      inbox.delivered_ids = mergeDeliveredIds(inbox.delivered_ids, messageIds)
    })
  }

  private async toPending(instanceId: string | undefined, body: DeliverBody, nextCursor: string | undefined, seq: number | undefined): Promise<void> {
    const { deps } = this.engine
    this.retryFailures = 0
    await deps.store.mutate((state) => {
      const inbox = state.inboxes[this.projectKey]
      if (inbox) delete inbox.batch
      const mine = state.pending.filter((item) => item.project_key === this.projectKey)
      if (mine.length >= deps.config.pendingCap) {
        // Safe to drop: the cursor never advanced past these, the next fetch
        // refetches them from the server. Pending is an optimization, not the
        // only copy.
        const oldest = mine[0]!
        state.pending.splice(state.pending.indexOf(oldest), 1)
        this.log(`msg9 daemon: pending overflow for ${body.inbox}; dropped the oldest item (cursor still covers it)`)
      }
      const item: PendingItem = {
        id: deps.uuid(),
        project_key: this.projectKey,
        ...(instanceId ? { instance_id: instanceId } : {}),
        messages: body.messages,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        mode: body.mode,
        downgraded: body.downgraded === true,
        enqueued_at: new Date(deps.now()).toISOString(),
        attempts: 0,
        next_retry_at: deps.now(),
        ...(seq !== undefined ? { cursor_seq: seq } : {}),
      }
      state.pending.push(item)
    })
  }

  /**
   * Paged reconcile against folder=unprocessed (the v1.20 rule, without the
   * old limit=100 truncation): pages of 100 until a short page. Falls back to
   * the payload's processed_at when the reconcile call itself fails — a broken
   * reconcile degrades to the old behaviour, never to "wake for everything".
   */
  private async onlyUnprocessed(identity: DaemonIdentity, messages: InboxMessage[]): Promise<InboxMessage[]> {
    const { deps } = this.engine
    if (messages.length === 0) return messages
    try {
      const live = new Set<string>()
      let offset = 0
      for (let page = 0; page < deps.config.unprocessedMaxPages; page += 1) {
        const result = await deps.listInbox(identity.api_url, identity.api_key, { folder: 'unprocessed', limit: 100, offset })
        const rows = result.messages ?? []
        for (const row of rows) live.add(row.message_id)
        if (rows.length < 100) break
        offset += rows.length
      }
      return messages.filter((message) => live.has(message.message_id))
    } catch (error) {
      this.log(`msg9 daemon: unprocessed reconcile failed for ${identity.address} (${(error as Error)?.message ?? String(error)}); falling back to processed_at`)
      return messages.filter((message) => !message.processed_at)
    }
  }
}

// --------------------------------------------------------------- the engine

interface EngineContext {
  deps: EngineDeps
  identities: Map<string, DaemonIdentity>
}

export function createEngine(deps: EngineDeps): Engine {
  const context: EngineContext = { deps, identities: new Map() }
  const runners = new Map<string, InboxRunner>()
  let reconcileTimer: ReturnType<typeof setInterval> | undefined
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  let replaying = false
  let stopped = false

  const reconcile = async (): Promise<void> => {
    const identities = await deps.enumerate()
    const next = new Map(identities.map((identity) => [identity.project_key, identity]))
    context.identities = next
    for (const [key, identity] of next) {
      const runner = runners.get(key)
      if (runner) continue
      const fresh = new InboxRunner(key, context)
      runners.set(key, fresh)
      fresh.start()
      deps.log(`msg9 daemon: watching ${identity.address} (${key})`)
    }
    for (const [key, runner] of [...runners]) {
      if (next.has(key)) continue
      runner.stop()
      runners.delete(key)
      deps.log(`msg9 daemon: inbox ${key} disappeared; watcher stopped`)
    }
    // Keep the persisted address/api_url in step with the credentials.
    await deps.store.mutate((state) => {
      for (const [key, identity] of next) {
        const inbox = (state.inboxes[key] ??= { address: identity.address, api_url: identity.api_url })
        inbox.address = identity.address
        inbox.api_url = identity.api_url
      }
    })
  }

  const replayPending = async (projectKey?: string): Promise<void> => {
    if (replaying) return
    replaying = true
    try {
      const now = deps.now()
      const due = deps.store.get().pending.filter((item) =>
        item.next_retry_at <= now && (!projectKey || item.project_key === projectKey))
      const skippedKeys = new Set<string>()
      for (const item of due) {
        if (skippedKeys.has(item.project_key)) continue // FIFO per inbox
        const target = deps.registry.forProjectKey(item.project_key)
        if (!target || target.port <= 0) continue
        const address = context.identities.get(item.project_key)?.address
          ?? deps.store.get().inboxes[item.project_key]?.address
          ?? item.project_key
        try {
          await deps.deliverPost(target, {
            inbox: address,
            project_key: item.project_key,
            messages: item.messages,
            mode: item.mode,
            ...(item.downgraded ? { downgraded: true } : {}),
          }, 15_000)
          await deps.store.mutate((state) => {
            const index = state.pending.findIndex((row) => row.id === item.id)
            if (index !== -1) state.pending.splice(index, 1)
            const inbox = state.inboxes[item.project_key]
            if (inbox) {
              const atSeq = item.cursor_seq ?? inbox.cursor_seq ?? 0
              if (atSeq >= (inbox.acked_seq ?? 0)) {
                if (item.next_cursor) inbox.watch_cursor = item.next_cursor
                inbox.acked_seq = atSeq
              }
              inbox.delivered_ids = mergeDeliveredIds(inbox.delivered_ids, item.messages.map((message) => message.message_id))
            }
          })
          deps.log(`msg9 daemon: redelivered ${item.messages.length} queued mail(s) for ${address} to ${target.instance_id}`)
        } catch (error) {
          const attempts = item.attempts + 1
          const wait = backoffMs(attempts, deps.config.deliverRetryBaseMs, deps.config.deliverRetryMaxMs)
          await deps.store.mutate((state) => {
            const row = state.pending.find((entry) => entry.id === item.id)
            if (row) {
              row.attempts = attempts
              row.next_retry_at = deps.now() + wait
            }
          })
          if (!(error instanceof DeliverHttpError && error.noSession)) {
            deps.log(`msg9 daemon: redelivery for ${address} failed (${(error as Error)?.message ?? String(error)}); retry in ${Math.round(wait / 1000)}s`)
          }
          skippedKeys.add(item.project_key)
        }
      }
    } finally {
      replaying = false
    }
  }

  return {
    async start() {
      await reconcile()
      reconcileTimer = setInterval(() => void reconcile().catch((error) => deps.log(`msg9 daemon: reconcile failed: ${(error as Error)?.message ?? String(error)}`)), deps.config.reconcileMs)
      sweepTimer = setInterval(() => void replayPending(), deps.config.pendingSweepMs)
    },
    async stop() {
      stopped = true
      if (reconcileTimer) clearInterval(reconcileTimer)
      if (sweepTimer) clearInterval(sweepTimer)
      for (const runner of runners.values()) runner.stop()
      runners.clear()
    },
    replayPending(projectKey) {
      if (stopped) return
      void replayPending(projectKey)
    },
    status() {
      const state = deps.store.get()
      return [...context.identities.keys()].sort().map((key) => ({
        project_key: key,
        address: context.identities.get(key)!.address,
        ws_connected: runners.get(key)?.connected ?? false,
        has_cursor: Boolean(state.inboxes[key]?.watch_cursor),
        batch_size: state.inboxes[key]?.batch?.messages.length ?? 0,
        pending: state.pending.filter((item) => item.project_key === key).length,
      }))
    },
  }
}
