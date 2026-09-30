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
 *   POST /dsh-msg9/deliver              the watcher daemon pushes a coalesced
 *                                       batch here (x-msg9-daemon-token auth)
 *
 * @module dsh-msg9-kit/http
 */

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
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
  orgInfo,
  orgListPods,
  resolveAddress,
  sendMessage,
  type InboxMessage,
} from './api.ts'
import { L } from './locale.ts'
import { derivePodLabel, ensureInbox, ensureSigningKey, maskKey, migrateInbox, openPod, ownerContext, podState, type InboxContext } from './service.ts'
import { credentialsMigrated, readOrgKey, removeProjectCredentials, resolveCredentials, saveOwner, writeOrgKey } from './credentials.ts'
import { defaultApiUrl, deleteWorkspaceInbox, getNotifyPaused, isTenantOwner, loadState, saveState, setMessageMark, setNotifyPaused, stateFilePath, withStateLock, type LiveInbox, type OwnerState, type State } from './store.ts'
import type { OverviewView, PodStateView, WorkspaceHealth, WorkspaceView } from '../shared/types.ts'
import type { OrgInfo } from './api.ts'
import {
  deriveAddress,
  isValidLocalPart,
  listWorkspaces,
  matchWorkspaceByPath,
  type CurrentWorkspace,
} from './workspace.ts'
import type { DaemonDelivery } from './watch.ts'

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
  /** ORG 级：列 pod（只读；"开启"前的存在性探测）。 */
  orgInfo: typeof orgInfo
  orgListPods: typeof orgListPods
  listGroups: typeof listGroups
  getGroup: typeof getGroup
  groupMessages: typeof groupMessages
}

/**
 * service.openPod 的返回形状（只列 bridge 透传用到的字段）。
 * 刻意不 import service 的类型，避免 http ↔ service 的循环依赖。
 */
export interface OpenPodResultLike {
  state: string
  podCreated: boolean
  podLabel?: string
  orgLabel?: string
  addressDomain?: string
  existingAgents?: number
  note?: string
}

/** Everything the bridge reads from the host (injectable). */
export interface BridgeDeps {
  api: BridgeApi
  loadState(): Promise<State>
  stateFilePath(): string
  defaultApiUrl(): string
  ensureInbox(workspace: CurrentWorkspace, signal?: AbortSignal, preferred?: string): Promise<InboxContext>
  /** 开启 Pod（ORG → Pod → Agent）。由 service.openPod 实现。 */
  openPod(workspace: CurrentWorkspace, options?: { podLabel?: string }): Promise<OpenPodResultLike>
  /** 开通状态（只读）：unconfigured / pod_closed / ready。 */
  podState(workspace: CurrentWorkspace): Promise<string>
  /** 推导本 workspace 的 pod label（面板预览用，与实际开启路径同一个函数）。 */
  derivePodLabel(workspace: CurrentWorkspace): string
  /** state 的原子更新（ORG 绑定等元数据）。 */
  updateState(mutate: (state: State) => void): Promise<void>
  listWorkspaces(): CurrentWorkspace[]
  matchWorkspaceByPath(cwd: string | undefined): CurrentWorkspace | undefined
  log(message: string): void
  /** 凭据解析（含惰性迁移）；缺省走 credentials.ts 的真实实现。 */
  resolveCredentials?(key: string): Promise<LiveInbox | undefined>
  /** Optional SSE invalidation bus (clients stop polling /unread when present). */
  events?: BridgeEventBus
  /**
   * The watcher daemon's delivery seam (POST /dsh-msg9/deliver). Absent = this
   * instance has no daemon client; the route then answers 401 to everything.
   */
  deliver?: {
    /** The per-boot token the daemon must present (undefined = not registered). */
    token(): string | undefined
    /** Deliver one coalesced batch; throws BridgeError(409) when no live session. */
    handle(body: DaemonDelivery): Promise<unknown>
  }
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

/** 经 deps 注入点解析凭据（测试可替换），缺省走 credentials.ts。 */
function resolveVia(deps: BridgeDeps, key: string): Promise<LiveInbox | undefined> {
  return deps.resolveCredentials ? deps.resolveCredentials(key) : resolveCredentials(key, { log: deps.log })
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
    // 统一从凭据仓解析（含惰性迁移）；解析不到的 entry 不参与计数。
    const keys = Object.keys(state.workspaces)
    const resolved = await Promise.all(keys.map((key) => resolveVia(deps, key)))
    const rows = keys
      .map((key, index) => [key, resolved[index]] as const)
      .filter((pair): pair is readonly [string, LiveInbox] => Boolean(pair[1]))
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
      orgInfo,
      orgListPods,
      listGroups,
      getGroup,
      groupMessages,
      ...override,
    },
    loadState,
    stateFilePath,
    defaultApiUrl,
    ensureInbox,
    openPod,
    podState,
    derivePodLabel,
    // ORG 绑定等元数据的原子更新（走同一把 state 锁，避免与别的写互相覆盖）。
    updateState: (mutate) => withStateLock(async () => {
      const next = await loadState()
      mutate(next)
      await saveState(next)
    }),
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

/** Constant-time token compare for the daemon delivery header. */
function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
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
    // Tenant mode needs an owner key AND a tenant domain; under the ORG model
    // (v1.22) the domain is `address_domain` while the pod reports `slug: ""`,
    // and a slug-only test silently disabled legacy detection — so no legacy
    // inbox was ever offered for migration.
    const tenantMode = Boolean(owner?.api_key && isTenantOwner(owner))
    const mailDomain = owner?.mail_domain || addressDomain(apiUrl)
    // ORG model (v1.22): the pod's real address domain wins when probed.
    const domain = tenantMode ? (owner?.address_domain ?? `${owner!.slug}.${mailDomain}`) : mailDomain
    // 统一从凭据仓解析（含惰性迁移）：address 与 provisioned 以解析结果为准。
    const resolvedByKey = new Map<string, LiveInbox>()
    await Promise.all(Object.keys(state.workspaces).map(async (key) => {
      const resolved = await resolveVia(deps, key)
      if (resolved) resolvedByKey.set(key, resolved)
    }))
    // A workspace that once asked for a specific address previews that address;
    // otherwise the readable per-workspace name provisioning tries first.
    const planned = (workspace: CurrentWorkspace): string => {
      if (!tenantMode) return `${deriveAddress(workspace)}@${domain}`
      const preferred = state.workspaces[workspace.key]?.preferred_address
      return `${preferred ?? deriveAddress(workspace, { tenant: true })}@${domain}`
    }
    const rows = new Map<string, WorkspaceView>()

    // 三态开通状态（主人 2026-09-30）：整个 overview 只探测一次 ORG 的 key 与
    // pod 列表，免得每个 workspace 行都去读一遍凭据仓 / 打一次 API。
    const orgMeta = state.org
    const orgKey = orgMeta?.label ? await readOrgKey(orgMeta.label).catch(() => undefined) : undefined
    const orgReady = Boolean(orgKey?.key)
    // pod 名 → { agents, max_agents }：来自只读探测 `GET /api/v1/org/pods`。
    // 探测失败 ⇒ 空表 ⇒ 面板显示"—"，**不把"未知"画成"零"**。
    const podStats = new Map<string, { agents: number | null; max: number | null }>()
    if (orgReady) {
      const pods = await deps.api
        .orgListPods(orgMeta?.api_url || defaultApiUrl(), orgKey!.key)
        .catch(() => [])
      for (const pod of pods) {
        podStats.set(pod.pod_label, {
          agents: typeof pod.agents === 'number' ? pod.agents : null,
          max: typeof pod.max_agents === 'number' ? pod.max_agents : null,
        })
      }
    }
    const podFor = (workspace: CurrentWorkspace, address: string | null, domain: string | null): PodStateView => {
      const custom = Boolean(state.org?.pod_labels?.[workspace.key])
      const label = custom ? state.org!.pod_labels![workspace.key]! : deps.derivePodLabel(workspace)
      const stats = podStats.get(label)
      return {
        state: address ? 'ready' : (orgReady ? 'pod_closed' : 'unconfigured'),
        pod_label: label,
        custom,
        domain,
        agents: stats?.agents ?? null,
        max_agents: stats?.max ?? null,
      }
    }

    /**
     * 一条记录的健康判断（只读）。
     *
     * 两类问题**必须被标出来**，因为从地址本身看不出来：
     *   ① **僵尸**：`path` 已不存在（仓库搬走了，记录还留着）；
     *   ② **重复**：两条记录指向同一个地址 —— 我 09-30 修信箱时就制造过一条
     *      （`dsh-42b65c` 与 `dsh-c3330f` 撞到了 `dsh@dsh.ice.msg9.io`）。
     *
     * `removable` 的判据：**移除它不会让某个地址失去唯一的持有者**。
     * 否则那个信箱就没人管了（游标、转发、key 都在记录里）。
     */
    const addressCount = new Map<string, number>()
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      const resolved = resolvedByKey.get(key)
      const addr = resolved?.address ?? inbox.address ?? null
      if (addr) addressCount.set(addr, (addressCount.get(addr) ?? 0) + 1)
    }
    const healthFor = (address: string | null, path: string): WorkspaceHealth => {
      const pathMissing = Boolean(path) && !existsSync(path)
      const dupCount = address ? (addressCount.get(address) ?? 0) : 0
      const duplicateOf = address && dupCount > 1 ? address : null
      // 该地址只有它一个持有者 ⇒ 移除会孤立这个信箱 —— 除非它本来就是僵尸
      // （目录都没了，那条记录已无实际用途，留着才是问题）。
      const soleHolder = Boolean(address) && dupCount === 1
      const removable = !soleHolder || pathMissing
      return {
        pathMissing,
        duplicateOf,
        removable,
        ...(removable ? {} : {
          reason: L(
            '这是地址 {address} 的唯一记录，移除后该信箱将不再被管理。',
            'This is the only record for {address}; removing it leaves that inbox unmanaged.',
            { address: address ?? '' },
          ),
        }),
      }
    }

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
        pod: podFor(workspace, null, null),
        health: healthFor(null, workspace.path),
      })
    }
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      const existing = rows.get(key)
      const resolved = resolvedByKey.get(key)
      const address = resolved?.address ?? null
      // Legacy = provisioned under a previous tenant: the address lives
      // outside the current tenant domain and should be migrated.
      const legacy = Boolean(resolved && tenantMode && address && !address.endsWith(`@${domain}`))
      const title = inbox.title || existing?.title || key
      const path = inbox.path || existing?.path || ''
      rows.set(key, {
        key,
        title,
        path,
        address,
        planned_address: resolved
          ? (legacy ? planned({ key, title, path }) : null)
          : (existing?.planned_address ?? null),
        provisioned: Boolean(resolved),
        legacy,
        cursor: inbox.cursor ?? null,
        current: key === currentKey,
        // 已开通 ⇒ ready；pod 域取地址里 `@` 之后那一段（真实值，不是推导值）。
        pod: podFor({ key, title, path }, address, address ? address.slice(address.indexOf('@') + 1) : null),
        pod_domain: address ? address.slice(address.indexOf('@') + 1) : null,
        health: healthFor(address, path),
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
    const resolved = await resolveVia(deps, key)
    if (resolved) {
      return {
        workspace: { key, title: resolved.title, path: resolved.path },
        inbox: resolved.signing_seed ? resolved : await ensureSigningKey(resolved, deps.log),
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
      const tenantMode = Boolean(owner?.api_key && isTenantOwner(owner))
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
      org: await orgView(),
      api_url: owner?.api_url || apiUrl,
      state_file: deps.stateFilePath(),
      // 在 workspaceViews 之后取：解析过程可能刚完成惰性迁移。
      credentials_migrated: await credentialsMigrated(),
      current: workspaces.find((row) => row.current) ?? null,
      workspaces,
    }
  }

  /**
   * ORG 绑定的只读视图。**不返回 key 本体**，只给打码形式，
   * 让用户能确认"绑的是哪把"。
   *
   * pod_count 用**只读探测**拿（列 pod）；探测失败**不让 overview 失败** ——
   * 面板仍要能显示"已绑定 ORG"，只是数量未知（否则一次网络抖动会让整个设置页报错）。
   */
  async function orgView(): Promise<OverviewView['org']> {
    const state = await deps.loadState()
    const meta = state.org
    if (!meta?.label) return null
    const resolved = await readOrgKey(meta.label).catch(() => undefined)
    let podCount: number | null = null
    if (resolved?.key) {
      podCount = await deps.api
        .orgListPods(meta.api_url || defaultApiUrl(), resolved.key)
        .then((pods) => pods.length)
        .catch(() => null)
    }
    return {
      label: meta.label,
      id: meta.id ?? null,
      name: meta.name ?? null,
      masked: resolved?.key ? maskKey(resolved.key) : '—',
      verified_at: meta.verified_at ?? null,
      pod_count: podCount,
    }
  }

  async function peers(signal: AbortSignal): Promise<{ address: string; title: string | null; path: string | null; local: boolean }[]> {
    const state = await deps.loadState()
    const localByAddress = new Map<string, LiveInbox>()
    await Promise.all(Object.keys(state.workspaces).map(async (key) => {
      const resolved = await resolveVia(deps, key)
      if (resolved) localByAddress.set(resolved.address, resolved)
    }))
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
    return [...localByAddress.values()].map((inbox) => ({
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

    // The watcher daemon's push channel: loopback (the generic trust gate)
    // plus the per-boot deliver token the daemon learned at /register. 409
    // means "no live session" and the daemon parks the batch for redelivery.
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/deliver`) {
      const presented = req.headers['x-msg9-daemon-token']
      const expected = deps.deliver?.token()
      if (!deps.deliver || !expected || typeof presented !== 'string' || !tokenMatches(expected, presented)) {
        throw new BridgeError(401, 'bad-daemon-token', 'a valid daemon delivery token is required')
      }
      const body = await readJsonBody(req)
      const projectKey = str(body.project_key)
      const messages = Array.isArray(body.messages) ? (body.messages as InboxMessage[]) : undefined
      const mode = body.mode === 'followup' || body.mode === 'inject' ? body.mode : undefined
      if (!projectKey || !messages || !mode) {
        throw new BridgeError(400, 'invalid-delivery', 'fields "project_key", "messages" and "mode" (followup|inject) are required')
      }
      return ok(res, await deps.deliver.handle({
        inbox: str(body.inbox) ?? '',
        project_key: projectKey,
        messages,
        mode,
        ...(body.downgraded === true ? { downgraded: true } : {}),
      }))
    }

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
      await saveOwner({ api_key: ownerKey, api_url: apiUrl, id, name, slug, mail_domain: mailDomain, address_domain: addressDomain })
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
      const existing = await resolveVia(deps, key)
      if (!existing) throw new BridgeError(404, 'unknown-workspace', `no inbox is registered as "${key}"`)
      const workspace = deps.listWorkspaces().find((row) => row.key === key)
        ?? { key, title: existing.title, path: existing.path }
      const preferred = str(body.preferred_address)
      if (preferred && !isValidLocalPart(preferred)) {
        throw new BridgeError(400, 'invalid-address', `"${preferred}" is not a valid msg9 local part (3-30 chars, a-z0-9-_ inside)`)
      }
      const result = await migrateInbox(workspace, existing, str(body.old_owner_key), preferred || undefined)
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
      const preferred = str(body.preferred_address)
      if (preferred && !isValidLocalPart(preferred)) {
        throw new BridgeError(400, 'invalid-address', `"${preferred}" is not a valid msg9 local part (3-30 chars, a-z0-9-_ inside)`)
      }
      const { inbox, provisioned } = await deps.ensureInbox(
        title ? { ...workspace, title } : workspace,
        signal,
        preferred || undefined,
      )
      if (provisioned) invalidateUnreadCache()
      return ok(res, { key: workspace.key, address: inbox.address, provisioned })
    }

    // ------------------------------------------------------------ ORG 级
    //
    // 主人 2026-09-30 定的形态：设置里填 ORG key；**默认不开 Pod**；
    // 手工点「开启」才走 ORG → Pod → Agent 这条链。

    // 绑定 ORG key：**label 由服务端读取，不由用户输入**。
    //
    // 规范 `address-format.md` §2：ORG label「**不可变**」，且与顶层租户 slug
    // 共享命名空间 —— 它在 msg9 上建 ORG 时就定了。让用户手填会填错，
    // 进而算出错的 pod 域名（`<pod>.<填错的 label>.<base>`）。
    // 所以这里只收 key，label 从 `GET /api/v1/org` 读回来。
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/org`) {
      const body = await readJsonBody(req)
      const orgKey = str(body.org_key)
      if (!orgKey) throw new BridgeError(400, 'missing-org-key', 'field "org_key" is required')
      const apiUrl = (str(body.api_url) || defaultApiUrl()).replace(/\/+$/, '')
      // 校验 + 取元数据：只读端点，绝不拿写接口试形状（本机误建过 probe-x）
      let info: OrgInfo
      try {
        info = await deps.api.orgInfo(apiUrl, orgKey, signal)
      } catch (error) {
        throw new BridgeError(
          400,
          'org-key-rejected',
          `ORG key 校验失败（${(error as Error)?.message ?? String(error)}）。`
          + '请确认它是 msg9_ok_… 开头的 ORG key。',
        )
      }
      // 顺带数一下该 ORG 下已有多少 pod（只读；失败不影响绑定）
      const podCount = await deps.api
        .orgListPods(apiUrl, orgKey, signal)
        .then((pods) => pods.length)
        .catch(() => null)
      await writeOrgKey(info.label, orgKey)
      await deps.updateState((state) => {
        state.org = {
          label: info.label,
          id: info.id,
          ...(info.name ? { name: info.name } : {}),
          api_url: apiUrl,
          verified_at: new Date().toISOString(),
          ...(str(body.pod_label) ? { pod_label: str(body.pod_label) } : {}),
        }
      })
      invalidateUnreadCache()
      return ok(res, {
        label: info.label,
        id: info.id,
        name: info.name ?? null,
        domain: info.domain ?? null,
        api_url: apiUrl,
        pod_count: podCount,
      })
    }

    // 开启 Pod（幂等）：ORG → Pod → Agent key。**这是本方案唯一的写路径。**
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/open-pod`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      const cwd = str(body.cwd)
      const state = await deps.loadState()
      const known = key ? state.workspaces[key] : undefined
      const workspace = (key ? deps.listWorkspaces().find((row) => row.key === key) : undefined)
        ?? (key && known ? { key, title: known.title, path: known.path } : undefined)
        ?? deps.matchWorkspaceByPath(cwd)
      if (!workspace) throw new BridgeError(400, 'missing-workspace', 'field "key" (workspace) or "cwd" is required')
      const preferredLabel = str(body.pod_label)
      const result = await deps.openPod(workspace, preferredLabel ? { podLabel: preferredLabel } : undefined)
      invalidateUnreadCache()
      return ok(res, { key: workspace.key, ...result })
    }

    // 移除**本地记录**（僵尸 / 重复条目）。
    //
    // 🔴 这个端点【只动本地】：删凭据文件 + state 里那条 workspace 记录。
    //    **不调用任何远端接口** —— 不 disable、不 purge、不删信。
    //    "收回本地引用"与"注销身份"是两件事，这里只做前者（后者是不可逆的对外动作）。
    //
    // 安全判断在这里**再判一次**（不信客户端）：如果它是该地址唯一的持有者，
    // 就拒绝 —— 否则那个信箱会失去管理（游标、转发、key 都在记录里）。
    // 例外：目录已经不存在的僵尸记录允许移除（它已无实际用途，留着才是问题）。
    if (method === 'POST' && path === `${BRIDGE_PREFIX}/remove-workspace`) {
      const body = await readJsonBody(req)
      const key = str(body.key)
      if (!key) throw new BridgeError(400, 'missing-workspace', 'field "key" is required')
      const state = await deps.loadState()
      const inbox = state.workspaces[key]
      if (!inbox) throw new BridgeError(404, 'unknown-workspace', `no workspace record is registered as "${key}"`)

      // 数一下这个地址还有几条记录（必须与 overview 用同一算法）
      const selfAddress = (await resolveVia(deps, key))?.address ?? inbox.address ?? null
      const holders = selfAddress
        ? (await Promise.all(Object.keys(state.workspaces).map(async (k) => ({
            k, address: (await resolveVia(deps, k))?.address ?? state.workspaces[k]?.address ?? null,
          })))).filter((row) => row.address === selfAddress)
        : []
      const pathMissing = Boolean(inbox.path) && !existsSync(inbox.path)
      if (holders.length <= 1 && !pathMissing) {
        throw new BridgeError(
          409,
          'sole-holder',
          L(
            '"{key}" 是地址 {address} 的唯一记录，移除后该信箱将不再被管理；已拒绝。',
            '"{key}" is the only record for {address}; removing it would leave that inbox unmanaged.',
            { key, address: selfAddress ?? '' },
          ),
        )
      }

      const removedFiles = inbox.project_key
        ? await removeProjectCredentials(inbox.project_key)
        : []
      await deleteWorkspaceInbox(key)
      invalidateUnreadCache()
      deps.log(`msg9: removed local record ${key} (${removedFiles.length} credential file(s))`)
      return ok(res, {
        key,
        address: selfAddress,
        removed_files: removedFiles,
        // 明确回给界面：远端什么都没动
        remote_untouched: true,
      })
    }

    // 开通状态（只读；面板据此决定显示"未配置"/"未开启"/"已开通"）
    if (method === 'GET' && path === `${BRIDGE_PREFIX}/pod-state`) {
      const url2 = new URL(req.url ?? '/', 'http://localhost')
      const cwd = url2.searchParams.get('cwd') ?? undefined
      const key = url2.searchParams.get('key') ?? undefined
      const state = await deps.loadState()
      const known = key ? state.workspaces[key] : undefined
      const workspace = (key ? deps.listWorkspaces().find((row) => row.key === key) : undefined)
        ?? (key && known ? { key, title: known.title, path: known.path } : undefined)
        ?? deps.matchWorkspaceByPath(cwd)
      if (!workspace) throw new BridgeError(400, 'missing-workspace', 'query "key" or "cwd" is required')
      return ok(res, {
        key: workspace.key,
        state: await deps.podState(workspace),
        planned_pod_label: deps.derivePodLabel(workspace),
        org: state.org ? { label: state.org.label, name: state.org.name ?? null } : null,
      })
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
