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

      {/* ① 介绍 + 注册/登录引导（主人 2026-09-30 定的三步结构之首） */}
      <section style={styles.card}>
        <div style={styles.cardTitle}>msg9.io</div>
        <div style={styles.dim}>
          {L(
            'msg9 是给 Agent 用的邮件服务：每个 dsh workspace 一个信箱，Agent 用工具收发，你在「消息」页签里看同一个邮箱。兄弟 workspace 之间可以互发消息，跨项目同步信息。',
            'msg9 is email for agents: one inbox per dsh workspace — the agent mails through tools while you read the same mailbox in the "Messages" view tab. Sibling workspaces can message each other to sync across projects.',
          )}
        </div>
        <div style={styles.dim}>
          {L('还没有账号？', "No account yet? ")}
          <a href="https://msg9.io" target="_blank" rel="noreferrer noopener" style={styles.link}>
            {L('打开 msg9.io 注册 / 登录 →', 'Open msg9.io to sign up / log in →')}
          </a>
        </div>
      </section>

      {/* ② 引导创建并录入 ORG key（只绑定，不开 Pod） */}
      <OrgCard state={state} store={store} />

      {/* ③ workspace 清单：基础信息 + 是否开通 Pod + 可点「开通」+ pod slug 可改 */}
      <WorkspaceCard state={state} store={store} />

      {provisioned.length > 0 && (
        <section style={styles.card}>
          <div style={styles.cardTitle}>{L('已开通的信箱（{n}）', 'Open inboxes ({n})', { n: provisioned.length })}</div>
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
                    {row.address && <div style={styles.path}>{row.address}</div>}
                    {peer?.display_name && <div style={styles.role}>{peer.display_name}</div>}
                  </div>
                  <div style={styles.rowStats}>
                    {mailboxSize !== undefined && <span style={styles.dim}>{mailboxSize}</span>}
                    {badge && <span style={styles.badge}>{badge}</span>}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section style={styles.card}>
          <div style={styles.cardTitle}>{L('待开通（{n}）', 'Awaiting a pod ({n})', { n: pending.length })}</div>
          <div style={styles.pendingChips}>
            {pending.map((row) => (
              <span key={row.key} style={styles.pendingChip}>{row.title}</span>
            ))}
          </div>
        </section>
      )}

      {/* 旧租户下开通的信箱：仍提供迁移入口（换绑 ORG 后这条才有内容） */}
      <MigrationCard state={state} store={store} />
    </div>
  )
}

/**
 * ② 录入 ORG key。**只绑定，不开任何 Pod** ——
 * 这一步只回答"这套 dsh 实例属于哪个 ORG"，开通是下一张卡的逐行按钮。
 */
function OrgCard({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const [orgKey, setOrgKey] = useState('')
  const [label, setLabel] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const busy = state.orgForm.busy
  const bound = state.org

  return (
    <section style={styles.card}>
      <div style={styles.cardTitle}>{L('① ORG（组织）', '① ORG (organization)')}</div>
      {state.status === 'loading' ? (
        // overview 未回来 ⇒ 是否已绑 ORG 是未知数：先显示加载态，
        // 否则已绑定实例每次打开设置页都会闪一下「录入 ORG key」表单。
        <div style={styles.dim}>{L('加载中…', 'Loading…')}</div>
      ) : bound ? (
        <>
          <dl style={styles.fields}>
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>{L('名称', 'Label')}</dt>
              <dd style={styles.fieldValue}>{bound.label}</dd>
            </div>
            {bound.name && (
              <div style={styles.fieldRow}>
                <dt style={styles.fieldName}>ID</dt>
                <dd style={styles.fieldValue}>{bound.id ?? bound.name}</dd>
              </div>
            )}
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>Key</dt>
              <dd style={styles.fieldValue}>{bound.masked}</dd>
            </div>
            <div style={styles.fieldRow}>
              <dt style={styles.fieldName}>{L('已有 Pod', 'Pods')}</dt>
              <dd style={styles.fieldValue}>
                {bound.pod_count === null || bound.pod_count === undefined
                  ? L('未知（探测失败）', 'unknown (probe failed)')
                  : String(bound.pod_count)}
              </dd>
            </div>
          </dl>
          <div style={styles.dim}>
            {L(
              'ORG key 只用于开通 Pod，不参与收发信。改绑 ORG 不会动已开通的信箱。',
              'The ORG key only opens pods; it is never used to send or receive. Re-binding never touches already-open inboxes.',
            )}
          </div>
        </>
      ) : (
        <>
          <div style={styles.dim}>
            {L(
              '在 msg9.io 的 Account 页创建一个 ORG，复制它的 key（msg9_ok_…，只显示一次）粘到这里。每个项目对应一个 Pod，Pod 里放各 harness 的信箱。',
              'Create an ORG on the msg9.io Account page and paste its key (msg9_ok_…, shown once) here. One project = one pod, and each harness gets an inbox inside it.',
            )}
          </div>
          <form
            style={styles.orgForm}
            onSubmit={(event) => {
              event.preventDefault()
              if (busy || !orgKey.trim() || !label.trim()) return
              void store.bindOrg(orgKey, label, apiUrl.trim() || undefined)
            }}
          >
            <label style={styles.orgField}>
              {L('ORG key', 'ORG key')}
              <input
                className="m9-input"
                type="password"
                value={orgKey}
                autoComplete="off"
                spellCheck={false}
                placeholder="msg9_ok_…"
                onChange={(event) => setOrgKey(event.target.value)}
              />
            </label>
            <label style={styles.orgField}>
              {L('ORG 域名前缀（label）', 'ORG label')}
              <input
                className="m9-input"
                value={label}
                autoComplete="off"
                spellCheck={false}
                placeholder="ice"
                onChange={(event) => setLabel(event.target.value.toLowerCase())}
              />
            </label>
            <label style={styles.orgField}>
              {L('API 地址（可选，自建 msg9 时填）', 'API base (optional — self-hosted msg9)')}
              <input
                className="m9-input"
                value={apiUrl}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.msg9.io"
                onChange={(event) => setApiUrl(event.target.value)}
              />
            </label>
            <div style={styles.orgActions}>
              <button
                type="submit"
                className="m9-btn m9-btn-primary"
                disabled={busy || !orgKey.trim() || !label.trim()}
              >
                {busy ? L('校验中…', 'Checking…') : L('绑定 ORG', 'Bind ORG')}
              </button>
              <span style={styles.dim}>
                {L('只校验并保存，不会开通任何信箱。', 'Validated and saved only — nothing is provisioned.')}
              </span>
            </div>
            {state.orgForm.error && <div style={styles.errorText}>{state.orgForm.error}</div>}
          </form>
        </>
      )}
    </section>
  )
}

/**
 * ③ workspace 清单：基础信息 · 是否开通 Pod · 「开通」按钮 · pod slug 可人工改。
 *
 * **未绑定 ORG 时，"开通"按钮不可用**（而不是点下去才报错）——
 * 让不可用的原因在界面上直接可见。
 */
function WorkspaceCard({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const bound = Boolean(state.org)
  return (
    <section style={styles.card}>
      <div style={styles.cardTitle}>
        {L('② Workspace 与 Pod（{n}）', '② Workspaces & pods ({n})', { n: state.workspaces.length })}
      </div>
      {state.workspaces.length === 0 ? (
        <div style={styles.dim}>{L('还没有 workspace。', 'No workspaces yet.')}</div>
      ) : (
        <ul style={styles.list}>
          {state.workspaces.map((row) => (
            <WorkspaceRow key={row.key} row={row} state={state} store={store} orgBound={bound} />
          ))}
        </ul>
      )}
      {/* 只在 overview 回来后才有意义：加载中时"是否绑了 ORG"还是未知数，
          此时提示"先绑定 ORG key"会误导（也可能早就绑过了）。 */}
      {state.status !== 'loading' && !bound && (
        <div style={styles.dim}>
          {L(
            '先绑定 ORG key（上一节），才能开通 Pod。',
            'Bind an ORG key (previous section) before opening pods.',
          )}
        </div>
      )}
    </section>
  )
}

function WorkspaceRow({
  row, state, store, orgBound,
}: {
  row: Msg9State['workspaces'][number]
  state: Msg9State
  store: Msg9Store
  orgBound: boolean
}): JSX.Element {
  const pod = row.pod
  const unread = state.unreadByKey[row.key] ?? 0
  const mailboxSize = state.totalByKey[row.key]
  const badge = badgeText(unread)
  const opening = state.opening[row.key] ?? { busy: false, error: null }
  const [editLabel, setEditLabel] = useState<string | null>(null)

  const stateText = !pod || pod.state === 'unconfigured'
    ? L('未配置 ORG', 'No ORG')
    : pod.state === 'pod_closed'
      ? L('Pod 未开通', 'Pod closed')
      : L('已开通', 'Ready')

  return (
    <li style={styles.row}>
      <Mail size={14} style={styles.rowIcon} />
      <div style={styles.rowText}>
        <div style={styles.rowTitle}>{row.title}</div>
        <div style={styles.path}>{row.path}</div>
        <div style={styles.rowMeta}>
          <span style={pod?.state === 'ready' ? styles.ok : styles.warn}>{stateText}</span>
          {pod && (
            <>
              <span style={styles.dot}>·</span>
              <span>
                {L('Pod', 'Pod')}{' '}
                <code style={styles.code}>{pod.pod_label}</code>
                {pod.custom && <span style={styles.dim}>{L('（已自定义）', ' (custom)')}</span>}
              </span>
            </>
          )}
          {row.address && (
            <>
              <span style={styles.dot}>·</span>
              <span style={styles.code}>{row.address}</span>
            </>
          )}
        </div>
        {editLabel !== null && pod?.state !== 'ready' && (
          <div style={styles.rowMeta}>
            <input
              className="m9-input"
              style={styles.slugInput}
              value={editLabel}
              spellCheck={false}
              placeholder={pod?.pod_label ?? ''}
              onChange={(event) => setEditLabel(event.target.value.toLowerCase())}
            />
            <span style={styles.dim}>
              {L('开通前可改；对已开通的 Pod 无效。', 'Changeable before opening; no effect once open.')}
            </span>
          </div>
        )}
      </div>
      <div style={styles.rowStats}>
        {opening.error && <span style={styles.warn}>{L('开通失败', 'Failed')}</span>}
        {row.provisioned ? (
          <>
            {/* 未读 / 总数：改版前就有，这里补回来（信息不能因为换布局而丢） */}
            {mailboxSize !== undefined && (
              <span style={styles.dim}>
                {L('{unread} 未读 · 共 {total} 封', '{unread} unread · {total} total', {
                  unread, total: mailboxSize,
                })}
              </span>
            )}
            {badge ? <span style={styles.badge}>{badge}</span> : null}
          </>
        ) : (
          <>
            <button
              type="button"
              className="m9-btn"
              style={styles.smallBtn}
              onClick={() => setEditLabel(editLabel === null ? (pod?.pod_label ?? '') : null)}
              title={L('改 pod slug', 'Edit pod slug')}
            >
              {L('改 slug', 'Rename')}
            </button>
            <button
              type="button"
              className="m9-btn m9-btn-primary"
              style={styles.smallBtn}
              disabled={!orgBound || opening.busy}
              title={orgBound ? undefined : L('先绑定 ORG key', 'Bind an ORG key first')}
              onClick={() => void store.openPod(row.key)}
            >
              {opening.busy ? L('开通中…', 'Opening…') : L('开通', 'Open pod')}
            </button>
          </>
        )}
      </div>
    </li>
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
  // ORG pods report no slug; the tenant domain lives in `address_domain`, so
  // gating on slug alone hid this card exactly when it was needed.
  if (!(state.owner?.address_domain || state.owner?.slug) || legacyRows.length === 0) return null

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
  // --- ORG 卡（设置页第 ② 步）---
  link: { color: ACCENT, textDecoration: 'none' },
  orgForm: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 },
  orgField: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: DIM },
  orgActions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  errorText: { fontSize: 12, color: '#d9534f', lineHeight: 1.5 },
  // --- workspace 行（设置页第 ③ 步）---
  rowMeta: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: DIM },
  dot: { color: DIM },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
  ok: { color: ACCENT },
  warn: { color: '#d9534f' },
  smallBtn: { fontSize: 11, padding: '2px 8px' },
  slugInput: { width: 140, fontSize: 11, padding: '2px 6px' },
}
