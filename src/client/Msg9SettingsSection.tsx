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

      {/* ③ workspace 清单：基础信息 + Pod 状态 + 「开通」+ pod slug 可改。
          —— 这一节已完整覆盖"哪些开了、哪些没开"，所以**不再另开
          「已开通的信箱」与「待开通」两块**：那是同一份数据的第二次陈列，
          同一批 workspace 出现两次只会让人以为它们是不同的东西。 */}
      <WorkspaceCard state={state} store={store} />

      {/* 归位提示：列出"开在别的 pod 下"的信箱（**只读判断，不做批量迁移**） */}
      <PlacementCard state={state} />
    </div>
  )
}

/**
 * ② 录入 ORG key。**只绑定，不开任何 Pod** ——
 * 这一步只回答"这套 dsh 实例属于哪个 ORG"，开通是下一张卡的逐行按钮。
 */
function OrgCard({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const [orgKey, setOrgKey] = useState('')
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
              if (busy || !orgKey.trim()) return
              void store.bindOrg(orgKey, apiUrl.trim() || undefined)
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
            {/* ORG label 不在这里填：规范说它「不可变」，是建 ORG 时定的，
                插件从 GET /api/v1/org 读回来。让用户填只会填错。 */}
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
                disabled={busy || !orgKey.trim()}
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
  const [confirmRemove, setConfirmRemove] = useState(false)

  const stateText = !pod || pod.state === 'unconfigured'
    ? L('未配置 ORG', 'No ORG')
    : pod.state === 'pod_closed'
      ? L('Pod 未开通', 'Pod closed')
      : L('已开通', 'Ready')

  return (
    <li style={styles.row}>
      <Mail size={14} style={styles.rowIcon} />
      <div style={styles.rowText}>
        {/* 第 1 层：workspace 本身 */}
        <div style={styles.rowTitle}>{row.title}</div>
        <div style={styles.path}>{row.path}</div>

        {/* 健康判断：僵尸 / 重复。**从地址看不出来，所以必须标出来。** */}
        {row.health?.pathMissing && (
          <div style={styles.rowMeta}>
            <span style={styles.warn}>{L('⚠ 目录已不存在', '⚠ directory is gone')}</span>
            <span style={styles.dim}>
              {L('（仓库搬走了，这条记录是残留）', '(the repo moved; this record is a leftover)')}
            </span>
          </div>
        )}
        {row.health?.duplicateOf && (
          <div style={styles.rowMeta}>
            <span style={styles.warn}>{L('⚠ 与另一条记录共用同一地址', '⚠ shares an address with another record')}</span>
            <code style={styles.code}>{row.health.duplicateOf}</code>
          </div>
        )}

        {/* 第 2 层：Pod —— 显示它自己的状态与用量（不是这个 workspace 的消息数） */}
        <div style={styles.layerRow}>
          <span style={styles.layerTag}>{L('Pod', 'Pod')}</span>
          {pod ? (
            <>
              <code style={styles.code}>{pod.pod_label}</code>
              {pod.custom && <span style={styles.dim}>{L('（已自定义）', ' (custom)')}</span>}
              {pod.domain && <span style={styles.code}>{pod.domain}</span>}
              {/* 已开 agent 数 / 上限 —— 这才是 Pod 的真实状态 */}
              <span style={pod.state === 'ready' ? styles.ok : styles.warn}>{stateText}</span>
              <span style={styles.dim}>
                {pod.agents === null || pod.agents === undefined
                  ? L('agent —（未探测到）', 'agents — (not probed)')
                  : L('{n} / {max} 个 Agent 信箱', '{n} / {max} inboxes', {
                      n: pod.agents, max: pod.max_agents ?? '—',
                    })}
              </span>
            </>
          ) : (
            <span style={styles.dim}>{L('（此 workspace 尚无 Pod）', '(no pod yet)')}</span>
          )}
        </div>

        {/* 第 3 层：Agent 信箱地址 */}
        {row.address && (
          <div style={styles.layerRow}>
            <span style={styles.layerTag}>{L('Agent', 'Agent')}</span>
            <code style={styles.code}>{row.address}</code>
          </div>
        )}

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
          // 消息数**不在这里**显示（那属于「消息」页签）；这里只留未读徽标做提示。
          badge ? <span style={styles.badge}>{badge}</span> : null
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
        {/* 人工移除：**只在判断为安全时出现**，且永不触碰远端信箱 */}
        {row.health?.removable && (row.health.pathMissing || row.health.duplicateOf) && (
          <button
            type="button"
            className="m9-btn"
            style={styles.smallBtn}
            title={L('只移除本地记录，不动远端信箱', 'Removes the local record only — the remote inbox is untouched')}
            onClick={() => setConfirmRemove(true)}
          >
            {L('移除记录', 'Remove')}
          </button>
        )}
      </div>
      {confirmRemove && (
        <RemoveConfirm row={row} store={store} onClose={() => setConfirmRemove(false)} />
      )}
    </li>
  )
}

/**
 * 移除确认。**说清楚会发生什么**，并且明确区分"本地记录"与"远端信箱"：
 *
 * 移除只做一件事 —— 删掉 `~/.msg9/projects/<harness>/<project-key>.yaml(/.signing.yaml)`
 * 与 state 里那条 workspace 记录。
 * **不调用任何远端接口**（不 disable、不 purge、不删信）。
 *
 * 若该地址还有别的记录持有，会一并说明"信箱仍由谁管"，避免用户以为信箱没了。
 */
function RemoveConfirm({
  row, store, onClose,
}: {
  row: Msg9State['workspaces'][number]
  store: Msg9Store
  onClose: () => void
}): JSX.Element {
  const busy = false
  return (
    <div style={styles.confirmBox}>
      <div style={styles.rowMeta}>
        <strong>{L('移除这条记录？', 'Remove this record?')}</strong>
      </div>
      <ul style={styles.confirmList}>
        <li>{L('只删本地记录（凭据文件 + 热状态），不调用任何远端接口。',
              'Deletes the local record only (credential files + hot state); no remote call.')}</li>
        {row.address && row.health?.duplicateOf
          ? <li>{L('信箱 {address} 仍由另一条记录管理，收发不受影响。',
                  'Inbox {address} stays managed by the other record; mail is unaffected.',
                  { address: row.address })}</li>
          : null}
        {row.health?.pathMissing
          ? <li>{L('目录 {path} 已不存在，这条记录不会再被用到。',
                  'Directory {path} no longer exists, so this record is already unused.',
                  { path: row.path })}</li>
          : null}
      </ul>
      <div style={styles.orgActions}>
        <button
          type="button"
          className="m9-btn m9-btn-primary"
          style={styles.smallBtn}
          disabled={busy}
          onClick={() => void store.removeWorkspace(row.key).then(onClose)}
        >
          {L('确认移除', 'Remove')}
        </button>
        <button type="button" className="m9-btn" style={styles.smallBtn} onClick={onClose}>
          {L('取消', 'Cancel')}
        </button>
      </div>
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

/**
 * 归位提示：把"**开在别的 pod 下**"的信箱列出来（只读）。
 *
 * 为什么不做「一键迁移」：
 *   旧实现按「地址域 ≠ 当前 owner 域」判定，然后提供一个批量迁移按钮 ——
 *   那个判据在 ORG 模型下是错的。规范 `address-format.md` §3 明说
 *   **「项目即 pod」只是 P1 一种用法，不写成强制**；pod 叫什么由 ORG 决定。
 *   所以"地址不在某个域里"**本身不代表任何问题** ——
 *   真正要看的只有一条：**这个信箱是不是开在了一个跟它无关的 pod 下**
 *   （本机实例：8 条被开进了 `msg9` 这个 pod，7 条被开进了 `whymyphone`，
 *    而那分别是 msg9.io 项目和 WhyMyPhone 项目的 pod）。
 *
 * 而且迁移是**破坏性 + 涉及归属判断**的动作：该不该迁、迁去哪个 pod，
 * 取决于那个 workspace 属于哪个项目 —— 这件事 dsh 不该替用户猜。
 * ⇒ 这里只**如实呈现**，把决定留给看到它的人。
 */
function PlacementCard({ state }: { state: Msg9State }): JSX.Element | null {
  // ⚠️ 判据必须是「地址实际落在哪个 pod」，**不是** `pod.pod_label` ——
  //    后者是"将要/已经使用的 pod"（对未开通的行只是推导出的候选名），
  //    拿它去比地址段会把正常行误判成异常（我第一版就误报了 5 条）。
  //    真正的异常只有一种：**地址的域与本实例自己的域不同**。
  // 本实例的域：优先 ORG 模型的 `address_domain`，退回 `<slug>.<mail_domain>`
  // （扁平域时两者都没有 ⇒ selfDomain 为 null ⇒ 卡片不渲染，宁可不报也不误报）
  const selfDomain = state.owner?.address_domain
    ?? (state.owner?.slug ? `${state.owner.slug}.${state.owner.mail_domain ?? 'msg9.io'}` : null)
  const rows = state.workspaces.filter((row) => {
    if (!row.address || !row.provisioned) return false
    // 没有自身域可比就无从判断 ⇒ 宁可不报，也不误报
    if (!selfDomain) return false
    const domain = row.address.slice(row.address.indexOf('@') + 1)
    return domain !== selfDomain
  })
  if (rows.length === 0) return null

  return (
    <section style={styles.card}>
      <div style={styles.cardTitle}>
        {L('开在别的 Pod 下（{n}）', 'Opened under another pod ({n})', { n: rows.length })}
      </div>
      <div style={styles.dim}>
        {L(
          '这些信箱的地址落在别的 Pod 里（不是本实例自己的域）。'
          + '地址本身仍然可用，只是归属上不属于本项目 —— 是否迁移、迁去哪个 Pod，取决于那个 workspace 属于哪个项目，请自行判断。',
          'These inboxes live under another pod (not this instance\'s own domain). They keep working; only the ownership is off. Whether to move them — and to which pod — depends on which project that workspace belongs to, so it is left to you.',
        )}
      </div>
      <ul style={styles.list}>
        {rows.map((row) => (
          <li key={row.key} style={styles.row}>
            <div style={styles.rowText}>
              <div style={styles.rowTitle}>{row.title}</div>
              <div style={styles.path}>{row.path}</div>
              <div style={styles.layerRow}>
                <span style={styles.layerTag}>{L('现址', 'now')}</span>
                <code style={styles.code}>{row.address}</code>
              </div>
              {row.pod && (
                <div style={styles.layerRow}>
                  <span style={styles.layerTag}>{L('归属', 'pod')}</span>
                  <code style={styles.code}>{row.pod.pod_label}</code>
                  <span style={styles.dim}>
                    {L('（该 pod 不是此 workspace 的）', '(not this workspace\'s pod)')}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div style={styles.dim}>
        {L(
          '注：这里【没有】迁移按钮。旧版本的「一键迁到当前域」会把这些信箱批量搬进本项目的 Pod —— 其中有些属于别的项目（例如 msg9、WhyMyPhone 自己的信箱），那一步不该由本项目代做。',
          'Note: there is no migrate button here on purpose. The old one-click migration would have swept these into this project\'s pod, including inboxes that belong to other projects.',
        )}
      </div>
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
  // 三层分明：workspace（标题+路径）/ Pod / Agent 各占一行，左侧小标签对齐。
  layerRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, marginTop: 2 },
  layerTag: {
    flex: 'none',
    width: 42,
    fontSize: 10,
    color: DIM,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  // 移除确认：给它自己的框，别和那一行的其它内容混在一起。
  confirmBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 6,
    padding: '8px 10px',
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    background: 'rgba(217,83,79,0.04)',
  },
  confirmList: { margin: 0, paddingLeft: 18, fontSize: 12, color: DIM, lineHeight: 1.6 },
}
