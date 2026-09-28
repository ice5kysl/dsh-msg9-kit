/**
 * The msg9 watcher daemon entry: single-instance guard + wiring.
 *
 * `createDaemon` is the testable core (no guard, no signals); `runDaemon` adds
 * the single-instance contract used by bin/msg9-watcher-daemon.mjs:
 *
 *   1. daemon.json points at a live, healthy daemon → exit 0 (the plugin
 *      reuses the existing instance);
 *   2. otherwise take the startup lock (O_EXCL + stale detection), boot, and
 *      publish daemon.json atomically;
 *   3. SIGTERM/SIGINT shut down gracefully and remove daemon.json.
 *
 * @module dsh-msg9-kit/daemon/main
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { issueWsTicket, listInbox } from '../api.ts'
import { defaultSleep } from '../watch.ts'
import {
  DeliverHttpError,
  createEngine,
  createRegistry,
  defaultEngineConfig,
  type DeliverBody,
  type Engine,
  type EngineConfig,
  type EngineDeps,
  type Registry,
} from './engine.ts'
import { enumerateIdentities } from './identity.ts'
import { startControlServer } from './server.ts'
import {
  daemonHome,
  isStalePidFile,
  openDaemonStore,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
  type DaemonStore,
} from './state.ts'
import { connectWebSocket } from './wsclient.ts'

/** Bump when the register/deliver wire format changes incompatibly. */
export const DAEMON_PROTOCOL = 1

async function daemonVersion(): Promise<string> {
  try {
    // Resolved from the bundle (lib/index.js → <package>/package.json).
    const raw = await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Default delivery: POST the batch to the instance's /dsh-msg9/deliver. */
async function httpDeliver(target: { port: number; deliver_token: string }, body: DeliverBody, timeoutMs: number): Promise<void> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/dsh-msg9/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-msg9-daemon-token': target.deliver_token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new DeliverHttpError(`deliver request failed: ${(error as Error)?.message ?? String(error)}`, undefined, false)
  }
  if (response.status === 409) throw new DeliverHttpError('instance reports no live session', 409, true)
  if (!response.ok) throw new DeliverHttpError(`deliver answered HTTP ${response.status}`, response.status, false)
}

export interface DaemonConfig extends Partial<EngineConfig> {
  home?: string
  version?: string
  log?: (message: string) => void
  /** Test seam: replace the HTTP delivery call. */
  deliverPost?: EngineDeps['deliverPost']
}

export interface DaemonHandle {
  readonly port: number
  readonly token: string
  readonly home: string
  readonly engine: Engine
  readonly store: DaemonStore
  readonly registry: Registry
  close(): Promise<void>
}

/** Boot the daemon without any single-instance guard (tests drive this). */
export async function createDaemon(config: DaemonConfig = {}): Promise<DaemonHandle> {
  const home = config.home ?? daemonHome()
  const log = config.log ?? ((message: string) => console.log(message))
  const version = config.version ?? await daemonVersion()
  const startedAt = new Date().toISOString()
  const token = randomUUID()

  const store = await openDaemonStore(home)
  const registry = createRegistry()
  const engineConfig: EngineConfig = { ...defaultEngineConfig() }
  for (const key of Object.keys(engineConfig) as (keyof EngineConfig)[]) {
    const value = config[key]
    if (typeof value === 'number') (engineConfig[key] as number) = value
  }
  const engine = createEngine({
    store,
    registry,
    config: engineConfig,
    log,
    uuid: () => randomUUID(),
    now: () => Date.now(),
    listInbox: (apiUrl, apiKey, query) => listInbox(apiUrl, apiKey, query),
    issueWsTicket: (apiUrl, apiKey, signal) => issueWsTicket(apiUrl, apiKey, signal),
    wsConnect: (url, options) => connectWebSocket(url, options),
    deliverPost: config.deliverPost ?? httpDeliver,
    sleep: defaultSleep,
    enumerate: () => enumerateIdentities(log),
  })
  const server = await startControlServer({
    store,
    registry,
    engine,
    token,
    version,
    protocol: DAEMON_PROTOCOL,
    startedAt,
    log,
  })
  await engine.start()
  await writeDaemonInfo({ pid: process.pid, port: server.port, token, started_at: startedAt, version, protocol: DAEMON_PROTOCOL }, home)
  log(`msg9 daemon: ${Object.keys(store.get().inboxes).length} known inbox(es); control on 127.0.0.1:${server.port}`)

  return {
    port: server.port,
    token,
    home,
    engine,
    store,
    registry,
    async close() {
      await engine.stop()
      await server.close()
      await removeDaemonInfo(process.pid, home)
    },
  }
}

// ---------------------------------------------------------- runDaemon (bin)

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return pid === process.pid
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * The bin entry contract: reuse a live daemon, otherwise become it.
 * Resolves with the process exit code (0 = reused or clean shutdown).
 */
export async function runDaemon(): Promise<number> {
  const home = daemonHome()
  const log = (message: string): void => console.log(`[${new Date().toISOString()}] ${message}`)

  const existing = await readDaemonInfo(home)
  if (existing && pidAlive(existing.pid) && await healthy(existing.port)) {
    console.log(`msg9 daemon already running (pid ${existing.pid}, port ${existing.port})`)
    return 0
  }

  // Startup lock: two daemons spawned at once must not race past the guard.
  await mkdir(home, { recursive: true })
  const lockPath = join(home, 'daemon.start.lock')
  for (let attempt = 0; ; attempt += 1) {
    let handle
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      await handle.close()
      break
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStalePidFile(lockPath)) {
        await rm(lockPath, { force: true })
        continue
      }
      // Another daemon is starting right now: wait for ITS daemon.json.
      await new Promise((resolve) => setTimeout(resolve, 250))
      const winner = await readDaemonInfo(home)
      if (winner && winner.pid !== process.pid && await healthy(winner.port)) {
        console.log(`msg9 daemon already running (pid ${winner.pid}, port ${winner.port})`)
        return 0
      }
      if (attempt >= 40) {
        console.error('msg9 daemon: another instance holds the startup lock but never came up')
        return 1
      }
    }
  }

  let daemon: DaemonHandle | undefined
  try {
    daemon = await createDaemon({ home, log })
  } finally {
    await rm(lockPath, { force: true })
  }
  log(`msg9 watcher daemon up on 127.0.0.1:${daemon.port} (pid ${process.pid})`)

  return new Promise<number>((resolve) => {
    const shutdown = (signal: string): void => {
      log(`msg9 daemon: ${signal} received; shutting down`)
      void daemon.close().then(() => resolve(0), () => resolve(0))
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
  })
}
