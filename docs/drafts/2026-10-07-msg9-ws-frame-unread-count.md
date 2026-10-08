# 信稿（**未发出**）：平台侧 WS 帧带 `unread_count`

> **T-54 ② 产出**。跨项目请求由 **PO（`dsh@dsh.ice.msg9.io`）** 发出，本文件只是可直接投递的草稿
> —— 我（实现者）**没有**发这封信。

## 投递信息（地址已核，别改）

| 项 | 值 |
|---|---|
| **收件人** | `dsh@msg9.ice.msg9.io` |
| 地址核验 | `msg9_resolve dsh@msg9.ice.msg9.io` → `exists: true`，`display_name: "msg9"`，`kind: "agent"`，profile.description = `Inbox of dsh workspace "msg9" (/Users/iceskysl/Code/msg9)`，`signing_public_key` 有值 |
| 别名（同一个信箱） | `msg9-io@dsh.ice.msg9.io` → `alias_of: dsh@msg9.ice.msg9.io`（`resolve` 原文）——**两个地址都通，用上面那个真身** |
| **发件人（拟）** | `dsh@dsh.ice.msg9.io`（本 workspace，dsh-msg9-kit 的 PO 信箱） |
| **主题** | 需求：`/api/v1/ws` 的帧带上地址级 `unread_count`（通知面，零新增读取面） |
| 建议 thread | 新开线程（不要 reply_to 任何旧信）；若你们已有对应 REQ 条目，回信带 `reply_to` 即可闭环 |
| 依据 | 你们 `docs/COLLABORATION.md` §3「各项目 PO 信箱格式 `dsh@<项目名>.ice.msg9.io`」+ §4 写作者区块（本条目请按你们的台账口径取号） |

## 正文（可直接作为 `msg9_send text=` 投递）

```markdown
# 需求：`/api/v1/ws` 的帧带上地址级 `unread_count`（通知面，零新增读取面）

来自 `dsh@dsh.ice.msg9.io`（dsh-msg9-kit 项目）。这是**跨项目请求**，不是缺陷报告。
下面所有数字都能在我们仓库里复跑（`dsh-msg9-kit` → `node scripts/quota-probe.mjs`，会计数的假服务器 + 真实代码路径）。

## 一、一句话

`GET /api/v1/ws` 发给我们 agent 连接的帧（至少 30s 一跳的 `{"type":"ping"}`）请带上**地址级**
`unread_count`，让"未读数"不再必须用一次 REST 换取。

## 二、为什么值得（量化）

**现状**：我们为了给人看的一个数字，付的是上游调用。

| 场景 | 上游调用 |
|---|---|
| `ingest: 'ledger'`（我们计划切过去的默认）：28 个信箱 × 30 跳/小时的徽章对账，而该模式下自研 daemon 与进程内 watcher 都不启动 ⇒ **安静的信箱没有任何未读快照来源**，全退 REST 直查 | **840 次/小时**（`GET /inbox/messages?folder=all&limit=1`） |
| `self` 模式：自研 daemon 的"安全网"每 120s 给每个信箱补一次信（本职是补漏掉的推送），**未读是搭车的**，而它也是未读的唯一保底 | **840 次/小时**（`folder=all&limit=20&since`） |
| T-23 之前的历史（已消除）：per-inbox 未读轮询 | 3380 次/天 |

**平台其实已经有这个数**：REST 与 `/inbox/stream` 两条路径都返回 `UnreadCount`
（`backend/internal/service/message.go:590` / `:699` / `:725`），来源是
`repository/message.go:153` 的 `CountUnread(address)`（地址级索引计数，与查询无关）。
**WS 面是唯一漏掉它的读取路径 —— 而它恰好是零边际成本的那条**：
`handler/websocket.go:267` 的 `writePump` 已经每 30s 发一次 `{"type":"ping"}`（`:32` `pingPeriod = 30 * time.Second`），
这条往返已经在发生了，只是里面没有东西。

## 三、证据（我方现状 + 代码位置）

**我方三级取值**（`dsh-msg9-kit` `src/host/http.ts` 的 `computeUnread`）：

1. 进程内 `/inbox/stream` 长轮询页的快照 —— 该页**已经带** `unread_count`
   （`src/host/watch.ts` 的 `onInboxSnapshot`）⇒ 0 次上游；但那要长轮询活着；
2. 本机 daemon 快照 —— **我们自己加的** `GET /unread` 路由：daemon 每次 fetch 把读数记进 state
   （`src/host/daemon/engine.ts` 的 `noteUnread`），插件再读它 ⇒ 0 次上游，但**读数年龄 = 上次 fetch 的年龄**；
3. REST 兜底 `folder=all&limit=1`（`INBOX_SNAPSHOT_MAX_AGE_MS = 240_000`）—— 每个信箱一次。

**② 之所以必须存在，就是因为 WS 帧只当门铃**：`engine.ts` 的 `attachWs` 解析到的帧只有
`type` 与 `message.message_id`，正文与未读数都得再 fetch 一次。

**平台侧对照**：`handler/websocket.go` 的 `MessageEvent{address,type,message}`
（`:84`）与租户流的 `TenantEvent` 都**没有**未读字段；`writePump` 的 ping 帧只有 `{"type":"ping"}`（`:286`）。

**T-23 的实测（同一台探针）**：per-inbox 轮询 840 → **0**；`/resolve` 同址 22 → **1**；
本次（T-54）新增场景 S7 = **840 次/小时**（ledger 模式无快照来源）。
连同"哪一层省掉了"的对照表在我们仓库 `docs/QUOTA-BUDGET.md`。

## 四、期望产出与验收口径

**字段**：`unread_count`（number）。语义 = 与该地址 REST `GET /inbox/messages?folder=all&limit=1`
的 `unread_count` **相同**（地址级、与查询无关）。

**放哪儿**（按成本从低到高，任选其一都有用）：

1. `{"type":"ping"}` 帧带 `unread_count` —— **最省、最有用**（安静信箱也有 30s 一跳）；
2. `new_message` 帧也带 —— 徽章即时性；
3. 或者单独开一帧（例如 `{"type":"unread","unread_count":N}`）—— 同样可以。

**兼容性**：**新增可选字段**；老客户端忽略未知字段；不新增端点、不动投递语义、
不改既有字段语义（`since` 模式的 `total` 是"窗口命中数"，DEF-020 —— 请**不要**顺手把 `total` 塞进帧里）。

**可机器验证的验收判据**（我们这边可以照着写回归）：

- **A1** 同一时刻采样：帧里的 `unread_count` == `folder=all&limit=1` 的 `unread_count`；
- **A2** 未读数变化（新信到达 / 别处标已读）后 ≤ 1 个 ping 周期（30s）内帧内数字跟随；
- **A3** 不新增端点、不改认证（沿用现有 `msg9-l0, <ticket>`）；老连接不因缺字段报错或断开；
- **A4** **不产生额外查询**：复用现有的 `CountUnread(address)`，不要因为"每 30s 一帧"就给
  每条连接新增一次 DB 往返（按连接/地址缓存 ≤ 30s 即可）；
- **A5** 字段缺失时 = 老行为（我们按"没有读数"处理，退回 REST 兜底）。

## 五、我方配套（不需要平台额外配合）

拿到帧内读数后，我们会：把 daemon 的"未读刷新"与"补信 fetch"解耦
（`safetyNetMs` 按补信的 SLA 单独调，预计 −80% 的那条通道），
并把 ledger 模式的 840 次/小时 REST 兜底降到 0。两侧都不新增平台面。

## 六、本地绕过与代价（如实说，供你们按台账判据定档）

绕过就是我们的 ③ REST 兜底：**能用**，代价是配额（S7 的 840/小时）与滞后（徽章最坏 ~240s）。
按你们 `docs/REQUESTS.md` §1 的"是否有本地绕过"判据，这条**不阻塞我们**；
但它是**我们自己制造的重复请求**，与 T-23 消掉的那两条同源，所以我们照实报上来。

## 七、相关台账（供归档）

- **REQ-303**（`kimi@dsh.ice.msg9.io`，v1.40 的租户级流）—— 同一张 WS 通知面；
- **DEF-018 / T-74**（同一张面：`Total` 与 REST 同义化、空批也带 `Total`）；
- 本条目编号请按你们的写作者区块自取（我们这边是 **T-54**）。

## 八、时限与期望

**不阻塞**：我们会继续用 REST 兜底跑着，不需要你们为此专门排一个版本。
若判定为**批次 1/2**，希望能落在你们下一轮的 WS 面改动里（与 REQ-303 同一处）；
若判定为**批次 3（不做）**，请回一封结论信说明理由 —— 我们会把它写进
`docs/QUOTA-BUDGET.md`，免得下一轮再评估一遍。任何结论我们都在 48 小时内回执。
```

## 发出后要回填的两件事

1. 卡 **T-54** 的 comment：发出的时间、收件地址、`message_id`；
2. 对方回执/结论 → 写回 `docs/QUOTA-BUDGET.md` §4（替代"信稿见 drafts"那句）。
