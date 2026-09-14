/**
 * msg9 统一凭据仓（~/.msg9）迁移的回归测试 —— 覆盖：
 *
 *   - project-key 推导：git@/https remote、无 remote 回退、特殊字符清洗、冲突后缀
 *   - 迁移 happy path：旧 state.json → yaml 落位（0600/0700 权限）→ state 残留清空、热状态保留
 *   - 中途失败：注入写盘错误，旧字段保留、可重试
 *   - 锁竞争：两个进程并发迁移不互相覆盖
 *   - cwd: bucket 合一：registry 为准、cwd: 补位、marks 取较新、bucket 删除
 *   - 全量读路径：迁移前后 bridge 读到的 key 一致；overview 带 credentials_migrated
 *
 * 夹具仿真实 state.json 结构（registry uuid + cwd: bucket 混合）。
 * Run: node tests/credentials.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const root = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-creds-'))
process.env.MSG9_STATE_FILE = join(root, 'state.json')
process.env.MSG9_HOME = join(root, 'msg9-home')
delete process.env.MSG9_OWNER_KEY

const {
  BRIDGE_PREFIX,
  createMsg9Bridge,
  credentialsMigrated,
  defaultBridgeDeps,
  deriveProjectKey,
  ensureCredentialsMigrated,
  msg9Home,
  projectYamlPath,
  readProjectCredentials,
  readSigningSeed,
  resolveCredentials,
  resolveOwner,
  signingYamlPath,
  tenantKeyPath,
} = await import('../lib/index.js')

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

const writeState = async (state) => {
  await writeFile(process.env.MSG9_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}
const readState = async () => JSON.parse(await readFile(process.env.MSG9_STATE_FILE, 'utf8'))
const resetAll = async () => {
  await rm(msg9Home(), { recursive: true, force: true })
  await writeState({ workspaces: {} })
}
const modeOf = async (path) => (await stat(path)).mode & 0o777

/** 造一个带 git remote 的伪项目目录。 */
async function fakeProject(name, remoteUrl) {
  const path = join(root, 'projects', name)
  await mkdir(join(path, '.git'), { recursive: true })
  if (remoteUrl) {
    await writeFile(join(path, '.git', 'config'), `[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
  }
  return path
}

/** 仿真真实 state.json 的 legacy 结构（uuid bucket，字段与线上一致）。 */
function legacyInbox(overrides) {
  return {
    address: 'dsh-alpha-1a2b@msg9.io',
    api_key: 'msg9_sk_alpha',
    api_url: 'http://fake',
    title: 'alpha',
    path: '/work/alpha',
    cursor: 'C1',
    last_message_id: 'm8',
    watch_cursor: 'W1',
    watch_last_message_id: 'm9',
    watch_last_seen_at: '2026-09-13T02:00:00Z',
    last_wake_agent_id: 'sess-1',
    marks: { m1: { read_by: 'human', read_at: '2026-09-12T10:00:00Z', processed_by: 'agent', processed_at: '2026-09-12T11:00:00Z' } },
    signing_seed: 'c2VlZF9hbHBoYQ==',
    ...overrides,
  }
}

console.log('dsh-msg9-kit credentials test:')

// ----------------------------------------------------------- project-key 推导

await check('project-key: git@ 与 https remote 归一（github.com/acme/web → github-com-acme-web）', async () => {
  const scp = await fakeProject('scp-form', 'git@github.com:acme/web.git')
  assert.equal(await deriveProjectKey({ title: 'x', path: scp }), 'github-com-acme-web')
  const https = await fakeProject('https-form', 'https://github.com/acme/web.git')
  assert.equal(await deriveProjectKey({ title: 'x', path: https }), 'github-com-acme-web')
  const noSuffix = await fakeProject('no-suffix', 'https://github.com/acme/web')
  assert.equal(await deriveProjectKey({ title: 'x', path: noSuffix }), 'github-com-acme-web')
})

await check('project-key: 无 remote 回退为 目录名-sha256前6；特殊字符清洗', async () => {
  const bare = await fakeProject('my repo', undefined)
  const key = await deriveProjectKey({ title: 'x', path: bare })
  const hash = createHash('sha256').update(bare).digest('hex').slice(0, 6)
  assert.equal(key, `my-repo-${hash}`)

  const messy = await fakeProject('messy', 'https://GitHub.COM/Acme_Corp/Web.Repo.git')
  assert.equal(await deriveProjectKey({ title: 'x', path: messy }), 'github-com-acme_corp-web-repo')
})

// ------------------------------------------------------------- 迁移 happy path

await check('迁移 happy path：yaml 落位（0600/0700）→ state 残留清空、热状态保留', async () => {
  await resetAll()
  const pathA = await fakeProject('alpha', 'git@github.com:acme/web.git')
  const UUID = 'a1b2c3d4-5e6f-4a7b-8c9d-00000000000a'
  await writeState({
    owner: { api_key: 'msg9_tk_owner', api_url: 'http://fake', id: 'own_1', name: 'dsh', slug: 'vme', mail_domain: 'msg9.io', address_domain: 'vme.msg9.io' },
    workspaces: { [UUID]: legacyInbox({ path: pathA }) },
  })

  const resolved = await resolveCredentials(UUID, { listWorkspaces: () => [] })
  assert.equal(resolved.api_key, 'msg9_sk_alpha', '解析出的 key 与迁移前一致')
  assert.equal(resolved.address, 'dsh-alpha-1a2b@msg9.io')
  assert.equal(resolved.signing_seed, 'c2VlZF9hbHBoYQ==')

  // yaml 落位与字段
  const projectKey = resolved.project_key
  assert.equal(projectKey, 'github-com-acme-web')
  const creds = await readProjectCredentials(projectKey)
  assert.deepEqual(Object.keys(creds).sort(), ['address', 'api_key', 'api_url', 'created_at'])
  assert.equal(creds.api_key, 'msg9_sk_alpha')
  // 权限：文件 0600，目录链 0700
  assert.equal(await modeOf(projectYamlPath(projectKey)), 0o600)
  assert.equal(await modeOf(signingYamlPath(projectKey)), 0o600)
  assert.equal(await modeOf(tenantKeyPath()), 0o600)
  assert.equal(await modeOf(join(msg9Home(), 'projects', 'dsh')), 0o700)
  assert.equal(await modeOf(join(msg9Home(), 'tenants')), 0o700)
  assert.equal(await readFile(tenantKeyPath(), 'utf8'), 'msg9_tk_owner\n')
  assert.equal(await readSigningSeed(projectKey), 'c2VlZF9hbHBoYQ==')

  // state.json：任何 msg9_ key 与 signing_seed 不再出现；热状态保留
  const saved = await readState()
  const raw = JSON.stringify(saved)
  assert.ok(!raw.includes('msg9_sk_alpha') && !raw.includes('msg9_tk_owner') && !raw.includes('c2VlZF9hbHBoYQ=='), 'state.json 无任何明文凭据')
  const entry = saved.workspaces[UUID]
  assert.equal(entry.project_key, projectKey)
  assert.ok(entry.migrated_at, '记 migrated_at')
  assert.equal(entry.cursor, 'C1')
  assert.equal(entry.watch_cursor, 'W1')
  assert.equal(entry.watch_last_seen_at, '2026-09-13T02:00:00Z')
  assert.deepEqual(entry.marks.m1, { read_by: 'human', read_at: '2026-09-12T10:00:00Z', processed_by: 'agent', processed_at: '2026-09-12T11:00:00Z' })
  // owner 元数据（探测缓存）保留，明文 key 删除
  assert.equal(saved.owner.api_key, undefined)
  assert.equal(saved.owner.slug, 'vme')
  assert.equal(saved.owner.address_domain, 'vme.msg9.io')
  assert.equal((await resolveOwner()).api_key, 'msg9_tk_owner')
  assert.equal(await credentialsMigrated(), true)
})

await check('迁移幂等：新位置已存在则以凭据仓为准，不覆盖', async () => {
  await resetAll()
  const pathA = await fakeProject('alpha2', 'git@github.com:acme/web.git')
  const UUID = 'a1b2c3d4-5e6f-4a7b-8c9d-00000000000b'
  // 凭据仓里已有一份（另一个 harness/之前迁移写的）：它是准。
  await ensureCredentialsMigrated({ listWorkspaces: () => [] }) // 建目录
  await mkdir(join(msg9Home(), 'projects', 'dsh'), { recursive: true })
  await writeFile(projectYamlPath('github-com-acme-web'), 'address: real@msg9.io\napi_key: msg9_sk_real\napi_url: http://fake\ncreated_at: 2026-09-01T00:00:00Z\n', { mode: 0o600 })
  await writeState({ workspaces: { [UUID]: legacyInbox({ path: pathA }) } })

  const resolved = await resolveCredentials(UUID, { listWorkspaces: () => [] })
  assert.equal(resolved.api_key, 'msg9_sk_real', '凭据仓优先，state 残留不覆盖')
  const saved = await readState()
  assert.equal(saved.workspaces[UUID].api_key, undefined, '旧字段当残留删除')
  assert.equal(saved.workspaces[UUID].project_key, 'github-com-acme-web')
})

await check('中途失败（写盘错误）：旧字段保留、读路径不断、可重试', async () => {
  await resetAll()
  const pathA = await fakeProject('alpha3', 'git@github.com:acme/web.git')
  const UUID = 'a1b2c3d4-5e6f-4a7b-8c9d-00000000000c'
  await writeState({
    owner: { api_key: 'msg9_tk_owner', api_url: 'http://fake' },
    workspaces: { [UUID]: legacyInbox({ path: pathA }) },
  })
  // 注入写盘错误：projects 路径上放一个普通文件，mkdir 必失败。
  await mkdir(msg9Home(), { recursive: true })
  await writeFile(join(msg9Home(), 'projects'), 'blocker')

  const logs = []
  const resolved = await resolveCredentials(UUID, { listWorkspaces: () => [], log: (m) => logs.push(m) })
  assert.equal(resolved.api_key, 'msg9_sk_alpha', '迁移失败时退回旧字段，读路径不断')
  assert.ok(logs.some((m) => m.includes('legacy fields kept')), logs.join('\n'))
  const saved = await readState()
  assert.equal(saved.workspaces[UUID].api_key, 'msg9_sk_alpha', '旧字段保留（下次重试）')
  assert.equal(saved.owner.api_key, undefined, 'owner 不受 workspace 失败影响，已迁走')
  assert.equal(await credentialsMigrated(), false, '还有残留 → 未迁完')

  // 移除障碍后重试成功。
  await rm(join(msg9Home(), 'projects'))
  const retried = await resolveCredentials(UUID, { listWorkspaces: () => [] })
  assert.equal(retried.project_key, 'github-com-acme-web')
  assert.equal((await readState()).workspaces[UUID].api_key, undefined)
  assert.equal(await credentialsMigrated(), true)
})

await check('锁竞争：两个进程并发迁移不互相覆盖', async () => {
  await resetAll()
  const pathA = await fakeProject('alpha4', 'git@github.com:acme/web.git')
  const UUID = 'a1b2c3d4-5e6f-4a7b-8c9d-00000000000d'
  await writeState({ workspaces: { [UUID]: legacyInbox({ path: pathA }) } })
  const libPath = new URL('../lib/index.js', import.meta.url).pathname
  const child = spawn(process.execPath, [
    '--input-type=module', '-e',
    `const { ensureCredentialsMigrated } = await import(${JSON.stringify(`file://${libPath}`)}); await ensureCredentialsMigrated()`,
  ], { env: process.env, stdio: 'pipe' })
  let childErr = ''
  child.stderr.on('data', (chunk) => { childErr += chunk })
  // 父进程同时迁（文件锁串行化：一个真迁，另一个等到锁后变 no-op）。
  await ensureCredentialsMigrated({ listWorkspaces: () => [] })
  const code = await new Promise((resolve) => child.once('exit', resolve))
  assert.equal(code, 0, childErr)

  const creds = await readProjectCredentials('github-com-acme-web')
  assert.equal(creds.api_key, 'msg9_sk_alpha', 'yaml 内容完整且与夹具一致（无半写/覆盖）')
  const saved = await readState()
  assert.equal(saved.workspaces[UUID].api_key, undefined)
  assert.equal(saved.workspaces[UUID].project_key, 'github-com-acme-web')
})

// --------------------------------------------------------------- cwd: 合一

await check('cwd: 合一：registry 为准、cwd: 补位、marks 取较新、bucket 删除', async () => {
  await resetAll()
  const pathReg = await fakeProject('regproj', 'git@github.com:acme/reg.git')
  const registry = [{ key: 'ws-reg', title: 'reg', path: pathReg }]
  await writeState({
    workspaces: {
      // registry bucket：有自己的 key，marks 较旧；缺 cursor
      'ws-reg': {
        address: 'dsh-reg-9z8y@msg9.io', api_key: 'msg9_sk_reg', api_url: 'http://fake',
        title: 'reg', path: pathReg, watch_cursor: 'W-REG',
        marks: {
          m1: { read_by: 'human', read_at: '2026-09-10T10:00:00Z' },
        },
      },
      // cwd: bucket（同目录，registry 后补前的遗留）：不同的 key，marks 较新，带 cursor
      [`cwd:${pathReg}`]: {
        address: 'dsh-reg-old@msg9.io', api_key: 'msg9_sk_cwd', api_url: 'http://fake',
        title: 'reg', path: pathReg, cursor: 'C-CWD', watch_cursor: 'W-CWD',
        signing_seed: 'c2VlZF9jd2Q=',
        marks: {
          m1: { read_by: 'agent', read_at: '2026-09-12T10:00:00Z' },
          m2: { processed_by: 'agent', processed_at: '2026-09-12T12:00:00Z' },
        },
      },
    },
  })

  await ensureCredentialsMigrated({ listWorkspaces: () => registry })
  const saved = await readState()
  assert.equal(saved.workspaces[`cwd:${pathReg}`], undefined, 'cwd: bucket 已删除')
  const entry = saved.workspaces['ws-reg']
  assert.equal(entry.cursor, 'C-CWD', 'registry 缺的游标由 cwd: 补位')
  assert.equal(entry.watch_cursor, 'W-REG', 'registry 已有的游标不被覆盖')
  assert.deepEqual(entry.marks.m1, { read_by: 'agent', read_at: '2026-09-12T10:00:00Z' }, '同一字段取较新的')
  assert.deepEqual(entry.marks.m2, { processed_by: 'agent', processed_at: '2026-09-12T12:00:00Z' }, 'cwd: 独有的 mark 并入')

  // registry 的 key 为准：yaml 里是 msg9_sk_reg，cwd: 的 key 被丢弃。
  const creds = await readProjectCredentials(entry.project_key)
  assert.equal(creds.api_key, 'msg9_sk_reg')
  assert.equal(creds.address, 'dsh-reg-9z8y@msg9.io')
  // registry 没有签名种子 → 由 cwd: 补位
  assert.equal(await readSigningSeed(entry.project_key), 'c2VlZF9jd2Q=')
})

await check('cwd: 合一：registry 没有 bucket 时整个挪过去', async () => {
  await resetAll()
  const pathReg = await fakeProject('moveproj', 'git@github.com:acme/move.git')
  await writeState({
    workspaces: { [`cwd:${pathReg}`]: legacyInbox({ path: pathReg, api_key: 'msg9_sk_move' }) },
  })
  await ensureCredentialsMigrated({ listWorkspaces: () => [{ key: 'ws-move', title: 'move', path: pathReg }] })
  const saved = await readState()
  assert.equal(saved.workspaces[`cwd:${pathReg}`], undefined)
  assert.equal(saved.workspaces['ws-move'].project_key, 'github-com-acme-move')
  assert.equal((await readProjectCredentials('github-com-acme-move')).api_key, 'msg9_sk_move')
})

await check('project-key 冲突：同 key 不同 address，后到的加后缀并记日志', async () => {
  await resetAll()
  // 两个目录、同一个 remote（真实中不该发生：fork/重复克隆）→ 同 project-key。
  const pathA = await fakeProject('fork-a', 'git@github.com:acme/web.git')
  const pathB = await fakeProject('fork-b', 'git@github.com:acme/web.git')
  await writeState({
    workspaces: {
      'ws-fork-a': legacyInbox({ path: pathA, address: 'dsh-a@msg9.io', api_key: 'msg9_sk_fa' }),
      'ws-fork-b': legacyInbox({ path: pathB, address: 'dsh-b@msg9.io', api_key: 'msg9_sk_fb' }),
    },
  })
  const logs = []
  await ensureCredentialsMigrated({ listWorkspaces: () => [], log: (m) => logs.push(m) })
  const saved = await readState()
  const keyA = saved.workspaces['ws-fork-a'].project_key
  const keyB = saved.workspaces['ws-fork-b'].project_key
  assert.equal(keyA, 'github-com-acme-web')
  assert.ok(keyB.startsWith('github-com-acme-web-'), keyB)
  assert.notEqual(keyA, keyB)
  assert.ok(logs.some((m) => m.includes('project-key conflict')), logs.join('\n'))
  assert.equal((await readProjectCredentials(keyA)).api_key, 'msg9_sk_fa')
  assert.equal((await readProjectCredentials(keyB)).api_key, 'msg9_sk_fb')
})

// ------------------------------------------------------------- 全量读路径

await check('全量读路径：迁移前后 bridge 读到的 key 一致；overview 带 credentials_migrated', async () => {
  await resetAll()
  const pathA = await fakeProject('bridge-proj', 'git@github.com:acme/web.git')
  const UUID = 'a1b2c3d4-5e6f-4a7b-8c9d-00000000000e'
  const auths = []
  const server = createServer((req, res) => {
    auths.push(req.headers.authorization)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { messages: [], total: 0, unread_count: 0 } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await writeState({
      owner: { api_key: 'msg9_tk_bridge_123456', api_url: apiUrl, slug: null, address_domain: null },
      workspaces: { [UUID]: legacyInbox({ path: pathA, api_url: apiUrl, signing_seed: undefined }) },
    })
    const host = {
      logger: () => ({ info: () => {} }),
      sessions: { get: () => undefined },
      workspaceRegistry: { list: () => [{ id: UUID, title: 'alpha', path: pathA }] },
    }
    const bridge = createMsg9Bridge(defaultBridgeDeps(host))
    const call = (path) => new Promise((resolve) => {
      const req = {
        method: 'GET', url: path, headers: { host: '127.0.0.1:3080' },
        on() {},
        async *[Symbol.asyncIterator]() {},
      }
      const res = {
        status: 0, body: '',
        on() {},
        writeHead(status) { res.status = status },
        write() {},
        end(text) { res.body = text },
      }
      void bridge.handle(req, res).then(() => resolve({ status: res.status, payload: JSON.parse(res.body) }))
    })

    // 第一次读：触发惰性迁移（还顺带装了签名 key）；上游看到的仍是夹具里的原始 key。
    const page1 = await call(`${BRIDGE_PREFIX}/messages?key=${UUID}`)
    assert.equal(page1.status, 200)
    assert.ok(auths.length >= 1 && auths.every((auth) => auth === 'Bearer msg9_sk_alpha'), JSON.stringify(auths))
    assert.equal((await readState()).workspaces[UUID].api_key, undefined, 'state 已无 key')

    // 第二次读：从凭据仓 yaml 取，key 一致。
    auths.length = 0
    const page2 = await call(`${BRIDGE_PREFIX}/messages?key=${UUID}`)
    assert.equal(page2.status, 200)
    assert.deepEqual(auths, ['Bearer msg9_sk_alpha'], '凭据仓读出的 key 与迁移前一致')

    const overview = await call(`${BRIDGE_PREFIX}/overview`)
    assert.equal(overview.payload.data.credentials_migrated, true, 'overview 透传迁移标志')
    assert.equal(overview.payload.data.workspaces.find((row) => row.key === UUID).address, 'dsh-alpha-1a2b@msg9.io')
    assert.equal(overview.payload.data.owner.masked.startsWith('msg9_tk_bri…'), true)
  } finally {
    server.close()
  }
})

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
