# dsh-msg9-kit 重构方案：ORG key → Pod → Agent key

**状态**：待主人确认（**未动一行代码**）
**日期**：2026-09-30
**起因**：主人指出现状"一堆乱七八糟的 Agent inbox"，并给出目标形态

---

## 0. 一句话

**把「凭证阶梯」补全，并把「自动开通」改成「显式开启」。**

```
msg9_ok_（ORG 开通） → msg9_tk_（pod 建 inbox） → msg9_sk_（分身收发）
```

这三层**平台早就实现了**（`12-org-pods.md` §4 定稿 2026-09-12），
**本插件只实现了最下面一层**：它拿着一把写死的 pod key，给每个 workspace 自动开 agent。
**⇒ 本方案就是补上缺的那两层，并去掉"自动"。**

---

## 1. 现状（已核实，非推测）

### 1.1 三个已确认的缺陷

| # | 位置 | 行为 | 后果 |
|---|---|---|---|
| **D1** | `lib/index.js:1051` | 无 pod key ⇒ **公开自助注册**，无任何提示 | 静默落到"当时的默认域" |
| **D2** | `lib/index.js:589` `tenantKeyPath()` | 硬编码单把 `tenants/dsh.key` | "哪个项目用哪个 pod"**不随项目走**；换一把 key，**全机 23 个 workspace 一起换域** |
| **D3** | `lib/index.js:556` `deriveAddress()` | slug 回退 `title → 目录名 → "ws"` | title 为通用的 `workspace` 时产出 `dsh-ws-xxxx`，**事后认不出是谁** |

### 1.2 本机实况（23 个身份，散在 6 个域）

| 域 | 个 | 定性 |
|---|---|---|
| `msg9.ice` | 8 | **P4 扁平域存量**（`dsh-ws-*` ×5、`dsh-why-*`、`dsh-3-*`、`dsh@msg9.ice`）——**与 msg9 项目毫无关系**，只是"当时默认域是它" |
| `whymyphone.ice` | 7 | **域选错**（`loops`/`videos`/`llmpool`/`ws-*`/`dsh-jev-*`/`dsh@whymyphone`） |
| `dsh.ice` | 5 | **正确**（P1 项目即 pod） |
| `vme` / `murun` / `mum` | 各 1 | 历史遗留 |

### 1.3 权威规范（`docs/specs/address-format.md`，2026-09-17 统一）

```
<agent>@<pod>.<org>.<base>        P1 项目即 pod（开发推荐）
```

- **新接入优先用 pod 形态**；扁平域 `<agent>@<base>` 仅供"公共注册、对外长期服务邮箱、**存量**"；
- pod 内 agent local = **harness 名**（`kimi` / `claude` / `dsh`），**撞名追加 `-2`**；
- **local 不编码**（不放 uid、路径、git remote）——"pod 标签已承载归属标识"；
- pod 租户 key 存 `~/.msg9/tenants/<pod>-<org>.key`。

### 1.4 ⚠️ 规范里有一条，正是本机事故的直接机制

> **租户 key 解析优先级**：`--tenant-key` / `MSG9_TENANT_KEY` > `tenants/<harness>.key`（旧模型，存量）
> > `tenants/` 里唯一一把 `*.key`。
> **多把 key 且不显式指定 → 报错列候选**，不会替你猜。

**⇒ 本机 `tenants/` 下躺着 17 把 key**，而插件**既没报错也没列候选**——它**硬编码读 `dsh.key`**（D2）。
**⇒ 这就是 2026-09-30 01:12 那次"全机 24 个 workspace 被卷进 `whymyphone`"的完整机制。**
（msg9 项目 PO 独立定位同一机制，记为 **DEF-001**，已复发 2 次。）

---

## 2. 目标形态（主人 2026-09-30 定）

```
设置里填 ORG key（msg9_ok_…）
   │
   └─ 默认不动：workspace 的 Pod = 【未开启】
        │
        └─ 手工点「开启」
             ├─ 用 ORG key 申请 Pod          → 得 pod key（msg9_tk_，一次性显示）
             ├─ 按规范存 pod key             → ~/.msg9/tenants/<pod>-<org>.key（0600）
             └─ 用 pod key 申请 Agent key    → 得 agent key（msg9_sk_）
                  └─ 按规范存 agent 凭据      → ~/.msg9/projects/dsh/<dir>-<hash4>.yaml（0600）

收发信：一律用 Agent key
监听：统一走 msg9 daemon + WS 通道
```

**核心变化**：

| 维度 | 现状 | 目标 |
|---|---|---|
| 默认行为 | 访问即自动开通 | **默认不开通**，显示"将得到什么"+「开启」按钮 |
| 无凭证时 | 静默公开注册 | **拒绝并说明缺什么** |
| 凭证层级 | 只见 pod key | **ORG → Pod → Agent 三层，各自落规范位置** |
| 监听 | 各 workspace 自轮询 | **统一 daemon + WS** |

---

## 3. 状态机（workspace 维度）

```
        ┌─────────────────────────────────────────┐
        │  U 未配置（无 ORG key）                  │
        │  面板：引导填 ORG key；不注册任何东西     │
        └───────────────┬─────────────────────────┘
                        │ 填入并校验 ORG key
                        ▼
        ┌─────────────────────────────────────────┐
        │  P 已配置 ORG，Pod 【未开启】（默认态）   │
        │  面板：显示"将得到 <pod>.<org>.<base>"    │
        │        + 「开启」按钮；不注册任何东西      │
        └───────────────┬─────────────────────────┘
                        │ 点「开启」
                        ▼
        ┌─────────────────────────────────────────┐
        │  A 开通中（幂等，可重入）                 │
        │   ① pod 已存在？ → 复用，不重建           │
        │   ② 否则 POST /org/pods → pod key        │
        │   ③ 存 tenants/<pod>-<org>.key (0600)    │
        │   ④ POST /owner/agents → agent key       │
        │   ⑤ 存 projects/dsh/<dir>-<hash4>.yaml   │
        └───────────────┬─────────────────────────┘
                        │
                        ▼
        ┌─────────────────────────────────────────┐
        │  R 已开通（收/发信都用 agent key）        │
        └─────────────────────────────────────────┘
```

**关键约束（每条都有理由）**：

1. **U/P 两态绝不写任何凭据**——这是"默认不动"的实质，不是 UI 措辞；
2. **A 态幂等**：任一步失败可重入。**pod 已存在时复用**，不报错、不重建
   （理由见 §5 的 40900 坑）；
3. **Agent key 是唯一收发凭证**——ORG key 只管开通，**不参与收发**（`12-org-pods.md` §4 明文）；
4. **每一步的产物都可单独校验**（pod key 能 `owner/me`、agent key 能 `agent/me`）。

---

## 4. 三层凭证的落盘（严格按规范）

| 层 | 存哪 | 格式 | 权限 | 谁写 |
|---|---|---|---|---|
| **ORG** | `~/.msg9/orgs/<org>.key` | **一行 key**（`msg9_ok_…`） | 0600 | 仅本插件 |
| **Pod** | `~/.msg9/tenants/<pod>-<org>.key` | **一行 key**（`msg9_tk_…`） | 0600 | 仅本插件 |
| **Agent** | `~/.msg9/projects/dsh/<dir>-<hash4>.yaml` | `address` / `api_key` / `api_url` / `created_at` | 0600 | 仅本插件 |
| Agent 签名 | `~/.msg9/projects/dsh/<dir>-<hash4>.signing.yaml` | 见 §7 | 0600 | 仅本插件 |

**⚠️ 注意与现状的差异**：规范对 pod key 的文件名是 `<pod>-<org>.key`
（例：pod `dsh` + org `ice` ⇒ `dsh-ice.key`）。
**本机现在那把 `tenants/dsh.key` 是旧模型的 `<harness>.key`**，按规范属于"**迁移后归档移走**"的对象（§1.4）。

**文件名推导**（`<dir>-<hash4>`）：目录名折叠（小写、≤20、非法字符转 `-`）+ **绝对路径 sha256 前 4 位**。
**已知 wart（规范承认暂不修）**：嵌套目录下 stem 随 cwd 变 ⇒ **一律从工作区根解析**。

---

## 5. ⚠️ 必须写进实现的三个坑（都是实测踩过的）

### 5.1 目标地址已存在 ⇒ `provisionUnderOwner` 撞 40900 直接失败

```
POST /api/v1/owner/agents {"addresses":["dsh"]}
→ {"code":0,"data":{"created":[],"errors":[{"address":"dsh","code":40900,"message":"address already taken"}]}}
```

**⇒ 决议表（实现必须照此）**：

| 情形 | 处理 |
|---|---|
| 地址已存在**且属于目标 pod** | **认领**（幂等，不新建、不报错） |
| 地址已存在**但属于别的 pod** | **报错并列出冲突地址**，交人工决定（**不静默跳过、不覆盖**） |
| 不存在 | 新建 |

**⇒ 这条是硬要求**：`migrate` 在本机就因为这个坑**用不了**，只能"认领已有身份"。

### 5.2 ORG key 的 scope 可能不全

实测：本机那把 ORG key 有 `pod:create`，但**没有 `pod:purge` / `pod:disable`**：

```
DELETE /api/v1/org/pods/:id          → 403 "lacks the pod:purge scope"
POST   /api/v1/org/pods/:id/disable  → 403 "lacks the pod:disable scope"
```

**⇒ 实现要求**：
- **创建前先只读探测**（列 pod / `owner/me`），**不要拿生产 ORG 试接口形状**；
- **scope 不足时要给出明确文案**（"这把 key 缺 `pod:create`"），而不是笼统 403。

### 5.3 我误建过一个生产 pod（记录在案）

2026-09-30 我用 `{"label":"probe-x","name":"probe-x"}` **试探**创建接口形状，
**结果真的建成了**（`probe-x.official.msg9.io`，agents=0）。因 key 无 purge scope **当时删不掉**，
后由主人清除（现已不在 pod 列表）。

**⇒ 教训写进实现纪律**：
**"试探接口形状"必须用必然失败的 body，或改用只读端点。禁止在生产 ORG 上做写操作探测。**

---

## 6. 监听：统一走 daemon + WS

**现状**：`src/host/watch.ts` 各 workspace 自己轮询/监听；`src/host/daemon/` 已实现
**票路径 + WS 客户端**（`engine.ts:280` `issueWsTicket()` → `protocols: ['msg9-l0', ticket]`）。

**目标**：**收信统一归 daemon**，插件只消费 daemon 的事件流。

**与 msg9 侧契约对齐**（msg9 PO 2026-09-29 定稿「账本 + 门铃」）：

| 角色 | 用什么 | 保证 |
|---|---|---|
| **账本**（谁还没消费） | `~/.msg9/spool/<address>.jsonl` | 持久 + at-least-once |
| **门铃**（有新信了） | `~/.msg9/daemon.sock` | **尽力而为**（丢了不影响正确性） |

**三条不得违反**（对方明文要求）：
1. **账本（spool）是唯一契约与唯一真相**；
2. **游标只在消费者确认后推进；daemon 永不替消费者推进**；
3. **门铃尽力而为**——缺席/丢失/重复**不得影响正确性**。

**⚠️ 我方现状与差距（已核）**：

| 要求 | 现状 |
|---|---|
| ① 走票路径，票不进 URL/日志 | ✅ **已实现** |
| ② 按 spool 契约写 `.jsonl` | ❌ **未做**（grep `spool` = 0；现在是内存注册表，**不落盘**） |
| ③ 守卫按 `(level,id)` 加锁 | ❌ **未做**：`daemon.start.lock` 是**全机一把** ⇒ **第二个 daemon 必然拒绝启动** |
| ④ scope 模型按 `(level,id)` | ❌ 未做（`daemon.json` 单一固定路径） |

**⇒ ③ 是硬伤，列为第一期前置**：它挡的不是性能，是**"多 daemon 同机"这个前提本身**。
**⇒ ③④ 必须一起改**（否则"锁放开了、但两个 daemon 抢同一个 `daemon.json`"）。

### 6.1 🔴 重要更正（2026-09-30 晚，核实后推翻上一版结论）

**上一版建议"我们改自己的 daemon 去补 spool 与 scope 锁" —— 这个方向被推翻了。**

实测 `msg9` CLI（v1.40.1 已收编 daemon）：

```bash
$ msg9 daemon --help
Watch every agent credential under ~/.msg9/projects and ledger each new-mail
notification to ~/.msg9/spool/<address>.jsonl …
consumers read it with their own cursors (spool/<address>.<consumer>.cursor),
which only consumers write.
Multiple daemons may share a machine: the startup guard locks per scope
(~/.msg9/daemon.lock.<level>-<id>), not globally …
Exit codes: 3 = scope already held by a live daemon
$ msg9 daemon compact   # 按所有消费者游标的最小值截断账本
```

**⇒ 平台侧已经把 ②③④ 全做完了，而且做成了 CLI 子命令。**

**⇒ 所以我方不该再造一个 daemon**（那会有两套契约、两份真相 —— 正是本轮反复出现的病）。

**⇒ 修正后的方向**：

| 层 | 谁做 | 说明 |
|---|---|---|
| **ingest + 账本 + 门铃** | **`msg9 daemon`（平台 CLI）** | 我们不实现 |
| **发现 + 消费** | 我方插件 | 读 `~/.msg9/spool/<address>.jsonl`，**自己写游标**（DM-9） |
| **唤醒会话** | 我方插件 | 把账本事件转成 dsh 的会话注入 |

**⚠️ 但有一个真实的迁移障碍（已核，不是推测）**：两套 daemon **协议不同**，不是 drop-in：

```
我方现有： ~/.dsh/msg9-daemon/daemon.json（pid/port/token）+ HTTP /register · /deliver
平台 CLI： ~/.msg9/daemon.sock（unix socket）+ spool 账本 + 每消费者游标
```

**⇒ 迁移不是"换个进程启动"，而是"换一套集成契约"**：
我方 `daemonclient.ts` / `daemon/`（engine + server + wsclient）在新方案里**大部分会作废**：
- `engine.ts`（WS + 票路径 + 合并投递）⇒ **由 `msg9 daemon` 接管**；
- `server.ts`（HTTP register/deliver）⇒ **由 socket + 账本取代**；
- `state.ts`（注册表/cursor/pending）⇒ **由 spool + 每消费者游标取代**。

**⇒ 保留的**：把"账本事件"变成"dsh 会话注入"的那一层（`deliverDaemonBatch` 一类），
以及**唤醒预算 / 降级投递**那套策略（那是 dsh 侧特有的，平台不该管）。

**⇒ 结论：这件事的性质从"补功能"变成"删代码 + 改集成"，工作量方向相反。**
先做 P1（ORG→Pod→Agent），daemon 迁移单独立项、单独评估。

### 6.2 顺带清掉一个遗留

`~/.dsh/msg9-daemon/daemon.json` 指向 **pid 56926**，该进程**已不存在**（`pgrep` 无结果），
但 json 仍是 0.4.6 的陈旧记录。msg9 侧说明那是**他们的测试遗留进程**，同意由我方处置。

**⇒ 处置**：迁移时一并清掉该文件（它现在是"指向死进程的活配置"，
会让启动逻辑以为"已经有一个 daemon 在跑"）。**本次不动**（迁移时统一处理）。

---

## 7. 签名密钥格式（与 msg9 CLI 对齐）

**现状**：我方写 **YAML**（`signing_seed:` + `created_at:`），全局那份是**裸 base64** ⇒
msg9 CLI 按裸 base64 解码 ⇒ `illegal base64 data at input byte 7`（`signing_seed:` 正好 13 字符）。

**决定：权威格式 = 裸 base64**（与全局那份一致）。

**但落地顺序不能反**（这是唯一会"改出新故障"的点）：

```
① msg9 侧先上「YAML 优先、裸 base64 兜底」的容错读取   ← 对方已完成（T-46）
② 我方改成裸 base64（保留读 YAML 的能力）
③ 观察一版后，再考虑是否废弃 YAML 读取
```

**⇒ 现状**：① 已完成 ⇒ **② 现在可以安全做**。

---

## 8. 存量 23 个身份的处置（**不做自动迁移**）

**原则**：**自动迁移会断通信**（msg9 PO 的立场，我方同意）。故：

| 类别 | 处置 |
|---|---|
| **`dsh.ice` 下 5 个（正确）** | **保留原样**，纳入新状态机（已开通态） |
| **`whymyphone` 下 7 个（域选错）** | **保留 + 标注"域与项目不符"**，提供人工迁移入口，**不自动搬** |
| **`msg9.ice` 下 8 个（扁平域存量）** | **保留 + 标注"P4 存量"**，同上 |
| **其他 3 个** | 同上 |

**每个存量身份都要能回答"我属于哪个项目"**——这是本次事故的核心痛点。
⇒ 面板为每条显示：**地址 / 所属域 / 是否与项目 pod 一致 / 冲突时的说明**。

---

## 9. 改动清单（文件级）

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/host/credentials.ts` | 新增 ORG key 读写；pod key 按 `<pod>-<org>.key` 解析（**含"多把 key 必须报错列候选"**） | **高** |
| `src/host/service.ts` | `provision()` 改为**显式**；新增 `openPod()`（ORG→Pod）；40900 决议表 | **高** |
| `src/host/api.ts` | 加 `orgPods()` / `orgMe()` / 创建 pod；**所有调用先只读探测** | 中 |
| `src/host/store.ts` | state 增加 `org` / `pod` 段；workspace 增加 `state: unconfigured\|pod_closed\|ready` | 中 |
| `src/client/Msg9SettingsSection.tsx` | ORG key 输入 + 校验；Pod「开启」按钮 + 预览地址 | 中 |
| `src/client/Msg9Panel.tsx` | 地址列表显示"所属域/是否与项目一致" | 中 |
| `src/host/daemon/*` | 锁键按 `(level,id)`；`daemon.json` 按 scope 分文件；spool 落盘 | **高** |
| `src/host/signing.ts` | 写裸 base64（读保留双格式） | 低 |
| `README*.md` | 地址规范改为现行口径；补"发布后需重启" | 低 |

---

## 10. 分期（P0 可独立先做，不等 P3）

| 期 | 内容 | 依赖 |
|---|---|---|
| **P0** 🔴 | **租户 key 解析按规范报错列候选**（治 D2 的静默覆盖）；**去掉无凭证时的静默公开注册**（治 D1） | **无** |
| **P1** | ORG key 配置 + Pod「开启」链路（ORG→Pod→Agent）+ 状态机 | P0 |
| **P2** | 存量身份标注与人工迁移入口；面板呈现 | P1 |
| **P3** | daemon 锁按 scope + spool 落盘 + 监听统一 | 与 msg9 侧契约对齐 |

**⇒ P0 是"止血"**：它单独就能防止"下次换 key 再卷一遍全机"。

---

## 11. 回归验证（每条都可证伪）

| # | 验什么 | 怎么验 |
|---|---|---|
| R1 | **无 ORG key 时，绝不注册任何身份** | 清空配置 ⇒ 跑 workspace ⇒ 断言凭据仓零新增 |
| R2 | **有 ORG key 但未开启时，仍不注册** | 同上，断言 pod/agent 均未创建 |
| R3 | **"开启"幂等** | 连点两次 ⇒ pod 只建一个、agent 只建一个 |
| R4 | **pod 已存在时复用而非报错** | 手工预建同名 pod ⇒ 开启成功 |
| R5 | **多把租户 key 时不猜** | 造两把 ⇒ 断言报错并列出候选 |
| R6 | **不污染 `Object.prototype` 类问题**（若沿用 taskboard 的教训） | — |
| R7 | **agent key 是唯一收发凭证** | 断言收发不读 ORG key |
| R8 | **锁按 scope** | 两个不同 scope 的 daemon 可同时启动 |
| R9 | **spool 不丢不重** | `kill -9` 后重放，断言 at-least-once |
| R10 | **门铃缺席零丢失** | 不连 socket ⇒ 仍能从账本按游标读到 |

**⇒ 全部用 `node:test` 写进 `tests/`，遵循现有风格。**

---

## 12. 需要主人拍板的三件事

1. **本方案是否照此实施**（尤其 §2 状态机与 §8「存量不自动迁移」）；
2. **P0 是否立即做**（它独立、且能止血，不等 P1–P3）；
3. 🔴 **ORG key 从哪来 —— 这是 P1 的硬阻塞（已核实）**。

### 12.1 关于第 3 条，我已把实情查清（不是推测）

本机现有一把 ORG key（`official-account-msg9.io.yaml` 里的 `msg9_ok_bf41…`），
但**它属于另一个 ORG，管不到 dsh**：

```
dsh pod（own_i3Ue1hCBplyF, pod_label=dsh） → org_id = org_3zQmLlMboo9Y   ← ORG「ice」
                                               address_domain = dsh.ice.msg9.io

official ORG key（org_RK9z2VyOuIZ7）        → ORG「official」
   `GET /org/pods` 只列出 ['std', 'sys']
   ⇒ 【不包含 dsh】，即这把 key 对 dsh 的 pod 无任何管辖权
```

**⇒ 结论：本机【没有】ORG「ice」的 key**（`~/.msg9/tenants/` 下无 `msg9_ok_` 类型凭证）。

**⇒ 所以第 3 条必须由主人决定，二选一**：

| 方案 | 含义 | 需要什么 |
|---|---|---|
| **(a) 新建 dsh 专属 ORG** | 给 dsh 项目建自己的 ORG + pod | 可建 ORG 的凭证（`POST /api/v1/account/orgs`，user JWT） |
| **(b) 复用 ORG「ice」** | 在 ice 下建/管 dsh pod | **ice 的 ORG key**（本机目前没有） |

**⇒ 在主人给出 (a)/(b) 及其凭证之前，P1 无法开工**（**P0 不受影响，可立即做**）。

**⇒ 附带说明（避免误解）**：`12-org-pods.md` §5 明确「**不提供把已有 pod 从一个 ORG 挪到另一个 ORG**」
——所以 (a) 与 (b) 的选择**会影响 dsh 现有 `dsh@dsh.ice.msg9.io` 的归属**：
- 选 (b) ⇒ 现有地址**一字不变**，最省事；
- 选 (a) ⇒ 现有 `dsh.ice` 下的身份**留在 ice**，新 ORG 是另一套域，**需走迁移配方**（§6）。

---

## 附：本方案与 msg9 侧已确认事项的对应

| msg9 侧 | 状态 | 本方案如何用 |
|---|---|---|
| DEF-001（实例 owner 单槽位静默覆盖） | 已确认，复发 2 次 | §10 P0 的 D2 |
| T-46（签名双格式兼容） | ✅ 已完成 | §7 的落地顺序① |
| T-62（resolve 对组返回 false） | 修中 | **发送路径不做 resolve 预检** |
| `accepted` ≠ 送达 | 语义已明确 | 工具层措辞 + `message_id` 回查 |
| 账本 + 门铃契约（DM-7/8/9） | 已定稿 | §6 |
| daemon scope 锁（对方第 3 项预警） | **与我方核实一致：确实是全机一把** | §6 ③ |

---

## §13 地址规范改造 + Jev 归位（主人 2026-09-30 定案）

### 13.1 已确认的命名规则

**规范地址 = `<harness 名>@<项目 Pod>.<org>.<base>`**

| 段 | 含义 | 例（Jev 项目） |
|---|---|---|
| Agent 段 | **harness 名**（固定，不带项目后缀） | `dsh` |
| Pod 段 | **项目名** | `jev` |

**harness 名映射**（主人 2026-09-30 明确）：

| harness | agent 名 |
|---|---|
| dsh | `dsh` |
| kimi | `kimi` |
| claude | **`cc`**（不是 `claude`） |

⇒ 同一个项目 Pod 里每个 harness 一个信箱：`dsh@jev.ice` · `kimi@jev.ice` · `cc@jev.ice`。

**平台侧已经在按这个模型运行**（实证）：`~/.msg9/spool/` 里 `dsh@dsh.ice.…jsonl` 与
`kimi@dsh.ice.…jsonl` 并存 —— 同一个 pod 两个 harness。

### 13.2 代码现状：推导方向是反的（13 条不规范的根因）

`src/host/workspace.ts` `deriveAddress()`：

```
租户/子域模式（tenant: true）： <workspace-slug>@<pod>   → jev@dsh.ice    ← 反的
扁平模式（无 pod）：            dsh-<slug>-<hash4>@msg9.io
```

本地部分放的是 **workspace 名**，不是 harness 名。
（那 6 条规范的，是因为当时**手工给了** `preferred_address: dsh`，不是默认行为。）

**✅ 已改（2026-09-30，主人定案）**：

1. 租户模式本地部分固定为 **harness 名**；扁平模式保持不变（无 pod 承载项目，必须靠本地部分区分）
2. 抽出 `HARNESS_AGENT_NAMES` / `harnessAgentName()`（原硬编码在 `dsh-` 前缀里）并暴露给面板
3. 判据补齐：**规范 = Agent 段是 harness 名（或 harness 名 + 可读后缀）且 Pod 段 == 应有 Pod**
   —— 之前只查 Pod 段，是**半条判据**

**粒度（主人的原话，两句话要一起读）**：

> 「大多数应该是 **1 个项目对应 1 个 workspace**」
> 「如果有多个 dsh，后续可以加 **dsh-1、dsh-2** 或者 **dsh-dev、dsh-fe** 这样」

⇒ 默认 `dsh@<项目>`；**撞名时允许加可读后缀**（自动试 `dsh-2`…`dsh-4`，
`dsh-dev` / `dsh-fe` 这类语义后缀由人显式指定）。

⚠️ **与旧行为的关键区别是"后缀必须可读"**：
旧实现撞名退化成 `<workspace-slug>-<hash4>`（`dsh-jev-8221`、`dsh-ws-04fe`）—— 那串哈希
就是"认不出是谁"的根源，**已废弃**。自动编号用尽后不再编更多，而是报错让人显式命名。

**刻意没做的一件事**：**没有**加"后缀里带 4 位十六进制就算不规范"的启发式。
理由：`dsh-2024` 这种正常编号会被误伤，文本上无法与 `dsh-why-545a` 区分；
而现存那 5 条带哈希的行**本来就被 Pod 段判为不规范**（真机核对：仅 Agent 段错的 **0** 条）。
⇒ 少一个会误判的启发式，规则仍然完整。

### 13.3 Jev 归位（主人 2026-09-30 批准「迁移」）

现状（两个信箱都不规范）：

| 地址 | 问题 | 有无历史 |
|---|---|---|
| `dsh-jev-8221@whymyphone.ice.msg9.io` | Pod 错（不是它的项目）+ Agent 段错 | 有（但主人说"应该还没正式启用"） |
| `jev@dsh.ice.msg9.io` | Pod 错 + Agent 段错（`jev` 是 workspace 名不是 harness 名） | 无（**误建**） |
| **目标** `dsh@jev.ice.msg9.io` | ✅ 已确认**空着**，`jev` pod 已存在（0 个信箱） | — |

**只读探测已证**：`whymyphone-ice.key` 能列出旧 agent 的 key（`code=0`）
⇒ 规格 §6 那条路走得通：`POST /owner/agents/:address/keys` 可为旧地址**签发新凭据**。

**步骤**（依规格 `address-format.md` §6 的迁移配方）：

| # | 动作 | 端点 / 手段 | key |
|---|---|---|---|
| 0 | **前置：把 `Documents/OPC/Jev` 在 dsh 里登记成工作区** | 主人操作（我不代改 dsh 注册表） | — |
| 1 | **先建** `dsh@jev.ice.msg9.io` | `POST /owner/agents` | jev pod key |
| 2 | 给旧 agent 签一把新 key（否则搬不了信） | `POST /owner/agents/:address/keys` | whymyphone pod key |
| 3 | **再**搬历史（目标此刻已存在，见下） | `POST /owner/agents/:address/move-mail` | whymyphone pod key |
| 4 | 老地址设转发（漏网来信进新信箱） | `PUT /agent/forwarding` | 旧 agent key（第 2 步所得） |
| 5 | `disable` 旧 agent（消息全保留） | `POST /agent/disable` | 旧 agent key |
| 6 | 删掉误建的 `jev@dsh.ice.msg9.io` | `DELETE /owner/agents/<local>` | jev pod key |
| 7 | 本地：记录挂到新工作区 + 写新凭据；移除旧记录 | 本插件 | — |

**⚠️ 第 1 步必须在第 3 步之前** —— 见下面这条踩过的坑。

### 13.3.1 踩过的坑：我把"目标不存在"误读成"跨 pod 被禁止"

**我一度报了一个缺陷，主结论是错的，已去信更正。** 记录在此以免重犯：

| 探测（`dry_run`） | 目标状态 | 结果 |
|---|---|---|
| `to = dsh@dsh.ice.msg9.io` | **存在**（不同 pod） | ✅ `code=0`，`moved=2` |
| `to = dsh@jev.ice.msg9.io` | **不存在**（jev pod 里 0 agent） | ❌ `40311 not owned by this owner` |

`40311` 的字面意思诱使我推断"**同 ORG 跨 pod 不被允许**"，于是准备**放弃迁移历史、
退化成只设转发**。实际只是**目标还没建**。

平台侧**已修**（实测：同一调用连测 3 次均为 `40410 not found`）——
即"目标不存在"不再复用"越权"的错误码。

**⇒ 两条纪律**：
1. **迁移类动作的顺序是"先建目标、再搬信"** —— 反了会得到一个语义完全错位的报错；
2. **错误码把两种语义揉在一起时，使用者会替它做一次错误的因果推断。**
   看到 `not owned` 先问一句"**是不是目标根本不存在**"，别急着下"被禁止"的结论。

### 13.3.2 已确认的前提（不必再验）

* **跨 pod 搬信允许**（规格 §12.1 的 ②「同 ORG 另一个 pod」是真的）；
* **旧信箱里只有 2 封，且都未读**（`dry_run` 报 `by_folder={"inbox/unread":2}`）；
* **目标 `dsh@jev.ice.msg9.io` 空着**，`jev` pod 已存在（0 agent）；
* **`whymyphone-ice.key` 有权管旧 agent**（`GET /owner/agents/:address/keys` → `code=0`）；
* 搬信**保留 folder**（未读搬过去仍未读），且**是 move 不是 copy**、**不可逆**。

### 13.3.3 ⚠️ 第 5 步（`disable` 旧 agent）的**前置断言**必须写成结构判据

第 5 步是全流程唯一的**破坏性**动作（我们的远端破坏面就只有 `ownerDisableAgent()` 这一处）。
msg9 侧 2026-09-30 报了他们自己的一个 P0：**"条件清理"接口会把活实体判成垃圾**
（基线 `docs/reviews/2026-09-30-t81-cleanup-baseline.md`），并给了他们踩出来的判据形态。
**⇒ 直接复用，别自己发明**：

| 判据 | 说明 |
|---|---|
| **该 pod 下还有 agent ⇒ 不许停** | "缺一种链接" ≠ "可删" |
| **该 agent 有 `user_id` / 元数据带 `system` 标记 ⇒ 不许停** | **服务身份天然没有 user 成员** —— 这正是他们误删的形态 |
| **时间窗只作辅助** | **休眠的合法身份与垃圾在时间轴上完全一样** —— 拿"最近没用"当判据必错 |

**⇒ 纪律**：断言要写成**结构性判据**（"能不能删"由关系决定），
而不是"**看起来**没人用"。同族：本仓"绝不跨 pod 回退"、"用前验证 key 归属" ——
**别用"看起来合理"的兜底掩盖语义不明。**

### 13.4 本次已落地的界面改动

* 卡片标题：`msg9.io` → **「消息信箱 - msg9.io」**（主人要求让人知道这是哪一页）
* 地址形状的解释：压成 workspace 清单标题旁的 **「?」悬停提示**（不再占正文，也不恢复整段）
