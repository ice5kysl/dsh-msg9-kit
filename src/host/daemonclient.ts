/**
 * The plugin-side client of the msg9 watcher daemon.
 *
 * The daemon (bin/msg9-watcher-daemon.mjs, one process per machine) owns the
 * WebSocket watchers, cursors, coalescing and storm budgets; a dsh instance's
 * plugin is only a DELIVERY TARGET. This module is the plugin's half of that
 * contract:
 *
 *   1. find the daemon through `~/.dsh/msg9-daemon/daemon.json`; when it is
 *      missing or unhealthy, spawn the bin entry detached and wait (bounded)
 *      for it to publish a healthy daemon.json;
 *   2. register this instance (instance_id, pid, web port, a per-boot
 *      deliver_token, the workspace roster the daemon routes deliveries by);
 *   3. heartbeat well inside the daemon's 3-minute stale window; a 404
 *      `unknown-instance` answer (daemon restarted) means register again, and
 *      a daemon that went away entirely is re-found/re-spawned the same way
 *      as at boot;
 *   4. on stop, just stop heartbeating — the control plane has no unregister
 *      endpoint by design, the daemon prunes after three missed heartbeats
 *      plus a refused port probe.
 *
 * `start()` resolving to false means the daemon is unavailable; the caller
 * (src/host/index.ts) then falls back to the in-process watcher, exactly the
 * pre-daemon behaviour.
 *
 * @module dsh-msg9-kit/daemonclient
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DAEMON_PROTOCOL } from './daemon/main.ts'
import type { WorkspaceRow } from './daemon/engine.ts'
import { daemonHome, readDaemonInfo, type DaemonInfo } from './daemon/state.ts'
// T-13 阶段三：死 pid 自愈（只读判断）。
import { isPidAlive } from './cutover.ts'

export interface DaemonClientDeps {
  /** Daemon home override (tests point at a temp dir; default ~/.dsh/msg9-daemon). */
  home?: string
  /** The bin entry to spawn (default: <package>/bin/msg9-watcher-daemon.mjs). */
  binPath?: string
  /** The plugin's web port at call time; 0 = unknown (headless or startup). */
  getPort(): number
  /** The workspace roster (register payload + every heartbeat refresh). */
  getWorkspaces(): Promise<WorkspaceRow[]>
  /** This instance's DSH_HOME (identity input + debugging); default from env. */
  dshHome?(): string
  log(message: string): void
  /** Test seam for the detached spawn (default: child_process.spawn + unref). */
  spawnDaemon?(binPath: string): void
  now?(): number
  sleep?(ms: number): Promise<void>
  /** Boot wait ceiling for a freshly spawned daemon (default 10s). */
  bootTimeoutMs?: number
  /** Heartbeat cadence (default 45s — the daemon prunes after 3 missed minutes). */
  heartbeatMs?: number
}

/** 一个信箱的未读读数，由 daemon 的推送通道带回（T-23）。 */
export interface DaemonUnreadRow {
  project_key: string
  address: string
  unread: number
  /** 只有确实知道"folder 全量"的调用点才有；否则缺席。 */
  total?: number
  /** 读数时刻（daemon 的 epoch ms，同机时钟可直接比较）。 */
  at?: number
}

export interface DaemonClient {
  /** The per-boot token the daemon must present on POST /dsh-msg9/deliver. */
  readonly deliverToken: string
  /** The stable per-DSH_HOME id this instance registers under. */
  readonly instanceId: string
  /** Connect (spawning the daemon when needed) and register. false = fall back. */
  start(): Promise<boolean>
  /** Stop heartbeats; the daemon prunes the registration on its own schedule. */
  stop(): Promise<void>
  /**
   * T-23：daemon 握着的未读读数（它的每次 fetch 都带 `unread_count`）。
   * 拿不到（老 daemon 没这条路由 / 暂时不可达）就返回空数组 —— 调用方退回
   * REST 直查，绝不因为本地快照缺失而让徽章停摆。
   */
  readUnread(): Promise<DaemonUnreadRow[]>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** One dsh instance per DSH_HOME (store.ts's lock already forbids sharing it). */
export function daemonInstanceId(dshHome: string): string {
  return `dsh-${createHash('sha256').update(dshHome).digest('hex').slice(0, 16)}`
}

/** GET /healthz with a tight budget: the daemon is local, 800ms is generous. */
async function healthy(info: DaemonInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/healthz`, { signal: AbortSignal.timeout(800) })
    return response.ok
  } catch {
    return false
  }
}

export function createDaemonClient(deps: DaemonClientDeps): DaemonClient {
  const home = deps.home ?? daemonHome()
  const log = deps.log
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? defaultSleep
  const dshHome = deps.dshHome ?? defaultDshHome
  const bootTimeoutMs = deps.bootTimeoutMs ?? 10_000
  const heartbeatMs = deps.heartbeatMs ?? 45_000

  const deliverToken = randomUUID()
  const instanceId = daemonInstanceId(dshHome())

  let daemon: DaemonInfo | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let heartbeating = false

  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; data?: Record<string, unknown> }> {
    if (!daemon) throw new Error('no daemon connection')
    const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    })
    let data: Record<string, unknown> | undefined
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch {
      /* an empty/non-JSON body carries no detail */
    }
    return { status: response.status, data }
  }

  /**
   * T-23：读 daemon 的未读快照（`GET /unread`）。
   *
   * 只走 127.0.0.1 —— 这条路径的意义正是**不花 msg9 的 IP 配额**。
   * 任何失败（老 daemon 404 / 连接抖动 / 响应形状不对）都返回空数组：调用方
   * 会退回 REST 直查，徽章不会因为本地快照缺失而变瞎。
   */
  async function readUnread(): Promise<DaemonUnreadRow[]> {
    if (!daemon) return []
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/unread`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return []
      const body = (await response.json()) as { data?: { inboxes?: unknown } }
      const rows = Array.isArray(body?.data?.inboxes) ? body.data!.inboxes as Record<string, unknown>[] : []
      const out: DaemonUnreadRow[] = []
      for (const row of rows) {
        const unread = row?.unread
        const projectKey = row?.project_key
        if (typeof unread !== 'number' || !Number.isFinite(unread) || typeof projectKey !== 'string') continue
        out.push({
          project_key: projectKey,
          address: typeof row.address === 'string' ? row.address : '',
          unread,
          ...(typeof row.total === 'number' && Number.isFinite(row.total) ? { total: row.total } : {}),
          ...(typeof row.at === 'number' && Number.isFinite(row.at) ? { at: row.at } : {}),
        })
      }
      return out
    } catch {
      return []
    }
  }

  async function register(): Promise<boolean> {
    const workspaces = await deps.getWorkspaces()
    const { status, data } = await post('/register', {
      instance_id: instanceId,
      pid: process.pid,
      dsh_home: dshHome(),
      port: deps.getPort(),
      deliver_token: deliverToken,
      protocol: DAEMON_PROTOCOL,
      workspaces,
    })
    if (status === 200) {
      log(`msg9 daemon: registered as ${instanceId} (${workspaces.length} workspace(s))`)
      return true
    }
    // protocol-mismatch (409): the daemon predates/postdates this plugin —
    // running both watchers is safer than negotiating; the caller falls back.
    const detail = data && typeof data.error === 'object' && data.error !== null
      ? String((data.error as Record<string, unknown>).message ?? '')
      : ''
    log(`msg9 daemon: register answered HTTP ${status}${detail ? ` (${detail})` : ''}`)
    return false
  }

  /** A live, healthy daemon.json — reading it fresh (a restart moves the port). */
  async function findDaemon(): Promise<DaemonInfo | undefined> {
    const info = await readDaemonInfo(home)
    if (!info) return undefined
    // T-13 阶段三（死 pid 自愈）：daemon.json 可能指向**已经不在的**进程
    // （历史 56926；平台侧的同类是本机 `daemon.lock.machine-Jiker` 里的 75656）。
    // 死了就当没有 —— 连 800ms 的 /healthz 探测都不必做，也绝不因此拒绝启动：
    // ensureDaemon 会照常 spawn 一个新的。**只读判断，绝不改用户文件。**
    if (!isPidAlive(info.pid)) {
      log(`msg9 daemon: daemon.json points at dead pid ${info.pid}; treating it as absent`)
      return undefined
    }
    if (!(await healthy(info))) return undefined
    return info
  }

  function spawnDaemon(binPath: string): void {
    if (deps.spawnDaemon) {
      deps.spawnDaemon(binPath)
      return
    }
    // Logs must land somewhere. The daemon used to spawn with `stdio: 'ignore'`,
    // so every console line (including the only evidence of a dead doorbell)
    // went to /dev/null: the msg9 PO's field report could not be diagnosed from
    // our side at all — the 90-minute hang was invisible until an external sweep
    // noticed the spool had stopped growing. Append to daemon.log instead.
    const logPath = join(home, 'daemon.log')
    try {
      mkdirSync(home, { recursive: true })
      const logFd = openSync(logPath, 'a')
      try {
        spawn(process.execPath, [binPath], { detached: true, stdio: ['ignore', logFd, logFd] }).unref()
      } finally {
        closeSync(logFd)
      }
    } catch (error) {
      log(`msg9 daemon: spawn failed: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  /** Find or boot the daemon, bounded by bootTimeoutMs. */
  async function ensureDaemon(): Promise<DaemonInfo | undefined> {
    const existing = await findDaemon()
    if (existing) return existing
    const binPath = deps.binPath ?? fileURLToPath(new URL('../bin/msg9-watcher-daemon.mjs', import.meta.url))
    spawnDaemon(binPath)
    const deadline = now() + bootTimeoutMs
    while (now() < deadline) {
      await sleep(200)
      const info = await findDaemon()
      if (info) return info
    }
    return undefined
  }

  async function heartbeat(): Promise<void> {
    if (heartbeating) return
    heartbeating = true
    try {
      const workspaces = await deps.getWorkspaces()
      const port = deps.getPort()
      const { status } = await post('/heartbeat', {
        instance_id: instanceId,
        ...(port > 0 ? { port } : {}),
        workspaces,
      })
      if (status === 404) {
        // unknown-instance: the daemon restarted and lost the registry.
        log('msg9 daemon: heartbeat answered unknown-instance; re-registering')
        await register()
      }
    } catch {
      // The daemon went away (or restarted on a new port): re-resolve it,
      // spawning a fresh one when daemon.json is gone or stale.
      try {
        const info = await ensureDaemon()
        if (info) {
          daemon = info
          await register()
        }
      } catch (error) {
        log(`msg9 daemon: reconnect failed: ${(error as Error)?.message ?? String(error)}`)
      }
    } finally {
      heartbeating = false
    }
  }

  return {
    deliverToken,
    instanceId,
    async start() {
      try {
        const info = await ensureDaemon()
        if (!info) {
          log('msg9 daemon: no healthy daemon came up in time')
          return false
        }
        daemon = info
        if (!(await register())) return false
        heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs)
        return true
      } catch (error) {
        log(`msg9 daemon: unavailable (${(error as Error)?.message ?? String(error)})`)
        return false
      }
    },
    async stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
      // No unregister endpoint by design: the daemon prunes this instance after
      // three missed heartbeats once the web port stops answering.
    },
    readUnread,
  }
}
