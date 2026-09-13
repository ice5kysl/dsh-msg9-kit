/**
 * Standalone smoke test for the host face (no cordis runtime needed).
 *
 * Boots a fake msg9 server (agent + owner endpoints), applies the plugin to a
 * minimal fake ctx (logger / tools / commands / sessions / workspaceRegistry),
 * and exercises the workspace-inbox contract:
 *   - owner setup validates and persists the tenant key
 *   - each workspace is provisioned once (owner path), keyed by workspace id
 *   - msg9_peers lists the sibling workspaces
 *   - a workspace can send to a sibling
 *   - with no owner, a workspace falls back to public registration
 *   - cursors advance on a normal pull and stay put on an explicit `since`
 *
 * Run: npm test   (or: node tests/smoke.test.mjs)
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-'))
process.env.MSG9_STATE_FILE = join(stateDir, 'state.json')
delete process.env.MSG9_OWNER_KEY

// ---------------------------------------------------------------- fake msg9

const seen = { register: 0, ownerCreate: [], ownerList: 0, ownerMe: 0, send: [], rotate: [], contactAdd: [], contactRemove: [], reads: [] }
const ownerAgents = []

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake')
  const auth = req.headers.authorization || ''

  if (req.method === 'POST' && url.pathname === '/api/v1/register') {
    seen.register += 1
    const body = await readBody(req)
    return reply(res, 201, {
      code: 0,
      data: { address: `${body.requested_address}@msg9.io`, api_key: `msg9_sk_pub_${body.requested_address}`, public_key: '' },
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/owner/agents') {
    if (!auth.startsWith('Bearer msg9_tk_')) return reply(res, 401, { code: 40100, message: 'invalid owner key' })
    const body = await readBody(req)
    seen.ownerCreate.push(body.addresses)
    seen.provisionProfiles = seen.provisionProfiles ?? []
    seen.provisionProfiles.push(body.profile ?? null)
    const created = []
    const errors = []
    for (const address of body.addresses ?? []) {
      if (ownerAgents.some((row) => row.agent_address === `${address}@msg9.io`)) {
        errors.push({ address, code: 40900, message: 'address already taken' })
        continue
      }
      const row = { id: `oa_${address}`, agent_address: `${address}@msg9.io`, created_at: '2026-09-11T00:00:00Z', ...(body.profile ? { profile: body.profile } : {}) }
      ownerAgents.push(row)
      created.push({ address: row.agent_address, api_key: `msg9_sk_owner_${address}` })
    }
    return reply(res, 200, { code: 0, data: { created, errors } })
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/owner/agents') {
    if (!auth.startsWith('Bearer msg9_tk_')) return reply(res, 401, { code: 40100, message: 'invalid owner key' })
    seen.ownerList += 1
    return reply(res, 200, { code: 0, data: { agents: ownerAgents, total: ownerAgents.length } })
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/owner/me') {
    if (!auth.startsWith('Bearer msg9_tk_')) return reply(res, 401, { code: 40100, message: 'invalid owner key' })
    seen.ownerMe += 1
    return reply(res, 200, { code: 0, data: { id: 'own_1', name: 'dsh', status: 'active', quota: { max_agents: 50, max_messages_per_day: 10000 } } })
  }

  if (req.method === 'POST' && /^\/api\/v1\/owner\/agents\/.+\/rotate-key$/.test(url.pathname)) {
    const address = decodeURIComponent(url.pathname.split('/')[5])
    seen.rotate.push(address)
    return reply(res, 200, { code: 0, data: { api_key: `msg9_sk_rotated_${seen.rotate.length}` } })
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/send') {
    const body = await readBody(req)
    seen.send.push({ auth, body, idempotencyKey: req.headers['idempotency-key'] })
    return reply(res, 200, { code: 0, data: { message_id: 'msg_sent_1', status: 'accepted' } })
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/inbox/messages') {
    const since = url.searchParams.get('since')
    if (since) {
      return reply(res, 200, {
        code: 0,
        data: {
          messages: [{ message_id: 'msg_new_2', from_address: 'peer@msg9.io', subject: 'newer', body: { text: 'newer body' }, folder: 'inbox/unread', created_at: '2026-09-11T10:00:00Z' }],
          unread_count: 1,
          next_cursor: 'CURSOR_2',
        },
      })
    }
    return reply(res, 200, {
      code: 0,
      data: {
        messages: [{ message_id: 'msg_boot_1', from_address: 'peer@msg9.io', subject: 'first', body: { text: 'first body' }, folder: 'inbox/unread', created_at: '2026-09-11T09:00:00Z' }],
        unread_count: 1,
      },
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/outbox/messages') {
    return reply(res, 200, {
      code: 0,
      data: {
        messages: [{ message_id: 'msg_sent_1', from_address: 'a@msg9.io', to_address: 'peer@msg9.io', subject: 'sync', body: { text: 'sync from B' }, created_at: '2026-09-11T11:00:00Z' }],
        total: 1,
      },
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/contacts') {
    return reply(res, 200, {
      code: 0,
      data: { contacts: [{ id: 'c1', contact: 'peer@msg9.io', alias: 'Peer', notes: 'sibling', status: 'accepted' }], total: 1 },
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/contacts') {
    const body = await readBody(req)
    seen.contactAdd.push(body)
    return reply(res, 200, { code: 0, data: { id: 'c2', contact: body.contact, alias: body.alias, status: 'accepted' } })
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/contacts/')) {
    const address = decodeURIComponent(url.pathname.slice('/api/v1/contacts/'.length))
    seen.contactRemove.push(address)
    return reply(res, 200, { code: 0, data: { status: 'ok' } })
  }

  if (req.method === 'POST' && /^\/api\/v1\/inbox\/messages\/.+\/read$/.test(url.pathname)) {
    seen.reads.push(decodeURIComponent(url.pathname.split('/')[5]))
    return reply(res, 200, { code: 0, data: { status: 'ok' } })
  }

  if (req.method === 'POST' && /^\/api\/v1\/inbox\/messages\/.+\/processed$/.test(url.pathname)) {
    seen.processed = seen.processed ?? []
    seen.processed.push(decodeURIComponent(url.pathname.split('/')[5]))
    return reply(res, 200, { code: 0, data: { status: 'ok' } })
  }

  if (req.method === 'PUT' && url.pathname === '/api/v1/agent/signing-key') {
    const body = await readBody(req)
    seen.signingKeys = seen.signingKeys ?? []
    seen.signingKeys.push({ auth: req.headers.authorization, publicKey: body.signing_public_key })
    return reply(res, 200, { code: 0, data: { signing_public_key: body.signing_public_key, key_id: 'kid_fake', first_time: true } })
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/agent/me') {
    if (!auth.startsWith('Bearer msg9_sk_')) return reply(res, 401, { code: 40100, message: 'invalid API key' })
    return reply(res, 200, { code: 0, data: { address: 'ws@msg9.io', status: 'active' } })
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/v1/resolve/')) {
    const address = decodeURIComponent(url.pathname.slice('/api/v1/resolve/'.length))
    return reply(res, 200, { code: 0, data: { address, exists: true, public_key: '' } })
  }

  return reply(res, 404, { code: 40400, message: 'not found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
process.env.MSG9_API_URL = `http://127.0.0.1:${port}`

// ------------------------------------------------------------- fake dsh host

const workspaces = [
  { id: 'ws-a', title: 'alpha', path: '/work/a' },
  { id: 'ws-b', title: 'Beta Repo', path: '/work/b' },
]
const sessionCwd = { 'sess-a': '/work/a', 'sess-b': '/work/b', 'sess-c': '/work/c' }

const { apply, inject, name: pluginName } = await import('../lib/index.js')

const tools = []
const commands = []
const webRoutes = []
const promptSections = []
apply({
  logger: () => ({ info: () => {} }),
  tools: { register: (tool) => tools.push(tool) },
  commands: { register: (command) => commands.push(command) },
  sessions: { get: (id) => (sessionCwd[id] ? { header: { cwd: sessionCwd[id] } } : undefined) },
  workspaceRegistry: { list: () => workspaces },
  // Optional faces are mounted through cordis' soft dependency injection.
  inject: (deps, callback) => {
    const [dep] = [...deps]
    if (dep === 'webServer') {
      return callback({
        effect: (fn) => fn(),
        webServer: {
          register: (route) => {
            webRoutes.push(route)
            return () => {}
          },
        },
      })
    }
    if (dep === 'systemPrompt') {
      return callback({
        systemPrompt: {
          section: (options) => {
            promptSections.push(options)
            return () => {}
          },
        },
      })
    }
    if (dep === 'agents') {
      // No live agents in this harness: the watcher stays off, tools unaffected.
      return callback({})
    }
    if (dep === 'workspaceRegistry') {
      return callback({
        workspaceRegistry: {
          list: () => workspaces,
          resolveByPath: async () => undefined,
        },
      })
    }
    throw new Error(`unexpected soft dependency: ${dep}`)
  },
})

const tool = (name) => tools.find((entry) => entry.name === name)
const exec = (id) => ({ agent: { id } })
const readState = async () => JSON.parse(await readFile(process.env.MSG9_STATE_FILE, 'utf8'))
const writeState = async (state) => writeFile(process.env.MSG9_STATE_FILE, JSON.stringify(state, null, 2))

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

console.log('dsh-msg9-kit host smoke test:')

await check('plugin identity: name + inject declare the cordis contract', () => {
  assert.equal(pluginName, 'msg9-kit')
  assert.deepEqual([...inject], ['tools', 'commands', 'sessions'])
})

await check('registers the thirteen msg9 model tools', () => {
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
})

await check('registers the /msg9 slash command', () => {
  assert.deepEqual(commands.map((entry) => entry.name), ['msg9'])
})

await check('mounts the /dsh-msg9 browser bridge on the web server', () => {
  assert.equal(webRoutes.length, 1)
  assert.equal(webRoutes[0].kind, 'prefix')
  assert.equal(webRoutes[0].path, '/dsh-msg9')
  assert.equal(typeof webRoutes[0].handler, 'function')
})

await check('adds the mailbox rules to the system prompt', () => {
  assert.equal(promptSections.length, 1)
  assert.equal(promptSections[0].name, 'msg9:mailbox')
  assert.match(promptSections[0].text, /msg9_inbox/)
  assert.match(promptSections[0].text, /msg9_send/)
})

await check('msg9_send metadata: required to/text, text render', () => {
  const send = tool('msg9_send')
  assert.equal(send.parameters.properties.to.type, 'string')
  assert.deepEqual(send.parameters.required.sort(), ['text', 'to'])
  assert.deepEqual(send.output.render({}, 'x'), [{ type: 'text', text: 'x' }])
})

await check('status before any setup reports no owner', async () => {
  const text = await tool('msg9_status').execute({}, exec('sess-a'))
  assert.ok(text.includes('not configured'), text)
  assert.ok(text.includes('alpha'), text)
})

await check('msg9_setup validates and stores the owner key', async () => {
  const text = await tool('msg9_setup').execute({ owner_key: 'msg9_tk_abc' })
  assert.ok(text.includes('Owner configured'), text)
  assert.ok(text.includes('max_agents=50'), text)
  const saved = await readState()
  assert.equal(saved.owner.api_key, 'msg9_tk_abc')
  assert.equal(seen.ownerMe, 1)
})

await check('workspace A inbox is provisioned under the owner, keyed by workspace id', async () => {
  const text = await tool('msg9_inbox').execute({}, exec('sess-a'))
  assert.ok(text.includes('first body'), text)
  assert.ok(text.includes('[alpha]'), text)
  const saved = await readState()
  const inbox = saved.workspaces['ws-a']
  assert.ok(inbox.address.startsWith('dsh-alpha-'), inbox.address)
  assert.ok(inbox.api_key.startsWith('msg9_sk_owner_'), inbox.api_key)
  assert.deepEqual(seen.ownerCreate[0], [inbox.address.replace('@msg9.io', '')])
  // Provisioning writes the yellow-pages profile (v1.5).
  const profile = seen.provisionProfiles[0]
  assert.equal(profile.display_name, 'alpha')
  assert.ok(profile.description.includes('alpha'), JSON.stringify(profile))
  assert.equal(profile.links.workspace, '/work/a')
  assert.equal(profile.visibility, 'public')
  // …and installs an Ed25519 signing key (v1.3 identity), persisted locally.
  assert.equal((seen.signingKeys ?? []).length, 1, 'signing key registered with msg9')
  assert.ok(inbox.signing_seed, 'the seed is kept in the state file')
})

await check('workspace B inbox is a separate address (sibling under the same owner)', async () => {
  const text = await tool('msg9_inbox').execute({}, exec('sess-b'))
  assert.ok(text.includes('[Beta Repo]'), text)
  const saved = await readState()
  assert.ok(saved.workspaces['ws-b'].address.startsWith('dsh-beta-repo-'), saved.workspaces['ws-b'].address)
  assert.notEqual(saved.workspaces['ws-a'].address, saved.workspaces['ws-b'].address)
})

await check('second inbox pull reuses the stored inbox (no re-provision)', async () => {
  await tool('msg9_inbox').execute({}, exec('sess-a'))
  assert.equal(seen.ownerCreate.length, 2)
})

await check('msg9_peers lists both sibling workspaces', async () => {
  const text = await tool('msg9_peers').execute({})
  const saved = await readState()
  assert.ok(text.includes(saved.workspaces['ws-a'].address), text)
  assert.ok(text.includes(saved.workspaces['ws-b'].address), text)
  // Locally-known inboxes carry title AND path, so the agent can tell what
  // each sibling project is.
  assert.ok(text.includes('(alpha · /work/a)'), text)
  // The yellow-pages role description rides along (profile from the roster).
  assert.ok(text.includes('— '), text)
  assert.ok(seen.ownerList >= 1)
})

await check('a workspace can send to a sibling inbox', async () => {
  const saved = await readState()
  const text = await tool('msg9_send').execute(
    { to: saved.workspaces['ws-a'].address, text: 'sync from B', idempotency_key: 'idem-1' },
    exec('sess-b'),
  )
  assert.ok(text.includes('[Beta Repo]'), text)
  const last = seen.send[seen.send.length - 1]
  assert.equal(last.idempotencyKey, 'idem-1')
  assert.equal(last.body.to, saved.workspaces['ws-a'].address)
  assert.ok(last.auth.includes(saved.workspaces['ws-b'].api_key))
})

await check('msg9_rotate rotates the current workspace key', async () => {
  const text = await tool('msg9_rotate').execute({}, exec('sess-b'))
  assert.ok(text.includes('Rotated the key'), text)
  const saved = await readState()
  assert.ok(saved.workspaces['ws-b'].api_key.startsWith('msg9_sk_rotated_'), saved.workspaces['ws-b'].api_key)
  assert.equal(seen.rotate.length, 1)
})

await check('explicit since peeks without advancing the cursor', async () => {
  const before = (await readState()).workspaces['ws-b'].cursor
  const text = await tool('msg9_inbox').execute({ since: 'CURSOR_1' }, exec('sess-b'))
  assert.ok(text.includes('newer body'), text)
  assert.ok(text.includes('Cursor not advanced'), text)
  assert.equal((await readState()).workspaces['ws-b'].cursor, before)
})

await check('advance=true moves the saved cursor to next_cursor', async () => {
  await tool('msg9_inbox').execute({ since: 'CURSOR_1', advance: true }, exec('sess-b'))
  assert.equal((await readState()).workspaces['ws-b'].cursor, 'CURSOR_2')
})

await check('msg9_read marks a message read', async () => {
  const text = await tool('msg9_read').execute({ message_id: 'msg_boot_1' }, exec('sess-a'))
  assert.ok(text.includes('Marked as read'), text)
})

await check('msg9_done closes the loop and attributes the agent', async () => {
  const text = await tool('msg9_done').execute({ message_id: 'msg_boot_1' }, exec('sess-a'))
  assert.ok(text.includes('Marked as processed'), text)
  const saved = await readState()
  assert.equal(saved.workspaces['ws-a'].marks['msg_boot_1'].processed_by, 'agent')
  assert.ok((seen.processed ?? []).includes('msg_boot_1'), 'server-native /processed called')
})

await check('a reply with correlation_id marks the original processed', async () => {
  const saved = await readState()
  const text = await tool('msg9_send').execute(
    { to: 'peer@msg9.io', text: 'closing the loop', reply_to: 'msg_boot_1', correlation_id: 'msg_boot_1', idempotency_key: 'idem-done-1' },
    exec('sess-b'),
  )
  assert.ok(text.includes('Sent'), text)
  assert.equal(seen.send.at(-1).body.reply_to, 'msg_boot_1', 'reply_to reaches the server')
  const after = await readState()
  assert.equal(after.workspaces['ws-b'].marks['msg_boot_1'].processed_by, 'agent')
})

await check('msg9_inbox auto-marks returned unread as read; mark_read:false peeks', async () => {
  // An explicit-since read of ws-a returns msg_new_2 (no read_at): auto-marked.
  const before = seen.reads.length
  const text = await tool('msg9_inbox').execute({ since: 'CURSOR_1' }, exec('sess-a'))
  assert.ok(text.includes('auto-marked 1 as read'), text)
  assert.ok(seen.reads.slice(before).includes('msg_new_2'), JSON.stringify(seen.reads))

  // A peek reads the same span WITHOUT touching the read state.
  const peekBefore = seen.reads.length
  const peek = await tool('msg9_inbox').execute({ since: 'CURSOR_1', mark_read: false }, exec('sess-a'))
  assert.ok(peek.includes('peek'), peek)
  assert.equal(seen.reads.length, peekBefore, 'peek must not mark anything read')
})

await check('msg9_resolve reads a public record', async () => {
  const text = await tool('msg9_resolve').execute({ address: 'bob' })
  assert.ok(text.includes('"exists": true'), text)
})

await check('msg9_status verify=true validates the workspace key', async () => {
  const text = await tool('msg9_status').execute({ verify: true }, exec('sess-a'))
  assert.ok(text.includes('verify: ok'), text)
  assert.ok(text.includes('(alpha)') === false, text) // workspace shown by title, not in parens
  assert.ok(text.includes('current workspace: alpha'), text)
  assert.ok(text.includes('signing: on'), text) // N1: the signature state is exposed
})

await check('without an owner, a new workspace falls back to public registration', async () => {
  const saved = await readState()
  delete saved.owner
  await writeState(saved)
  const before = seen.register
  const text = await tool('msg9_inbox').execute({}, exec('sess-c'))
  assert.ok(text.includes('[c]'), text)
  assert.equal(seen.register, before + 1)
  const after = await readState()
  assert.ok(after.workspaces['cwd:/work/c'].api_key.startsWith('msg9_sk_pub_'), after.workspaces['cwd:/work/c'].api_key)
})

await check('msg9_outbox lists what the workspace sent', async () => {
  const text = await tool('msg9_outbox').execute({}, exec('sess-b'))
  assert.ok(text.includes('[Beta Repo]'), text)
  assert.ok(text.includes('→ peer@msg9.io'), text)
  assert.ok(text.includes('sync from B'), text)
})

await check('msg9_contacts lists, adds and removes address-book entries', async () => {
  const listed = await tool('msg9_contacts').execute({ action: 'list' }, exec('sess-a'))
  assert.ok(listed.includes('Peer <peer@msg9.io>'), listed)

  const added = await tool('msg9_contacts').execute(
    { action: 'add', address: 'gamma@msg9.io', alias: 'Gamma', notes: 'a third agent' },
    exec('sess-a'),
  )
  assert.ok(added.includes('Contact added'), added)
  assert.deepEqual(seen.contactAdd[seen.contactAdd.length - 1], { contact: 'gamma@msg9.io', alias: 'Gamma', notes: 'a third agent' })

  const removed = await tool('msg9_contacts').execute({ action: 'remove', address: 'gamma@msg9.io' }, exec('sess-a'))
  assert.ok(removed.includes('Contact removed'), removed)
  assert.deepEqual(seen.contactRemove, ['gamma@msg9.io'])

  const missing = await tool('msg9_contacts').execute({ action: 'add' }, exec('sess-a'))
  assert.ok(missing.includes('requires an address'), missing)
})

await check('/msg9 command prints the registered workspaces', async () => {
  const result = await commands[0].handler({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('alpha'), result.text)
})

server.close()

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
