/**
 * `daemon.log` 的滚动策略（T-43 尾巴 b）。
 *
 * 背景：子进程的 stdout/stderr 被 `spawn(..., stdio: ['ignore', fd, fd])` 直接
 * 指到 `<daemon home>/daemon.log`（src/host/daemonclient.ts），当年是为了让
 * "门铃静默失效"这类故障留下线索；代价是这个文件**只增不减** —— 而自研 daemon
 * 正是眼下唯一在值班的唤醒链，长期跑下去它必然长成一块没人敢删的石头。
 *
 * 这里只做两件事：
 *   1. 纯函数（阈值判据 + 历史份搬动计划）—— 不碰 fs，便于单测；
 *   2. `rotateDaemonLog` 把计划落到磁盘，**复制 + 清空**（copytruncate），
 *      因为那个 fd 握在 daemon 手里（原因与代价见 `rotateDaemonLog` 的注释）。
 *
 * @module dsh-msg9-kit/daemonlog
 */

import { copyFileSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 单个 `daemon.log` 的大小上限：2 MiB。
 *
 * 理由：daemon **健康时几乎不写日志**（只在建连/关闭/看门狗判死/重连失败时落一行），
 * 就算一条连接反复重连也就每秒几行 —— 2 MiB ≈ 数万行，足够一场事后追查
 * （2026-09-30 那次 90 分钟静默失效，要的正是"从上一次重启一直看到现在"），
 * 又远远够不上磁盘压力。这个上限的意义**不是省磁盘，而是给"无限增长"画一条线**：
 * 没有它，值班链跑三个月就会留下一个没人知道多大的文件。
 */
export const DAEMON_LOG_MAX_BYTES = 2 * 1024 * 1024

/**
 * 保留的历史份数：3（即 `daemon.log.1` … `daemon.log.3`）。
 *
 * 理由：一次现场故障往往**跨几次重启**（观察期里就真发生过 daemon 被杀→救回、
 * 平台 daemon 停了 5.8 天又被拉起），只留 1 份会把"上一次为什么死的"直接覆盖掉；
 * 而超过 3 份基本不再提供新信息。一份当前 + 3 份历史 = 8 MiB 硬上限，代价可忽略。
 */
export const DAEMON_LOG_KEEP = 3

/**
 * 纯判据：当前日志是否已经到该滚动的体量。
 *
 * 边界取 `>=`：正好等于上限就滚 —— 否则"上限"会变成一个只有超过 1 字节才生效的
 * 虚线，而这个恰好卡在上限上的状态，正是测试最容易写错、也最容易长期没人发现的地方。
 */
export function shouldRotateDaemonLog(sizeBytes: number, maxBytes: number = DAEMON_LOG_MAX_BYTES): boolean {
  return maxBytes > 0 && Number.isFinite(sizeBytes) && sizeBytes >= maxBytes
}

/** 一条历史份的搬动：`from` → `to`（同一目录内的文件名）。 */
export interface DaemonLogShift {
  from: string
  to: string
}

/** 一次滚动要动的文件（纯数据，落在 `home` 目录下）。 */
export interface DaemonLogRotationPlan {
  /** 最旧那一代的落点：滚动时直接删掉（它就是被挤出去的历史）。 */
  drop: string
  /** 历史份依次右移，**按数组顺序执行**：先搬最旧的，避免自己覆盖自己。 */
  shifts: DaemonLogShift[]
  /**
   * 当前日志的留档目标。注意是**复制**目标，不是改名目标 ——
   * 改名不会动 daemon 手里的 fd（见 `rotateDaemonLog`）。
   */
  copyTo: string
}

/**
 * 纯计划：`keep` 份历史时该删哪个、该把谁搬到哪。
 *
 * 不变式（测试钉住的就是它）：任何时刻最多存在 `daemon.log.1` … `daemon.log.keep`，
 * **绝不出现第 `keep + 1` 份**。
 */
export function planDaemonLogRotation(keep: number = DAEMON_LOG_KEEP): DaemonLogRotationPlan {
  const n = Math.max(1, Math.floor(Number.isFinite(keep) ? keep : DAEMON_LOG_KEEP))
  const shifts: DaemonLogShift[] = []
  for (let i = n - 1; i >= 1; i -= 1) {
    shifts.push({ from: `daemon.log.${i}`, to: `daemon.log.${i + 1}` })
  }
  return { drop: `daemon.log.${n}`, shifts, copyTo: 'daemon.log.1' }
}

export interface DaemonLogRotationOptions {
  /** 大小阈值（默认 {@link DAEMON_LOG_MAX_BYTES}）。 */
  maxBytes?: number
  /** 保留的历史份数（默认 {@link DAEMON_LOG_KEEP}）。 */
  keep?: number
}

export interface DaemonLogRotationResult {
  rotated: boolean
  /** 决策时 `daemon.log` 的字节数（文件不存在时为 0）。 */
  sizeBytes: number
  /** 为什么是这个结果 —— 调用方据此决定要不要记一行日志。 */
  reason: 'missing' | 'below-threshold' | 'rotated' | 'failed'
  /** 仅 `reason === 'failed'`：失败原因（此时**当前日志一行没动**）。 */
  error?: string
}

/**
 * 滚动一次 `<home>/daemon.log`（没到阈值就什么都不做）。
 *
 * ## 为什么是"复制 + 清空"（logrotate 的 copytruncate），而不是改名
 *
 * 这个文件**不是我们这个进程打开的**：它由 `spawn(..., stdio: ['ignore', fd, fd])`
 * 继承给 daemon 子进程当 stdout/stderr，子进程一直持有那个 fd，而且 daemon 起来之后
 * 可以连着跑很久（launchd/观察期里就是如此）。于是：
 *
 *   - `renameSync(daemon.log, daemon.log.1)` 只把 **inode 改了个名**：daemon 之后
 *     写出的每一行仍然落进那个 inode ⇒ `daemon.log.1` 继续无限增长，新建的
 *     `daemon.log` 永远是空的。**看着滚了，实际一行都没滚** —— 正是"日志轮转"
 *     最经典的坑，所以这里不用它。
 *   - `truncateSync` 作用在 inode 本身，fd 依旧有效；而 `openSync(path, 'a')` 的
 *     O_APPEND 标志由子进程继承，下一次写会落到新的文件尾（此时偏移 0）。
 *     既能立刻回收空间，又**不必重启 daemon**（重启会白白丢掉一次值班窗口）。
 *
 * ## 代价（明确写在这里，不是免费的）
 *
 * 1. `copyFileSync` 与 `truncateSync` 之间有一个窗口，**窗口内 daemon 写出的行会丢**
 *    （复制已经读过它们，紧接着的清空又把它们抹了）。窗口 ≈ 复制 2 MiB 的时间
 *    （本机毫秒级）⇒ 极端情况下丢几十行。对"事后追查为什么卡死"这个用途可以接受；
 *    要做到一行不丢就得让 daemon 自己 reopen（SIGUSR1 那套），而那个 fd 属于
 *    0.6.0 要替换的那一层，本卡明确不动。
 * 2. 截断可能落在**一行中间**：新 `daemon.log` 的首行也许是半行。
 * 3. 留档是**快照**：同几行可能既在 `.1` 里、也在当前文件里（不保证严格不重叠）。
 * 4. 触发者是**插件进程**（spawn 前 + 每次心跳），不是 daemon 自己 ⇒ 没有 dsh
 *    在跑的那段时间，只有 spawn 那一次滚动生效。这是有意的取舍：给别人的进程
 *    加信号处理，代价远大于"日志多长一会儿"。
 *
 * 任何一步失败都**不清空当前文件**：宁可让它继续长，也不能把唯一的线索弄丢。
 */
export function rotateDaemonLog(home: string, opts: DaemonLogRotationOptions = {}): DaemonLogRotationResult {
  const maxBytes = opts.maxBytes ?? DAEMON_LOG_MAX_BYTES
  const keep = opts.keep ?? DAEMON_LOG_KEEP
  const logPath = join(home, 'daemon.log')

  let sizeBytes: number
  try {
    sizeBytes = statSync(logPath).size
  } catch {
    // 还没产生过日志（daemon 一次都没跑起来过）：无事可做。
    return { rotated: false, sizeBytes: 0, reason: 'missing' }
  }
  if (!shouldRotateDaemonLog(sizeBytes, maxBytes)) {
    return { rotated: false, sizeBytes, reason: 'below-threshold' }
  }

  const plan = planDaemonLogRotation(keep)
  try {
    // 1) 先把它自己搬走，再逐份右移，最后复制当前 —— 顺序反了会自己覆盖自己。
    rmSync(join(home, plan.drop), { force: true })
    for (const shift of plan.shifts) {
      try {
        renameSync(join(home, shift.from), join(home, shift.to))
      } catch {
        // 该历史份还不存在（头几次滚动就是这样）—— 跳过，不是错误。
      }
    }
    copyFileSync(logPath, join(home, plan.copyTo))
  } catch (error) {
    return { rotated: false, sizeBytes, reason: 'failed', error: (error as Error)?.message ?? String(error) }
  }

  try {
    truncateSync(logPath, 0)
  } catch (error) {
    // 留档已经成功、清空失败：只是白复制了一份，当前文件继续长着 —— 不算致命。
    return { rotated: false, sizeBytes, reason: 'failed', error: (error as Error)?.message ?? String(error) }
  }
  return { rotated: true, sizeBytes, reason: 'rotated' }
}
