/**
 * Build script for dsh-msg9-kit.
 *
 * Host face:    src/host/index.ts   → lib/index.js   (ESM, node20)
 * Browser face: src/client/index.ts → lib/client.js  (CJS body inside the
 *               official `window.__ModuleLoader__.load({ id, factory })`
 *               envelope the dsh client module system serves over /plugins)
 *
 * The host build externalizes every bare specifier (the profile's node_modules
 * already provides @deepseek-ai/*) and bundles our own relative sources. The
 * browser build externalizes only the specifiers the module loader can resolve
 * at run time: the shell-seeded platform baseline (react and its jsx runtime).
 *
 * Run: `npm run build` (node 20+).
 */

import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Bare specifiers the browser factory may require. Everything here must be
 * satisfiable by the dsh client module system — react and react/jsx-runtime are
 * part of the shell-seeded platform baseline.
 */
const clientExternals = ['react', 'react/jsx-runtime']

async function main() {
  // ⚠️ **先构建到暂存目录，全部成功后才换上去**。
  //
  // 原实现是 `rm -rf lib` 再构建 —— 于是**构建一失败，lib/ 就空了**。
  // 而部署方（`~/.dsh/profiles/web/node_modules/dsh-msg9-kit`）是指向本仓的**符号链接**，
  // 直接吃我们的 `lib/` ⇒ **一次失败的构建会让正在跑的插件当场坏掉**。
  // （2026-09-30 我在做一次"蓄意破坏验证"时真踩到了：打了个语法错的补丁 →
  //  构建失败 → `lib/index.js` 消失 → 后续测试跑的是"没有产物"的状态。）
  //
  // 换法保留旧目录直到新目录就位：中途被打断时，老产物还在 `lib.previous/`
  // 可以手工挪回来（而不是凭空消失）。
  const live = join(root, 'lib')
  const stage = join(root, 'lib.staging')
  const previous = join(root, 'lib.previous')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // ---- host face ---------------------------------------------------------
  await build({
    entryPoints: [join(root, 'src/host/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: join(stage, 'index.js'),
    packages: 'external',
    logLevel: 'info',
  })

  // ---- browser face ------------------------------------------------------
  const head = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`
  const tail = `\n\t\treturn module.exports;\n\t}\n});\n`
  const bodyFile = join(stage, '.client.body.js')
  await build({
    entryPoints: [join(root, 'src/client/index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    // The browser face ships over /plugins on every dsh web load: keep it tight
    // (Shiki grammars dominate the size; minification more than halves them).
    minify: true,
    outfile: bodyFile,
    external: clientExternals,
    banner: { js: head },
    footer: { js: tail },
    logLevel: 'info',
  })

  writeFileSync(join(stage, 'client.js'), readFileSync(bodyFile, 'utf8'))
  rmSync(bodyFile, { force: true })

  // ---- 产物就位（到这里说明两面都构建成功）-------------------------------
  rmSync(previous, { recursive: true, force: true })
  if (existsSync(live)) renameSync(live, previous)
  renameSync(stage, live)
  rmSync(previous, { recursive: true, force: true })

  console.log('[build] lib/index.js + lib/client.js written')
}

main().catch((error) => {
  console.error(error)
  // 失败时**不动 lib/**（暂存目录里的半成品直接丢掉）
  rmSync(join(root, 'lib.staging'), { recursive: true, force: true })
  console.error('[build] 失败：lib/ 未被改动（旧产物仍在）')
  process.exitCode = 1
})
