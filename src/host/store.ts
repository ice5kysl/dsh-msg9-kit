/**
 * State store for dsh-msg9-kit.
 *
 * The model is: **one dsh instance = one msg9 owner (tenant)**, and **one inbox
 * per dsh workspace**, so sibling workspaces can exchange messages and a single
 * owner key manages them all.
 *
 *   $DSH_HOME/msg9-kit/state.json        (default ~/.dsh/msg9-kit/state.json)
 *   {
 *     "owner":      { "api_url": "…", "id": "own_…", "slug": "…" },   // 元数据（探测缓存）
 *     "workspaces": { "<workspaceId>": { "project_key": "…", "title": "…", "cursor": "…" } }
 *   }
 *
 * state.json 只放热状态与元数据。身份与密钥（owner key、inbox address/api_key、
 * signing seed）的唯一真实来源是 msg9 统一凭据仓 `~/.msg9/`（见
 * credentials.ts）；state.json 里若还读到这些字段，那是凭据仓之前的历史
 * 残留，读到即触发惰性迁移，迁完删除。
 *
 * The owner key is optional: without it each workspace falls back to public
 * self-registration, which still allows cross-workspace messaging (addresses
 * are global) but loses tenant-level lifecycle/quota management.
 *
 * @module dsh-msg9-kit/store
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * state.json 里持久化的 owner：元数据（探测缓存）+ 迁移前遗留的明文 key。
 * key 的唯一真实来源是 msg9 统一凭据仓 `~/.msg9/tenants/dsh.key`，
 * 这里的 `api_key` 是凭据仓之前的历史残留——读到即触发惰性迁移，迁完删除。
 */
export interface StoredOwnerState {
  api_url: string
  id?: string
  name?: string
  /**
   * Tenant subdomain assigned by the msg9 server (`<agent>@<slug>.msg9.io`).
   * `undefined` = never probed (pre-upgrade state), `null` = the server says
   * this owner has none (flat `@msg9.io` namespace).
   */
  slug?: string | null
  /** Mail domain reported by the server (defaults to msg9.io). */
  mail_domain?: string
  /**
   * The pod's actual address domain (v1.22+ ORG model, e.g.
   * `dsh.ice.msg9.io` — pod dsh under org ice). Present on owner/me since the
   * ORG upgrade. When set it WINS over `${slug}.${mail_domain}` for previews,
   * legacy detection and display. `undefined` = never probed; `null` = probed,
   * the server has none (flat namespace).
   */
  address_domain?: string | null
  /**
   * pod label（ORG 模型：`<agent>@<pod>.<org>.<base>` 里的 `<pod>`）。
   * `owner/me` 已回该字段；用于推导 `tenants/<pod>-<org>.key` 的文件名
   * （规范 `address-format.md` §5）。
   */
  pod_label?: string | null
  /**
   * ORG label（地址里的 `<org>`）。与 `pod_label` 合起来定位 pod key 文件名。
   * 注意：这与 ORG **key**（`msg9_ok_…`，平台级凭证）不是一回事 ——
   * 后者只用于开通 pod，**不参与收发**（`12-org-pods.md` §4）。
   */
  org_label?: string | null
  /** 凭据迁入 ~/.msg9 的时间（遗留字段清理完成的标记）。 */
  migrated_at?: string
  /** 迁移前遗留的 owner key：惰性迁往 ~/.msg9/tenants/dsh.key 后删除。 */
  api_key?: string
}

/** 内存里的 owner：api_key 已从凭据仓 / 环境变量 / 遗留字段解析出来。 */
export interface OwnerState extends StoredOwnerState {
  api_key: string
}

/**
 * Tenant mode: an owner key that also pins a tenant domain.
 *
 * The ORG model (v1.22) moved the tenant domain into `address_domain` and makes
 * pods answer `slug: ""`, so a truthiness test on `slug` alone reads a fully
 * bound org tenant as "no tenant at all".
 */
export function isTenantOwner(owner: { slug?: string | null; address_domain?: string | null } | undefined): boolean {
  return Boolean(owner && (owner.slug || owner.address_domain))
}

export interface WorkspaceInbox {
  /** msg9 统一凭据仓里的 project-key（`~/.msg9/projects/dsh/<key>.yaml`）。 */
  project_key?: string
  /**
   * 用户指定的地址 local part（如 `dsh` → `dsh@<租户域>`）：开通/迁移时优先尝试，
   * 并存下来让预览与后续重开保持一致。
   */
  preferred_address?: string
  /** 凭据迁入 ~/.msg9 的时间。 */
  migrated_at?: string
  title: string
  path: string
  /** Incremental inbox cursor (opaque `next_cursor` from the last pull). */
  cursor?: string
  /** Newest message id already reported (bootstrap baseline). */
  last_message_id?: string
  /** The watcher's own cursor — kept separate from the tool's `cursor`, so a
   * background peek never eats the mail `msg9_inbox` would report as new. */
  watch_cursor?: string
  /** The watcher's bootstrap baseline (newest message id it has seen). */
  watch_last_message_id?: string
  /** Timestamp half of the baseline: re-announcement is impossible even when
   * the id scrolls off the page or the state is rebuilt. */
  watch_last_seen_at?: string
  /** Sticky delivery target: the session this inbox's notices went to last
   * time. While it stays alive, notices keep going there instead of drifting
   * to whatever session is newest. */
  last_wake_agent_id?: string
  /**
   * Local read/processed attribution, keyed by message id. msg9's server-side
   * `read_at` cannot say WHO marked it (the panel and the agent share one key),
   * so the marking channel records itself here until the server grows native
   * read/processed state. `processed` = closed loop (replied or explicitly
   * marked done); unprocessed mail is what「待处理」filters on.
   */
  marks?: Record<string, MessageMark>
  // ---- 以下四个字段是 msg9 统一凭据仓之前的历史残留：身份与密钥的唯一真实
  // 来源是 ~/.msg9/projects/dsh/<project_key>.yaml（+ .signing.yaml），读到
  // 即触发惰性迁移（见 credentials.ts），迁完从 state.json 删除。
  address?: string
  api_key?: string
  api_url?: string
  /** Ed25519 signing seed (base64, 32-byte RFC 8032)，迁移前存这里。 */
  signing_seed?: string
}

/** 内存里的完整信箱：热状态 + 已从凭据仓解析出的身份与密钥。 */
export interface LiveInbox extends WorkspaceInbox {
  address: string
  api_key: string
  api_url: string
}

export interface MessageMark {
  read_by?: 'human' | 'agent'
  read_at?: string
  processed_by?: 'human' | 'agent'
  processed_at?: string
}

export interface State {
  owner?: StoredOwnerState
  /**
   * ORG 级配置（主人 2026-09-30 定的形态：设置里填 ORG key，默认不开 Pod）。
   *
   * 只存**指向性元数据**；ORG key 本体在 `~/.msg9/orgs/<label>.key`（0600）——
   * 与 owner key / agent key 同样的纪律：明文 key 不进 state.json。
   */
  org?: StoredOrgState
  workspaces: Record<string, WorkspaceInbox>
  /** Global notification mute: the watcher keeps its cursors advancing (no
   * backlog replay) but never wakes/injects sessions. The panel badge keeps
   * working. Toggled from the panel bell or msg9_notify. */
  notify_paused?: boolean
}

/** ORG 绑定的元数据（key 本体不在 state.json 里）。 */
export interface StoredOrgState {
  /** ORG label（地址 `<org>` 那一段），也是 key 文件名。 */
  label: string
  /** ORG id（`org_…`），服务端返回，便于对账。 */
  id?: string
  /** ORG 显示名。 */
  name?: string
  /** API 基址（默认走 `defaultApiUrl()`）。 */
  api_url?: string
  /** 该 ORG 下本项目要用的默认 pod label（不填则由 workspace 推导）。 */
  pod_label?: string
  /**
   * 每个 workspace 的 pod label 覆盖（主人 2026-09-30：
   * 「免得自动生成的 pod slug 很乱」⇒ 允许人工改）。
   *
   * 键是 workspace key，值是 pod label。**只影响"还没开的 Pod"**——
   * 已开 Pod 的 label 是既成事实（地址已经发出去了，改 label 等于换地址）。
   */
  pod_labels?: Record<string, string>
  /** 校验通过的时间。 */
  verified_at?: string
}

/** Absolute path of the state file. */
export function stateFilePath(): string {
  if (process.env.MSG9_STATE_FILE) return process.env.MSG9_STATE_FILE
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'msg9-kit', 'state.json')
}

/** msg9 API base URL (default: the public service). */
export function defaultApiUrl(): string {
  return (process.env.MSG9_API_URL || 'https://api.msg9.io').replace(/\/+$/, '')
}

export async function loadState(): Promise<State> {
  let raw: string
  try {
    raw = await readFile(stateFilePath(), 'utf8')
  } catch (error) {
    // A missing file is the normal first-run case; anything else (EACCES …)
    // must surface instead of masquerading as "no state".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workspaces: {} }
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as Partial<State> | undefined
    // NOTE: every persisted top-level field must be re-hydrated here —
    // dropping one silently turns it into a write-only field (the
    // notify_paused regression: mute survived until the next read).
    return {
      owner: parsed?.owner,
      // ORG 绑定（2026-09-30 新增）。**必须在这里显式 re-hydrate**，
      // 否则它会变成"写得进、读不出"的字段 —— 上面那条注释警告的正是这个。
      org: parsed?.org,
      workspaces: parsed?.workspaces ?? {},
      notify_paused: parsed?.notify_paused === true,
    }
  } catch (error) {
    // Never silently empty a corrupt file: it holds irreplaceable inbox keys.
    // Keep a copy for manual recovery and fail loudly.
    const backup = `${stateFilePath()}.corrupt-${Date.now()}`
    await writeFile(backup, raw, { mode: 0o600 }).catch(() => {})
    throw new Error(`msg9-kit state file is not valid JSON (a copy was kept at ${backup}): ${(error as Error).message}`)
  }
}

let tempCounter = 0

export async function saveState(state: State): Promise<void> {
  const file = stateFilePath()
  await mkdir(dirname(file), { recursive: true })
  // Write-then-rename: a crash mid-write must not leave a truncated state file.
  const temp = `${file}.tmp-${process.pid}-${(tempCounter += 1)}`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, file)
}

// In-process callers share one state file; serialize read-modify-write cycles
// so concurrent operations (cursor push vs. inbox upsert vs. owner binding)
// cannot overwrite each other with a stale snapshot.
let writeQueue: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(async () => {
    // 进程内队列挡不住同 DSH_HOME 的另一个 dsh 实例：写前再拿文件锁，
    // 否则两个实例的 read-modify-write 会互相覆盖（公开注册的 key 不可再生）。
    const release = await acquireStateLock()
    try {
      return await task()
    } finally {
      await release()
    }
  })
  writeQueue = run.catch(() => {})
  return run
}

/**
 * 在进程内写队列 + 跨进程文件锁内执行一段 read-modify-write。惰性迁移
 * （credentials.ts）用它把"写凭据 yaml + 清 state 残留"与日常写入串行化。
 * 注意：任务体内只能直接 loadState/saveState，不能再调 enqueueWrite 系
 * 函数（会自死锁）。
 */
export function withStateLock<T>(task: () => Promise<T>): Promise<T> {
  return enqueueWrite(task)
}

// ----------------------------------------------------------- 跨进程文件锁
// 简单 O_EXCL 锁文件（state.json.lock，内容 {pid, at}），不引第三方依赖。
// stale 判定：mtime 超过 30s，或持锁 PID 已死——两种都直接拆锁重来。

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 100
const LOCK_MAX_ATTEMPTS = 50 // 最多等 ~5s，然后响亮报错

async function acquireStateLock(): Promise<() => Promise<void>> {
  const lockPath = `${stateFilePath()}.lock`
  await mkdir(dirname(lockPath), { recursive: true })
  for (let attempt = 0; ; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      await handle.close()
      return async () => {
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true })
        continue
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        throw new Error(
          `msg9-kit state file is locked by another process (${lockPath}); ` +
          'multiple dsh instances sharing one DSH_HOME are not supported',
        )
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  let info
  try {
    info = await stat(lockPath)
  } catch {
    return true // 锁刚好被释放，下一轮重试即可拿到
  }
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true
  const raw = await readFile(lockPath, 'utf8').catch(() => '')
  let pid = NaN
  try {
    pid = Number(JSON.parse(raw).pid)
  } catch {
    /* 内容不可读就只看 mtime */
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0)
    } catch {
      return true // 持锁进程已经死了
    }
  }
  return false
}

/** The global notification mute (panel bell / msg9_notify). */
export async function getNotifyPaused(): Promise<boolean> {
  const state = await loadState()
  return state.notify_paused === true
}

export async function setNotifyPaused(paused: boolean): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    state.notify_paused = paused
    await saveState(state)
  })
}

export async function getWorkspaceInbox(key: string): Promise<WorkspaceInbox | undefined> {
  const state = await loadState()
  return state.workspaces[key]
}

/**
 * Merge a patch into a workspace inbox. Callers that hold a STALE snapshot
 * (e.g. msg9_rotate, which read the inbox before an upstream call) must pass
 * only the fields they actually changed — spreading the snapshot would write
 * its outdated cursor/marks back over whatever advanced meanwhile.
 */
export async function upsertWorkspaceInbox(key: string, patch: Partial<WorkspaceInbox>): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    state.workspaces[key] = { ...(state.workspaces[key] ?? {}), ...clean } as WorkspaceInbox
    await saveState(state)
  })
}

export async function deleteWorkspaceInbox(key: string): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    if (!(key in state.workspaces)) return
    delete state.workspaces[key]
    await saveState(state)
  })
}

/** Replace an inbox wholesale (migration): cursor fields must not survive. */
export async function replaceWorkspaceInbox(key: string, inbox: WorkspaceInbox): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    state.workspaces[key] = inbox
    await saveState(state)
  })
}

export async function setCursor(key: string, cursor: string): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    const existing = state.workspaces[key]
    if (!existing) return
    existing.cursor = cursor
    await saveState(state)
  })
}

export async function setLastMessageId(key: string, messageId: string): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    const existing = state.workspaces[key]
    if (!existing) return
    existing.last_message_id = messageId
    await saveState(state)
  })
}

/** Advance the watcher's own incremental state (never the tool's cursor). */
export async function setWatchState(key: string, patch: { watch_cursor?: string; watch_last_message_id?: string; watch_last_seen_at?: string; last_wake_agent_id?: string }): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    const existing = state.workspaces[key]
    if (!existing) return
    if (patch.watch_cursor !== undefined) existing.watch_cursor = patch.watch_cursor
    if (patch.watch_last_message_id !== undefined) existing.watch_last_message_id = patch.watch_last_message_id
    if (patch.watch_last_seen_at !== undefined) existing.watch_last_seen_at = patch.watch_last_seen_at
    if (patch.last_wake_agent_id !== undefined) existing.last_wake_agent_id = patch.last_wake_agent_id
    await saveState(state)
  })
}

/**
 * Record WHO read/processed a message (the server can't tell — the panel and
 * the agent share one key). Fields already set win: the first reader keeps
 * the attribution, and the first closer keeps the processed mark.
 */
export async function setMessageMark(key: string, messageId: string, patch: MessageMark): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    const existing = state.workspaces[key]
    if (!existing) return
    const marks = (existing.marks ??= {})
    const mark = (marks[messageId] ??= {})
    if (patch.read_by && !mark.read_by) {
      mark.read_by = patch.read_by
      mark.read_at = patch.read_at ?? new Date().toISOString()
    }
    if (patch.processed_by && !mark.processed_by) {
      mark.processed_by = patch.processed_by
      mark.processed_at = patch.processed_at ?? new Date().toISOString()
    }
    // Bound the map: marks older than the newest 500 ids are dropped (the
    // messages themselves age out of any listing long before that).
    const ids = Object.keys(marks)
    if (ids.length > 500) {
      const sorted = ids.sort((a, b) => (marks[a]!.processed_at ?? marks[a]!.read_at ?? '').localeCompare(marks[b]!.processed_at ?? marks[b]!.read_at ?? ''))
      for (const id of sorted.slice(0, ids.length - 500)) delete marks[id]
    }
    await saveState(state)
  })
}
