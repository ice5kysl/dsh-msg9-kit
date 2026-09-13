/**
 * Browser-side client of the local `/dsh-msg9/*` bridge.
 *
 * The page never holds a msg9 key: every call is same-origin HTTP against the
 * dsh web server, which performs the msg9 request with the keys in the plugin's
 * state file.
 *
 * @module dsh-msg9-kit/client-api
 */

import type {
  AccountAgentView,
  ContactRow,
  DirectoryView,
  FolderName,
  GroupRow,
  MessageRow,
  MessagesView,
  MigrateResult,
  OutboxView,
  OverviewView,
  OwnerView,
  PeerRow,
  UnreadView,
} from '../shared/types.ts'

import { L } from './locale.ts'

/** A failure reported by the bridge (or the transport). */
export class BridgeApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = 'BridgeApiError'
  }
}

export interface SendInput {
  key: string
  to: string
  text: string
  subject?: string
  /** Precise close of the original message (its id) — always set on replies. */
  reply_to?: string
  /** Threads the conversation (does NOT reliably close the original). */
  correlation_id?: string
  /** Caller-generated key, reused across retries of the same user intent. */
  idempotency_key?: string
}

export interface AddContactInput {
  key: string
  contact: string
  alias?: string
  notes?: string
}

/** The `/dsh-msg9` calls the panel makes. */
export interface BridgeClient {
  overview(cwd: string | undefined, signal?: AbortSignal): Promise<OverviewView>
  messages(
    key: string,
    query: { folder?: FolderName; limit?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<MessagesView>
  outbox(key: string, query: { limit?: number; offset?: number }, signal?: AbortSignal): Promise<OutboxView>
  contacts(key: string, signal?: AbortSignal): Promise<{ contacts: ContactRow[]; total: number }>
  /** Groups the workspace inbox belongs to (v1.19). */
  groups(key: string, signal?: AbortSignal): Promise<{ groups: GroupRow[]; total: number }>
  groupDetail(key: string, address: string, signal?: AbortSignal): Promise<{ group: GroupRow }>
  /** Group archive (the「群组」tab's right column). */
  groupMessages(key: string, address: string, query: { limit?: number; offset?: number }, signal?: AbortSignal): Promise<{ messages: MessageRow[]; total: number }>
  addContact(input: AddContactInput, signal?: AbortSignal): Promise<{ contact: ContactRow }>
  removeContact(key: string, address: string, signal?: AbortSignal): Promise<{ removed: string }>
  send(input: SendInput, signal?: AbortSignal): Promise<{ message_id: string; status: string; from: string }>
  markRead(key: string, messageId: string, signal?: AbortSignal): Promise<{ message_id: string; read: boolean }>
  /** Explicit "handled" from the panel (processed_by: human). */
  markDone(key: string, messageId: string, signal?: AbortSignal): Promise<{ message_id: string; processed: boolean }>
  peers(signal?: AbortSignal): Promise<{ peers: PeerRow[] }>
  /** The notification mute state (panel bell). */
  notifyStatus(signal?: AbortSignal): Promise<{ paused: boolean }>
  setNotifyPaused(paused: boolean, signal?: AbortSignal): Promise<{ paused: boolean }>
  /** 「我的租户网络」: every agent of every owner on this account (v1.10). */
  accountAgents(signal?: AbortSignal): Promise<{ agents: AccountAgentView[]; total: number }>
  /** The public yellow pages (all tenants), for the「广场」tab. q / capability filter server-side. */
  directory(
    query: { limit?: number; offset?: number; q?: string; capability?: string },
    signal?: AbortSignal,
  ): Promise<DirectoryView>
  unread(signal?: AbortSignal): Promise<UnreadView>
  provision(
    input: { key?: string; cwd?: string; title?: string },
    signal?: AbortSignal,
  ): Promise<{ key: string; address: string; provisioned: boolean }>
  /** Re-provision a legacy inbox under the current tenant (and optionally suspend the old one). */
  migrate(
    input: { key: string; old_owner_key?: string },
    signal?: AbortSignal,
  ): Promise<MigrateResult>
  /** Bind this dsh instance to a msg9 tenant (owner key), validated server-side. */
  setup(
    input: { owner_key: string; api_url?: string },
    signal?: AbortSignal,
  ): Promise<{ owner: OwnerView; api_url: string }>
  resolve(address: string, signal?: AbortSignal): Promise<{ record: Record<string, unknown> }>
}

export interface BridgeOptions {
  /** Bridge prefix; defaults to the host route `/dsh-msg9`. */
  base?: string
  /** Transport override (tests inject a fake). */
  fetch?: typeof fetch
}

/** Build the bridge client. */
export function createBridge(options: BridgeOptions = {}): BridgeClient {
  const base = (options.base ?? '/dsh-msg9').replace(/\/+$/, '')
  const doFetch: typeof fetch = options.fetch ?? ((...args) => fetch(...args))

  /** JSON body carried by our own calls (serialized here). */
  interface CallOptions {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    signal?: AbortSignal
  }

  async function request<T>(path: string, options: CallOptions = {}): Promise<T> {
    // A hung bridge must not wedge the panel (busy flags stuck, polls stacking):
    // fail after 20s even when the caller passed no signal.
    const timeout = AbortSignal.timeout(20_000)
    const signal = options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, timeout])
      : timeout
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.headers ?? {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal,
    }
    let response: Response
    try {
      response = await doFetch(`${base}${path}`, init)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new BridgeApiError('timeout', 0, L('请求超时，请重试。', 'Request timed out, please retry.'))
      }
      throw error
    }

    const text = await response.text()
    let parsed: { ok?: boolean; data?: T; error?: { code?: string; message?: string } } | undefined
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }

    if (!response.ok || parsed?.ok === false) {
      const code = parsed?.error?.code ?? `http-${response.status}`
      const message = parsed?.error?.message ?? (text || response.statusText)
      throw new BridgeApiError(code, response.status, message)
    }
    return (parsed?.data ?? (undefined as unknown)) as T
  }

  const query = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value))
    }
    const text = search.toString()
    return text ? `?${text}` : ''
  }

  return {
    overview: (cwd, signal) => request<OverviewView>(`/overview${query({ cwd })}`, { signal }),
    messages: (key, q, signal) => request<MessagesView>(
      `/messages${query({ key, folder: q.folder, limit: q.limit, offset: q.offset })}`,
      { signal },
    ),
    outbox: (key, q, signal) => request<OutboxView>(`/outbox${query({ key, limit: q.limit, offset: q.offset })}`, { signal }),
    contacts: (key, signal) => request<{ contacts: ContactRow[]; total: number }>(`/contacts${query({ key })}`, { signal }),
    groups: (key, signal) => request<{ groups: GroupRow[]; total: number }>(`/groups${query({ key })}`, { signal }),
    groupDetail: (key, address, signal) => request<{ group: GroupRow }>(`/groups${query({ key, address })}`, { signal }),
    groupMessages: (key, address, q, signal) => request<{ messages: MessageRow[]; total: number }>(
      `/groups/messages${query({ key, address, limit: q.limit, offset: q.offset })}`,
      { signal },
    ),
    addContact: (input, signal) => request<{ contact: ContactRow }>('/contacts', { method: 'POST', body: input, signal }),
    removeContact: (key, address, signal) => request<{ removed: string }>(
      `/contacts${query({ key, address })}`,
      { method: 'DELETE', signal },
    ),
    send: (input, signal) => request<{ message_id: string; status: string; from: string }>(
      '/send',
      { method: 'POST', body: input, signal },
    ),
    markRead: (key, messageId, signal) => request<{ message_id: string; read: boolean }>(
      '/read',
      { method: 'POST', body: { key, message_id: messageId }, signal },
    ),
    markDone: (key, messageId, signal) => request<{ message_id: string; processed: boolean }>(
      '/done',
      { method: 'POST', body: { key, message_id: messageId }, signal },
    ),
    peers: (signal) => request<{ peers: PeerRow[] }>('/peers', { signal }),
    notifyStatus: (signal) => request<{ paused: boolean }>('/notify', { signal }),
    setNotifyPaused: (paused, signal) => request<{ paused: boolean }>('/notify', { method: 'POST', body: { paused }, signal }),
    accountAgents: (signal) => request<{ agents: AccountAgentView[]; total: number }>('/account/agents', { signal }),
    directory: (q, signal) => request<DirectoryView>(
      `/directory${query({ limit: q.limit, offset: q.offset, q: q.q, capability: q.capability })}`,
      { signal },
    ),
    unread: (signal) => request<UnreadView>('/unread', { signal }),
    provision: (input, signal) => request<{ key: string; address: string; provisioned: boolean }>(
      '/provision',
      { method: 'POST', body: input, signal },
    ),
    migrate: (input, signal) => request<MigrateResult>(
      '/migrate',
      { method: 'POST', body: input, signal },
    ),
    setup: (input, signal) => request<{ owner: OwnerView; api_url: string }>(
      '/setup',
      { method: 'POST', body: input, signal },
    ),
    resolve: (address, signal) => request<{ record: Record<string, unknown> }>(
      '/resolve',
      { method: 'POST', body: { address }, signal },
    ),
  }
}

/** True for the errors a caller can show verbatim. */
export function isBridgeError(error: unknown): error is BridgeApiError {
  return error instanceof BridgeApiError
}

/** One-line text of any thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export type { MessageRow }
