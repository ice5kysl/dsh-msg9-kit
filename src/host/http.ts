/**
 * Browser bridge of dsh-msg9-kit.
 *
 * The browser face never sees a msg9 key: it calls `/dsh-msg9/*` on the local
 * dsh web server, and this module performs the msg9 calls with the keys held in
 * the plugin state file. Requests are accepted only from loopback / same-origin
 * callers.
 *
 * Routes (all `GET` unless noted):
 *   /dsh-msg9/overview?cwd=<abs path>   tenant + workspace table + current inbox
 *   /dsh-msg9/messages?key=&folder=&limit=&offset=
 *   /dsh-msg9/outbox?key=&limit=&offset=
 *   /dsh-msg9/contacts?key=             address book of that workspace inbox
 *   /dsh-msg9/peers                     sibling inboxes (owner agents, or local)
 *   /dsh-msg9/account/agents            every agent of every owner on this account (v1.10)
 *   /dsh-msg9/directory                 public yellow pages (the「广场」listing)
 *   /dsh-msg9/unread                    per-workspace unread counts (sidebar badge)
 *   POST /dsh-msg9/send                 { key, to, subject, text, correlation_id? }
 *   POST /dsh-msg9/read                 { key, message_id }
 *   POST /dsh-msg9/done                 { key, message_id } — mark handled (processed_by: human)
 *   POST /dsh-msg9/provision            { key } or { cwd, title? } — open an inbox on demand
 *   POST /dsh-msg9/setup                { owner_key, api_url? } — bind this instance to a msg9 tenant
 *   POST /dsh-msg9/contacts             { key, contact, alias?, notes? }
 *   DELETE /dsh-msg9/contacts?key=&address=
 *
 * @module dsh-msg9-kit/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  addContact,
  deleteContact,
  getGroup,
  groupMessages,
  listContacts,
  listDirectory,
  listGroups,
  listInbox,
  listOutbox,
  markProcessed,
  markRead,
  Msg9ApiError,
  ownerAccountAgents,
  ownerOrgAgents,
  ownerListAgents,
  ownerMe,
  resolveAddress,
  sendMessage,
} from './api.ts'
import { ensureInbox, ensureSigningKey, maskKey, migrateInbox, ownerContext, type InboxContext } from './service.ts'
import { defaultApiUrl, getNotifyPaused, loadState, setMessageMark, setNotifyPaused, setOwner, stateFilePath, type OwnerState, type State } from './store.ts'
import type { OverviewView, WorkspaceView } from '../shared/types.ts'
import {
  deriveAddress,
  listWorkspaces,
  matchWorkspaceByPath,
  type CurrentWorkspace,
} from './workspace.ts'

/** Absolute prefix the browser face calls. */
export const BRIDGE_PREFIX = '/dsh-msg9'

/** The msg9 calls the bridge performs (injectable so tests can fake them). */
export interface BridgeApi {
  listInbox: typeof listInbox
  listOutbox: typeof listOutbox
  sendMessage: typeof sendMessage
  markRead: typeof markRead
  markProcessed: typeof markProcessed
  listContacts: typeof listContacts
  addContact: typeof addContact
  deleteContact: typeof deleteContact
  resolveAddress: typeof resolveAddress
  listDirectory: typeof listDirectory
  ownerListAgents: typeof ownerListAgents
  ownerAccountAgents: typeof ownerAccountAgents
  ownerOrgAgents: typeof ownerOrgAgents
  listGroups: typeof listGroups
  getGroup: typeof getGroup
  groupMessages: typeof groupMessages
}

/** Everything the bridge reads from the host (injectable). */
export interface BridgeDeps {
  api: BridgeApi
  loadState(): Promise<State>
  stateFilePath(): string
  defaultApiUrl(): string
  ensureInbox(workspace: CurrentWorkspace, signal?: AbortSignal): Promise<InboxContext>
  listWorkspaces(): CurrentWorkspace[]
  matchWorkspaceByPath(cwd: string | undefined): CurrentWorkspace | undefined
  log(message: string): void
  /** Optional SSE invalidation bus (clients stop polling /unread when present). */
  events?: BridgeEventBus
}

/**
 * A tiny invalidation bus: the host emits a reason string ('mail' / 'read' /
 * 'sync' …), SSE subscribers wake and refetch. Dead listeners are dropped
 * silently — a hung client must never break the bridge.
 */
export interface BridgeEventBus {
  subscribe(listener: (event: string) => void): () => void
  emit(event: string): void
  size(): number
}

export function createBridgeEventBus(): BridgeEventBus {
  const listeners = new Set<(event: string) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          /* a dead client must not break the bridge */
        }
      }
    },
    size: () => listeners.size,
  }
}

export interface Msg9Bridge {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

export interface UnreadView {
  total: number
  byKey: Record<string, number>
  totalByKey: Record<string, number>
}

/**
 * /unread 的放大防护：N 信箱 × M 标签页 × 每次 SSE 事件曾各打一轮上游。
 * 现在同一进程共享一份 ~10s TTL 快照 + in-flight 合并；并发调用拿到同一个
 * Promise。某个信箱本次拉取失败时沿用上轮快照里它的计数（有快照的话），
 * 不再静默缺 key、把有信的信箱显示成 0。
 */
const UNREAD_TTL_MS = 10_000
let unreadCache: { at: number; view: UnreadView } | undefined
let unreadInflight: Promise<UnreadView> | undefined

/** 本地状态变化后（已读/闭环/开通/迁移）立刻作废旧快照。 */
export function invalidateUnreadCache(): void {
  unreadCache = undefined
}

/**
 * Unread + mailbox-size snapshot across every provisioned inbox. Used by the
 * /unread route AND the host-side reconcile (which only emits when the
 * snapshot actually changed).
 */
export async function computeUnread(deps: BridgeDeps, signal: AbortSignal, options?: { ttlMs?: number }): Promise<UnreadView> {
  const ttl = options?.ttlMs ?? UNREAD_TTL_MS
  if (unreadInflight) return unreadInflight
  if (unreadCache && Date.now() - unreadCache.at < ttl) return unreadCache.view
  // 共享任务不带任何单个调用方的 signal：第一个调用方断开不应中止合并后
  // 其余等待者的上游拉取（出站调用自带 30s 超时兜底）。
  void signal
  unreadInflight = (async () => {
    const state = await deps.loadState()
    const rows = Object.entries(state.workspaces).filter(([, inbox]) => Boolean(inbox.api_key))
    const settled = await Promise.allSettled(
      rows.map(async ([key, inbox]) => {
        // folder=all: one call yields both the mailbox size and the unread count.
        const page = await deps.api.listInbox(inbox.api_url, inbox.api_key, { folder: 'all', limit: 1 })
        return [key, Number(page?.unread_count ?? 0), Number(page?.total ?? (page?.messages ?? []).length)] as const
      }),
    )
    const previous = unreadCache?.view
    const byKey: Record<string, number> = {}
    const totalByKey: Record<string, number> = {}
    let total = 0
    for (let index = 0; index < rows.length; index += 1) {
      const [key] = rows[index]!
      const result = settled[index]!
      if (result.status === 'fulfilled') {
        const [, count, mailboxSize] = result.value
        byKey[key] = count
        totalByKey[key] = mailboxSize
        total += count
      } else if (previous && key in previous.byKey) {
        // 部分失败：沿用上轮快照里该信箱的计数，而不是静默丢 key。
        byKey[key] = previous.byKey[key]!
        totalByKey[key] = previous.totalByKey[key] ?? 0
        total += byKey[key]!
      }
    }
    const view: UnreadView = { total, byKey, totalByKey }
    unreadCache = { at: Date.now(), view }
    return view
  })().finally(() => {
    unreadInflight = undefined
  })
  return unreadInflight
}

/** The real dependencies, bound to a host context. */
export function defaultBridgeDeps(ctx: Context, override: Partial<BridgeApi> = {}): BridgeDeps {
  return {
    api: {
      listInbox,
      listOutbox,
      sendMessage,
      markRead,
      markProcessed,
      listContacts,
      addContact,
      deleteContact,
      resolveAddress,
      listDirectory,
      ownerListAgents,
      ownerAccountAgents,
      ownerOrgAgents,
      listGroups,
      getGroup,
      groupMessages,
      ...override,
    },
    loadState,
    stateFilePath,
    defaultApiUrl,
    ensureInbox,
    listWorkspaces: () => listWorkspaces(ctx),
    matchWorkspaceByPath: (cwd) => matchWorkspaceByPath(ctx, cwd),
    log: (message) => {
      try {
        ctx.logger('msg9-kit:http').info(message)
      } catch {
        /* logger is best-effort */
      }
    },
  }
}

// ------------------------------------------------------------------- helpers

/** A structured failure the handler turns into an HTTP response. */
export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function ok(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { ok: true, data })
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** host[:port] → hostname, without the port (and without IPv6 brackets). */
function hostnameOf(host: string | undefined): string | null {
  if (!host) return null
  const bracketed = /^\[([^\]]+)\]/.exec(host)
  if (bracketed) return bracketed[1]!.toLowerCase()
  const colon = host.lastIndexOf(':')
  const bare = colon > 0 ? host.slice(0, colon) : host
  return bare.toLowerCase() || null
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/** 对端 IP 是不是 loopback（含 IPv4-mapped 的 ::ffff:127.x）。 */
function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  return normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(\.\d{1,3}){3}$/.test(normalized)
}

/**
 * Accept a request only from the local GUI or a non-browser local client.
 *
 * A browser `Origin` is authoritative: when it is present it MUST be
 * same-origin with the `Host` header, so a page on another site cannot drive
 * this bridge through the user's browser (CSRF). Requests with no `Origin` at
 * all — curl, the test doubles, other local tools — are accepted only when the
 * CONNECTION comes from loopback (`req.socket.remoteAddress`): the `Host`
 * header is client-supplied, so checking it alone let any local process
 * impersonate the panel (read mail / send / POST /setup to swap the tenant
 * key). The loopback Host check stays as a secondary guard; a missing
 * remoteAddress only happens with injected test doubles, which keep the old
 * Host-only behaviour.
 *
 * Threat-model note (per audit 补充 12): a local process connecting via
 * loopback still passes — deliberately. Such a process could read
 * ~/.dsh/msg9-kit/state.json directly; HTTP-layer defence has never been able
 * to keep out "the machine's owner". What this check actually closes is (a) a
 * REMOTE client forging Host when dsh web binds a non-loopback address, and
 * (b) cross-origin browser pages. Those are the bridge's real boundaries.
 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host)
  if (!host) return false
  const origin = req.headers.origin
  if (origin) return isSameOrigin(origin, req.headers.host ?? '')
  const remote = req.socket?.remoteAddress
  if (remote && !isLoopbackAddress(remote)) return false
  return isLoopbackHostname(host)
}

/** host[:port] / [v6][:port] → the port, or undefined when absent. */
function portOf(hostHeader: string): string | undefined {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    if (end < 0) return undefined
    const rest = hostHeader.slice(end + 1)
    return rest.startsWith(':') ? rest.slice(1) : undefined
  }
  const colon = hostHeader.lastIndexOf(':')
  return colon > 0 ? hostHeader.slice(colon + 1) : undefined
}

/** `origin` addresses the same scheme/host/port as the `Host` header. */
function isSameOrigin(origin: string, hostHeader: string): boolean {
  try {
    const parsed = new URL(origin)
    // WHATWG URL 给 IPv6 保留方括号（'[::1]'），hostnameOf 会去掉——对齐再比。
    const originHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (originHost !== hostnameOf(hostHeader)) return false
    const expected = portOf(hostHeader) ?? (parsed.protocol === 'https:' ? '443' : '80')
    const actual = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return actual === expected
  } catch {
    return false
  }
}

/** Best-effort domain for preview addresses: `api.msg9.io` → `msg9.io`. */
function addressDomain(apiUrl: string): string {
  try {
    return new URL(apiUrl).hostname.replace(/^api\./, '') || 'msg9.io'
  } catch {
    return 'msg9.io'
  }
}

const MAX_BODY_BYTES = 1024 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, 'body-too-large', 'request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BridgeError(400, 'invalid-body', 'request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof BridgeError) throw error
    throw new BridgeError(400, 'invalid-body', 'request body is not valid JSON')
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  // `searchParams.get()` is null when absent, and Number(null) === 0 passed the
  // finite check straight into the clamp — every default list call asked the
  // upstream for a single message.
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

// -------------------------------------------------------------------- bridge

/** Build the `/dsh-msg9` handler. */
export function createMsg9Bridge(deps: BridgeDeps): Msg9Bridge {
  /** Every registered workspace plus everything the state file knows. */
  async function workspaceViews(currentKey: string | undefined, apiUrl: string, owner: OwnerState | undefined): Promise<WorkspaceView[]> {
    const state = await deps.loadState()
    // Under a tenant subdomain the preview matches provisioning: readable
    // (hash-less) address on the tenant's domain.
    const tenantMode = Boolean(owner?.api_key && owner.slug)
    const mailDomain = owner?.mail_domain || addressDomain(apiUrl)
    // ORG model (v1.22): the pod's real address domain wins when probed.
    const domain = tenantMode ? (owner?.address_domain ?? `${owner!.slug}.${mailDomain}`) : mailDomain
    const planned = (workspace: CurrentWorkspace): string =>
      `${tenantMode ? deriveAddress(workspace, { tenant: true }) : deriveAddress(workspace)}@${domain}`
    const rows = new Map<string, WorkspaceView>()

    for (const workspace of deps.listWorkspaces()) {
      rows.set(workspace.key, {
        key: workspace.key,
        title: workspace.title,
        path: workspace.path,
        address: null,
        // The address provisioning will assign, derived on the host so the
        // panel shows the real thing instead of guessing from the raw key.
        planned_address: planned(workspace),
        provisioned: false,
        cursor: null,
        current: workspace.key === currentKey,
      })
    }
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      const existing = rows.get(key)
      // Legacy = provisioned under a previous tenant: the address lives
      // outside the current tenant domain and should be migrated.
      const legacy = Boolean(inbox.api_key && tenantMode && inbox.address && !inbox.address.endsWith(`@${domain}`))
      rows.set(key, {
        key,
        title: inbox.title || existing?.title || key,
        path: inbox.path || existing?.path || '',
        address: inbox.address,
        planned_address: inbox.api_key
          ? (legacy ? planned({ key, title: inbox.title || existing?.title || key, path: inbox.path || existing?.path || '' }) : null)
          : (existing?.planned_address ?? null),
        provisioned: Boolean(inbox.api_key),
        legacy,
        cursor: inbox.cursor ?? null,
        current: key === currentKey,
      })
    }

    return [...rows.values()].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      if (a.provisioned !== b.provisioned) return a.provisioned ? -1 : 1
      return a.title.localeCompare(b.title)
    })
  }

  /** The inbox behind a state key, provisioning it when the workspace is known. */
  async function inboxFor(key: string, signal: AbortSignal): Promise<InboxContext> {
    const state = await deps.loadState()
    const existing = state.workspaces[key]
    if (existing?.api_key) {
      return {
        workspace: { key, title: existing.title, path: existing.path },
        inbox: existing.signing_seed ? existing : await ensureSigningKey(key, existing, deps.log),
        provisioned: false,
      }
    }
    const workspace = deps.listWorkspaces().find((row) => row.key === key)
    if (!workspace) throw new BridgeError(404, 'unknown-workspace', `no workspace is registered as "${key}"`)
    return deps.ensureInbox(workspace, signal)
  }

  async function overview(url: URL): Promise<OverviewView> {
    const cwd = str(url.searchParams.get('cwd'))
    const current = deps.matchWorkspaceByPath(cwd)
    const { owner, apiUrl } = await ownerContext()
    const workspaces = await workspaceViews(current?.key, apiUrl, owner)
    // A session outside the registry still belongs in the table, unprovisioned:
    // the panel offers "open inbox" for exactly this row.
    if (current && !workspaces.some((row) => row.key === current.key)) {
      const tenantMode = Boolean(owner?.api_key && owner.slug)
      const mailDomain = owner?.mail_domain || addressDomain(apiUrl)
      const currentDomain = tenantMode ? (owner?.address_domain ?? `${owner!.slug}.${mailDomain}`) : mailDomain
      workspaces.unshift({
        key: current.key,
        title: current.title,
        path: current.path,
        address: null,
        planned_address: `${tenantMode ? deriveAddress(current, { tenant: true }) : deriveAddress(current)}@${currentDomain}`,
        provisioned: false,
        cursor: null,
        current: true,
      })
    }
    return {
      owner: owner ? {
        name: owner.name ?? null,
        id: owner.id ?? null,
        masked: maskKey(owner.api_key),
        slug: owner.slug ?? null,
        mail_domain: owner.mail_domain ?? null,
        address_domain: owner.address_domain ?? null,
      } : null,
      api_url: owner?.api_url || apiUrl,
      state_file: deps.stateFilePath(),
      current: workspaces.find((row) => row.current) ?? null,
      workspaces,
    }
  }

  async function peers(signal: AbortSignal): Promise<{ address: string; title: string | null; path: string | null; local: boolean }[]> {
    const state = await deps.loadState()
    const localByAddress = new Map(Object.values(state.workspaces).map((inbox) => [inbox.address, inbox]))
    const { owner } = await ownerContext()

    if (owner?.api_key) {
      const { agents } = await deps.api.ownerListAgents(owner.api_url, owner.api_key, 0, 200, signal)
      return (agents ?? []).map((row) => ({
        address: row.agent_address,
        title: localByAddress.get(row.agent_address)?.title ?? null,
        path: localByAddress.get(row.agent_address)?.path ?? null,
        local: localByAddress.has(row.agent_address),
        display_name: row.profile?.display_name ?? null,
        description: row.profile?.description ?? null,
        capabilities: row.profile?.capabilities ?? [],
      }))
    }
    return Object.values(state.workspaces).map((inbox) => ({
      address: inbox.address,
      title: inbox.title,
      path: inbox.path,
      local: true,
    }))
  }

  async function unread(signal: AbortSignal): Promise<{ total: number; byKey: Record<string, number>; totalByKey: Record<string, number> }> {
    return computeUnread(deps, signal)
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || BRIDGE_PREFIX
    const method = req.method ?? 'GET'
    const controller = new AbortController()
    // `req 'close'` fires as soon as the request is complete - measured at +0ms
    // on a POST, before any outbound call starts - so it does NOT mean "the
    // client went away". Aborting on it killed every outbound msg9 call at
    // birth, which the panel reported as "This operation was aborted" (tenant
    // binding was the visible casualty). Only a response that closed before it
    // finished is a real disconnect.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    const signal = controller.signal

    if (method === 'GET' && path === `${BRIDGE_PREFIX}/overview`) return ok(res, await overview(url))

    if (method === 'GET' && path === `${BRIDGE_PREFIX}/unread`) return ok(res, await unread(signal))

    // Notification mute (the panel bell / msg9_notify): pause mail wake-ups
    // while the human is mid-task; the badge keeps working either way.
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/notify`) {
      return ok(res, { paused: await getNotifyPaused() })
    }
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/notify`) {
      const body = await readJsonBody(req)
      const paused = body.paused === true
      await setNotifyPaused(paused)
      deps.events?.emit(paused ? 'notify-paused' : 'notify-resumed')
      return ok(res, { paused })
    }

    // Server-sent events: clients subscribe once and refetch /unread only
    // when the host says something changed ('mail' / 'read' / 'sync'…),
    // instead of polling on a timer. One open response per subscriber.
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/events`) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      const heartbeat = setInterval(() => {
        try {
          res.write(': hb\n\n')
        } catch {
          /* closed below */
        }
      }, 25_000)
      const unsubscribe = deps.events?.subscribe((event) => {
        try {
          res.write(`data: ${JSON.stringify({ type: 'invalidate', reason: event })}\n\n`)
        } catch {
          /* the close handler unsubscribes */
        }
      })
      res.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe?.()
      })
      return
    }

    if (method === 'GET' && path === `${BRIDGE_PREFIX}/peers`) return ok(res, { peers: await peers(signal) })

    // 「我的租户网络」: the ORG-level union when the server knows §28 (v1.27),
    // falling back to the v1.10 account-level union otherwise — narrow fields
    // only. Needs the bound tenant key.
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/account/agents`) {
      const { owner } = await ownerContext()
      if (!owner?.api_key) throw new BridgeError(400, 'no-tenant', 'bind a tenant first (msg9_tk_…)')
      const page = await deps.api.ownerOrgAgents(
        owner.api_url,
        owner.api_key,
        intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
        intParam(url.searchParams.get('limit'), 50, 1, 200),
        signal,
      )
      const agents = (page.agents ?? []).map((row) => ({
        owner_id: row.owner_id,
        owner_name: row.owner_name,
        owner_slug: row.owner_slug ?? null,
        address_domain: row.address_domain,
        address: row.agent_address,
        status: row.status,
        display_name: row.profile?.display_name ?? null,
        description: row.profile?.description ?? null,
        capabilities: row.profile?.capabilities ?? [],
      }))
      return ok(res, { agents, total: page.total ?? agents.length, org_id: page.org_id ?? null, org_label: page.org_label ?? null })
    }

    // The public yellow pages behind the「广场」tab: no key needed, so the
    // panel can browse agents of other tenants and add them as contacts.
    // q / capability are server-side (substring match / exact tag), limit caps
    // at 100 per the v1.10 spec — asking for more falls back to the default 20.
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/directory`) {
      const { apiUrl } = await ownerContext()
      const page = await deps.api.listDirectory(apiUrl, {
        limit: intParam(url.searchParams.get('limit'), 100, 1, 100),
        offset: intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
        q: str(url.searchParams.get('q')),
        capability: str(url.searchParams.get('capability')),
      }, signal)
      const agents = (page.agents ?? []).map((row) => ({
        address: row.address,
        display_name: row.profile?.display_name ?? null,
        description: row.profile?.description ?? null,
        capabilities: row.profile?.capabilities ?? [],
        links: row.profile?.links ?? {},
        created_at: row.created_at,
      }))
      return ok(res, { agents, total: page.total ?? agents.length })
    }

    if (method === 'GET' && path === `${BRIDGE_PREFIX}/messages`) {
      const key = str(url.searchParams.get('key'))
      if (!key) throw new BridgeError(400, 'missing-key', 'query parameter "key" is required')
      const { inbox, workspace } = await inboxFor(key, signal)
      const page = await deps.api.listInbox(inbox.api_url, inbox.api_key, {
        folder: str(url.searchParams.get('folder')) ?? 'all',
        limit: intParam(url.searchParams.get('limit'), 20, 1, 100),
        offset: intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
        ...(str(url.searchParams.get('since')) ? { since: str(url.searchParams.get('since')) } : {}),
      }, signal)
      // Attribution merge: the server is authoritative since v1.13; the local
      // marks only fill gaps (older servers, or marks made before v1.13).
      const marks = inbox.marks ?? {}
      const messages = (page.messages ?? []).map((message) => {
        const mark = marks[message.message_id]
        if (!mark) return message
        const readBy = message.read_by ?? mark.read_by
        const processedBy = message.processed_by ?? mark.processed_by
        const processedAt = message.processed_at ?? mark.processed_at
        return {
          ...message,
          ...(readBy ? { read_by: readBy } : {}),
          ...(processedBy ? { processed_by: processedBy, processed_at: processedAt } : {}),
        }
      })
      return ok(res, {
        workspace: { key: workspace.key, title: workspace.title, address: inbox.address },
        messages,
        total: page.total ?? messages.length,
        unread_count: page.unread_count ?? 0,
        next_cursor: page.next_cursor ?? null,
      })
    }

    if (method === 'GET' && path === `${BRIDGE_PREFIX}/outbox`) {
      const key = str(url.searchParams.get('key'))
      if (!key) throw new BridgeError(400, 'missing-key', 'query parameter "key" is required')
      const { inbox, workspace } = await inboxFor(key, signal)
      const page = await deps.api.listOutbox(inbox.api_url, inbox.api_key, {
        limit: intParam(url.searchParams.get('limit'), 20, 1, 100),
        offset: intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
      }, signal)
      return ok(res, {
        workspace: { key: workspace.key, title: workspace.title, address: inbox.address },
        messages: page.messages ?? [],
        total: page.total ?? 0,
      })
    }

    if (method === 'GET' && path === `${BRIDGE_PREFIX}/contacts`) {
      const key = str(url.searchParams.get('key'))
      if (!key) throw new BridgeError(400, 'missing-key', 'query parameter "key" is required')
      const { inbox } = await inboxFor(key, signal)
      const page = await deps.api.listContacts(inbox.api_url, inbox.api_key, {}, signal)
      return ok(res, { contacts: page.contacts ?? [], total: page.total ?? 0 })
    }

    // v1.19 groups the workspace inbox belongs to (contacts tab「组」section).
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/groups`) {
      const key = str(url.searchParams.get('key'))
      if (!key) throw new BridgeError(400, 'missing-key', 'query parameter "key" is required')
      const { inbox } = await inboxFor(key, signal)
      const address = str(url.searchParams.get('address'))
      if (address) {
        return ok(res, { group: await deps.api.getGroup(inbox.api_url, inbox.api_key, address, signal) })
      }
      const page = await deps.api.listGroups(inbox.api_url, inbox.api_key, signal)
      return ok(res, { groups: page.groups ?? [], total: page.total ?? (page.groups ?? []).length })
    }

    // Group archive (the「群组」tab's right column).
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/groups/messages`) {
      const key = str(url.searchParams.get('key'))
      const address = str(url.searchParams.get('address'))
      if (!key) throw new BridgeError(400, 'missing-key', 'query parameter "key" is required')
      if (!address) throw new BridgeError(400, 'missing-address', 'query parameter "address" is required')
      const { inbox } = await inboxFor(key, signal)
      const page = await deps.api.groupMessages(inbox.api_url, inbox.api_key, address, {
        limit: intParam(url.searchParams.get('limit'), 50, 1, 100),
        offset: intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
      }, signal)
      return ok(res, { messages: page.messages ?? [], total: page.total ?? (page.messages ?? []).length })
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/contacts`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      const contact = str(body.contact)
      if (!key) throw new BridgeError(400, 'missing-key', 'field "key" is required')
      if (!contact) throw new BridgeError(400, 'missing-contact', 'field "contact" is required')
      const { inbox } = await inboxFor(key, signal)
      const created = await deps.api.addContact(inbox.api_url, inbox.api_key, {
        contact,
        ...(str(body.alias) ? { alias: str(body.alias)! } : {}),
        ...(str(body.notes) ? { notes: str(body.notes)! } : {}),
      }, signal)
      return ok(res, { contact: created })
    }

    if (method === 'DELETE' && path === `${BRIDGE_PREFIX}/contacts`) {
      const key = str(url.searchParams.get('key'))
      const address = str(url.searchParams.get('address'))
      if (!key) throw new BridgeError(400, 'missing-key', 'query parameter "key" is required')
      if (!address) throw new BridgeError(400, 'missing-address', 'query parameter "address" is required')
      const { inbox } = await inboxFor(key, signal)
      await deps.api.deleteContact(inbox.api_url, inbox.api_key, address, signal)
      return ok(res, { removed: address })
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/send`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      const to = str(body.to)
      const text = typeof body.text === 'string' ? body.text : undefined
      if (!key) throw new BridgeError(400, 'missing-key', 'field "key" is required')
      if (!to) throw new BridgeError(400, 'missing-to', 'field "to" is required')
      if (!text) throw new BridgeError(400, 'missing-text', 'field "text" is required')
      const { inbox, workspace } = await inboxFor(key, signal)
      const correlationId = str(body.correlation_id)
      const replyTo = str(body.reply_to)
      const result = await deps.api.sendMessage(inbox.api_url, inbox.api_key, {
        to,
        subject: str(body.subject),
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(correlationId ? { correlationId } : {}),
        idempotencyKey: str(body.idempotency_key) ?? `dsh-ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      }, signal, inbox.signing_seed ? { from: inbox.address, seedBase64: inbox.signing_seed } : undefined)
      // 回复即处理: a reply closes the loop on the original message. Prefer
      // reply_to's target (precise); fall back to the correlation id.
      const closedId = replyTo ?? correlationId
      if (closedId) await setMessageMark(key, closedId, { processed_by: 'human' })
      deps.log(`sent ${result.message_id} from ${inbox.address} to ${to}`)
      return ok(res, { message_id: result.message_id, status: result.status, from: inbox.address, workspace: workspace.title })
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/read`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      const messageId = str(body.message_id)
      if (!key) throw new BridgeError(400, 'missing-key', 'field "key" is required')
      if (!messageId) throw new BridgeError(400, 'missing-message', 'field "message_id" is required')
      const { inbox } = await inboxFor(key, signal)
      await deps.api.markRead(inbox.api_url, inbox.api_key, messageId, 'human', signal)
      // The panel marked this one: attribute the read to the human.
      await setMessageMark(key, messageId, { read_by: 'human' })
      invalidateUnreadCache()
      deps.events?.emit('read')
      return ok(res, { message_id: messageId, read: true })
    }

    // Explicit "handled" from the panel: closes the loop without replying.
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/done`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      const messageId = str(body.message_id)
      if (!key) throw new BridgeError(400, 'missing-key', 'field "key" is required')
      if (!messageId) throw new BridgeError(400, 'missing-message', 'field "message_id" is required')
      const { inbox } = await inboxFor(key, signal)
      // v1.13 server-native processed (implies read); local marks back up
      // older servers.
      try {
        await deps.api.markProcessed(inbox.api_url, inbox.api_key, messageId, 'human', signal)
      } catch {
        await deps.api.markRead(inbox.api_url, inbox.api_key, messageId, 'human', signal).catch(() => {})
      }
      await setMessageMark(key, messageId, { read_by: 'human', processed_by: 'human' })
      invalidateUnreadCache()
      deps.events?.emit('done')
      return ok(res, { message_id: messageId, processed: true })
    }

    // Bind this dsh instance to a msg9 tenant (owner). The key is validated
    // against /owner/me first, so a mistyped token is reported right here
    // instead of failing on every later call.
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/setup`) {
      const body = await readJsonBody(req)
      const ownerKey = str(body.owner_key)
      if (!ownerKey) throw new BridgeError(400, 'missing-owner-key', 'field "owner_key" is required')
      const apiUrl = (str(body.api_url) || defaultApiUrl()).replace(/\/+$/, '')
      let me: Record<string, unknown>
      try {
        me = await ownerMe(apiUrl, ownerKey, signal)
      } catch (error) {
        // Tell a refused key apart from an unreachable API: the first is a token
        // problem the user can fix, the second a base-URL/network problem. A
        // bare "owner-key-rejected" for both wasted a debugging round.
        if (error instanceof Msg9ApiError) {
          const code = error.code === undefined ? '' : `, code ${error.code}`
          throw new BridgeError(
            400,
            'owner-key-rejected',
            `msg9 rejected this key (HTTP ${error.status}${code}): ${error.message}`,
          )
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new BridgeError(400, 'msg9-unreachable', `cannot reach ${apiUrl}: ${reason}`)
      }
      const id = typeof me.id === 'string' ? me.id : undefined
      const name = typeof me.name === 'string' ? me.name : undefined
      const slug = typeof me.slug === 'string' ? me.slug : null
      const mailDomain = typeof me.mail_domain === 'string' ? me.mail_domain : undefined
      const addressDomain = typeof me.address_domain === 'string' ? me.address_domain : null
      await setOwner({ api_key: ownerKey, api_url: apiUrl, id, name, slug, mail_domain: mailDomain, address_domain: addressDomain })
      invalidateUnreadCache()
      return ok(res, {
        owner: {
          name: name ?? null,
          id: id ?? null,
          masked: maskKey(ownerKey),
          slug,
          mail_domain: mailDomain ?? null,
          address_domain: addressDomain,
        },
        api_url: apiUrl,
      })
    }

    // Tenant migration: re-provision one workspace's inbox under the current
    // tenant (new domain address), replacing the state entry; when the caller
    // supplies the previous tenant's key, the old inbox is suspended too.
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/migrate`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      if (!key) throw new BridgeError(400, 'missing-key', 'field "key" is required')
      const state = await deps.loadState()
      const existing = state.workspaces[key]
      if (!existing?.api_key) throw new BridgeError(404, 'unknown-workspace', `no inbox is registered as "${key}"`)
      const workspace = deps.listWorkspaces().find((row) => row.key === key)
        ?? { key, title: existing.title, path: existing.path }
      const result = await migrateInbox(workspace, existing, str(body.old_owner_key))
      invalidateUnreadCache()
      deps.log(`migrated ${key}: ${existing.address} -> ${result.inbox.address}`)
      deps.events?.emit('migrate')
      return ok(res, {
        key,
        old_address: existing.address,
        new_address: result.inbox.address,
        old_disabled: result.oldDisabled,
        forwarding: result.forwarding,
        moved_mail: result.movedMail,
        ...(result.note ? { note: result.note } : {}),
      })
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/provision`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      const cwd = str(body.cwd)
      const title = str(body.title)
      const state = await deps.loadState()
      const known = key ? state.workspaces[key] : undefined
      const workspace = (key ? deps.listWorkspaces().find((row) => row.key === key) : undefined)
        ?? (key && known ? { key, title: known.title, path: known.path } : undefined)
        ?? deps.matchWorkspaceByPath(cwd)
      if (!workspace) throw new BridgeError(400, 'missing-workspace', 'field "key" (workspace) or "cwd" is required')
      const { inbox, provisioned } = await deps.ensureInbox(
        title ? { ...workspace, title } : workspace,
        signal,
      )
      if (provisioned) invalidateUnreadCache()
      return ok(res, { key: workspace.key, address: inbox.address, provisioned })
    }

    if (method === 'POST' && path === `${BRIDGE_PREFIX}/resolve`) {
      const body = await readJsonBody(req)
      const address = str(body.address)
      if (!address) throw new BridgeError(400, 'missing-address', 'field "address" is required')
      const { apiUrl } = await ownerContext()
      return ok(res, { record: await deps.api.resolveAddress(apiUrl, address, signal) })
    }

    return fail(res, 404, 'not-found', `no route for ${method} ${path}`)
  }

  return {
    async handle(req, res) {
      try {
        if (!isTrustedRequest(req)) {
          return fail(res, 403, 'forbidden', 'untrusted host or origin')
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        await route(req, res, url)
      } catch (error) {
        if (error instanceof BridgeError) {
          return fail(res, error.status, error.code, error.message)
        }
        const message = (error as Error)?.message ?? String(error)
        const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 502
        const code = typeof (error as { code?: unknown }).code === 'number' ? `msg9-${(error as { code: number }).code}` : 'msg9-error'
        deps.log(`bridge error: ${message}`)
        return fail(res, status >= 400 && status < 600 ? status : 502, code, message)
      }
    },
  }
}
