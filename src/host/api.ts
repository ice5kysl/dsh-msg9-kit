/**
 * Minimal msg9.io HTTP client: L0 agent endpoints plus the L1 owner endpoints
 * used to provision one inbox per workspace (tenant = dsh instance).
 *
 * Uses the global `fetch` (node 20+).
 *
 * @module dsh-msg9-kit/api
 */

import { buildSignatureHeaders } from './signing.ts'

export class Msg9ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
    /** v1.17: seconds the server asks us to wait (429 `Retry-After`). */
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'Msg9ApiError'
  }
}

interface RequestOptions {
  method?: string
  apiKey?: string
  body?: unknown
  /** Exact pre-serialized body bytes (signed sends must hash the verbatim body). */
  rawBody?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Override the 30s safety net (long-poll endpoints need more). */
  timeoutMs?: number
}

/** Call a msg9 endpoint and unwrap the `{ code, message, data }` envelope. */
export async function msg9Request<T = any>(apiUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  const bodyText = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json'
  if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`

  // Never hang forever: even when the caller passes no signal, a wedged msg9
  // endpoint must fail the call instead of pinning the tool/bridge open.
  const timeoutMs = options.timeoutMs ?? 30_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([options.signal, timeout])
    : timeout
  let response: Response
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: bodyText,
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Msg9ApiError(0, undefined, `msg9 request timed out after ${Math.round(timeoutMs / 1000)}s (${options.method ?? 'GET'} ${path})`)
    }
    throw error
  }

  const text = await response.text()
  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new Msg9ApiError(
      response.status,
      parsed?.code,
      parsed?.message || text || response.statusText,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    )
  }

  return (parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed) as T
}

export interface RegisteredAgent {
  address: string
  api_key: string
  public_key?: string
  db9_instance_id?: string
  inbox_url?: string
}

/** The msg9 v1.5 agent profile (yellow pages), stored as metadata reserved keys. */
export interface AgentProfile {
  display_name?: string
  description?: string
  capabilities?: string[]
  links?: Record<string, string>
  visibility?: 'public' | 'unlisted'
}

export interface InboxMessage {
  id?: string
  message_id: string
  from_address: string
  to_address?: string
  subject?: string
  body?: { text?: string } | Record<string, unknown>
  folder?: string
  read_at?: string
  /** v1.13: self-reported attribution of who read / closed the message. */
  read_by?: string
  processed_at?: string
  processed_by?: string
  /** v1.3 identity: server-side signature verification result. */
  signature?: string
  verified?: boolean
  key_id?: string
  /** v1.19 groups: this copy came via a group (reply-all routes here). */
  list_address?: string
  group_copy?: boolean
  correlation_id?: string
  priority?: string
  created_at?: string
}

export interface InboxPage {
  messages: InboxMessage[]
  total?: number
  unread_count?: number
  next_cursor?: string
  has_more?: boolean
}

export interface SendResult {
  message_id: string
  status: string
}

export interface ProvisionError {
  address: string
  code: number
  message: string
}

export interface ProvisionResult {
  created: RegisteredAgent[]
  errors: ProvisionError[]
}

export interface OwnerAgentRow {
  id: string
  agent_address: string
  external_ref?: string
  profile?: AgentProfile
  created_at?: string
}

// ---------------------------------------------------------------- L0 (agent)

export function registerAgent(apiUrl: string, address: string, publicKey?: string, profile?: AgentProfile, signal?: AbortSignal): Promise<RegisteredAgent> {
  const body: Record<string, unknown> = { requested_address: address }
  if (publicKey) body.public_key = publicKey
  if (profile) body.profile = profile
  return msg9Request<RegisteredAgent>(apiUrl, '/api/v1/register', { method: 'POST', body, signal })
}

export function getMe(apiUrl: string, apiKey: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return msg9Request(apiUrl, '/api/v1/agent/me', { apiKey, signal })
}

export function sendMessage(
  apiUrl: string,
  apiKey: string,
  input: { to: string; subject?: string; text: string; correlationId?: string; replyTo?: string; idempotencyKey?: string },
  signal?: AbortSignal,
  signing?: { from: string; seedBase64: string },
): Promise<SendResult> {
  const idempotencyKey = input.idempotencyKey ?? `msg9-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  // Serialize ONCE: a signed send hashes the exact body bytes, so the string
  // hashed and the string sent must be the same string.
  const rawBody = JSON.stringify({
    to: input.to,
    subject: input.subject ?? '',
    body: { text: input.text },
    // reply_to closes the ORIGINAL message precisely (by its id);
    // correlation_id only threads — and auto-closes nothing when the original
    // never carried one (typical for cross-system mail).
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
  })
  const signatureHeaders = signing
    ? buildSignatureHeaders({
        from: signing.from,
        to: input.to,
        body: rawBody,
        seedBase64: signing.seedBase64,
        idempotencyKey,
      })
    : {}
  return msg9Request<SendResult>(apiUrl, '/api/v1/send', {
    method: 'POST',
    apiKey,
    signal,
    rawBody,
    headers: {
      'Idempotency-Key': idempotencyKey,
      ...signatureHeaders,
    },
  })
}

/**
 * v1.3 identity: install this agent's Ed25519 signing public key. First-time
 * installs need only API-key auth; rotations require a signature by the
 * current key (the plugin never rotates — it installs once at provisioning).
 */
export function setSigningKey(apiUrl: string, apiKey: string, signingPublicKey: string, signal?: AbortSignal): Promise<unknown> {
  return msg9Request(apiUrl, '/api/v1/agent/signing-key', {
    method: 'PUT',
    apiKey,
    body: { signing_public_key: signingPublicKey },
    signal,
  })
}

export function listInbox(
  apiUrl: string,
  apiKey: string,
  query: { folder?: string; limit?: number; offset?: number; since?: string },
  signal?: AbortSignal,
): Promise<InboxPage> {
  const params = new URLSearchParams()
  if (query.folder) params.set('folder', query.folder)
  params.set('limit', String(query.limit ?? 20))
  if (query.offset) params.set('offset', String(query.offset))
  if (query.since) params.set('since', query.since)
  return msg9Request<InboxPage>(apiUrl, `/api/v1/inbox/messages?${params.toString()}`, { apiKey, signal })
}

/**
 * One message by id with its FULL body (the list endpoints only carry previews
 * once rendered). Server route: `GET /api/v1/inbox/messages/:id`. Tolerates both
 * envelope shapes (`{message}` or the bare message) so a server-side tweak does
 * not break the read path.
 */
export async function getMessage(apiUrl: string, apiKey: string, messageId: string, signal?: AbortSignal): Promise<InboxMessage> {
  const raw = await msg9Request<any>(apiUrl, `/api/v1/inbox/messages/${encodeURIComponent(messageId)}`, { apiKey, signal })
  const message = raw && typeof raw === 'object' && 'message' in raw ? raw.message : raw
  if (!message || typeof message !== 'object' || !message.message_id) {
    throw new Msg9ApiError(0, undefined, `msg9 returned no message for ${messageId}`)
  }
  return message as InboxMessage
}

export function markRead(apiUrl: string, apiKey: string, messageId: string, by?: string, signal?: AbortSignal): Promise<unknown> {
  return msg9Request(apiUrl, `/api/v1/inbox/messages/${encodeURIComponent(messageId)}/read`, {
    method: 'POST',
    apiKey,
    // v1.13: `by` is a self-reported attribution tag (human/agent/auto); the
    // server records it but cannot verify it (panel and agent share one key).
    ...(by ? { body: { by } } : {}),
    signal,
  })
}

/** v1.13: close the loop on a message (processed implies read; first mark wins). */
export function markProcessed(apiUrl: string, apiKey: string, messageId: string, by?: string, signal?: AbortSignal): Promise<unknown> {
  return msg9Request(apiUrl, `/api/v1/inbox/messages/${encodeURIComponent(messageId)}/processed`, {
    method: 'POST',
    apiKey,
    ...(by ? { body: { by } } : {}),
    signal,
  })
}

/**
 * Long-poll for new mail (server v1.10): hangs up to `wait` seconds and
 * returns as soon as anything newer than `since` arrives. The client timeout
 * is padded well past the hang so the server gets to answer first.
 */
export function streamInbox(
  apiUrl: string,
  apiKey: string,
  query: { since?: string; wait?: number },
  signal?: AbortSignal,
): Promise<InboxPage> {
  const params = new URLSearchParams()
  if (query.since) params.set('since', query.since)
  const wait = Math.max(1, Math.min(query.wait ?? 25, 30))
  params.set('wait', String(wait))
  return msg9Request<InboxPage>(apiUrl, `/api/v1/inbox/stream?${params.toString()}`, {
    apiKey,
    signal,
    timeoutMs: (wait + 15) * 1000,
  })
}

export function resolveAddress(apiUrl: string, address: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return msg9Request(apiUrl, `/api/v1/resolve/${encodeURIComponent(address)}`, { signal })
}

/** A v1.9 forwarding rule: mail to this address is delivered to `target`. */
export interface ForwardingRule {
  address?: string
  target?: string
  notify_sender?: boolean
  [key: string]: unknown
}

/**
 * v1.9: forward THIS agent's mail to another address, with the agent's own
 * key. While the rule exists the address stays reserved (nobody can register
 * it and hijack delivery), and it outranks the live agent (this inbox stops
 * receiving). Survives the agent's later suspension.
 */
export function setForwarding(apiUrl: string, apiKey: string, target: string, notifySender = false, signal?: AbortSignal): Promise<ForwardingRule> {
  return msg9Request<ForwardingRule>(apiUrl, '/api/v1/agent/forwarding', {
    method: 'PUT',
    apiKey,
    body: { target, notify_sender: notifySender },
    signal,
  })
}

/** v1.9: stop forwarding this agent's mail (also releases the reservation). */
export function deleteForwarding(apiUrl: string, apiKey: string, signal?: AbortSignal): Promise<unknown> {
  return msg9Request(apiUrl, '/api/v1/agent/forwarding', { method: 'DELETE', apiKey, signal })
}

/** v1.19 groups: one group the caller is a member of. */
export interface GroupRow {
  address: string
  display_name?: string
  description?: string
  open?: boolean
  created_by?: string
  created_at?: string
  member_count?: number
  is_member?: boolean
  members?: string[]
}

/** Groups the caller is a member of (agent key). */
export function listGroups(apiUrl: string, apiKey: string, signal?: AbortSignal): Promise<{ groups: GroupRow[]; total: number }> {
  return msg9Request(apiUrl, '/api/v1/groups', { apiKey, signal })
}

/** Group detail incl. the member list (members only). */
export function getGroup(apiUrl: string, apiKey: string, address: string, signal?: AbortSignal): Promise<GroupRow> {
  return msg9Request(apiUrl, `/api/v1/groups/${encodeURIComponent(address)}`, { apiKey, signal })
}

/** Group archive: every copy ever fanned out to this group (members only). */
export function groupMessages(
  apiUrl: string,
  apiKey: string,
  address: string,
  query: { limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<{ messages: InboxMessage[]; total?: number }> {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 50))
  if (query.offset) params.set('offset', String(query.offset))
  return msg9Request(apiUrl, `/api/v1/groups/${encodeURIComponent(address)}/messages?${params.toString()}`, { apiKey, signal })
}

export interface DirectoryPage {
  agents?: { address: string; profile?: AgentProfile; created_at?: string }[]
  total?: number
}

/** The public yellow pages (v1.5): every agent published as `visibility: public`.
 *  v1.10: server-side `q` (substring over name/description) and `capability`
 *  (exact tag) filters; limit caps at 100. */
export function listDirectory(
  apiUrl: string,
  query: { limit?: number; offset?: number; q?: string; capability?: string },
  signal?: AbortSignal,
): Promise<DirectoryPage> {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 100))
  if (query.offset) params.set('offset', String(query.offset))
  if (query.q) params.set('q', query.q)
  if (query.capability) params.set('capability', query.capability)
  return msg9Request<DirectoryPage>(apiUrl, `/api/v1/directory?${params.toString()}`, { signal })
}

// ---------------------------------------------------------------- L1 (owner)

/** Who am I as an owner? Validates the owner key. */
export function ownerMe(apiUrl: string, ownerKey: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return msg9Request(apiUrl, '/api/v1/owner/me', { apiKey: ownerKey, signal })
}

/** Batch-provision agent inboxes under the owner (not subject to the IP register limit). */
export function ownerCreateAgents(
  apiUrl: string,
  ownerKey: string,
  addresses: string[],
  metadata?: Record<string, unknown>,
  profile?: AgentProfile,
  signal?: AbortSignal,
): Promise<ProvisionResult> {
  return msg9Request<ProvisionResult>(apiUrl, '/api/v1/owner/agents', {
    method: 'POST',
    apiKey: ownerKey,
    signal,
    body: { addresses, ...(metadata ? { metadata } : {}), ...(profile ? { profile } : {}) },
  })
}

/** List the owner's agent inboxes (sibling workspaces). */
export function ownerListAgents(
  apiUrl: string,
  ownerKey: string,
  offset = 0,
  limit = 100,
  signal?: AbortSignal,
): Promise<{ agents: OwnerAgentRow[]; total: number }> {
  return msg9Request(apiUrl, `/api/v1/owner/agents?offset=${offset}&limit=${limit}`, { apiKey: ownerKey, signal })
}

/** Rotate an owned agent's key (recovers from a lost local key). */
export function ownerRotateAgentKey(
  apiUrl: string,
  ownerKey: string,
  address: string,
  signal?: AbortSignal,
): Promise<{ api_key: string }> {
  return msg9Request(apiUrl, `/api/v1/owner/agents/${encodeURIComponent(address)}/rotate-key`, {
    method: 'POST',
    apiKey: ownerKey,
    signal,
  })
}

export interface MoveMailResult {
  moved?: number
  [key: string]: unknown
}

/** One row of the v1.10 account-level agent union ("my tenant network"). */
export interface AccountAgentRow {
  owner_id: string
  owner_name: string
  /** Omitted (not empty) for slug-less tenants — treat as undefined. */
  owner_slug?: string
  address_domain: string
  agent_address: string
  status: string
  profile?: AgentProfile
}

/**
 * v1.10: the union of agents across this tenant and every other tenant of the
 * same account (tenant key = account-level READ; no keys, no quota, no
 * messages in the projection). Live state, not a cache.
 */
export function ownerAccountAgents(
  apiUrl: string,
  ownerKey: string,
  offset = 0,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ agents: AccountAgentRow[]; total: number }> {
  return msg9Request(apiUrl, `/api/v1/owner/account/agents?offset=${offset}&limit=${limit}`, { apiKey: ownerKey, signal })
}

/**
 * v1.8: move an agent's RECEIVED mail to another agent of the SAME tenant
 * (folders preserved, move not copy, irreversible). Cross-tenant is a 403 by
 * design — callers should treat that as "history stays behind".
 */
export function ownerMoveMail(
  apiUrl: string,
  ownerKey: string,
  address: string,
  input: { to: string; dryRun?: boolean },
  signal?: AbortSignal,
): Promise<MoveMailResult> {
  return msg9Request<MoveMailResult>(apiUrl, `/api/v1/owner/agents/${encodeURIComponent(address)}/move-mail`, {
    method: 'POST',
    apiKey: ownerKey,
    body: { to: input.to, ...(input.dryRun ? { dry_run: true } : {}) },
    signal,
  })
}

/** Suspend an owned agent (tenant migration: decommission the old inbox). */
export function ownerDisableAgent(
  apiUrl: string,
  ownerKey: string,
  address: string,
  signal?: AbortSignal,
): Promise<{ status: string }> {
  return msg9Request(apiUrl, `/api/v1/owner/agents/${encodeURIComponent(address)}/disable`, {
    method: 'POST',
    apiKey: ownerKey,
    signal,
  })
}

// ------------------------------------------------------- sent + address book

export interface OutboxPage {
  messages: InboxMessage[]
  total?: number
}

/** Sent messages of the authenticated agent (msg9's own outbox). */
export function listOutbox(
  apiUrl: string,
  apiKey: string,
  query: { limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<OutboxPage> {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 20))
  params.set('offset', String(query.offset ?? 0))
  return msg9Request<OutboxPage>(apiUrl, `/api/v1/outbox/messages?${params.toString()}`, { apiKey, signal })
}

export interface ContactRow {
  id?: string
  owner?: string
  contact: string
  alias?: string
  notes?: string
  status?: string
  is_favorite?: boolean
  created_at?: string
  updated_at?: string
}

export interface ContactPage {
  contacts: ContactRow[]
  total: number
}

/** The agent's msg9 address book. */
export function listContacts(
  apiUrl: string,
  apiKey: string,
  query: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<ContactPage> {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 100))
  params.set('offset', String(query.offset ?? 0))
  return msg9Request<ContactPage>(apiUrl, `/api/v1/contacts?${params.toString()}`, { apiKey, signal })
}

/** Add an address-book entry (server-side msg9 contact). */
export function addContact(
  apiUrl: string,
  apiKey: string,
  input: { contact: string; alias?: string; notes?: string },
  signal?: AbortSignal,
): Promise<ContactRow> {
  return msg9Request<ContactRow>(apiUrl, '/api/v1/contacts', { method: 'POST', apiKey, signal, body: input })
}

/** Remove an address-book entry. */
export function deleteContact(
  apiUrl: string,
  apiKey: string,
  address: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return msg9Request(apiUrl, `/api/v1/contacts/${encodeURIComponent(address)}`, { method: 'DELETE', apiKey, signal })
}
