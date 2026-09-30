/**
 * Shared msg9 operations used by both faces of dsh-msg9-kit: the model tools
 * (host) and the `/dsh-msg9/*` HTTP bridge that feeds the browser panel.
 *
 * The unit of identity is the **workspace inbox**: one msg9 address per dsh
 * workspace, optionally managed under the instance-wide owner (tenant). Both
 * faces resolve a workspace to the same inbox, so an agent and its human look
 * at exactly the same mailbox.
 *
 * @module dsh-msg9-kit/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { orgCreatePod, orgListPods, ownerCreateAgents, ownerDisableAgent, ownerMe, ownerMoveMail, registerAgent, setForwarding, setSigningKey, type AgentProfile, type OrgPodRow, type RegisteredAgent } from './api.ts'
import {
  allocateProjectKey,
  ensureCredentialsMigrated,
  msg9Home,
  readOrgKey,
  readProjectCredentials,
  readTenantKeyWithSource,
  resolveCredentials,
  resolveOwner,
  saveOwner,
  writeProjectCredentials,
  writeSigningSeed,
  writeTenantKey,
} from './credentials.ts'
import { generateSigningMaterial } from './signing.ts'
import { L } from './locale.ts'
import {
  defaultApiUrl,
  isTenantOwner,
  loadState,
  replaceWorkspaceInbox,
  upsertWorkspaceInbox,
  type LiveInbox,
  type OwnerState,
} from './store.ts'
import { deriveAddress, harnessAgentName, resolveWorkspace, tenantAddressCandidates, type CallerAgent, type CurrentWorkspace } from './workspace.ts'

/** A resolved workspace together with its msg9 inbox. */
export interface InboxContext {
  workspace: CurrentWorkspace
  inbox: LiveInbox
  /** True when this call created the inbox. */
  provisioned: boolean
}

/** The synthetic bucket used when the host cannot name the calling workspace. */
export const DEFAULT_WORKSPACE: CurrentWorkspace = { key: 'default', title: 'default', path: '(unknown)' }

/** owner 探测失败的重试间隔：key 失效时不能每次调用都白打一轮 /owner/me。 */
const OWNER_PROBE_RETRY_MS = 60_000
let ownerProbeFailedAt = 0

/** Effective owner (tenant) and API base for this process. */
export async function ownerContext(): Promise<{ owner: OwnerState | undefined; apiUrl: string }> {
  const owner = await resolveOwner()
  // ORG 绑定里记了 api_url ⇒ 它说了算。
  // 为什么必须这样：`state.owner` 是**存量**绑定，历史上只记 slugg/name，
  // 不带 api_url；于是 pod key 是新建的时候，请求会掉回 `defaultApiUrl()`
  // （生产域）—— 这正是"配置了自定义 ORG 却被引导到生产"的坑。
  const org = (await loadState()).org
  const apiUrl = org?.api_url || owner?.api_url || defaultApiUrl()
  // One-time lazy probe: an owner bound before the server learned about tenant
  // slugs has `slug === undefined` in the state file. Ask /owner/me once and
  // persist the answer (`null` = flat namespace; per the server spec, existing
  // owners never gain a slug later, so a persisted null stays correct).
  // The ORG upgrade (v1.22) added address_domain: re-probe when it is missing
  // so previews/legacy-detection/display track the pod's real domain.
  if (
    owner?.api_key
    // `''` is the ORG model's "pod, no slug" answer — keep probing it so a
    // server that later reports a real slug gets picked up.
    && (owner.slug === undefined || owner.slug === '' || owner.address_domain === undefined)
    && !process.env.MSG9_OWNER_KEY
    && Date.now() - ownerProbeFailedAt >= OWNER_PROBE_RETRY_MS
  ) {
    try {
      const me = await ownerMe(apiUrl, owner.api_key)
      const probed: OwnerState = {
        ...owner,
        slug: typeof me.slug === 'string' ? me.slug : null,
        ...(typeof me.mail_domain === 'string' ? { mail_domain: me.mail_domain } : {}),
        address_domain: typeof me.address_domain === 'string' ? me.address_domain : null,
      }
      await saveOwner(probed)
      ownerProbeFailedAt = 0
      return { owner: probed, apiUrl }
    } catch {
      // Probe is best-effort: leave the owner unprobed, but负缓存一分钟——
      // 探测失败（如 key 失效）时不能每次调用都白打一轮 /owner/me。
      ownerProbeFailedAt = Date.now()
    }
  }
  return { owner, apiUrl }
}

/** In-flight provisioning, so two concurrent callers create one inbox. */
const provisioning = new Map<string, Promise<InboxContext>>()

/**
 * Resolve a workspace's inbox, provisioning it on first use.
 *
 * Provisioning is **explicit** (2026-09-30): it requires a pod tenant key. With
 * no key it refuses instead of falling back to public self-registration — that
 * silent fallback scattered 9 identities into an unrelated domain on this
 * machine. `options.allowSelfRegister` restores the old path for callers that
 * genuinely mean it.
 */
export function ensureInbox(
  workspace: CurrentWorkspace,
  signal?: AbortSignal,
  preferred?: string,
  options?: { allowSelfRegister?: boolean },
): Promise<InboxContext> {
  const pending = provisioning.get(workspace.key)
  if (pending) return pending
  // The shared task must not carry any single caller's signal: the first
  // caller disconnecting would otherwise abort provisioning for every waiter.
  // Outbound calls inside rely on the API client's own timeout instead.
  const task = provision(workspace, undefined, preferred, options?.allowSelfRegister ?? false)
    .finally(() => provisioning.delete(workspace.key))
  provisioning.set(workspace.key, task)
  if (!signal) return task
  if (signal.aborted) return Promise.reject(signal.reason)
  // A caller may stop waiting, but the shared task runs to completion.
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  ])
}

/** 已被其他 workspace 占用的 project-key（冲突检测用）。 */
async function takenProjectKeys(): Promise<Map<string, string>> {
  const state = await loadState()
  const taken = new Map<string, string>()
  for (const inbox of Object.values(state.workspaces)) {
    if (!inbox.project_key) continue
    const creds = await readProjectCredentials(inbox.project_key)
    if (creds) taken.set(inbox.project_key, creds.address)
  }
  return taken
}

async function provision(
  workspace: CurrentWorkspace,
  log?: (message: string) => void,
  preferred?: string | null,
  allowSelfRegister = false,
): Promise<InboxContext> {
  let existing = await resolveCredentials(workspace.key, { log })
  if (!existing) {
    // 还没解析到：可能有未合一的 cwd:<path> bucket（registry 后补的场景）。
    // ensureCredentialsMigrated 内含 cwd: 合一，跑一次再解析。
    const state = await loadState()
    if (Object.keys(state.workspaces).some((key) => key.startsWith('cwd:'))) {
      await ensureCredentialsMigrated({ log })
      existing = await resolveCredentials(workspace.key, { log })
    }
  }
  if (existing) return { workspace, inbox: await ensureSigningKey(existing, log), provisioned: false }

  const { owner, apiUrl } = await ownerContext()
  const profile = workspaceProfile(workspace)
  // A preference set earlier still applies to a fresh inbox, so re-opening a
  // workspace keeps the address its user asked for.
  const preferredAddress = preferred ?? (await loadState()).workspaces[workspace.key]?.preferred_address

  // ---------------------------------------------------------------- 显式开启
  //
  // 没有 pod 租户 key ⇒ 【拒绝开通】，不再退回公开自助注册。
  //
  // 为什么改（2026-09-30，主人拍板；msg9 侧记为 DEF-001 的同族缺陷）：
  //   旧实现在这里 `: registerAgent(...)` 静默落到「当时的默认域」，没有任何提示。
  //   本机 23 个身份里有 9 个因此堆进了 `msg9.ice.msg9.io` —— 它们与 msg9 这个
  //   项目毫无关系，只因为"当时默认域是它"。主人原话：
  //     「没有配 pod key 那就不应该自动申请 Agent inbox 呀」
  //
  // 新行为：未配置 ⇒ 抛错说明缺什么、去哪儿配；面板据此显示「未开启 + 开启按钮」。
  // 传 `allowSelfRegister` 可显式恢复旧行为（仅测试/显式调用用）。
  if (!owner?.api_key && !allowSelfRegister) {
    throw new Error(
      'msg9 未配置 pod 租户 key，拒绝自动开通收件箱（不会再退回公开自助注册）。'
      + '请在「设置 → 消息信箱」填入 ORG key（msg9_ok_…），'
      + '再对本 workspace 点「开启」。',
    )
  }

  const agent: RegisteredAgent = owner?.api_key
    ? await provisionUnderOwner(apiUrl, owner, workspace, profile, preferredAddress)
    : await registerAgent(apiUrl, deriveAddress(workspace), undefined, profile)

  // 身份与密钥落 msg9 统一凭据仓（0600/0700）；state.json 只留热状态 +
  // project_key 引用，明文 key 与 signing seed 不进 state.json。
  const projectKey = await allocateProjectKey(workspace, agent.address, await takenProjectKeys(), log ?? (() => {}))
  await writeProjectCredentials(projectKey, { address: agent.address, api_key: agent.api_key, api_url: apiUrl })
  await upsertWorkspaceInbox(workspace.key, {
    title: workspace.title,
    path: workspace.path,
    project_key: projectKey,
    ...(preferredAddress ? { preferred_address: preferredAddress } : {}),
  })
  const inbox: LiveInbox = {
    title: workspace.title,
    path: workspace.path,
    project_key: projectKey,
    address: agent.address,
    api_key: agent.api_key,
    api_url: apiUrl,
  }
  return { workspace, inbox: await ensureSigningKey(inbox, log), provisioned: true }
}

/**
 * Lazily install this inbox's Ed25519 signing key (v1.3 identity): generate a
 * seed, register the public half with msg9 (first-time installs need only
 * API-key auth), persist the seed to the credentials store
 * (`<project-key>.signing.yaml`). Servers without the identity layer skip
 * quietly — unsigned sends are still accepted (warn mode).
 */
export async function ensureSigningKey(inbox: LiveInbox, log?: (message: string) => void): Promise<LiveInbox> {
  if (inbox.signing_seed) return inbox
  if (!inbox.project_key) return inbox // 凭据迁移未完成：不装签名，下次再试
  const material = generateSigningMaterial()
  try {
    await setSigningKey(inbox.api_url, inbox.api_key, material.publicKey)
  } catch (error) {
    // N1 (audit): never degrade silently. Two distinct causes: a pre-identity
    // server (expected, unsigned is fine there) vs an install failure on an
    // identity-capable server (seed missing + key on file = signing stays
    // off forever unless someone notices).
    log?.(`msg9 signing key install failed for ${inbox.address}: ${(error as Error)?.message ?? String(error)}`)
    return inbox
  }
  await writeSigningSeed(inbox.project_key, material.seed)
  return { ...inbox, signing_seed: material.seed }
}

/**
 * Provision under the owner. Tenant subdomain (`<agent>@<tenant>.msg9.io`):
 * uniqueness is scoped to the tenant, so try the readable address first and
 * fall back to the hashed form only on a conflict (server code 40900).
 */
async function provisionUnderOwner(
  apiUrl: string,
  owner: OwnerState,
  workspace: CurrentWorkspace,
  profile: AgentProfile,
  preferred?: string | null,
): Promise<RegisteredAgent> {
  // Tenant mode = owner key + a tenant domain (ORG era: `address_domain`).
  const candidates = isTenantOwner(owner)
    ? tenantAddressCandidates(workspace, preferred)
    : [deriveAddress(workspace)]
  let lastAddress = candidates[0]!
  let lastReason = 'no agent returned'
  let lastCode: number | undefined
  for (const address of candidates) {
    lastAddress = address
    const result = await ownerCreateAgents(apiUrl, owner.api_key, [address], { workspace: workspace.title }, profile)
    const created = result.created?.[0]
    if (created?.api_key) return created
    const first = result.errors?.[0]
    lastReason = first ? `${first.message} (${first.code})` : 'no agent returned'
    lastCode = first?.code
    if (first?.code !== 40900) break
  }
  // 自动编号（dsh-2…dsh-4）也全被占 ⇒ 给一条**可操作**的说明，
  // 而不是把服务端的 40900 原文甩给用户。
  // 主人 2026-09-30：允许多个 dsh，但要**可读后缀** —— 剩下的选择是让人显式命名
  // （`dsh-dev` / `dsh-fe` 这种带语义的），而不是我们替他编更多编号。
  if (lastCode === 40900 && lastAddress.startsWith(harnessAgentName())) {
    throw new Error(L(
      '本项目下「dsh」「dsh-2」「dsh-3」「dsh-4」都已被占用，自动编号用完了。\n'
      + '请给这个 workspace **显式指定一个可读的 Agent 名**（例如 dsh-dev、dsh-fe）后重试。',
      'In this project "dsh", "dsh-2", "dsh-3" and "dsh-4" are all taken; auto-numbering is exhausted.\n'
      + 'Give this workspace an explicit, readable agent name (e.g. dsh-dev, dsh-fe) and retry.',
    ))
  }
  throw new Error(
    L(
      '在 owner 下开通「{address}」失败：{reason}',
      'Failed to provision "{address}" under the owner: {reason}',
      { address: lastAddress, reason: lastReason },
    ),
  )
}

/** The yellow-pages profile written at provisioning time. */
function workspaceProfile(workspace: CurrentWorkspace): AgentProfile {
  return {
    display_name: workspace.title,
    description: L(
      'dsh workspace「{title}」的收件箱（{path}）',
      'Inbox of dsh workspace "{title}" ({path})',
      { title: workspace.title, path: workspace.path },
    ),
    links: { workspace: workspace.path },
    visibility: 'public',
  }
}

/**
 * Tenant migration, v1.9 order (forward → replace → move history → release):
 *
 *   1. provision a FRESH inbox for the workspace under the current owner
 *      (tenant-domain address) — server-side only, the state file still
 *      points at the old inbox;
 *   2. set forwarding on the OLD inbox → the new address, with the old inbox's
 *      OWN key (no old-tenant owner key needed): the old address keeps
 *      receiving into the new mailbox, and stays reserved so nobody can
 *      re-register it and hijack delivery. If this FAILS the migration aborts
 *      with a clear error and the local state is left untouched — replacing
 *      the state first would silently strand mail in the old mailbox;
 *   3. only then switch local state: the new credentials overwrite the
 *      workspace's project yaml in the credentials store (the old yaml pointed
 *      at the old inbox) and the state entry is replaced (cursors reset —
 *      they belong to the old inbox's stream); when the previous tenant's key
 *      is supplied: move the old inbox's history over (same-tenant only —
 *      cross-tenant move-mail is a 403 the server refuses, reported in the
 *      note) and suspend the old agent. The forwarding rule survives the
 *      release.
 */
export async function migrateInbox(
  workspace: CurrentWorkspace,
  oldInbox: LiveInbox,
  oldOwnerKey?: string,
  preferred?: string,
): Promise<{ inbox: LiveInbox; oldDisabled: boolean; forwarding: boolean; movedMail: number | null; note?: string }> {
  const { owner, apiUrl } = await ownerContext()
  if (!owner?.api_key) {
    throw new Error(L('还没有绑定租户，无法迁移。', 'No tenant is bound; cannot migrate.'))
  }
  const agent = await provisionUnderOwner(apiUrl, owner, workspace, workspaceProfile(workspace), preferred)
  // 签名材料只在内存里备好：转发没设成之前 state/凭据仓必须仍指向旧信箱。
  let signingSeed: string | undefined
  try {
    const material = generateSigningMaterial()
    await setSigningKey(apiUrl, agent.api_key, material.publicKey)
    signingSeed = material.seed
  } catch {
    /* 服务端没有身份层：跳过，未签名发送仍被接受（warn 模式） */
  }

  /** 新凭据落凭据仓（覆盖该 project 的旧凭据——它指向旧信箱）+ 切换 state。 */
  const activate = async (): Promise<LiveInbox> => {
    const entry = (await loadState()).workspaces[workspace.key]
    const taken = await takenProjectKeys()
    if (entry?.project_key) taken.delete(entry.project_key) // 自己占的 key 可复用
    const projectKey = entry?.project_key
      ?? await allocateProjectKey(workspace, agent.address, taken, () => {})
    await writeProjectCredentials(projectKey, { address: agent.address, api_key: agent.api_key, api_url: apiUrl }, { overwrite: true })
    if (signingSeed) await writeSigningSeed(projectKey, signingSeed, { overwrite: true })
    await replaceWorkspaceInbox(workspace.key, {
      title: workspace.title,
      path: workspace.path,
      project_key: projectKey,
      ...(preferred ? { preferred_address: preferred } : {}),
    })
    return {
      title: workspace.title,
      path: workspace.path,
      project_key: projectKey,
      address: agent.address,
      api_key: agent.api_key,
      api_url: apiUrl,
      ...(signingSeed ? { signing_seed: signingSeed } : {}),
    }
  }

  if (oldInbox.address === agent.address) {
    const inbox = await activate()
    return { inbox, oldDisabled: false, forwarding: false, movedMail: null }
  }

  // Step 2: forwarding first, so mail never lands in a mailbox nobody reads.
  try {
    await setForwarding(oldInbox.api_url, oldInbox.api_key, agent.address)
  } catch (error) {
    throw new Error(L(
      '旧地址 {old} 的转发设置失败（{reason}），迁移已中止：本地配置未改动，仍指向旧信箱。',
      'Could not set forwarding on the old address {old} ({reason}); migration aborted — local state still points at the old inbox.',
      { old: oldInbox.address, reason: (error as Error)?.message ?? String(error) },
    ))
  }
  // 转发已生效，此刻切换本地凭据与状态才不会丢信。
  const inbox = await activate()
  const forwarding = true

  // Step 3: history + release, when the previous tenant's key is around.
  let oldDisabled = false
  let movedMail: number | null = null
  let note: string | undefined
  if (oldOwnerKey) {
    try {
      const moved = await ownerMoveMail(oldInbox.api_url, oldOwnerKey, oldInbox.address, { to: agent.address })
      movedMail = typeof moved.moved === 'number' ? moved.moved : null
    } catch (error) {
      // Same-tenant only: a cross-tenant move is a 403 by design.
      note = L(
        '历史邮件未搬运（{reason}）。跨租户时 msg9 不支持搬信，旧邮件留在旧信箱。',
        'History not moved ({reason}). msg9 cannot move mail across tenants; old mail stays in the old inbox.',
        { reason: (error as Error)?.message ?? String(error) },
      )
    }
    try {
      await ownerDisableAgent(oldInbox.api_url, oldOwnerKey, oldInbox.address)
      oldDisabled = true
    } catch {
      /* decommission is best-effort: forwarding already covers delivery */
    }
  }
  return { inbox, oldDisabled, forwarding, movedMail, ...(note ? { note } : {}) }
}

/** Resolve the calling agent's workspace and its inbox. */
export function resolveInbox(ctx: Context, exec?: CallerAgent): Promise<InboxContext> {
  return ensureInbox(resolveWorkspace(ctx, exec) ?? DEFAULT_WORKSPACE)
}

// ------------------------------------------------------- 显式开启：ORG → Pod
//
// 主人的目标形态（2026-09-30）：
//
//   设置里填 ORG key
//     └─ 默认不动：workspace 的 Pod = 未开启
//          └─ 手工点「开启」→ 用 ORG key 申请 Pod → 按规范存 pod key
//               └─ 用 pod key 申请 Agent key
//                    └─ 收发信一律用 Agent key
//
// 规则来源：`docs/specs/address-format.md`（地址与落盘）、
// `12-org-pods.md` §4（凭证阶梯与职责边界）。

/** workspace 的开通状态（面板据此渲染）。 */
export type PodState = 'unconfigured' | 'pod_closed' | 'ready'

/** 「开启」的结果，供面板/工具显示。 */
export interface OpenPodResult {
  state: PodState
  /** 本次是否真的创建了 pod（false = 复用了已存在的）。 */
  podCreated: boolean
  podLabel?: string
  orgLabel?: string
  addressDomain?: string
  /** 触发开启前该 pod 下已有多少 agent（用于"复用了已有 pod"的提示）。 */
  existingAgents?: number
  note?: string
}

/**
 * 通用词黑名单：这些 title/目录名没有区分度，拿来做 pod label 会产出
 * 事后认不出的地址（本机 5 个 `dsh-ws-*` 的成因）。
 */
const GENERIC_POD_LABELS = new Set([
  'workspace', 'ws', 'wip', 'tmp', 'temp', 'test', 'tests', 'src', 'app', 'code', 'codes',
])

/**
 * 一个推导出来的 pod 名**是否有语义**。
 *
 * pod label 只能是小写 ASCII（规范 §2），所以中文标题的 slug 会退化成空，
 * 再叠加 hash 变成 `ws-89fa` / `3-f483` 这种认不出是谁的名字 ——
 * 拿它当"候选 pod"只是噪音，还会让人以为那就该是它的名字。
 * 只有"去掉尾部 hash 后仍 ≥3 字符、且不是通用词"才算有意义。
 */
export function isMeaningfulPodLabel(label: string): boolean {
  const stem = label.replace(/-[0-9a-f]{4}$/, '')
  return stem.length >= 3 && !GENERIC_POD_LABELS.has(stem)
}

function podSlugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
}

/**
 * 推导本 workspace 的 pod label。
 *
 * 规范 §4：「pod label = 小写短名（≤20 字符为宜），可读优先于缩写」；
 * P1 模式下 pod 装的是一个**项目**。所以优先用有项目语义的名字（目录名），
 * `title` 只有在非通用词时才用 —— 这正是 D3「`dsh-ws-xxxx` 认不出是谁」的修法。
 */
export function derivePodLabel(workspace: CurrentWorkspace): string {
  const candidates = [workspace.title, basename(workspace.path.replace(/\/+$/, ''))]
  for (const raw of candidates) {
    const slug = podSlugify(raw)
    if (!slug || GENERIC_POD_LABELS.has(slug)) continue
    if (slug.length >= 3) return slug.slice(0, 30).replace(/[^a-z0-9]+$/, '')
  }
  // 全都不具备语义时才退化加 hash，保证唯一且仍可追溯
  const slug = podSlugify(workspace.title) || podSlugify(basename(workspace.path)) || 'ws'
  return `${slug}-${shortHash(workspace.key)}`.slice(0, 30).replace(/[^a-z0-9]+$/, '')
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 4)
}

/** 当前 workspace 处于哪个开通状态（**只读**；不写任何凭据）。 */
export async function podState(workspace: CurrentWorkspace): Promise<PodState> {
  if (await resolveCredentials(workspace.key)) return 'ready'
  const org = await readOrgKey((await loadState()).org?.label ?? undefined)
  return org?.key ? 'pod_closed' : 'unconfigured'
}

/**
 * 开启本 workspace 的 Pod（**本方案唯一的写路径**，幂等可重入）。
 *
 *   ① 读 ORG key —— 没有就明确拒绝（不猜、不降级）
 *   ② 列 ORG 下的 pod —— **只读探测**，绝不用写接口试形状
 *   ③ pod 已存在 ⇒ **复用**（40900 决议表：同 pod 认领，不重建）
 *   ④ 不存在 ⇒ 创建，拿到 pod key（服务端只显示一次）⇒ 立刻落盘
 *   ⑤ 用 pod key 开 agent ⇒ 落 `projects/dsh/<key>.yaml`
 *
 * ⚠️ 关于 40900（`address already taken`）—— 本机踩过的坑：
 *   `provisionUnderOwner` 撞 40900 会**直接失败**，于是"目标地址已存在"时
 *   整条迁移都用不了。所以这里**先探测再决策**，把"已存在"当正常分支处理。
 *
 * ⚠️ 绝不拿生产 ORG 试接口形状（本机误建过 `probe-x`）：
 *   创建只在这一条路径上发生，且 label 由 `derivePodLabel` 决定、可被显式覆盖。
 */
export async function openPod(
  workspace: CurrentWorkspace,
  options?: { podLabel?: string; log?: (message: string) => void },
): Promise<OpenPodResult> {
  const log = options?.log ?? (() => {})
  const state = await loadState()
  const orgLabel = state.org?.label
  const org = await readOrgKey(orgLabel)
  if (!org?.key) {
    throw new Error(L(
      '未配置 ORG key，无法开启 Pod。请在「设置 → 消息信箱」填入 ORG key（msg9_ok_…）。',
      'No ORG key configured, so the pod cannot be opened. Add one in Settings → Mailbox.',
    ))
  }
  const apiUrl = state.org?.api_url ?? defaultApiUrl()
  // pod label 的优先级：调用方显式指定 > 该 workspace 的人工覆盖 > ORG 默认 > 推导。
  // "人工覆盖"就是主人要的那条口子：「免得自动生成的 pod slug 很乱」。
  const label = options?.podLabel
    ?? state.org?.pod_labels?.[workspace.key]
    ?? state.org?.pod_label
    ?? derivePodLabel(workspace)

  // ② 只读探测：pod 是否已在 ORG 下存在
  let pods: OrgPodRow[]
  try {
    pods = await orgListPods(apiUrl, org.key)
  } catch (error) {
    throw new Error(L(
      '读取 ORG 下的 Pod 列表失败：{reason}',
      'Could not list pods under the ORG: {reason}',
      { reason: (error as Error)?.message ?? String(error) },
    ))
  }
  const existingPod = pods.find((pod) => pod.pod_label === label)

  let podKey: string | undefined
  let podCreated = false
  let addressDomain = existingPod?.address_domain
  const existingAgents = existingPod?.agents

  if (existingPod) {
    // ③ 复用：但需要它的 pod key。pod key 服务端只在创建时给一次，
    //    所以先看本地有没有；没有则明确报错，**绝不静默重建一个已存在的 pod**。
    podKey = (await readTenantKeyForPod(label, orgLabel)) ?? undefined
    if (!podKey) {
      throw new Error(L(
        'Pod「{pod}」已存在于 ORG「{org}」下（已有 {agents} 个 agent），但本地没有它的 pod key。'
        + '请提供该 Pod 的租户 key（或先删除该 Pod 再重开）。本插件不会重建一个已存在的 Pod。',
        'Pod "{pod}" already exists under ORG "{org}" but its key is not stored locally.',
        { pod: label, org: orgLabel ?? '?', agents: existingAgents ?? 0 },
      ))
    }
    log(`msg9 openPod: reusing existing pod ${label} (${addressDomain ?? '?'})`)
  } else {
    // ④ 创建（每个 pod 只走一次）
    const created = await orgCreatePod(apiUrl, org.key, { label, name: workspace.title }).catch((error) => {
      throw new Error(L(
        '在 ORG 下创建 Pod「{pod}」失败：{reason}',
        'Failed to create pod "{pod}" under the ORG: {reason}',
        { pod: label, reason: (error as Error)?.message ?? String(error) },
      ))
    })
    podKey = created.api_key
    podCreated = true
    addressDomain = created.pod?.address_domain ?? addressDomain
  }

  if (!podKey) {
    throw new Error(L(
      'Pod 已创建但没有返回 pod key；已中止（未写任何凭据）。',
      'The pod was created but no pod key came back; aborting without writing credentials.',
    ))
  }

  // pod key 落规范位置：tenants/<pod>-<org>.key（0600）。服务端只给一次。
  await writeTenantKey(podKey, { podLabel: label, orgLabel })

  // ⑤ 用 pod key 开 agent（复用既有幂等逻辑）
  await ensureInbox(workspace)
  return {
    state: 'ready',
    podCreated,
    podLabel: label,
    orgLabel,
    addressDomain,
    existingAgents,
    note: podCreated ? undefined : L('复用了已存在的 Pod（未新建）', 'Reused the existing pod'),
  }
}

/** 读某个 pod 的 key（`tenants/<pod>-<org>.key`，按规范命名）。 */
async function readTenantKeyForPod(podLabel: string, orgLabel?: string): Promise<string | null> {
  if (orgLabel) {
    try {
      const key = (await readFile(join(msg9Home(), 'tenants', `${podLabel}-${orgLabel}.key`), 'utf8')).trim()
      if (key) return key
    } catch { /* 落到通用解析 */ }
  }
  const resolved = await readTenantKeyWithSource().catch(() => undefined)
  return resolved?.key ?? null
}

/** Display/format helpers shared with the browser face. */
export { bodyText, maskKey, truncate } from '../shared/message.ts'
