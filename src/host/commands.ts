/**
 * Human slash-command of dsh-msg9-kit: `/msg9` prints the tenant (owner) and
 * the workspace inboxes registered on this machine.
 *
 * @module dsh-msg9-kit/commands
 */

import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { resolveCredentials, resolveOwner } from './credentials.ts'
import { defaultApiUrl, loadState, stateFilePath } from './store.ts'
import { L } from './locale.ts'

function mask(key: string): string {
  if (key.length <= 14) return '***'
  return `${key.slice(0, 11)}…${key.slice(-4)}`
}

/** Register the `/msg9` command. */
export function registerMsg9Commands(commands: CommandRuntime): void {
  commands.register({
    name: 'msg9',
    description: L('查看 msg9 owner 与已登记的 workspace 收件箱', 'Show the msg9 owner and registered workspace inboxes'),
    async handler() {
      const owner = await resolveOwner()
      const state = await loadState()
      const rows: { title: string; address: string }[] = []
      for (const key of Object.keys(state.workspaces)) {
        const resolved = await resolveCredentials(key)
        if (resolved) rows.push({ title: resolved.title, address: resolved.address })
      }

      const head = owner
        ? L('owner：{name}（{key}）  API {api}', 'owner: {name} ({key})  API {api}', {
            name: owner.name ?? owner.id ?? 'owner',
            key: mask(owner.api_key),
            api: owner.api_url,
          })
        : L('owner：未配置（每个 workspace 走公开注册）', 'owner: not configured (per-workspace public registration)')

      const body = rows.length === 0
        ? L('还没有已登记的 workspace 收件箱。', 'No workspace inbox registered yet.')
        : rows.map((inbox) => `· ${inbox.title} → ${inbox.address}`).join('\n')

      return {
        kind: 'success',
        text: [
          head,
          L('API 默认值：{v}', 'default API: {v}', { v: defaultApiUrl() }),
          body,
          L('状态文件：{v}', 'state file: {v}', { v: stateFilePath() }),
        ].join('\n'),
      }
    },
  })
}
