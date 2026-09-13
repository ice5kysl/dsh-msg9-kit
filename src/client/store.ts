/**
 * The msg9 panel's store: framework-free, testable, and the single place that
 * talks to the local bridge.
 *
 * Keeping every data operation here (instead of inside components) means the
 * panel, the sidebar badge and the tests all drive the same code path, and the
 * React layer stays a pure projection of `getState()`.
 *
 * @module dsh-msg9-kit/client-store
 */

import type {
  AccountAgentView,
  ContactRow,
  DirectoryAgentRow,
  FolderName,
  GroupRow,
  MessageRow,
  MessagesView,
  MigrateResult,
  OwnerView,
  PeerRow,
  WorkspaceView,
} from '../shared/types.ts'
import { createBridge, errorText, type BridgeClient, type BridgeOptions } from './api.ts'
import { L } from './locale.ts'

export type Tab = 'inbox' | 'outbox' | 'contacts' | 'groups' | 'square'

/** The server knows all/unread/read;「待处理」is a client-side filter on top of `all`. */
export type FolderFilter = FolderName | 'pending'

export interface ComposeState {
  to: string
  subject: string
  text: string
  /** The message being answered (its id) — closes it on send (回复即处理). */
  replyTo?: string
  /** The THREAD id, copied verbatim from the incoming message (never invented). */
  correlationId?: string
}

export interface Notice {
  kind: 'ok' | 'error'
  text: string
}

export interface Msg9State {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  notice: Notice | null
  /** Current session's directory; how the host finds the workspace. */
  cwd: string | null
  owner: OwnerView | null
  /** First-run tenant binding: until this is done the panel asks for the token. */
  setup: { busy: boolean; error: string | null; dismissed: boolean }
  apiUrl: string
  stateFile: string
  workspaces: WorkspaceView[]
  currentKey: string | null
  tab: Tab
  folder: FolderFilter
  messages: MessageRow[]
  messagesTotal: number
  unreadCount: number
  unreadByKey: Record<string, number>
  unreadTotal: number
  /** Mailbox size per workspace (all folders), for the settings inventory. */
  totalByKey: Record<string, number>
  outbox: MessageRow[]
  outboxTotal: number
  contacts: ContactRow[]
  contactsTotal: number
  peers: PeerRow[]
  /** 「我的租户网络」: agents of every owner on this account (v1.10). */
  accountAgents: AccountAgentView[]
  /** §28 (v1.27): the org the tenant network was projected from, when the server knows it. */
  accountOrg: { id: string | null; label: string | null } | null
  /** 「组」(v1.19): groups the selected workspace inbox belongs to. */
  groups: GroupRow[]
  /** Group selected in the middle column (its card shows on the right). */
  selectedGroup: string | null
  /** Detail of the selected group (member list included), once loaded. */
  groupDetail: GroupRow | null
  /** Archive of the selected group (the「群组」tab's right column). */
  groupArchive: MessageRow[]
  groupArchiveTotal: number
  /** Whether mail wake-ups are paused (the bell; badge keeps working). */
  notifyPaused: boolean
  /** The「广场」listing: public agents of every tenant. */
  directory: DirectoryAgentRow[]
  directoryTotal: number
  /** Server-side filters of the square listing. */
  directoryQuery: string
  directoryCapability: string | null
  /** Agent selected in the square's middle column (its card shows on the right). */
  selectedAgent: string | null
  selectedId: string | null
  /** Contact selected in the middle column (its detail shows on the right). */
  selectedContact: string | null
  /** Whether the detail column shows the composer instead of the selection. */
  composeOpen: boolean
  compose: ComposeState
  busy: {
    overview: boolean
    messages: boolean
    outbox: boolean
    contacts: boolean
    directory: boolean
    archive: boolean
    send: boolean
    action: boolean
  }
  loadedAt: number | null
}

export interface Msg9Store {
  getState(): Msg9State
  subscribe(listener: () => void): () => void
  /** Begin background polling (ref-counted). Returns a disposer. */
  start(): () => void
  setCwd(cwd: string | null): void
  setTab(tab: Tab): void
  setFolder(folder: FolderFilter): void
  selectWorkspace(key: string): void
  selectMessage(id: string | null): void
  selectContact(address: string | null): void
  selectAgent(address: string | null): void
  selectGroup(address: string | null): void
  refreshGroups(): Promise<void>
  /** Load (or append) the selected group's archive. */
  refreshGroupArchive(append?: boolean): Promise<void>
  /** Load the notification mute state (once per panel mount). */
  refreshNotifyStatus(): Promise<void>
  /** Toggle the notification mute (the bell). */
  toggleNotify(): Promise<void>
  /** Server-side square search: re-queries the directory with the new filters. */
  setDirectoryQuery(query: string): void
  setDirectoryCapability(capability: string | null): void
  /** Append the next page of the current square query. */
  loadMoreDirectory(): Promise<void>
  setCompose(patch: Partial<ComposeState>): void
  /** Open the composer in the detail column, optionally pre-filling fields. */
  openCompose(patch?: Partial<ComposeState>): void
  closeCompose(): void
  composeTo(address: string): void
  /** Reply to a message: To = list_address (groups) or the sender; reply_to
   * closes it; the thread's correlation_id rides verbatim when it has one. */
  replyTo(message: MessageRow): void
  /** Explicit "handled" from the panel: processed_by human, drops out of 待处理. */
  markDone(id: string): Promise<void>
  clearNotice(): void
  refreshOverview(): Promise<void>
  refreshInbox(): Promise<void>
  refreshOutbox(): Promise<void>
  refreshContacts(): Promise<void>
  refreshUnread(): Promise<void>
  refreshPeers(): Promise<void>
  refreshAccountAgents(): Promise<void>
  refreshDirectory(): Promise<void>
  refreshAll(): Promise<void>
  send(): Promise<void>
  markRead(id: string): Promise<void>
  /** Add a contact; resolves true on success so forms can clear themselves. */
  addContact(input: { contact: string; alias?: string; notes?: string }): Promise<boolean>
  removeContact(address: string): Promise<void>
  /** Open the current workspace's inbox on demand (first use). */
  provision(): Promise<void>
  /** Migrate a legacy inbox to the current tenant; returns the result or null. */
  migrate(key: string, oldOwnerKey?: string): Promise<MigrateResult | null>
  /** Bind this dsh instance to a msg9 tenant (owner key) and reload everything. */
  bindOwner(ownerKey: string, apiUrl?: string): Promise<void>
  /** Skip binding for now: fall back to per-workspace public registration. */
  dismissSetup(): void
}

export interface StoreOptions extends BridgeOptions {
  pollMs?: number
  bridge?: BridgeClient
}

const INITIAL: Msg9State = {
  status: 'loading',
  error: null,
  notice: null,
  cwd: null,
  owner: null,
  setup: { busy: false, error: null, dismissed: false },
  apiUrl: '',
  stateFile: '',
  workspaces: [],
  currentKey: null,
  tab: 'inbox',
  folder: 'all',
  messages: [],
  messagesTotal: 0,
  unreadCount: 0,
  unreadByKey: {},
  unreadTotal: 0,
  totalByKey: {},
  outbox: [],
  outboxTotal: 0,
  contacts: [],
  contactsTotal: 0,
  peers: [],
  accountAgents: [],
  accountOrg: null,
  groups: [],
  selectedGroup: null,
  groupDetail: null,
  groupArchive: [],
  groupArchiveTotal: 0,
  directory: [],
  directoryTotal: 0,
  directoryQuery: '',
  directoryCapability: null,
  selectedAgent: null,
  selectedId: null,
  selectedContact: null,
  composeOpen: false,
  compose: { to: '', subject: '', text: '' },
  notifyPaused: false,
  busy: { overview: false, messages: false, outbox: false, contacts: false, directory: false, archive: false, send: false, action: false },
  loadedAt: null,
}

/** 同一 message_id 只留第一份（fan-out 存档与翻页漂移都可能带回重复行）。 */
function dedupeById(rows: MessageRow[]): MessageRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.message_id)) return false
    seen.add(row.message_id)
    return true
  })
}

/** Build a store. Tests pass a fake bridge; the app uses the default one. */
export function createMsg9Store(options: StoreOptions = {}): Msg9Store {
  const bridge = options.bridge ?? createBridge(options)
  const pollMs = options.pollMs ?? 20_000

  let state: Msg9State = INITIAL
  const listeners = new Set<() => void>()
  let lastAutoKey: string | null = null
  let overviewKey: string | undefined
  let overviewRun: Promise<void> | undefined
  // Last-write-wins guards: a slow response from a previous workspace/folder
  // (or a previous cwd) must never overwrite the view the user is looking at.
  let overviewSeq = 0
  let inboxSeq = 0
  let outboxSeq = 0
  let contactsSeq = 0
  let groupsSeq = 0
  let directorySeq = 0
  let unreadRun: Promise<void> | undefined
  let sendIdempotencyKey: string | undefined
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const get = (): Msg9State => state
  const set = (patch: Partial<Msg9State>): void => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const setBusy = (patch: Partial<Msg9State['busy']>): void => set({ busy: { ...state.busy, ...patch } })

  function notice(kind: Notice['kind'], text: string): void {
    set({ notice: { kind, text } })
  }

  /** The workspace the panel is showing. */
  function selected(state: Msg9State): WorkspaceView | undefined {
    if (!state.currentKey) return undefined
    return state.workspaces.find((row) => row.key === state.currentKey)
  }

  /** Pick a default workspace after an overview refresh. */
  function reconcileKey(view: { current: WorkspaceView | null; workspaces: WorkspaceView[] }): string | null {
    const auto = view.current?.key ?? null
    if (auto !== lastAutoKey) {
      lastAutoKey = auto
      if (auto) return auto
    }
    if (state.currentKey && view.workspaces.some((row) => row.key === state.currentKey)) return state.currentKey
    const provisioned = view.workspaces.find((row) => row.provisioned)
    return provisioned?.key ?? auto ?? view.workspaces[0]?.key ?? null
  }

  async function refreshOverview(): Promise<void> {
    // The panel asks on mount and `setCwd` asks too: one cwd, one request.
    const cwd = state.cwd ?? ''
    if (overviewRun && overviewKey === cwd) return overviewRun
    overviewKey = cwd
    const seq = ++overviewSeq
    const run = runOverview(seq)
    overviewRun = run
    try {
      await run
    } finally {
      // Only clear the slot when it still holds THIS run: a newer run for
      // another cwd may already have replaced it.
      if (overviewRun === run) overviewRun = undefined
    }
  }

  async function runOverview(seq: number): Promise<void> {
    try {
      setBusy({ overview: true })
      const view = await bridge.overview(state.cwd ?? undefined)
      if (seq !== overviewSeq) return
      const currentKey = reconcileKey(view)
      set({
        status: 'ready',
        error: null,
        owner: view.owner,
        apiUrl: view.api_url,
        stateFile: view.state_file,
        workspaces: view.workspaces,
        currentKey,
        loadedAt: Date.now(),
      })
      // Keep the selected workspace's data in step with the new selection.
      const key = currentKey
      if (key) {
        void refreshInbox()
        void refreshOutbox()
        void refreshContacts()
        void refreshUnread()
      }
    } catch (error) {
      if (seq !== overviewSeq) return
      set({ status: state.workspaces.length === 0 ? 'error' : 'ready', error: errorText(error) })
    } finally {
      if (seq === overviewSeq) setBusy({ overview: false })
    }
  }

  async function refreshInbox(): Promise<void> {
    const workspace = selected(get())
    // A workspace without an inbox has nothing to fetch: asking anyway made the
    // host answer 404 and filled the browser console with failed requests.
    if (!workspace?.provisioned) return
    const seq = ++inboxSeq
    try {
      setBusy({ messages: true })
      const pending = state.folder === 'pending'
      // v1.13: 待处理 is the server's own `unprocessed` folder; on an older
      // server (invalid folder → 400) fall back to a local filter over `all`.
      let page: MessagesView
      let localFilter = false
      try {
        page = await bridge.messages(workspace.key, {
          folder: pending ? 'unprocessed' : (state.folder as FolderName),
          limit: 50,
          offset: 0,
        })
      } catch (error) {
        if (!pending) throw error
        page = await bridge.messages(workspace.key, { folder: 'all', limit: 50, offset: 0 })
        localFilter = true
      }
      if (seq !== inboxSeq) return
      const list = page.messages ?? []
      set({
        messages: localFilter ? list.filter((message) => !message.processed_by) : list,
        messagesTotal: page.total ?? list.length,
        unreadCount: page.unread_count ?? 0,
        loadedAt: Date.now(),
      })
    } catch (error) {
      if (seq === inboxSeq) notice('error', errorText(error))
    } finally {
      if (seq === inboxSeq) setBusy({ messages: false })
    }
  }

  async function refreshOutbox(): Promise<void> {
    const workspace = selected(get())
    // A workspace without an inbox has nothing to fetch: asking anyway made the
    // host answer 404 and filled the browser console with failed requests.
    if (!workspace?.provisioned) return
    const seq = ++outboxSeq
    try {
      setBusy({ outbox: true })
      const page = await bridge.outbox(workspace.key, { limit: 50, offset: 0 })
      if (seq !== outboxSeq) return
      set({ outbox: page.messages ?? [], outboxTotal: page.total ?? (page.messages ?? []).length })
    } catch (error) {
      if (seq === outboxSeq) notice('error', errorText(error))
    } finally {
      if (seq === outboxSeq) setBusy({ outbox: false })
    }
  }

  async function refreshContacts(): Promise<void> {
    const workspace = selected(get())
    // A workspace without an inbox has nothing to fetch: asking anyway made the
    // host answer 404 and filled the browser console with failed requests.
    if (!workspace?.provisioned) return
    const seq = ++contactsSeq
    try {
      setBusy({ contacts: true })
      const page = await bridge.contacts(workspace.key)
      if (seq !== contactsSeq) return
      set({ contacts: page.contacts ?? [], contactsTotal: page.total ?? (page.contacts ?? []).length })
    } catch (error) {
      if (seq === contactsSeq) notice('error', errorText(error))
    } finally {
      if (seq === contactsSeq) setBusy({ contacts: false })
    }
  }

  async function refreshUnread(): Promise<void> {
    // The poller fires on a fixed tick: skip a run while the previous one is
    // still in flight instead of stacking requests on a hung bridge.
    if (unreadRun) return unreadRun
    const run = (async () => {
      try {
        const view = await bridge.unread()
        set({ unreadByKey: view.byKey ?? {}, unreadTotal: view.total ?? 0, totalByKey: view.totalByKey ?? {} })
      } catch {
        /* the badge is advisory: a failed poll leaves the previous count */
      }
    })()
    unreadRun = run
    try {
      await run
    } finally {
      if (unreadRun === run) unreadRun = undefined
    }
  }

  async function refreshPeers(): Promise<void> {
    try {
      const view = await bridge.peers()
      set({ peers: view.peers ?? [] })
    } catch {
      /* peers are advisory too */
    }
  }

  async function refreshAccountAgents(): Promise<void> {
    if (!state.owner) return
    try {
      const view = await bridge.accountAgents()
      set({
        accountAgents: view.agents ?? [],
        accountOrg: view.org_id || view.org_label ? { id: view.org_id ?? null, label: view.org_label ?? null } : null,
      })
    } catch {
      /* the tenant network is advisory: an old server leaves the section hidden */
    }
  }

  async function refreshGroups(): Promise<void> {
    const workspace = selected(get())
    if (!workspace?.provisioned) return
    const seq = ++groupsSeq
    try {
      const view = await bridge.groups(workspace.key)
      if (seq !== groupsSeq) return
      set({ groups: view.groups ?? [] })
    } catch {
      /* groups are advisory too: a pre-v1.19 server leaves the section hidden */
    }
  }

  async function refreshGroupArchive(append = false): Promise<void> {
    const workspace = selected(get())
    const address = state.selectedGroup
    if (!workspace?.provisioned || !address) return
    // 「加载更多」连点闸：上一页还没回来时再点，offset 以旧长度发出，跨页重复。
    if (append && state.busy.archive) return
    const seq = ++groupsSeq
    const base = append ? state.groupArchive : []
    try {
      setBusy({ archive: true })
      const view = await bridge.groupMessages(workspace.key, address, { limit: 50, offset: base.length })
      if (seq !== groupsSeq) return
      const messages = view.messages ?? []
      set({
        // 平台按 fan-out 副本存档，翻页 offset 也可能漂移：合并一律按 message_id 去重。
        groupArchive: dedupeById(append ? [...base, ...messages] : messages),
        groupArchiveTotal: view.total ?? messages.length,
      })
    } catch {
      /* archive is advisory */
    } finally {
      if (seq === groupsSeq) setBusy({ archive: false })
    }
  }

  async function refreshDirectory(append = false): Promise<void> {
    const seq = ++directorySeq
    const base = append ? state.directory : []
    try {
      setBusy({ directory: true })
      const view = await bridge.directory({
        limit: 100,
        offset: base.length,
        ...(state.directoryQuery.trim() ? { q: state.directoryQuery.trim() } : {}),
        ...(state.directoryCapability ? { capability: state.directoryCapability } : {}),
      })
      if (seq !== directorySeq) return
      const agents = view.agents ?? []
      set({
        directory: append ? [...base, ...agents] : agents,
        directoryTotal: view.total ?? agents.length,
      })
    } catch (error) {
      if (seq === directorySeq) notice('error', errorText(error))
    } finally {
      if (seq === directorySeq) setBusy({ directory: false })
    }
  }

  /** One mark-read flow, shared by the explicit button and view-auto-read. */
  async function markReadOp(id: string): Promise<void> {
    const workspace = selected(get())
    if (!workspace) return
    const before = state.messages
    const beforeUnread = state.unreadCount
    const opKey = workspace.key
    const opFolder = state.folder
    // Optimistic: the list is the human's view of the mailbox.
    set({
      messages: before.map((message) => (message.message_id === id ? { ...message, read_at: new Date().toISOString() } : message)),
      unreadCount: Math.max(0, state.unreadCount - 1),
    })
    try {
      await bridge.markRead(workspace.key, id)
      void refreshUnread()
    } catch (error) {
      // Roll back BOTH halves of the optimistic update, or the list says
      // "unread" while the badge stayed decremented. 但先确认视图没换：
      // 操作在途时用户切了 workspace/folder，列表已被新刷新接管，
      // 把旧列表塞回去就是覆盖新视图（读路径靠 seq 防，写路径靠这个一致性校验）。
      const view = get()
      if (view.currentKey === opKey && view.folder === opFolder) {
        set({ messages: before, unreadCount: beforeUnread })
      }
      notice('error', errorText(error))
    }
  }

  async function refreshAll(): Promise<void> {
    await refreshOverview()
    void refreshPeers()
    void refreshAccountAgents()
  }

  function ensureTimer(): void {
    if (timer !== undefined) return
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refreshUnread()
    }, pollMs)
  }

  return {
    getState: get,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      subscribers += 1
      // Event-driven unread: the bridge pushes invalidations over SSE and we
      // refetch only when told something changed. The 20s timer survives only
      // as the fallback for environments without (working) EventSource.
      let source: EventSource | undefined
      let failures = 0
      const eventsUrl = `${(options.base ?? '/dsh-msg9').replace(/\/+$/, '')}/events`
      if (typeof EventSource !== 'undefined') {
        source = new EventSource(eventsUrl)
        source.onmessage = () => {
          failures = 0
          void refreshUnread()
        }
        source.onerror = () => {
          failures += 1
          if (failures >= 3) {
            source?.close()
            source = undefined
            ensureTimer()
          }
        }
      } else {
        ensureTimer()
      }
      void refreshUnread()
      return () => {
        subscribers -= 1
        source?.close()
        if (subscribers <= 0 && timer !== undefined) {
          clearInterval(timer)
          timer = undefined
          subscribers = 0
        }
      }
    },
    setCwd(cwd) {
      const next = cwd ?? null
      if (next === state.cwd) return
      lastAutoKey = null
      set({ cwd: next })
      if (next) void refreshOverview()
    },
    setTab(tab) {
      set({ tab })
      if (tab === 'inbox') void refreshInbox()
      if (tab === 'outbox') void refreshOutbox()
      if (tab === 'contacts') {
        void refreshContacts()
        void refreshAccountAgents()
      }
      if (tab === 'groups') void refreshGroups()
      if (tab === 'square') void refreshDirectory()
    },
    setFolder(folder) {
      set({ folder })
      void refreshInbox()
    },
    selectWorkspace(key) {
      if (key === state.currentKey) return
      set({
        currentKey: key, selectedId: null, selectedContact: null, selectedGroup: null, composeOpen: false,
        messages: [], outbox: [], contacts: [],
        // 列表清空了徽标也要归零：新 workspace 的数据回来之前，
        // 不能挂着旧 workspace 的未读/总数。
        messagesTotal: 0, unreadCount: 0, outboxTotal: 0, contactsTotal: 0,
      })
      void refreshInbox()
      void refreshOutbox()
      void refreshContacts()
      void refreshGroups()
    },
    selectMessage(id) {
      set({ selectedId: id, composeOpen: false })
      // Reading is believing for the human too: opening a message opens its
      // whole conversation (Gmail 式) — every UNREAD inbox letter in it gets
      // marked read, no separate click required. 仍走单封的 markReadOp 链路
      // （乐观更新 + 失败回滚），只对未读的触发。
      if (!id) return
      const seed = state.messages.find((row) => row.message_id === id)
      if (!seed) return
      const thread = seed.correlation_id
        ? state.messages.filter((row) => row.correlation_id === seed.correlation_id)
        : [seed]
      for (const row of thread) {
        if (!row.read_at) void markReadOp(row.message_id)
      }
    },
    selectContact(address) {
      set({ selectedContact: address, composeOpen: false })
    },
    selectAgent(address) {
      set({ selectedAgent: address, composeOpen: false })
    },
    selectGroup(address) {
      set({ selectedGroup: address, groupDetail: null, groupArchive: [], groupArchiveTotal: 0, composeOpen: false })
      const workspace = selected(get())
      if (!address || !workspace) return
      void bridge.groupDetail(workspace.key, address)
        .then((view) => {
          if (get().selectedGroup === address) set({ groupDetail: view.group })
        })
        .catch(() => {})
      void refreshGroupArchive()
    },
    setDirectoryQuery(query) {
      if (query === state.directoryQuery) return
      set({ directoryQuery: query })
      void refreshDirectory()
    },
    setDirectoryCapability(capability) {
      if (capability === state.directoryCapability) return
      set({ directoryCapability: capability })
      void refreshDirectory()
    },
    async loadMoreDirectory() {
      if (state.busy.directory || state.directory.length >= state.directoryTotal) return
      await refreshDirectory(true)
    },
    setCompose(patch) {
      // Editing the draft starts a new intent: the next send gets a fresh key.
      sendIdempotencyKey = undefined
      set({ compose: { ...state.compose, ...patch } })
    },
    openCompose(patch) {
      sendIdempotencyKey = undefined
      // A fresh compose (no patch) never inherits a previous reply's linkage.
      set({
        composeOpen: true,
        compose: patch ? { ...state.compose, ...patch } : { ...state.compose, replyTo: undefined, correlationId: undefined },
      })
    },
    closeCompose() {
      set({ composeOpen: false })
    },
    composeTo(address) {
      sendIdempotencyKey = undefined
      set({ composeOpen: true, compose: { ...state.compose, to: address, replyTo: undefined, correlationId: undefined } })
    },
    replyTo(message) {
      sendIdempotencyKey = undefined
      set({
        composeOpen: true,
        compose: {
          ...state.compose,
          to: message.list_address ?? message.from_address,
          replyTo: message.message_id,
          // The thread id rides verbatim — inventing one (e.g. reusing the
          // message id) forks the thread and the group convergence view
          // never sees the reply.
          ...(message.correlation_id ? { correlationId: message.correlation_id } : { correlationId: undefined }),
        },
      })
    },
    clearNotice() {
      set({ notice: null })
    },
    refreshOverview,
    refreshInbox,
    refreshOutbox,
    refreshContacts,
    refreshUnread,
    refreshPeers,
    refreshAccountAgents,
    refreshGroups,
    refreshGroupArchive,
    async refreshNotifyStatus() {
      try {
        const view = await bridge.notifyStatus()
        set({ notifyPaused: view.paused })
      } catch {
        /* the bell is advisory: older bridge leaves it off */
      }
    },
    async toggleNotify() {
      try {
        const view = await bridge.setNotifyPaused(!state.notifyPaused)
        set({ notifyPaused: view.paused })
        notice('ok', view.paused
          ? L('已静音：新邮件不再打断会话', 'Paused: mail no longer interrupts sessions')
          : L('已恢复新邮件提醒', 'New-mail wake-ups resumed'))
      } catch (error) {
        notice('error', errorText(error))
      }
    },
    refreshDirectory,
    refreshAll,
    async send() {
      const workspace = selected(get())
      const { to, subject, text, replyTo, correlationId } = state.compose
      if (!workspace) return notice('error', L('请先选择一个 workspace。', 'Select a workspace first.'))
      if (!workspace.provisioned) return notice('error', L('该 workspace 还没有收件箱。', 'This workspace has no inbox yet.'))
      if (!to.trim()) return notice('error', L('请填写收件人地址。', 'Enter a recipient address.'))
      if (!text.trim()) return notice('error', L('请填写消息正文。', 'Enter a message body.'))
      try {
        setBusy({ send: true })
        // One key per composer intent: a retry after a lost/timed-out response
        // must reuse it so msg9 dedups instead of delivering the mail twice.
        // setCompose regenerates it whenever the draft changes.
        sendIdempotencyKey ??= `dsh-ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const result = await bridge.send({
          key: workspace.key,
          to: to.trim(),
          text,
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          // reply_to closes the original precisely; correlation_id threads it
          // (verbatim from the incoming message, never invented).
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(correlationId ? { correlation_id: correlationId } : {}),
          idempotency_key: sendIdempotencyKey,
        })
        sendIdempotencyKey = undefined
        // 回复即处理: the original drops out of 待处理 right away.
        if (replyTo) {
          set({
            messages: state.messages.map((message) =>
              message.message_id === replyTo ? { ...message, processed_by: 'human' as const } : message),
          })
        }
        set({ compose: { to: '', subject: '', text: '' }, composeOpen: false })
        notice('ok', L('已发送到 {to}（{id}）', 'Sent to {to} ({id})', { to, id: result.message_id }))
        // 发送没有 SSE 失效事件兜底：发件箱和未读徽标都要主动刷新，
        // 否则发件箱会一直显示旧的（甚至空的）缓存列表。
        void refreshOutbox()
        void refreshUnread()
      } catch (error) {
        notice('error', errorText(error))
      } finally {
        setBusy({ send: false })
      }
    },
    async markDone(id) {
      const workspace = selected(get())
      if (!workspace) return
      const before = state.messages
      const beforeUnread = state.unreadCount
      const opKey = workspace.key
      const opFolder = state.folder
      const target = before.find((message) => message.message_id === id)
      const now = new Date().toISOString()
      set({
        messages: before.map((message) =>
          message.message_id === id ? { ...message, read_at: message.read_at ?? now, processed_by: 'human' as const } : message),
        // 未读邮件被「标为已处理」时顺手补了 read_at，徽标跟着减；本来就已读的不能再减。
        unreadCount: target && !target.read_at ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
      })
      try {
        await bridge.markDone(workspace.key, id)
        void refreshUnread()
      } catch (error) {
        // 同 markReadOp：视图已切换（workspace/folder 变了）就丢弃回滚，
        // 旧列表不能塞回已被新刷新接管的视图。
        const view = get()
        if (view.currentKey === opKey && view.folder === opFolder) {
          set({ messages: before, unreadCount: beforeUnread })
        }
        notice('error', errorText(error))
      }
    },
    async markRead(id) {
      await markReadOp(id)
    },
    async addContact(input) {
      const workspace = selected(get())
      if (!workspace) return false
      try {
        setBusy({ action: true })
        await bridge.addContact({ key: workspace.key, ...input })
        notice('ok', L('已添加联系人 {contact}', 'Contact added: {contact}', { contact: input.contact }))
        await refreshContacts()
        return true
      } catch (error) {
        notice('error', errorText(error))
        return false
      } finally {
        setBusy({ action: false })
      }
    },
    async removeContact(address) {
      const workspace = selected(get())
      if (!workspace) return
      try {
        setBusy({ action: true })
        await bridge.removeContact(workspace.key, address)
        notice('ok', L('已删除联系人 {contact}', 'Contact removed: {contact}', { contact: address }))
        await refreshContacts()
      } catch (error) {
        notice('error', errorText(error))
      } finally {
        setBusy({ action: false })
      }
    },
    async provision() {
      const workspace = selected(get())
      if (!workspace && !state.cwd) {
        return notice('error', L('还不知道当前 workspace 的目录。', 'The current workspace directory is unknown.'))
      }
      try {
        setBusy({ action: true })
        const result = await bridge.provision({
          ...(workspace ? { key: workspace.key, title: workspace.title } : {}),
          ...(state.cwd ? { cwd: state.cwd } : {}),
        })
        notice('ok', result.provisioned
          ? L('已开通收件箱 {address}', 'Inbox opened: {address}', { address: result.address })
          : L('收件箱已存在：{address}', 'Inbox already open: {address}', { address: result.address }))
        await refreshOverview()
      } catch (error) {
        notice('error', errorText(error))
      } finally {
        setBusy({ action: false })
      }
    },
    async migrate(key, oldOwnerKey) {
      try {
        setBusy({ action: true })
        const result = await bridge.migrate({
          key,
          ...(oldOwnerKey?.trim() ? { old_owner_key: oldOwnerKey.trim() } : {}),
        })
        const parts = [
          L('已迁移到 {address}', 'Migrated to {address}', { address: result.new_address }),
          result.forwarding ? L('旧地址已设置转发', 'old address forwards here') : null,
          result.moved_mail !== null && result.moved_mail !== undefined
            ? L('搬入 {n} 封历史邮件', '{n} old message(s) moved', { n: result.moved_mail })
            : null,
          result.old_disabled ? L('旧收件箱已停用', 'old inbox suspended') : null,
        ].filter(Boolean).join('，')
        if (result.note) notice('ok', `${parts}。${result.note}`)
        else notice('ok', parts)
        await refreshOverview()
        return result
      } catch (error) {
        notice('error', errorText(error))
        return null
      } finally {
        setBusy({ action: false })
      }
    },
    async bindOwner(ownerKey, apiUrl) {
      const key = ownerKey.trim()
      if (!key) return
      set({ setup: { ...state.setup, busy: true, error: null } })
      try {
        const result = await bridge.setup(apiUrl ? { owner_key: key, api_url: apiUrl } : { owner_key: key })
        set({
          owner: result.owner,
          apiUrl: result.api_url,
          setup: { busy: false, error: null, dismissed: false },
        })
        notice('ok', result.owner.slug
          ? L('已绑定租户 {name}（{domain}）', 'Tenant connected: {name} ({domain})', {
              name: result.owner.name ?? result.owner.id ?? 'owner',
              domain: `${result.owner.slug}.${result.owner.mail_domain ?? 'msg9.io'}`,
            })
          : L('已绑定租户 {name}', 'Tenant connected: {name}', {
              name: result.owner.name ?? result.owner.id ?? 'owner',
            }))
        await refreshAll()
      } catch (error) {
        set({ setup: { busy: false, error: errorText(error), dismissed: false } })
      }
    },
    dismissSetup() {
      set({ setup: { ...state.setup, dismissed: true, error: null } })
    },
  }
}

let singleton: Msg9Store | undefined

/** The page-wide store (one poller, one badge, one panel). */
export function getMsg9Store(options?: StoreOptions): Msg9Store {
  singleton ??= createMsg9Store(options)
  return singleton
}

/** The workspace currently shown, if any. */
export function selectedWorkspace(state: Msg9State): WorkspaceView | undefined {
  if (!state.currentKey) return undefined
  return state.workspaces.find((row) => row.key === state.currentKey)
}

/** Overview rows the panel offers, current one first (already sorted by host). */
export function workspaceOptions(state: Msg9State): WorkspaceView[] {
  return state.workspaces
}
