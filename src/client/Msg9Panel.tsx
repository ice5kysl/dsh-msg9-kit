/**
 * The msg9 mailbox view, registered as a「消息」session view tab next to
 * 对话 | 轨迹 | 文件 (`conversation.view`).
 *
 * Three-column mail-client layout:
 *
 *   1. nav — workspace switcher, 写消息, 收件箱 / 发件箱 / 联系人 / 广场;
 *   2. list — the message list of the active box (folder chips for the
 *      inbox), or the contact / sibling-inbox / public-agent list;
 *   3. detail — the selected message, the selected contact, the selected
 *      agent's yellow-pages card, or the composer.
 *
 * It is a pure projection of the store (`useSyncExternalStore`) — every action
 * goes through `Msg9Store`, so the model tools, the view and the tests all
 * share one implementation of "provision / list / send / read / contacts".
 * Colors ride the shell's design tokens; interactive states and icons are
 * class-based (see theme.ts / icons.tsx), no emoji glyphs anywhere.
 *
 * @module dsh-msg9-kit/client-panel
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import DOMPurify from 'dompurify'
import type { AccountAgentView, ContactRow, DirectoryAgentRow, GroupRow, MessageRow, PeerRow } from '../shared/types.ts'
import { ArrowRight, Bell, BellOff, Check, Copy, Globe, Inbox, MessagesSquare, PenLine, RefreshCw, Reply, Search, Send, Trash2, UserPlus, Users, X } from './icons.tsx'
import { highlightCode, highlightReady } from './highlight.ts'
import { L } from './locale.ts'
import { selectedWorkspace, type Msg9State, type Msg9Store, type Tab } from './store.ts'
import { ACTIVE_BG, ACCENT, BG, BORDER, BORDER_STRONG, DIM, FG, M9_CSS } from './theme.ts'
import {
  FOLDERS,
  agentLabel,
  badgeText,
  contactLabel,
  filterContacts,
  folderLabel,
  formatTime,
  fullBody,
  isUnread,
  previewOf,
  processedLabel,
} from './view.ts'

/** Props handed to the view: injected store + the standard slot shares. */
export interface Msg9PanelProps {
  /** The page-wide store (injected). */
  store: Msg9Store
  /** Leave the view (unused by conversation.view; kept for compatibility). */
  onBack?: () => void
  /** Current session list state; the view follows the selected session. */
  useSessions?: (selector: (state: SessionListLike) => unknown) => unknown
}

interface SessionListLike {
  current?: string
  byId?: Record<string, { cwd?: string } | undefined>
}

/** Read the selected session's directory out of the standard slot share. */
function useSessionCwd(props: Msg9PanelProps): string | undefined {
  const selector = props.useSessions
  const read = useCallback((state: SessionListLike): unknown => {
    const current = state?.current
    if (!current) return undefined
    return state?.byId?.[current]?.cwd
  }, [])
  // `useSessions` is itself a hook when the host provides one: keep the call
  // unconditional in shape (no early return above it) so hook order stays
  // stable; the host keeps this prop stable for the panel's lifetime.
  const value = typeof selector === 'function' ? selector(read) : undefined
  return typeof value === 'string' ? value : undefined
}

export function Msg9Panel(props: Msg9PanelProps): JSX.Element {
  const { store } = props
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const cwd = useSessionCwd(props)

  // Follow the current session's workspace.
  useEffect(() => {
    store.setCwd(cwd ?? null)
  }, [store, cwd])

  // The first paint can precede Shiki's async init: re-render once when the
  // highlighter lands so code blocks light up without a reload.
  const [, bumpHighlight] = useState(0)
  useEffect(() => {
    let live = true
    void highlightReady.then(() => {
      if (live) bumpHighlight((n) => n + 1)
    })
    return () => {
      live = false
    }
  }, [])

  // First paint: tenant table + workspace data + sibling list + bell state.
  useEffect(() => {
    void store.refreshAll()
    void store.refreshNotifyStatus()
  }, [store])

  const workspace = selectedWorkspace(state)
  // Nothing is configurable before the instance knows its tenant, so the
  // binding form comes first; "skip" keeps the public-registration path.
  const needsSetup = !state.owner && !state.setup.dismissed

  if (needsSetup) {
    return (
      <div style={styles.root}>
        <style>{M9_CSS}</style>
        <SetupView state={state} store={store} />
      </div>
    )
  }

  if (state.status === 'error' && state.error) {
    return (
      <div style={styles.root}>
        <style>{M9_CSS}</style>
        <div style={styles.errorBlock}>
          <div>{L('无法读取 msg9 状态：{error}', 'Cannot read msg9 state: {error}', { error: state.error })}</div>
          {state.cwd && !workspace?.provisioned && (
            <button type="button" className="m9-btn m9-btn-primary" onClick={() => void store.provision()}>
              {L('为当前 workspace 开通收件箱', 'Open an inbox for this workspace')}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!workspace || !workspace.provisioned) {
    return (
      <div style={styles.root}>
        <style>{M9_CSS}</style>
        <Notice state={state} store={store} />
        {!workspace ? (
          <Empty
            text={L(
              '还没有可用的 workspace 收件箱。回到对话里让 Agent 运行一次 msg9_inbox，或在这里开通当前 workspace 的收件箱。',
              'No workspace inbox yet. Ask the agent to run msg9_inbox in a session, or open this workspace\'s inbox here.',
            )}
            actionLabel={state.cwd ? L('开通收件箱', 'Open inbox') : undefined}
            onAction={() => void store.provision()}
          />
        ) : (
          <Empty
            text={L(
              '「{title}」还没有 msg9 收件箱。开通后会得到一个地址（例如 {address}），其他 workspace 和 Agent 就能给它发消息。',
              '"{title}" has no msg9 inbox yet. Opening one assigns an address (for example {address}) that other workspaces and agents can message.',
              { title: workspace.title, address: workspace.planned_address ?? 'dsh-…@msg9.io' },
            )}
            actionLabel={L('开通收件箱', 'Open inbox')}
            onAction={() => void store.provision()}
          />
        )}
      </div>
    )
  }

  return (
    <div style={styles.root}>
      <style>{M9_CSS}</style>
      <Notice state={state} store={store} />
      <div style={styles.columns}>
        <NavColumn state={state} store={store} />
        <ListColumn state={state} store={store} />
        <DetailColumn state={state} store={store} />
      </div>
    </div>
  )
}

/** Column 1: workspace, compose, and the three boxes. */
function NavColumn({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const workspace = selectedWorkspace(state)
  const items: { id: Tab; label: string; badge?: string; icon: JSX.Element }[] = [
    { id: 'inbox', label: L('收件箱', 'Inbox'), badge: badgeText(state.unreadCount), icon: <Inbox size={15} /> },
    { id: 'outbox', label: L('发件箱', 'Outbox'), badge: badgeText(state.outboxTotal), icon: <Send size={15} /> },
    { id: 'contacts', label: L('联系人', 'Contacts'), badge: badgeText(state.contactsTotal), icon: <Users size={15} /> },
    { id: 'groups', label: L('群组', 'Groups'), badge: badgeText(state.groups.length), icon: <MessagesSquare size={15} /> },
    { id: 'square', label: L('广场', 'Square'), badge: badgeText(state.directoryTotal), icon: <Globe size={15} /> },
  ]
  return (
    <nav style={styles.nav} className="m9-nav">
      <select
        className="m9-select"
        value={state.currentKey ?? ''}
        onChange={(event) => store.selectWorkspace(event.target.value)}
        title={L('切换 workspace 收件箱', 'Switch workspace inbox')}
      >
        {state.workspaces.map((row) => (
          <option key={row.key} value={row.key}>
            {row.title}
            {row.provisioned ? '' : L('（未开通）', ' (no inbox)')}
          </option>
        ))}
      </select>
      <div style={styles.navAddress} title={workspace?.address ?? ''}>{workspace?.address}</div>
      <div style={styles.composeRow}>
        <button type="button" className="m9-btn m9-btn-primary" style={styles.composeButton} onClick={() => store.openCompose()}>
          <PenLine size={13} />
          {L('写消息', 'Compose')}
        </button>
        <button
          type="button"
          className="m9-iconbtn"
          style={styles.bellButton}
          onClick={() => void store.toggleNotify()}
          title={state.notifyPaused
            ? L('新邮件提醒已静音（会话不被打断），点击恢复', 'Wake-ups paused (sessions never interrupted) — click to resume')
            : L('新邮件提醒开启中，点击静音', 'Wake-ups on — click to pause')}
        >
          {state.notifyPaused ? <BellOff size={14} style={styles.bellMuted} /> : <Bell size={14} />}
        </button>
      </div>
      <div style={styles.navItems}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === state.tab && !state.composeOpen ? 'm9-nav-item active' : 'm9-nav-item'}
            onClick={() => store.setTab(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge ? <span style={styles.navBadge}>{item.badge}</span> : null}
          </button>
        ))}
      </div>
      <div style={styles.navFooter}>
        <button type="button" className="m9-iconbtn" onClick={() => void store.refreshAll()} title={L('刷新', 'Refresh')}>
          <RefreshCw size={13} className={state.busy.overview ? 'm9-spin' : undefined} />
        </button>
        <span style={styles.navTenant}>
          {state.owner?.slug
            ? `${state.owner.slug}.${state.owner.mail_domain ?? 'msg9.io'}`
            : state.owner?.name ?? L('公开注册', 'public registration')}
        </span>
      </div>
    </nav>
  )
}

/** Column 2: the list of the active box. */
function ListColumn({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  if (state.tab === 'contacts') return <ContactList state={state} store={store} />
  if (state.tab === 'groups') return <GroupListView state={state} store={store} />
  if (state.tab === 'square') return <SquareList state={state} store={store} />
  const outgoing = state.tab === 'outbox'
  const messages = outgoing ? state.outbox : state.messages
  return (
    <section style={styles.listCol} className="m9-listcol">
      {state.tab === 'inbox' && (
        <div style={styles.folderRow}>
          {FOLDERS.map((folder) => (
            <button
              key={folder}
              type="button"
              className={folder === state.folder ? 'm9-chip active' : 'm9-chip'}
              onClick={() => store.setFolder(folder)}
            >
              {folderLabel(folder)}
            </button>
          ))}
        </div>
      )}
      <MessageList
        messages={messages}
        selectedId={state.selectedId}
        empty={outgoing ? L('还没有已发送的消息。', 'Nothing sent yet.') : L('收件箱是空的。', 'The inbox is empty.')}
        loading={outgoing ? state.busy.outbox : state.busy.messages}
        store={store}
        outgoing={outgoing}
      />
    </section>
  )
}

/** Column 3: composer, message detail, contact detail, group view, or agent card. */
function DetailColumn({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  if (state.composeOpen) return <Composer state={state} store={store} />
  if (state.tab === 'contacts') return <ContactDetail state={state} store={store} />
  if (state.tab === 'groups') return <GroupView state={state} store={store} />
  if (state.tab === 'square') return <SquareDetail state={state} store={store} />
  const messages = state.tab === 'outbox' ? state.outbox : state.messages
  const selected = messages.find((message) => message.message_id === state.selectedId)
  return (
    <section style={styles.detailCol}>
      <MessageDetail message={selected} store={store} />
    </section>
  )
}

/** First run: paste the tenant (owner) key before anything else can happen.
 *  Also embedded by Settings → 消息信箱 while the instance is unbound, so the
 *  newcomer gets the same guidance on both surfaces. */
export function SetupView({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const [token, setToken] = useState('')
  const [apiUrl, setApiUrl] = useState(state.apiUrl || '')
  const busy = state.setup.busy

  return (
    <form
      style={styles.setup}
      onSubmit={(event) => {
        event.preventDefault()
        if (!token.trim() || busy) return
        void store.bindOwner(token, apiUrl.trim() || undefined)
      }}
    >
      <div style={styles.setupTitle}>{L('连接 msg9：给每个 workspace 一个 Agent 信箱', 'Connect msg9: an inbox for every workspace agent')}</div>
      <div style={styles.setupHint}>
        {L(
          'msg9 是给 Agent 用的消息服务：每个 dsh workspace 得到一个邮箱地址，workspace 之间、以及和其他 Agent（Kimi Code、Claude Code…）用邮件协作。两条路，以后随时切换：',
          'msg9 is messaging for agents: every dsh workspace gets an address, so workspaces — and other agents (Kimi Code, Claude Code…) — collaborate by mail. Two ways in, switchable any time:',
        )}
      </div>

      <div style={styles.setupPath}>
        <div style={styles.setupPathTitle}>{L('方式 A · 绑定租户（推荐）', 'Path A · Bind a tenant (recommended)')}</div>
        <ol style={styles.setupSteps}>
          <li>{L('打开 msg9.io，注册 / 登录账号', 'Open msg9.io and sign up / log in')}</li>
          <li>{L('进入 Account 页，创建一个租户（tenant）', 'Go to the Account page and create a tenant')}</li>
          <li>{L('复制租户 key（msg9_tk_…，只显示一次）粘贴到下面', 'Copy the tenant key (msg9_tk_…, shown once) and paste it below')}</li>
        </ol>
        <div style={styles.setupHintDim}>
          {L(
            '好处：每个 workspace 得到 {example} 这样的短地址、租户独立配额、可停用 / 轮换 / 迁移信箱。',
            'You get short addresses like {example}, a dedicated quota, and lifecycle control (suspend / rotate / migrate).',
            { example: 'looploop@you.msg9.io' },
          )}
        </div>
      </div>

      <label style={styles.setupLabel}>
        {L('租户 key', 'Tenant key')}
        <input
          className="m9-input"
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          placeholder="msg9_tk_…"
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <label style={styles.setupLabel}>
        {L('API 地址（可选，自建 msg9 时填）', 'API base (optional — only for self-hosted msg9)')}
        <input
          className="m9-input"
          value={apiUrl}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://api.msg9.io"
          onChange={(event) => setApiUrl(event.target.value)}
        />
      </label>
      {state.setup.error && <div style={styles.setupError}>{state.setup.error}</div>}
      <div style={styles.setupActions}>
        <button type="submit" className="m9-btn m9-btn-primary" disabled={busy || !token.trim()}>
          {busy ? L('校验中…', 'Checking…') : L('绑定租户', 'Connect tenant')}
        </button>
        <button type="button" className="m9-btn" onClick={() => store.dismissSetup()}>
          {L('暂不绑定', 'Skip for now')}
        </button>
      </div>

      <div style={styles.setupPath}>
        <div style={styles.setupPathTitle}>{L('方式 B · 没有账号？点「暂不绑定」先用起来', 'Path B · No account? Hit "Skip for now" and start')}</div>
        <div style={styles.setupHintDim}>
          {L(
            '每个 workspace 首次使用时自动公开注册一个 @msg9.io 地址，立刻就能收发——不需要任何 key。代价：地址较长（形如 dsh-xxx-1a2b@msg9.io）、与他人共享限流、没有租户级的配额与生命周期管理。以后随时可回到这里绑定（设置 → 消息信箱，或本页）。',
            'Each workspace self-registers a @msg9.io address on first use and can mail right away — no key needed. Trade-offs: longer addresses (like dsh-xxx-1a2b@msg9.io), shared rate limits, and no tenant-level quota or lifecycle control. Bind later any time (Settings → Messages, or right here).',
          )}
        </div>
      </div>
    </form>
  )
}

function Notice({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element | null {
  if (!state.notice) return null
  const isOk = state.notice.kind === 'ok'
  return (
    <div style={isOk ? styles.noticeOk : styles.noticeError}>
      <span>{state.notice.text}</span>
      <button type="button" className="m9-iconbtn" onClick={() => store.clearNotice()} title={L('关闭', 'Dismiss')}>
        <X size={12} />
      </button>
    </div>
  )
}

function Empty({ text, actionLabel, onAction }: { text: string; actionLabel?: string; onAction?: () => void }): JSX.Element {
  return (
    <div style={styles.empty}>
      <p style={styles.emptyText}>{text}</p>
      {actionLabel && onAction && (
        <button type="button" className="m9-btn m9-btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

function MessageList({
  messages,
  selectedId,
  empty,
  loading,
  store,
  outgoing,
}: {
  messages: MessageRow[]
  selectedId: string | null
  empty: string
  loading: boolean
  store: Msg9Store
  outgoing?: boolean
}): JSX.Element {
  if (messages.length === 0) {
    return <div style={styles.listEmpty}>{loading ? L('加载中…', 'Loading…') : empty}</div>
  }
  return (
    <ul style={styles.list}>
      {messages.map((message) => {
        const active = message.message_id === selectedId
        const unread = !outgoing && isUnread(message)
        return (
          <li key={message.message_id}>
            <button
              type="button"
              className={active ? 'm9-row active' : 'm9-row'}
              onClick={() => store.selectMessage(message.message_id)}
            >
              <div style={styles.rowTop}>
                {message.processed_by
                  ? <Check size={11} style={styles.rowProcessed} />
                  : <span style={unread ? styles.rowUnreadDot : styles.rowDot} />}
                <span style={unread ? styles.rowPeerUnread : styles.rowPeer}>
                  {outgoing ? message.to_address : message.from_address}
                </span>
                {message.list_address && <span style={styles.groupTag}>{L('组', 'group')}</span>}
                <span style={styles.rowTime}>{formatTime(message.created_at)}</span>
              </div>
              {message.subject ? <div style={unread ? styles.rowSubjectUnread : styles.rowSubject}>{message.subject}</div> : null}
              <div style={styles.rowPreview}>{previewOf(message)}</div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Render a message body as sanitized markdown (email line breaks count). */
// Syntax highlighting for fenced code (```lang …```): Shiki (VS Code's engine)
// — see highlight.ts. Until it finishes initializing, code degrades to
// escaped plaintext and the panel re-renders once on ready.
marked.use(markedHighlight({
  langPrefix: 'language-',
  highlight: (code, lang) => highlightCode(code, lang),
}))

function markdownHtml(text: string): string {
  const raw = marked.parse(text, { gfm: true, breaks: true }) as string
  // Server-side render (tests) has no DOM: DOMPurify degrades to pass-through,
  // which is fine — the browser build always sanitizes.
  return DOMPurify.isSupported ? DOMPurify.sanitize(raw) : raw
}

function MessageDetail({
  message,
  store,
}: {
  message: MessageRow | undefined
  store: Msg9Store
}): JSX.Element {
  if (!message) return <div style={styles.detailEmpty}>{L('选择一条消息查看内容。', 'Select a message to read it.')}</div>
  return (
    <article style={styles.detail}>
      <header style={styles.detailHeader}>
        <div style={styles.detailSubject}>{message.subject || L('（无主题）', '(no subject)')}</div>
        <div style={styles.detailMeta}>
          <span style={styles.detailAddresses}>
            {message.from_address}
            <ArrowRight size={11} style={styles.metaArrow} />
            {message.to_address ?? '—'}
          </span>
          {message.list_address && (
            <span style={styles.groupTag} title={L('组邮件：回复将发到组', 'Group mail: replies go to the group')}>
              {L('组', 'group')} · {message.list_address}
            </span>
          )}
          <span style={styles.metaTime}>{formatTime(message.created_at)}</span>
          {message.verified === true && (
            <span style={styles.sigOk} title={message.key_id ? `key ${message.key_id}` : undefined}>
              {L('签名已验证', 'Signature verified')}
            </span>
          )}
          {message.verified === false && (
            <span style={styles.sigBad} title={message.key_id ? `key ${message.key_id}` : undefined}>
              {L('签名无效', 'Invalid signature')}
            </span>
          )}
          {message.verified === undefined && (
            <span style={styles.sigNone}>{L('未签名', 'Unsigned')}</span>
          )}
        </div>
        {(message.processed_by || message.read_by) && (
          <div style={styles.detailMeta}>
            {message.processed_by ? (
              <span style={styles.processedTag}>
                <Check size={11} />
                {processedLabel(message)}
                {message.processed_at ? ` · ${formatTime(message.processed_at)}` : ''}
              </span>
            ) : message.read_by ? (
              <span style={styles.metaTime}>
                {message.read_by === 'human' ? L('人已读', 'Read by you') : L('Agent 已读', 'Read by agent')}
              </span>
            ) : null}
          </div>
        )}
        <div style={styles.detailActions}>
          {isUnread(message) && (
            <button type="button" className="m9-btn" onClick={() => void store.markRead(message.message_id)}>
              <Check size={12} />
              {L('标记已读', 'Mark read')}
            </button>
          )}
          {!message.processed_by && (
            <button type="button" className="m9-btn" onClick={() => void store.markDone(message.message_id)}>
              <Check size={12} />
              {L('标为已处理', 'Mark handled')}
            </button>
          )}
          <button type="button" className="m9-btn" onClick={() => store.replyTo(message)}>
            <Reply size={12} />
            {message.list_address ? L('回复组', 'Reply to group') : L('回复', 'Reply')}
          </button>
          <button
            type="button"
            className="m9-btn"
            onClick={() => void navigator.clipboard?.writeText(message.message_id)}
            title={message.message_id}
          >
            <Copy size={12} />
            {L('复制 ID', 'Copy id')}
          </button>
        </div>
      </header>
      <div className="m9-md" dangerouslySetInnerHTML={{ __html: markdownHtml(fullBody(message)) }} />
      <div style={styles.detailId}>{message.message_id}</div>
    </article>
  )
}

/** The composer occupies the detail column while open. */
function Composer({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const suggestions = useMemo(() => {
    const rows: { address: string; label: string }[] = []
    for (const contact of state.contacts) rows.push({ address: contact.contact, label: contactLabel(contact) })
    for (const peer of state.peers) {
      if (!rows.some((row) => row.address === peer.address)) {
        rows.push({ address: peer.address, label: peer.title ?? L('同租户收件箱', 'sibling inbox') })
      }
    }
    return rows
  }, [state.contacts, state.peers])

  return (
    <section style={styles.detailCol}>
      <div style={styles.composerHead}>
        <span style={styles.detailSubject}>
          {state.compose.replyTo
            ? L('回复 {id}', 'Reply to {id}', { id: state.compose.replyTo })
            : L('写消息', 'Compose')}
        </span>
        <button type="button" className="m9-iconbtn" onClick={() => store.closeCompose()} title={L('关闭', 'Close')}>
          <X size={14} />
        </button>
      </div>
      <label style={styles.field}>
        <span style={styles.fieldLabel}>{L('收件人', 'To')}</span>
        <input
          className="m9-input"
          list="msg9-recipients"
          value={state.compose.to}
          placeholder="peer@msg9.io"
          onChange={(event) => store.setCompose({ to: event.target.value })}
        />
        <datalist id="msg9-recipients">
          {suggestions.map((row) => (
            <option key={row.address} value={row.address}>
              {row.label}
            </option>
          ))}
        </datalist>
      </label>
      <label style={styles.field}>
        <span style={styles.fieldLabel}>{L('主题', 'Subject')}</span>
        <input
          className="m9-input"
          value={state.compose.subject}
          onChange={(event) => store.setCompose({ subject: event.target.value })}
        />
      </label>
      <label style={styles.field}>
        <span style={styles.fieldLabel}>{L('正文', 'Message')}</span>
        <textarea
          className="m9-textarea"
          rows={8}
          value={state.compose.text}
          onChange={(event) => store.setCompose({ text: event.target.value })}
        />
      </label>
      <div style={styles.composerActions}>
        <button type="button" className="m9-btn m9-btn-primary" disabled={state.busy.send} onClick={() => void store.send()}>
          <Send size={12} />
          {state.busy.send ? L('发送中…', 'Sending…') : L('发送', 'Send')}
        </button>
        <span style={styles.composerHint}>
          {L('以 {address} 的身份发送', 'Sent as {address}', {
            address: selectedWorkspace(state)?.address ?? '—',
          })}
        </span>
      </div>
    </section>
  )
}

/** Middle column of the contacts tab: search + contacts + sibling inboxes + tenant network. */
function ContactList({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const [query, setQuery] = useState('')
  const rows = useMemo(() => filterContacts(state.contacts, query), [state.contacts, query])
  const networkGroups = useMemo(() => {
    const groups = new Map<string, { owner_id: string; owner_name: string; address_domain: string; agents: AccountAgentView[] }>()
    for (const agent of state.accountAgents) {
      const group = groups.get(agent.owner_id) ?? {
        owner_id: agent.owner_id,
        owner_name: agent.owner_name,
        address_domain: agent.address_domain,
        agents: [],
      }
      group.agents.push(agent)
      groups.set(agent.owner_id, group)
    }
    return [...groups.values()]
  }, [state.accountAgents])
  return (
    <section style={styles.listCol} className="m9-listcol">
      <div style={styles.searchWrap}>
        <Search size={13} style={styles.searchIcon} />
        <input
          className="m9-input"
          style={styles.searchInput}
          placeholder={L('搜索联系人', 'Search contacts')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <div style={styles.listEmpty}>
          {state.busy.contacts ? L('加载中…', 'Loading…') : L('没有联系人。', 'No contacts.')}
        </div>
      ) : (
        <ul style={styles.list}>
          {rows.map((contact) => (
            <li key={contact.id ?? contact.contact}>
              <button
                type="button"
                className={contact.contact === state.selectedContact ? 'm9-row active' : 'm9-row'}
                onClick={() => store.selectContact(contact.contact)}
              >
                <div style={styles.contactName}>{contactLabel(contact)}</div>
                <div style={styles.rowPreview}>{contact.contact}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.peers.length > 0 && (
        <>
          <div style={styles.listHeader}>{L('同租户收件箱', 'Sibling inboxes')}</div>
          <ul style={styles.list}>
            {state.peers.map((peer) => (
              <PeerRowView key={peer.address} peer={peer} store={store} />
            ))}
          </ul>
        </>
      )}
      {networkGroups.length > 0 && (
        <>
          <div style={styles.listHeader}>{L('我的租户网络', 'My tenant network')}</div>
          {networkGroups.map((group) => (
            <div key={group.owner_id}>
              <div style={styles.networkOwner}>{group.owner_name} · {group.address_domain}</div>
              <ul style={styles.list}>
                {group.agents.map((agent) => (
                  <AccountAgentRowView key={agent.address} agent={agent} state={state} store={store} />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

/** One row of「我的租户网络」: an agent of some owner on this account. */
function AccountAgentRowView({ agent, state, store }: { agent: AccountAgentView; state: Msg9State; store: Msg9Store }): JSX.Element {
  const isContact = state.contacts.some((contact) => contact.contact === agent.address)
  return (
    <li style={styles.contactRow} title={agent.description ?? agent.address}>
      <div style={styles.contactText}>
        <div style={styles.contactName}>
          {agent.display_name ?? agent.address}
          {agent.status !== 'active' && <span style={styles.statusTag}>{agent.status}</span>}
        </div>
        <div style={styles.contactAddress}>{agent.address}</div>
        {agent.capabilities?.length ? (
          <div style={styles.capsRow}>
            {agent.capabilities.map((cap) => (
              <span key={cap} style={styles.capChip}>{cap}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div style={styles.rowActions}>
        {!isContact && (
          <button
            type="button"
            className="m9-iconbtn"
            disabled={state.busy.action}
            onClick={() => void store.addContact({
              contact: agent.address,
              ...(agent.display_name?.trim() ? { alias: agent.display_name.trim() } : {}),
            })}
            title={L('加联系人', 'Add contact')}
          >
            <UserPlus size={13} />
          </button>
        )}
        <button type="button" className="m9-iconbtn" onClick={() => store.composeTo(agent.address)} title={L('发消息', 'Message')}>
          <Send size={13} />
        </button>
      </div>
    </li>
  )
}

/** Detail column of the contacts tab: the selected contact, or the add form. */
function ContactDetail({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const contact = state.contacts.find((row) => row.contact === state.selectedContact)
  return (
    <section style={styles.detailCol}>
      {contact ? <ContactCard contact={contact} store={store} /> : <AddContactForm state={state} store={store} />}
    </section>
  )
}

/** Middle column of the「群组」tab: every group the workspace inbox belongs to,
 *  split into 我创建的 (created_by = this inbox) and 我加入的. */
function GroupListView({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const myAddress = selectedWorkspace(state)?.address ?? null
  const created = state.groups.filter((group) => group.created_by && group.created_by === myAddress)
  const joined = state.groups.filter((group) => !(group.created_by && group.created_by === myAddress))
  if (state.groups.length === 0) {
    return (
      <section style={styles.listCol} className="m9-listcol">
        <div style={styles.listEmpty}>
          {L('还没有加入任何组。组是多个 Agent 围绕话题讨论的地方（msg9 v1.19）。', 'No groups yet. Groups are where agents discuss a topic together (msg9 v1.19).')}
        </div>
      </section>
    )
  }
  const renderGroup = (group: GroupRow): JSX.Element => (
    <li key={group.address}>
      <button
        type="button"
        className={group.address === state.selectedGroup ? 'm9-row active' : 'm9-row'}
        onClick={() => store.selectGroup(group.address)}
      >
        <div style={styles.rowTop}>
          <span style={styles.agentName}>{group.display_name ?? group.address}</span>
          <span style={styles.knownTag}>{L('{n} 人', '{n}', { n: group.member_count ?? 0 })}</span>
        </div>
        <div style={styles.rowPreview}>{group.address}</div>
      </button>
    </li>
  )
  return (
    <section style={styles.listCol} className="m9-listcol">
      {created.length > 0 && (
        <>
          <div style={styles.listHeader}>{L('我创建的', 'Created by me')}</div>
          <ul style={styles.list}>{created.map(renderGroup)}</ul>
        </>
      )}
      {joined.length > 0 && (
        <>
          <div style={styles.listHeader}>{L('我加入的', 'Joined')}</div>
          <ul style={styles.list}>{joined.map(renderGroup)}</ul>
        </>
      )}
    </section>
  )
}

/** Right column of the「群组」tab: the group card plus its message archive. */
function GroupView({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const group = state.groupDetail ?? state.groups.find((row) => row.address === state.selectedGroup)
  if (!state.selectedGroup || !group) {
    return (
      <section style={styles.detailCol}>
        <div style={styles.detailEmpty}>{L('选择一个组查看详情和组内消息。', 'Select a group to see its details and messages.')}</div>
      </section>
    )
  }
  const memberCount = group.member_count ?? group.members?.length ?? 0
  return (
    <section style={styles.detailCol}>
      <article style={styles.detail}>
        <header style={styles.detailHeader}>
          <div style={styles.detailSubject}>{group.display_name ?? group.address}</div>
          <div style={styles.detailMeta}>
            <span style={styles.detailAddresses}>{group.address}</span>
            <span style={styles.groupTag}>{group.open ? L('开放组', 'open') : L('封闭组', 'closed')}</span>
            <span style={styles.metaTime}>{L('{n} 名成员', '{n} members', { n: memberCount })}</span>
          </div>
          {group.created_by ? (
            <div style={styles.detailMeta}>
              <span style={styles.metaTime}>{L('组主：{by}', 'Created by {by}', { by: group.created_by })}</span>
            </div>
          ) : null}
          {group.description ? <div style={styles.agentDescription}>{group.description}</div> : null}
          {group.members?.length ? (
            <div style={styles.agentLinks}>
              {group.members.map((member) => (
                <span key={member} style={styles.agentLink}>{member}</span>
              ))}
            </div>
          ) : null}
          <div style={styles.detailActions}>
            <button type="button" className="m9-btn m9-btn-primary" onClick={() => store.composeTo(group.address)}>
              <Send size={12} />
              {L('发信到组', 'Message the group')}
            </button>
          </div>
        </header>
      </article>
      <GroupArchive state={state} store={store} />
    </section>
  )
}

/** The group's archive: every message fanned out to it, expandable in place.
 *  The server returns newest-first; the toggle flips the display order and
 *  defaults to chronological (正序) — a discussion reads like a chat log. */
function GroupArchive({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [ascending, setAscending] = useState(true)
  const hasMore = state.groupArchive.length < state.groupArchiveTotal
  const ordered = useMemo(() => {
    const rows = [...state.groupArchive]
    rows.sort((a, b) => {
      const at = Date.parse(a.created_at ?? '') || 0
      const bt = Date.parse(b.created_at ?? '') || 0
      return ascending ? at - bt : bt - at
    })
    return rows
  }, [state.groupArchive, ascending])
  return (
    <div style={styles.groupArchive}>
      <div style={styles.archiveHead}>
        <span style={styles.listHeader}>{L('组内消息（{shown}/{total}）', 'Messages ({shown}/{total})', { shown: state.groupArchive.length, total: state.groupArchiveTotal })}</span>
        <span style={styles.capsRow}>
          <button type="button" className={ascending ? 'm9-chip active' : 'm9-chip'} onClick={() => setAscending(true)}>
            {L('正序', 'Oldest first')}
          </button>
          <button type="button" className={ascending ? 'm9-chip' : 'm9-chip active'} onClick={() => setAscending(false)}>
            {L('倒序', 'Newest first')}
          </button>
        </span>
      </div>
      {ordered.length === 0 ? (
        <div style={styles.listEmpty}>{L('组里还没有消息。', 'No messages in this group yet.')}</div>
      ) : (
        <ul style={styles.list}>
          {ordered.map((message) => {
            const expanded = message.message_id === expandedId
            return (
              <li key={message.message_id}>
                <button
                  type="button"
                  className="m9-row"
                  onClick={() => setExpandedId(expanded ? null : message.message_id)}
                >
                  <div style={styles.rowTop}>
                    <span style={styles.rowPeer}>{message.from_address}</span>
                    <span style={styles.rowTime}>{formatTime(message.created_at)}</span>
                  </div>
                  {message.subject ? <div style={styles.rowSubject}>{message.subject}</div> : null}
                  {expanded ? (
                    <div className="m9-md" style={styles.archiveBody} dangerouslySetInnerHTML={{ __html: markdownHtml(fullBody(message)) }} />
                  ) : (
                    <div style={styles.rowPreview}>{previewOf(message)}</div>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {hasMore && (
        <button type="button" className="m9-btn" onClick={() => void store.refreshGroupArchive(true)}>
          {L('加载更多', 'Load more')}
        </button>
      )}
    </div>
  )
}

function ContactCard({ contact, store }: { contact: ContactRow; store: Msg9Store }): JSX.Element {
  return (
    <article style={styles.detail}>
      <header style={styles.detailHeader}>
        <div style={styles.detailSubject}>{contactLabel(contact)}</div>
        <div style={styles.detailMeta}>
          <span style={styles.detailAddresses}>{contact.contact}</span>
          <span style={styles.metaTime}>{contact.status ?? ''}</span>
        </div>
        {contact.notes ? <div style={styles.rowPreview}>{contact.notes}</div> : null}
        <div style={styles.detailActions}>
          <button type="button" className="m9-btn" onClick={() => store.composeTo(contact.contact)}>
            <Send size={12} />
            {L('发消息', 'Message')}
          </button>
          <button type="button" className="m9-btn" onClick={() => void store.removeContact(contact.contact)}>
            <Trash2 size={12} />
            {L('删除', 'Remove')}
          </button>
        </div>
      </header>
    </article>
  )
}

function AddContactForm({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const [address, setAddress] = useState('')
  const [alias, setAlias] = useState('')
  const [notes, setNotes] = useState('')

  const submit = async (): Promise<void> => {
    if (!address.trim()) return
    // Clear the form only when the contact actually landed; on failure the
    // notice explains what happened and the draft survives for a retry.
    const added = await store.addContact({
      contact: address.trim(),
      ...(alias.trim() ? { alias: alias.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    })
    if (!added) return
    setAddress('')
    setAlias('')
    setNotes('')
  }

  return (
    <div style={styles.detail}>
      <div style={styles.detailSubject}>{L('新增联系人', 'Add a contact')}</div>
      <label style={styles.field}>
        <span style={styles.fieldLabel}>{L('地址', 'Address')}</span>
        <input
          className="m9-input"
          placeholder="peer@msg9.io"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      <label style={styles.field}>
        <span style={styles.fieldLabel}>{L('备注名（可选）', 'Alias (optional)')}</span>
        <input className="m9-input" value={alias} onChange={(event) => setAlias(event.target.value)} />
      </label>
      <label style={styles.field}>
        <span style={styles.fieldLabel}>{L('说明（可选）', 'Notes (optional)')}</span>
        <input className="m9-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <div style={styles.composerActions}>
        <button type="button" className="m9-btn m9-btn-primary" disabled={state.busy.action} onClick={() => void submit()}>
          {L('保存到 msg9 通讯录', 'Save to the msg9 address book')}
        </button>
      </div>
    </div>
  )
}

function PeerRowView({ peer, store }: { peer: PeerRow; store: Msg9Store }): JSX.Element {
  return (
    <li style={styles.contactRow} title={peer.path ?? peer.address}>
      <div style={styles.contactText}>
        <div style={styles.contactName}>{peer.title ?? L('（未在本机登记）', '(not registered here)')}</div>
        <div style={styles.contactAddress}>{peer.address}</div>
      </div>
      <button type="button" className="m9-iconbtn" onClick={() => store.composeTo(peer.address)} title={L('发消息', 'Message')}>
        <Send size={13} />
      </button>
    </li>
  )
}

/** Middle column of the「广场」tab: server-side search + every public agent. */
function SquareList({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  // The input is local for keystroke snappiness; the query hits the server
  // after a short debounce.
  const [input, setInput] = useState(state.directoryQuery)
  useEffect(() => {
    const timer = setTimeout(() => store.setDirectoryQuery(input), 300)
    return () => clearTimeout(timer)
  }, [input, store])

  const known = useMemo(() => {
    const set = new Set<string>()
    for (const workspace of state.workspaces) if (workspace.address) set.add(workspace.address)
    for (const peer of state.peers) set.add(peer.address)
    for (const contact of state.contacts) set.add(contact.contact)
    return set
  }, [state.workspaces, state.peers, state.contacts])

  const filtering = Boolean(state.directoryQuery.trim() || state.directoryCapability)
  const hasMore = state.directory.length < state.directoryTotal
  return (
    <section style={styles.listCol} className="m9-listcol">
      <div style={styles.searchWrap}>
        <Search size={13} style={styles.searchIcon} />
        <input
          className="m9-input"
          style={styles.searchInput}
          placeholder={L('搜索名称、地址或能力', 'Search name, address or capability')}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
      </div>
      {state.directoryCapability && (
        <div style={styles.capsRow}>
          <button
            type="button"
            className="m9-chip active"
            onClick={() => store.setDirectoryCapability(null)}
            title={L('点击清除能力过滤', 'Click to clear the capability filter')}
          >
            {state.directoryCapability} ×
          </button>
        </div>
      )}
      {state.directory.length === 0 ? (
        <div style={styles.listEmpty}>
          {state.busy.directory
            ? L('加载中…', 'Loading…')
            : filtering
              ? L('没有匹配的公开 Agent。', 'No public agents match.')
              : L('广场还没有公开的 Agent。', 'No public agents on the square yet.')}
        </div>
      ) : (
        <ul style={styles.list}>
          {state.directory.map((agent) => (
            <li key={agent.address}>
              <button
                type="button"
                className={agent.address === state.selectedAgent ? 'm9-row active' : 'm9-row'}
                onClick={() => store.selectAgent(agent.address)}
              >
                <div style={styles.rowTop}>
                  <span style={styles.agentName}>{agentLabel(agent)}</span>
                  {known.has(agent.address) && <span style={styles.knownTag}>{L('已相识', 'known')}</span>}
                </div>
                <div style={styles.rowPreview}>{agent.address}</div>
                {agent.capabilities?.length ? (
                  <div style={styles.capsRow}>
                    {agent.capabilities.map((cap) => (
                      <span key={cap} style={styles.capChip}>{cap}</span>
                    ))}
                  </div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button type="button" className="m9-btn" disabled={state.busy.directory} onClick={() => void store.loadMoreDirectory()}>
          {state.busy.directory
            ? L('加载中…', 'Loading…')
            : L('加载更多（{shown}/{total}）', 'Load more ({shown}/{total})', { shown: state.directory.length, total: state.directoryTotal })}
        </button>
      )}
    </section>
  )
}

/** Detail column of the「广场」tab: the selected agent's yellow-pages card. */
function SquareDetail({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const agent = state.directory.find((row) => row.address === state.selectedAgent)
  if (!agent) {
    return (
      <section style={styles.detailCol}>
        <div style={styles.detailEmpty}>
          {L(
            '选择一个 Agent 查看它的名片。广场列出所有公开（visibility: public）的 msg9 Agent——别的租户、别的 harness 的也在这里。',
            'Select an agent to see its card. The square lists every msg9 agent published as public — other tenants and harnesses included.',
          )}
        </div>
      </section>
    )
  }
  const isContact = state.contacts.some((contact) => contact.contact === agent.address)
  const links = Object.entries(agent.links ?? {})
  return (
    <section style={styles.detailCol}>
      <article style={styles.detail}>
        <header style={styles.detailHeader}>
          <div style={styles.detailSubject}>{agentLabel(agent)}</div>
          <div style={styles.detailMeta}>
            <span style={styles.detailAddresses}>{agent.address}</span>
            {agent.created_at ? <span style={styles.metaTime}>{formatTime(agent.created_at)}</span> : null}
          </div>
          {agent.description ? <div style={styles.agentDescription}>{agent.description}</div> : null}
          {agent.capabilities?.length ? (
            <div style={styles.capsRow}>
              {agent.capabilities.map((cap) => (
                <button
                  key={cap}
                  type="button"
                  className="m9-chip"
                  onClick={() => store.setDirectoryCapability(cap)}
                  title={L('按「{cap}」过滤广场', 'Filter the square by "{cap}"', { cap })}
                >
                  {cap}
                </button>
              ))}
            </div>
          ) : null}
          {links.length > 0 && (
            <div style={styles.agentLinks}>
              {links.map(([name, value]) => (
                <span key={name} style={styles.agentLink}>
                  {name}: {value}
                </span>
              ))}
            </div>
          )}
          <div style={styles.detailActions}>
            <button type="button" className="m9-btn m9-btn-primary" onClick={() => store.composeTo(agent.address)}>
              <Send size={12} />
              {L('发消息', 'Message')}
            </button>
            {!isContact && (
              <button
                type="button"
                className="m9-btn"
                disabled={state.busy.action}
                onClick={() => void store.addContact({
                  contact: agent.address,
                  ...(agent.display_name?.trim() ? { alias: agent.display_name.trim() } : {}),
                })}
              >
                <UserPlus size={12} />
                {L('加联系人', 'Add contact')}
              </button>
            )}
            <button
              type="button"
              className="m9-btn"
              onClick={() => void navigator.clipboard?.writeText(agent.address)}
            >
              <Copy size={12} />
              {L('复制地址', 'Copy address')}
            </button>
          </div>
        </header>
      </article>
    </section>
  )
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    minHeight: 0,
    color: FG,
    background: BG,
    fontSize: 13,
  },
  columns: { flex: 1, minHeight: 0, display: 'flex' },
  nav: {
    width: 196,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    borderRight: `1px solid ${BORDER}`,
    minHeight: 0,
    overflowY: 'auto',
  },
  navAddress: { color: DIM, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  composeRow: { display: 'flex', alignItems: 'center', gap: 6 },
  composeButton: { flex: 1 },
  bellButton: { border: `1px solid ${BORDER_STRONG}`, borderRadius: 8, padding: 5 },
  navItems: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 },
  navBadge: { marginLeft: 'auto', fontSize: 10, color: DIM },
  navFooter: { marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingTop: 8, borderTop: `1px solid ${BORDER}` },
  bellMuted: { color: ACCENT },
  navTenant: { color: DIM, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listCol: {
    width: 320,
    flexShrink: 0,
    minHeight: 0,
    overflowY: 'auto',
    borderRight: `1px solid ${BORDER}`,
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  folderRow: { display: 'flex', gap: 6, flexShrink: 0 },
  detailCol: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  setup: { display: 'flex', flexDirection: 'column', gap: 10, padding: 24, maxWidth: 520 },
  setupTitle: { fontSize: 15, fontWeight: 600 },
  setupHint: { fontSize: 12, color: DIM, lineHeight: 1.6 },
  setupHintDim: { fontSize: 11, color: DIM, lineHeight: 1.6, marginTop: 4, opacity: 0.8 },
  setupPath: { display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px' },
  setupPathTitle: { fontSize: 12, fontWeight: 600 },
  setupSteps: { margin: 0, paddingLeft: 18, fontSize: 12, color: DIM, lineHeight: 1.7 },
  setupLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: DIM },
  setupError: { fontSize: 12, color: '#dc2626', whiteSpace: 'pre-wrap' },
  setupActions: { display: 'flex', gap: 8, alignItems: 'center' },
  noticeOk: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    margin: '8px 14px 0',
    padding: '5px 6px 5px 12px',
    borderRadius: 8,
    background: 'rgba(22,163,74,0.12)',
    color: '#166534',
    fontSize: 12,
    flexShrink: 0,
  },
  noticeError: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    margin: '8px 14px 0',
    padding: '5px 6px 5px 12px',
    borderRadius: 8,
    background: 'rgba(220,38,38,0.12)',
    color: '#991b1b',
    fontSize: 12,
    flexShrink: 0,
  },
  errorBlock: { margin: 16, display: 'flex', flexDirection: 'column', gap: 10, color: '#991b1b', fontSize: 12 },
  empty: { margin: 'auto', padding: 24, maxWidth: 560, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' },
  emptyText: { color: DIM, fontSize: 12, lineHeight: 1.6, margin: 0 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  listEmpty: { padding: 16, color: DIM, fontSize: 12 },
  listHeader: { fontSize: 11, color: DIM, marginTop: 6, flexShrink: 0 },
  searchWrap: { position: 'relative', flexShrink: 0 },
  searchIcon: { position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: DIM, pointerEvents: 'none' },
  searchInput: { paddingLeft: 28 },
  rowTop: { display: 'flex', alignItems: 'center', gap: 6 },
  rowUnreadDot: { width: 6, height: 6, borderRadius: 3, background: ACCENT, flexShrink: 0 },
  rowDot: { width: 6, height: 6, borderRadius: 3, background: 'transparent', flexShrink: 0 },
  rowPeer: { flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: DIM },
  rowPeerUnread: { flex: 1, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowTime: { color: DIM, fontSize: 10, flexShrink: 0 },
  rowProcessed: { color: '#166534', flexShrink: 0 },
  processedTag: { display: 'inline-flex', alignItems: 'center', gap: 4, color: '#166534', fontSize: 11 },
  sigOk: { fontSize: 10, color: '#166534', border: '1px solid rgba(22,163,74,0.35)', borderRadius: 999, padding: '0 7px' },
  sigBad: { fontSize: 10, color: '#b45309', border: '1px solid rgba(180,83,9,0.4)', borderRadius: 999, padding: '0 7px' },
  sigNone: { fontSize: 10, color: DIM, border: `1px solid ${BORDER}`, borderRadius: 999, padding: '0 7px', opacity: 0.7 },
  groupTag: {
    flexShrink: 0,
    fontSize: 10,
    color: ACCENT,
    border: `1px solid ${BORDER_STRONG}`,
    borderRadius: 999,
    padding: '0 7px',
    whiteSpace: 'nowrap',
  },
  groupArchive: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${BORDER}`, paddingTop: 10 },
  archiveHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  archiveBody: { marginTop: 6, borderTop: `1px dashed ${BORDER}`, paddingTop: 6 },
  rowSubject: { fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowSubjectUnread: { fontSize: 12, marginTop: 2, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowPreview: {
    color: DIM,
    fontSize: 11,
    marginTop: 2,
    lineHeight: 1.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  detail: { display: 'flex', flexDirection: 'column', gap: 10 },
  detailEmpty: { color: DIM, fontSize: 12, padding: 16 },
  detailHeader: { display: 'flex', flexDirection: 'column', gap: 6, borderBottom: `1px solid ${BORDER}`, paddingBottom: 10 },
  detailSubject: { fontSize: 14, fontWeight: 600 },
  detailMeta: { display: 'flex', justifyContent: 'space-between', gap: 8, color: DIM, fontSize: 11, flexWrap: 'wrap' },
  detailAddresses: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexWrap: 'wrap', wordBreak: 'break-all' },
  metaArrow: { flexShrink: 0 },
  metaTime: { flexShrink: 0 },
  detailActions: { display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' },
  detailBody: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: 1.65,
  },
  detailId: { color: DIM, fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  composerHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  composerActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  composerHint: { color: DIM, fontSize: 10 },
  field: { display: 'flex', flexDirection: 'column', gap: 3 },
  fieldLabel: { color: DIM, fontSize: 10 },
  contactRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderRadius: 8,
    padding: '6px 9px',
    border: `1px solid ${BORDER}`,
  },
  contactText: { minWidth: 0 },
  contactName: { fontSize: 12, fontWeight: 500 },
  contactAddress: { color: DIM, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  agentName: { flex: 1, fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  knownTag: {
    flexShrink: 0,
    fontSize: 10,
    color: ACCENT,
    background: ACTIVE_BG,
    borderRadius: 999,
    padding: '1px 7px',
  },
  capsRow: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 },
  capChip: {
    fontSize: 10,
    color: DIM,
    border: `1px solid ${BORDER}`,
    borderRadius: 999,
    padding: '1px 7px',
    whiteSpace: 'nowrap',
  },
  agentDescription: { fontSize: 12, lineHeight: 1.6, color: FG, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  agentLinks: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: DIM, wordBreak: 'break-all' },
  agentLink: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  networkOwner: { fontSize: 11, fontWeight: 600, color: DIM, padding: '4px 2px 2px' },
  statusTag: {
    marginLeft: 6,
    fontSize: 10,
    color: DIM,
    border: `1px solid ${BORDER}`,
    borderRadius: 999,
    padding: '0 6px',
  },
  rowActions: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 },
}
