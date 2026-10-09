/**
 * 多宿主消费同一信箱：**在场登记**（永远开）+ **跨进程互斥**（显式开关，T-73）。
 *
 * ## 为什么要有这个文件
 *
 * T-67 用真实数据查明了现场那条 2:1：`dsh web`（pid 54271）与 Desktop 宿主
 * （pid 74139）**都**加载本插件、**都**是 `ingest: ledger`，各自起一个账本消费者，
 * 读**同一个** `spool/<address>.<consumer>.cursor`，而游标的「读 → 投递 → 写」
 * 没有任何跨进程互斥 ⇒ 两边都把同一条事件判成"新鲜"，各自唤醒**自己进程里的会话**。
 *
 * PO 的裁决（2026-10-09）：**默认什么都不改** —— 不引入互斥。理由是互斥会把
 * **可见的重复**换成**不可见的漏叫**：人在 A 宿主的会话里看着，信却只叫醒了 B 宿主，
 * 那一侧的人不会被叫，而这种失效比重复通知更难发现。**默认选"重复但不漏"。**
 *
 * 所以这里提供两件事：
 *   1. **在场登记**（`presence`，两种模式都写）：让 `msg9_status` 能回答
 *      "现在有几个宿主在消费同一个信箱" —— 这是本卡的另一半价值，且它**不改行为**；
 *   2. **跨进程互斥**（`lock`，只有 `singleHostConsumer` 开着才用）：`O_EXCL` 锁文件
 *      + **死 pid 自愈**（`store.ts` 的 `state.json` 锁是同款先例）。拿不到锁的进程
 *      **这一轮不消费**，并把这件事**记进观测行**（`decision=skipped-lock-holder=<pid>`）
 *      —— 让"为什么这次没叫我"可查；这是该开关**唯一的安全网**，不是可选项。
 *
 * 三条纪律：
 *   · **绝不写 `~/.msg9/**`**：登记与锁都落在**我们自己的状态目录**（`state.json` 同级
 *     的 `consumers/`），游标文件仍然只有账本消费者写；
 *   · **绝不空等**：拿不到锁就当轮跳过，下一个 tick 再来 —— 消费循环是定时器驱动的，
 *     阻塞一个 REST 长尾去等锁只会把两条唤醒路径又叠在一起；
 *   · **默认路径零副作用**：`singleHostConsumer=false` 时除了写一份在场登记，
 *     行为与改前逐字一致（不读锁、不建锁、不删锁）。
 *
 * ## 为什么登记要有 `instance`，而不只是 `pid`
 *
 * "有几个宿主在消费"在生产里 == "有几个 pid"（一个进程对一个地址只有一个消费循环）。
 * 但**测试要在同一个进程里造两个宿主** —— 只按 pid 记，两条循环会互相覆盖同一个文件，
 * 于是"两个宿主抢锁"这件事根本测不出来。所以登记按 **instance**（一个进程里针对一个
 * 地址的一个消费循环）分文件，同时**如实记下 pid**：判活看 pid，计数看 instance。
 * 生产里两者一一对应，读起来就是卡面要的"数有几个 pid 用同一个游标"。
 *
 * @module dsh-msg9-kit/consumers
 */

import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isPidAlive } from './cutover.ts'
import { stateFilePath } from './store.ts'

/**
 * 在场登记 / 锁的目录。
 *
 * **刻意与 `state.json` 同目录**（而不是 `~/.msg9/spool/`）：这是本插件自己的状态，
 * 不能污染平台 spool；同时测试只要 `MSG9_STATE_FILE` 指向临时目录就自动隔离。
 */
export function consumerRegistryDir(stateFile = stateFilePath()): string {
  return join(dirname(stateFile), 'consumers')
}

/**
 * 一个消费循环对某个信箱的**在场登记**。
 *
 * `role` 是关键字段：
 *   · `holder` —— 这个循环**正在消费**这个游标（默认模式下所有在场循环都是 holder，
 *     因为默认就是多宿主各消费一份 —— 那正是"重复但不漏"的来源）；
 *   · `waiter` —— 开关开着、但没拿到锁，**这一轮不消费**（`holderPid` 是持锁者）。
 * `msg9_status` 只数 `holder`，于是"有几个宿主在消费"和"开关有没有生效"是同一个口径。
 */
export interface ConsumerPresence {
  /** 一个进程里针对一个地址的一个消费循环（生产里与 `pid` 一一对应）。 */
  instance: string
  pid: number
  address: string
  consumer: string
  /** 这个循环消费的**游标文件**路径：同一个游标 = 同一个信箱的同一份消费位。 */
  cursor: string
  role: 'holder' | 'waiter'
  /** `role=waiter` 时：持锁者的 pid（拿不到就省略）。 */
  holderPid?: number
  at: string
}

const PRESENCE_HEARTBEAT_MS = 20_000
/** 锁的心跳超时：持锁者卡住（REST 长尾）也不会被无限期误判成"死了"。 */
export const CONSUMER_LOCK_STALE_MS = 120_000

function presencePath(dir: string, address: string, consumer: string, instance: string): string {
  return join(dir, `${address}.${consumer}.${instance}.json`)
}

function lockPathFor(dir: string, address: string, consumer: string): string {
  return join(dir, `${address}.${consumer}.lock`)
}

/**
 * 上一次**实际写下去**的 role（用来判断"要不要强制重写"）。
 *
 * 心跳节流（20s）会把 role 的变化一起吞掉：一个循环上一轮是 waiter、这一轮拿到了锁，
 * 若因为"刚写过"而跳过写入，`msg9_status` 就会看到一条过期的 `waiter`。
 * 所以 role 一变就**无视节流**立刻重写。
 */
const lastWritten = new Map<string, { at: number; role: ConsumerPresence['role'] }>()

async function writePresence(dir: string, entry: Omit<ConsumerPresence, 'at'>, now: number): Promise<void> {
  const path = presencePath(dir, entry.address, entry.consumer, entry.instance)
  const previous = lastWritten.get(path)
  if (previous && previous.role === entry.role && now - previous.at < PRESENCE_HEARTBEAT_MS) return
  const payload: ConsumerPresence = { ...entry, at: new Date(now).toISOString() }
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 })
    lastWritten.set(path, { at: now, role: entry.role })
  } catch {
    /* 登记是观测，写不进去也绝不打扰消费 */
  }
}

/** 循环停止时清掉自己的在场登记（陈旧登记只影响观测，但没必要留着）。 */
export async function clearConsumerPresence(input: {
  address: string
  consumer: string
  instance: string
  dir?: string
}): Promise<void> {
  const dir = input.dir ?? consumerRegistryDir()
  const path = presencePath(dir, input.address, input.consumer, input.instance)
  lastWritten.delete(path)
  await rm(path, { force: true }).catch(() => {})
}

/** 一个消费轮次的租约。`granted=false` ⇒ **这一轮绝不消费**。 */
export interface ConsumerLease {
  granted: boolean
  /** `granted=false` 时的持锁者 pid（读不到锁内容时省略）。 */
  holderPid?: number
  /** `open` = 开关关（不互斥）· `locked` = 拿到了锁 · `waiter` = 没拿到，本轮不消费。 */
  route: 'open' | 'locked' | 'waiter'
  release(): Promise<void>
}

export interface ConsumerLeaseOptions {
  address: string
  consumer: string
  /** 这个地址的消费者游标文件（互斥的**粒度**就是它）。 */
  cursor: string
  /** 这个消费循环的稳定标识（同一个循环每轮都传同一个值）。 */
  instance: string
  /** 开 = 跨进程互斥；关（默认）= 只登记在场，行为与改前逐字一致。 */
  singleHostConsumer: boolean
  dir?: string
  now?: () => number
}

async function readLockHolder(path: string): Promise<number | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => '')
  try {
    const pid = Number(JSON.parse(raw).pid)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * 锁算不算"陈旧的"（可以直接拆）。
 *
 * 两条判据，**死 pid 优先**（快路径，与 `store.ts` 的 `state.json` 锁同款）：
 *   ① 记的 pid 已经不在了 ⇒ 立刻拆（这正是"持锁者死掉 ⇒ 另一个能接手"）；
 *   ② 否则看 mtime 是否超出心跳超时（持锁者卡住但进程还在）。
 */
export async function isStaleConsumerLock(path: string, now: () => number = () => Date.now()): Promise<boolean> {
  let info
  try {
    info = await stat(path)
  } catch {
    return true // 正好被释放了，下一圈就能拿到
  }
  const holder = await readLockHolder(path)
  if (holder !== undefined && holder !== process.pid && !isPidAlive(holder)) return true
  return now() - info.mtimeMs > CONSUMER_LOCK_STALE_MS
}

/**
 * 拿本轮租约。
 *
 * 顺序刻意的：**先登记在场，再抢锁** —— 即使这一轮抢不到，`msg9_status` 也要看得见
 * "有这个宿主在场、它在等"。登记写失败（磁盘问题）不影响任何判断。
 *
 * 抢锁**只试两圈**（第一圈 + 拆掉陈旧锁后的一圈），失败就返回 `granted=false`：
 * 消费循环是定时器驱动的，空等只会让心跳更乱。锁**按轮持有**（tick 结束即释放）：
 * 临界区恰好是"读游标 → 投递 → 写游标"，也正是 T-67 那条 2:1 的窗口。
 */
export async function acquireConsumerLease(options: ConsumerLeaseOptions): Promise<ConsumerLease> {
  const dir = options.dir ?? consumerRegistryDir()
  const now = options.now ?? (() => Date.now())
  const noop = async (): Promise<void> => {}
  const base = {
    instance: options.instance,
    pid: process.pid,
    address: options.address,
    consumer: options.consumer,
    cursor: options.cursor,
  }

  if (!options.singleHostConsumer) {
    // 默认路径：只登记，不互斥 —— 与改前逐字一致（每个宿主都消费、都唤醒自己的会话）。
    await writePresence(dir, { ...base, role: 'holder' }, now())
    return { granted: true, route: 'open', release: noop }
  }

  const path = lockPathFor(dir, options.address, options.consumer)
  await mkdir(dir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ ...base, at: new Date(now()).toISOString() }))
      await handle.close()
      await writePresence(dir, { ...base, role: 'holder' }, now())
      return {
        granted: true,
        route: 'locked',
        release: async () => {
          // 只删**自己**写的锁：万一被误判陈旧而被别人抢走，别把别人的锁删了。
          const holder = await readLockHolder(path)
          if (holder === undefined || holder === process.pid) await rm(path, { force: true }).catch(() => {})
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStaleConsumerLock(path, now)) {
        await rm(path, { force: true }).catch(() => {})
        continue // 拆掉陈旧锁，下一圈重抢
      }
      const holderPid = await readLockHolder(path)
      await writePresence(dir, { ...base, role: 'waiter', ...(holderPid === undefined ? {} : { holderPid }) }, now())
      return { granted: false, route: 'waiter', ...(holderPid === undefined ? {} : { holderPid }), release: noop }
    }
  }
  // 第二圈还是 EEXIST（有人在这几毫秒里又抢到了）⇒ 当轮放弃，下一 tick 再来。
  const holderPid = await readLockHolder(path)
  await writePresence(dir, { ...base, role: 'waiter', ...(holderPid === undefined ? {} : { holderPid }) }, now())
  return { granted: false, route: 'waiter', ...(holderPid === undefined ? {} : { holderPid }), release: noop }
}

/** 一个信箱当前被谁在消费（`msg9_status` 的判据）。 */
export interface ConsumerShape {
  /** 游标文件路径（互斥与统计的粒度）。 */
  cursor: string
  /** 正在**消费**这个游标的宿主（`role=holder`），按 pid 升序。 */
  holders: Array<{ instance: string; pid: number }>
  /** 在场但没拿到锁的宿主（`role=waiter`）。 */
  waiters: Array<{ instance: string; pid: number; holderPid?: number }>
  /** 登记过、进程已经不在了的宿主（陈旧登记，只作观测）。 */
  stale: Array<{ instance: string; pid: number }>
}

/**
 * 读某个游标的消费形态。**只读**：不写任何文件、不改任何登记。
 *
 * 判据是"用同一个游标"（而不是"同一个地址"）：游标才是消费位，两个宿主用同一个游标
 * 就是在消费同一份位，这才是 T-67 那条重复门铃的成因。
 */
export async function readConsumerShape(cursor: string, options: { dir?: string } = {}): Promise<ConsumerShape> {
  const dir = options.dir ?? consumerRegistryDir()
  const shape: ConsumerShape = { cursor, holders: [], waiters: [], stale: [] }
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return shape // 目录还不存在 = 没有任何登记（不是错误）
  }
  const seen = new Set<string>()
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let entry: ConsumerPresence
    try {
      entry = JSON.parse(await readFile(join(dir, file), 'utf8')) as ConsumerPresence
    } catch {
      continue // 坏登记跳过：观测面不该因为一条坏记录就崩
    }
    if (!entry || entry.cursor !== cursor || !Number.isInteger(entry.pid)) continue
    const key = String(entry.instance ?? `${entry.pid}`)
    if (seen.has(key)) continue
    seen.add(key)
    const row = { instance: key, pid: entry.pid }
    if (!isPidAlive(entry.pid)) {
      shape.stale.push(row)
      continue
    }
    if (entry.role === 'waiter') {
      shape.waiters.push({ ...row, ...(entry.holderPid === undefined ? {} : { holderPid: entry.holderPid }) })
    } else {
      shape.holders.push(row)
    }
  }
  const byPid = (a: { pid: number }, b: { pid: number }): number => a.pid - b.pid
  shape.holders.sort(byPid)
  shape.waiters.sort(byPid)
  shape.stale.sort(byPid)
  return shape
}

/** 测试与观测用：把心跳节流状态清空（否则同一进程里的连续断言会被"刚写过"挡住）。 */
export function resetConsumerPresenceThrottle(): void {
  lastWritten.clear()
}
