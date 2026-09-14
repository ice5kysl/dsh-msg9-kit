/**
 * Settings → 消息信箱 (Messages): the msg9 service intro, the bound tenant,
 * and every inbox this tenant has opened.
 *
 * Read-only inventory — day-to-day mailing lives in the「消息」view tab; this
 * page answers "what is msg9, which tenant am I bound to, and which
 * workspaces have an inbox here?". When the tenant was switched and some
 * inboxes still live under the old one, a migration card offers to move them
 * (new tenant-domain address, optional suspension of the old inbox).
 *
 * @module dsh-msg9-kit/client-settings
 */

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Mail } from './icons.tsx'
import { L } from './locale.ts'
import { SetupView } from './Msg9Panel.tsx'
import type { Msg9State, Msg9Store } from './store.ts'
import { ACCENT, BORDER, DIM, FG, M9_CSS } from './theme.ts'
import { badgeText } from './view.ts'

/** Props handed to the section: the injected store (owner prop `close` unused). */
export interface Msg9SettingsSectionProps {
  store: Msg9Store
  close?: () => void
}

export function Msg9SettingsSection(props: Msg9SettingsSectionProps): JSX.Element {
  const { store } = props
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)

  // The settings page can be the first surface the user opens.
  useEffect(() => {
    void store.refreshOverview()
    void store.refreshUnread()
    void store.refreshPeers()
  }, [store])

  const provisioned = state.workspaces.filter((row) => row.provisioned)
  const pending = state.workspaces.filter((row) => !row.provisioned)
  const peerByAddress = new Map(state.peers.map((peer) => [peer.address, peer]))

  return (
    <div style={styles.wrap}>
      <style>{M9_CSS}</style>
      <section style={styles.card}>
        <div style={styles.cardTitle}>msg9.io</div>
        <div style={styles.dim}>
          {L(
            'msg9 是给 Agent 用的邮件服务：每个 dsh workspace 一个信箱，Agent 用工具收发，你在「消息」页签里看同一个邮箱。兄弟 workspace 之间可以互发消息，跨项目同步信息。',
            'msg9 is email for agents: one inbox per dsh workspace — the agent mails through tools while you read the same mailbox in the "Messages" view tab. Sibling workspaces can message each other to sync across projects.',
          )}
        </div>
      </section>

      <section style={styles.card}>
        <div style={styles.cardTitle}>{L('租户', 'Tenant')}</div>
        {state.status === 'loading' ? (
          // 首次 overview 未回来：是否绑定租户还是未知数，先显示加载态，
          // 避免已绑定实例在设置页闪一下「绑定租户」表单。
          <div style={styles.dim}>{L('加载中…', 'Loading…')}</div>
        ) : state.owner ? (
          <dl style={styles.fields}>
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>{L('名称', 'Name')}</dt>
              <dd style={styles.fieldValue}>{state.owner.name ?? '—'}</dd>
            </div>
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>ID</dt>
              <dd style={styles.fieldValue}>{state.owner.id ?? '—'}</dd>
            </div>
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>{L('租户域名', 'Domain')}</dt>
              <dd style={styles.fieldValue}>
                {state.owner.address_domain ?? (state.owner.slug
                  ? `${state.owner.slug}.${state.owner.mail_domain ?? 'msg9.io'}`
                  : L('未分配（扁平 @msg9.io）', 'none (flat @msg9.io)'))}
              </dd>
            </div>
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>Key</dt>
              <dd style={styles.fieldValue}>{state.owner.masked}</dd>
            </div>
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>API</dt>
              <dd style={styles.fieldValue}>{state.apiUrl}</dd>
            </div>
          </dl>
        ) : (
          <SetupView state={state} store={store} />
        )}
      </section>

      <section style={styles.card}>
        <div style={styles.cardTitle}>{L('已开通的信箱（{n}）', 'Open inboxes ({n})', { n: provisioned.length })}</div>
        {provisioned.length === 0 ? (
          <div style={styles.dim}>
            {L(
              '还没有开通任何信箱。在会话里让 Agent 调用 msg9_inbox，或在「消息」页签里点「开通收件箱」。',
              'No inboxes yet. Ask the agent to run msg9_inbox in a session, or use "Open inbox" in the "Messages" view tab.',
            )}
          </div>
        ) : (
          <ul style={styles.list}>
            {provisioned.map((row) => {
              const unread = state.unreadByKey[row.key] ?? 0
              const mailboxSize = state.totalByKey[row.key]
              const badge = badgeText(unread)
              const peer = peerByAddress.get(row.address ?? '')
              return (
                <li key={row.key} style={styles.row}>
                  <Mail size={14} style={styles.rowIcon} />
                  <div style={styles.rowText}>
                    <div style={styles.rowTitle}>{row.title}</div>
                    <div style={styles.dim}>{row.address}</div>
                    {peer?.description ? <div style={styles.role}>{peer.description}</div> : null}
                    {peer?.capabilities?.length ? (
                      <div style={styles.caps}>{peer.capabilities.join(' · ')}</div>
                    ) : null}
                    <div style={styles.path}>{row.path}</div>
                  </div>
                  <div style={styles.rowStats}>
                    {mailboxSize !== undefined ? (
                      <span style={styles.dim}>
                        {L('{unread} 未读 · 共 {total} 封', '{unread} unread · {total} total', { unread, total: mailboxSize })}
                      </span>
                    ) : null}
                    {badge ? <span style={styles.badge}>{badge}</span> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {pending.length > 0 ? (
          <div style={styles.pending}>
            <span style={styles.dim}>{L('尚未开通：', 'Not opened yet:')}</span>
            <PendingChips titles={pending.map((row) => row.title)} />
          </div>
        ) : null}
      </section>

      <MigrationCard state={state} store={store} />
    </div>
  )
}

/** 尚未开通的 workspace：flex wrap 小 chips，最多显示 8 个，超出「…等 N 个」。
 *  导出以便测试直接驱动截断逻辑。 */
export function PendingChips({ titles }: { titles: string[] }): JSX.Element {
  const shown = titles.slice(0, 8)
  const rest = titles.length - shown.length
  return (
    <span style={styles.pendingChips}>
      {shown.map((title) => (
        <span key={title} style={styles.pendingChip}>{title}</span>
      ))}
      {rest > 0 && <span style={styles.pendingChip}>{L('…等 {n} 个', '…and {n} more', { n: rest })}</span>}
    </span>
  )
}

/** Tenant switch aftermath: move legacy inboxes to the current tenant. */
function MigrationCard({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element | null {
  const [oldKey, setOldKey] = useState('')
  const legacyRows = state.workspaces.filter((row) => row.provisioned && row.legacy)
  if (!state.owner?.slug || legacyRows.length === 0) return null

  return (
    <section style={styles.card}>
      <div style={styles.cardTitle}>{L('迁移到新租户（{n}）', 'Migrate to the new tenant ({n})', { n: legacyRows.length })}</div>
      <div style={styles.dim}>
        {L(
          '以下收件箱还开在旧租户下（域名不是 {domain}）。迁移会在新租户下按地址规范重新开通，并给旧地址设置转发（新邮件自动进新信箱，旧地址不会被他人注册）。',
          'These inboxes still live under the previous tenant (not on {domain}). Migrating re-opens them under the new tenant with the naming spec and sets forwarding on the old address (new mail lands in the new mailbox; the old address stays reserved).',
          { domain: state.owner.address_domain ?? `${state.owner.slug}.${state.owner.mail_domain ?? 'msg9.io'}` },
        )}
      </div>
      <label style={styles.migrateKeyRow}>
        <span style={styles.dim}>{L('旧租户 key（可选，用于搬运同租户历史邮件并停用旧收件箱）', 'Old tenant key (optional — moves same-tenant history and suspends the old inbox)')}</span>
        <input
          className="m9-input"
          type="password"
          value={oldKey}
          autoComplete="off"
          spellCheck={false}
          placeholder="msg9_tk_…"
          onChange={(event) => setOldKey(event.target.value)}
        />
      </label>
      <ul style={styles.list}>
        {legacyRows.map((row) => (
          <li key={row.key} style={styles.row}>
            <div style={styles.rowText}>
              <div style={styles.rowTitle}>{row.title}</div>
              <div style={styles.dim}>{row.address}</div>
              {row.planned_address ? <div style={styles.caps}>→ {row.planned_address}</div> : null}
            </div>
            <button
              type="button"
              className="m9-btn m9-btn-primary"
              disabled={state.busy.action}
              onClick={() => void store.migrate(row.key, oldKey || undefined)}
            >
              {state.busy.action ? L('迁移中…', 'Migrating…') : L('迁移', 'Migrate')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 20, padding: '16px 0', maxWidth: 640, color: FG, fontSize: 13 },
  card: { display: 'flex', flexDirection: 'column', gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: 600 },
  fields: { margin: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  fieldRow: { display: 'flex', gap: 12, fontSize: 13 },
  fieldName: { flex: 'none', width: 72, color: DIM, fontSize: 12 },
  fieldValue: { margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dim: { fontSize: 12, color: DIM, lineHeight: 1.6 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 0',
    borderTop: `1px solid ${BORDER}`,
  },
  rowIcon: { flexShrink: 0, color: DIM },
  rowText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
  rowTitle: { fontSize: 13, fontWeight: 500 },
  role: { fontSize: 11, color: FG, lineHeight: 1.5 },
  caps: { fontSize: 10, color: ACCENT, lineHeight: 1.5 },
  path: { fontSize: 11, color: DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowStats: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  badge: {
    minWidth: 18,
    height: 18,
    padding: '0 5px',
    borderRadius: 9,
    background: ACCENT,
    color: '#ffffff',
    fontSize: 11,
    lineHeight: '18px',
    textAlign: 'center',
    fontWeight: 600,
  },
  pending: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: DIM, borderTop: `1px solid ${BORDER}`, paddingTop: 8 },
  pendingChips: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 44, overflow: 'hidden' },
  pendingChip: { fontSize: 11, color: DIM, border: `1px solid ${BORDER}`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' },
  migrateKeyRow: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 380 },
}
