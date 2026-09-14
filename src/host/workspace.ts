/**
 * Resolve the workspace a tool call (or a browser request) belongs to.
 *
 * dsh binds every agent to a session, and a session records the absolute
 * directory it was created in (`session.header.cwd`). The workspace registry
 * maps that directory to a durable workspace record, which gives us a stable id
 * and a human title to name the inbox after.
 *
 * Fallback order:
 *   1. a registry workspace whose path equals (or contains) the directory;
 *   2. the directory itself (`key = "cwd:<path>"`);
 *   3. undefined — the caller then uses the `default` bucket.
 *
 * The same resolution serves the browser face: it knows the current session's
 * `cwd` (standard slot props) and passes it to `/dsh-msg9/*`.
 *
 * @module dsh-msg9-kit/workspace
 */

import type { Context } from '@deepseek-ai/cordis'

export interface CurrentWorkspace {
  /** Stable key used in the state file (workspace id, or `cwd:<path>`). */
  key: string
  /** Human title, used for the derived address slug. */
  title: string
  /** Absolute directory of the workspace. */
  path: string
}

interface SessionLike {
  header?: { cwd?: string }
}
interface WorkspaceLike {
  id: string
  title?: string
  path: string
}
interface WorkspaceBridge {
  sessions?: { get(id: string): SessionLike | undefined }
  workspaceRegistry?: { list(): WorkspaceLike[] }
}

/** The dsh workspace-registry service (optional; web profile only). */
export interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  resolveByPath?(path: string): Promise<{ sessionIds: readonly string[] } | undefined>
}

/**
 * The registry captured through an explicit `ctx.inject(['workspaceRegistry'])`.
 * In cordis, reading an un-injected service property throws, so reaching for
 * `ctx.workspaceRegistry` directly never worked at runtime — the try/catch
 * below silently degraded to "no registry" and every workspace fell back to
 * `cwd:` buckets. The plugin entry calls `setWorkspaceRegistry` instead.
 */
let injectedRegistry: WorkspaceRegistryLike | undefined

/** Called by the plugin entry once the optional registry service appears. */
export function setWorkspaceRegistry(registry: WorkspaceRegistryLike | undefined): void {
  injectedRegistry = registry
}

/** The injected registry, or the ctx cast for hand-rolled fake contexts (tests). */
function registryOf(ctx: Context): WorkspaceRegistryLike | undefined {
  if (injectedRegistry) return injectedRegistry
  try {
    return (ctx as unknown as WorkspaceBridge).workspaceRegistry
  } catch {
    return undefined
  }
}

/** The `exec` slice we read: the calling agent's session id. */
export interface CallerAgent {
  agent?: { id?: unknown }
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

function toCurrent(workspace: WorkspaceLike): CurrentWorkspace {
  return { key: workspace.id, title: workspace.title || basename(workspace.path), path: workspace.path }
}

/** The registry's workspaces, or an empty list when the profile has none. */
export function listWorkspaces(ctx: Context): CurrentWorkspace[] {
  try {
    return (registryOf(ctx)?.list?.() ?? []).map(toCurrent)
  } catch {
    return []
  }
}

/** 只看注入的 registry（无 ctx 的调用方，如凭据迁移的 cwd: 合一）。 */
export function listRegisteredWorkspaces(): CurrentWorkspace[] {
  try {
    return (injectedRegistry?.list?.() ?? []).map(toCurrent)
  } catch {
    return []
  }
}

/** One registry workspace by its durable id. */
export function workspaceByKey(ctx: Context, key: string): CurrentWorkspace | undefined {
  return listWorkspaces(ctx).find((workspace) => workspace.key === key)
}

/**
 * Match an absolute directory to a workspace: exact path first, then the
 * workspace that contains it. An unknown directory becomes its own
 * `cwd:<path>` bucket, so a session outside the registry still gets an inbox.
 */
export function matchWorkspaceByPath(ctx: Context, cwd: string | undefined): CurrentWorkspace | undefined {
  if (!cwd) return undefined
  const workspaces = listWorkspaces(ctx)
  const match = workspaces.find((workspace) => workspace.path === cwd)
    // Longest path wins: with /a and /a/b registered, a session in /a/b/c must
    // land in /a/b, not in whichever workspace the registry listed first.
    ?? [...workspaces].sort((a, b) => b.path.length - a.path.length)
      .find((workspace) => cwd.startsWith(`${workspace.path}/`))
  if (match) return match
  return { key: `cwd:${cwd}`, title: basename(cwd), path: cwd }
}

/** The directory a session was created in, when the host still holds it. */
export function cwdOfSession(ctx: Context, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const bridge = ctx as unknown as WorkspaceBridge
  try {
    return bridge.sessions?.get(sessionId)?.header?.cwd
  } catch {
    return undefined
  }
}

/** Resolve the workspace for the calling agent, if the host exposes it. */
export function resolveWorkspace(ctx: Context, exec?: CallerAgent): CurrentWorkspace | undefined {
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  return matchWorkspaceByPath(ctx, cwdOfSession(ctx, sessionId))
}

/** Lowercase, dash-separated, ASCII-only slug. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
}

/** Deterministic 4-hex suffix derived from an arbitrary key. */
export function shortHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 4)
}

/**
 * Derive a msg9 address for a workspace.
 *
 * Flat `@msg9.io` namespace (default): `dsh-<slug>-<hash4>` — the prefix marks
 * the harness and the deterministic hash (from the workspace key) makes
 * collisions across workspaces impossible.
 *
 * Tenant subdomain (`tenant: true`): `<slug>` — the harness already lives in
 * the domain (`@<tenant>.msg9.io`), so the local part is just the workspace
 * slug. Slugs shorter than msg9's 3-char minimum fall back to `<slug>-<hash4>`.
 *
 * Always satisfies msg9's rules (lowercase, `-`/`_`, alphanumeric ends, 3–30).
 */
export function deriveAddress(workspace: CurrentWorkspace, options?: { tenant?: boolean }): string {
  const slug = slugify(workspace.title) || slugify(basename(workspace.path)) || 'ws'
  if (options?.tenant) {
    if (slug.length >= 3) return slug.slice(0, 30).replace(/[^a-z0-9]+$/, '')
    return deriveTenantFallback(workspace)
  }
  const address = `dsh-${slug}-${shortHash(workspace.key)}`
  return address.slice(0, 30).replace(/[^a-z0-9]+$/, '')
}

/** Tenant-namespace conflict fallback: `<slug>-<hash4>` (deterministic). */
export function deriveTenantFallback(workspace: CurrentWorkspace): string {
  const slug = slugify(workspace.title) || slugify(basename(workspace.path)) || 'ws'
  return `${slug}-${shortHash(workspace.key)}`.slice(0, 30).replace(/[^a-z0-9]+$/, '')
}
