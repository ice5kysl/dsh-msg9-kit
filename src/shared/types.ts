/**
 * Wire types shared by the two faces of dsh-msg9-kit.
 *
 * The browser never talks to msg9 directly: it calls the local `/dsh-msg9/*`
 * bridge, and these are the shapes that cross that boundary. Types only — no
 * runtime code, so importing them from the browser bundle costs nothing.
 *
 * @module dsh-msg9-kit/types
 */

/** workspace 维度的开通状态（主人 2026-09-30 的三态模型）。 */
export type PodState = 'unconfigured' | 'pod_closed' | 'ready'

export interface PodStateView {
  state: PodState
  /** 将要用 / 正在用的 pod label（可能就是用户改过的那个）。 */
  pod_label: string
  /** 是否已被人工显式指定（面板据此显示「已自定义」并可恢复默认）。 */
  custom: boolean
  /** 已开 Pod 时的地址域（如 `dsh.ice.msg9.io`）。 */
  domain?: string | null
  /**
   * 该 pod 下**已开**的 agent（信箱）数。
   * 来源：ORG 只读探测 `GET /api/v1/org/pods` 的 `agents` 字段。
   * `null` = 没探到 —— 面板显示"—"而不是 0（**别把"未知"画成"零"**）。
   */
  agents?: number | null
  /** 该 pod 的 agent 上限（`max_agents`）。 */
  max_agents?: number | null
  /**
   * 按 workspace 推导出的「候选 pod」（标题/目录名派生的那个）。
   * 只在**与现址所在 pod 不同**时才有值 —— 用来回答"它开在自己的 pod 里吗"。
   * 注意：候选名 ≠ "就应该叫这个"，它只是一个对照基准。
   */
  suggested_label?: string
  /** 上述候选 pod 是否**已存在**于 ORG（已存在却空着，常是"本该开在这儿"的强信号）。 */
  suggested_exists?: boolean
  /**
   * 那个"应有 pod"的名字**是否有语义**。
   * `false` = 名字是 `ws-89fa` 这种纯 hash（中文标题无法生成合法 ASCII pod 名），
   * 界面据此把"名字本来就没法取"和"名字好好的却开错了"分开说。
   */
  suggested_meaningful?: boolean
  /**
   * 现址是否是 pod 形态（`<agent>@<pod>.<org>.<base>`）。
   * `false` = 扁平域 / ORG 的 Default Pod ⇒ 没有 pod 归属。只在已开通时有值。
   */
  pod_form?: boolean
  /**
   * 现址所在的那个 pod **是否存在于 ORG**。
   * 只在"ORG 探测成功"时才有值（探测失败给 undefined，**不把"未知"当"不存在"**）。
   */
  pod_exists?: boolean
}

/**
 * 一条 workspace 记录的**健康判断**（只读推导；面板据此标注，并允许人工移除）。
 *
 * 为什么要它：`~/.msg9/projects/` 是**多项目共用**的，一条记录可能因为
 * 「仓库搬走了」或「两个 workspace 撞到同一地址」而变成僵尸/冲突 ——
 * **而这些从地址本身看不出来**，必须由程序判断，不能靠人记得。
 */
export interface WorkspaceHealth {
  /** 目录已不存在（记录指向一个被搬走/删除的路径）。 */
  pathMissing: boolean
  /** 与另一条记录共用同一个地址（两条都指向同一个信箱）。 */
  duplicateOf?: string | null
  /** 移除这条记录是否安全。`false` = 它是该地址唯一的持有者（移除会孤立信箱）。 */
  removable: boolean
  /** 不可移除的原因（给用户看的一句话）。 */
  reason?: string
}

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
  /**
   * 开通状态：`unconfigured` 没有 ORG key · `pod_closed` 有 ORG key 但未开 Pod（默认）·
   * `ready` 已开通。面板据此决定那一行显示「开通」按钮还是地址。
   */
  pod?: PodStateView
  /** 该 pod 的地址域（已开 Pod 时）；未开时为 null。 */
  pod_domain?: string | null
  /** 这条记录的健康判断（僵尸 / 重复 / 可否移除）。 */
  health?: WorkspaceHealth
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
  /**
   * ORG 绑定（主人 2026-09-30 的形态）：填 ORG key → 默认不开 Pod → 手工开通。
   * `null` = 还没绑 ORG key（面板显示"引导录入"态）。
   */
  org: OrgView | null
  api_url: string
  state_file: string
  /** state.json 已无任何明文凭据（全部迁入 ~/.msg9 凭据仓）。 */
  credentials_migrated?: boolean
  current: WorkspaceView | null
  workspaces: WorkspaceView[]
}

/** ORG 绑定的只读视图（**不含 key 本体**，只有打码形式）。 */
export interface OrgView {
  /** ORG label（地址里 `<org>` 那一段）。 */
  label: string
  /** ORG id（`org_…`）。 */
  id?: string | null
  name?: string | null
  /** 打码后的 ORG key（`msg9_ok_…`），用于确认"绑的是哪把"。 */
  masked: string
  /** 校验通过的时间。 */
  verified_at?: string | null
  /** 该 ORG 下现有的 pod 数（只读探测结果；探测失败为 null）。 */
  pod_count?: number | null
  /** 该 ORG 的 pod 上限（`max_pods`）；未知为 null。 */
  max_pods?: number | null
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
