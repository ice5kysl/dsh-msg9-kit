/**
 * msg9 统一凭据仓（`~/.msg9/`）的读写与惰性迁移 —— 身份与密钥的唯一真实来源。
 *
 * 布局（平台官方契约，与 kimi-code 侧一致）：
 *
 *   ~/.msg9/                                       # 0700
 *   ├── tenants/dsh.key                            # owner key，纯一行，0600
 *   ├── projects/dsh/<project-key>.yaml            # 每 workspace 一份，0600
 *   └── projects/dsh/<project-key>.signing.yaml    # Ed25519 签名 seed，0600
 *
 * project yaml 字段：address / api_key / api_url / created_at；
 * signing yaml 字段：signing_seed / created_at。
 *
 * project-key 推导：workspace 目录有 git remote → 从 remote 推导
 * （`github.com/acme/web` → `github-com-acme-web`）；无 remote → 目录名 +
 * 绝对路径 sha256 前 6 位十六进制。
 *
 * state.json 里若还读到 address/api_key/api_url/signing_seed（或 owner 里的
 * api_key），那是凭据仓之前的历史残留：resolveCredentials / resolveOwner 读
 * 到时在 state 文件锁内做惰性迁移（ensureCredentialsMigrated），迁完删除
 * 残留。所有需要 key 的调用点必须走 resolveCredentials / resolveOwner，
 * 没有第二条路径。
 *
 * @module dsh-msg9-kit/credentials
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  defaultApiUrl,
  loadState,
  saveState,
  withStateLock,
  type LiveInbox,
  type MessageMark,
  type OwnerState,
  type State,
} from './store.ts'
import { listRegisteredWorkspaces, type CurrentWorkspace } from './workspace.ts'

/** 凭据仓根目录（默认 ~/.msg9；MSG9_HOME 覆盖，测试用临时目录）。 */
export function msg9Home(): string {
  return process.env.MSG9_HOME || join(homedir(), '.msg9')
}

function tenantsDir(): string {
  return join(msg9Home(), 'tenants')
}

function projectsDir(): string {
  return join(msg9Home(), 'projects', 'dsh')
}

/**
 * ORG key 的存放目录。
 *
 * ⚠️ 规范 `address-format.md` §5 只规定了 `tenants/`（pod key）与
 * `projects/<harness>/`（agent 凭据），**没有给 ORG key 定位置** ——
 * 因为 ORG 是"平台级凭证"，按设计不该发给终端 harness。
 *
 * 主人在（2026-09-30）要求"设置里填 ORG key"，所以本插件需要存它。
 * 取名 `orgs/` 与 `tenants/`、`projects/` 并级，文件名 `<org>.key`，
 * **同样 0600**，与其余凭据一致；并在 README 里标注这是我方扩展。
 */
function orgsDir(): string {
  return join(msg9Home(), 'orgs')
}

export function orgKeyPath(orgLabel: string): string {
  return join(orgsDir(), `${sanitizeKey(orgLabel)}.key`)
}

export function tenantKeyPath(): string {
  return join(tenantsDir(), 'dsh.key')
}

export function projectYamlPath(projectKey: string): string {
  return join(projectsDir(), `${projectKey}.yaml`)
}

export function signingYamlPath(projectKey: string): string {
  return join(projectsDir(), `${projectKey}.signing.yaml`)
}

/** 迁移辅助的注入点：registry（cwd: 合一）与日志。 */
export interface MigrationDeps {
  listWorkspaces(): CurrentWorkspace[]
  log(message: string): void
}

function defaultDeps(): MigrationDeps {
  return { listWorkspaces: listRegisteredWorkspaces, log: () => {} }
}

// ------------------------------------------------------------- project-key

function sanitizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * 从 `<path>/.git/config` 的第一条 `url = ` 行推导 remote 标识：
 * `git@github.com:acme/web.git` / `https://github.com/acme/web.git` 都归一成
 * `github-com-acme-web`（host + path，分隔符一律转 `-`）。读不到返回 undefined。
 */
export async function gitRemoteKey(path: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(join(path, '.git', 'config'), 'utf8')
  } catch {
    return undefined
  }
  const match = /^\s*url\s*=\s*(\S+)\s*$/m.exec(raw)
  const url = match?.[1]
  if (!url) return undefined
  let hostPath: string | undefined
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url) // git@host:owner/repo(.git)
  if (scp) {
    hostPath = `${scp[1]}/${scp[2]}`
  } else {
    try {
      const parsed = new URL(url)
      hostPath = `${parsed.hostname}${parsed.pathname}`
    } catch {
      return undefined
    }
  }
  const normalized = hostPath.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const key = normalized.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return key || undefined
}

/**
 * 推导 workspace 的 project-key：有 git remote 用 remote，否则
 * `<目录名>-<绝对路径 sha256 前 6 位>`。
 */
export async function deriveProjectKey(workspace: { title: string; path: string }): Promise<string> {
  const remote = await gitRemoteKey(workspace.path)
  if (remote) return remote
  const hash = createHash('sha256').update(workspace.path).digest('hex').slice(0, 6)
  const name = sanitizeKey(basename(workspace.path.replace(/\/+$/, ''))) || 'workspace'
  return `${name}-${hash}`
}

/**
 * 分配不冲突的 project-key：已被别的 workspace（不同 address）占用时，
 * 加 `-<workspace key 前 4 位>` 后缀并响亮记日志（真实中不该发生）。
 */
export async function allocateProjectKey(
  workspace: { key: string; title: string; path: string },
  address: string,
  taken: Map<string, string>,
  log: (message: string) => void,
): Promise<string> {
  const base = await deriveProjectKey(workspace)
  const holder = taken.get(base)
  if (!holder || holder === address) {
    taken.set(base, address)
    return base
  }
  const suffixed = `${base}-${workspace.key.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 4)}`
  log(`msg9 credentials: project-key conflict "${base}" (${holder} vs ${address}); using "${suffixed}" for ${address}`)
  taken.set(suffixed, address)
  return suffixed
}

// ------------------------------------------------------------------ yaml IO

export interface ProjectCredentials {
  address: string
  api_key: string
  api_url: string
  created_at?: string
}

/** 极简 yaml 解析（`key: value` 行，本模块写出的格式）。 */
function parseYaml(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line.trim())
    if (match) out[match[1]!] = match[2]!
  }
  return out
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700).catch(() => {})
}

export async function readProjectCredentials(projectKey: string): Promise<ProjectCredentials | undefined> {
  let raw: string
  try {
    raw = await readFile(projectYamlPath(projectKey), 'utf8')
  } catch {
    return undefined
  }
  const parsed = parseYaml(raw)
  if (!parsed.address || !parsed.api_key) return undefined
  return {
    address: parsed.address,
    api_key: parsed.api_key,
    api_url: parsed.api_url || defaultApiUrl(),
    ...(parsed.created_at ? { created_at: parsed.created_at } : {}),
  }
}

export async function readSigningSeed(projectKey: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(signingYamlPath(projectKey), 'utf8')
  } catch {
    return undefined
  }
  return parseYaml(raw).signing_seed || undefined
}

/**
 * 写 project yaml（0600，父目录 0700）。默认不覆盖已存在的文件（凭据仓
 * 为准）；rotation / tenant 迁移换 key 时显式传 overwrite。
 */
export async function writeProjectCredentials(
  projectKey: string,
  creds: { address: string; api_key: string; api_url: string },
  options?: { overwrite?: boolean },
): Promise<boolean> {
  await ensureDir(projectsDir())
  const path = projectYamlPath(projectKey)
  if (!options?.overwrite && await readProjectCredentials(projectKey)) return false
  const created = (await readProjectCredentials(projectKey))?.created_at ?? new Date().toISOString()
  await writeFile(
    path,
    `address: ${creds.address}\napi_key: ${creds.api_key}\napi_url: ${creds.api_url}\ncreated_at: ${created}\n`,
    { mode: 0o600 },
  )
  await chmod(path, 0o600).catch(() => {})
  return true
}

export async function writeSigningSeed(projectKey: string, seed: string, options?: { overwrite?: boolean }): Promise<boolean> {
  await ensureDir(projectsDir())
  const path = signingYamlPath(projectKey)
  if (!options?.overwrite && await readSigningSeed(projectKey)) return false
  await writeFile(path, `signing_seed: ${seed}\ncreated_at: ${new Date().toISOString()}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
  return true
}

/**
 * 按规范解析 pod 租户 key（`address-format.md` §5 / `12-org-pods.md`）。
 *
 * 优先级（规范原文）：
 *   ① `MSG9_TENANT_KEY=<路径>` / 显式指定
 *   ② `tenants/<pod>-<org>.key`（新模型，pod 级）
 *   ③ `tenants/<harness>.key`（**旧模型，存量**）
 *   ④ `tenants/` 里唯一一把 `*.key`
 *   **多把 key 且不显式指定 → 报错列候选，不替调用方猜。**
 *
 * ⚠️ 为什么这里要"报错"而不是"挑一把"（2026-09-30 事故）：
 * 原实现硬编码 `tenants/dsh.key`，于是一次 `msg9_setup` 覆盖它就把**全机 24 个
 * workspace 一起换了域**（DEF-001 静默覆盖，已复发 2 次）。规范写明"不会替你猜"——
 * 本函数即该条的实现；旧 harness key 仍在时，只要同目录还有别的 key 就必须显式点名。
 *
 * @example 只有一把 key ⇒ 直接用它（存量平滑）；两把以上 ⇒ 抛 TenantKeyAmbiguousError
 */
export class TenantKeyAmbiguousError extends Error {
  readonly candidates: string[]
  constructor(candidates: string[]) {
    super(
      'msg9 租户 key 不唯一，拒绝替你猜（规范 address-format.md §5）。'
      + `候选取自 ${tenantsDir()}/：${candidates.join(', ')}。`
      + '请显式指定：env MSG9_TENANT_KEY=<路径>，或在设置里为该项目选定 pod key。',
    )
    this.name = 'TenantKeyAmbiguousError'
    this.candidates = candidates
  }
}

/** `tenants/` 下所有 `*.key`（`.bak` 等不参与匹配，规范明文）。 */
async function listTenantKeyFiles(): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(tenantsDir())
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.key') && !name.includes('.bak'))
    .sort()
}

/**
 * 解析租户 key。返回 `{ key, source }`，`source` 用于面板/日志说明"这把 key 是谁"。
 * 找不到返回 undefined（**不是错误**：未配置是合法状态，调用方据此走"未开启"）。
 */
export async function readTenantKeyWithSource(): Promise<{ key: string; source: string } | undefined> {
  // ① 环境变量显式指定（规范第一优先级；永不落盘）
  const envPath = process.env.MSG9_TENANT_KEY
  if (envPath) {
    try {
      const key = (await readFile(envPath, 'utf8')).trim()
      if (key) return { key, source: `MSG9_TENANT_KEY=${envPath}` }
    } catch {
      /* 显式指定但读不到：继续往下找，由候选报错兜底 */
    }
  }
  const files = await listTenantKeyFiles()

  // ② pod 模型：`tenants/<pod>-<org>.key`
  //    规范示例：pod `dsh` + org `ice` ⇒ `tenants/dsh-ice.key`
  const known = await knownTenantKeyName()
  if (known && files.includes(known)) {
    const key = await readTenantKeyFile(known)
    if (key) return { key, source: `tenants/${known}` }
  }

  // ②b ORG 已绑定、但 pod label 未显式指定 ⇒ 按"本项目名"猜一个 pod 名试一下。
  //     理由：ORG 绑定本身就说明了"这个实例属于哪个 ORG"，
  //     而 pod 名在本项目里是有语义的（P1 项目即 pod ⇒ 通常等于项目/目录名）。
  //     **只在文件真的存在时才用** —— 猜不到就继续往下走，绝不凭空造 key。
  const orgLabel = (await loadState()).org?.label
  if (orgLabel) {
    const guessed = await guessPodKeyName(orgLabel, files)
    if (guessed) {
      const key = await readTenantKeyFile(guessed)
      if (key) return { key, source: `tenants/${guessed}（按 ORG 绑定的 pod 推导）` }
    }
  }

  // ③ 旧 harness 模型：tenants/dsh.key（存量）
  //    仅在【没有别的 key】时使用；有别的 key 就必须显式点名（规范"多把不猜"）。
  const legacy = 'dsh.key'
  if (files.length === 1 && files[0] === legacy) {
    const key = await readTenantKeyFile(legacy)
    if (key) return { key, source: `tenants/${legacy}（旧模型存量）` }
  }

  // ④ 唯一一把 ⇒ 用它；多把 ⇒ 报错列候选
  if (files.length === 1) {
    const key = await readTenantKeyFile(files[0]!)
    if (key) return { key, source: `tenants/${files[0]}` }
  }
  if (files.length > 1) {
    // 旧 key 也在候选里 —— 正是它当年"静默优先"把 agent 开进了旧租户。
    throw new TenantKeyAmbiguousError(files)
  }
  return undefined
}

/** 读单个候选文件的内容（空白/读不到返回 undefined）。 */
async function readTenantKeyFile(name: string): Promise<string | undefined> {
  try {
    const key = (await readFile(join(tenantsDir(), name), 'utf8')).trim()
    return key || undefined
  } catch {
    return undefined
  }
}

/**
 * 当前实例已知的 pod key 文件名（`<pod>-<org>.key`）。
 *
 * 只有**明确知道**自己在用哪个 pod 时才返回文件名：
 * `state.org.pod_label`（ORG 绑定里的默认 pod）优先，其次 owner 上探测到的
 * `pod_label`/`org_label`。都不知道 ⇒ undefined ⇒ 退回"多把就报错列候选"。
 *
 * ⚠️ 这里踩过一个坑，值得留着：最初只读 owner 上那两个字段时，用户明明在设置里
 * 绑好了 ORG（写进 `state.org`），但 `owner.pod_label` 要等一次 `/owner/me` 探测
 * 才有值 —— 于是**绑定成功后仍解析不出 key**，`/overview` 直接抛"key 不唯一"，
 * 面板表现成"点了没反应"。**绑定成功 ≠ 能被解析出来，两件事都得成立。**
 */
async function knownTenantKeyName(): Promise<string | undefined> {
  const state = await loadState()
  const orgLabel = state.org?.label
  const podFromOrg = state.org?.pod_label
  if (orgLabel && podFromOrg) return `${sanitizeKey(podFromOrg)}-${sanitizeKey(orgLabel)}.key`
  const label = state.owner?.pod_label
  const org = state.owner?.org_label
  if (!label || !org) return undefined
  return `${sanitizeKey(label)}-${sanitizeKey(org)}.key`
}

/**
 * ORG 已绑定但没指定 pod label 时，从**已存在的 key 文件**里挑一个 `<pod>-<org>.key`。
 *
 * 为什么不直接报错：用户刚绑完 ORG、还没开 pod，此时 `state.org.pod_label` 是空的；
 * 而本项目在 `tenants/` 下**确实已经有**正确的那把（`dsh-ice.key`）。
 * **文件存在 = 事实**，比"猜一个名字"可靠得多，也比"因为没配置就整个页面报错"合理。
 *
 * 多个候选时取**字典序第一个**并在返回值里带上 source，让用户看得见用了哪个 ——
 * 这仍然不是"替你猜租户"（那需要 key 里有租户信息，我们没有），
 * 而是"按文件名收敛"，且只在确实存在时才生效。
 */
async function guessPodKeyName(orgLabel: string, files: string[]): Promise<string | undefined> {
  const suffix = `-${sanitizeKey(orgLabel)}.key`
  const matches = files.filter((name) => name.endsWith(suffix))
  if (matches.length === 0) return undefined
  return matches.sort()[0]
}

/**
 * 旧签名：只要 key、不要来源。**保留是为了不动既有调用点**，
 * 但现在它会**在 key 不唯一时抛错**（旧行为是静默取 `dsh.key`）。
 */
export async function readTenantKey(): Promise<string | undefined> {
  return (await readTenantKeyWithSource())?.key
}

/**
 * 写 pod 租户 key。按规范写到 `tenants/<pod>-<org>.key`；
 * 信息不足时退回旧路径（`dsh.key`）以保持存量兼容。
 */
export async function writeTenantKey(key: string, scope?: { podLabel?: string; orgLabel?: string }): Promise<void> {
  await ensureDir(tenantsDir())
  const name = scope?.podLabel && scope?.orgLabel
    ? `${sanitizeKey(scope.podLabel)}-${sanitizeKey(scope.orgLabel)}.key`
    : 'dsh.key'
  const path = join(tenantsDir(), name)
  await writeFile(path, `${key}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

// ------------------------------------------------------------------ ORG key

/**
 * 读 ORG key（`~/.msg9/orgs/<org>.key`）。
 *
 * 与 pod key 不同，这里**不做"多把就报错"**：ORG 与项目是多对多的
 * （一个 ORG 下可以有多个 pod；一台机器可以接多个 ORG），
 * 所以"哪把 ORG key 用在哪"必须由**显式配置**（state.org.label）决定，而不是猜。
 * 无显式配置时退回"唯一一把"，多把则返回 undefined 由调用方提示去设置里选。
 */
export async function readOrgKey(orgLabel?: string): Promise<{ key: string; label: string; source: string } | undefined> {
  // ① 环境变量（测试/一次性用；永不落盘）
  const envKey = process.env.MSG9_ORG_KEY
  if (envKey) return { key: envKey, label: orgLabel ?? 'env', source: 'MSG9_ORG_KEY' }

  // ② 显式指定 org ⇒ 精确读那一把
  if (orgLabel) {
    const path = orgKeyPath(orgLabel)
    try {
      const key = (await readFile(path, 'utf8')).trim()
      if (key) return { key, label: orgLabel, source: `orgs/${sanitizeKey(orgLabel)}.key` }
    } catch { /* 落到候选逻辑 */ }
  }

  // ③ 未指定 ⇒ 唯一一把才敢用；多把说明需要用户去设置里选
  let names: string[]
  try {
    names = (await readdir(orgsDir())).filter((n) => n.endsWith('.key') && !n.includes('.bak')).sort()
  } catch {
    return undefined
  }
  if (names.length !== 1) return undefined
  const name = names[0]!
  try {
    const key = (await readFile(join(orgsDir(), name), 'utf8')).trim()
    if (!key) return undefined
    return { key, label: name.replace(/\.key$/, ''), source: `orgs/${name}` }
  } catch {
    return undefined
  }
}

/** 写 ORG key（0600）。`label` 用作文件名，也是 state 里的归属标识。 */
export async function writeOrgKey(orgLabel: string, key: string): Promise<void> {
  await ensureDir(orgsDir())
  const path = orgKeyPath(orgLabel)
  await writeFile(path, `${key}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

/** 清掉 ORG key（用户改主意/换 ORG 时用）。 */
export async function removeOrgKey(orgLabel: string): Promise<void> {
  await rm(orgKeyPath(orgLabel), { force: true }).catch(() => {})
}

// --------------------------------------------------------------- 惰性迁移

/** state.json 里还残留明文凭据（= 还没迁完）。 */
export function hasLegacyCredentials(state: State): boolean {
  if (state.owner?.api_key) return true
  return Object.values(state.workspaces).some((inbox) => Boolean(inbox.api_key || inbox.signing_seed))
}

/** marks 合并：registry 为准，cwd: 补缺；同字段两边都有时取时间较新的。 */
function mergeMarks(base: Record<string, MessageMark>, extra: Record<string, MessageMark>): Record<string, MessageMark> {
  const out: Record<string, MessageMark> = { ...base }
  for (const [id, mark] of Object.entries(extra)) {
    const existing = out[id]
    if (!existing) {
      out[id] = { ...mark }
      continue
    }
    for (const field of ['read_by', 'processed_by'] as const) {
      if (mark[field] && !existing[field]) {
        existing[field] = mark[field]
        const atField = field === 'read_by' ? 'read_at' : 'processed_at'
        existing[atField] = mark[atField]
      } else if (mark[field] && existing[field]) {
        const atField = field === 'read_by' ? 'read_at' : 'processed_at'
        if ((mark[atField] ?? '') > (existing[atField] ?? '')) {
          existing[field] = mark[field]
          existing[atField] = mark[atField]
        }
      }
    }
  }
  return out
}

/**
 * 全量惰性迁移，在 state 文件锁内执行（调用方resolve* 检测到残留时触发，
 * 幂等，可重入）：
 *
 *   1. cwd:<path> bucket 合一进对应 registry uuid bucket（registry 为准；
 *      cwd: 的身份/密钥只在 registry 缺失时补位；marks 合并取较新；registry
 *      没有对应 workspace 的 cwd: bucket 原样保留，自己迁移）；
 *   2. 每个还留明文字段的 workspace：推导 project-key → 写 yaml（已存在
 *      则以凭据仓为准，不覆盖）→ 写 signing.yaml → 清 state 残留字段并记
 *      project_key / migrated_at。单个 entry 写盘失败：保留旧字段（下次
 *      重试），继续处理其他 entry；
 *   3. owner 的遗留 api_key → tenants/dsh.key（同样已存在不覆盖）。
 */
export function ensureCredentialsMigrated(deps: Partial<MigrationDeps> = {}): Promise<void> {
  const { listWorkspaces, log } = { ...defaultDeps(), ...deps }
  return withStateLock(async () => {
    const state = await loadState()
    let dirty = false

    // Step 1: cwd: bucket 合一（迁移前先行）。
    const registered = listWorkspaces()
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      if (!key.startsWith('cwd:')) continue
      const target = registered.find((workspace) => workspace.path === (inbox.path || key.slice(4)))
      if (!target || target.key === key) continue
      const existing = state.workspaces[target.key]
      if (!existing) {
        // registry 还没有 bucket：整个挪过去（老的 key-continuity 行为）。
        state.workspaces[target.key] = { ...inbox }
      } else {
        // registry 为准；cwd: 的身份/密钥只在 registry 缺失时补位。
        existing.address ??= inbox.address
        existing.api_key ??= inbox.api_key
        existing.api_url ??= inbox.api_url
        existing.signing_seed ??= inbox.signing_seed
        existing.cursor ??= inbox.cursor
        existing.last_message_id ??= inbox.last_message_id
        existing.watch_cursor ??= inbox.watch_cursor
        existing.watch_last_message_id ??= inbox.watch_last_message_id
        existing.watch_last_seen_at = [existing.watch_last_seen_at ?? '', inbox.watch_last_seen_at ?? ''].sort()[1] || undefined
        if (inbox.marks) existing.marks = mergeMarks(existing.marks ?? {}, inbox.marks)
      }
      delete state.workspaces[key]
      dirty = true
      log(`msg9 credentials: merged legacy bucket "${key}" into "${target.key}"`)
    }

    // Step 2: 逐 workspace 迁移明文字段到凭据仓。
    const taken = new Map<string, string>()
    for (const inbox of Object.values(state.workspaces)) {
      if (inbox.project_key) {
        const known = await readProjectCredentials(inbox.project_key)
        if (known) taken.set(inbox.project_key, known.address)
      }
    }
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      if (!inbox.api_key && !inbox.signing_seed) continue
      try {
        const address = inbox.address ?? ''
        const projectKey = inbox.project_key
          ?? await allocateProjectKey({ key, title: inbox.title, path: inbox.path }, address, taken, log)
        if (inbox.api_key && address) {
          const written = await writeProjectCredentials(projectKey, {
            address,
            api_key: inbox.api_key,
            api_url: inbox.api_url || defaultApiUrl(),
          })
          if (!written) {
            const kept = await readProjectCredentials(projectKey)
            if (kept && kept.address !== address) {
              log(`msg9 credentials: ${projectYamlPath(projectKey)} already exists for ${kept.address}; it wins over the state residue (${address})`)
            }
          }
        }
        if (inbox.signing_seed) await writeSigningSeed(projectKey, inbox.signing_seed)
        delete inbox.address
        delete inbox.api_key
        delete inbox.api_url
        delete inbox.signing_seed
        inbox.project_key = projectKey
        inbox.migrated_at = new Date().toISOString()
        dirty = true
      } catch (error) {
        // 写盘失败：旧字段原样保留（下次读到再重试），其他 entry 继续。
        log(`msg9 credentials: migration of "${key}" failed (${(error as Error)?.message ?? String(error)}); legacy fields kept, will retry`)
      }
    }

    // Step 3: owner key → tenants/dsh.key。
    if (state.owner?.api_key) {
      try {
        if (!await readTenantKey()) await writeTenantKey(state.owner.api_key)
        delete state.owner.api_key
        state.owner.migrated_at = new Date().toISOString()
        dirty = true
      } catch (error) {
        log(`msg9 credentials: owner key migration failed (${(error as Error)?.message ?? String(error)}); legacy field kept, will retry`)
      }
    }

    if (dirty) await saveState(state)
  })
}

// --------------------------------------------------------------- 统一入口

/**
 * 解析一个 workspace 的完整信箱（热状态 + 身份与密钥）。解析顺序：
 * 凭据仓（project_key → yaml）→ state.json 旧字段（触发惰性迁移后重读；
 * 迁移失败时退回旧字段，下次再试）→ undefined（未开通）。
 *
 * 所有需要 address/api_key/signing_seed 的调用点必须走这里。
 */
export async function resolveCredentials(key: string, deps: Partial<MigrationDeps> = {}): Promise<LiveInbox | undefined> {
  const log = deps.log ?? (() => {})
  let state = await loadState()
  let inbox = state.workspaces[key]
  if (!inbox) return undefined
  if (inbox.api_key || inbox.signing_seed || !inbox.project_key) {
    await ensureCredentialsMigrated(deps)
    state = await loadState()
    inbox = state.workspaces[key]
    if (!inbox) return undefined
  }
  if (inbox.project_key) {
    const creds = await readProjectCredentials(inbox.project_key)
    if (creds) {
      const seed = await readSigningSeed(inbox.project_key)
      return {
        ...inbox,
        address: creds.address,
        api_key: creds.api_key,
        api_url: creds.api_url,
        ...(seed ? { signing_seed: seed } : {}),
      }
    }
    log(`msg9 credentials: ${projectYamlPath(inbox.project_key)} is missing; falling back to state residue`)
  }
  // 迁移失败（或 yaml 丢失）且旧字段还在：退回旧字段，保证读路径不断。
  if (inbox.address && inbox.api_key) {
    return { ...inbox, address: inbox.address, api_key: inbox.api_key, api_url: inbox.api_url || defaultApiUrl() }
  }
  return undefined
}

/**
 * Effective owner：环境变量 MSG9_OWNER_KEY 优先（永不落盘）；然后凭据仓
 * tenants/dsh.key + state.json 里的元数据；state.json 旧字段触发惰性迁移
 * （失败时退回旧字段）。
 */
export async function resolveOwner(deps: Partial<MigrationDeps> = {}): Promise<OwnerState | undefined> {
  const envKey = process.env.MSG9_OWNER_KEY
  if (envKey) {
    return { api_key: envKey, api_url: defaultApiUrl(), name: process.env.MSG9_OWNER_NAME }
  }
  let state = await loadState()
  if (state.owner?.api_key) {
    await ensureCredentialsMigrated(deps)
    state = await loadState()
  }
  const meta = state.owner
  const key = await readTenantKey()
  if (!key) {
    // 迁移失败且旧字段还在：退回旧字段。
    return meta?.api_key ? { ...meta, api_key: meta.api_key } : undefined
  }
  return { ...(meta ?? { api_url: defaultApiUrl() }), api_key: key }
}

/**
 * 绑定/更新 owner：key 写凭据仓（tenants/dsh.key），元数据（去掉明文 key）
 * 写 state.json。
 */
export async function saveOwner(owner: OwnerState): Promise<void> {
  await writeTenantKey(owner.api_key)
  return withStateLock(async () => {
    const state = await loadState()
    const { api_key: _secret, ...meta } = owner
    state.owner = { ...meta, migrated_at: new Date().toISOString() }
    await saveState(state)
  })
}

/** 供 overview 的 credentials_migrated 标志：state.json 已无任何明文凭据。 */
export async function credentialsMigrated(): Promise<boolean> {
  return !hasLegacyCredentials(await loadState())
}
