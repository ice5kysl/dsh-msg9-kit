/**
 * State store for dsh-msg9-kit.
 *
 * The model is: **one dsh instance = one msg9 owner (tenant)**, and **one inbox
 * per dsh workspace**, so sibling workspaces can exchange messages and a single
 * owner key manages them all.
 *
 *   $DSH_HOME/msg9-kit/state.json        (default ~/.dsh/msg9-kit/state.json)
 *   {
 *     "owner":      { "api_key": "msg9_tk_…", "id": "own_…", "api_url": "…" },
 *     "workspaces": { "<workspaceId>": { "address": "…", "api_key": "msg9_sk_…", … } }
 *   }
 *
 * The owner key is optional: without it each workspace falls back to public
 * self-registration, which still allows cross-workspace messaging (addresses
 * are global) but loses tenant-level lifecycle/quota management.
 *
 * @module dsh-msg9-kit/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface OwnerState {
  api_key: string
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
}

export interface WorkspaceInbox {
  address: string
  api_key: string
  api_url: string
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
   * Ed25519 signing seed (base64, 32-byte RFC 8032) for msg9-sig-v1 sends.
   * Installed lazily on first use after the v1.3 identity upgrade; the public
   * half lives on the server (`PUT /agent/signing-key`).
   */
  signing_seed?: string
  /**
   * Local read/processed attribution, keyed by message id. msg9's server-side
   * `read_at` cannot say WHO marked it (the panel and the agent share one key),
   * so the marking channel records itself here until the server grows native
   * read/processed state. `processed` = closed loop (replied or explicitly
   * marked done); unprocessed mail is what「待处理」filters on.
   */
  marks?: Record<string, MessageMark>
}

export interface MessageMark {
  read_by?: 'human' | 'agent'
  read_at?: string
  processed_by?: 'human' | 'agent'
  processed_at?: string
}

export interface State {
  owner?: OwnerState
  workspaces: Record<string, WorkspaceInbox>
  /** Global notification mute: the watcher keeps its cursors advancing (no
   * backlog replay) but never wakes/injects sessions. The panel badge keeps
   * working. Toggled from the panel bell or msg9_notify. */
  notify_paused?: boolean
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
  const run = writeQueue.then(task)
  writeQueue = run.catch(() => {})
  return run
}

/** Effective owner: an explicit env key wins over the saved one. */
export async function getOwner(): Promise<OwnerState | undefined> {
  const envKey = process.env.MSG9_OWNER_KEY
  if (envKey) {
    return { api_key: envKey, api_url: defaultApiUrl(), name: process.env.MSG9_OWNER_NAME }
  }
  const state = await loadState()
  return state.owner
}

export async function setOwner(owner: OwnerState): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    state.owner = owner
    await saveState(state)
  })
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

export async function upsertWorkspaceInbox(key: string, inbox: WorkspaceInbox): Promise<void> {
  return enqueueWrite(async () => {
    const state = await loadState()
    state.workspaces[key] = { ...(state.workspaces[key] ?? {}), ...inbox }
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
