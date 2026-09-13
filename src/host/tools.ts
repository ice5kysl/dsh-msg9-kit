/**
 * Model-facing tools of dsh-msg9-kit.
 *
 * Model: **one dsh instance = one msg9 owner (tenant)**, **one inbox per dsh
 * workspace**. Each tool resolves the calling session's workspace
 * (`exec.agent` → session cwd → workspace registry), then uses that
 * workspace's own msg9 inbox — provisioning it on first use.
 *
 * Reception is a cursor pull, which matches the turn-based dsh agent loop:
 * a workspace that was offline still gets everything on its next turn. Sends
 * are idempotent via `Idempotency-Key`.
 *
 * Tool metadata (descriptions/parameters) is English — the model consumes it;
 * output text is bilingual via `L()`.
 *
 * @module dsh-msg9-kit/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  Msg9ApiError,
  addContact,
  deleteContact,
  getMe,
  getMessage,
  listContacts,
  listInbox,
  listOutbox,
  markProcessed,
  markRead,
  ownerListAgents,
  ownerMe,
  ownerRotateAgentKey,
  resolveAddress,
  sendMessage,
  type InboxMessage,
  type InboxPage,
} from './api.ts'
import {
  bodyText,
  maskKey,
  resolveInbox,
  truncate,
  DEFAULT_WORKSPACE,
} from './service.ts'
import {
  defaultApiUrl,
  getNotifyPaused,
  getOwner,
  loadState,
  setCursor,
  setLastMessageId,
  setMessageMark,
  setNotifyPaused,
  setOwner,
  stateFilePath,
  upsertWorkspaceInbox,
} from './store.ts'
import { resolveWorkspace } from './workspace.ts'
import { L } from './locale.ts'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function errorText(error: unknown): string {
  if (error instanceof Msg9ApiError) {
    return L(
      'msg9 返回错误 {status}（code {code}）：{message}',
      'msg9 returned error {status} (code {code}): {message}',
      { status: error.status, code: error.code ?? '-', message: error.message },
    )
  }
  return L('msg9 请求失败：{message}', 'msg9 request failed: {message}', {
    message: (error as Error).message,
  })
}

function withoutSeen(messages: InboxMessage[], lastId?: string): InboxMessage[] {
  if (!lastId) return messages
  const index = messages.findIndex((message) => message.message_id === lastId)
  if (index < 0) return messages
  return messages.slice(0, index)
}

/** One-line lifecycle tag for a message: unread/read + open/processed. */
function statusOf(message: InboxMessage): string {
  const read = message.read_at ? 'read' : 'unread'
  const state = message.processed_at ? 'processed' : 'open'
  return `${read} · ${state}`
}

/** Render ONE message with its full body (the list only carries a preview). */
export function formatMessage(message: InboxMessage, bodyLimit = 0): string {
  const head = message.subject ? `${message.subject}\n` : ''
  const meta = [
    `${message.from_address} → ${message.to_address ?? ''}`.trim(),
    message.created_at ? String(message.created_at).slice(0, 19).replace('T', ' ') : '',
    statusOf(message),
    message.correlation_id ? `correlation ${message.correlation_id}` : '',
    `\`${message.message_id}\``,
  ].filter(Boolean).join(' · ')
  const text = bodyText(message)
  const body = text ? (bodyLimit > 0 ? truncate(text, bodyLimit) : text) : L('（无正文）', '(no body)')
  return `${head}${meta}\n\n${body}`
}

function formatMessages(
  messages: InboxMessage[],
  unread: number,
  note: string,
  opts: { full?: boolean; bodyLimit?: number } = {},
): string {
  if (messages.length === 0) {
    return L('没有新消息（未读 {unread}）。', 'No new messages ({unread} unread).', { unread })
  }
  const lines = messages.map((message) => {
    const subject = message.subject ? ` ${message.subject}` : ''
    const text = bodyText(message)
    if (opts.full) {
      // full:true is opt-in precisely because a screen of 10 complete letters
      // would blow up the caller's context — the default stays a preview.
      const body = opts.bodyLimit && opts.bodyLimit > 0 ? truncate(text, opts.bodyLimit) : text
      const head = `${message.subject ? `${message.subject}\n` : ''}${message.from_address} · ${statusOf(message)}${message.correlation_id ? ` · correlation ${message.correlation_id}` : ''} · \`${message.message_id}\``
      return `${head}\n\n${body || L('（无正文）', '(no body)')}\n`
    }
    const excerpt = text ? ` — ${truncate(text, 140)}` : ''
    return `· ${message.from_address}${subject}${excerpt}  \`${message.message_id}\``
  })
  const head = L('{count} 条消息（未读 {unread}）：', '{count} message(s) ({unread} unread):', {
    count: messages.length,
    unread,
  })
  return `${head}\n${lines.join('\n')}\n${note}`
}

/** Register all msg9 tools on `ctx.tools`. */
export function registerMsg9Tools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'msg9_setup',
    description:
      'Configure the msg9.io owner (tenant) for this dsh instance by saving its owner key (msg9_tk_...). ' +
      'With an owner configured, each workspace gets its own inbox under that owner — so sibling workspaces can ' +
      'message each other and one key manages them all. Skip this to use per-workspace public registration instead. ' +
      'If the human has no key yet, guide them: sign up at msg9.io → Account page → create a tenant → copy the ' +
      'msg9_tk_ key (shown once). The「消息」panel and Settings → 消息信箱 show the same three steps.',
    parameters: {
      owner_key: { type: 'string', required: true, description: 'The owner key, starting with "msg9_tk_".' },
      api_url: { type: 'string', description: 'msg9 API base (default: MSG9_API_URL or https://api.msg9.io).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const apiUrl = (args.api_url || defaultApiUrl()).replace(/\/+$/, '')
      try {
        const me = await ownerMe(apiUrl, args.owner_key, exec?.signal)
        const ownerId = typeof me?.id === 'string' ? me.id : undefined
        const ownerName = typeof me?.name === 'string' ? me.name : undefined
        await setOwner({ api_key: args.owner_key, api_url: apiUrl, id: ownerId, name: ownerName })

        const quota = (me?.quota ?? {}) as Record<string, unknown>
        const maxAgents = quota.max_agents
        return L(
          'owner 已配置：{name}（{id}），API {api}，配额 max_agents={maxAgents}。\n之后每个 workspace 首次使用会自动在该 owner 下开通收件箱。',
          'Owner configured: {name} ({id}), API {api}, quota max_agents={maxAgents}.\nEach workspace will now be provisioned automatically under this owner.',
          {
            name: ownerName ?? '(unnamed)',
            id: ownerId ?? '(unknown)',
            api: apiUrl,
            maxAgents: typeof maxAgents === 'number' ? maxAgents : '(n/a)',
          },
        )
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_inbox',
    description:
      'Pull new msg9.io messages for the CURRENT workspace, provisioning its inbox on first use. ' +
      'By default it continues from the saved cursor and advances it, so each call returns only what is new. ' +
      'Pass an explicit "since" to read a specific span without moving the cursor. ' +
      'Reading is believing: every unread message RETURNED by this call is marked read automatically — ' +
      'pass mark_read:false to peek without touching the read state. ' +
      'The list shows a ~140-char preview per message; pass full:true (or call msg9_message for one id) ' +
      'when a letter is longer than the preview.',
    parameters: {
      folder: { type: 'string', description: 'all | unread | read (default: all).' },
      limit: { type: 'integer', description: 'Max messages to return (default 20, max 100).' },
      since: { type: 'string', description: 'Explicit opaque cursor to read from; does not advance the saved cursor.' },
      advance: { type: 'boolean', description: 'Force cursor advancement even with an explicit since.' },
      mark_read: { type: 'boolean', description: 'Auto-mark returned unread messages as read (default: true). Pass false to peek.' },
      full: { type: 'boolean', description: 'Include each message FULL body instead of the ~140-char preview (default false).' },
      body_limit: { type: 'integer', description: 'With full:true, cap each body at N characters (default: no cap).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox, provisioned } = await resolveInbox(ctx, exec)
        const banner = L('[{title}] {address}', '[{title}] {address}', { title: workspace.title, address: inbox.address })
        const provisionNote = provisioned
          ? L('\n（已为本站开通收件箱）', '\n(inbox provisioned for this workspace)')
          : ''

        // Reading is believing: the agent has SEEN every returned message, so
        // unread ones are marked read without waiting for a human click.
        // Best-effort — a failed mark never fails the read itself. The agent
        // claims the attribution only while the message is still unmarked
        // (a human who already read it keeps the credit).
        const autoReadNote = async (messages: InboxMessage[], note: string): Promise<string> => {
          if (args.mark_read === false) {
            return `${note}${L('（预览模式：未改动已读状态）', '(peek — read state untouched)')}`
          }
          const unread = messages.filter((message) => !message.read_at)
          if (unread.length === 0) return note
          const settled = await Promise.allSettled(
            unread.map(async (message) => {
              await markRead(inbox.api_url, inbox.api_key, message.message_id, 'agent', exec?.signal)
              await setMessageMark(workspace.key, message.message_id, { read_by: 'agent' })
            }),
          )
          const marked = settled.filter((result) => result.status === 'fulfilled').length
          return L(
            '{note}（已自动标记 {n} 封为已读）',
            '{note} (auto-marked {n} as read)',
            { note, n: marked },
          )
        }

        const limit = Math.max(1, Math.min(args.limit ?? 20, 100))
        const explicit = args.since
        const since = explicit ?? inbox.cursor

        if (since) {
          const page = await listInbox(inbox.api_url, inbox.api_key, { folder: args.folder, limit, since }, exec?.signal)
          const advance = args.advance ?? (explicit === undefined)
          if (advance && page.next_cursor) await setCursor(workspace.key, page.next_cursor)
          const messages = page.messages ?? []
          return `${banner}${provisionNote}\n${formatMessages(
            messages,
            page.unread_count ?? 0,
            await autoReadNote(messages, advance
              ? L('游标已推进，下次只返回更新。', 'Cursor advanced; the next call returns only what is newer.')
              : L('未推进游标，可重复读取。', 'Cursor not advanced — safe to re-read.')),
            { full: args.full, bodyLimit: args.body_limit },
          )}`
        }

        const page: InboxPage = await listInbox(inbox.api_url, inbox.api_key, { folder: args.folder, limit }, exec?.signal)
        const all = page.messages ?? []
        if (page.next_cursor) {
          await setCursor(workspace.key, page.next_cursor)
          return `${banner}${provisionNote}\n${formatMessages(
            all,
            page.unread_count ?? 0,
            await autoReadNote(all, L('游标已推进，下次只返回更新。', 'Cursor advanced; the next call returns only what is newer.')),
            { full: args.full, bodyLimit: args.body_limit },
          )}`
        }
        const fresh = withoutSeen(all, inbox.last_message_id)
        const newest = all[0]?.message_id
        if (newest) await setLastMessageId(workspace.key, newest)
        return `${banner}${provisionNote}\n${formatMessages(
          fresh,
          page.unread_count ?? 0,
          await autoReadNote(fresh, L(
            '（首次拉取，已用「最新消息」作为增量基线）',
            '(first pull — the newest message is now the incremental baseline)',
          )),
          { full: args.full, bodyLimit: args.body_limit },
        )}`
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_message',
    description:
      'Read ONE msg9.io message IN FULL, by message_id. msg9_inbox only carries a ~140-char preview per row, ' +
      'so a long letter is unreadable from the list — use this before answering anything substantive. ' +
      'Marks the message read (pass mark_read:false to peek).',
    parameters: {
      message_id: { type: 'string', required: true, description: 'The message_id to read (from msg9_inbox, an outbox row, or a wake notice).' },
      body_limit: { type: 'integer', description: 'Cap the body at N characters (default: the whole letter).' },
      mark_read: { type: 'boolean', description: 'Mark it read (default true). Pass false to peek.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec)
        const message = await getMessage(inbox.api_url, inbox.api_key, args.message_id, exec?.signal)
        const banner = L('[{title}] {address}', '[{title}] {address}', { title: workspace.title, address: inbox.address })
        if (args.mark_read !== false && !message.read_at) {
          // Same "reading is believing" rule as msg9_inbox; a failed mark never
          // fails the read itself.
          await markRead(inbox.api_url, inbox.api_key, message.message_id, 'agent', exec?.signal).catch(() => {})
          await setMessageMark(workspace.key, message.message_id, { read_by: 'agent' }).catch(() => {})
        }
        return `${banner}\n${formatMessage(message, Math.max(0, args.body_limit ?? 0))}`
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_send',
    description:
      'Send a msg9.io message as the CURRENT workspace (provisioning its inbox on first use). ' +
      'Use msg9_peers to discover the other workspaces of this dsh instance, then send to their addresses to sync information. ' +
      'Retries are safe: the same Idempotency-Key returns the original message.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient address, e.g. "dsh-msg9-io-a1b2@msg9.io".' },
      text: { type: 'string', required: true, description: 'Message body in markdown (readers render it: headings, lists, tables, and fenced code blocks with a language tag, e.g. ```ts).' },
      subject: { type: 'string', description: 'Optional subject line.' },
      reply_to: { type: 'string', description: 'The message_id you are replying to. ALWAYS set it on replies: it closes (processed) the original precisely — correlation_id alone cannot when the original never carried one (typical for cross-system mail).' },
      correlation_id: { type: 'string', description: 'The THREAD id: copy it VERBATIM from the message you are answering; omit when it had none. Never invent one (e.g. reusing the message id) — that forks the thread and group convergence views never see your reply.' },
      idempotency_key: { type: 'string', description: 'Optional idempotency key; defaults to a generated one.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec)
        const idempotencyKey = args.idempotency_key || `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const result = await sendMessage(inbox.api_url, inbox.api_key, {
          to: args.to,
          subject: args.subject,
          text: args.text,
          replyTo: args.reply_to,
          correlationId: args.correlation_id,
          idempotencyKey,
        }, exec?.signal, inbox.signing_seed ? { from: inbox.address, seedBase64: inbox.signing_seed } : undefined)
        // 回复即处理: replying closes the loop on the original message.
        const closedId = args.reply_to ?? args.correlation_id
        if (closedId) await setMessageMark(workspace.key, closedId, { processed_by: 'agent' })
        return L('[{title}] 已发送到 {to}：{id}（{status}）', '[{title}] Sent to {to}: {id} ({status})', {
          title: workspace.title,
          to: args.to,
          id: result.message_id,
          status: result.status,
        })
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_read',
    description:
      'Mark a msg9.io message as read for the current workspace. ' +
      'Rarely needed: msg9_inbox already auto-marks what it returns — use this only after a mark_read:false peek.',
    parameters: {
      message_id: { type: 'string', required: true, description: 'The message_id returned by msg9_inbox.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec)
        await markRead(inbox.api_url, inbox.api_key, args.message_id, 'agent', exec?.signal)
        await setMessageMark(workspace.key, args.message_id, { read_by: 'agent' })
        return L('已标记为已读：{id}', 'Marked as read: {id}', { id: args.message_id })
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_done',
    description:
      'Mark a msg9.io message as HANDLED (processed) for the current workspace: you read it and nothing ' +
      'more is needed — no reply, no follow-up. Replying with msg9_send + correlation_id already marks ' +
      'the original as processed; use this for mail that is closed WITHOUT a reply. Processed mail drops ' +
      'out of the「待处理」view, so the human stops re-checking it.',
    parameters: {
      message_id: { type: 'string', required: true, description: 'The message_id returned by msg9_inbox.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec)
        // v1.13: server-native processed (implies read, first mark wins). The
        // local mark stays as the fallback record for older servers.
        try {
          await markProcessed(inbox.api_url, inbox.api_key, args.message_id, 'agent', exec?.signal)
        } catch {
          await markRead(inbox.api_url, inbox.api_key, args.message_id, 'agent', exec?.signal).catch(() => {})
        }
        await setMessageMark(workspace.key, args.message_id, { read_by: 'agent', processed_by: 'agent' })
        return L('已标记为已处理：{id}', 'Marked as processed: {id}', { id: args.message_id })
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_notify',
    description:
      'Pause or resume msg9 new-mail wake-ups for this dsh instance. While paused the watcher keeps tracking ' +
      '(no backlog replay later) but never interrupts sessions; the panel badge keeps updating, and unprocessed ' +
      'mail is still found by msg9_inbox. Use when the human is mid-task and mail keeps derailing the conversation.',
    parameters: {
      action: { type: 'string', required: true, description: 'on | off | status' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.action === 'status') {
        const paused = await getNotifyPaused()
        return paused
          ? L('新邮件提醒：静音中（面板徽标仍更新，msg9_inbox 照常可查）', 'New-mail wake-ups: paused (badge still updates; msg9_inbox works as usual)')
          : L('新邮件提醒：开启', 'New-mail wake-ups: on')
      }
      if (args.action === 'off') {
        await setNotifyPaused(true)
        return L('已静音：新邮件不再打断会话（watcher 照常跟踪，解除后不重播）。', 'Paused: mail no longer interrupts sessions (tracked silently, no replay on resume).')
      }
      if (args.action === 'on') {
        await setNotifyPaused(false)
        return L('已恢复新邮件提醒。', 'New-mail wake-ups resumed.')
      }
      return L('未知动作 {action}：用 on | off | status。', 'Unknown action {action}: use on | off | status.', { action: String(args.action) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_resolve',
    description:
      'Resolve a msg9.io address to its public record (existence, public key, metadata). Public endpoint — no credentials needed.',
    parameters: {
      address: { type: 'string', required: true, description: 'Address to resolve, e.g. "bob" or "bob@msg9.io".' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const record = await resolveAddress(defaultApiUrl(), args.address, exec?.signal)
        return L('解析 {input}：\n{json}', 'Resolved {input}:\n{json}', {
          input: args.address,
          json: JSON.stringify(record, null, 2),
        })
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_peers',
    description:
      'List the msg9.io inboxes of the other dsh workspaces (siblings under the same owner), so this workspace can message ' +
      'another one to sync information. With no owner configured, lists the inboxes registered on this machine.',
    parameters: {
      limit: { type: 'integer', description: 'Max rows (default 100).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const state = await loadState()
        const localByAddress = new Map(
          Object.values(state.workspaces).map((inbox) => [inbox.address, inbox] as const),
        )
        const owner = await getOwner()

        if (owner?.api_key) {
          const limit = Math.max(1, Math.min(args.limit ?? 100, 200))
          const { agents, total } = await ownerListAgents(owner.api_url, owner.api_key, 0, limit, exec?.signal)
          if (!agents || agents.length === 0) {
            return L('owner 名下还没有收件箱。', 'The owner has no inboxes yet.')
          }
          const body = agents
            .map((row) => {
              const known = localByAddress.get(row.agent_address)
              const label = known ? `${known.title} · ${known.path}` : (row.profile?.display_name ?? '')
              const role = row.profile?.description ? ` — ${row.profile.description}` : ''
              const caps = row.profile?.capabilities?.length ? ` [${row.profile.capabilities.join(', ')}]` : ''
              return `· ${row.agent_address}${label ? `  (${label})` : ''}${role}${caps}`
            })
            .join('\n')
          return L(
            'owner「{owner}」名下的收件箱（{count}）：\n{body}',
            'Inboxes under owner "{owner}" ({count}):\n{body}',
            { owner: owner.name ?? owner.id ?? 'owner', count: total ?? agents.length, body },
          )
        }

        const local = Object.values(state.workspaces)
        if (local.length === 0) {
          return L(
            '本机还没有为任何 workspace 开通收件箱（也未配置 owner）。先运行 msg9_inbox 即可自动开通当前 workspace。',
            'No workspace inbox is registered on this machine yet (and no owner is configured). Run msg9_inbox to provision the current workspace.',
          )
        }
        const body = local.map((inbox) => `· ${inbox.address}  (${inbox.title} · ${inbox.path})`).join('\n')
        return L(
          '本机已登记的收件箱（未配置 owner，{count}）：\n{body}',
          'Inboxes registered on this machine (no owner, {count}):\n{body}',
          { count: local.length, body },
        )
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_rotate',
    description:
      'Rotate the current workspace\'s msg9 agent key (owner path only) and save the new key. Use it to recover when the ' +
      'local key was lost or leaked; the old key stops working immediately.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec)
        const owner = await getOwner()
        if (!owner?.api_key) {
          return L(
            '未配置 owner，无法轮换 key。请先用 msg9_setup 配置 owner（或重新注册该 workspace）。',
            'No owner configured, so the key cannot be rotated. Run msg9_setup first (or re-register this workspace).',
          )
        }
        const { api_key } = await ownerRotateAgentKey(owner.api_url, owner.api_key, inbox.address, exec?.signal)
        await upsertWorkspaceInbox(workspace.key, { ...inbox, api_key })
        return L(
          '已轮换「{title}」({address}) 的 key，新 key 已保存。',
          'Rotated the key for "{title}" ({address}); the new key is saved.',
          { title: workspace.title, address: inbox.address },
        )
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_status',
    description:
      'Show the msg9.io identity of this dsh instance and the current workspace: owner (masked key), workspace inbox address, ' +
      'saved cursor, state file, and how many workspaces are registered.',
    parameters: {
      verify: { type: 'boolean', description: 'Also call msg9 to validate the current workspace credentials.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const owner = await getOwner()
      const state = await loadState()
      const workspace = resolveWorkspace(ctx, exec) ?? DEFAULT_WORKSPACE
      const inbox = state.workspaces[workspace.key]
      const inboxCount = Object.keys(state.workspaces).length

      const lines = [
        L('owner：{v}', 'owner: {v}', {
          v: owner ? `${owner.name ?? owner.id ?? 'owner'}（${maskKey(owner.api_key)}）` : L('未配置（每 workspace 公开注册）', 'not configured (per-workspace public registration)'),
        }),
        L('API：{v}', 'api: {v}', { v: owner?.api_url ?? defaultApiUrl() }),
        L('当前 workspace：{title}  {path}', 'current workspace: {title}  {path}', {
          title: workspace.title,
          path: workspace.path,
        }),
        L('收件箱：{v}', 'inbox: {v}', {
          v: inbox ? `${inbox.address}（${maskKey(inbox.api_key)}）` : L('尚未开通（首次 msg9_inbox 时自动开通）', 'not provisioned yet (created on first msg9_inbox)'),
        }),
        L('游标：{v}', 'cursor: {v}', { v: inbox?.cursor || '(none)' }),
        L('签名：{v}', 'signing: {v}', {
          v: inbox?.signing_seed
            ? L('开（Ed25519 已安装）', 'on (Ed25519 installed)')
            : L('关（未安装：服务端无身份层或安装失败）', 'off (not installed: pre-identity server or install failed)'),
        }),
        L('已登记 workspace：{v}', 'registered workspaces: {v}', { v: inboxCount }),
        L('状态文件：{v}', 'state file: {v}', { v: stateFilePath() }),
      ]

      if (args.verify && inbox?.api_key) {
        try {
          const me = await getMe(inbox.api_url, inbox.api_key, exec?.signal)
          lines.push(L('校验：ok（{json}）', 'verify: ok ({json})', { json: JSON.stringify(me) }))
        } catch (error) {
          lines.push(L('校验：失败（{err}）', 'verify: failed ({err})', { err: errorText(error) }))
        }
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_outbox',
    description:
      'List the messages the CURRENT workspace has sent (msg9 outbox), newest first. Use it to confirm what this workspace ' +
      'already told a peer before sending again.',
    parameters: {
      limit: { type: 'integer', description: 'Max messages to return (default 20, max 100).' },
      offset: { type: 'integer', description: 'Pagination offset (default 0).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec)
        const limit = Math.max(1, Math.min(args.limit ?? 20, 100))
        const offset = Math.max(0, args.offset ?? 0)
        const page = await listOutbox(inbox.api_url, inbox.api_key, { limit, offset }, exec?.signal)
        const messages = page.messages ?? []
        const banner = L('[{title}] {address} 发件箱', '[{title}] {address} outbox', {
          title: workspace.title,
          address: inbox.address,
        })
        if (messages.length === 0) return `${banner}\n${L('还没有已发送的消息。', 'Nothing sent yet.')}`
        const lines = messages.map((message) => {
          const subject = message.subject ? ` ${message.subject}` : ''
          const excerpt = bodyText(message) ? ` — ${truncate(bodyText(message), 140)}` : ''
          return `· → ${message.to_address}${subject}${excerpt}  \`${message.message_id}\``
        })
        return `${banner}\n${L('{count} 条（共 {total}）：', '{count} of {total}:', {
          count: messages.length,
          total: page.total ?? messages.length,
        })}\n${lines.join('\n')}`
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'msg9_contacts',
    description:
      'Manage the CURRENT workspace inbox\'s msg9 address book (the same contacts the msg9 panel shows): ' +
      'action "list" shows the saved addresses, "add" saves one with an optional alias/notes, "remove" deletes one. ' +
      'Saved contacts are a convenient recipient list for msg9_send.',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add | remove' },
      address: { type: 'string', description: 'Contact address (required for add/remove).' },
      alias: { type: 'string', description: 'Display name to save with the contact (add only).' },
      notes: { type: 'string', description: 'Free-form note to save with the contact (add only).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec)
        const banner = L('[{title}] {address} 联系人', '[{title}] {address} contacts', {
          title: workspace.title,
          address: inbox.address,
        })
        const action = (args.action || 'list').toLowerCase()

        if (action === 'list') {
          const page = await listContacts(inbox.api_url, inbox.api_key, { limit: 100 }, exec?.signal)
          const contacts = page.contacts ?? []
          if (contacts.length === 0) {
            return `${banner}\n${L('通讯录为空。', 'The address book is empty.')}`
          }
          const lines = contacts.map((contact) => {
            const alias = contact.alias ? `${contact.alias} ` : ''
            const notes = contact.notes ? `  — ${truncate(contact.notes, 80)}` : ''
            return `· ${alias}<${contact.contact}>${notes}`
          })
          return `${banner}\n${L('{count} 个联系人：', '{count} contact(s):', { count: page.total ?? contacts.length })}\n${lines.join('\n')}`
        }

        if (!args.address) {
          return L('action={action} 需要 address。', 'action={action} requires an address.', { action })
        }

        if (action === 'add') {
          const created = await addContact(inbox.api_url, inbox.api_key, {
            contact: args.address,
            ...(args.alias ? { alias: args.alias } : {}),
            ...(args.notes ? { notes: args.notes } : {}),
          }, exec?.signal)
          return L('{banner}\n已添加联系人：{contact}', '{banner}\nContact added: {contact}', {
            banner,
            contact: created?.contact ?? args.address,
          })
        }

        if (action === 'remove') {
          await deleteContact(inbox.api_url, inbox.api_key, args.address, exec?.signal)
          return L('{banner}\n已删除联系人：{contact}', '{banner}\nContact removed: {contact}', {
            banner,
            contact: args.address,
          })
        }

        return L('未知 action「{action}」：请用 list / add / remove。', 'Unknown action "{action}": use list / add / remove.', {
          action,
        })
      } catch (error) {
        return errorText(error)
      }
    },
  }))
}
