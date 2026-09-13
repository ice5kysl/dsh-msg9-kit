/**
 * Integration test against the REAL cordis runtime.
 *
 * The other two tests drive the plugin through a hand-written fake context.
 * This one boots an actual `@deepseek-ai/cordis` app, provides the services the
 * plugin injects (including the optional `webServer`), and applies the plugin
 * the way the dsh Loader does — so fiber injection, `ctx.inject`, `ctx.effect`
 * and route registration are exercised for real.
 *
 * Skipped (with a notice) when the cordis runtime is not installed, so the
 * package's tests still run in a bare checkout.
 *
 * Run: node tests/cordis.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-cordis-'))
process.env.MSG9_STATE_FILE = join(stateDir, 'state.json')
delete process.env.MSG9_OWNER_KEY
await writeFile(process.env.MSG9_STATE_FILE, JSON.stringify({ workspaces: {} }))

let Context
try {
  ({ Context } = await import('@deepseek-ai/cordis'))
} catch {
  console.log('dsh-msg9-kit cordis integration test: skipped (@deepseek-ai/cordis not installed)')
  process.exit(0)
}

const plugin = await import('../lib/index.js')

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

console.log('dsh-msg9-kit cordis integration test:')

const tools = []
const commands = []
const routes = []
const dispositioned = []

const ctx = new Context()
ctx.provide('tools', { register: (tool) => tools.push(tool) })
ctx.provide('commands', { register: (command) => commands.push(command) })
ctx.provide('sessions', { get: () => ({ header: { cwd: '/work/a' } }) })
ctx.provide('workspaceRegistry', { list: () => [{ id: 'ws-a', title: 'alpha', path: '/work/a' }] })
ctx.provide('webServer', {
  register: (route) => {
    routes.push(route)
    return () => dispositioned.push(route.path)
  },
})

const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
await fiber

await check('the plugin fiber activates with every injected service present', async () => {
  assert.deepEqual(tools.map((entry) => entry.name).sort(), [
    'msg9_contacts',
    'msg9_done',
    'msg9_inbox',
    'msg9_message',
    'msg9_notify',
    'msg9_outbox',
    'msg9_peers',
    'msg9_read',
    'msg9_resolve',
    'msg9_rotate',
    'msg9_send',
    'msg9_setup',
    'msg9_status',
  ])
  assert.deepEqual(commands.map((entry) => entry.name), ['msg9'])
})

await check('the soft webServer injection mounted the /dsh-msg9 prefix route', () => {
  assert.equal(routes.length, 1)
  assert.deepEqual({ kind: routes[0].kind, path: routes[0].path }, { kind: 'prefix', path: '/dsh-msg9' })
})

await check('the registered tool really executes through defineTool', async () => {
  const status = tools.find((entry) => entry.name === 'msg9_status')
  const text = await status.execute({}, { agent: { id: 'sess-a' } })
  assert.ok(text.includes('not configured'), text)
  assert.ok(text.includes('alpha'), text)
})

await check('teardown disposes the route through ctx.effect', async () => {
  await fiber.dispose()
  assert.deepEqual(dispositioned, ['/dsh-msg9'])
})

await check('a headless host (no webServer service) still activates the tools', async () => {
  const headlessTools = []
  const headless = new Context()
  headless.provide('tools', { register: (tool) => headlessTools.push(tool) })
  headless.provide('commands', { register: () => {} })
  headless.provide('sessions', { get: () => undefined })

  const headlessFiber = headless.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
  await headlessFiber
  assert.equal(headlessTools.length, 13)
  await headlessFiber.dispose()
})

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
