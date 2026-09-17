/**
 * Pure presentation helpers for the msg9 panel.
 *
 * No React and no store access, so the panel's copy and formatting rules stay
 * unit-testable in plain node.
 *
 * @module dsh-msg9-kit/client-view
 */

import { bodyText, truncate } from '../shared/message.ts'
import type { ContactRow, DirectoryAgentRow, MessageRow, WorkspaceView } from '../shared/types.ts'
import { L } from './locale.ts'

/** Short, one-line preview of a message. */
export function previewOf(message: MessageRow, limit = 90): string {
  const text = bodyText(message)
  if (text) return truncate(text, limit)
  if (message.subject) return truncate(message.subject, limit)
  return L('（空消息）', '(empty message)')
}

/** Full body of a message, preserving line breaks. */
export function fullBody(message: MessageRow): string {
  const text = bodyText(message)
  return text || L('（空消息）', '(empty message)')
}

/** True when the message has not been read yet. */
export function isUnread(message: MessageRow): boolean {
  return !message.read_at
}

/** Localized date-time for a msg9 timestamp. */
export function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return date.toISOString()
  }
}

/** Label of an address-book row: alias when present, address otherwise. */
export function contactLabel(contact: ContactRow): string {
  return contact.alias?.trim() || contact.contact
}

/** Sidebar badge text: nothing at zero, `99+` when it overflows. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  return count > 99 ? '99+' : String(Math.trunc(count))
}

/** Human label for a workspace row. */
export function workspaceLabel(workspace: WorkspaceView): string {
  const address = workspace.address ?? L('未开通收件箱', 'no inbox yet')
  return `${workspace.title} · ${address}`
}

/** Filter the address book by a literal, case-insensitive query. */
export function filterContacts(contacts: ContactRow[], query: string): ContactRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return contacts
  return contacts.filter((contact) => {
    const haystack = `${contact.alias ?? ''} ${contact.contact} ${contact.notes ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
}

/** Display name of a directory row: profile name, else the bare address. */
export function agentLabel(agent: DirectoryAgentRow): string {
  return agent.display_name?.trim() || agent.address
}

/** Folder chips of the inbox tab. `pending` filters client-side (not a server folder). */
export const FOLDERS = ['all', 'unread', 'read', 'pending'] as const

/** Localized folder chip label. */
export function folderLabel(folder: (typeof FOLDERS)[number]): string {
  if (folder === 'unread') return L('未读', 'Unread')
  if (folder === 'read') return L('已读', 'Read')
  if (folder === 'pending') return L('待处理', 'Pending')
  return L('全部', 'All')
}

/** Closed-loop label of a processed message: who handled it. */
export function processedLabel(message: MessageRow): string {
  if (!message.processed_by) return ''
  return message.processed_by === 'human' ? L('人已处理', 'Handled by you') : L('Agent 已处理', 'Handled by agent')
}

/** Compose 收件人联想的候选行。 */
export interface RecipientSuggestion {
  address: string
  label: string
}

/** 收件人联想：地址/备注名包含查询串即命中（大小写不敏感），最多 limit 条。 */
export function filterRecipients(rows: RecipientSuggestion[], query: string, limit = 6): RecipientSuggestion[] {
  const needle = query.trim().toLowerCase()
  const matched = needle
    ? rows.filter((row) => `${row.address} ${row.label}`.toLowerCase().includes(needle))
    : rows
  return matched.slice(0, limit)
}

/** 「信」的身份（发件人+主题+正文）：fan-out 副本的折叠键。不能用
 *  correlation_id——同一线程/会话的回复共享它，按它折会把不同的信藏进一行。 */
export function letterIdentity(row: MessageRow): string {
  const text = bodyText(row)
  if (!text && !row.subject) return row.message_id
  return `${row.from_address}\n${row.subject ?? ''}\n${text}`
}

/** Gmail 式会话：与 seed 同 correlation_id 的收件箱+发件箱信（无则自成
 *  会话），按时间正序平铺。只用本地已有数据，不新发请求。 */
export function conversationOf(inbox: MessageRow[], outbox: MessageRow[], seed: MessageRow): MessageRow[] {
  if (!seed.correlation_id) return [seed]
  const seen = new Set<string>()
  const rows: MessageRow[] = []
  for (const row of [...inbox, ...outbox]) {
    if (row.correlation_id !== seed.correlation_id || seen.has(row.message_id)) continue
    seen.add(row.message_id)
    rows.push(row)
  }
  if (!seen.has(seed.message_id)) rows.push(seed)
  rows.sort((a, b) => (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0))
  return rows
}

/** 「会话」摘要：收件箱 thread 模式的一行（同 correlation_id 的一组信）。 */
export interface ThreadSummary {
  /** 组键：correlation_id（无 correlation_id 的单封自成一组）。 */
  key: string
  /** 组内成员，时间正序。 */
  messages: MessageRow[]
  /** 最新一封：行的发件人/主题/预览/时间都取自它。 */
  latest: MessageRow
  /** 组内总封数（>1 时行内显示计数徽标）。 */
  total: number
  /** 组内未读数（>0 时整行按未读加粗）。 */
  unread: number
  /** 全部已处理（人/agent）：决定行首显示绿勾还是圆点。 */
  allProcessed: boolean
}

/** 收件箱 thread 模式：按 correlation_id 分组（无则自成一组），组内时间正序、
 *  组间按最新一封倒序。纯本地聚合，不新发请求；在过滤文件夹（未读/已读/待处理）
 *  下组里只有服务端筛回来的成员，计数反映"当前列表中该组的成员数"。 */
export function threadRows(rows: MessageRow[]): ThreadSummary[] {
  const groups = new Map<string, MessageRow[]>()
  for (const row of rows) {
    const key = row.correlation_id || row.message_id
    const members = groups.get(key)
    if (members) members.push(row)
    else groups.set(key, [row])
  }
  const threads: ThreadSummary[] = []
  for (const [key, messages] of groups) {
    messages.sort((a, b) => (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0))
    const latest = messages[messages.length - 1]
    if (!latest) continue // 组按构造非空，只是让索引访问的类型收敛
    threads.push({
      key,
      messages,
      latest,
      total: messages.length,
      unread: messages.reduce((count, row) => (isUnread(row) ? count + 1 : count), 0),
      allProcessed: messages.every((row) => Boolean(row.processed_by)),
    })
  }
  threads.sort((a, b) => (Date.parse(b.latest.created_at ?? '') || 0) - (Date.parse(a.latest.created_at ?? '') || 0))
  return threads
}
