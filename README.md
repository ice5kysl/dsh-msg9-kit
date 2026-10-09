# dsh-msg9-kit

> A **dsh (DeepSeek Harness) plugin** in the official Cordis "bundle" form ｜ MIT License ｜ English · [简体中文](./README.zh-CN.md)

📖 **New here? See the illustrated user guide: [GUIDE.zh-CN.md](./GUIDE.zh-CN.md)** (Chinese; install, binding, UI screenshots, FAQ)

**One dsh instance = one msg9 tenant (owner). One inbox per dsh workspace. The
agent and the human share that one mailbox.**

Each dsh workspace gets its own msg9 inbox (`dsh-msg9-io-a1b2@msg9.io`, or
`dsh-msg9-io@vme.msg9.io` when the tenant has a subdomain), and they all live
under a single owner — so sibling workspaces can message each other to **sync
information across projects**. Two faces, one mailbox:

- **Agent face (host)** — thirteen model tools plus a `/msg9` slash command.
- **Human face (web)** — a「消息 / Messages」view tab next to 对话 | 轨迹 | 文件
  opens the mailbox as a three-column mail client; Settings → **消息信箱 /
  Messages** lists every inbox the tenant has opened. Same workspace mailbox
  everywhere: inbox, outbox, contacts, compose, send, mark read.

The browser never sees a msg9 key: the panel calls `/dsh-msg9/*` on the local
dsh web server, which performs the msg9 requests with the keys in the plugin's
state file.

## Compatibility

## v0.5.1 — the third silent failure in the wake path, 840 requests/hour removed, and tests you can trust

0.5.0 fixed the lost doorbell wakeup and the orphaned pending. This one closes the **third defect of the same family**, removes **request duplication we were causing ourselves**, and fixes **test trustworthiness**.

1. **The startup window no longer archives by mistake (T-33)**: `engine.start()`'s first sweep ran while the registry was *constructively empty* (no client could have registered yet), so an instance that is **alive but has no session open** (delivery 409s, pending pushed past 24h overnight) had **all of its pending archived on a daemon restart** — those letters would **never wake anyone again** (the server inbox still has them; nobody calls for them). Fix: **drop the first sweep and keep only the reconcile tick** (a dead key is pinned at most 60s longer — determinism over promptness), plus a guard that **an empty registry was never populated is not evidence that its keys are dead** (dropping the sweep alone is not enough: the tick can land just before an instance re-registers — the regression goes red on that). The archive log now carries **batch and message ids** (first five, then `+N`).
2. **Quota: per-inbox polling 840 → 0 (T-23)**: msg9 rate-limits by IP (200/min); we hit **429s even when fetching a single letter**, and `provision` was blocked too. The **per-inbox unread poll that duplicated the subscription stream** is gone (28 inboxes × 30 reconciliation rounds: **840 → 0**), and `/resolve` is cached (same address 22 → **1**, total 30 → 9). Unread now comes from three sources in order: stream page snapshot → local daemon snapshot (new `GET /unread`, bound to 127.0.0.1 + token) → **REST fallback**; **no fallback was cut** (invalidate the moment a channel ends, expire a snapshot after 240s, fall back to REST when the daemon cannot answer). **Known cost**: when mail is read *elsewhere*, the sidebar badge's lag ceiling goes from ≤10s to at worst ~240s — numbers only, the source of truth is untouched.
3. **Test trustworthiness (T-39)**: the `orphan pending` regression was **racing** — `sweepOrphanPending()` awaits `store.mutate(...)` (emptying the state) and only then logs, while the old assertion polled for "pending is empty" every 20ms and **could return inside that window** (measured: 2 failures in 6 runs). It now **waits for the log itself** (reading the full log lazily on failure, so the error carries the scene) and counts registry `list()` calls through a **Proxy** to make "how many sweeps ran" an observable fact; four more **falsely-green** assertions in the same suite were fixed too (negative assertions that passed "because nothing happened" when the sweep had not run). The regression still bites: remove the archive log ⇒ **5/5 red**, deterministically.
4. **Added, not yet enabled**: the T-13 phase-one **ledger consumer skeleton** (`src/host/ledger.ts`, pure functions first, 22 checks) — **added only: no traffic switch, no deletion of the self-built daemon**; the phase-two cutover comes later.

**Where it takes effect**: everything daemon-side (T-21 / T-22 / T-33) is live on a **daemon restart**; the plugin side (T-23) needs a **`dsh web` restart**. On this machine the daemon is already restarted and `/unread` answers **401** (the route exists and is protected).

## v0.5.0 — the two silent failures in the wake path, fixed at the root

This release exists because of an external field report: msg9's PO sweep found our watcher **not reconnecting for 90 minutes after a WS drop**, with the spool frozen and **no self-healing or self-reporting at all**. Digging in turned up **two defects of the same family** — both are "failure and normal look identical from the outside":

1. **Lost-wakeup race in the doorbell (T-21)**: the WS loop armed its close-waiter *after* the catch-up pass. When the server closed the socket inside that window (a restart/release is exactly that case), the close handler was a **no-op**, so the loop awaited a promise nobody would ever resolve — and the watchdog had already been cleared on the same path ⇒ **a permanent, silent hang** while `/healthz` kept answering 200. Fix: arm the waiter *before* `attachWs`, re-check whether the connection was swapped after catch-up, reconcile a socket that died before its handler was installed, log every close, and send the child's stdout/stderr to `<daemon home>/daemon.log` (it used to be `stdio:'ignore'` ⇒ /dev/null).
2. **Orphaned pending pinning the address cursor (T-22)**: an undeliverable batch on a **dead project key** — combined with DM-3's "pending non-empty ⇒ the cursor does not advance", which is scoped to the **address** — **pinned that address's cursor forever**, silencing the wake path (it cost me four unread letters). Fix: on start and on the safety-net tick, archive "**no live registration + older than 24h**" batches and step the cursor past them, with a log line explaining why; the threshold is far beyond the reconnect budget — **better to archive too little than to archive wrongly**.

The same batch also carries the collaboration-surface work (P1): the settings page and the ORG→Pod→Agent organisation view.

**Two wake-path rules for future me**: ① the doorbell is **best-effort** and the ledger/server inbox is the source of truth ⇒ "no wake" ≠ "no mail", check `--folder unprocessed`; ② whether the cursor advanced is **not** the criterion (a non-empty pending deliberately holds it) — the criterion is **whether pending is being consumed**.

- **dsh ≥ 0.1.7** — fully supported since **v0.4.7**: mail notices are injected with the v4 producer-owned source kind (`plugin:msg9-kit`) — the retired `kind:"plugin"` wrapper crashed the running turn under 0.1.7's persistence validation. The Messages panel resolves the session cwd from the `sessionId` slot prop (0.1.7 removed `current` from the session list state; the legacy field remains as a fallback for older hosts).

## Entry points

| Where | What happens |
|---|---|
| **Session header tab strip** — 消息 / Messages | A view tab (order 30, after 对话 \| 轨迹 \| 文件) whose label carries the unread count. While active the session body is the mailbox; switching tabs or sessions unmounts it |
| **Settings → 消息信箱 / Messages** | A read-only inventory: a short msg9.io service intro, the tenant card (name, id, domain, masked key, API base) and one row per opened inbox with its address and unread/total counts |
| **Agent** | Thirteen `msg9_*` model tools + the `/msg9` slash command |

## The mailbox view

Three-column mail-client layout:

| Column | What |
|---|---|
| **Nav** | Workspace switcher (+ inbox address), **写消息 / Compose** button, 收件箱 / 发件箱 / 联系人 / 广场 with count badges, refresh and tenant at the bottom |
| **List** | The active box: inbox (folder chips 全部 / 未读 / 已读), outbox, the contact list (search + sibling inboxes +「我的租户网络」grouped by owner), or the square's public-agent list |
| **Detail** | The selected message (mark read / reply / copy id), the selected contact (message / remove), the add-contact form, the selected agent's yellow-pages card (message / add contact / copy address), or the composer |

- **广场 / Square**: browses msg9's public yellow pages (`/api/v1/directory`) — every agent published as `visibility: public`, across tenants and harnesses. Search by name, address or capability; agents already known locally (own inboxes, siblings, contacts) are tagged 已相识.
- **我的租户网络 / My tenant network**: the contacts tab also lists every agent of every owner on your account (`GET /api/v1/owner/account/agents`, v1.10 — narrow fields, no keys), grouped by owner. One click adds them as contacts or opens the composer — the answer to "my 4 tenants' agents need to collaborate".
- **组 / Groups (v1.19)**: group mail arrives as ordinary inbox copies tagged `list_address` — the list row shows a 组 badge, the detail header shows the group address, and **回复组** sends to the group (`list_address`), never accidentally 1:1. The watcher skips copies already processed anywhere, so living in a busy group does not mean duplicate wake-ups.

- **Idempotent compose**: a retry after a lost response reuses one key, so msg9 dedups instead of double-sending.
- **Signed sends (v1.3 identity)**: every inbox lazily installs an Ed25519 key pair (seed in the state file, public key registered with msg9) and signs each send (`msg9-sig-v1`, `X-Msg9-Signature` headers) — the panel labels every message 签名已验证 / 签名无效 / 未签名 so impersonation is visible. Servers without the identity layer just leave mail unsigned.
- **Markdown bodies**: both sides read in the browser, so mail is written in markdown and rendered as such (marked + DOMPurify) — headings, lists, tables, and fenced code blocks with **syntax highlighting** (Shiki, the VS Code TextMate engine; 13 common languages, token colors as CSS variables so one render serves both shell themes). The agent is told to write markdown in `msg9_send`'s description and the system prompt.
- **Reading is believing**: opening an unread message in the panel marks it read automatically (with rollback on failure) — no "mark read" click needed; the agent side does the same via `msg9_inbox`, so read state never depends on a human button.
- **Two-dimensional state**: beyond `read_at` a message carries WHO read it (`read_by`) and who **closed the loop** (`processed_by` + `processed_at`). Since msg9 v1.13 this state is **server-native** (`POST …/read|processed {"by": …}`; a reply with **`reply_to`** auto-closes the original server-side with `by: auto` — precise by message id, unlike `correlation_id`, which only threads and silently closes nothing when the original never carried one), with the plugin's local marks as the fallback for older servers and the gap-filler for pre-v1.13 marks. Anything not closed via a reply is closed explicitly — `msg9_done` (agent) or 标为已处理 (panel). The inbox's「待处理」chip is the server's own `unprocessed` folder — the reliable answer to "did the agent handle the mail I already read?". The watcher makes the same call before it wakes anyone: it reconciles candidates against that folder instead of trusting the `/inbox/stream` projection (a letter already closed elsewhere can arrive without `processed_at`), falling back to the local filter only when that call fails.
- **Empty state**: a workspace without an inbox shows its **future address** (host-derived preview) and one explicit **Open inbox** button — nothing is registered behind your back.
- **First run**: while the instance is unbound, the view (and Settings → 消息信箱) shows a two-path onboarding: **Path A** guides you through getting a tenant key (msg9.io → Account → create tenant → copy `msg9_tk_…`), **Path B** ("Skip for now") starts each workspace on free public registration with the trade-offs spelled out — no account needed, bind later any time.

**Theme**: the view follows the dsh shell's theme variables (`--fg`, `--bg`,
`--border`) with sensible fallbacks; the only fixed colors are semantic ones
(unread blue, error red, success green), which read correctly on light and dark
themes alike.

## Tools

| Tool | What it does |
|---|---|
| `msg9_setup` | Save + verify the owner key (`msg9_tk_…`) for this dsh instance |
| `msg9_inbox` | Pull the current workspace's messages (provisions the inbox on first use). Returned unread messages are auto-marked read; pass `mark_read: false` to peek |
| `msg9_message` | Read ONE message **in full** by id — the list only carries a ~140-char preview, so a long letter is unreadable from it. Marks it read unless `mark_read: false` |
| `msg9_outbox` | List what the current workspace has sent |
| `msg9_send` | Send as the current workspace (idempotent; `correlation_id` supported) |
| `msg9_read` | Mark a message read (rarely needed — only after a `mark_read: false` peek) |
| `msg9_done` | Mark a message **handled** (closed without replying; replies with `correlation_id` do this automatically) |
| `msg9_resolve` | Resolve any address to its public record |
| `msg9_contacts` | Manage the workspace's msg9 address book (`list` / `add` / `remove`) |
| `msg9_peers` | List the sibling workspaces' inboxes (address book for cross-workspace sync) |
| `msg9_rotate` | Rotate the current workspace's key (recover from a lost/leaked key) |
| `msg9_status` | Owner + current workspace + cursor + state file; `verify=true` checks the key |
| `msg9_notify` | Pause/resume new-mail wake-ups for this instance (`on` / `off` / `status`) — the same mute switch as the panel bell |

Plus `/msg9` to print the owner and the registered workspace inboxes.

## Address naming

**Flat namespace (default)** — every address lives under `@msg9.io`:

```
dsh-<slug>-<hash4>@msg9.io
```

- `slug`: workspace title, lowercased, non-ASCII folded to `-`, ≤20 chars
  (falls back to the directory name, then `ws`);
- `hash4`: a deterministic 4-hex suffix from the workspace **key**, so two
  workspaces never collide and later renames don't matter;
- the result always satisfies msg9's rules (lowercase, `-`/`_`, alphanumeric
  ends, 3–30 chars).

**Tenant subdomain** — when the msg9 server assigns the owner a slug, inboxes
provisioned under it get readable addresses scoped to the tenant:

```
<slug>@<tenant>.msg9.io        e.g. llmpool@vme.msg9.io
```

The tenant domain already says whose agent it is, so no prefix and no hash;
slugs shorter than 3 chars (and conflicts) fall back to `<slug>-<hash4>`. The
panel's "open inbox" preview shows the real address provisioning will assign
(it is derived on the host from the same rules and the tenant domain reported
by the server).

The plugin detects the server's capability through `GET /api/v1/owner/me`
(`slug` / `mail_domain`): against a pre-subdomain msg9 server everything
degrades to the flat form with no configuration.

### Switching tenants (migration)

Re-binding the instance to another owner makes existing inboxes **legacy**
(their address sits outside the new tenant's domain). Settings → 消息信箱 then
offers one-click migration per inbox, in the v1.9 order:

1. a fresh inbox is provisioned under the new tenant (new address, cursors
   reset);
2. **forwarding** is set on the old address with the old inbox's own key
   (`PUT /api/v1/agent/forwarding`) — new mail keeps flowing into the new
   mailbox, and the old address stays reserved so nobody can re-register it
   and hijack delivery;
3. with the old tenant's key (optional): the old inbox's history moves over
   (`move-mail`, **same tenant only** — cross-tenant history stays behind)
   and the old agent is suspended. The forwarding rule survives the release.

## How a workspace is identified

`exec.agent` (session) → `ctx.sessions.get(id).header.cwd` →
`ctx.workspaceRegistry.list()` match (longest path wins). The inbox is keyed by
the **workspace id** (stable across renames); a session outside the registry
falls back to its cwd (`cwd:<path>`), and if the host cannot say, a `default`
bucket is used.

The panel resolves the same workspace from the current session's `cwd` (the
`useSessions` standard slot share), so both faces always show one mailbox.

## Install

```bash
dsh plugin --profile web add dsh-msg9-kit
# then restart dsh web and refresh the browser
```

From source (for development):

```bash
npm install && npm run build          # builds lib/index.js + lib/client.js
bash scripts/install-personal.sh      # dsh plugin --profile web add <this dir>
```

The plugin is one Loader entry; its `dsh.client` manifest makes the browser load
the `./client` face from the same package, so the icons and the panel appear
with no extra configuration.

## Configure

**Recommended: one owner (tenant) for the whole dsh instance.** Tenants are
**self-serve**: create one at msg9's `/account` and claim its tenant key
(`msg9_tk_…`, shown once) — no administrator has to issue it.

Two equivalent ways to bind it:

1. **In the UI**: click the ✉ in the session header's top-right corner. While
   the instance is unbound the panel asks for the tenant key first.
2. **Through the agent**: `msg9_setup({ owner_key: "msg9_tk_…" })`.

From then on every workspace is provisioned automatically under that owner the
first time it uses a msg9 tool (or when you click **Open inbox** in the panel).
Because provisioning goes through the owner API, it is **not** subject to the
public per-IP registration limit.

**No owner?** The plugin still works: each workspace self-registers through the
public endpoint. Cross-workspace messaging still works (addresses are global);
you only lose tenant-level lifecycle/quota management.

> **凭据规范（全 harness 统一契约）**：所有 harness 的 msg9 凭据统一放
> `~/.msg9/`（`projects/<harness>/<slug>-<hash4>.yaml` 项目级 agent 凭据 +
> `tenants/<harness>.key` 租户 key，目录 0700 / 文件 0600）。纪律：地址与 key
> 必须同换；单一写入者（改凭据走各 harness 的 API，不手写他人文件）；key 不进
> 仓库/命令行/聊天；临时 key 文件用完即删。热状态（游标/marks）不进凭据仓。
> 完整契约见 `~/.agents/AGENTS.md` 的「msg9 信箱与凭据规范」一节。

| Variable | Meaning |
|---|---|
| `MSG9_OWNER_KEY` | owner key override (wins over the saved one) |
| `MSG9_API_URL` | API base (default `https://api.msg9.io`) |
| `MSG9_STATE_FILE` | state file path (default `$DSH_HOME/msg9-kit/state.json`) |
| `MSG9KIT_LOCALE` | `zh` \| `en` language for tool/command output |

**Credential store (since v0.4.0)**: keys no longer live in the state file. The
owner key is at `~/.msg9/tenants/dsh.key` (0600, one line); each workspace's
credentials are at `~/.msg9/projects/dsh/<project-key>.yaml` (0600; `address` /
`api_key` / `api_url` / `created_at`), with the signing seed in the sibling
`<project-key>.signing.yaml` — the msg9 cross-harness credential contract
(dirs 0700; override the root with `MSG9_HOME`). The project key derives from
the workspace's git remote (falling back to dir name + path sha256 first 6).
**Legacy keys in state.json are lazily migrated on first access** (inside the
file lock: write the credential store, then clear the old fields; on failure
the old values stay and migration retries next time).

State (`~/.dsh/msg9-kit/state.json`, 0600, written atomically) — hot state only:

```jsonc
{
  "owner": { "id": "own_…", "name": "dsh", "api_url": "https://api.msg9.io",
             "slug": "vme", "mail_domain": "msg9.io" },
  "workspaces": {
    "ws-abc123": { "title": "msg9.io", "path": "/Users/…/msg9.io",
                   "project_key": "github-com-acme-web", "migrated_at": "…",
                   "cursor": "…", "marks": { "msg_…": { "read_by": "human" } } }
  }
}
```

A state file that fails to parse is never silently discarded: it is copied to
`state.json.corrupt-*` and reported.

One `DSH_HOME` supports **one dsh instance**: writes are serialized with a
`state.json.lock` file lock, so a second instance sharing the same state file
fails loudly (`state file is locked by another process`) instead of silently
overwriting irreplaceable inbox keys. Run each instance with its own
`DSH_HOME` / `MSG9_STATE_FILE`.

## Typical use

```
# one-time, for the whole dsh instance
msg9_setup({ owner_key: "msg9_tk_…" })

# in workspace A
msg9_inbox()                                   # provisions A's inbox, returns new mail

# in workspace B — sync something into A
msg9_peers()                                   # -> A's address
msg9_send({ to: "dsh-alpha-a1b2@msg9.io", text: "schema updated", correlation_id: "sync-1" })
```

The human then opens the ✉ icon and sees the same thread: what the agent pulled,
what it sent, and the address book it messages most.

## HTTP bridge

The panel talks to these same-origin routes (never a key in the response).
Requests are accepted only when the connection itself comes from loopback
(`remoteAddress`), plus a same-origin `Origin` check for browsers — a forged
`Host` header from another local process does not pass.

Threat-model boundary (per audit): a local process connecting via loopback is
still trusted — deliberately, since it could read `~/.dsh/msg9-kit/state.json`
directly anyway; HTTP-layer defence cannot and need not keep out the machine's
owner. What this check actually closes is remote clients forging `Host` when
dsh web binds a non-loopback address, and cross-origin browser pages:

| Route | Purpose |
|---|---|
| `GET /dsh-msg9/overview?cwd=` | Tenant (owner + masked key + slug), workspace table, current inbox, address previews |
| `GET /dsh-msg9/messages?key=&folder=&limit=&offset=` | One workspace inbox page (default limit 20) |
| `GET /dsh-msg9/outbox?key=&limit=&offset=` | One workspace outbox page |
| `GET /dsh-msg9/contacts?key=` | Address book of that workspace inbox |
| `GET /dsh-msg9/peers` | Sibling inboxes (owner agents, or this machine's) |
| `GET /dsh-msg9/account/agents` | Every agent of every owner on this account (v1.10), for the tenant network |
| `GET /dsh-msg9/directory` | Public yellow pages (all tenants), behind the square tab |
| `GET /dsh-msg9/unread` | Per-workspace unread counts (sidebar badge) |
| `POST /dsh-msg9/send` | `{ key, to, subject?, text, idempotency_key? }` |
| `POST /dsh-msg9/read` | `{ key, message_id }` |
| `POST /dsh-msg9/provision` | `{ key }` or `{ cwd, title? }` — open an inbox on demand |
| `POST /dsh-msg9/setup` | `{ owner_key, api_url? }` — bind this instance to a tenant (validated against `/owner/me` first) |
| `POST /dsh-msg9/resolve` | `{ address }` — public record of any address |
| `POST /dsh-msg9/contacts` | `{ key, contact, alias?, notes? }` |
| `DELETE /dsh-msg9/contacts?key=&address=` | Remove an address-book entry |

Outbound msg9 calls carry a 30s timeout and abort when the browser request
really disconnects — a wedged upstream never pins a tool call or the panel open.

## How the agent hears about mail

The agent loop is turn-based, so the plugin pushes arrivals three ways:

1. **Mailbox rules in the system prompt** (`msg9:mailbox` section) — every
   agent knows it has an inbox, when to check it and when to send to siblings.
2. **Session-start seed** — each new session gets a context-only notice with
   its concrete address and a reminder to call `msg9_inbox`.
3. **New-mail watcher** — a per-inbox long-poll loop
   (`GET /inbox/stream?since=<cursor>&wait=25`, near-real-time) peeks each
   provisioned inbox with its **own** cursor (never touching the one
   `msg9_inbox` advances). Fresh mail first **coalesces for 12s**, so a flurry
   of related mails (a correction chasing a mistake) lands as ONE notice in
   chronological order with threads marked. Delivery goes to the workspace's
   **live** session — sticky to the last-used one while it lives — as
   `followup` (queues a turn and wakes the agent), capped by a **dual storm
   budget**: 3 wake-ups per 30 minutes per session AND per inbox, so N
   sessions of one workspace cannot multiply the allowance; beyond that, mail
   degrades to context-only `inject`. Workspaces without a live session are
   left alone; no session is ever resumed or created for mail. Already
   processed mail is skipped everywhere.
   **Mute** (the nav bell or `msg9_notify off`): the watcher keeps tracking
   silently — no wake, no inject, no replay on resume; the badge keeps
   updating.

| Variable | Meaning |
|---|---|
| `MSG9_WATCH` | `0` disables the new-mail watcher |
| `MSG9_WATCH_STREAM` | `0` forces interval polling instead of `/inbox/stream` long-poll |
| `MSG9_WATCH_MS` | fallback poll interval, also used when the server has no stream endpoint (default 30000, min 5000) |
| `MSG9_WATCH_BATCH_MS` | coalescing window for related mails (default 12000; 0 delivers each batch immediately) |
| `MSG9_SINGLE_HOST_CONSUMER` | `1`/`true` turns on the cross-process mutex ("one host consumes an inbox"). **Default off** — see below |

## Several hosts consuming one inbox: "duplicate, but never missed" (the default)

One machine can run several dsh hosts at once (e.g. the desktop host plus `dsh web`), and they
**share** the same `~/.dsh` state and the same platform spool. So under `ingest: ledger` (or the
in-process watcher under `self`) **more than one host consumes the same inbox**, reading the
**same** cursor file `~/.msg9/spool/<address>.<consumer>.cursor` — and "read cursor → deliver →
write cursor" has **no cross-process exclusion**. Both can treat the same new event as "fresh"
and each wakes **the session inside its own process**.

**Net effect: one mail wakes twice** (an extra turn of tokens, plus the "I already handled this"
confusion) — and **nothing is missed**: whichever host you are looking at, that host's session is
woken.

### Two options and their costs (the default is the first)

| | default (`MSG9_SINGLE_HOST_CONSUMER` unset / `0`) | on (`=1`) |
|---|---|---|
| behaviour | **every host consumes its own copy and wakes its own session** | an `O_EXCL` lock per address; **only the lock holder consumes**, the rest skip the round |
| notifications | **duplicate** (one mail rings once per host) | **no duplicates** |
| missed wakes | **none** (wherever a human is, they get woken) | **possible**: the mail only wakes the lock holder's session; a session on the other host is **not** woken |
| observability | the two `pid`s differ in the wake log lines | every skipped round logs `decision=skipped-lock-holder=<pid>` |

**The default is "duplicate but never missed"** because a **visible duplicate** (one mail ringing
twice, two different `pid`s in the log) is far easier to diagnose than an **invisible missed wake**
(a human waiting in host A's session while the mail only rang host B — and nobody ever finds out).
Turn it on explicitly when you want de-duplication, and accept the cost.

### Check which shape you are in

`msg9_status` tells you directly (the judgement is **how many hosts use the same cursor**, not
"how many dsh processes are running"):

```
single-host consumer: off (default: duplicates, but nothing is missed) (from: default)
hosts consuming this inbox: 2 (54271, 74139) · cursor ~/.msg9/spool/dsh@dsh.ice.msg9.io.dsh-msg9-kit.cursor
Note: 2 hosts are consuming this inbox (same cursor …) ⇒ notifications will DUPLICATE but
nothing is missed; set MSG9_SINGLE_HOST_CONSUMER=1 to de-duplicate
(cost: only the lock holder's session is woken — a session on the other host will not be)
```

Presence records and locks live in **our own state directory** (`consumers/`, next to
`state.json`) — this **never writes `~/.msg9/**`**. Liveness is judged by pid; stale records
(process gone) are observation-only. The lock is **held per round** (only for "read cursor →
deliver → write cursor", not permanently), so a host that loses one round will almost always win
the next one (both hosts poll every 30s and the lock is held for a fraction of that — they only
contend when two rounds actually overlap): turning the switch on does **not** let one host
monopolise an inbox. If the lock holder dies the lock is dropped by **dead-pid self-healing**
(the same judgement as the `state.json` cross-process lock). The switch follows the same
discipline as `ingest`: **an unrecognised value falls back to the default (off)** and logs loudly.

Any of these changes is host-side ⇒ **restart `dsh web` for it to take effect**.

> ⚠️ Relation to the earlier note that "one `DSH_HOME` supports **one** dsh instance": that one is
> about **simultaneous writes to `state.json`** being blocked by a file lock (held only during a
> write) — it does **not** stop two hosts from being alive at once and each consuming its own copy
> of an inbox. The latter is exactly what `msg9_status` now reports.


The human-facing badge is event-driven: the bridge exposes an SSE channel
(`GET /dsh-msg9/events`) and the host emits invalidations when the watcher
sees mail, when mail is marked read/handled, or when a 120s host-side
snapshot diff notices drift — the panel refetches `/unread` only then. The
20s timer survives purely as the no-EventSource fallback.

## Behaviour notes

- **One inbox per workspace** (not per session): concurrent sessions in the same
  workspace, and the panel, share it.
- **Cursor pull**: `msg9_inbox` continues from the saved cursor and advances it;
  an explicit `since` peeks without moving it (`advance: true` forces the move).
  The panel lists by page and does not touch the agent's cursor.
- **Cursor bootstrap**: msg9 returns `next_cursor` only when a request carries
  `since`, so the first pull on a fresh inbox records the newest message id as
  the incremental baseline until a cursor exists.
- **At-least-once**: dedupe on `message_id`.
- Reception to the agent is poll-based (see *How the agent hears about mail*):
  there is no WebSocket from msg9; the watcher and the UI badge each poll on
  their own cursor and cadence.
- The public registration path (no owner) is subject to msg9's limit of
  10 registrations / 24h / IP.
- A headless dsh has no `webServer`: the tools and the command still work, the
  panel simply has nothing to call.

## Develop

```bash
npm install
npm run build       # src/host → lib/index.js ｜ src/client → lib/client.js
npm run typecheck   # tsc --noEmit (host + client)
npm test            # smoke (host) + client (browser face) + cordis (real runtime)
```

`lib/client.js` is the browser bundle wrapped in the official
`window.__ModuleLoader__.load({ id, factory })` envelope; `react` and
`react/jsx-runtime` stay external and are resolved by the dsh client module
system from the shell-seeded platform baseline.

The tests need no browser and no msg9 account: `tests/smoke.test.mjs` drives the
tools against a fake msg9 server, `tests/client.test.mjs` loads the built client
bundle through the module-loader envelope, drives the store through the real
host bridge (including races, retries and tenant-subdomain mode) and renders
the components with `react-dom/server`, and `tests/cordis.test.mjs` activates
the plugin in a real `@deepseek-ai/cordis` app (including teardown, and a
headless host with no `webServer`).

## License

MIT

## v0.6.1 — quota round two: frequency down, semantics untouched

1. **How often the `onlyUnprocessed` reconciliation runs** (the leftover evaluation from T-23): the **semantics stay** — it is the only
   judgment for "a message already closed elsewhere must not wake anyone" — with two frequency reductions that do not relax it:
   ① an **early stop on the daemon side** (this batch's ids are on page one ⇒ stop paging) and ② the **watcher looks for a live session before
   reconciling** (no live session ⇒ no query). **Before/after** (`scripts/quota-probe.mjs`, a counting fake server on the real code paths):
   S4 **3 → 1**, S5 **20 → 0**, S6 20 → 20 (control, semantics unchanged), S7 840 → 840 (what the platform-side WS unread-count request is for).
   **Mutation**: turning either reconciliation off makes the ghost-wake regression test genuinely red.
2. **The `ingest` switch and the coexistence handover checklist**: `self` (default; the old behaviour is untouched) and `ledger` (consume the
   platform ledger); machine-checkable preconditions (platform daemon alive / ledger fresh / health file present) plus **precondition 0: who is
   authorised** — because "it runs" is not "you should switch": switching while the platform daemon is not writing would swap one live wake source
   for a dead ledger.
3. **Three must-fixes before switching + the `staleMs` tuning**: an empty-ledger **sentinel cursor** (previously an address with no ledger file
   never got a baseline and could never top up, and its first message was swallowed) · `connected:false` merged per address on **two axes** ·
   backfill blocks **throttled in file order** (avoiding a 127-message wake storm).
4. **A live-fire rehearsal script**: `scripts/ledger-rehearsal.mjs` consumes the real spool **read-only** (cursors in a temp dir, the ledger
   byte-identical) — it is what uncovered the three must-fixes above.
5. **A missing `return` in the reconciliation branch + `daemon.log` rotation**.
6. **Docs**: `docs/COEXISTENCE-HANDOVER.md` · `docs/QUOTA-BUDGET.md`.

**Verified**: `npm test` **275 checks / 15 suites green** + clean typecheck; both reductions carry mutation evidence.

