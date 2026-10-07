#!/usr/bin/env node
// 只读观测：平台 daemon 健康 + 账本/游标状态 + 锁与自研 watcher 存活。
// 每行一条追加到 ~/.dsh/msg9-observe.log。**不写任何 ~/.msg9/**，不投递、不发信。**
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 自我保护：观测者绝不能被被观测对象拖死（本机实测：同一个脚本在 launchd 下曾经卡住不退出）。
// 5s 后无论如何退出，并把「超时」这件事**写进日志**——静默超时等于没观测。
setTimeout(() => {
  try {
    fs.appendFileSync(path.join(os.homedir(), '.dsh', 'msg9-observe.log'),
      `${new Date().toISOString()} OBSERVE-TIMEOUT 5s（读数过程中被阻塞，已强制退出）\n`)
  } catch { /* 连日志都写不了就只能放弃 */ }
  process.exit(0)
}, 5000).unref()

const home = os.homedir()
const msg9 = path.join(home, '.msg9')
const spool = path.join(msg9, 'spool')
const parts = []

// ① 平台 daemon 健康（两个正交轴：进程活没活 / 每个连接 up 没 up）
try {
  const d = JSON.parse(fs.readFileSync(path.join(spool, '.daemon-status.json'), 'utf8'))
  const beat = Math.round((Date.now() - Date.parse(d.last_beat)) / 1000)
  const t = Array.isArray(d.tenants) ? d.tenants : []
  const disc = t.filter((x) => x.connected === false).map((x) => x.tenant)
  const stalled = t.filter((x) => x.stalled).map((x) => x.tenant)
  parts.push(
    `daemon pid=${d.pid} beat=${beat}s tenants=${t.length} connected=${t.filter((x) => x.connected).length}` +
      ` stalled=${stalled.length}${disc.length ? ` disconnected=[${disc.join(',')}]` : ''}`,
  )
} catch (e) {
  parts.push(`daemon status=UNREADABLE(${e.code || e.message})`)
}

// ② 账本与消费者游标（游标文件数应恒为 0：我们的账本消费者还没上过岗）
try {
  const files = fs.readdirSync(spool)
  const ledgers = files.filter((f) => f.endsWith('.jsonl'))
  const cursors = files.filter((f) => f.endsWith('.cursor'))
  let newest = 0
  for (const f of ledgers) {
    const m = fs.statSync(path.join(spool, f)).mtimeMs
    if (m > newest) newest = m
  }
  parts.push(
    `ledgers=${ledgers.length} cursors=${cursors.length} last_ledger_write=${newest ? `${Math.round((Date.now() - newest) / 60000)}m ago` : 'never'}`,
  )
} catch (e) {
  parts.push(`spool status=UNREADABLE(${e.code || e.message})`)
}

// ③ 平台 scope 锁里的 pid 真的活着吗（死 pid ⇒ daemon 已不在）
try {
  for (const f of fs.readdirSync(msg9).filter((x) => x.startsWith('daemon.lock.'))) {
    const pid = Number(fs.readFileSync(path.join(msg9, f), 'utf8').trim())
    let alive = false
    try { process.kill(pid, 0); alive = true } catch (e) { alive = e.code === 'EPERM' }
    parts.push(`lock ${f} pid=${pid} alive=${alive}`)
  }
} catch { /* 没有锁目录就跳过 */ }

// ④ 自研 watcher 的记录文件在不在（内容指向死 pid 时会被消费方当"没有"）
parts.push(`self_watcher=${fs.existsSync(path.join(home, '.dsh', 'msg9-daemon', 'daemon.json')) ? 'present' : 'absent'}`)

const line = `${new Date().toISOString()} ${parts.join(' | ')}`
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
fs.appendFileSync(path.join(home, '.dsh', 'msg9-observe.log'), `${line}\n`)
process.stdout.write(`${line}\n`)
