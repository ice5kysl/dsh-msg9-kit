/**
 * The daemon's local control server (127.0.0.1, OS-assigned port, token auth).
 *
 * Plugins find the daemon through daemon.json (pid/port/token) and talk to:
 *
 *   GET  /healthz                 liveness + version (unauthenticated)
 *   POST /register                { instance_id, pid, dsh_home, port,
 *                                   deliver_token, protocol, workspaces[] }
 *   POST /heartbeat               { instance_id, port?, workspaces? }
 *                                 → 404 unknown-instance means "register again"
 *   GET  /notify                  { paused }
 *   POST /notify                  { paused }   (the panel bell / msg9_notify)
 *   GET  /events                  debug dump: inboxes, instances, pending
 *
 * Every route except /healthz requires `Authorization: Bearer <token>` with
 * the token from daemon.json (0600, same-user only).
 *
 * @module dsh-msg9-kit/daemon/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { INSTANCE_STALE_MS, type Engine, type InstanceRegistration, type Registry, type WorkspaceRow } from './engine.ts'
import type { DaemonStore } from './state.ts'

export interface ControlServerDeps {
  store: DaemonStore
  registry: Registry
  engine: Engine
  token: string
  version: string
  protocol: number
  startedAt: string
  log(message: string): void
}

export interface ControlServer {
  port: number
  close(): Promise<void>
}

const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function ok(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { ok: true, data })
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed as Record<string, unknown>
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function parseWorkspaces(value: unknown): WorkspaceRow[] {
  if (!Array.isArray(value)) return []
  const rows: WorkspaceRow[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const projectKey = str(record.project_key)
    if (!projectKey) continue
    rows.push({
      project_key: projectKey,
      key: str(record.key) ?? projectKey,
      title: str(record.title) ?? projectKey,
      path: str(record.path) ?? '',
    })
  }
  return rows
}

export function startControlServer(deps: ControlServerDeps): Promise<ControlServer> {
  // 「实例过期」只有一处定义（engine.ts）：pruneStale 与孤儿 pending 归档必须
  // 对"什么算 live"给出同一个答案，否则两条规则会各自漂移。
  const staleAfterMs = INSTANCE_STALE_MS

  const pruneStale = (): void => {
    const now = Date.now()
    for (const instance of deps.registry.list()) {
      if (now - instance.last_seen < staleAfterMs) continue
      // Three missed heartbeats AND the port refuses: the instance is gone.
      const probe = new Promise<boolean>((resolve) => {
        if (instance.port <= 0) {
          resolve(false)
          return
        }
        import('node:net').then(({ connect }) => {
          const socket = connect({ host: '127.0.0.1', port: instance.port })
          socket.setTimeout(1_000)
          socket.once('connect', () => {
            socket.destroy()
            resolve(true)
          })
          socket.once('timeout', () => {
            socket.destroy()
            resolve(false)
          })
          socket.once('error', () => resolve(false))
        }).catch(() => resolve(false))
      })
      void probe.then((alive) => {
        if (!alive) {
          deps.registry.remove(instance.instance_id)
          deps.log(`msg9 daemon: instance ${instance.instance_id} missed heartbeats and its port refuses; unregistered`)
        }
      })
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === '/healthz') {
        return ok(res, {
          status: 'ok',
          version: deps.version,
          protocol: deps.protocol,
          started_at: deps.startedAt,
          uptime_s: Math.round((Date.now() - Date.parse(deps.startedAt)) / 1000),
        })
      }

      const auth = req.headers.authorization ?? ''
      const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
      if (!presented || !tokenMatches(deps.token, presented)) {
        return fail(res, 401, 'unauthorized', 'a valid daemon token is required')
      }

      if (method === 'POST' && path === '/register') {
        const body = await readJsonBody(req)
        const instanceId = str(body.instance_id)
        const deliverToken = str(body.deliver_token)
        const protocol = typeof body.protocol === 'number' ? body.protocol : 0
        if (!instanceId) return fail(res, 400, 'missing-instance', 'field "instance_id" is required')
        if (!deliverToken) return fail(res, 400, 'missing-token', 'field "deliver_token" is required')
        if (protocol !== deps.protocol) {
          return fail(res, 409, 'protocol-mismatch', `daemon speaks protocol ${deps.protocol}, plugin offered ${protocol}`)
        }
        const registration: Omit<InstanceRegistration, 'registered_at' | 'last_seen'> = {
          instance_id: instanceId,
          pid: typeof body.pid === 'number' ? body.pid : 0,
          dsh_home: str(body.dsh_home) ?? '',
          port: typeof body.port === 'number' && body.port > 0 ? body.port : 0,
          deliver_token: deliverToken,
          protocol,
          workspaces: parseWorkspaces(body.workspaces),
        }
        deps.registry.upsert(registration, Date.now())
        deps.log(`msg9 daemon: instance ${instance_id_redact(instanceId)} registered (${registration.workspaces.length} workspace(s), port ${registration.port || 'unknown'})`)
        deps.engine.replayPending()
        return ok(res, {
          instance_id: instanceId,
          notify_paused: deps.store.get().notify_paused === true,
          daemon_version: deps.version,
          protocol: deps.protocol,
        })
      }

      if (method === 'POST' && path === '/heartbeat') {
        const body = await readJsonBody(req)
        const instanceId = str(body.instance_id)
        if (!instanceId) return fail(res, 400, 'missing-instance', 'field "instance_id" is required')
        const touched = deps.registry.touch(instanceId, {
          ...(typeof body.port === 'number' && body.port > 0 ? { port: body.port } : {}),
          ...(body.workspaces !== undefined ? { workspaces: parseWorkspaces(body.workspaces) } : {}),
        }, Date.now())
        if (!touched) return fail(res, 404, 'unknown-instance', 'instance is not registered; register first')
        const pending = deps.store.get().pending.length
        if (pending > 0) deps.engine.replayPending()
        return ok(res, {
          notify_paused: deps.store.get().notify_paused === true,
          pending,
        })
      }

      if (method === 'GET' && path === '/notify') {
        return ok(res, { paused: deps.store.get().notify_paused === true })
      }

      if (method === 'POST' && path === '/notify') {
        const body = await readJsonBody(req)
        const paused = body.paused === true
        await deps.store.mutate((state) => {
          state.notify_paused = paused
        })
        deps.log(`msg9 daemon: notify ${paused ? 'paused' : 'resumed'}`)
        return ok(res, { paused })
      }

      if (method === 'GET' && path === '/events') {
        const state = deps.store.get()
        return ok(res, {
          notify_paused: state.notify_paused === true,
          inboxes: deps.engine.status(),
          instances: deps.registry.list().map((instance) => ({
            instance_id: instance.instance_id,
            pid: instance.pid,
            dsh_home: instance.dsh_home,
            port: instance.port,
            protocol: instance.protocol,
            workspaces: instance.workspaces,
            registered_at: instance.registered_at,
            last_seen_ago_s: Math.round((Date.now() - instance.last_seen) / 1000),
          })),
          pending: state.pending.map((item) => ({
            id: item.id,
            project_key: item.project_key,
            instance_id: item.instance_id ?? null,
            messages: item.messages.length,
            mode: item.mode,
            downgraded: item.downgraded,
            attempts: item.attempts,
            enqueued_at: item.enqueued_at,
          })),
        })
      }

      return fail(res, 404, 'not-found', `no route for ${method} ${path}`)
    })().catch((error) => {
      fail(res, 500, 'internal', (error as Error)?.message ?? String(error))
    })
  })

  const pruneTimer = setInterval(pruneStale, 60_000)

  return new Promise<ControlServer>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('control server did not bind a TCP port'))
        return
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => {
          clearInterval(pruneTimer)
          server.close(() => done())
        }),
      })
    })
  })
}

/** instance ids carry no secrets, but keep logs short. */
function instance_id_redact(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 24)}…`
}
