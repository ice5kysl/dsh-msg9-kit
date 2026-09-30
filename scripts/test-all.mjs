#!/usr/bin/env node
/**
 * 跑全部测试套件，**一个都不跳过**。
 *
 * 为什么不用 `a && b && c`（原来的写法）：`&&` 链在**第一个**失败处就断，
 * 后面的套件根本没跑 —— 而输出的 `[ok]` 计数看起来仍然"有一堆通过"。
 * 2026-09-30 我正是因此把一次"79 项通过"当成了"其余也通过"，
 * **漏判了一整批失败**，并据此给你报了一个错误的现状。
 *
 * ⇒ 失败必须**一次看全**：每个套件都跑，最后给汇总。
 *
 * 用法：node scripts/test-all.mjs [suite ...]    （suite = tests/<name>.test.mjs 的 <name>）
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('用法：node scripts/test-all.mjs <suite-name> [...]')
  process.exit(2)
}

const failed = []
for (const name of names) {
  const file = fileURLToPath(new URL(`../tests/${name}.test.mjs`, import.meta.url))
  const started = Date.now()
  // stdio 直通：各套件自己的 `[ok]` / `[FAIL]` 原样可见，不吞日志
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) failed.push({ name, status: result.status ?? 'signal', seconds })
  else console.log(`—— ${name}: 通过（${seconds}s）`)
}

console.log('')
if (failed.length === 0) {
  console.log(`✅ ${names.length} 个套件全部通过`)
} else {
  console.log(`❌ ${failed.length}/${names.length} 个套件失败（其余已跑完，未被跳过）：`)
  for (const f of failed) console.log(`   - ${f.name}（退出码 ${f.status}，${f.seconds}s）`)
  process.exitCode = 1
}
