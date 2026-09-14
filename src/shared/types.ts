/**
 * Wire types shared by the two faces of dsh-msg9-kit.
 *
 * The browser never talks to msg9 directly: it calls the local `/dsh-msg9/*`
 * bridge, and these are the shapes that cross that boundary. Types only — no
 * runtime code, so importing them from the browser bundle costs nothing.
 *
 * @module dsh-msg9-kit/types
 */

/** One workspace row of the tenant table (never carries a key). */
export interface WorkspaceView {
  key: string
  title: string
  path: string
  address: string | null
  /** The address provisioning would assign (host-derived), null once open —
   * except on legacy rows, where it previews the migration target. */
  planned_address?: string | null
  provisioned: boolean
  /** Provisioned under a previous tenant (address outside the current domain). */
  legacy?: boolean
  cursor: string | null
  current: boolean
}

/** The msg9 owner (tenant) behind this dsh instance. */
export interface OwnerView {
  name: string | null
  id: string | null
  /** Display-only masked form of the owner key. */
  masked: string
  /** Tenant subdomain (`<agent>@<slug>.msg9.io`); null = flat namespace. */
  slug?: string | null
  /** Mail domain reported by the server. */
  mail_domain?: string | null
  /** The pod's real address domain (v1.22+ ORG model), wins over slug-derived. */
  address_domain?: string | null
}

/** `GET /dsh-msg9/overview` payload. */
export interface OverviewView {
  owner: OwnerView | null
  api_url: string
  state_file: string
  /** state.json 已无任何明文凭据（全部迁入 ~/.msg9 凭据仓）。 */
  credentials_migrated?: boolean
  current: WorkspaceView | null
  workspaces: WorkspaceView[]
}

/** One message, as msg9 returns it (inbox and outbox share the shape). */
export interface MessageRow {
  id?: string
  message_id: string
  from_address: string
  to_address?: string
  subject?: string
  body?: { text?: string } | Record<string, unknown>
  folder?: string
  read_at?: string
  /** Local attribution: who marked it read (the server can't tell). */
  read_by?: 'human' | 'agent'
  /** Local closed-loop mark: replied or explicitly done. */
  processed_by?: 'human' | 'agent'
  processed_at?: string
  /** v1.3 identity: server-side signature verification of this message. */
  signature?: string
  verified?: boolean
  key_id?: string
  /** v1.19 groups: this copy came via a group (reply-all routes here). */
  list_address?: string
  group_copy?: boolean
  correlation_id?: string
  /** The message this one answers (its message_id); how the archive's reply
   *  tree is built. May point at ANY fan-out copy of the parent letter. */
  reply_to?: string
  created_at?: string
}

/** One address-book entry (msg9's own contact record). */
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

/** One sibling inbox of this dsh instance. */
export interface PeerRow {
  address: string
  title: string | null
  /** Workspace directory when the inbox is registered on this machine. */
  path?: string | null
  local: boolean
  /** Yellow-pages profile from the msg9 directory (v1.5), when published. */
  display_name?: string | null
  description?: string | null
  capabilities?: string[]
}

/** `GET /dsh-msg9/messages` payload. */
export interface MessagesView {
  workspace: { key: string; title: string; address: string }
  messages: MessageRow[]
  total: number
  unread_count: number
  next_cursor: string | null
}

/** `GET /dsh-msg9/outbox` payload. */
export interface OutboxView {
  workspace: { key: string; title: string; address: string }
  messages: MessageRow[]
  total: number
}

/** `GET /dsh-msg9/unread` payload. */
export interface UnreadView {
  total: number
  byKey: Record<string, number>
  /** Mailbox size per workspace (all folders), for the settings inventory. */
  totalByKey?: Record<string, number>
}

/** One public agent of the msg9 directory (the「广场」listing). */
export interface DirectoryAgentRow {
  address: string
  display_name?: string | null
  description?: string | null
  capabilities?: string[]
  links?: Record<string, string>
  created_at?: string
}

/** `GET /dsh-msg9/directory` payload. */
export interface DirectoryView {
  agents: DirectoryAgentRow[]
  total: number
}

/** `POST /dsh-msg9/migrate` payload. */
export interface MigrateResult {
  key: string
  old_address: string
  new_address: string
  old_disabled: boolean
  /** v1.9: the old address forwards into the new mailbox. */
  forwarding: boolean
  /** v1.8: history moved over (same-tenant only; null when not attempted). */
  moved_mail: number | null
  note?: string
}

/** One agent of the account-wide tenant network (every owner of this account). */
export interface AccountAgentView {
  owner_id: string
  owner_name: string
  /** null for slug-less tenants (their addresses live on msg9.io). */
  owner_slug: string | null
  address_domain: string
  address: string
  status: string
  display_name?: string | null
  description?: string | null
  capabilities?: string[]
}

/** One group (v1.19) the workspace inbox belongs to. */
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

/** Inbox folders msg9 accepts (processed/unprocessed are v1.13 derived filters). */
export type FolderName = 'all' | 'unread' | 'read' | 'processed' | 'unprocessed'
