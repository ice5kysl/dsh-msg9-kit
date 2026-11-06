#!/usr/bin/env node
/**
 * The msg9 watcher daemon: one machine-wide process that owns every dsh
 * inbox's WebSocket watch, cursors, coalescing and delivery (the plugins are
 * only delivery targets). Safe to spawn repeatedly — a live, healthy daemon
 * makes this exit 0 immediately (see runDaemon in src/host/daemon/main.ts).
 *
 * The import is dynamic on purpose: this process is a **bare `node` child**
 * spawned from the plugin (no host module loader), and a bundle-level import
 * failure must leave a readable trace in daemon.log instead of dying with a
 * bare stack (v0.7.3 shipped exactly that: a static `@deepseek-ai/dsh-tools`
 * import inside lib/index.js killed the daemon on start).
 */
let runDaemon
try {
  ;({ runDaemon } = await import('../lib/index.js'))
} catch (error) {
  console.error(`msg9 watcher daemon: cannot load ../lib/index.js — ${error?.stack ?? String(error)}`)
  process.exit(1)
}

process.exitCode = await runDaemon()

