/**
 * Browser-face smoke test for dsh-msg9-kit (no browser needed).
 *
 * Three layers are exercised end to end against a fake msg9 server:
 *
 *   1. the host bridge — `createMsg9Bridge` over fake node req/res objects,
 *      including the loopback/origin guard and key redaction;
 *   2. the built browser bundle — loaded through the official
 *      `window.__ModuleLoader__` envelope, then `apply()`ed against a fake
 *      client ctx that records slot registrations;
 *   3. the panel itself — the store drives the real client bridge (whose
 *      transport is the host bridge above), and the components are rendered
 *      with `react-dom/server` so the markup can be asserted.
 *
 * Run: node tests/client.test.mjs   (or: npm test)
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

process.env.MSG9KIT_LOCALE = 'en'
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-client-'))
process.env.MSG9_STATE_FILE = join(stateDir, 'state.json')
delete process.env.MSG9_OWNER_KEY

const require_ = createRequire(import.meta.url)
const React = require_('react')
const { renderToStaticMarkup } = require_('react-dom/server')

// ---------------------------------------------------------------- fake msg9

const seen = { send: [], read: [], readBy: [], processed: [], contactAdd: [], contactRemove: [], ownerAgents: 0, register: 0, inboxLimit: [], provisioned: [], provisionProfiles: [], directory: [], forwarding: [], moveMail: [], signingKeys: [] }
const ownerAgents = [{ id: 'oa_a', agent_address: 'dsh-alpha-1a2b@msg9.io', profile: { display_name: 'alpha', description: 'alpha workspace inbox', capabilities: ['code-review'] } }]

const inbox = [
  { message_id: 'm1', from_address: 'peer@msg9.io', subject: 'hello', body: { text: '**first body line**' }, created_at: '2026-09-11T09:00:00Z' },
  { message_id: 'm2', from_address: 'beta@msg9.io', subject: 'second', body: { text: 'second body' }, created_at: '2026-09-11T10:00:00Z', read_at: '2026-09-11T10:05:00Z' },
  { message_id: 'm3', from_address: 'peer@msg9.io', subject: 'snippet', body: { text: '看这段：\n\n```ts\nconst answer: number = 42\n```' }, created_at: '2026-09-11T10:30:00Z', read_at: '2026-09-11T10:31:00Z', verified: true, key_id: 'kid_peer_1', list_address: 'team-x@dsh.msg9.io', group_copy: true, correlation_id: 'thread-9' },
]
const outbox = [
  { message_id: 'o1', from_address: 'dsh-alpha-1a2b@msg9.io', to_address: 'peer@msg9.io', subject: 'answer', body: { text: 'sent body' }, created_at: '2026-09-11T11:00:00Z' },
]
const contacts = [{ id: 'c1', contact: 'peer@msg9.io', alias: 'Peer', notes: 'sibling workspace', status: 'accepted' }]
const directoryAgents = [
  { address: 'dsh-alpha-1a2b@msg9.io', profile: { display_name: 'alpha', description: 'alpha workspace inbox', capabilities: ['code-review'], visibility: 'public' }, created_at: '2026-09-11' },
  { address: 'nova@vme.msg9.io', profile: { display_name: 'Nova', description: 'design reviewer of another tenant', capabilities: ['design-review'], links: { workspace: '/opt/nova' }, visibility: 'public' }, created_at: '2026-09-10' },
]
const accountAgents = [
  { owner_id: 'own_ui', owner_name: 'dsh-ui', address_domain: 'msg9.io', agent_address: 'dsh-alpha-1a2b@msg9.io', status: 'active', profile: { display_name: 'alpha' } },
  { owner_id: 'own_kimi', owner_name: 'KimiCode', owner_slug: 'kimi', address_domain: 'kimi.msg9.io', agent_address: 'nova@kimi.msg9.io', status: 'active', profile: { display_name: 'Nova', capabilities: ['design-review'] } },
  { owner_id: 'own_kimi', owner_name: 'KimiCode', owner_slug: 'kimi', address_domain: 'kimi.msg9.io', agent_address: 'old@kimi.msg9.io', status: 'suspended', profile: { display_name: 'Old' } },
]
const groupsFixture = [
  { address: 'team-x@dsh.msg9.io', display_name: 'Team X', description: 'demo group for the panel', open: false, created_by: 'dsh-alpha-1a2b@msg9.io', created_at: '2026-09-12', member_count: 3, is_member: true },
  { address: 'platform-crew@dsh.msg9.io', display_name: 'Platform Crew', description: 'someone else created it', open: false, created_by: 'msg9-io@dsh.msg9.io', created_at: '2026-09-12', member_count: 4, is_member: true },
]
// The §28 org endpoint starts "unshipped" and is flipped on mid-suite.
let orgEndpointLive = false
const orgAgents = [
  { owner_id: 'own_ice_dsh', owner_name: 'DSH', owner_slug: 'dsh', address_domain: 'dsh.ice.msg9.io', agent_address: 'dsh@dsh.ice.msg9.io', status: 'active', profile: { display_name: 'dsh' } },
]
const groupArchive = [
  // The server returns newest-first; the panel's default view flips it.
  { message_id: 'g2', from_address: 'peer@msg9.io', subject: 'follow', body: { text: 'archive body two' }, created_at: '2026-09-12T09:00:00Z' },
  { message_id: 'g1', from_address: 'boss@msg9.io', subject: 'kickoff', body: { text: '**archive body one**' }, created_at: '2026-09-12T08:00:00Z' },
]
// The platform archives fan-out COPIES: one thread lands once per recipient.
// Flipped on mid-suite so the panel's fold-by-thread rendering is exercised.
let fanoutArchive = false
const fanoutCopies = [
  // 真实 fan-out：同一封信按成员各存一行，from/subject/body 完全一致，仅 message_id/to_address 不同。
  { message_id: 'f1', from_address: 'peer@msg9.io', subject: 'fanout topic', body: { text: 'same letter body' }, created_at: '2026-09-12T08:00:00Z', list_address: 'team-x@dsh.msg9.io', group_copy: true, correlation_id: 'thread-f', to_address: 'a@dsh.msg9.io' },
  { message_id: 'f2', from_address: 'peer@msg9.io', subject: 'fanout topic', body: { text: 'same letter body' }, created_at: '2026-09-12T08:00:01Z', list_address: 'team-x@dsh.msg9.io', group_copy: true, correlation_id: 'thread-f', to_address: 'b@dsh.msg9.io' },
  { message_id: 'f3', from_address: 'peer@msg9.io', subject: 'fanout topic', body: { text: 'same letter body' }, created_at: '2026-09-12T08:00:02Z', list_address: 'team-x@dsh.msg9.io', group_copy: true, correlation_id: 'thread-f', to_address: 'c@dsh.msg9.io' },
  // 同一线程（correlation_id 相同）里的另一封信——必须保持独立行，不能被折进去。
  { message_id: 'f4', from_address: 'peer@msg9.io', subject: 'another letter in thread', body: { text: 'a different letter' }, created_at: '2026-09-12T08:30:00Z', list_address: 'team-x@dsh.msg9.io', group_copy: true, correlation_id: 'thread-f', to_address: 'a@dsh.msg9.io' },
  { message_id: 'f5', from_address: 'boss@msg9.io', subject: 'standalone', body: { text: 'own thread' }, created_at: '2026-09-12T09:00:00Z' },
  // 本 workspace 自己发的信（频道视图里的 self 标记），自己一个线程。
  { message_id: 'f6', from_address: 'dsh-alpha-1a2b@msg9.io', subject: 'my two cents', body: { text: 'from this workspace' }, created_at: '2026-09-12T09:30:00Z', correlation_id: 'thread-mine' },
  // 超长正文：超过 clamp 阈值（2000 字符），开头带 ## 标题 + 表格（clamp 必须
  // 保留换行，不能压平毁掉 markdown），尾巴带标记验证截断。
  { message_id: 'f7', from_address: 'boss@msg9.io', subject: 'long read', body: { text: `## 建议书\n\n| option | latency | cost |\n| --- | --- | --- |\n| a-very-long-option | 120ms | $$$ |\n\n${'long body line\n'.repeat(160)}TAIL_END_MARKER` }, created_at: '2026-09-12T10:00:00Z' },
  // 带 markdown 表格的信：宽表格必须表格内部横滚，不能撑破卡片。
  { message_id: 'f8', from_address: 'peer@msg9.io', subject: 'proposal', body: { text: '| option | latency | cost |\n| --- | --- | --- |\n| a-very-long-option-name-that-keeps-going | 120ms | $$$ |' }, created_at: '2026-09-12T10:30:00Z' },
]
// 回复树夹具（3 层）：根信 3 份 fan-out 副本；reply_to 分别指向第 1、第 2 个副本
// （都要解析到根信）；t31 是 t3 的回复（第三层）；t4 的 reply_to 指向存档外
// （兜底挂根）；t5 同线程但无 reply_to（兜底当根的孩子）；t6 是另一个线程。
let treeArchive = false
const treeLetters = [
  { message_id: 't1a', from_address: 'alice@msg9.io', subject: 'topic', body: { text: 'root body' }, created_at: '2026-09-12T08:00:00Z', correlation_id: 'thread-t' },
  { message_id: 't1b', from_address: 'alice@msg9.io', subject: 'topic', body: { text: 'root body' }, created_at: '2026-09-12T08:00:01Z', correlation_id: 'thread-t' },
  { message_id: 't1c', from_address: 'alice@msg9.io', subject: 'topic', body: { text: 'root body' }, created_at: '2026-09-12T08:00:02Z', correlation_id: 'thread-t' },
  { message_id: 't2', from_address: 'bob@msg9.io', subject: 're: topic', body: { text: 'reply one' }, created_at: '2026-09-12T08:10:00Z', correlation_id: 'thread-t', reply_to: 't1a' },
  { message_id: 't3', from_address: 'carol@msg9.io', subject: 're: topic', body: { text: 'reply two' }, created_at: '2026-09-12T08:20:00Z', correlation_id: 'thread-t', reply_to: 't1b' },
  { message_id: 't31', from_address: 'dave@msg9.io', subject: 're: topic', body: { text: 'reply two dot one' }, created_at: '2026-09-12T08:30:00Z', correlation_id: 'thread-t', reply_to: 't3' },
  { message_id: 't4', from_address: 'erin@msg9.io', subject: 're: topic', body: { text: 'reply three' }, created_at: '2026-09-12T08:40:00Z', correlation_id: 'thread-t', reply_to: 'ghost-not-in-archive' },
  { message_id: 't5', from_address: 'frank@msg9.io', subject: 're: topic', body: { text: 'loose letter' }, created_at: '2026-09-12T08:50:00Z', correlation_id: 'thread-t' },
  { message_id: 't6', from_address: 'gina@msg9.io', subject: 'solo', body: { text: 'solo letter' }, created_at: '2026-09-12T09:30:00Z' },
]
// Gmail 式会话夹具：同 correlation_id 的 3 封信（c1/c2 收 + c1s 发——发的那封
// 只在 outbox）+ 一封别的会话（无 correlation_id，自成会话）+ 组副本 2 份。
let threadInbox = false
const threadInboxRows = [
  { message_id: 'c1', from_address: 'peer@msg9.io', subject: 'roadmap sync', body: { text: '**question one**' }, created_at: '2026-09-12T08:00:00Z', correlation_id: 'thread-c' },
  { message_id: 'c2', from_address: 'peer@msg9.io', subject: 're: roadmap sync', body: { text: 'answer two' }, created_at: '2026-09-12T09:00:00Z', correlation_id: 'thread-c', read_at: '2026-09-12T09:05:00Z', verified: true, key_id: 'kid_peer_1' },
  { message_id: 'c3', from_address: 'boss@msg9.io', subject: 'other topic', body: { text: 'other body' }, created_at: '2026-09-12T10:00:00Z' },
  { message_id: 'c4a', from_address: 'team@msg9.io', subject: 'group note', body: { text: 'group body' }, created_at: '2026-09-12T11:00:00Z', list_address: 'team-x@dsh.msg9.io', group_copy: true, correlation_id: 'thread-g', read_at: '2026-09-12T11:05:00Z' },
  { message_id: 'c4b', from_address: 'team@msg9.io', subject: 'group note', body: { text: 'group body' }, created_at: '2026-09-12T11:00:01Z', list_address: 'team-x@dsh.msg9.io', group_copy: true, correlation_id: 'thread-g', read_at: '2026-09-12T11:05:00Z' },
]
const threadOutboxRows = [
  { message_id: 'c1s', from_address: 'dsh-alpha-1a2b@msg9.io', to_address: 'peer@msg9.io', subject: 're: roadmap sync', body: { text: 'my question' }, created_at: '2026-09-12T08:30:00Z', correlation_id: 'thread-c' },
]

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
function readRaw(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => resolve(raw))
  })
}

/** Verify an msg9-sig-v1 signed send the way the real server would. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
function verifySignedSend({ publicKeyB64, headers, rawBody, from, to }) {
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyB64, 'base64')]),
    format: 'der',
    type: 'spki',
  })
  const payload = [
    'msg9-sig-v1',
    `from=${from}`,
    `to=${to}`,
    `ts=${headers['x-msg9-timestamp']}`,
    `nonce=${headers['x-msg9-nonce']}`,
    `idem=${headers['idempotency-key']}`,
    `body_sha256=${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`,
  ].join('\n')
  return cryptoVerify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(headers['x-msg9-signature'], 'base64'))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake')
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/v1/inbox/messages') {
    seen.inboxLimit.push(url.searchParams.get('limit'))
    const rows = threadInbox ? threadInboxRows : inbox
    return reply(res, 200, { code: 0, data: { messages: rows, total: rows.length, unread_count: 3 } })
  }
  if (req.method === 'GET' && path === '/api/v1/outbox/messages') {
    const rows = threadInbox ? threadOutboxRows : outbox
    return reply(res, 200, { code: 0, data: { messages: rows, total: rows.length } })
  }
  if (req.method === 'POST' && path === '/api/v1/send') {
    const rawBody = await readRaw(req)
    seen.send.push({
      auth: req.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : {},
      rawBody,
      idempotencyKey: req.headers['idempotency-key'],
      signatureHeaders: req.headers['x-msg9-signature']
        ? {
            'x-msg9-signature': req.headers['x-msg9-signature'],
            'x-msg9-timestamp': req.headers['x-msg9-timestamp'],
            'x-msg9-nonce': req.headers['x-msg9-nonce'],
            'idempotency-key': req.headers['idempotency-key'],
          }
        : null,
    })
    return reply(res, 200, { code: 0, data: { message_id: 'm_sent_ui', status: 'accepted' } })
  }
  if (req.method === 'PUT' && path === '/api/v1/agent/signing-key') {
    const body = await readBody(req)
    seen.signingKeys.push({ auth: req.headers.authorization, publicKey: body.signing_public_key })
    return reply(res, 200, { code: 0, data: { signing_public_key: body.signing_public_key, key_id: 'kid_fake', first_time: true } })
  }
  if (req.method === 'POST' && /^\/api\/v1\/inbox\/messages\/.+\/read$/.test(path)) {
    const body = await readBody(req)
    seen.read.push(decodeURIComponent(path.split('/')[5]))
    seen.readBy.push(body.by ?? null)
    return reply(res, 200, { code: 0, data: { status: 'ok' } })
  }
  if (req.method === 'POST' && /^\/api\/v1\/inbox\/messages\/.+\/processed$/.test(path)) {
    const body = await readBody(req)
    seen.processed.push({ id: decodeURIComponent(path.split('/')[5]), by: body.by ?? null })
    return reply(res, 200, { code: 0, data: { status: 'ok' } })
  }
  if (req.method === 'GET' && path === '/api/v1/contacts') {
    return reply(res, 200, { code: 0, data: { contacts, total: contacts.length } })
  }
  if (req.method === 'GET' && path === '/api/v1/directory') {
    seen.directory.push({ q: url.searchParams.get('q'), capability: url.searchParams.get('capability'), limit: url.searchParams.get('limit') })
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const capability = url.searchParams.get('capability')
    const agents = directoryAgents.filter((agent) => {
      if (capability && !(agent.profile.capabilities ?? []).includes(capability)) return false
      if (q && !`${agent.profile.display_name} ${agent.address} ${agent.profile.description}`.toLowerCase().includes(q)) return false
      return true
    })
    return reply(res, 200, { code: 0, data: { agents, total: agents.length } })
  }
  if (req.method === 'POST' && path === '/api/v1/contacts') {
    const body = await readBody(req)
    seen.contactAdd.push(body)
    return reply(res, 200, { code: 0, data: { id: 'c9', contact: body.contact, alias: body.alias, status: 'accepted' } })
  }
  if (req.method === 'DELETE' && path.startsWith('/api/v1/contacts/')) {
    seen.contactRemove.push(decodeURIComponent(path.slice('/api/v1/contacts/'.length)))
    return reply(res, 200, { code: 0, data: { status: 'ok' } })
  }
  if (req.method === 'GET' && path === '/api/v1/owner/me') {
    const auth = req.headers.authorization || ''
    // A tenant with a subdomain slug (post-upgrade server shape).
    if (auth === 'Bearer msg9_tk_slug_1234567890') {
      return reply(res, 200, { code: 0, data: { id: 'own_sl', name: 'slugged', slug: 'vme', mail_domain: 'msg9.io', quota: { max_agents: 50 } } })
    }
    if (auth !== 'Bearer msg9_tk_ui_1234567890') return reply(res, 401, { code: 40100, message: 'invalid owner key' })
    return reply(res, 200, { code: 0, data: { id: 'own_ui', name: 'dsh-ui', quota: { max_agents: 50 } } })
  }
  if (req.method === 'GET' && path === '/api/v1/owner/agents') {
    seen.ownerAgents += 1
    return reply(res, 200, { code: 0, data: { agents: ownerAgents, total: ownerAgents.length } })
  }
  if (req.method === 'GET' && path === '/api/v1/owner/account/agents') {
    return reply(res, 200, { code: 0, data: { agents: accountAgents, total: accountAgents.length } })
  }
  // §28 (v1.27): the org-level union. Gated so the suite exercises BOTH the
  // 404 fallback (account view) and the org-priority path once it "ships".
  if (req.method === 'GET' && path === '/api/v1/owner/org/agents') {
    if (!orgEndpointLive) return reply(res, 404, { code: 40400, message: 'not found' })
    return reply(res, 200, { code: 0, data: { agents: orgAgents, total: orgAgents.length, org_id: 'org_ice', org_label: 'ice' } })
  }
  if (req.method === 'GET' && path === '/api/v1/groups') {
    return reply(res, 200, { code: 0, data: { groups: groupsFixture, total: groupsFixture.length } })
  }
  if (req.method === 'GET' && /^\/api\/v1\/groups\/.+\/messages$/.test(path)) {
    const rows = treeArchive ? treeLetters : fanoutArchive ? fanoutCopies : groupArchive
    return reply(res, 200, { code: 0, data: { messages: rows, total: rows.length } })
  }
  if (req.method === 'GET' && path.startsWith('/api/v1/groups/')) {
    const address = decodeURIComponent(path.slice('/api/v1/groups/'.length))
    const group = groupsFixture.find((row) => row.address === address)
    if (!group) return reply(res, 404, { code: 40400, message: 'not found' })
    return reply(res, 200, { code: 0, data: { ...group, members: ['a1@x.msg9.io', 'b2@x.msg9.io', 'c3@x.msg9.io'] } })
  }
  if (req.method === 'POST' && path === '/api/v1/owner/agents') {
    const body = await readBody(req)
    seen.provisioned.push(body.addresses[0])
    seen.provisionProfiles.push(body.profile ?? null)
    // This local part is already taken: the server reports a 40900 conflict
    // inside the provision envelope.
    if (body.addresses[0] === 'taken') {
      return reply(res, 200, { code: 0, data: { created: [], errors: [{ address: 'taken@vme.msg9.io', code: 40900, message: 'address already taken' }] } })
    }
    // The slugged tenant mints addresses on its own domain.
    const domain = req.headers.authorization === 'Bearer msg9_tk_slug_1234567890' ? 'vme.msg9.io' : 'msg9.io'
    const address = `${body.addresses[0]}@${domain}`
    seen.ownerAgents += 1
    ownerAgents.push({ id: 'oa_new', agent_address: address, ...(body.profile ? { profile: body.profile } : {}) })
    return reply(res, 200, { code: 0, data: { created: [{ address, api_key: `msg9_sk_prov_${body.addresses[0]}` }], errors: [] } })
  }
  if (req.method === 'POST' && /^\/api\/v1\/owner\/agents\/.+\/disable$/.test(path)) {
    seen.disabled = seen.disabled ?? []
    seen.disabled.push(decodeURIComponent(path.split('/')[5]))
    return reply(res, 200, { code: 0, data: { status: 'suspended' } })
  }
  if (req.method === 'PUT' && path === '/api/v1/agent/forwarding') {
    const body = await readBody(req)
    seen.forwarding.push({ auth: req.headers.authorization, target: body.target })
    return reply(res, 200, { code: 0, data: { address: 'dsh-alpha-1a2b@msg9.io', target: body.target, notify_sender: false } })
  }
  if (req.method === 'POST' && /^\/api\/v1\/owner\/agents\/.+\/move-mail$/.test(path)) {
    const body = await readBody(req)
    seen.moveMail.push({ address: decodeURIComponent(path.split('/')[5]), to: body.to })
    return reply(res, 200, { code: 0, data: { moved: 2 } })
  }
  if (req.method === 'POST' && path === '/api/v1/register') {
    const body = await readBody(req)
    seen.register += 1
    return reply(res, 201, { code: 0, data: { address: `${body.requested_address}@msg9.io`, api_key: 'msg9_sk_pub_new' } })
  }
  return reply(res, 404, { code: 40400, message: 'not found' })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${server.address().port}`
process.env.MSG9_API_URL = apiUrl

// Pre-provisioned tenant: an owner plus two workspace inboxes. Workspace C has
// no inbox yet, so the panel's "open inbox" path has something to do.
await writeFile(process.env.MSG9_STATE_FILE, `${JSON.stringify({
  owner: { api_key: 'msg9_tk_smoketest0123456789', api_url: apiUrl, id: 'own_1', name: 'dsh' },
  workspaces: {
    'ws-a': { address: 'dsh-alpha-1a2b@msg9.io', api_key: 'msg9_sk_a', api_url: apiUrl, title: 'alpha', path: '/work/a', cursor: 'C1' },
    'ws-b': { address: 'dsh-beta-3c4d@msg9.io', api_key: 'msg9_sk_b', api_url: apiUrl, title: 'beta', path: '/work/b' },
  },
}, null, 2)}\n`)

// ------------------------------------------------------------- fake dsh host

const workspaces = [
  { id: 'ws-a', title: 'alpha', path: '/work/a' },
  { id: 'ws-b', title: 'beta', path: '/work/b' },
  { id: 'ws-c', title: 'gamma', path: '/work/c' },
]
const sessionCwd = { 'sess-a': '/work/a', 'sess-c': '/work/c' }

const host = {
  logger: () => ({ info: () => {} }),
  sessions: { get: (id) => (sessionCwd[id] ? { header: { cwd: sessionCwd[id] } } : undefined) },
  workspaceRegistry: { list: () => workspaces },
}

const {
  BRIDGE_PREFIX,
  createMsg9Bridge,
  defaultBridgeDeps,
  isTrustedRequest,
  createBridgeEventBus,
} = await import('../lib/index.js')

const bridge = createMsg9Bridge(defaultBridgeDeps(host))

// ----------------------------------------------------- node req/res doubles

function fakeReq({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  const listeners = {}
  const res = {
    status: 0,
    body: undefined,
    headers: undefined,
    written: [],
    // The bridge subscribes to 'close' to abort outbound calls on disconnect.
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
    },
    fire(event) {
      for (const fn of listeners[event] ?? []) fn()
    },
    writableEnded: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    write(text) {
      res.written.push(text)
    },
    end(text) {
      res.body = text
      res.writableEnded = true
    },
    json() {
      return res.body ? JSON.parse(res.body) : undefined
    },
  }
  return res
}

/** Call one bridge route and return `{ status, payload }`. */
async function call(path, { method = 'GET', body, headers } = {}) {
  const res = fakeRes()
  await bridge.handle(fakeReq({ method, url: path, body, headers }), res)
  return { status: res.status, payload: res.json(), raw: res.body }
}

// -------------------------------------------------------------- bundle load

let envelope
globalThis.window = {
  __ModuleLoader__: {
    load: (captured) => {
      envelope = captured
    },
  },
}
await import('../lib/client.js')
assert.ok(envelope, 'client bundle must register itself with the module loader')
const client = envelope.factory((specifier) => require_(specifier))

/** A `fetch` that serves the client bridge from the host bridge. */
function bridgeFetch() {
  return async (url, init = {}) => {
    const target = new URL(url, 'http://127.0.0.1:3080')
    const res = fakeRes()
    await bridge.handle(fakeReq({
      method: init.method ?? 'GET',
      url: `${target.pathname}${target.search}`,
      body: init.body ? JSON.parse(init.body) : undefined,
    }), res)
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: '',
      text: async () => res.body ?? '',
    }
  }
}

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

console.log('dsh-msg9-kit browser-face smoke test:')

// ------------------------------------------------------------- host bridge

await check('bridge: overview resolves the current workspace from a session cwd', async () => {
  const { status, payload } = await call(`${BRIDGE_PREFIX}/overview?cwd=%2Fwork%2Fa`)
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.current.key, 'ws-a')
  assert.equal(payload.data.current.address, 'dsh-alpha-1a2b@msg9.io')
  assert.equal(payload.data.owner.name, 'dsh')
  assert.deepEqual(payload.data.workspaces.map((row) => row.key), ['ws-a', 'ws-b', 'ws-c'])
  assert.equal(payload.data.workspaces.find((row) => row.key === 'ws-c').provisioned, false)
  // Unprovisioned rows carry the host-derived address preview.
  assert.match(payload.data.workspaces.find((row) => row.key === 'ws-c').planned_address, /^dsh-gamma-[0-9a-f]{4}@/)
  assert.equal(payload.data.workspaces.find((row) => row.key === 'ws-a').planned_address, null)
})

await check('bridge: overview without a cwd still lists the tenant', async () => {
  const { payload } = await call(`${BRIDGE_PREFIX}/overview`)
  assert.equal(payload.data.current, null)
  assert.equal(payload.data.workspaces.length, 3)
  assert.match(payload.data.owner.masked, /^msg9_tk_smo…/)
})

await check('bridge: no response ever carries a usable key', async () => {
  const secrets = ['msg9_tk_smoketest0123456789', 'msg9_sk_a', 'msg9_sk_b']
  for (const path of ['/overview?cwd=%2Fwork%2Fa', '/messages?key=ws-a', '/outbox?key=ws-a', '/contacts?key=ws-a', '/peers', '/unread']) {
    const { raw } = await call(`${BRIDGE_PREFIX}${path}`)
    for (const secret of secrets) {
      assert.ok(!raw.includes(secret), `${path} leaked ${secret}`)
    }
  }
  // The owner key reaches the page only in its masked form.
  const { raw } = await call(`${BRIDGE_PREFIX}/overview`)
  assert.ok(raw.includes('msg9_tk_smo…6789'), raw)
})

await check('bridge: messages/outbox/contacts return the workspace mailbox', async () => {
  const messages = await call(`${BRIDGE_PREFIX}/messages?key=ws-a&folder=all&limit=10`)
  assert.equal(messages.payload.data.messages.length, 3)
  assert.equal(messages.payload.data.unread_count, 3)

  // No limit given: the documented default (20) reaches the upstream — a
  // regression here once clamped the absent parameter to a single message.
  seen.inboxLimit.length = 0
  const dflt = await call(`${BRIDGE_PREFIX}/messages?key=ws-a`)
  assert.equal(dflt.payload.data.messages.length, 3)
  assert.deepEqual(seen.inboxLimit, ['20'])

  const outboxPage = await call(`${BRIDGE_PREFIX}/outbox?key=ws-a`)
  assert.equal(outboxPage.payload.data.messages[0].message_id, 'o1')
  assert.equal(outboxPage.payload.data.messages[0].to_address, 'peer@msg9.io')

  const addressBook = await call(`${BRIDGE_PREFIX}/contacts?key=ws-a`)
  assert.equal(addressBook.payload.data.contacts[0].alias, 'Peer')
})

await check('bridge: send / read / contacts write through to msg9', async () => {
  const sent = await call(`${BRIDGE_PREFIX}/send`, {
    method: 'POST',
    body: { key: 'ws-a', to: 'peer@msg9.io', subject: 'hi', text: 'from the panel' },
  })
  assert.equal(sent.payload.data.message_id, 'm_sent_ui')
  assert.equal(seen.send[0].auth, 'Bearer msg9_sk_a')
  assert.deepEqual(seen.send[0].body, { to: 'peer@msg9.io', subject: 'hi', body: { text: 'from the panel' } })

  await call(`${BRIDGE_PREFIX}/read`, { method: 'POST', body: { key: 'ws-a', message_id: 'm1' } })
  assert.deepEqual(seen.read, ['m1'])

  await call(`${BRIDGE_PREFIX}/contacts`, { method: 'POST', body: { key: 'ws-a', contact: 'gamma@msg9.io', alias: 'Gamma' } })
  assert.deepEqual(seen.contactAdd, [{ contact: 'gamma@msg9.io', alias: 'Gamma' }])

  await call(`${BRIDGE_PREFIX}/contacts?key=ws-a&address=gamma%40msg9.io`, { method: 'DELETE' })
  assert.deepEqual(seen.contactRemove, ['gamma@msg9.io'])
})

await check('bridge: peers and unread serve the sidebar badge', async () => {
  const peers = await call(`${BRIDGE_PREFIX}/peers`)
  assert.equal(peers.payload.data.peers.length, 1)
  assert.equal(peers.payload.data.peers[0].title, 'alpha')
  // Yellow-pages profile rides the roster (v1.5).
  assert.equal(peers.payload.data.peers[0].description, 'alpha workspace inbox')
  assert.deepEqual(peers.payload.data.peers[0].capabilities, ['code-review'])

  const unread = await call(`${BRIDGE_PREFIX}/unread`)
  const keys = Object.keys(unread.payload.data.byKey).sort()
  assert.deepEqual(keys, ['ws-a', 'ws-b']) // ws-c has no inbox yet
  assert.equal(unread.payload.data.total, 3 * keys.length) // every inbox reports 3 unread
  assert.equal(unread.payload.data.byKey['ws-a'], 3)
})

await check('bridge: provision opens the inbox of a workspace that has none', async () => {
  const before = seen.ownerAgents
  const { payload } = await call(`${BRIDGE_PREFIX}/provision`, { method: 'POST', body: { cwd: '/work/c', title: 'gamma' } })
  assert.equal(payload.data.key, 'ws-c')
  assert.ok(payload.data.address.startsWith('dsh-gamma-'), payload.data.address)
  assert.equal(payload.data.provisioned, true)
  assert.equal(seen.ownerAgents, before + 1)
  // Provisioning writes the yellow-pages profile for the new inbox.
  const profile = seen.provisionProfiles[seen.provisionProfiles.length - 1]
  assert.equal(profile.display_name, 'gamma')
  assert.equal(profile.links.workspace, '/work/c')

  const overview = await call(`${BRIDGE_PREFIX}/overview?cwd=%2Fwork%2Fc`)
  assert.equal(overview.payload.data.current.key, 'ws-c')
  assert.equal(overview.payload.data.current.provisioned, true)
})

await check('bridge: rejects untrusted hosts, unknown routes and missing params', async () => {
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: 'evil.example:80' } })), false)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '127.0.0.1:3080' } })), true)
  // A browser origin is authoritative: cross-site pages cannot drive the bridge.
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } })), false)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } })), true)
  assert.equal(isTrustedRequest(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' } })), false)

  const forbidden = await call(`${BRIDGE_PREFIX}/overview`, { headers: { host: 'evil.example' } })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.payload.error.code, 'forbidden')

  const notFound = await call(`${BRIDGE_PREFIX}/nope`)
  assert.equal(notFound.status, 404)

  const missingKey = await call(`${BRIDGE_PREFIX}/messages`)
  assert.equal(missingKey.status, 400)
  assert.equal(missingKey.payload.error.code, 'missing-key')

  const unknownWorkspace = await call(`${BRIDGE_PREFIX}/messages?key=ghost`)
  assert.equal(unknownWorkspace.status, 404)
  assert.equal(unknownWorkspace.payload.error.code, 'unknown-workspace')
})

await check('bridge: the notify mute survives a write/read roundtrip (the lost-on-refresh bug)', async () => {
  const on = await call(`${BRIDGE_PREFIX}/notify`, { method: 'POST', body: { paused: true } })
  assert.equal(on.payload.data.paused, true)
  // The state file round trip is the actual regression: loadState once dropped
  // every top-level field except owner/workspaces, so the mute never came back.
  const saved = JSON.parse(await readFile(process.env.MSG9_STATE_FILE, 'utf8'))
  assert.equal(saved.notify_paused, true, 'persisted to the state file')
  const back = await call(`${BRIDGE_PREFIX}/notify`)
  assert.equal(back.payload.data.paused, true, 'and it reads back')
  // Leave the fixture unmuted for the rest of the suite.
  await call(`${BRIDGE_PREFIX}/notify`, { method: 'POST', body: { paused: false } })
})

// --------------------------------------------------------- browser bundle

await check('bundle: the module-loader envelope names the package', () => {
  assert.equal(envelope.id, 'dsh-msg9-kit')
  assert.equal(client.name, 'msg9-kit')
  assert.deepEqual([...client.inject], ['slots'])
  assert.equal(client.MSG9_VIEW_ID, 'msg9')
})

await check('apply(): the conversation view tab and the settings section are registered', async () => {
  const registrations = []
  const injections = []
  const disposers = []
  const ctx = {
    logger: () => ({ info: () => {} }),
    effect: (fn) => {
      const dispose = fn()
      const disposer = () => {
        if (typeof dispose === 'function') dispose()
      }
      disposers.push(disposer)
      return disposer
    },
    slots: {
      inject: (slot, callback) => {
        injections.push(slot)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  assert.deepEqual([...new Set(injections)].sort(), ['conversation.view', 'settings.section'])

  // The「消息」view tab sits after 对话 | 轨迹 | 文件 (order 30).
  const view = registrations.find((row) => row.options.name === 'conversation.view')
  assert.equal(view.options.id, 'msg9')
  assert.equal(view.options.order, 30)
  assert.equal(view.options.label(), 'Messages')
  assert.equal(typeof view.component, 'function')
  const viewStore = view.options.inject().store
  assert.equal(typeof viewStore.getState, 'function')
  // The mute state shows on the tab itself (no need to open it to know).
  // The registered store is the singleton (default bridge): point the global
  // fetch at the test bridge so toggleNotify can reach it.
  const realFetch = globalThis.fetch
  globalThis.fetch = bridgeFetch()
  await viewStore.toggleNotify()
  globalThis.fetch = realFetch
  assert.equal(viewStore.getState().notifyPaused, true)
  assert.ok(view.options.label().includes('‖'), 'muted tab is marked')
  globalThis.fetch = bridgeFetch()
  await viewStore.toggleNotify()
  globalThis.fetch = realFetch

  // Settings → 消息信箱 section.
  const section = registrations.find((row) => row.options.name === 'settings.section')
  assert.equal(section.options.id, 'msg9-mailboxes')
  assert.equal(section.options.label(), 'Messages')
  assert.equal(typeof section.options.inject().store.getState, 'function')

  // Effects: just the unread poller.
  assert.equal(disposers.length, 1)
  for (const dispose of disposers) dispose()
})

// -------------------------------------------------------------- panel + store

await check('store: loads overview, inbox, outbox and contacts through the bridge', async () => {
  const store = client.createMsg9Store({
    bridge: client.createBridge({ fetch: bridgeFetch() }),
    pollMs: 10 ** 9,
  })
  store.setCwd('/work/a')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const state = store.getState()
  assert.equal(state.status, 'ready')
  assert.equal(state.currentKey, 'ws-a')
  assert.equal(state.owner.name, 'dsh')
  assert.equal(state.messages.length, 3)
  assert.equal(state.unreadCount, 3)
  assert.equal(state.outbox.length, 1)
  assert.equal(state.contacts.length, 1)
  assert.equal(state.unreadTotal, 3 * Object.keys(state.unreadByKey).length)
  assert.equal(store.getState() === state, true)
})

await check('store: send, mark-read, contacts and provision move the real data', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()

  store.setCompose({ to: 'peer@msg9.io', subject: 'ping', text: 'hello from the panel' })
  await store.send()
  assert.ok(store.getState().notice.text.includes('m_sent_ui'), store.getState().notice.text)
  assert.equal(store.getState().compose.text, '')
  assert.equal(seen.send[seen.send.length - 1].body.body.text, 'hello from the panel')

  const before = store.getState().unreadCount
  await store.markRead('m1')
  assert.equal(store.getState().unreadCount, before - 1)
  assert.ok(store.getState().messages.find((message) => message.message_id === 'm1').read_at)
  assert.equal(seen.read[seen.read.length - 1], 'm1')

  await store.addContact({ contact: 'delta@msg9.io', alias: 'Delta' })
  assert.equal(seen.contactAdd[seen.contactAdd.length - 1].contact, 'delta@msg9.io')

  await store.removeContact('delta@msg9.io')
  assert.equal(seen.contactRemove[seen.contactRemove.length - 1], 'delta@msg9.io')

  store.selectWorkspace('ws-c')
  await store.provision()
  assert.ok(store.getState().notice.text.includes('dsh-gamma-'), store.getState().notice.text)
  assert.equal(store.getState().workspaces.find((row) => row.key === 'ws-c').provisioned, true)
})
await check('store: failed sends surface a notice and keep the draft', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  store.setCompose({ to: '', text: '' })
  await store.send()
  assert.equal(store.getState().notice.kind, 'error')
  assert.ok(store.getState().notice.text.includes('recipient'), store.getState().notice.text)
})

await check('store: a retried send reuses one idempotency key', async () => {
  const base = bridgeFetch()
  const sendKeys = []
  let failFirstSend = true
  const flaky = async (url, init) => {
    if (String(url).includes('/send')) {
      sendKeys.push(JSON.parse(init.body).idempotency_key)
      if (failFirstSend) {
        failFirstSend = false
        return { ok: false, status: 500, statusText: '', text: async () => JSON.stringify({ ok: false, error: { code: 'boom', message: 'send failed' } }) }
      }
    }
    return base(url, init)
  }
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: flaky }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()

  store.setCompose({ to: 'peer@msg9.io', text: 'retry me' })
  await store.send()
  assert.equal(store.getState().notice.kind, 'error')
  await store.send()
  assert.equal(store.getState().notice.kind, 'ok')

  // Both attempts carried the SAME key, and that key reached msg9 as the
  // Idempotency-Key header — the server can dedup instead of double-sending.
  assert.equal(sendKeys.length, 2)
  assert.ok(sendKeys[0], 'client generates a key')
  assert.equal(sendKeys[0], sendKeys[1])
  assert.equal(seen.send[seen.send.length - 1].idempotencyKey, sendKeys[0])

  // Editing the draft is a new intent: the next send gets a fresh key.
  store.setCompose({ to: 'peer@msg9.io', text: 'retry me (edited)' })
  await store.send()
  assert.equal(sendKeys.length, 3)
  assert.notEqual(sendKeys[2], sendKeys[0])
})

await check('store: a failed mark-read restores the list AND the unread count', async () => {
  const base = bridgeFetch()
  let failFirstRead = true
  const flaky = async (url, init) => {
    if (failFirstRead && String(url).includes('/read')) {
      failFirstRead = false
      return { ok: false, status: 500, statusText: '', text: async () => JSON.stringify({ ok: false, error: { code: 'boom', message: 'read failed' } }) }
    }
    return base(url, init)
  }
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: flaky }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const before = store.getState().unreadCount
  await store.markRead('m1')
  assert.equal(store.getState().notice.kind, 'error')
  assert.equal(store.getState().unreadCount, before, 'badge count restored')
  assert.equal(store.getState().messages.find((message) => message.message_id === 'm1').read_at, undefined, 'message still unread')
})

await check('store: a stale list response never overwrites the workspace being viewed', async () => {
  // Fully fake bridge: inbox fetches hang until the test releases them.
  const release = new Map()
  const fake = {
    overview: async () => ({
      owner: null,
      api_url: 'http://fake',
      state_file: '',
      current: null,
      workspaces: [
        { key: 'ws-a', title: 'alpha', path: '/work/a', address: 'a@msg9.io', provisioned: true, cursor: null, current: false },
        { key: 'ws-b', title: 'beta', path: '/work/b', address: 'b@msg9.io', provisioned: true, cursor: null, current: false },
      ],
    }),
    messages: (key) => new Promise((resolve) => release.set(key, resolve)),
    outbox: async () => ({ messages: [], total: 0 }),
    contacts: async () => ({ contacts: [], total: 0 }),
    unread: async () => ({ total: 0, byKey: {} }),
    peers: async () => ({ peers: [] }),
  }
  const store = client.createMsg9Store({ bridge: fake, pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshOverview()
  assert.ok(release.has('ws-a'), 'inbox of the auto-selected workspace is loading')

  // Switch workspaces while ws-a's fetch is still in flight.
  store.selectWorkspace('ws-b')
  assert.ok(release.has('ws-b'))

  // The NEWER request answers first, then the stale one: last write must win.
  release.get('ws-b')({ messages: [{ message_id: 'b1', from_address: 'x@msg9.io' }], total: 1, unread_count: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  release.get('ws-a')({ messages: [{ message_id: 'a1', from_address: 'x@msg9.io' }], total: 1, unread_count: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(store.getState().currentKey, 'ws-b')
  assert.deepEqual(store.getState().messages.map((message) => message.message_id), ['b1'])
})

await check('panel renders the current workspace mailbox (server-side markup)', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
  const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))

  // Three columns: nav (boxes + compose), list, detail placeholder.
  assert.ok(html.includes('Inbox'), 'nav: inbox')
  assert.ok(html.includes('Outbox'), 'nav: outbox')
  assert.ok(html.includes('Contacts'), 'nav: contacts')
  assert.ok(html.includes('Compose'), 'nav: compose button')
  assert.ok(html.includes('dsh-alpha-1a2b@msg9.io'), 'address shown')
  assert.ok(html.includes('peer@msg9.io'), 'sender shown')
  assert.ok(html.includes('hello'), 'subject shown')
  assert.ok(html.includes('first body line'), 'preview shown')
  assert.ok(html.includes('Select a message to read it.'), 'detail placeholder')
  // The body renders as markdown in the detail column.
  store.selectMessage('m1')
  const reading = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(reading.includes('m9-md'), 'markdown container')
  assert.ok(reading.includes('<strong>first body line</strong>'), 'markdown rendered, not raw')
  assert.ok(reading.includes('Unsigned'), 'unsigned mail is labelled as such')
  // Fenced code blocks get syntax highlighting (Shiki css-variables theme).
  await client.highlightReady
  store.selectMessage('m3')
  const coded = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(coded.includes('language-ts'), 'language tag on the fence')
  assert.ok(coded.includes('var(--shiki-'), 'code is highlighted with Shiki token variables')
  assert.ok(coded.includes('Signature verified'), 'verified mail carries the badge')
  assert.ok(coded.includes('team-x@dsh.msg9.io'), 'group address shown on a group copy')
  assert.ok(coded.includes('Reply to group'), 'group copies reply to the group, not the sender')
  // The composer opens in the detail column on demand.
  store.composeTo('peer@msg9.io')
  const composing = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(composing.includes('peer@msg9.io'), 'reply pre-fills the recipient')
  assert.ok(composing.includes('Send'), 'composer offered')
})

await check('square tab lists public agents and shows the agent card', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  store.setTab('square')
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(store.getState().directoryTotal, 2)
  const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
  const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(html.includes('Square'), 'nav: square')
  assert.ok(html.includes('nova@vme.msg9.io'), 'agent of another tenant listed')
  assert.ok(html.includes('design-review'), 'capability chip listed')
  assert.ok(html.includes('known'), 'the local inbox is tagged as known')

  // Selecting an agent shows its yellow-pages card with the follow-up actions.
  store.selectAgent('nova@vme.msg9.io')
  const card = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(card.includes('Nova'), 'display name on the card')
  assert.ok(card.includes('design reviewer of another tenant'), 'description on the card')
  assert.ok(card.includes('/opt/nova'), 'profile link on the card')
  assert.ok(card.includes('Add contact'), 'add-contact action offered')

  // Adding it lands in the workspace's address book (alias = display name).
  const added = await store.addContact({ contact: 'nova@vme.msg9.io', alias: 'Nova' })
  assert.ok(added, 'addContact resolves true')
  assert.equal(seen.contactAdd.at(-1).contact, 'nova@vme.msg9.io')
  assert.equal(seen.contactAdd.at(-1).alias, 'Nova')

  // The square queries the SERVER: q / capability ride the request, and the
  // page size stays within the v1.10 cap of 100.
  assert.equal(seen.directory.at(-1).limit, '100')
  store.setDirectoryQuery('nova')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(seen.directory.at(-1).q, 'nova')
  assert.deepEqual(store.getState().directory.map((row) => row.address), ['nova@vme.msg9.io'])
  store.setDirectoryCapability('code-review')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(seen.directory.at(-1).capability, 'code-review')
  assert.deepEqual(store.getState().directory.map((row) => row.address), [], 'q + capability combine')
})

await check('contacts tab shows the tenant network grouped by owner', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  store.setTab('contacts')
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(store.getState().accountAgents.length, 3)
  const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
  const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(html.includes('My tenant network'), 'network section shown')
  assert.ok(html.includes('KimiCode · kimi.msg9.io'), 'grouped under the other owner')
  assert.ok(html.includes('nova@kimi.msg9.io'), 'agent of the other owner listed')
  assert.ok(html.includes('design-review'), 'capabilities ride along')
  assert.ok(html.includes('suspended'), 'non-active status is tagged')
})

await check('account agents: the §28 org endpoint wins once it ships; 404 falls back to the account view', async () => {
  // The tenant-network test above already exercised the fallback
  // (orgEndpointLive=false → /owner/org/agents 404s → the account fixture).
  orgEndpointLive = true
  const res = await call(`${BRIDGE_PREFIX}/account/agents`)
  assert.equal(res.payload.data.total, 1, 'org projection, not the account fixture')
  assert.equal(res.payload.data.agents[0].address, 'dsh@dsh.ice.msg9.io')
  assert.equal(res.payload.data.org_id, 'org_ice', 'org id rides along to the panel')
  assert.equal(res.payload.data.org_label, 'ice', 'org label rides along to the panel')
  orgEndpointLive = false
})

await check('groups tab lists groups; selecting one shows the card and its archive', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  store.setTab('groups')
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(store.getState().groups.length, 2)
  const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
  const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(html.includes('Groups'), 'nav: groups tab')
  assert.ok(html.includes('Created by me'), 'created section shown')
  assert.ok(html.includes('Joined'), 'joined section shown')
  assert.ok(html.indexOf('Created by me') < html.indexOf('Team X'), 'team-x sits under Created by me (its creator is this inbox)')
  assert.ok(html.indexOf('Joined') < html.indexOf('Platform Crew'), 'platform-crew sits under Joined')

  // Selecting a group: the card (with members) and the archive below it.
  store.selectGroup('team-x@dsh.msg9.io')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.getState().groupArchive.length, 2)
  const card = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(card.includes('demo group for the panel'), 'description on the card')
  assert.ok(card.includes('closed'), 'closed/open tag shown')
  assert.ok(card.includes('3 members'), 'member count shown')
  assert.ok(card.includes('Created by dsh-alpha-1a2b@msg9.io'), 'creator shown on the card')
  assert.ok(card.includes('a1@x.msg9.io'), 'member list loaded from the detail endpoint')
  assert.ok(card.includes('Message the group'), 'reply-all action offered')
  assert.ok(card.includes('kickoff'), 'archive subject listed')
  assert.ok(card.includes('Messages (2/2)'), 'archive counter shown')
  // Default view is chronological (正序): the older kickoff precedes follow
  // even though the server returns newest-first.
  assert.ok(card.indexOf('kickoff') < card.indexOf('follow'), 'default order is oldest-first')
})

await check('processed state: a reply closes the loop; markDone and the pending filter work', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Pending = not yet processed: all three fixture messages show up.
  store.setFolder('pending')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(store.getState().messages.map((row) => row.message_id), ['m1', 'm2', 'm3'])

  // 回复即处理: replying with reply_to closes m1's loop. m1 has no thread id,
  // so correlation_id must be ABSENT (never invented from the message id).
  store.replyTo({ message_id: 'm1', from_address: 'peer@msg9.io' })
  store.setCompose({ text: 'reply body' })
  await store.send()
  assert.equal(seen.send.at(-1).body.reply_to, 'm1', 'the reply closes the original precisely (reply_to)')
  assert.equal(seen.send.at(-1).body.correlation_id, undefined, 'no thread id → no correlation_id')
  assert.equal(store.getState().messages.find((row) => row.message_id === 'm1')?.processed_by, 'human')

  // A group copy reply: To = list_address, and the thread id rides VERBATIM.
  store.replyTo({ message_id: 'm3', from_address: 'peer@msg9.io', list_address: 'team-x@dsh.msg9.io', correlation_id: 'thread-9' })
  store.setCompose({ text: 'group reply' })
  await store.send()
  const groupReply = seen.send.at(-1).body
  assert.equal(groupReply.to, 'team-x@dsh.msg9.io', 'group copies reply to the group')
  assert.equal(groupReply.reply_to, 'm3', 'closes this copy')
  assert.equal(groupReply.correlation_id, 'thread-9', 'thread id copied verbatim — no fork')

  // The send is signed (msg9-sig-v1) and the signature verifies against the
  // public key this inbox installed at provisioning — the server-side check.
  const signedSend = seen.send.at(-1)
  assert.ok(signedSend.signatureHeaders, 'the send carries signature headers')
  const signingKey = seen.signingKeys.find((row) => row.auth.includes('msg9_sk_a'))
  assert.ok(signingKey, 'signing key installed for ws-a')
  assert.ok(verifySignedSend({
    publicKeyB64: signingKey.publicKey,
    headers: signedSend.signatureHeaders,
    rawBody: signedSend.rawBody,
    from: 'dsh-alpha-1a2b@msg9.io',
    to: signedSend.body.to,
  }), 'the signature verifies the way the server checks it')

  // Explicit done closes m2 without a reply — server-native /processed, by human.
  await store.markDone('m2')
  assert.equal(store.getState().messages.find((row) => row.message_id === 'm2')?.processed_by, 'human')
  assert.deepEqual(seen.processed.at(-1), { id: 'm2', by: 'human' }, 'v1.13 /processed called with attribution')

  // The attribution is recorded in the state file (server can't tell who marked).
  const saved = JSON.parse(await readFile(process.env.MSG9_STATE_FILE, 'utf8'))
  assert.equal(saved.workspaces['ws-a'].marks['m1'].processed_by, 'human')
  assert.equal(saved.workspaces['ws-a'].marks['m2'].read_by, 'human')

  // And the marks ride the next listing (read_by / processed_by merged in).
  store.setFolder('all')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.getState().messages.find((row) => row.message_id === 'm1')?.processed_by, 'human')
})

await check('SSE events: subscribe, get invalidated on mark-read, unsubscribe on close', async () => {
  const bus = createBridgeEventBus()
  const deps = defaultBridgeDeps(host)
  deps.events = bus
  const busBridge = createMsg9Bridge(deps)

  const res = fakeRes()
  await busBridge.handle(fakeReq({ url: `${BRIDGE_PREFIX}/events` }), res)
  assert.match(res.headers['Content-Type'], /text\/event-stream/)
  assert.ok(res.written[0].includes('connected'), 'greets the subscriber')
  assert.equal(bus.size(), 1)

  // A panel mark-read pushes an invalidation with the reason to the subscriber.
  await busBridge.handle(fakeReq({ method: 'POST', url: `${BRIDGE_PREFIX}/read`, body: { key: 'ws-a', message_id: 'm1' } }), fakeRes())
  assert.ok(
    res.written.some((line) => line.includes('"type":"invalidate"') && line.includes('"reason":"read"')),
    JSON.stringify(res.written),
  )

  // Closing the connection drops the subscriber (and the heartbeat).
  res.fire('close')
  assert.equal(bus.size(), 0)
})

await check('panel renders the unprovisioned workspace as an explicit action', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  // A workspace with no inbox: /work/d is not in the registry, so it becomes a cwd bucket.
  store.setCwd('/work/d')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const useSessions = (selector) => selector({ current: 'sess-d', byId: { 'sess-d': { cwd: '/work/d' } } })
  const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions, onBack: () => {} }))
  assert.ok(html.includes('Open inbox'), html)
  // The preview shows the real derived address — never the raw `cwd:` key.
  assert.ok(html.includes('dsh-d-'), html)
  assert.ok(!html.includes('dsh-cwd'), html)
})

await check('settings section renders the service intro, tenant and its open inboxes', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  await store.refreshUnread()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const html = renderToStaticMarkup(React.createElement(client.Msg9SettingsSection, { store }))
  assert.ok(html.includes('msg9.io'), 'service intro shown')
  assert.ok(html.includes('Tenant'), html)
  assert.ok(html.includes('dsh'), 'tenant name shown')
  assert.ok(html.includes('own_1'), 'tenant id shown')
  // ws-c was provisioned by the earlier bridge test, so all three are open.
  assert.ok(html.includes('Open inboxes (3)'), html)
  assert.ok(html.includes('dsh-alpha-1a2b@msg9.io'), 'first inbox listed')
  assert.ok(html.includes('dsh-beta-3c4d@msg9.io'), 'second inbox listed')
  assert.ok(html.includes('dsh-gamma-'), 'newly opened inbox listed too')
  // Role column: the matching peer's yellow-pages description shows up.
  assert.ok(html.includes('alpha workspace inbox'), html)
  assert.ok(html.includes('code-review'), 'capabilities shown')
  // Per-inbox counts from /unread (the fake reports 3 unread of a 2-message box).
  assert.ok(html.includes('3 unread · 3 total'), html)
})

await check('store.start() keeps one poller and its disposer stops it', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  const stop = store.start()
  assert.equal(typeof stop, 'function')
  stop()
})

// ------------------------------------------------- panel fixes (2026-09-13)

await check('panel: the first paint shows a loading state, never a setup-form flash', async () => {
  // INITIAL.status === 'loading'：overview 还没回来，是否绑定租户是未知数。
  // 此时渲染 SetupView 就是已绑定实例每次打开「消息」都闪一下绑定表单的 bug。
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
  const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(html.includes('Loading'), 'loading state shown while the overview is in flight')
  assert.ok(!html.includes('Skip for now'), 'no setup-form flash for an already-bound instance')

  const settings = renderToStaticMarkup(React.createElement(client.Msg9SettingsSection, { store }))
  assert.ok(settings.includes('Loading'), 'settings tenant card waits for the overview too')
  assert.ok(!settings.includes('Skip for now'), 'no setup-form flash on the settings page either')
})

await check('store: a failed write never rolls an old list back over the new view', async () => {
  // 读路径有 seq 防护，写路径的乐观回滚原本没有：失败回来时视图若已切换
  // （workspace/folder 变了），回滚必须丢弃，否则旧列表塞回新视图。
  function makeStore(writeName) {
    let rejectWrite
    const fake = {
      overview: async () => ({
        owner: null, api_url: 'http://fake', state_file: '', current: null,
        workspaces: [
          { key: 'ws-a', title: 'alpha', path: '/work/a', address: 'a@msg9.io', provisioned: true, cursor: null, current: false },
          { key: 'ws-b', title: 'beta', path: '/work/b', address: 'b@msg9.io', provisioned: true, cursor: null, current: false },
        ],
      }),
      messages: async (key) => ({ messages: [{ message_id: `${key}-1`, from_address: 'x@msg9.io' }], total: 1, unread_count: 1 }),
      outbox: async () => ({ messages: [], total: 0 }),
      contacts: async () => ({ contacts: [], total: 0 }),
      unread: async () => ({ total: 0, byKey: {} }),
      peers: async () => ({ peers: [] }),
      groups: async () => ({ groups: [], total: 0 }),
      [writeName]: () => new Promise((_, reject) => { rejectWrite = reject }),
    }
    return { store: client.createMsg9Store({ bridge: fake, pollMs: 10 ** 9 }), fail: () => rejectWrite(new Error('write failed')) }
  }
  const flows = [
    ['markRead', (store) => store.markRead('ws-a-1')],
    ['markDone', (store) => store.markDone('ws-a-1')],
  ]
  for (const [writeName, run] of flows) {
    const { store, fail } = makeStore(writeName)
    store.setCwd('/work/a')
    await store.refreshOverview()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(store.getState().messages.map((row) => row.message_id), ['ws-a-1'])

    // The write is in flight when the user switches workspaces.
    const pending = run(store)
    store.selectWorkspace('ws-b')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(store.getState().messages.map((row) => row.message_id), ['ws-b-1'], `${writeName}: ws-b list loaded`)

    fail()
    await pending
    assert.equal(store.getState().notice.kind, 'error', `${writeName}: failure still surfaces`)
    assert.deepEqual(store.getState().messages.map((row) => row.message_id), ['ws-b-1'], `${writeName}: stale rollback dropped, ws-b view intact`)
    assert.equal(store.getState().unreadCount, 1, `${writeName}: badge belongs to ws-b, not rolled back`)
  }
})

await check('store: markDone decrements the badge, but only for unread mail', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const before = store.getState().unreadCount
  assert.equal(before, 3, 'fixture inbox starts with 3 unread')
  await store.markDone('m1') // m1 has no read_at: done implies read, badge drops.
  const done = store.getState().messages.find((row) => row.message_id === 'm1')
  assert.ok(done.read_at, 'read_at filled in')
  assert.equal(done.processed_by, 'human')
  assert.equal(store.getState().unreadCount, before - 1, 'unread mail handled: badge decremented')

  await store.markDone('m2') // m2 was already read: no double decrement.
  assert.equal(store.getState().unreadCount, before - 1, 'already-read mail: badge untouched')
})

await check('store: switching workspaces clears the badges along with the lists', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.getState().unreadCount, 3)
  assert.equal(store.getState().outboxTotal, 1)
  assert.equal(store.getState().contactsTotal, 1)

  store.selectWorkspace('ws-b')
  // 同步归零：新 workspace 的数据回来之前，徽标不能挂着旧 workspace 的计数。
  assert.equal(store.getState().unreadCount, 0)
  assert.equal(store.getState().messagesTotal, 0)
  assert.equal(store.getState().outboxTotal, 0)
  assert.equal(store.getState().contactsTotal, 0)

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.getState().unreadCount, 3, 'ws-b counts load right after')
})

await check('store: group archive append is busy-gated and deduped by message_id', async () => {
  // 「加载更多」的 offset 以已加载数为准：服务端数据漂移会跨页带回重复行，
  // 合并必须按 message_id 去重；连点由 busy 闸挡下（同 loadMoreDirectory）。
  const calls = []
  let releasePage = null
  const firstPage = {
    messages: [
      { message_id: 'g1', from_address: 'a@msg9.io' },
      { message_id: 'g2', from_address: 'b@msg9.io' },
    ],
    total: 3,
  }
  const driftedPage = {
    messages: [
      { message_id: 'g2', from_address: 'b@msg9.io' }, // offset 漂移：g2 又回来一次
      { message_id: 'g3', from_address: 'c@msg9.io' },
    ],
    total: 3,
  }
  const fake = {
    overview: async () => ({
      owner: null, api_url: 'http://fake', state_file: '', current: null,
      workspaces: [{ key: 'ws-a', title: 'alpha', path: '/work/a', address: 'a@msg9.io', provisioned: true, cursor: null, current: false }],
    }),
    messages: async () => ({ messages: [], total: 0, unread_count: 0 }),
    outbox: async () => ({ messages: [], total: 0 }),
    contacts: async () => ({ contacts: [], total: 0 }),
    unread: async () => ({ total: 0, byKey: {} }),
    peers: async () => ({ peers: [] }),
    groups: async () => ({ groups: [{ address: 'team@msg9.io', display_name: 'Team' }], total: 1 }),
    groupDetail: async () => ({ group: { address: 'team@msg9.io', display_name: 'Team' } }),
    groupMessages: (key, address, query) => {
      calls.push(query.offset)
      if (calls.length === 1) return Promise.resolve(firstPage)
      return new Promise((resolve) => { releasePage = () => resolve(driftedPage) })
    },
  }
  const store = client.createMsg9Store({ bridge: fake, pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshOverview()
  store.selectGroup('team@msg9.io')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(store.getState().groupArchive.map((row) => row.message_id), ['g1', 'g2'])
  assert.deepEqual(calls, [0], 'first page loaded at offset 0')

  const appending = store.refreshGroupArchive(true) // hangs until releasePage()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.getState().busy.archive, true, 'append in flight')
  await store.refreshGroupArchive(true) // gated: no second request goes out
  assert.deepEqual(calls, [0, 2], 'the in-flight append blocks the duplicate click')

  releasePage()
  await appending
  assert.deepEqual(store.getState().groupArchive.map((row) => row.message_id), ['g1', 'g2', 'g3'], 'offset drift merged without the duplicate')
  assert.equal(store.getState().busy.archive, false)
})

await check('groups archive: the channel view threads letters, folds copies and marks my own', async () => {
  fanoutArchive = true
  try {
    const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
    store.setCwd('/work/a')
    await store.refreshAll()
    store.setTab('groups')
    store.selectGroup('team-x@dsh.msg9.io')
    for (let i = 0; i < 50 && store.getState().groupArchive.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(store.getState().groupArchive.length, 8, 'store keeps every archived copy (dedup is by message_id only)')

    const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
    const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
    // 布局：组头（信息卡 + 发信按钮）和计数/正倒序行在滚动容器外且位于其前；
    // 滚动容器 m9-archive-scroll 里只有存档内容（含底部的加载更多）。
    assert.ok(html.includes('m9-archive-scroll'), 'the archive has its own scroll region')
    assert.ok(html.indexOf('Message the group') < html.indexOf('m9-archive-scroll'), 'group header stays above (outside) the scroll region')
    assert.ok(html.indexOf('Oldest first') < html.indexOf('m9-archive-scroll'), 'counter + order toggle stays above the scroll region')
    assert.ok(!html.slice(html.indexOf('m9-archive-scroll')).includes('Message the group'), 'scroll region holds only archive content')
    // 卡片宽度约束锚点：maxWidth 封顶，任何卡片不超出右栏可视宽度。
    assert.ok(html.includes('max-width:92%'), 'letter cards carry the max-width clamp')
    // 宽表格处理规则随 M9_CSS 注入（表格内部横滚，不撑破卡片）。
    assert.ok(html.includes('.m9-letter-md table'), 'archive tables scroll internally')
    // 默认折叠：只有头行 + 纯文本预览，没有 markdown 正文，也没有「回复」。
    // （断言匹配渲染出的 class 属性——M9_CSS 样式文本里本来就含 ".m9-md" 字样。）
    assert.ok(!html.includes('class="m9-md'), 'collapsed channel renders previews, not markdown bodies')
    assert.ok(!html.includes('Reply</button>'), 'the reply action lives in the expanded card')
    // 线程 thread-f：3 份投递副本折成一张卡片（×N 徽标折叠态可见），另一封信同组且按时间排在后面。
    assert.equal(html.match(/same letter body/g).length, 1, 'three delivery copies of one letter render as ONE card')
    assert.ok(html.includes('×3 copies'), 'the copy-count chip is visible on the collapsed card')
    assert.ok(html.includes('another letter in thread'), 'a different letter sharing the thread id is NOT folded away')
    assert.ok(html.indexOf('same letter body') < html.indexOf('a different letter'), 'letters inside a thread run oldest-first')
    // 不同线程分开；线程之间按首信时间正序（thread-f → standalone → mine → long）。
    assert.ok(html.indexOf('a different letter') < html.indexOf('own thread'), 'threads sort by first-letter time')
    assert.ok(html.indexOf('own thread') < html.indexOf('from this workspace'), 'a letter without a thread id is its own thread')
    // 回复树：无 reply_to 的信兜底挂到线程根下（嵌套子树容器），非根卡挂节点圆点。
    assert.ok(html.includes('m9-tree-children'), 'letters without reply_to nest under the thread root')
    assert.ok(html.includes('m9-tl-node'), 'nested cards hang a node dot on the connector line')
    assert.ok(html.includes('2 letters'), 'the thread head shows its letter count')
    assert.ok(html.includes('Expand all'), 'per-thread expand-all is offered')
    // 自己发的信折叠态也有区分标记。
    assert.ok(html.includes('Sent by this workspace'), 'own letters carry the me marker')
    // 超长正文折叠后连预览都只有 ~120 字符，尾巴当然不出现。
    assert.ok(!html.includes('TAIL_END_MARKER'), 'collapsed long letter shows only a short preview')

    // 展开态：SSR 没有事件，直接渲染导出的 LetterCard 验证两个层级。
    const longRow = store.getState().groupArchive.find((entry) => entry.message_id === 'f7')
    const cardProps = {
      message: longRow, copies: 1, depth: 0, mine: false,
      childrenCount: 0, descendants: 0, childrenOpen: true,
      onToggleChildren: () => {}, onToggleOpen: () => {}, onToggleFull: () => {}, onReply: () => {},
    }
    const openCard = renderToStaticMarkup(React.createElement(client.LetterCard, { ...cardProps, open: true, full: false }))
    assert.ok(openCard.includes('m9-md'), 'expanded card renders the markdown body')
    assert.ok(openCard.includes('m9-letter-md'), 'archive markdown carries the overflow-safe scoped class')
    assert.ok(!openCard.includes('TAIL_END_MARKER'), 'long body stays clamped at 2000 chars')
    // clamp 保留换行（不是 truncate 压平）：标题和表格在截断后仍然渲染。
    assert.ok(openCard.includes('<h2'), 'clamped body keeps the markdown heading (newlines preserved)')
    assert.ok(openCard.includes('<table>'), 'clamped body keeps the markdown table (newlines preserved)')
    assert.ok(openCard.includes('Show full text'), 'clamp offers an expander')
    assert.ok(openCard.includes('Reply</button>'), 'expanded card has the reply action')
    const fullCard = renderToStaticMarkup(React.createElement(client.LetterCard, { ...cardProps, open: true, full: true }))
    assert.ok(fullCard.includes('TAIL_END_MARKER'), 'show-full reveals the tail')
    assert.ok(fullCard.includes('Show less'), 'and offers to collapse back')
    // 宽表格信：markdown 表格照常渲染，滚动由 .m9-letter-md table 规则兜住（上面已断言注入）。
    const tableRow = store.getState().groupArchive.find((entry) => entry.message_id === 'f8')
    const tableCard = renderToStaticMarkup(React.createElement(client.LetterCard, { ...cardProps, message: tableRow, open: true, full: false }))
    assert.ok(tableCard.includes('<table>'), 'markdown table renders')
    assert.ok(tableCard.includes('m9-letter-md'), 'and sits inside the overflow-safe container')

    // 回复链路：reply_to 闭环、correlation_id 原样随行；存档行不带
    // list_address 时回退到组地址（与 handler 里 `message.list_address ?? groupAddress` 一致）。
    const row = store.getState().groupArchive.find((entry) => entry.message_id === 'f4')
    store.replyTo({ ...row, list_address: row.list_address ?? 'team-x@dsh.msg9.io' })
    assert.equal(store.getState().compose.to, 'team-x@dsh.msg9.io', 'archive reply targets the group')
    assert.equal(store.getState().compose.replyTo, 'f4', 'reply_to = the letter id')
    assert.equal(store.getState().compose.correlationId, 'thread-f', 'thread id rides verbatim')
    const bare = { message_id: 'f9', from_address: 'boss@msg9.io', correlation_id: 'thread-f' } // 无 list_address 的存档行
    store.replyTo({ ...bare, list_address: bare.list_address ?? 'team-x@dsh.msg9.io' })
    assert.equal(store.getState().compose.to, 'team-x@dsh.msg9.io', 'rows without list_address fall back to the group address')
  } finally {
    fanoutArchive = false
  }
})

await check('groups archive: reply_to builds a nested reply tree (copies resolve to their letter)', async () => {
  treeArchive = true
  try {
    // 纯函数层：建树规则——根=最早无 reply_to 信；副本 id 映射到信；兜底挂根。
    // （按真实折叠喂数据：t1a/t1b/t1c 是同一封信的 3 份副本，合并为一封。）
    const rows = treeLetters.filter((row) => row.correlation_id === 'thread-t')
    const letters = [
      { message: rows[0], copies: 3, ids: ['t1a', 't1b', 't1c'] },
      ...rows.slice(3).map((row) => ({ message: row, copies: 1, ids: [row.message_id] })),
    ]
    const indexNodes = (node) => {
      const map = new Map()
      const walk = (n) => { map.set(n.letter.message.message_id, n); for (const c of n.children) walk(c) }
      walk(node)
      return map
    }
    const direct = client.buildLetterTree(letters)
    assert.equal(direct.letter.message.message_id, 't1a', 'earliest reply_to-less letter is the root')
    assert.deepEqual(direct.children.map((node) => node.letter.message.message_id), ['t2', 't3', 't4', 't5'], 'children by time: direct reply, copy-targeted reply, orphan fallback, no-reply_to fallback')
    const nodes = indexNodes(direct)
    assert.equal(nodes.get('t3').children[0].letter.message.message_id, 't31', 'a reply to a reply nests one level deeper')
    assert.equal(direct.descendants, 5, 'the root counts every descendant')

    // 面板渲染：默认全部展开，嵌套层级与顺序可见。
    const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
    store.setCwd('/work/a')
    await store.refreshAll()
    store.setTab('groups')
    store.selectGroup('team-x@dsh.msg9.io')
    for (let i = 0; i < 50 && store.getState().groupArchive.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(store.getState().groupArchive.length, 9, 'store keeps every archived copy')

    const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
    const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
    // 根信 3 份副本折成一张卡（×3），reply_to 指向第 2 个副本的 t3 仍挂在根下。
    assert.equal(html.match(/root body/g).length, 1, 'three copies of the root fold into ONE card')
    assert.ok(html.includes('×3 copies'), 'root copy-count chip')
    const order = ['root body', 'reply one', 'reply two', 'reply two dot one', 'reply three', 'loose letter']
    for (let i = 1; i < order.length; i++) {
      assert.ok(html.indexOf(order[i - 1]) < html.indexOf(order[i]), `tree order: ${order[i - 1]} before ${order[i]}`)
    }
    // 层级锚点：根的子树容器 + t3 的子树容器（两级嵌套），t31 在第二个容器内。
    assert.equal(html.match(/m9-tree-children/g).length, 2, 'two nesting levels (root → replies → reply-of-reply)')
    const secondNest = html.indexOf('m9-tree-children', html.indexOf('reply two'))
    assert.ok(secondNest > html.indexOf('reply two') && secondNest < html.indexOf('reply two dot one'), 'reply-of-reply nests under its parent')
    // 另一个线程（无 correlation_id）独立成树。
    assert.ok(html.indexOf('loose letter') < html.indexOf('solo letter'), 'threads stay separate, sorted by root time')

    // 子树收起（SSR 无事件，直接渲染 LetterCard）：显示「N 条回复」，正文/子树动作分离。
    const rootRow = store.getState().groupArchive.find((entry) => entry.message_id === 't1a')
    const cardProps = {
      message: rootRow, copies: 3, depth: 0, mine: false,
      onToggleChildren: () => {}, onToggleOpen: () => {}, onToggleFull: () => {}, onReply: () => {},
    }
    const collapsed = renderToStaticMarkup(React.createElement(client.LetterCard, { ...cardProps, open: false, full: false, childrenCount: 4, descendants: 5, childrenOpen: false }))
    assert.ok(collapsed.includes('5 replies'), 'collapsed subtree shows the descendant count')
    assert.ok(collapsed.includes('Expand replies'), 'and the toggle offers to expand')
    const expanded = renderToStaticMarkup(React.createElement(client.LetterCard, { ...cardProps, open: false, full: false, childrenCount: 4, descendants: 5, childrenOpen: true }))
    assert.ok(!expanded.includes('5 replies'), 'expanded subtree hides the count badge')
    assert.ok(expanded.includes('Collapse replies'), 'the subtree toggle is separate from the body toggle')

    // 嵌套节点的正文照常走 markdown 管线。
    const nestedRow = store.getState().groupArchive.find((entry) => entry.message_id === 't31')
    const nestedCard = renderToStaticMarkup(React.createElement(client.LetterCard, { ...cardProps, message: nestedRow, copies: 1, depth: 2, childrenCount: 0, descendants: 0, childrenOpen: true, open: true }))
    assert.ok(nestedCard.includes('class="m9-md'), 'a deeply nested letter still renders markdown')
    assert.ok(nestedCard.includes('m9-tl-node'), 'and hangs its node dot on the connector line')
  } finally {
    treeArchive = false
  }
})

await check('inbox detail: opening a letter opens its whole conversation (Gmail thread)', async () => {
  threadInbox = true
  try {
    const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
    store.setCwd('/work/a')
    await store.refreshAll()
    for (let i = 0; i < 50 && store.getState().messages.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })

    // 点开 c1 → 会话 = 同 correlation_id 的 2 收 1 发（发的那封只在 outbox），时间正序。
    const readBefore = seen.read.length
    store.selectMessage('c1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const html = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
    assert.ok(html.includes('roadmap sync'), 'conversation subject shown')
    assert.ok(html.includes('3 in thread'), 'letter count in the header')
    // 顺序断言锚在会话详情区（中栏列表也带同样的主题/预览，会先命中）。
    const detail = html.slice(html.indexOf('3 in thread'))
    assert.ok(detail.indexOf('question one') < detail.indexOf('my question'), 'inbox letter before the outbox reply')
    assert.ok(detail.indexOf('my question') < detail.indexOf('answer two'), 'outbox reply before the final answer')
    // 我发的信带 mine 标记。
    assert.equal(html.match(/Sent by this workspace/g).length, 1, 'the outbox letter carries the me marker')
    // 默认展开最新 + 当前点开的（2 张 markdown 卡），中间那封折叠成头行预览。
    assert.equal(html.match(/class="m9-md /g).length, 2, 'seed + latest expanded, the middle letter collapsed to its header')
    assert.ok(html.includes('<strong>question one</strong>'), 'expanded seed renders markdown')
    assert.ok(html.includes('my question'), 'collapsed letter still shows its one-line preview')
    // 签名徽标与动作保留（最新一封已读且已验证签名）。
    assert.ok(html.includes('Signature verified'), 'signature badge on the expanded letter')
    assert.ok(html.includes('Mark handled'), 'mark-handled action on the expanded inbox letter')
    assert.ok(html.includes('Copy id'), 'copy-id action on the expanded letter')
    // 点开 = 会话里未读的都标已读：c2 本来就已读，只有 c1 触发 markRead。
    assert.deepEqual(seen.read.slice(readBefore), ['c1'], 'only the unread letters in the conversation get marked read')

    // 组副本 2 份：折成一张卡 ×2，回复走「回复组」。
    store.selectMessage('c4a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const group = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
    assert.ok(group.includes('1 in thread'), 'copies fold into one letter')
    assert.ok(group.includes('×2 copies'), 'copy-count chip preserved')
    assert.ok(group.includes('Reply to group'), 'group copies reply to the group')
    assert.ok(group.includes('group · team-x@dsh.msg9.io'), 'group tag on the card')

    // 无 correlation_id 的信：单封会话。
    store.selectMessage('c3')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const solo = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
    assert.ok(solo.includes('1 in thread'), 'no correlation_id → a conversation of one')
    assert.ok(solo.includes('other body'), 'and it renders expanded (seed = latest)')
  } finally {
    threadInbox = false
  }
})

await check('panel: a capped inbox/outbox says so instead of silently truncating', async () => {
  // 收发箱每页 50 封封顶：total 大于已加载数时，列表底部必须给出提示行。
  const fake = {
    overview: async () => ({
      owner: { id: 'own_1', name: 'fake' }, api_url: 'http://fake', state_file: '', current: null,
      workspaces: [{ key: 'ws-a', title: 'alpha', path: '/work/a', address: 'a@msg9.io', provisioned: true, cursor: null, current: false }],
    }),
    messages: async () => ({
      messages: [
        { message_id: 'm1', from_address: 'x@msg9.io', created_at: '2026-09-12T09:00:00Z' },
        { message_id: 'm2', from_address: 'y@msg9.io', created_at: '2026-09-12T09:01:00Z' },
      ],
      total: 57,
      unread_count: 0,
    }),
    outbox: async () => ({
      messages: [{ message_id: 'o1', from_address: 'a@msg9.io', to_address: 'x@msg9.io', created_at: '2026-09-12T09:00:00Z' }],
      total: 80,
    }),
    contacts: async () => ({ contacts: [], total: 0 }),
    unread: async () => ({ total: 0, byKey: {} }),
    peers: async () => ({ peers: [] }),
    groups: async () => ({ groups: [], total: 0 }),
  }
  const store = client.createMsg9Store({ bridge: fake, pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshOverview()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const useSessions = (selector) => selector({ current: 'sess-a', byId: { 'sess-a': { cwd: '/work/a' } } })
  const inboxHtml = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(inboxHtml.includes('Showing the first 2 of 57'), 'inbox cap hint shown')

  store.setTab('outbox')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const outboxHtml = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store, useSessions }))
  assert.ok(outboxHtml.includes('Showing the first 1 of 80'), 'outbox cap hint shown')

  // total 不超过已加载数时不显示（同一 fixture 把 total 调小验证）。
  const smallFake = { ...fake, messages: async () => ({ messages: [{ message_id: 'm1', from_address: 'x@msg9.io' }], total: 1, unread_count: 0 }) }
  const smallStore = client.createMsg9Store({ bridge: smallFake, pollMs: 10 ** 9 })
  smallStore.setCwd('/work/a')
  await smallStore.refreshOverview()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const smallHtml = renderToStaticMarkup(React.createElement(client.Msg9Panel, { store: smallStore, useSessions }))
  assert.ok(!smallHtml.includes('Showing the first'), 'no hint when everything fits')
})

await check('markdown links open in a new window (no webview hijack)', () => {
  // 面板跑在 webview 里：邮件内的 <a> 原地跳转会把整个 dsh 界面劫持走。
  // externalizeLinks 挂在 DOMPurify 的 afterSanitizeAttributes 钩子上（测试环境
  // 没有 DOM，DOMPurify 不净化，所以这里直接驱动钩子函数本身）。
  const attrs = {}
  client.externalizeLinks({ tagName: 'A', setAttribute: (name, value) => { attrs[name] = value } })
  assert.equal(attrs.target, '_blank')
  assert.equal(attrs.rel, 'noopener noreferrer')

  let touched = false
  client.externalizeLinks({ tagName: 'P', setAttribute: () => { touched = true } })
  assert.equal(touched, false, 'non-anchor elements are left alone')
})

await check('panel: root height sync targets the FIRST scrollable ancestor (no hard-coded host class)', () => {
  // 宿主实测结构：scrollBody(overflow-y:auto) ← 两层 height 为 0 的 wrapper ← root。
  // root 的 height:100% 解析不到有效高度，面板被宿主整体滚走；修法是把这个祖先的
  // clientHeight 同步成 root 的 px 高度。这里验证祖先查找：取最近的可滚动祖先，
  // 不是最远的，也不依赖 class 名。
  const page = { parentElement: null }
  const scrollBody = { parentElement: page }
  const wrapperB = { parentElement: scrollBody }
  const wrapperA = { parentElement: wrapperB }
  const root = { parentElement: wrapperA }
  const overflow = new Map([[scrollBody, 'auto'], [page, 'scroll']])
  const computed = (el) => ({ overflowY: overflow.get(el) ?? 'visible' })

  assert.equal(client.findScrollParent(root, computed), scrollBody, 'nearest scrollable ancestor wins')
  assert.equal(client.findScrollParent(root, () => ({ overflowY: 'visible' })), null, 'no scrollable ancestor → no sync')
  assert.equal(client.findScrollParent({ parentElement: null }, computed), null, 'detached root is a no-op')
})

await check('highlight: an unloaded grammar (```jsonc) degrades to plaintext instead of crashing the panel', async () => {
  // 真实事故：roadmap 组的信带 jsonc 代码块，getLanguage 对未加载语言直接
  // 抛 ShikiError，React 整树崩溃、页面空白。语言成员判定必须走
  // getLoadedLanguages()，未知语言回落纯文本。
  await client.highlightReady
  const html = client.highlightCode('{"a": 1}', 'jsonc')
  assert.ok(html.includes('{&quot;a&quot;: 1}') || html.includes('{"a": 1}'), 'content escaped, not highlighted')
  const known = client.highlightCode('const x = 1', 'typescript')
  assert.ok(known.includes('<span'), 'a loaded grammar still gets real highlighting')
})

await check('store: a successful send refreshes the outbox and the unread badge', async () => {
  // 发送没有 SSE 失效事件兜底：不主动刷新的话发件箱一直显示旧的缓存列表。
  const base = bridgeFetch()
  const hits = { outbox: 0, unread: 0 }
  const counting = async (url, init) => {
    const target = String(url)
    if (target.includes('/outbox')) hits.outbox += 1
    if (target.includes('/unread')) hits.unread += 1
    return base(url, init)
  }
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: counting }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const before = { ...hits }
  store.setCompose({ to: 'peer@msg9.io', text: 'flush the outbox cache' })
  await store.send()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.getState().notice.kind, 'ok')
  assert.ok(hits.outbox > before.outbox, 'outbox refetched after the send')
  assert.ok(hits.unread > before.unread, 'unread badge refetched after the send')
})

// ------------------------------------------------- first-run tenant binding

await check('bridge: setup verifies the tenant key and stores it', async () => {
  const KEY = 'msg9_tk_ui_1234567890'
  const { status, payload } = await call(`${BRIDGE_PREFIX}/setup`, { method: 'POST', body: { owner_key: KEY } })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.owner.id, 'own_ui')
  assert.equal(payload.data.owner.name, 'dsh-ui')
  // The browser must never see the key again — only its masked form.
  assert.equal(payload.data.owner.masked, 'msg9_tk_ui_…7890')
  assert.ok(!JSON.stringify(payload).includes('1234567890'), 'the raw key must not be echoed')
})

await check('bridge: setup rejects a key msg9 refuses', async () => {
  const { status, payload } = await call(`${BRIDGE_PREFIX}/setup`, { method: 'POST', body: { owner_key: 'nope' } })
  assert.equal(status, 400)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'owner-key-rejected')
})

await check('bridge: setup requires owner_key', async () => {
  const { status, payload } = await call(`${BRIDGE_PREFIX}/setup`, { method: 'POST', body: {} })
  assert.equal(status, 400)
  assert.equal(payload.error.code, 'missing-owner-key')
})

await check('store: bindOwner validates the key and reloads the panel', async () => {
  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  // A bad key surfaces as a setup error, not a crash.
  await store.bindOwner('nope')
  assert.equal(store.getState().setup.busy, false)
  assert.ok(store.getState().setup.error, 'rejected key is reported')

  // A good key binds, then refreshes everything (this path once crashed on a
  // bare `refreshAll()` that resolved to nothing inside the store object).
  await store.bindOwner('msg9_tk_ui_1234567890')
  assert.equal(store.getState().setup.error, null)
  assert.equal(store.getState().owner.name, 'dsh-ui')
  assert.equal(store.getState().status, 'ready')
  assert.ok(store.getState().workspaces.length > 0, 'overview reloaded after binding')
})

await check('first run: the setup view guides a newcomer through both paths', () => {
  const fakeState = { apiUrl: '', setup: { busy: false, error: null, dismissed: false } }
  const html = renderToStaticMarkup(React.createElement(client.SetupView, { state: fakeState, store: {} }))
  // Path A: the three steps to a tenant key, with its payoff.
  assert.ok(html.includes('Open msg9.io'), 'step 1: sign up')
  assert.ok(html.includes('create a tenant'), 'step 2: create a tenant')
  assert.ok(html.includes('msg9_tk_'), 'step 3: the key format')
  assert.ok(html.includes('looploop@you.msg9.io'), 'the short-address payoff')
  // Path B: skip-and-use anyway, with the trade-offs spelled out.
  assert.ok(html.includes('Skip for now'), 'skip path offered')
  assert.ok(html.includes('dsh-xxx-1a2b@msg9.io'), 'the public-registration address shape')
  assert.ok(html.includes('no key needed'), 'no account required for path B')
  assert.ok(html.includes('Settings'), 'bind-later pointer')
})

// ------------------------------------------------- tenant subdomain mode

await check('tenant mode: setup stores the slug and the preview drops the hash', async () => {
  const { status, payload } = await call(`${BRIDGE_PREFIX}/setup`, { method: 'POST', body: { owner_key: 'msg9_tk_slug_1234567890' } })
  assert.equal(status, 200)
  assert.equal(payload.data.owner.slug, 'vme')
  assert.equal(payload.data.owner.mail_domain, 'msg9.io')

  // cwd bucket "/work/t" -> slug "t": too short for msg9's 3-char minimum, so
  // the preview uses the deterministic `<slug>-<hash4>` fallback.
  const overview = await call(`${BRIDGE_PREFIX}/overview?cwd=%2Fwork%2Ft`)
  assert.equal(overview.payload.data.owner.slug, 'vme')
  assert.match(overview.payload.data.current.planned_address, /^t-[0-9a-f]{4}@vme\.msg9\.io$/)
})

await check('tenant mode: provisioning asks for the readable address first', async () => {
  const { payload } = await call(`${BRIDGE_PREFIX}/provision`, { method: 'POST', body: { cwd: '/work/t', title: 'tenantws' } })
  assert.equal(payload.data.provisioned, true)
  assert.ok(payload.data.address.startsWith('tenantws@'), payload.data.address)
  // No harness prefix: the tenant domain already says whose agent this is.
  assert.equal(seen.provisioned[seen.provisioned.length - 1], 'tenantws')
})

await check('tenant mode: a conflicting address falls back to the hashed form', async () => {
  const before = seen.provisioned.length
  const { payload } = await call(`${BRIDGE_PREFIX}/provision`, { method: 'POST', body: { cwd: '/work/taken', title: 'taken' } })
  assert.equal(payload.data.provisioned, true)
  const attempts = seen.provisioned.slice(before)
  assert.equal(attempts.length, 2, 'one conflict, one retry')
  assert.equal(attempts[0], 'taken')
  assert.match(attempts[1], /^taken-[0-9a-f]{4}$/)
  assert.ok(payload.data.address.startsWith('taken-'), payload.data.address)
})

await check('settings section offers migration for legacy inboxes', async () => {
  // ws-a's inbox predates the slug tenant: it must be flagged legacy, with a
  // migration target preview.
  const overview = await call(`${BRIDGE_PREFIX}/overview`)
  const row = overview.payload.data.workspaces.find((r) => r.key === 'ws-a')
  assert.equal(row.legacy, true)
  assert.equal(row.planned_address, 'alpha@vme.msg9.io')

  const store = client.createMsg9Store({ bridge: client.createBridge({ fetch: bridgeFetch() }), pollMs: 10 ** 9 })
  store.setCwd('/work/a')
  await store.refreshAll()
  const html = renderToStaticMarkup(React.createElement(client.Msg9SettingsSection, { store }))
  assert.ok(html.includes('Migrate to the new tenant'), html)
  assert.ok(html.includes('alpha@vme.msg9.io'), 'migration target preview')
})

await check('tenant migration: legacy inbox is re-provisioned and the old one suspended', async () => {
  const before = seen.provisioned.length
  const { status, payload } = await call(`${BRIDGE_PREFIX}/migrate`, {
    method: 'POST',
    body: { key: 'ws-a', old_owner_key: 'msg9_tk_ui_1234567890' },
  })
  assert.equal(status, 200)
  assert.equal(payload.data.old_address, 'dsh-alpha-1a2b@msg9.io')
  assert.ok(payload.data.new_address.startsWith('alpha@'), payload.data.new_address)
  assert.equal(payload.data.old_disabled, true)
  assert.equal(seen.provisioned[before], 'alpha', 'tenant-form address requested')
  assert.ok(seen.disabled.includes('dsh-alpha-1a2b@msg9.io'), 'old inbox suspended with the old key')

  // v1.9 order: forwarding first (old inbox's own key), then the history move.
  assert.equal(payload.data.forwarding, true)
  assert.equal(seen.forwarding.at(-1).target, payload.data.new_address)
  assert.ok(seen.forwarding.at(-1).auth.includes('msg9_sk_a'), 'forwarding uses the OLD inbox key')
  assert.equal(payload.data.moved_mail, 2)
  assert.deepEqual(seen.moveMail.at(-1), { address: 'dsh-alpha-1a2b@msg9.io', to: payload.data.new_address })

  // The state entry now points at the new inbox; old cursors did not survive.
  const state = JSON.parse(await readFile(process.env.MSG9_STATE_FILE, 'utf8'))
  assert.equal(state.workspaces['ws-a'].address, payload.data.new_address)
  assert.equal(state.workspaces['ws-a'].cursor, undefined)

  // Overview is clean again.
  const after = await call(`${BRIDGE_PREFIX}/overview`)
  assert.equal(after.payload.data.workspaces.find((r) => r.key === 'ws-a').legacy, false)
})

server.closeAllConnections?.()
server.close()

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0

// Undici pools the bridge's connections to the fake msg9 server, and those
// keep-alive sockets outlive the listener by seconds. The assertions are done,
// so end deterministically once stdout has flushed.
setTimeout(() => process.exit(process.exitCode ?? 0), 100)
