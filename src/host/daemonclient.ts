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
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DAEMON_PROTOCOL } from './daemon/main.ts'
import type { WorkspaceRow } from './daemon/engine.ts'
import { daemonHome, readDaemonInfo, type DaemonInfo } from './daemon/state.ts'

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

export interface DaemonClient {
  /** The per-boot token the daemon must present on POST /dsh-msg9/deliver. */
  readonly deliverToken: string
  /** The stable per-DSH_HOME id this instance registers under. */
  readonly instanceId: string
  /** Connect (spawning the daemon when needed) and register. false = fall back. */
  start(): Promise<boolean>
  /** Stop heartbeats; the daemon prunes the registration on its own schedule. */
  stop(): Promise<void>
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
    if (!(await healthy(info))) return undefined
    return info
  }

  function spawnDaemon(binPath: string): void {
    if (deps.spawnDaemon) {
      deps.spawnDaemon(binPath)
      return
    }
    try {
      spawn(process.execPath, [binPath], { detached: true, stdio: 'ignore' }).unref()
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
  }
}
