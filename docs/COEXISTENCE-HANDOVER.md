# 共存交接清单 —— 平台 daemon ↔ 自研 daemon（T-13 阶段三·第一步）

> 目标：把「什么时候能把 ingest 从自研 daemon（`self`）切到平台账本（`ledger`）」
> 写成**机器可判**的东西，而不是一份靠人记得的手测清单。三条边界各有一个自动化
> 测试（`tests/cutover.test.mjs`），每一条都做过**变异验证**（把边界弄坏 ⇒ 测试必须红）。

本轮**只交付骨架**：开关默认 `self`（默认行为一字不改）、死 pid 自愈、三条判据。
**不删任何旧代码**，`src/host/daemon/**` 本轮只读。

---

## 0. 现状：双读共存

| 面 | 谁在值班 | 位置 |
|---|---|---|
| 门铃流（best-effort） | 平台 `msg9 daemon` | `~/.msg9/daemon.sock` |
| 账本（**真相源**） | 平台 `msg9 daemon` 追加写 | `~/.msg9/spool/<address>.jsonl` |
| 消费者游标 | **只有消费者自己写** | `~/.msg9/spool/<address>.<consumer>.cursor` |
| 唤醒投递（改前） | 自研 daemon 或进程内 watcher | `src/host/watch.ts` + `src/host/daemon/**` |

两边各自持有游标 ⇒ **互不干扰**，所以可以并存。

平台契约（`msg9 daemon --help`，逐字要点）：

- 「the doorbell is best-effort; the ledger is the source of truth, and consumers
  read it with their own cursors」—— 账本才是真相源；
- 「a (re)connect replays from the daemon's own tenant cursor, but the server caps
  one replay at **500 events per tenant**」—— 长断线后**别指望流重放**，
  要「top up from inbox unread」；
- 「Multiple daemons may share a machine: the startup guard locks per scope
  （`~/.msg9/daemon.lock.<level>-<id>`）, not globally」。

---

## 1. 三条边界 → 三条自动化判据

### ① 停 daemon → 发信 → 重启必须补上（不许丢唤醒）

**为什么是边界**：平台 daemon 停掉期间到达的信**不会进账本**。账本自身的滞后
（`CursorLag.lag_seconds`）此时是 **0**（账本根本没长），所以「滞后」这条判据
**覆盖不了这个缺口**。唯一能覆盖它的是 **daemon 健康**这一条：健康是
`dead`/`stalled` ⇒ `decideTopUp` 返回 `reason='daemon-down'` ⇒ 走 inbox unread 补齐。

**判据（可判据的形态）**：

- `tests/cutover.test.mjs` · `① 停 daemon → 发信 → 重启必须补上`
  - 临时 spool 里先有 `m1` 并**已经确认**（游标 = `m1`）；
  - daemon 停掉：账本**不长**，同时 `daemonHealth()` 报 `dead`；
  - 消费者这一轮必须把「掉线期间到的信」从 **inbox unread** 拿回来
    （`top_up.reason === 'daemon-down'` 且 `top_up_messages` 非空）⇒ **唤醒没丢**；
  - daemon 重启：它按自己的租户游标回放，把那行补进账本 ⇒ 下一轮
    `fresh` 必须有它（`fresh` 非空）⇒ **重启后补上了**；
  - 同一个进程内不会重复叫（`seen` 环 + 服务器 `folder=unprocessed` 兜底）。

**变异验证**：把 `decideTopUp` 里的 `daemon === 'dead'` 分支删掉 ⇒ 该用例必须红
（掉线期间的信就丢了）。

### ② `scope` 是**选择器**，不是**身份**

平台原文：

```
--scope tenant:<pod>.<org> watches only that tenant's agents; omit to watch all
credentials (any other form is rejected — it never silently degrades to watching
everything)
```

逐条落到我们的代码与文档：

1. `--scope` 回答的是「**这台 daemon 盯哪些凭据**」——一个把凭据集合**筛小**的
   选择器；省略 = 盯全部（machine 级）。
2. 它**不是**「我是谁」的声明：daemon 不因为 `--scope` 获得某个租户的身份，
   它只是不再去看别的租户的凭据。**把 `scope` 写成"租户身份"是不对的**，
   文档与注释里都**不许**这么写。
3. 别的形状**一律被平台拒绝**（exit 2），**绝不静默降级**成"盯全部"——
   所以本仓库自己的解析器（`parseScopeFlag`）也必须**拒绝**，不许猜。

**判据（可判据的形态）** —— 一条 **grep 式断言**（`tests/cutover.test.mjs` ·
`② scope 不许被写成"租户身份"`），对着仓库里的**真实文件**跑：

- 正向：`SCOPE_CONTRACT` 必须包含 `--scope tenant:<pod>.<org>`、`watches only`、
  `rejected`；`docs/COEXISTENCE-HANDOVER.md` / `src/host/cutover.ts` 里必须出现
  把 scope 说成**选择器**的声明（「盯哪些凭据」「选择器」「selector」）；
- 反向：**逐行**扫 `src/**/*.ts` + `docs/*.md` + `README*.md`，
  扫到的每一行里，`scope` 与身份词（`身份` / `identity`）**不许同时出现**，
  除非同行带否定（`不是` / `不许` / `不对` / `绝不` / `not ` / `never` / `≠`），
  否则判红。

**变异验证**：往文档里塞一行「`--scope` 就是租户身份（tenant identity）」——那不是我们的声明，是**故意造的反例** ⇒ 该断言必须红。

### ③ flat 信箱（无 pod）必须有**默认 scope** 的 daemon 值守

**为什么是边界**：`tenant:<pod>.<org>` 的 daemon 按定义只盯
`<agent>@<pod>.<org>.<base>`。`a@msg9.io` 这种**没有 pod 段**的扁平地址
**永远轮不到它**——只有省略 `--scope`（machine / 默认 scope）的 daemon 才盯。
若某地址**没有任何 daemon 覆盖**：它的新邮件不会进账本，"账本不长了"会被
误读成"没有新邮件"。

**判据（可判据的形态）**：

- `scopeNeededFor(address)` / `scopeFlagForAddress(address)`：flat ⇒ `'machine'`
  且没有可用的 `--scope` 取值；pod ⇒ `'tenant'` + `tenant:<pod>.<org>`；
- `assessDaemonCoverage(addresses, scopes)`：没覆盖的地址进 `uncovered`，
  并产出一条 `code: 'no-daemon-coverage'` 的**明确告警**（文案里带地址 +
  「没有任何 daemon 覆盖」/ `no daemon covers`）；
- 接线层（`index.ts` 的 `startLedgerIngest`）在地址集合变化时把告警打进日志，
  **但不拒绝启动**（"没覆盖"是要人知道的事实，不是拒绝启动的理由）。

**变异验证**：让 `daemonScopeCovers` 对 machine scope 返回 `false`
（或让 flat 地址被判成 `tenant`）⇒ 该用例必须红。

---

## 2. 切换开关骨架：`ingest: 'self' | 'ledger'`

```yaml
# cordis 插件配置（或环境变量 MSG9_INGEST）
msg9-kit:
  ingest: self     # self（默认）| ledger
```

| 来源 | 优先级 |
|---|---|
| 插件配置 `ingest` | 1 |
| 环境变量 `MSG9_INGEST` | 2 |
| **默认值 `self`** | 3 |

- **默认关**：不写配置的人拿到的就是改前的行为（`resolveIngestMode({}).mode === 'self'`；
  `planIngest('self')` 与改前的接线逐项一致：`selfDaemon=true, inProcessWatcher=true,
  ledgerLoop=false`）；
- **值不认识 ⇒ 回落 `self` 并记 warning**（写错一个字母就静默换掉唤醒路径，
  是最坏的结果）；
- **可回滚**：把开关拨回 `self` 即完全恢复旧路径 —— 不删代码、不改旧 daemon 行为。

### 「只有一个唤醒来源」怎么保证

不靠"跑起来再看"，靠**计划表 + 运行时守卫**：

| 模式 | 候补来源 | 实际生效 |
|---|---|---|
| `self` | 自研 daemon **或** 进程内 watcher（二者互斥） | daemon 连上 ⇒ `self-daemon`；连不上 ⇒ `in-process-watcher` |
| `ledger` | 只有账本消费者 | `ledger-consumer` |

- `planIngest(mode)` 给出接线计划；`resolveWakeSources(plan, daemonConnected)`
  算出**实际生效**的来源列表；
- `assertSingleWakeSource(plan, daemonConnected)` 是**守卫**：长度 ≠ 1 直接抛错
  （唯一例外：`MSG9_WATCH=0` 整体关掉 watcher 时刻意的 0 个）；
- `ledger` 模式下 `index.ts` **不创建**自研 daemon 客户端（于是
  `POST /dsh-msg9/deliver` 没有 token，它不可能投递唤醒），也**不挂载**进程内
  watcher；唤醒只走 `startLedgerIngestLoop`。

### `ledger` 分支怎么走

1. 消费**我们自己的** consumer 游标（`spool/<address>.dsh-msg9-kit.cursor`，
   裸 `message_id + \n`，与平台 `compact` 的定位口径一致）；
2. 账本行**没有正文**（契约），所以正文去 server 拿：**一轮最多一次 REST**，
   用同一页 `folder=unprocessed` 同时做①正文来源 ②v1.20 的权威对账
   （已在别处闭环的信不在这一页里 ⇒ 不唤醒）；
3. **无游标**（首次消费）⇒ 只立基线，**绝不把历史邮件倒进会话**；
4. **游标落后 / 锚点丢失 / daemon 掉线** ⇒ `decideTopUp` 触发 **inbox unread 补齐**
   （`top_up_messages` 一并投递）；
5. **取不到那一页 ⇒ 绝不 commit**（游标不动、下一轮重投）；**没有活会话 ⇒ 不 commit**
   （与自研 daemon 的 409 ⇒ pending 同义）；**暂停通知 ⇒ 跟踪但不投递**。

---

## 3. 死 pid 自愈（只读，容错）

两处都可能指向**已经死掉的 pid**：

| 文件 | 谁写的 | 死 pid 时的处置 |
|---|---|---|
| `~/.dsh/msg9-daemon/daemon.json` | 自研 daemon | `readDaemonPidState()`：`alive=false` ⇒ **当它没有**；`daemonclient.findDaemon()` 直接跳过 `/healthz` 探测去 spawn 新 daemon |
| `~/.msg9/daemon.lock.<level>-<id>` | 平台 daemon | `readDaemonLocks()`：内容不是**活** pid ⇒ `stale=true`，**不算覆盖**（判据 ③ 因此会报警） |

- 判活只有一条口径：`process.kill(pid, 0)`；**`ESRCH` 才叫死**，
  `EPERM` 算活着（别人家的进程），非整数/非正数算不可信；
- **只读**：`readDaemonPidState` / `readDaemonLocks` 从不写、从不删、从不改用户文件
  （删 `daemon.json` 是 daemon 自己 `removeDaemonInfo` 的职责，且它有 pid 守卫）；
- **不拒绝启动**：死 pid 只是"这里没有 daemon"，`start()` 照常走 spawn / 退回
  进程内 watcher / 账本补齐。

---

## 4. 只读复核（人什么时候想自己看一眼）

```bash
# 账本还在长吗（最后一行的时间 = 平台 daemon 最后一次记账）
for f in ~/.msg9/spool/*.jsonl; do echo "$f: $(wc -l < "$f") lines, last $(tail -1 "$f" | sed 's/.*"received_at":"\([^"]*\)".*/\1/')"; done

# 我们的消费者游标在哪（不存在 = 还没跑过消费者 ⇒ 下一轮是 bootstrap）
ls -l ~/.msg9/spool/*.cursor 2>/dev/null || echo 'no consumer cursor yet'

# 平台侧：谁占着 scope（锁文件内容是 pid；死 pid 的锁 = 没有 daemon）
for f in ~/.msg9/daemon.lock.*; do printf '%s -> pid %s\n' "$f" "$(cat "$f")"; done
ps -p "$(cat ~/.msg9/daemon.lock.machine-"* 2>/dev/null | head -1)" >/dev/null 2>&1 && echo 'platform daemon alive' || echo 'platform daemon NOT running (stale lock)'

# 平台健康文件（两个正交轴：进程活着吗 / 每个连接通吗）
ls -l ~/.msg9/spool/.daemon-status*.json 2>/dev/null || echo 'no .daemon-status file'

# 自研 daemon 的记录（指向死 pid 时会被当成"没有"）
cat ~/.dsh/msg9-daemon/daemon.json 2>/dev/null
```

---

## 5. 本轮**没做**的（诚实清单）

- **没有真的切换**：默认仍是 `self`，`ledger` 分支是骨架，只在测试里端到端跑过；
- **不解析平台健康文件的全部字段**：`.daemon-status*.json` 的字段名按
  `--help` 的措辞容错解析（`last_beat` / `tenants[].state`），**真机没有这个文件，
  未实测**；没有它时靠**活锁**判（有活锁 ⇒ `unknown`，连活锁都没有 ⇒ `dead`）；
- **不做消费者游标的持久化去重环**：进程重启后「锚点之后的同 id 重复」仍由服务器
  `folder=unprocessed` 兜底（阶段一的已知边界，未解决）；
- **不给 `ledger` 分支做批量合并窗口**（self 路径的 12s coalescing 没搬过来）：
  账本一轮的 `fresh` 本来就会合成一条通知；
- **不调用 `msg9 daemon compact`**、不动 `~/.msg9/**` 的任何文件。

---

## 6. 切换前置（**PO 追加，2026-10-07**）—— 不满足就别拨开关

代码把"账本没人记账"**处理**了（判据① 的 `daemon-down` 路径 ⇒ 退回 inbox unread 补齐），
但「**能跑**」与「**该切**」是两件事：**账本停更时切过去，等于把唯一活着的唤醒来源（自研 daemon）换成一条死的账本 + 一条降级的补齐路径。**

动手前逐条确认（只读命令见 §4）：

1. **平台 daemon 活着**（锁里的 pid 真的在）；
2. **账本在长**：`~/.msg9/spool/<addr>.jsonl` 最后写入时间在**近几分钟内**（不是几天前）；
3. **平台健康文件存在**（`.daemon-status*.json`）—— 它是判「idle / dead」的唯一依据；不存在时我们的判定是
   `unknown`（有活锁）或 `dead`（连活锁都没有），**故意不猜**。

**2026-10-07 实测（本机，只读，我亲自复核过）**：三条**全部不满足** —— 平台锁里是**死 pid 75656**、
平台 daemon 进程不存在、账本最后一行停在 **2026-10-01 09:43**（约 5.8 天前）、`spool` 里**没有任何 `*.cursor`**。
⇒ **本机现在绝不能切到 `ledger`**：今天维持唤醒链的是自研 daemon（活着、在投递）。
等平台 daemon 复活、账本重新流动，再回来重跑本节三条。

