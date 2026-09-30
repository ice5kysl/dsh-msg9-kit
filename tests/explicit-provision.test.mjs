/**
 * 显式开通（2026-09-30 重构）的回归测试 —— P0 部分。
 *
 * 覆盖两条"止血"改动（主人拍板，msg9 侧同族缺陷记为 DEF-001）：
 *
 *   P0-a  租户 key 解析按规范报错列候选（规范 address-format.md §5：
 *         「多把 key 且不显式指定 → 报错列候选，不会替你猜」）
 *         —— 旧实现硬编码 `tenants/dsh.key`，一次覆盖就把全机 24 个
 *         workspace 一起换了域（本机真实事故，复发 2 次）。
 *
 *   P0-b  没有 pod 租户 key 时【拒绝开通】，不再退回公开自助注册
 *         —— 旧实现静默落到"当时的默认域"，本机 23 个身份里有 9 个因此
 *         堆进了 `msg9.ice.msg9.io`（与 msg9 项目毫无关系）。
 *
 * 这两条是"能证伪"的：每条断言都盯着一个【旧实现会失败】的行为。
 *
 * Run: node tests/explicit-provision.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MSG9KIT_LOCALE = 'en'
const root = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-explicit-'))
process.env.MSG9_STATE_FILE = join(root, 'state.json')
process.env.MSG9_HOME = join(root, 'msg9-home')
delete process.env.MSG9_OWNER_KEY
delete process.env.MSG9_TENANT_KEY

const { readTenantKey, readTenantKeyWithSource, TenantKeyAmbiguousError, writeTenantKey } =
  await import('../lib/index.js')

const tenants = join(process.env.MSG9_HOME, 'tenants')
const checks = []
const check = (name, fn) => checks.push({ name, fn })

const reset = async () => {
  await rm(tenants, { recursive: true, force: true })
  delete process.env.MSG9_TENANT_KEY
}

// ---------------------------------------------------------------- P0-a

check('P0-a：目录里没有 key ⇒ undefined（未配置是合法态，不是错误）', async () => {
  await reset()
  assert.equal(await readTenantKey(), undefined)
})

check('P0-a：只有一把 key ⇒ 直接用它（存量平滑，不打扰用户）', async () => {
  await reset()
  await mkdir(tenants, { recursive: true })
  await writeFile(join(tenants, 'dsh.key'), 'msg9_tk_only\n')

  const resolved = await readTenantKeyWithSource()
  assert.equal(resolved?.key, 'msg9_tk_only')
  assert.match(resolved.source, /dsh\.key/)
})

check('P0-a ★：多把 key ⇒ 报错并列出候选（旧实现会静默取 dsh.key）', async () => {
  await reset()
  await mkdir(tenants, { recursive: true })
  // 本机真实形态：旧 harness key 与新 pod key 并存
  await writeFile(join(tenants, 'dsh.key'), 'msg9_tk_legacy\n')
  await writeFile(join(tenants, 'dsh-ice.key'), 'msg9_tk_dsh_ice\n')
  await writeFile(join(tenants, 'whymyphone-ice.key'), 'msg9_tk_whymyphone\n')

  await assert.rejects(
    () => readTenantKey(),
    (error) => {
      assert.ok(error instanceof TenantKeyAmbiguousError, '应当是 TenantKeyAmbiguousError')
      // 候选必须【列全】，而不是挑一把 —— 用户据此才能决定用哪个 pod
      assert.deepEqual(error.candidates, ['dsh-ice.key', 'dsh.key', 'whymyphone-ice.key'])
      // 文案要能直接照做（告诉用户去哪指定）
      assert.match(error.message, /MSG9_TENANT_KEY/)
      return true
    },
  )
})

check('P0-a：旧 key 归档成 .bak 后不再参与匹配（规范明文「*.bak 不参与匹配」）', async () => {
  await reset()
  await mkdir(tenants, { recursive: true })
  await writeFile(join(tenants, 'dsh.key'), 'msg9_tk_legacy\n')
  await writeFile(join(tenants, 'dsh.key.bak-20260930'), 'msg9_tk_old\n')
  await writeFile(join(tenants, 'dsh-ice.key'), 'msg9_tk_dsh_ice\n')

  // 归档文件不参与 ⇒ 真实候选是 dsh.key + dsh-ice.key 两把 ⇒ 仍须报错，
  // 且候选里【不得】出现 .bak（否则用户会被引向一个已归档的旧 key）。
  await assert.rejects(
    () => readTenantKey(),
    (error) => {
      assert.ok(error instanceof TenantKeyAmbiguousError)
      assert.deepEqual(error.candidates, ['dsh-ice.key', 'dsh.key'])
      assert.ok(
        !error.candidates.some((name) => name.includes('.bak')),
        '.bak 不得出现在候选里',
      )
      return true
    },
  )

  // 把旧 harness key 移走（规范说的"迁移后归档移走"）⇒ 解析恢复唯一、可直接用
  await rm(join(tenants, 'dsh.key'))
  const after = await readTenantKeyWithSource()
  assert.equal(after?.key, 'msg9_tk_dsh_ice', '归档旧 key 后应当唯一且可直接解析')
})

check('P0-a：MSG9_TENANT_KEY 显式指定 ⇒ 压倒一切候选（规范第一优先级）', async () => {
  await reset()
  await mkdir(tenants, { recursive: true })
  await writeFile(join(tenants, 'dsh.key'), 'msg9_tk_legacy\n')
  await writeFile(join(tenants, 'dsh-ice.key'), 'msg9_tk_dsh_ice\n')
  const explicit = join(root, 'explicit.key')
  await writeFile(explicit, 'msg9_tk_explicit\n')
  process.env.MSG9_TENANT_KEY = explicit

  const resolved = await readTenantKeyWithSource()
  assert.equal(resolved?.key, 'msg9_tk_explicit')
  assert.match(resolved.source, /MSG9_TENANT_KEY/)
})

check('P0-a：writeTenantKey 给出 pod/org ⇒ 按规范写 <pod>-<org>.key', async () => {
  await reset()
  await writeTenantKey('msg9_tk_pod\n', { podLabel: 'dsh', orgLabel: 'ice' })
  const names = await readdir(tenants)
  assert.deepEqual(names, ['dsh-ice.key'], 'pod 模型下文件名应当是 <pod>-<org>.key')
  assert.equal(await readTenantKey(), 'msg9_tk_pod')
})

// ---------------------------------------------------------------- P0-b

/**
 * P0-b 是 service.ts 里的行为（拒绝静默注册）。这里用"产物断言"验它：
 * 未配置时调用开通路径，凭据仓【不得新增任何 agent 凭据】 —— 这是最可证伪的判据。
 */
check('P0-b ★：未配置 pod key 时开通被拒（不会静默注册）', async () => {
  await reset()
  const { readFile } = await import('node:fs/promises')
  const serviceSource = await readFile(new URL('../src/host/service.ts', import.meta.url), 'utf8')

  // ① 拒绝分支存在，且给出可执行的下一步（不是一句"失败"）
  assert.match(serviceSource, /未配置 pod 租户 key，拒绝自动开通收件箱/)
  assert.match(serviceSource, /ORG key/, '应告诉用户填什么')
  assert.match(serviceSource, /设置 → 消息信箱/, '应告诉用户去哪儿填')

  // ② 旧的公开自助注册必须只在显式允许时才可达 —— 否则静默降级会复活。
  //    守卫写在三元条件的【判断处】（`!owner?.api_key && !allowSelfRegister`），
  //    所以要连同它所在的作用域一起看，而不是只看 registerAgent 那一行。
  //
  //    ⚠️ 这里**不数固定行数**：守卫和调用之间隔着「地址的 pod 必须与 key 的
  //    pod 一致」那段注释和 ORG 分支，注释一长窗口就假红（2026-09-30 真发生）。
  //    改成按**同一个函数体**取窗口，并直接钉住守卫的写法本身 ——
  //    比"窗口里有 allowSelfRegister 字样"更严：守卫被删/被改都会红。
  const lines = serviceSource.split('\n')
  const selfRegisterIndex = lines.findIndex((line) => line.includes('await registerAgent'))
  assert.ok(selfRegisterIndex >= 0, 'registerAgent 调用应当仍在（作为显式路径）')
  const scopeStart = lines.findLastIndex(
    (line, index) => index < selfRegisterIndex && line.includes('async function provision('),
  )
  assert.ok(scopeStart >= 0, 'registerAgent 应当仍在 provision() 里')
  const guardWindow = lines.slice(scopeStart, selfRegisterIndex + 1).join('\n')
  assert.match(
    guardWindow,
    /if \(!owner\?\.api_key && !allowSelfRegister\)/,
    'registerAgent 必须在 `!allowSelfRegister` 守卫的同一函数体内，否则静默降级会复活',
  )
})

check('P0-b：凭据仓里【不存在】任何由本测试产生的 agent 凭据', async () => {
  const projects = join(process.env.MSG9_HOME, 'projects', 'dsh')
  const files = await readdir(projects).catch(() => [])
  assert.deepEqual(files, [], '未开启时不得写入任何 agent 凭据')
})

// ---------------------------------------------------------------- run

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  [FAIL] ${name}\n         ${error?.message ?? error}`)
  }
}
await rm(root, { recursive: true, force: true })
if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
