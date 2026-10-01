/**
 * Persistent state of the msg9 watcher daemon.
 *
 * The daemon is a single per-machine process, deliberately decoupled from any
 * per-DSH_HOME state file: its home is `~/.dsh/msg9-daemon/` (override with
 * MSG9_DAEMON_HOME, tests use a temp dir).
 *
 *   daemon.json   { pid, port, token, started_at, version, protocol }  (0600)
 *                 — written by the live daemon, consumed by plugins to find
 *                 and authenticate to it;
 *   state.json    { notify_paused, inboxes, pending }                  (0600)
 *                 — cursors, the persisted coalescing batch, the pending
 *                 redelivery queue. Cursors move ONLY after a delivery ack.
 *
 * @module dsh-msg9-kit/daemon/state
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InboxMessage } from '../api.ts'

/** Daemon home: single per machine, NOT per DSH_HOME (that is the point). */
export function daemonHome(): string {
  return process.env.MSG9_DAEMON_HOME || join(homedir(), '.dsh', 'msg9-daemon')
}

export function daemonInfoPath(home = daemonHome()): string {
  return join(home, 'daemon.json')
}

export function daemonStatePath(home = daemonHome()): string {
  return join(home, 'state.json')
}

// ---------------------------------------------------------------- daemon.json

/** What a plugin needs to reach the live daemon. */
export interface DaemonInfo {
  pid: number
  port: number
  token: string
  started_at: string
  version: string
  protocol: number
}

export async function readDaemonInfo(home = daemonHome()): Promise<DaemonInfo | undefined> {
  let raw: string
  try {
    raw = await readFile(daemonInfoPath(home), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonInfo>
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return undefined
    return {
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      started_at: parsed.started_at ?? '',
      version: parsed.version ?? 'unknown',
      protocol: parsed.protocol ?? 0,
    }
  } catch {
    return undefined
  }
}

export async function writeDaemonInfo(info: DaemonInfo, home = daemonHome()): Promise<void> {
  await atomicWrite(daemonInfoPath(home), `${JSON.stringify(info, null, 2)}\n`)
}

/** Remove daemon.json, but only if it still describes THIS process. */
export async function removeDaemonInfo(pid: number, home = daemonHome()): Promise<void> {
  const current = await readDaemonInfo(home)
  if (current && current.pid !== pid) return
  await rm(daemonInfoPath(home), { force: true })
}

// ----------------------------------------------------------------- state.json

/** One coalesced, not-yet-acked batch — persisted BEFORE flush for crash recovery. */
export interface PersistedBatch {
  messages: InboxMessage[]
  /** The last server-issued next_cursor covering every message in the batch. */
  next_cursor?: string
  /** Sequence of next_cursor (monotonic per inbox). */
  cursor_seq?: number
  first_queued_at: string
  /** epoch ms: flush at latest-arrival + window, recomputed on each arrival. */
  deliver_after: number
  /** epoch ms: hard ceiling — the 60s max-wait anti-starvation fix. */
  max_wait_until: number
}

/** Per-inbox watch state, keyed by project_key (the credential file's stem). */
export interface DaemonInboxState {
  address: string
  api_url: string
  /** Server-issued position, advanced ONLY after a delivery ack. Never minted locally. */
  watch_cursor?: string
  /** Last FETCHED cursor (uncommitted); batches/pending cover everything up to it. */
  fetch_cursor?: string
  /** Monotonic sequence of fetch_cursor (local, per inbox). */
  cursor_seq?: number
  /** Sequence of watch_cursor; stale pending items must never regress it. */
  acked_seq?: number
  /** Bootstrap baseline (newest message seen at first observation). */
  watch_last_message_id?: string
  watch_last_seen_at?: string
  /** First observation was an EMPTY mailbox: whatever appears next is genuinely new. */
  bootstrap_pending?: boolean
  /** Ring of recently acked message ids (dedupe WS push vs cursor refetch). */
  delivered_ids?: string[]
  batch?: PersistedBatch
}

/** A delivery the target instance refused with 409 (no live session). */
export interface PendingItem {
  id: string
  project_key: string
  /** The instance that 409'd, when known; redelivery always re-resolves. */
  instance_id?: string
  messages: InboxMessage[]
  next_cursor?: string
  /** Sequence of next_cursor (monotonic per inbox). */
  cursor_seq?: number
  mode: 'followup' | 'inject'
  downgraded: boolean
  enqueued_at: string
  attempts: number
  /** epoch ms; retried on register/heartbeat and the periodic sweep. */
  next_retry_at: number
}

export interface DaemonState {
  /** Global mute: mail is tracked (cursor advances) but never delivered. */
  notify_paused?: boolean
  inboxes: Record<string, DaemonInboxState>
  pending: PendingItem[]
}

function emptyState(): DaemonState {
  return { inboxes: {}, pending: [] }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temp, content, { mode: 0o600 })
  await rename(temp, path)
}

// ------------------------------------------------------------------ the store

/**
 * In-memory-authoritative store: loaded once at boot, every mutation serializes
 * through one promise queue and persists write-then-rename. The daemon is the
 * ONLY writer of this file, so no cross-process lock is needed.
 */
export interface DaemonStore {
  readonly home: string
  get(): DaemonState
  mutate(fn: (state: DaemonState) => void): Promise<void>
}

export async function openDaemonStore(home = daemonHome()): Promise<DaemonStore> {
  let state = emptyState()
  try {
    const raw = await readFile(daemonStatePath(home), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DaemonState>
    state = {
      notify_paused: parsed.notify_paused === true,
      inboxes: parsed.inboxes ?? {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const backup = `${daemonStatePath(home)}.corrupt-${Date.now()}`
      await writeFile(backup, await readFile(daemonStatePath(home), 'utf8').catch(() => ''), { mode: 0o600 }).catch(() => {})
      throw new Error(`msg9 daemon state file is not valid JSON (a copy was kept at ${backup}): ${(error as Error).message}`)
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  return {
    home,
    get: () => state,
    mutate(fn) {
      const run = queue.then(async () => {
        fn(state)
        await atomicWrite(daemonStatePath(home), `${JSON.stringify(state, null, 2)}\n`)
      })
      queue = run.catch(() => {})
      return run
    },
  }
}

// --------------------------------------------------------------- pure helpers

/**
 * The flush delay for a batch after a new arrival: the 12s window re-arms per
 * arrival, but never past the 60s max-wait ceiling (the starvation fix).
 */
export function computeFlushAt(batch: Pick<PersistedBatch, 'max_wait_until'>, now: number, windowMs: number): number {
  return Math.min(now + windowMs, batch.max_wait_until)
}

/** Sliding-window backoff shared by redelivery and reconnects. */
export function backoffMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, failures), 6))
}

/** Merge acked ids into the dedupe ring, capped (oldest dropped). */
export function mergeDeliveredIds(existing: string[] | undefined, acked: string[], cap = 200): string[] {
  const seen = new Set(existing ?? [])
  const merged = [...(existing ?? [])]
  for (const id of acked) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/**
 * DM-3 的**孤儿批次**判定（纯函数，便于单测）。
 *
 * 真实故障（2026-09-30，T-22）：state 里可以同时存在两个 project key 指向
 * **同一个地址** —— 一个是活跃实例，另一个是**再也不会注册**的死实例。按 DM-3
 * 「pending 非空 ⇒ 游标不推进」，死 key 上投不出去的批次会把**该地址**的游标
 * 永久钉死 ⇒ 唤醒链路静默哑掉（`/healthz` 一切正常、spool 照写，只有收信人
 * 发现自己漏读了 4 封信）。
 *
 * 归档条件必须**同时**满足两条，缺一不可：
 *
 *   1. `isLive(project_key)` 为假 —— 注册表里没有该实例，或它的 `last_seen`
 *      已过期（见 `INSTANCE_STALE_MS`）；
 *   2. 批次已经压了 **>= ttlMs**（默认 24h）。
 *
 * 阈值必须**远大于重连预算**（心跳 45s、实例过期 3min、重连退避上限 30s）：
 * 「正常重连窗口里被压住的批次」**绝不能**被归档 —— 那正是投递语义「不丢信」
 * 赖以成立的部分。24h 是"这个实例一整天都没露过面"的粗判，宁可少归档、不可误归档。
 *
 * 两个保守边界：`enqueued_at` 不可解析 ⇒ 保留（证明不了年龄就不动手）；
 * `ttlMs <= 0` ⇒ 整个扫描关闭（配置写成 0 的人想要的是"别动"，不是"全归档"）。
 */
export function selectOrphanPending(
  pending: readonly PendingItem[],
  options: { now: number; ttlMs: number; isLive: (projectKey: string) => boolean },
): { archive: PendingItem[]; keep: PendingItem[] } {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) return { archive: [], keep: [...pending] }
  const archive: PendingItem[] = []
  const keep: PendingItem[] = []
  for (const item of pending) {
    const enqueuedAt = Date.parse(item.enqueued_at)
    const oldEnough = Number.isFinite(enqueuedAt) && options.now - enqueuedAt >= options.ttlMs
    if (!options.isLive(item.project_key) && oldEnough) archive.push(item)
    else keep.push(item)
  }
  return { archive, keep }
}

/**
 * 把一个已归档批次"跨过去"：把游标推进到它覆盖的位置，语义与投递成功后的 ack
 * 完全一致（同一单调规则：陈旧批次永不回退 `acked_seq` / `watch_cursor`），
 * 并把它的消息 id 记进去重环，避免下一次回捞又把它们当成新信塞回队列。
 *
 * 与 `InboxRunner.commitCursor`（engine.ts）是同一条规则的第二个入口 —— 改动时
 * 两处必须一起看。
 */
export function acceptArchivedBatch(inbox: DaemonInboxState, item: PendingItem): void {
  const atSeq = item.cursor_seq ?? inbox.cursor_seq ?? 0
  if (atSeq >= (inbox.acked_seq ?? 0)) {
    if (item.next_cursor) inbox.watch_cursor = item.next_cursor
    else if (inbox.fetch_cursor) inbox.watch_cursor = inbox.fetch_cursor
    inbox.acked_seq = atSeq
  }
  inbox.delivered_ids = mergeDeliveredIds(inbox.delivered_ids, item.messages.map((message) => message.message_id))
}

/** The dedupe set for intake: acked ids + in-flight batch + queued redeliveries. */
export function knownMessageIds(state: DaemonState, projectKey: string): Set<string> {
  const inbox = state.inboxes[projectKey]
  const known = new Set<string>(inbox?.delivered_ids ?? [])
  for (const message of inbox?.batch?.messages ?? []) known.add(message.message_id)
  for (const item of state.pending) {
    if (item.project_key !== projectKey) continue
    for (const message of item.messages) known.add(message.message_id)
  }
  return known
}

/** mtime/pid based staleness for the startup lock (same recipe as store.ts). */
export async function isStalePidFile(path: string, staleMs = 30_000): Promise<boolean> {
  let info
  try {
    info = await stat(path)
  } catch {
    return true
  }
  if (Date.now() - info.mtimeMs > staleMs) return true
  const raw = await readFile(path, 'utf8').catch(() => '')
  let pid = NaN
  try {
    pid = Number(JSON.parse(raw).pid)
  } catch {
    /* unreadable content: judge by mtime only */
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
  }
  return false
}
