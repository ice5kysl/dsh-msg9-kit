#!/usr/bin/env node
/**
 * The msg9 watcher daemon: one machine-wide process that owns every dsh
 * inbox's WebSocket watch, cursors, coalescing and delivery (the plugins are
 * only delivery targets). Safe to spawn repeatedly — a live, healthy daemon
 * makes this exit 0 immediately (see runDaemon in src/host/daemon/main.ts).
 */
import { runDaemon } from '../lib/index.js'

process.exitCode = await runDaemon()
