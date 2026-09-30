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
 * 各 harness 在项目 Pod 里使用的**固定** Agent 名（主人 2026-09-30 定案）。
 *
 * 规范地址 = **`<harness 名>@<项目 Pod>.<org>.<base>`**：
 *
 *   ```
 *   dsh@jev.ice.msg9.io      ← dsh harness 在「Jev」这个项目里的信箱
 *   kimi@jev.ice.msg9.io     ← kimi harness 在同一个项目里的信箱
 *   cc@jev.ice.msg9.io       ← claude harness（主人明确用 `cc`，不是 `claude`）
 *   ```
 *
 * **Agent 名不带项目后缀** —— 项目身份由 Pod 段承载，`dsh-jev-8221`、
 * `dsh-ws-04fe` 那种丑名字正是旧规则"一个 workspace 一个 agent 名"的产物，已废弃。
 */
export const HARNESS_AGENT_NAMES: Record<string, string> = {
  dsh: 'dsh',
  kimi: 'kimi',
  claude: 'cc',
}

/** 本插件跑在哪个 harness 里（决定规范的 Agent 名）。 */
export const HARNESS = 'dsh'

/** harness → 它在项目 Pod 里用的 Agent 名（未知 harness 就用它自己的名字）。 */
export function harnessAgentName(harness: string = HARNESS): string {
  return HARNESS_AGENT_NAMES[harness] ?? harness
}

/**
 * Derive a msg9 address for a workspace.
 *
 * Flat `@msg9.io` namespace (default): `dsh-<slug>-<hash4>` — the prefix marks
 * the harness and the deterministic hash (from the workspace key) makes
 * collisions across workspaces impossible. **这条不变**：扁平域里没有 Pod 段
 * 承载项目身份，只能靠本地部分区分。
 *
 * Tenant subdomain (`tenant: true`): **harness 名**（`dsh`）—— 项目身份由 Pod 段
 * 承载（`dsh@<pod>.<org>`），所以同一个项目的不同 harness 各占一个名字。
 *
 * ⚠️ 2026-09-30 变更：这里**原来返回 workspace slug**（→ `jev@dsh.ice`），
 * 方向是反的，是那 13 条"不规范"地址的根因。主人定案后改为 harness 名。
 * 冲突时**加可读后缀**（`dsh-2` / `dsh-dev`），不再退化成带哈希的丑名字
 * （见 `tenantAddressCandidates`）。
 */
export function deriveAddress(workspace: CurrentWorkspace, options?: { tenant?: boolean }): string {
  if (options?.tenant) return harnessAgentName()
  const slug = slugify(workspace.title) || slugify(basename(workspace.path)) || 'ws'
  const address = `dsh-${slug}-${shortHash(workspace.key)}`
  return address.slice(0, 30).replace(/[^a-z0-9]+$/, '')
}

/**
 * 租户模式下开通要试的本地部分，**按顺序**：显式指定 → harness 名 → `dsh-2`…
 *
 * 主人 2026-09-30 定的粒度（**两个都是他的原话**）：
 *
 * 1. 「大多数应该是 **1 个项目对应 1 个 workspace**」⇒ 默认就是 `dsh@<项目>`；
 * 2. 「如果有多个 dsh，后续可以加 **`dsh-1`、`dsh-2`** 或者 **`dsh-dev`、`dsh-fe`** 这样」
 *    ⇒ 撞名时**允许加可读后缀**，不是硬拒绝。
 *
 * ⚠️ 但与旧行为的**关键区别**：后缀必须是**可读**的。
 *    旧实现撞名时退化成 `<workspace-slug>-<hash4>`（`dsh-jev-8221`、`dsh-ws-04fe`）——
 *    那串哈希就是"认不出是谁"的根源，**已废弃**。这里只自动试 `dsh-2`…`dsh-4`
 *    这种一眼能读的编号；想要 `dsh-dev` / `dsh-fe` 这类**语义后缀**，
 *    由人显式指定（`preferred`）。
 */
export function tenantAddressCandidates(workspace: CurrentWorkspace, preferred?: string | null): string[] {
  void workspace
  const base = harnessAgentName()
  return [...new Set([
    ...(preferred ? [preferred] : []),
    base,
    `${base}-2`,
    `${base}-3`,
    `${base}-4`,
  ])]
}

/** msg9 local-part rules: 3–30 chars, lowercase alphanumerics, `-`/`_` inside. */
export function isValidLocalPart(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/.test(value)
}
