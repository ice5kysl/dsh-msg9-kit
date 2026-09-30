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
import { Boxes, ChevronDown, ChevronRight, FolderOpen, Mail } from './icons.tsx'
import { L } from './locale.ts'
import { SetupView } from './Msg9Panel.tsx'
import type { Msg9State, Msg9Store } from './store.ts'
import type { RelinkTarget } from '../shared/types.ts'
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
        {/* 主人 2026-09-30 重写：旧文案写「每个 dsh workspace 一个信箱」——
            那既不符合实际（一个项目的信箱开在它自己的 Pod 里），也不符合本页
            真正要讲的东西（地址形状与 Pod 归属）。**别把意图说成设计。** */}
        <div style={styles.dim}>
          {L(
            'msg9 是给 Agent 用的邮件服务：Agent 用工具收发，你在「消息」页签里看同一个信箱 —— 同一把钥匙，两个入口。',
            'msg9 is mail for agents: the agent sends and receives through tools, and you read the same inbox in the「Messages」tab — one key, two doors.',
          )}
        </div>
        <div style={styles.dim}>
          {L(
            '信箱地址形如 dsh@dsh.ice.msg9.io：@ 前是 Agent 名，后面依次是它所属的 Pod（项目在平台上的落脚点）、ORG 与平台域名。',
            'An address looks like dsh@dsh.ice.msg9.io: before the @ is the agent, then its pod (the project’s foothold on the platform), its org, and the platform domain.',
          )}
        </div>
        <div style={styles.dim}>
          {L(
            '有了它，兄弟 workspace 之间、跨项目之间可以直接传话，不必等人转达。',
            'It lets sibling workspaces and separate projects talk to each other directly — nobody has to relay by hand.',
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
                  : (typeof bound.max_pods === 'number'
                      // 与 workspace 行同样的「已用 / 上限」写法，一眼看出还剩多少
                      ? L('{n} / {max}', '{n} / {max}', { n: bound.pod_count, max: bound.max_pods })
                      : String(bound.pod_count))}
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
              // 删掉原先的第二句「每个项目对应一个 Pod，Pod 里放各 harness 的信箱」：
              // 它与本页「规范的 / 不规范的」判据（pod 名 = workspace 名）说法相反，
              // 同一页里两处互相矛盾。ORG 卡的职责只是"这把 key 怎么来"，
              // 不该在这里替 Pod 归属下定义（那是下面那张表要讲的事）。
              '在 msg9.io 的 Account 页创建一个 ORG，复制它的 key（msg9_ok_…，只显示一次）粘到这里。',
              'Create an ORG on the msg9.io Account page and paste its key (msg9_ok_…, shown once) here.',
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
/**
 * 一条记录的归类。
 *
 *   missing      目录已不存在（仓库搬走 / 改名，记录成了残留）
 *   problem      与其他记录共用同一个地址
 *   noncompliant 已开通（不规范），**没开在自己的 Pod 里**
 *                （含：地址无 Pod 归属 / Pod 不存在 / 现址 Pod ≠ 应有 Pod）
 *   unopened     暂未开通 —— **没有归属可言**，所以既不算规范也不算不规范
 *   ok           已开通、且开在自己的 Pod 里
 *
 * 优先级即上序（故障优先），一行只进一个组。
 *
 * ⚠️「没开在自己的 Pod 里」是**本工作区的约定**（主人 2026-09-30 定：
 *    一个 workspace 的信箱应开在它自己那个 pod 下）。规范 `address-format.md`
 *    §3 只说「项目即 pod」是**推荐用法之一**、不强制 —— 措辞上要把两者分开，
 *    别让人以为那是规范违反。
 */
export type GroupId = 'missing' | 'problem' | 'noncompliant' | 'unopened' | 'ok'

export function groupOf(row: Msg9State['workspaces'][number]): GroupId {
  if (row.health?.pathMissing) return 'missing'
  if (row.health?.duplicateOf) return 'problem'
  // 暂未开通 ⇒ 没有"归属"可言，单独一组（放最下：它不是故障，只是还没做）
  if (!row.provisioned || !row.pod) return 'unopened'
  // ① 地址没有 pod 归属（扁平域 / ORG 的 Default Pod）
  if (row.pod.pod_form === false) return 'noncompliant'
  // ② 地址指向一个 ORG 里不存在的 pod
  if (row.pod.pod_exists === false) return 'noncompliant'
  // ③ 现址 pod ≠ 应有 pod —— host 只在两者不同时给出 suggested_label，故有值即判
  if (row.pod.suggested_label) return 'noncompliant'
  return 'ok'
}

function WorkspaceCard({ state, store }: { state: Msg9State; store: Msg9Store }): JSX.Element {
  const bound = Boolean(state.org)
  // 组序按主人要求：规范的 → 不规范的 → 异常的 → 不存在了的 → 暂未开通。
  // 越需要处理的越往下；「暂未开通」不是故障，放最后。
  const groups: { id: GroupId; label: string; hint: string | null; warn: boolean }[] = [
    { id: 'ok', label: L('规范的', 'Compliant'), warn: false, hint: null },
    { id: 'noncompliant', label: L('不规范的', 'Non-compliant'), warn: true,
      hint: L('没有开在自己的 Pod 里（含：无 Pod 归属、Pod 不存在）', 'not in its own pod (or no pod ownership / pod missing)') },
    { id: 'problem', label: L('异常的', 'Anomalies'), warn: true,
      hint: L('多条记录指向同一个地址', 'several records share one address') },
    { id: 'missing', label: L('不存在了的', 'Gone'), warn: true,
      hint: L('目录已不存在（仓库搬走或改名了）', 'directory no longer exists') },
    { id: 'unopened', label: L('暂未开通', 'Not opened yet'), warn: false,
      hint: L('还没有信箱，点「开通」即可', 'no inbox yet — hit "Open pod"') },
  ]
  const byGroup = new Map<GroupId, Msg9State['workspaces']>()
  for (const row of state.workspaces) {
    const id = groupOf(row)
    const bucket = byGroup.get(id)
    if (bucket) bucket.push(row)
    else byGroup.set(id, [row])
  }
  // 折叠：默认全展开，点标题栏切换
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  return (
    <section style={styles.card}>
      <div style={styles.cardTitle}>
        {L('② Workspace 与 Pod（{n}）', '② Workspaces & pods ({n})', { n: state.workspaces.length })}
      </div>
      {state.workspaces.length === 0 ? (
        <div style={styles.dim}>{L('还没有 workspace。', 'No workspaces yet.')}</div>
      ) : groups.map((group) => {
        // 组内保持 overview 给的**原始顺序**（宿主已不再重排）
        const rows = byGroup.get(group.id) ?? []
        const isCollapsed = collapsed[group.id] === true
        return (
          <div key={group.id} style={styles.group}>
            {/* 整行都是折叠开关：标题 + 说明在左，箭头在最右。
                箭头用 lucide 的 Chevron（14px）而不是 `▾` 字形 ——
                那个字形在这个字号下只有 10px 出头，太细看不清。 */}
            <button
              type="button"
              style={styles.groupHead}
              onClick={() => setCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
              title={isCollapsed ? L('展开', 'Expand') : L('折叠', 'Collapse')}
            >
              <span style={styles.groupHeadText}>
                <span style={group.warn && rows.length > 0 ? styles.groupTitleWarn : styles.groupTitle}>
                  {L('{label}（{n}）', '{label} ({n})', { label: group.label, n: rows.length })}
                </span>
                {group.hint && <span style={styles.dim}>{group.hint}</span>}
              </span>
              {isCollapsed
                ? <ChevronRight size={14} style={styles.groupChevron} />
                : <ChevronDown size={14} style={styles.groupChevron} />}
            </button>
            {isCollapsed
              ? null
              : (rows.length === 0
                  ? <div style={styles.groupEmpty}>{L('（无）', '(none)')}</div>
                  : (
                    <ul style={styles.list}>
                      {rows.map((row) => (
                        <WorkspaceRow key={row.key} row={row} state={state} store={store} orgBound={bound} />
                      ))}
                    </ul>
                  ))}
          </div>
        )
      })}
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
  const opening = state.opening[row.key] ?? { busy: false, error: null }
  const [editLabel, setEditLabel] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  // 重挂：候选目标是懒加载的（点「挂到…」才去要，避免每次 overview 都算一遍）
  const [relink, setRelink] = useState<{ open: boolean; targets: RelinkTarget[] | null; pick: string; error: string | null }>(
    { open: false, targets: null, pick: '', error: null },
  )
  const [relinking, setRelinking] = useState(false)

  const stateText = !pod || pod.state === 'unconfigured'
    ? L('未配置 ORG', 'No ORG')
    : pod.state === 'pod_closed'
      ? L('Pod 未开通', 'Pod closed')
      : L('已开通', 'Ready')

  return (
    <li style={styles.row}>
      {/* 不再有行首的邮箱图标：每一行都是信箱，它什么也没说明，
          只是把每行都往右推。图标改为贴在有信息量的地方（目录 / Agent）。 */}
      <div style={styles.rowText}>
        {/* 三层各一行，行首各有一个图标标明"这一行是什么"：
              行 1 = Pod（项目在平台上的落脚点）+ 状态/用量
              行 2 = 工作区（名字 + 目录）
              行 3 = Agent 信箱（地址）+ 未读
            主人 2026-09-30 的排法：把"三层"这件事在版面上显式化，
            每行的图标就是它的标签，因此行里不再重复写"Pod""Agent"这些词。 */}
        <div style={styles.lineBetween}>
          <div style={styles.lineRow}>
            <span style={styles.iconWrap} title={L('Pod（项目在平台上的落脚点）', 'Pod (the project’s foothold on the platform)')}>
              <Boxes size={12} />
            </span>
            {pod ? (
              <>
                <code style={styles.code}>{pod.pod_label}</code>
                {pod.domain && (
                  <>
                    <span style={styles.dot}>-</span>
                    <span style={styles.code}>{pod.domain}</span>
                  </>
                )}
              </>
            ) : (
              <span style={styles.dim}>{L('（尚无 Pod）', '(no pod yet)')}</span>
            )}
          </div>
          <div style={styles.lineRight}>
            {pod && pod.state === 'ready' && <span style={styles.pillOk}>{stateText}</span>}
            {pod && pod.state === 'unconfigured' && <span style={styles.pillWarn}>{stateText}</span>}
            {pod && pod.state === 'ready' && (
              <span
                style={styles.pillDim}
                title={L('该 Pod 下已开通的信箱数 / 上限', 'inboxes in this pod / limit')}
              >
                {pod.agents === null || pod.agents === undefined
                  ? L('用量未知', 'usage —')
                  : L('{n} / {max} 信箱', '{n} / {max} inboxes', { n: pod.agents, max: pod.max_agents ?? '—' })}
              </span>
            )}
          </div>
        </div>

        {/* 行 2：工作区 —— 名字 + 目录（工作区就是它那个目录，所以放同一行） */}
        <div style={styles.lineRow}>
          <span style={styles.iconWrap} title={L('工作区目录', 'Workspace directory')}>
            <FolderOpen size={12} />
          </span>
          <span style={styles.rowTitle}>{row.title}</span>
          {row.path && (
            <>
              <span style={styles.dot}>-</span>
              <span style={styles.path}>{row.path}</span>
            </>
          )}
        </div>

        {/* 行 3：Agent 信箱 —— 未读挂本行右端（它是**本信箱**的，不是 Pod 合计） */}
        {(row.address || unread > 0) && (
          <div style={styles.lineBetween}>
            <div style={styles.lineRow}>
              <span style={styles.iconWrap} title={L('Agent 信箱', 'Agent inbox')}>
                <Mail size={12} />
              </span>
              {row.address
                ? <code style={styles.code}>{row.address}</code>
                : <span style={styles.dim}>{L('（未开通）', '(not open)')}</span>}
            </div>
            <div style={styles.lineRight}>
              {unread > 0 && (
                <span
                  style={styles.unreadBubble}
                  title={L(
                    '{address} 这个信箱有 {n} 封未读',
                    '{address} has {n} unread',
                    { address: row.address ?? '', n: unread },
                  )}
                >
                  {badgeText(unread)}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 健康判断：僵尸 / 重复。**从地址看不出来，所以必须标出来。** */}
        {row.health?.pathMissing && (
          <div style={styles.rowMeta}>
            <span style={styles.warn}>{L('⚠ 目录已不存在', '⚠ directory is gone')}</span>
            <span style={styles.dim}>
              {row.address
                ? L(
                    '（仓库搬走了。信箱还在收信，但它挂在了已经不存在的工作区上）',
                    '(the repo moved. The inbox still receives mail, but it is attached to a workspace that no longer exists)',
                  )
                : L(
                    '（这是 dsh 注册表里的一条失效工作区，请到 dsh 中清理）',
                    '(a stale workspace in the dsh registry — clean it up in dsh)',
                  )}
            </span>
          </div>
        )}
        {/* 两处记录对"目录在哪"说法不一致：以注册表为准，但把旧记录摆出来。
            这不是故障（工作区照常可用），所以是提示而非报警。 */}
        {row.health?.stalePath && (
          <div style={styles.rowMeta}>
            <span style={styles.dim}>
              {L('msg9 记录里的目录是旧路径', 'the msg9 record holds an old path')}
            </span>
            <code style={styles.code}>{row.health.stalePath}</code>
            <span style={styles.dim}>
              {L('（工作区现在在 {now}，以它为准）', '(the workspace is now at {now}; that one wins)', {
                now: row.health.registryPath ?? '',
              })}
            </span>
          </div>
        )}
        {row.health?.duplicateOf && (
          <div style={styles.rowMeta}>
            <span style={styles.warn}>{L('⚠ 与另一条记录共用同一地址', '⚠ shares an address with another record')}</span>
            <code style={styles.code}>{row.health.duplicateOf}</code>
          </div>
        )}
        {/* 没开在自己的 pod 里 —— 这是"不合规"的具体原因，逐行说清楚。
            两种情形分开讲：
              · 名字有语义、pod 也已存在 ⇒ 很可能就是该迁过去的地方（最强信号）
              · 名字本身取不出合法 pod 名（纯 ASCII 限制）⇒ 需要人工指定
            注意措辞：这违反的是**本工作区约定**（项目即 pod），
            规范里它只是推荐用法 —— 不把约定说成规范。 */}
        {pod?.suggested_label && (
          <div style={styles.rowMeta}>
            <span style={styles.warn}>
              {L('⚠ 没开在自己的 Pod 里（应为「{pod}」）', '⚠ not in its own pod (expected "{pod}")', { pod: pod.suggested_label })}
            </span>
            <span style={styles.dim}>
              {!pod.suggested_meaningful
                ? L('（该名字取不出合法的 Pod 名，需人工指定）', '(name cannot yield a valid pod label; set it manually)')
                : pod.suggested_exists
                  ? L('（该 Pod 已存在，可能就是它该去的地方）', '(that pod already exists — likely where it belongs)')
                  : L('（该 Pod 尚未创建）', '(that pod does not exist yet)')}
            </span>
          </div>
        )}

        {relink.open && (
          <div style={styles.confirmBox}>
            <div style={styles.rowTitle}>
              {L('把这条信箱挂到哪个工作区？', 'Relink this inbox to which workspace?')}
            </div>
            <div style={styles.dim}>
              {L(
                '只改本地记录：地址、密钥、游标、监听基线、已读标记全部跟着走。远端信箱、凭据文件、dsh 的工作区注册表都不动。',
                'Local record only: address, key, cursor, watch baseline and read marks all move with it. The remote inbox, credential files and the dsh registry are untouched.',
              )}
            </div>
            {relink.error && <span style={styles.warn}>{relink.error}</span>}
            {relink.targets === null
              ? <span style={styles.dim}>{L('正在读取工作区列表…', 'Loading workspaces…')}</span>
              : relink.targets.length === 0
                ? (
                  <span style={styles.dim}>
                    {L(
                      '没有可挂的目标：注册表里没有"目录存在、且还没有信箱"的工作区。请先在 dsh 里打开搬走后的目录（登记成工作区）。',
                      'No eligible target: no registry workspace with an existing directory and no inbox yet. First open the moved directory in dsh.',
                    )}
                  </span>
                )
                : (
                  <>
                    <select
                      className="m9-input"
                      style={styles.slugInput}
                      value={relink.pick}
                      onChange={(event) => setRelink((prev) => ({ ...prev, pick: event.target.value }))}
                    >
                      <option value="">{L('选择要挂到的工作区…', 'Pick a workspace…')}</option>
                      {relink.targets.map((target) => (
                        <option key={target.key} value={target.key}>
                          {target.same_title ? '★ ' : (target.same_dir ? '· ' : '')}
                          {target.title} — {target.path}
                        </option>
                      ))}
                    </select>
                    <div style={styles.rowMeta}>
                      <span style={styles.dim}>
                        {L('★ = 标题相同，· = 目录名相同', '★ same title, · same directory name')}
                      </span>
                    </div>
                  </>
                )}
            <div style={styles.rowMeta}>
              <button
                type="button"
                className="m9-btn m9-btn-primary"
                style={styles.smallBtn}
                disabled={!relink.pick || relinking}
                onClick={() => {
                  if (!relink.pick) return
                  setRelinking(true)
                  void store.relinkWorkspace(row.key, relink.pick).then((done) => {
                    setRelinking(false)
                    if (done) setRelink({ open: false, targets: null, pick: '', error: null })
                  })
                }}
              >
                {relinking ? L('挂接中…', 'Relinking…') : L('挂到', 'Relink')}
              </button>
              <button
                type="button"
                className="m9-btn"
                style={styles.smallBtn}
                onClick={() => setRelink({ open: false, targets: null, pick: '', error: null })}
              >
                {L('取消', 'Cancel')}
              </button>
            </div>
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
        {!row.provisioned && (
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
        {/* 重挂：只在"目录没了、但信箱还在"时出现 —— 这正是"文件夹搬走了"的形态。
            其余情况不给（避免把好端端的信箱挂走）。 */}
        {row.health?.pathMissing && row.address && !relink.open && (
          <button
            type="button"
            className="m9-btn"
            style={styles.smallBtn}
            title={L(
              '把这个信箱挂到搬走后的那个工作区（只改本地记录）',
              'Attach this inbox to the moved workspace (local record only)',
            )}
            onClick={() => {
              setRelink({ open: true, targets: null, pick: '', error: null })
              void store.relinkTargets(row.key)
                .then((targets) => setRelink((prev) => ({ ...prev, targets })))
                .catch((error: unknown) => setRelink((prev) => ({ ...prev, targets: [], error: String(error) })))
            }}
          >
            {L('挂到…', 'Relink…')}
          </button>
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
    // 顶部对齐：右侧按钮与**行 1** 对齐，而不是浮在三行文字的垂直中间
    alignItems: 'flex-start',
    // ⚠️ 必须允许换行：展开的「移除确认」是这一行的第 4 个子项，
    //    不换行时它会和 rowText 抢宽度，把中文挤成"一字一行"（实测过的样式事故）。
    flexWrap: 'wrap',
    gap: 10,
    padding: '9px 0',
    borderTop: `1px solid ${BORDER}`,
  },
  // 行内小图标（目录 / Agent 前的标识）。
  // 用 <span title> 包一层而不是给 <svg> 加 title —— SVG 的 title **属性**
  // 不产生原生 tooltip（那要靠 <title> 子元素），HTML 元素的 title 才可靠。
  iconWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    color: DIM,
    alignSelf: 'center',
    cursor: 'help',
  },
  // flexBasis 给个下限：窄面板时让右侧按钮换行，而不是把文字压到逐字换行/被裁掉
  rowText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 240px' },
  // 紧凑行：把「workspace · Pod · 域 · 状态 · 用量」排在同一行内（可换行）
  lineRow: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', minWidth: 0 },
  // 「左内容 ……… 右内容」同一行两端对齐：pill / 未读气泡据此贴右边缘，
  // 并与该行基线对齐（不再挂在整块文字的垂直居中处）
  lineBetween: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  lineRight: { display: 'flex', alignItems: 'baseline', gap: 6, marginLeft: 'auto', flexShrink: 0 },
  // 未读气泡：本信箱的未读，做成实心小圆泡跟在 Agent 地址后面
  unreadBubble: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 18,
    padding: '0 6px',
    borderRadius: 9,
    background: ACCENT,
    color: '#fff',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: '18px',
  },
  // 小药丸：状态 / 用量。用背景色区分"状态"（有色）与"用量"（中性）
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
  },
  pillOk: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    background: 'rgba(45,102,247,0.10)',
    color: ACCENT,
    fontWeight: 500,
  },
  pillWarn: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    background: 'rgba(217,83,79,0.10)',
    color: '#d9534f',
    fontWeight: 500,
  },
  pillDim: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    border: `1px solid ${BORDER}`,
    color: DIM,
  },
  // 分组：每类一个小标题 + 说明，空组也显示「（无）」——"没有问题"本身是信息
  group: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 },
  // 整行可点：左（标题+说明）… 右（折叠箭头）
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    padding: '2px 0',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  groupHeadText: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  groupChevron: { flexShrink: 0, color: DIM },
  groupTitle: { fontSize: 12, fontWeight: 600, color: DIM },
  groupTitleWarn: { fontSize: 12, fontWeight: 600, color: '#d9534f' },
  groupEmpty: { fontSize: 12, color: DIM, paddingLeft: 2 },
  rowTitle: { fontSize: 13, fontWeight: 500 },
  // 与工作区名同行 ⇒ 必须可收缩，否则 nowrap 的长路径会顶破整行
  path: { fontSize: 11, color: DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' },
  rowStats: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  pendingChips: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 44, overflow: 'hidden' },
  pendingChip: { fontSize: 11, color: DIM, border: `1px solid ${BORDER}`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' },
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
  // 移除确认：给它自己的框，别和那一行的其它内容混在一起。
  confirmBox: {
    display: 'flex',
    flexDirection: 'column',
    // 整行独占：它讲的是"这条记录"的处置，不该和那一行的其他内容挤在一起
    flexBasis: '100%',
    gap: 6,
    marginTop: 6,
    padding: '8px 10px',
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    background: 'rgba(217,83,79,0.04)',
  },
  confirmList: { margin: 0, paddingLeft: 18, fontSize: 12, color: DIM, lineHeight: 1.6 },
}
