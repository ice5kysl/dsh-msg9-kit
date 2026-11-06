/**
 * 回归测试：watcher daemon 必须能在**没有宿主模块注入**的裸 node 子进程里加载产物。
 *
 * 背景（v0.7.3，2026-11-06 现场报告 dsh-2 @ dsh.ice pod）：
 * lib/index.js 顶层静态 `import { defineTool } from '@deepseek-ai/dsh-tools'`，
 * 而该包只是 **devDependency**——宿主进程会把它注入插件，所以 13 个 msg9_* 工具
 * 全正常；但 daemon 是插件 `spawn(process.execPath, [bin])` 出来的**裸 node 子进程**
 * （`bin/msg9-watcher-daemon.mjs` → `../lib/index.js`），没有宿主的模块解析，
 * 于是启动即崩：
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools'
 *       imported from .../dsh-msg9-kit/lib/index.js
 *
 * 后果：daemon.json 从未生成、WebSocket 唤醒静默全挂，而工具面看起来一切正常。
 *
 * 本测试复现子进程的解析环境：把产物拷到**没有 node_modules 的临时目录**再 import。
 * 覆盖：① 产物顶层不许有裸静态 import；② 冷目录里能 import；③ bin 能真正拉起 daemon。
 *
 * Run: node tests/daemon-boot.test.mjs (or: npm test)
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const bundlePath = join(root, 'lib', 'index.js')
const binPath = join(root, 'bin', 'msg9-watcher-daemon.mjs')

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error?.message ?? String(error)}`)
  }
}

const isBare = (spec) => !spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('file:')

await check('① lib/index.js 顶层没有裸静态 import（只有 node: 内置/相对路径）', async () => {
  const source = await readFile(bundlePath, 'utf8')
  const specs = []
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?:[^'"\n]*?\sfrom\s*)?["']([^"']+)["']/gm)) {
    specs.push(match[1])
  }
  const bare = specs.filter(isBare)
  assert.deepEqual(bare, [], `顶层静态 import 里有宿主包：${bare.join(', ')}`)
})

await check('② 没有 node_modules 的冷目录里，裸 node 能 import 产物', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-daemon-boot-'))
  try {
    // 只拷产物本身：临时目录的祖先链里没有 node_modules，复现 daemon 子进程的解析环境。
    await cp(bundlePath, join(dir, 'index.js'))
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(`file://${join(dir, 'index.js')}`)}); console.log('import-ok')`,
      ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`退出码 ${code}: ${stderr.trim().split('\n').slice(0, 6).join(' / ')}`))
        else resolve(stdout)
      })
    })
    assert.match(output, /import-ok/, '产物应能加载')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('③ bin 入口在同款冷目录里能真正拉起 daemon（而不是启动即崩）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-msg9-kit-daemon-run-'))
  const home = join(dir, 'home')
  const msg9Home = join(dir, 'msg9')
  const daemonHome = join(dir, 'daemon-home')
  try {
    // 保持真实布局：lib/index.js + bin/msg9-watcher-daemon.mjs（bin 里是 '../lib/index.js'）
    await mkdir(join(dir, 'lib'), { recursive: true })
    await mkdir(join(dir, 'bin'), { recursive: true })
    await cp(bundlePath, join(dir, 'lib', 'index.js'))
    await cp(binPath, join(dir, 'bin', 'msg9-watcher-daemon.mjs'))
    const started = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir, 'bin', 'msg9-watcher-daemon.mjs')], {
        cwd: dir,
        env: {
          ...process.env,
          HOME: home,
          MSG9_HOME: msg9Home,
          MSG9_DAEMON_HOME: daemonHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`15s 内没有启动完成；stdout=${stdout.trim().slice(-300)} stderr=${stderr.trim().slice(-300)}`))
      }, 15_000)
      const finish = (ok, error) => {
        clearTimeout(timer)
        child.kill('SIGTERM')
        if (ok) resolve(stdout)
        else reject(error)
      }
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (/watcher daemon up/i.test(stdout)) finish(true)
      })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => {
        if (code !== 0) finish(false, new Error(`退出码 ${code}: ${stderr.trim().slice(-300)}`))
      })
    })
    assert.match(started, /watcher daemon up/i, 'daemon 应打印启动行')
    // 启动后必须真的发布 daemon.json（老代码从未走到这一步）
    const state = await readFile(join(daemonHome, 'state.json'), 'utf8').catch(() => '')
    assert.ok(state.length > 0, 'daemon 应写出 state.json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log(failed > 0 ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed > 0 ? 1 : 0
