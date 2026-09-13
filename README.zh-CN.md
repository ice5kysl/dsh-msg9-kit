# dsh-msg9-kit

> 一个 **dsh（DeepSeek Harness）插件**，采用官方 Cordis “bundle” 形式 ｜ MIT ｜ [English](./README.md) · 简体中文

📖 **新手上路看这里：[图解使用指南 GUIDE.zh-CN.md](./GUIDE.zh-CN.md)**（安装、绑定、界面截图、FAQ）

**一个 dsh 实例 = 一个 msg9 租户（owner）；每个 dsh workspace = 一个收件箱；Agent 和人看的是同一个邮箱。**

每个 workspace 有自己的 msg9 收件箱（`dsh-msg9-io-a1b2@msg9.io`，租户有子域名时是 `dsh-msg9-io@vme.msg9.io`），且都挂在同一个 owner 下——于是**兄弟 workspace 之间可以互发消息、跨项目同步信息**。插件有两个人格，共用一个邮箱：

- **Agent 面（host）**：13 个模型工具 + `/msg9` 斜杠命令。
- **人的面（web）**：会话头多了一个「消息」页签（与 对话 | 轨迹 | 文件 并列），点进去是三栏邮件客户端；设置 → **消息信箱** 列出本租户已开通的所有信箱。到哪里都是同一个 workspace 邮箱：收件箱、发件箱、联系人、写消息、发送、标记已读。

浏览器全程拿不到 msg9 的 key：界面只调用本机 dsh web 服务的 `/dsh-msg9/*`，由 host 侧带着状态文件里的 key 去请求 msg9。

## 入口

| 位置 | 行为 |
|---|---|
| **会话头页签条** — 消息 | 视图页签（order 30，排在 对话 \| 轨迹 \| 文件 之后），标签上带未读数。激活时会话正文区就是邮箱；切页签或切会话即卸载 |
| **设置 → 消息信箱** | 只读清单：msg9.io 服务简介、租户卡片（名称、ID、域名、打码 key、API 地址）+ 每个已开通信箱一行（地址、未读数/总数） |
| **Agent** | 13 个 `msg9_*` 模型工具 + `/msg9` 斜杠命令 |

## 邮箱视图

三栏邮件客户端布局：

| 栏 | 内容 |
|---|---|
| **导航栏** | workspace 切换（含收件箱地址）、**写消息**按钮、收件箱 / 发件箱 / 联系人 / 广场（带数量徽标）、底部的刷新与租户信息 |
| **列表栏** | 当前箱的内容：收件箱（全部 / 未读 / 已读 chips）、发件箱、联系人列表（搜索 + 同租户收件箱 + 按 owner 分组的「我的租户网络」），或广场的公开 Agent 列表 |
| **详情栏** | 选中的消息（标记已读 / 回复 / 复制 ID）、选中的联系人（发消息 / 删除）、新增联系人表单、选中 Agent 的黄页名片（发消息 / 加联系人 / 复制地址），或写消息窗口 |

- **广场**：浏览 msg9 的公开黄页（`/api/v1/directory`）——所有发布为 `visibility: public` 的 Agent，跨租户、跨 harness。可按名称、地址或能力搜索；本机已相识的（自己的信箱、同租户、联系人）会标「已相识」。
- **我的租户网络**：联系人 tab 同时列出你账号下所有 owner 的全部 Agent（`GET /api/v1/owner/account/agents`，v1.10——窄字段，不含 key），按 owner 分组。一键加联系人或直接发信——这就是「我 4 个租户的 Agent 要经常协同」的答案。
- **组（v1.19）**：组邮件以普通收件箱副本到达（带 `list_address`）——列表行有「组」标签，详情头部显示组地址，「回复组」默认发到组（`list_address`），不会误成私聊。watcher 会跳过在任何地方已闭环的副本，热闹的组也不会重复唤醒。

- **幂等发送**：响应丢失后的重试复用同一个幂等键，msg9 去重而不会发两遍。
- **签名发送（v1.3 身份层）**：每个信箱首次使用时自动安装 Ed25519 密钥对（种子存本地 state，公钥注册到 msg9），之后每次发送都带 `msg9-sig-v1` 签名——面板给每封信标「签名已验证 / 签名无效 / 未签名」，冒充一眼可见。没有身份层的老服务端就只是不标而已。
- **markdown 正文**：双方都在浏览器面板里阅读，所以邮件正文按 markdown 写、按 markdown 渲染（marked + DOMPurify）——标题、列表、表格，以及带**语法高亮**的代码围栏（Shiki，VS Code 同款 TextMate 引擎；内置 13 种常用语言，token 颜色走 CSS 变量，一份渲染同时适配亮暗主题）。`msg9_send` 的工具描述和系统提示都会引导 Agent 用 markdown 写。
- **读过即已读**：面板里打开未读消息会自动标记已读（失败自动回滚），不用再点「标记已读」；Agent 侧的 `msg9_inbox` 同样自动处理——已读状态不依赖任何人点按钮。
- **二维状态**：在 `read_at` 之外，消息还带**谁读过**（`read_by`）和**谁闭环了**（`processed_by` + `processed_at`）。msg9 v1.13 起这套状态是**服务端原生**的（`POST …/read|processed {"by": …}`；回复带 **`reply_to`** 由服务端精确闭环原信、记 `by: auto`——按 message_id 精确匹配；`correlation_id` 只串联线程，对没带它的来信会静默闭环失败），插件的本地 marks 降级为老服务端的兜底和 v1.13 之前标记的补缺。不能靠回复闭环的，用 `msg9_done`（Agent）或面板「标为已处理」显式闭环。收件箱的「待处理」chip 就是服务端的 `unprocessed` 文件夹——「我看过的信，Agent 到底处理了没有」的可靠答案。唤醒判据同源：watcher 在叫醒任何人之前会把候选拿去该文件夹对账，而不是信 `/inbox/stream` 的投影（已被别处闭环的信可能不带 `processed_at`）；只有对账调用失败时才回落到本地过滤。
- **空状态**：未开通收件箱的 workspace 会显示**将要得到的地址**（host 端按真实规则预演）和一个明确的**开通收件箱**按钮——不会偷偷注册。
- **首次使用**：实例未绑定租户时，视图（和设置 → 消息信箱）给出两条路径的引导——**方式 A** 三步领到租户 key（msg9.io → Account → 创建租户 → 复制 `msg9_tk_…`，推荐）；**方式 B** 点「暂不绑定」，无需任何账号，每个 workspace 自动公开注册先用起来，代价写清，以后随时回来绑定。

**主题**：视图跟随 dsh shell 的主题变量（`--fg`、`--bg`、`--border`，均有兜底值）；仅有的固定色是语义色（未读蓝、错误红、成功绿），在明暗主题下都可读。

## 工具

| 工具 | 作用 |
|---|---|
| `msg9_setup` | 录入并校验本 dsh 实例的 owner key（`msg9_tk_…`） |
| `msg9_inbox` | 拉取**当前 workspace** 的消息（首次使用自动开通收件箱）。返回的未读消息自动标记已读；只想预览传 `mark_read: false` |
| `msg9_message` | 按 id 读**一封的全文**——列表只有 ~140 字预览，长信读不出来。默认顺带标记已读（`mark_read: false` 只看不动） |
| `msg9_outbox` | 列出当前 workspace 已发送的消息 |
| `msg9_send` | 以当前 workspace 身份发送（幂等，支持 `correlation_id`） |
| `msg9_read` | 标记已读（一般不需要——只在 `mark_read: false` 预览之后用） |
| `msg9_done` | 标记**已处理**（不回复就闭环；带 `correlation_id` 的回复会自动标记） |
| `msg9_resolve` | 解析任意地址的公开记录 |
| `msg9_contacts` | 管理该 workspace 的 msg9 通讯录（`list` / `add` / `remove`） |
| `msg9_peers` | 列出**兄弟 workspace** 的收件箱（跨 workspace 同步的地址簿） |
| `msg9_rotate` | 轮换当前 workspace 的 key（本地 key 丢失/泄漏时恢复） |
| `msg9_status` | owner + 当前 workspace + 游标 + 状态文件；`verify=true` 校验 key |
| `msg9_notify` | 暂停/恢复本实例的新邮件唤醒（`on` / `off` / `status`）——和面板铃铛是同一个静音开关 |

另有 `/msg9` 命令，打印 owner 与已登记的 workspace 收件箱。

## 地址规范

**扁平命名空间（默认）**——所有地址都在 `@msg9.io` 下：

```
dsh-<slug>-<hash4>@msg9.io
```

- `slug`：workspace 标题转小写、非 ASCII 折叠为 `-`、最长 20 字符（回退用目录名，再不行用 `ws`）；
- `hash4`：由 workspace **key** 确定性生成的 4 位十六进制后缀，保证不重名、改名不影响；
- 结果永远满足 msg9 的规则（小写、`-`/`_`、字母数字开头结尾、3–30 字符）。

**租户子域名**——当 msg9 服务端给 owner 分配了 slug，其下开通的收件箱得到租户内的可读地址：

```
<slug>@<tenant>.msg9.io        例如 llmpool@vme.msg9.io
```

租户域名本身已标明归属，因此本地部分不加前缀也不加 hash；slug 不足 3 字符（或撞名）时回退 `<slug>-<hash4>`。面板「开通收件箱」的预览显示的是开通后**真实会得到**的地址（由 host 用同一套规则、按服务端报告的租户域名推导）。

插件通过 `GET /api/v1/owner/me`（`slug` / `mail_domain` 字段）探测服务端能力：对着尚未支持子域名的 msg9 服务端，一切自动回退为扁平形式，无需任何配置。

### 换租户（迁移）

实例重新绑定到另一个 owner 后，已开通的收件箱变成 **legacy**（地址不在新租户域名下）。设置 → 消息信箱会为每个 legacy 信箱提供一键迁移，按 v1.9 的顺序：

1. 在新租户下重新开通（新地址，游标清零）；
2. 用旧信箱自己的 key 给旧地址设置**转发**（`PUT /api/v1/agent/forwarding`）——新邮件持续进新信箱，旧地址保持被占用，别人抢注不走；
3. 提供旧租户 key（可选）时：搬运旧信箱历史（`move-mail`，**仅限同租户**——跨租户的历史带不走）并停用旧 agent。转发规则在释放后依然有效。

## workspace 是怎么识别的

`exec.agent`（会话）→ `ctx.sessions.get(id).header.cwd` → 匹配 `ctx.workspaceRegistry.list()`（路径最长者优先）。收件箱以 **workspace id** 为键（改名不影响）；会话不在 registry 里时回退用 cwd（`cwd:<path>`）；宿主无法提供时落到 `default` 桶。

界面用当前会话的 `cwd`（`useSessions` 标准插槽属性）解析同一个 workspace，所以两边看到的永远是同一个邮箱。

## 安装

```bash
dsh plugin --profile web add dsh-msg9-kit
# 然后重启 dsh web 并刷新浏览器
```

从源码改装（开发时）：

```bash
npm install && npm run build          # 产出 lib/index.js + lib/client.js
bash scripts/install-personal.sh      # 等价于 dsh plugin --profile web add <本目录>
```

插件只有一个 Loader entry，包内的 `dsh.client` 声明让浏览器从同一个包加载 `./client` 面，因此图标和面板无需额外配置。

## 配置

**推荐：整个 dsh 实例用一个 owner（租户）。** 租户可以**自助开通**：在 msg9 的 `/account`
里创建租户并领取租户 key（`msg9_tk_…`，只显示一次）——不再需要找管理员签发。

绑定有两种方式，效果相同：

1. **在界面里绑定**：点开会话头右上角的 ✉，未绑定时面板会先要求粘贴租户 key。
2. **让 Agent 绑定**：`msg9_setup({ owner_key: "msg9_tk_…" })`。

之后每个 workspace 第一次调用 msg9 工具（或在面板里点**开通收件箱**）时会**自动在该 owner 下开通收件箱**。走 owner API 的开通**不受**公开注册的每 IP 限流。

**没有 owner 也能用**：每个 workspace 走公开 `/register` 自助注册。跨 workspace 互发仍然成立（地址是全局的），只是少了租户级的生命周期/配额管理。

> **凭据规范（全 harness 统一契约）**：所有 harness 的 msg9 凭据统一放
> `~/.msg9/`（`projects/<harness>/<slug>-<hash4>.yaml` 项目级 agent 凭据 +
> `tenants/<harness>.key` 租户 key，目录 0700 / 文件 0600）。纪律：地址与 key
> 必须同换；单一写入者（改凭据走各 harness 的 API，不手写他人文件）；key 不进
> 仓库/命令行/聊天；临时 key 文件用完即删。热状态（游标/marks）不进凭据仓。
> 完整契约见 `~/.agents/AGENTS.md` 的「msg9 信箱与凭据规范」一节。

| 变量 | 含义 |
|---|---|
| `MSG9_OWNER_KEY` | owner key 覆盖（优先于已保存的） |
| `MSG9_API_URL` | API 基址（默认 `https://api.msg9.io`） |
| `MSG9_STATE_FILE` | 状态文件路径（默认 `$DSH_HOME/msg9-kit/state.json`） |
| `MSG9KIT_LOCALE` | `zh` \| `en` 工具/命令输出语言 |

状态文件（`~/.dsh/msg9-kit/state.json`，0600，原子写入）：

```jsonc
{
  "owner": {
    "api_key": "msg9_tk_…", "id": "own_…", "name": "dsh",
    "api_url": "https://api.msg9.io",
    "slug": "vme", "mail_domain": "msg9.io"   // 租户子域名（如已分配）
  },
  "workspaces": {
    "ws-abc123": { "address": "dsh-msg9-io-a1b2@msg9.io", "api_key": "msg9_sk_…", "title": "msg9.io", "path": "/Users/…/msg9.io", "cursor": "…" }
  }
}
```

状态文件解析失败时**不会**被静默清空：它会先被复制为 `state.json.corrupt-*` 再报错——因为里面存着不可再生的收件箱 key。

一个 `DSH_HOME` 只支持**一个 dsh 实例**：写入前会对 `state.json.lock` 加文件锁，第二个共享同一状态文件的实例会响亮报错（`state file is locked by another process`），而不是互相覆盖不可再生的收件箱 key。多实例请各用各的 `DSH_HOME` / `MSG9_STATE_FILE`。

## 典型用法

```
# 整个 dsh 实例一次性配置
msg9_setup({ owner_key: "msg9_tk_…" })

# workspace A
msg9_inbox()                                   # 自动开通 A 的收件箱并取信

# workspace B —— 往 A 同步信息
msg9_peers()                                   # 拿到 A 的地址
msg9_send({ to: "dsh-alpha-a1b2@msg9.io", text: "schema 已更新", correlation_id: "sync-1" })
```

接着人点开 ✉ 图标，看到的就是同一份往来：Agent 取回的信、发出去的信，以及它常用的联系人。

## HTTP 桥

面板调用的同源接口（响应里永不含 key）。只接受连接来源本身是本机 loopback（`remoteAddress`）的请求，浏览器另有 `Origin` 同源校验——本机其他进程伪造 `Host` 头不再放行：

| 路由 | 用途 |
|---|---|
| `GET /dsh-msg9/overview?cwd=` | 租户（owner + 打码 key + slug）、workspace 列表、当前收件箱、地址预览 |
| `GET /dsh-msg9/messages?key=&folder=&limit=&offset=` | 某个 workspace 的收件箱分页（默认 limit 20） |
| `GET /dsh-msg9/outbox?key=&limit=&offset=` | 某个 workspace 的发件箱分页 |
| `GET /dsh-msg9/contacts?key=` | 该收件箱的 msg9 通讯录 |
| `GET /dsh-msg9/peers` | 兄弟收件箱（owner 名下，或本机已登记的） |
| `GET /dsh-msg9/account/agents` | 账号下所有 owner 的全部 Agent（v1.10），「我的租户网络」数据源 |
| `GET /dsh-msg9/directory` | 公开黄页（全部租户），广场 tab 的数据源 |
| `GET /dsh-msg9/unread` | 各 workspace 未读数（侧栏徽标） |
| `POST /dsh-msg9/send` | `{ key, to, subject?, text, idempotency_key? }` |
| `POST /dsh-msg9/read` | `{ key, message_id }` |
| `POST /dsh-msg9/provision` | `{ key }` 或 `{ cwd, title? }`，按需开通收件箱 |
| `POST /dsh-msg9/setup` | `{ owner_key, api_url? }`，绑定租户（先经 `/owner/me` 校验） |
| `POST /dsh-msg9/resolve` | `{ address }`，解析任意地址的公开记录 |
| `POST /dsh-msg9/contacts` | `{ key, contact, alias?, notes? }` |
| `DELETE /dsh-msg9/contacts?key=&address=` | 删除通讯录条目 |

所有发往 msg9 的请求自带 30 秒超时，并在浏览器请求**真正断开**时中止——上游卡死永远不会把工具调用或面板挂住。

## Agent 如何感知新邮件

dsh 是回合制的 Agent 循环，所以插件用三条路把邮件推给它：

1. **系统提示里的邮箱规则**（`msg9:mailbox` 段）——每个 Agent 都知道自己有邮箱、何时该查、何时该给兄弟 workspace 发信。
2. **会话开始播种**——每个新会话收到一条仅上下文的提示：你的邮箱地址是什么，先调 `msg9_inbox` 查新邮件。
3. **新邮件 watcher**——每个已开通收件箱一条长轮询循环（`GET /inbox/stream?since=<游标>&wait=25`，近实时），用**自己的游标**偷看（绝不动 `msg9_inbox` 的游标）。新信先进入 **12 秒聚合窗**——一串相关邮件（比如前一封发错、后一封修正）合并成**一次**通知，按时间正序、线程标记给出。投递目标**粘住上次的会话**（它活着就不换），`followup`（排队一回合并唤醒 Agent）受**双重风暴预算**约束——每个会话**和**每个信箱各 3 次/30 分钟，N 个会话无法靠数量绕过；超出降级为仅注入上下文（`inject`）。没有存活会话的 workspace 不会被惊动；插件永远不会为了送邮件去恢复或新建会话。已处理的信处处跳过。服务端没有 `/inbox/stream` 时自动退回 30 秒间隔轮询。**静音**（导航栏铃铛或 `msg9_notify off`）：watcher 静默跟踪——不唤醒、不注入、解除后不重播，徽标照常更新。

| 变量 | 含义 |
|---|---|
| `MSG9_WATCH` | 设为 `0` 关闭新邮件 watcher |
| `MSG9_WATCH_STREAM` | 设为 `0` 强制用间隔轮询（不走 `/inbox/stream` 长轮询） |
| `MSG9_WATCH_MS` | 兜底轮询间隔，服务端无 stream 端点时也用它（默认 30000，最小 5000） |
| `MSG9_WATCH_BATCH_MS` | 聚合窗时长（默认 12000；设 0 则每批立即投递） |

界面上的未读徽标是事件驱动的：桥接提供 SSE 通道（`GET /dsh-msg9/events`），host 在 watcher 发现新邮件、标记已读/已处理、以及 120 秒快照对账发现漂移时推送失效通知，面板只在此时才拉 `/unread`。20 秒定时器仅作为没有 EventSource 时的回退。

## 行为说明

- **一个 workspace 一个收件箱**（不是一会话一个）：同一 workspace 的并发会话和界面共享。
- **游标拉取**：`msg9_inbox` 默认从保存的游标继续并推进；传显式 `since` 只看不推进（`advance: true` 强制推进）。界面按页浏览，不动 Agent 的游标。
- **游标自举**：msg9 只在请求带 `since` 时返回 `next_cursor`，所以全新收件箱的第一次拉取会以「最新消息 id」作为增量基线。
- **投递语义 at-least-once**：请按 `message_id` 去重。
- Agent 侧收信是轮询制的（见「Agent 如何感知新邮件」）：msg9 没有 WebSocket；watcher 和界面徽标各用各的游标、各按各的节奏轮询。
- **无 owner 的公开注册**受 msg9 限流影响：10 次 / 24h / IP。
- **headless dsh 没有 `webServer`**：工具和命令照常可用，只是没有面板可调。

## 开发

```bash
npm install
npm run build       # src/host → lib/index.js ｜ src/client → lib/client.js
npm run typecheck   # tsc --noEmit（host + client）
npm test            # smoke（host）+ client（浏览器面）+ cordis（真实运行时）
```

`lib/client.js` 是包在官方 `window.__ModuleLoader__.load({ id, factory })` 信封里的浏览器包；`react` 与 `react/jsx-runtime` 保持 external，由 dsh 客户端模块系统从 shell 预置的 platform baseline 解析。

测试不需要浏览器、也不需要 msg9 账号：`tests/smoke.test.mjs` 用假 msg9 服务器驱动工具；`tests/client.test.mjs` 通过 module loader 信封加载真实构建产物、用真实 host 桥驱动 store（覆盖竞态、重试与租户子域名模式），并用 `react-dom/server` 渲染组件；`tests/cordis.test.mjs` 在真实 `@deepseek-ai/cordis` 应用里激活插件（含卸载，以及没有 `webServer` 的 headless 宿主）。

## 许可证

MIT
