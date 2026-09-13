// src/host/index.ts
import { randomUUID } from "node:crypto";

// src/host/signing.ts
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, createPrivateKey, createPublicKey } from "node:crypto";
var PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function generateSigningMaterial() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return {
    seed: Buffer.from(jwk.d, "base64url").toString("base64"),
    publicKey: Buffer.from(jwk.x, "base64url").toString("base64")
  };
}
function privateKeyFromSeed(seedBase64) {
  const seed = Buffer.from(seedBase64, "base64");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}
function buildSignatureHeaders(options) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1e3);
  const nonce = options.nonce ?? randomBytes(16).toString("hex");
  const bodySha256 = createHash("sha256").update(options.body, "utf8").digest("hex");
  const payload = [
    "msg9-sig-v1",
    `from=${options.from}`,
    `to=${options.to}`,
    `ts=${timestamp}`,
    `nonce=${nonce}`,
    `idem=${options.idempotencyKey}`,
    `body_sha256=${bodySha256}`
  ].join("\n");
  const signature = cryptoSign(null, Buffer.from(payload, "utf8"), privateKeyFromSeed(options.seedBase64)).toString("base64");
  return {
    "X-Msg9-Signature": signature,
    "X-Msg9-Timestamp": String(timestamp),
    "X-Msg9-Nonce": nonce,
    "Idempotency-Key": options.idempotencyKey
  };
}

// src/host/api.ts
var Msg9ApiError = class extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.name = "Msg9ApiError";
  }
};
async function msg9Request(apiUrl, path, options = {}) {
  const headers = { ...options.headers ?? {} };
  const bodyText2 = options.rawBody ?? (options.body === void 0 ? void 0 : JSON.stringify(options.body));
  if (bodyText2 !== void 0) headers["Content-Type"] = "application/json";
  if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;
  const timeoutMs = options.timeoutMs ?? 3e4;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, "")}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: bodyText2,
      signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Msg9ApiError(0, void 0, `msg9 request timed out after ${Math.round(timeoutMs / 1e3)}s (${options.method ?? "GET"} ${path})`);
    }
    throw error;
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : void 0;
  } catch {
    parsed = void 0;
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new Msg9ApiError(
      response.status,
      parsed?.code,
      parsed?.message || text || response.statusText,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : void 0
    );
  }
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}
function registerAgent(apiUrl, address, publicKey, profile, signal) {
  const body = { requested_address: address };
  if (publicKey) body.public_key = publicKey;
  if (profile) body.profile = profile;
  return msg9Request(apiUrl, "/api/v1/register", { method: "POST", body, signal });
}
function getMe(apiUrl, apiKey, signal) {
  return msg9Request(apiUrl, "/api/v1/agent/me", { apiKey, signal });
}
function sendMessage(apiUrl, apiKey, input, signal, signing) {
  const idempotencyKey = input.idempotencyKey ?? `msg9-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const rawBody = JSON.stringify({
    to: input.to,
    subject: input.subject ?? "",
    body: { text: input.text },
    // reply_to closes the ORIGINAL message precisely (by its id);
    // correlation_id only threads — and auto-closes nothing when the original
    // never carried one (typical for cross-system mail).
    ...input.replyTo ? { reply_to: input.replyTo } : {},
    ...input.correlationId ? { correlation_id: input.correlationId } : {}
  });
  const signatureHeaders = signing ? buildSignatureHeaders({
    from: signing.from,
    to: input.to,
    body: rawBody,
    seedBase64: signing.seedBase64,
    idempotencyKey
  }) : {};
  return msg9Request(apiUrl, "/api/v1/send", {
    method: "POST",
    apiKey,
    signal,
    rawBody,
    headers: {
      "Idempotency-Key": idempotencyKey,
      ...signatureHeaders
    }
  });
}
function setSigningKey(apiUrl, apiKey, signingPublicKey, signal) {
  return msg9Request(apiUrl, "/api/v1/agent/signing-key", {
    method: "PUT",
    apiKey,
    body: { signing_public_key: signingPublicKey },
    signal
  });
}
function listInbox(apiUrl, apiKey, query, signal) {
  const params = new URLSearchParams();
  if (query.folder) params.set("folder", query.folder);
  params.set("limit", String(query.limit ?? 20));
  if (query.offset) params.set("offset", String(query.offset));
  if (query.since) params.set("since", query.since);
  return msg9Request(apiUrl, `/api/v1/inbox/messages?${params.toString()}`, { apiKey, signal });
}
async function getMessage(apiUrl, apiKey, messageId, signal) {
  const raw = await msg9Request(apiUrl, `/api/v1/inbox/messages/${encodeURIComponent(messageId)}`, { apiKey, signal });
  const message = raw && typeof raw === "object" && "message" in raw ? raw.message : raw;
  if (!message || typeof message !== "object" || !message.message_id) {
    throw new Msg9ApiError(0, void 0, `msg9 returned no message for ${messageId}`);
  }
  return message;
}
function markRead(apiUrl, apiKey, messageId, by, signal) {
  return msg9Request(apiUrl, `/api/v1/inbox/messages/${encodeURIComponent(messageId)}/read`, {
    method: "POST",
    apiKey,
    // v1.13: `by` is a self-reported attribution tag (human/agent/auto); the
    // server records it but cannot verify it (panel and agent share one key).
    ...by ? { body: { by } } : {},
    signal
  });
}
function markProcessed(apiUrl, apiKey, messageId, by, signal) {
  return msg9Request(apiUrl, `/api/v1/inbox/messages/${encodeURIComponent(messageId)}/processed`, {
    method: "POST",
    apiKey,
    ...by ? { body: { by } } : {},
    signal
  });
}
function streamInbox(apiUrl, apiKey, query, signal) {
  const params = new URLSearchParams();
  if (query.since) params.set("since", query.since);
  const wait = Math.max(1, Math.min(query.wait ?? 25, 30));
  params.set("wait", String(wait));
  return msg9Request(apiUrl, `/api/v1/inbox/stream?${params.toString()}`, {
    apiKey,
    signal,
    timeoutMs: (wait + 15) * 1e3
  });
}
function resolveAddress(apiUrl, address, signal) {
  return msg9Request(apiUrl, `/api/v1/resolve/${encodeURIComponent(address)}`, { signal });
}
function setForwarding(apiUrl, apiKey, target, notifySender = false, signal) {
  return msg9Request(apiUrl, "/api/v1/agent/forwarding", {
    method: "PUT",
    apiKey,
    body: { target, notify_sender: notifySender },
    signal
  });
}
function listGroups(apiUrl, apiKey, signal) {
  return msg9Request(apiUrl, "/api/v1/groups", { apiKey, signal });
}
function getGroup(apiUrl, apiKey, address, signal) {
  return msg9Request(apiUrl, `/api/v1/groups/${encodeURIComponent(address)}`, { apiKey, signal });
}
function groupMessages(apiUrl, apiKey, address, query, signal) {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 50));
  if (query.offset) params.set("offset", String(query.offset));
  return msg9Request(apiUrl, `/api/v1/groups/${encodeURIComponent(address)}/messages?${params.toString()}`, { apiKey, signal });
}
function listDirectory(apiUrl, query, signal) {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 100));
  if (query.offset) params.set("offset", String(query.offset));
  if (query.q) params.set("q", query.q);
  if (query.capability) params.set("capability", query.capability);
  return msg9Request(apiUrl, `/api/v1/directory?${params.toString()}`, { signal });
}
function ownerMe(apiUrl, ownerKey, signal) {
  return msg9Request(apiUrl, "/api/v1/owner/me", { apiKey: ownerKey, signal });
}
function ownerCreateAgents(apiUrl, ownerKey, addresses, metadata, profile, signal) {
  return msg9Request(apiUrl, "/api/v1/owner/agents", {
    method: "POST",
    apiKey: ownerKey,
    signal,
    body: { addresses, ...metadata ? { metadata } : {}, ...profile ? { profile } : {} }
  });
}
function ownerListAgents(apiUrl, ownerKey, offset = 0, limit = 100, signal) {
  return msg9Request(apiUrl, `/api/v1/owner/agents?offset=${offset}&limit=${limit}`, { apiKey: ownerKey, signal });
}
function ownerRotateAgentKey(apiUrl, ownerKey, address, signal) {
  return msg9Request(apiUrl, `/api/v1/owner/agents/${encodeURIComponent(address)}/rotate-key`, {
    method: "POST",
    apiKey: ownerKey,
    signal
  });
}
function ownerAccountAgents(apiUrl, ownerKey, offset = 0, limit = 50, signal) {
  return msg9Request(apiUrl, `/api/v1/owner/account/agents?offset=${offset}&limit=${limit}`, { apiKey: ownerKey, signal });
}
async function ownerOrgAgents(apiUrl, ownerKey, offset = 0, limit = 50, signal) {
  try {
    return await msg9Request(apiUrl, `/api/v1/owner/org/agents?offset=${offset}&limit=${limit}`, { apiKey: ownerKey, signal });
  } catch (error) {
    if (error instanceof Msg9ApiError && error.status === 404) {
      return ownerAccountAgents(apiUrl, ownerKey, offset, limit, signal);
    }
    throw error;
  }
}
function ownerMoveMail(apiUrl, ownerKey, address, input, signal) {
  return msg9Request(apiUrl, `/api/v1/owner/agents/${encodeURIComponent(address)}/move-mail`, {
    method: "POST",
    apiKey: ownerKey,
    body: { to: input.to, ...input.dryRun ? { dry_run: true } : {} },
    signal
  });
}
function ownerDisableAgent(apiUrl, ownerKey, address, signal) {
  return msg9Request(apiUrl, `/api/v1/owner/agents/${encodeURIComponent(address)}/disable`, {
    method: "POST",
    apiKey: ownerKey,
    signal
  });
}
function listOutbox(apiUrl, apiKey, query, signal) {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 20));
  params.set("offset", String(query.offset ?? 0));
  return msg9Request(apiUrl, `/api/v1/outbox/messages?${params.toString()}`, { apiKey, signal });
}
function listContacts(apiUrl, apiKey, query = {}, signal) {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 100));
  params.set("offset", String(query.offset ?? 0));
  return msg9Request(apiUrl, `/api/v1/contacts?${params.toString()}`, { apiKey, signal });
}
function addContact(apiUrl, apiKey, input, signal) {
  return msg9Request(apiUrl, "/api/v1/contacts", { method: "POST", apiKey, signal, body: input });
}
function deleteContact(apiUrl, apiKey, address, signal) {
  return msg9Request(apiUrl, `/api/v1/contacts/${encodeURIComponent(address)}`, { method: "DELETE", apiKey, signal });
}

// src/host/store.ts
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function stateFilePath() {
  if (process.env.MSG9_STATE_FILE) return process.env.MSG9_STATE_FILE;
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "msg9-kit", "state.json");
}
function defaultApiUrl() {
  return (process.env.MSG9_API_URL || "https://api.msg9.io").replace(/\/+$/, "");
}
async function loadState() {
  let raw;
  try {
    raw = await readFile(stateFilePath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { workspaces: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      owner: parsed?.owner,
      workspaces: parsed?.workspaces ?? {},
      notify_paused: parsed?.notify_paused === true
    };
  } catch (error) {
    const backup = `${stateFilePath()}.corrupt-${Date.now()}`;
    await writeFile(backup, raw, { mode: 384 }).catch(() => {
    });
    throw new Error(`msg9-kit state file is not valid JSON (a copy was kept at ${backup}): ${error.message}`);
  }
}
var tempCounter = 0;
async function saveState(state) {
  const file = stateFilePath();
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${tempCounter += 1}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}
`, { mode: 384 });
  await rename(temp, file);
}
var writeQueue = Promise.resolve();
function enqueueWrite(task) {
  const run = writeQueue.then(async () => {
    const release = await acquireStateLock();
    try {
      return await task();
    } finally {
      await release();
    }
  });
  writeQueue = run.catch(() => {
  });
  return run;
}
var LOCK_STALE_MS = 3e4;
var LOCK_RETRY_MS = 100;
var LOCK_MAX_ATTEMPTS = 50;
async function acquireStateLock() {
  const lockPath = `${stateFilePath()}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 384);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      await handle?.close().catch(() => {
      });
      if (error.code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        throw new Error(
          `msg9-kit state file is locked by another process (${lockPath}); multiple dsh instances sharing one DSH_HOME are not supported`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}
async function isStaleLock(lockPath) {
  let info;
  try {
    info = await stat(lockPath);
  } catch {
    return true;
  }
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
  const raw = await readFile(lockPath, "utf8").catch(() => "");
  let pid = NaN;
  try {
    pid = Number(JSON.parse(raw).pid);
  } catch {
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}
async function getOwner() {
  const envKey = process.env.MSG9_OWNER_KEY;
  if (envKey) {
    return { api_key: envKey, api_url: defaultApiUrl(), name: process.env.MSG9_OWNER_NAME };
  }
  const state = await loadState();
  return state.owner;
}
async function setOwner(owner) {
  return enqueueWrite(async () => {
    const state = await loadState();
    state.owner = owner;
    await saveState(state);
  });
}
async function getNotifyPaused() {
  const state = await loadState();
  return state.notify_paused === true;
}
async function setNotifyPaused(paused) {
  return enqueueWrite(async () => {
    const state = await loadState();
    state.notify_paused = paused;
    await saveState(state);
  });
}
async function getWorkspaceInbox(key) {
  const state = await loadState();
  return state.workspaces[key];
}
async function upsertWorkspaceInbox(key, patch) {
  return enqueueWrite(async () => {
    const state = await loadState();
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== void 0));
    state.workspaces[key] = { ...state.workspaces[key] ?? {}, ...clean };
    await saveState(state);
  });
}
async function deleteWorkspaceInbox(key) {
  return enqueueWrite(async () => {
    const state = await loadState();
    if (!(key in state.workspaces)) return;
    delete state.workspaces[key];
    await saveState(state);
  });
}
async function replaceWorkspaceInbox(key, inbox) {
  return enqueueWrite(async () => {
    const state = await loadState();
    state.workspaces[key] = inbox;
    await saveState(state);
  });
}
async function setCursor(key, cursor) {
  return enqueueWrite(async () => {
    const state = await loadState();
    const existing = state.workspaces[key];
    if (!existing) return;
    existing.cursor = cursor;
    await saveState(state);
  });
}
async function setLastMessageId(key, messageId) {
  return enqueueWrite(async () => {
    const state = await loadState();
    const existing = state.workspaces[key];
    if (!existing) return;
    existing.last_message_id = messageId;
    await saveState(state);
  });
}
async function setWatchState(key, patch) {
  return enqueueWrite(async () => {
    const state = await loadState();
    const existing = state.workspaces[key];
    if (!existing) return;
    if (patch.watch_cursor !== void 0) existing.watch_cursor = patch.watch_cursor;
    if (patch.watch_last_message_id !== void 0) existing.watch_last_message_id = patch.watch_last_message_id;
    if (patch.watch_last_seen_at !== void 0) existing.watch_last_seen_at = patch.watch_last_seen_at;
    if (patch.last_wake_agent_id !== void 0) existing.last_wake_agent_id = patch.last_wake_agent_id;
    await saveState(state);
  });
}
async function setMessageMark(key, messageId, patch) {
  return enqueueWrite(async () => {
    const state = await loadState();
    const existing = state.workspaces[key];
    if (!existing) return;
    const marks = existing.marks ??= {};
    const mark = marks[messageId] ??= {};
    if (patch.read_by && !mark.read_by) {
      mark.read_by = patch.read_by;
      mark.read_at = patch.read_at ?? (/* @__PURE__ */ new Date()).toISOString();
    }
    if (patch.processed_by && !mark.processed_by) {
      mark.processed_by = patch.processed_by;
      mark.processed_at = patch.processed_at ?? (/* @__PURE__ */ new Date()).toISOString();
    }
    const ids = Object.keys(marks);
    if (ids.length > 500) {
      const sorted = ids.sort((a, b) => (marks[a].processed_at ?? marks[a].read_at ?? "").localeCompare(marks[b].processed_at ?? marks[b].read_at ?? ""));
      for (const id of sorted.slice(0, ids.length - 500)) delete marks[id];
    }
    await saveState(state);
  });
}

// src/shared/i18n.ts
function localize(locale, zh, en, vars) {
  const template = locale === "zh" ? zh : en;
  if (!vars) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (raw, name2) => vars[name2] !== void 0 ? String(vars[name2]) : raw
  );
}
function normalizeLocale(raw) {
  const tag = (raw ?? "").toLowerCase();
  if (tag.startsWith("zh")) return "zh";
  return "en";
}

// src/host/locale.ts
var cached;
function detectLocale() {
  if (cached) return cached;
  const override = (process.env.MSG9KIT_LOCALE ?? "").toLowerCase();
  if (override === "zh" || override === "en") {
    cached = override;
    return cached;
  }
  cached = normalizeLocale(process.env.LC_ALL || process.env.LANG || "");
  return cached;
}
function L(zh, en, vars) {
  return localize(detectLocale(), zh, en, vars);
}

// src/host/commands.ts
function mask(key) {
  if (key.length <= 14) return "***";
  return `${key.slice(0, 11)}\u2026${key.slice(-4)}`;
}
function registerMsg9Commands(commands) {
  commands.register({
    name: "msg9",
    description: L("\u67E5\u770B msg9 owner \u4E0E\u5DF2\u767B\u8BB0\u7684 workspace \u6536\u4EF6\u7BB1", "Show the msg9 owner and registered workspace inboxes"),
    async handler() {
      const owner = await getOwner();
      const state = await loadState();
      const rows = Object.values(state.workspaces);
      const head = owner ? L("owner\uFF1A{name}\uFF08{key}\uFF09  API {api}", "owner: {name} ({key})  API {api}", {
        name: owner.name ?? owner.id ?? "owner",
        key: mask(owner.api_key),
        api: owner.api_url
      }) : L("owner\uFF1A\u672A\u914D\u7F6E\uFF08\u6BCF\u4E2A workspace \u8D70\u516C\u5F00\u6CE8\u518C\uFF09", "owner: not configured (per-workspace public registration)");
      const body = rows.length === 0 ? L("\u8FD8\u6CA1\u6709\u5DF2\u767B\u8BB0\u7684 workspace \u6536\u4EF6\u7BB1\u3002", "No workspace inbox registered yet.") : rows.map((inbox) => `\xB7 ${inbox.title} \u2192 ${inbox.address}`).join("\n");
      return {
        kind: "success",
        text: [
          head,
          L("API \u9ED8\u8BA4\u503C\uFF1A{v}", "default API: {v}", { v: defaultApiUrl() }),
          body,
          L("\u72B6\u6001\u6587\u4EF6\uFF1A{v}", "state file: {v}", { v: stateFilePath() })
        ].join("\n")
      };
    }
  });
}

// src/host/workspace.ts
var injectedRegistry;
function setWorkspaceRegistry(registry) {
  injectedRegistry = registry;
}
function registryOf(ctx) {
  if (injectedRegistry) return injectedRegistry;
  try {
    return ctx.workspaceRegistry;
  } catch {
    return void 0;
  }
}
function basename(path) {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}
function toCurrent(workspace) {
  return { key: workspace.id, title: workspace.title || basename(workspace.path), path: workspace.path };
}
function listWorkspaces(ctx) {
  try {
    return (registryOf(ctx)?.list?.() ?? []).map(toCurrent);
  } catch {
    return [];
  }
}
function matchWorkspaceByPath(ctx, cwd) {
  if (!cwd) return void 0;
  const workspaces = listWorkspaces(ctx);
  const match = workspaces.find((workspace) => workspace.path === cwd) ?? [...workspaces].sort((a, b) => b.path.length - a.path.length).find((workspace) => cwd.startsWith(`${workspace.path}/`));
  if (match) return match;
  return { key: `cwd:${cwd}`, title: basename(cwd), path: cwd };
}
function cwdOfSession(ctx, sessionId) {
  if (!sessionId) return void 0;
  const bridge = ctx;
  try {
    return bridge.sessions?.get(sessionId)?.header?.cwd;
  } catch {
    return void 0;
  }
}
function resolveWorkspace(ctx, exec) {
  const sessionId = exec?.agent?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
  return matchWorkspaceByPath(ctx, cwdOfSession(ctx, sessionId));
}
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
}
function shortHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}
function deriveAddress(workspace, options) {
  const slug = slugify(workspace.title) || slugify(basename(workspace.path)) || "ws";
  if (options?.tenant) {
    if (slug.length >= 3) return slug.slice(0, 30).replace(/[^a-z0-9]+$/, "");
    return deriveTenantFallback(workspace);
  }
  const address = `dsh-${slug}-${shortHash(workspace.key)}`;
  return address.slice(0, 30).replace(/[^a-z0-9]+$/, "");
}
function deriveTenantFallback(workspace) {
  const slug = slugify(workspace.title) || slugify(basename(workspace.path)) || "ws";
  return `${slug}-${shortHash(workspace.key)}`.slice(0, 30).replace(/[^a-z0-9]+$/, "");
}

// src/shared/message.ts
function bodyText(message) {
  const body = message?.body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && typeof body.text === "string") {
    return body.text;
  }
  return "";
}
function truncate(text, limit) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}\u2026` : oneLine;
}
function maskKey(key) {
  if (key.length <= 14) return "***";
  return `${key.slice(0, 11)}\u2026${key.slice(-4)}`;
}

// src/host/service.ts
var DEFAULT_WORKSPACE = { key: "default", title: "default", path: "(unknown)" };
var OWNER_PROBE_RETRY_MS = 6e4;
var ownerProbeFailedAt = 0;
async function ownerContext() {
  const owner = await getOwner();
  const apiUrl = owner?.api_url || defaultApiUrl();
  if (owner?.api_key && (owner.slug === void 0 || owner.address_domain === void 0) && !process.env.MSG9_OWNER_KEY && Date.now() - ownerProbeFailedAt >= OWNER_PROBE_RETRY_MS) {
    try {
      const me = await ownerMe(apiUrl, owner.api_key);
      const probed = {
        ...owner,
        slug: typeof me.slug === "string" ? me.slug : null,
        ...typeof me.mail_domain === "string" ? { mail_domain: me.mail_domain } : {},
        address_domain: typeof me.address_domain === "string" ? me.address_domain : null
      };
      await setOwner(probed);
      ownerProbeFailedAt = 0;
      return { owner: probed, apiUrl };
    } catch {
      ownerProbeFailedAt = Date.now();
    }
  }
  return { owner, apiUrl };
}
var provisioning = /* @__PURE__ */ new Map();
function ensureInbox(workspace, signal) {
  const pending = provisioning.get(workspace.key);
  if (pending) return pending;
  const task = provision(workspace).finally(() => provisioning.delete(workspace.key));
  provisioning.set(workspace.key, task);
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    task,
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  ]);
}
async function provision(workspace) {
  let existing = await getWorkspaceInbox(workspace.key);
  if (!existing?.api_key) {
    const legacyKey = `cwd:${workspace.path}`;
    if (legacyKey !== workspace.key) {
      const legacy = await getWorkspaceInbox(legacyKey);
      if (legacy?.api_key) {
        await upsertWorkspaceInbox(workspace.key, legacy);
        await deleteWorkspaceInbox(legacyKey);
        existing = legacy;
      }
    }
  }
  if (existing?.api_key) return { workspace, inbox: await ensureSigningKey(workspace.key, existing), provisioned: false };
  const { owner, apiUrl } = await ownerContext();
  const profile = workspaceProfile(workspace);
  const agent = owner?.api_key ? await provisionUnderOwner(apiUrl, owner, workspace, profile) : await registerAgent(apiUrl, deriveAddress(workspace), void 0, profile);
  const inbox = {
    address: agent.address,
    api_key: agent.api_key,
    api_url: apiUrl,
    title: workspace.title,
    path: workspace.path
  };
  await upsertWorkspaceInbox(workspace.key, inbox);
  return { workspace, inbox: await ensureSigningKey(workspace.key, inbox), provisioned: true };
}
async function ensureSigningKey(key, inbox, log) {
  if (inbox.signing_seed) return inbox;
  const material = generateSigningMaterial();
  try {
    await setSigningKey(inbox.api_url, inbox.api_key, material.publicKey);
  } catch (error) {
    log?.(`msg9 signing key install failed for ${inbox.address}: ${error?.message ?? String(error)}`);
    return inbox;
  }
  const signed = { ...inbox, signing_seed: material.seed };
  await upsertWorkspaceInbox(key, signed);
  return signed;
}
async function provisionUnderOwner(apiUrl, owner, workspace, profile) {
  const candidates = owner.slug ? [.../* @__PURE__ */ new Set([deriveAddress(workspace, { tenant: true }), deriveTenantFallback(workspace)])] : [deriveAddress(workspace)];
  let lastAddress = candidates[0];
  let lastReason = "no agent returned";
  for (const address of candidates) {
    lastAddress = address;
    const result = await ownerCreateAgents(apiUrl, owner.api_key, [address], { workspace: workspace.title }, profile);
    const created = result.created?.[0];
    if (created?.api_key) return created;
    const first = result.errors?.[0];
    lastReason = first ? `${first.message} (${first.code})` : "no agent returned";
    if (first?.code !== 40900) break;
  }
  throw new Error(
    L(
      "\u5728 owner \u4E0B\u5F00\u901A\u300C{address}\u300D\u5931\u8D25\uFF1A{reason}",
      'Failed to provision "{address}" under the owner: {reason}',
      { address: lastAddress, reason: lastReason }
    )
  );
}
function workspaceProfile(workspace) {
  return {
    display_name: workspace.title,
    description: L(
      "dsh workspace\u300C{title}\u300D\u7684\u6536\u4EF6\u7BB1\uFF08{path}\uFF09",
      'Inbox of dsh workspace "{title}" ({path})',
      { title: workspace.title, path: workspace.path }
    ),
    links: { workspace: workspace.path },
    visibility: "public"
  };
}
async function migrateInbox(workspace, oldInbox, oldOwnerKey) {
  const { owner, apiUrl } = await ownerContext();
  if (!owner?.api_key) {
    throw new Error(L("\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u79DF\u6237\uFF0C\u65E0\u6CD5\u8FC1\u79FB\u3002", "No tenant is bound; cannot migrate."));
  }
  const agent = await provisionUnderOwner(apiUrl, owner, workspace, workspaceProfile(workspace));
  let signingSeed;
  try {
    const material = generateSigningMaterial();
    await setSigningKey(apiUrl, agent.api_key, material.publicKey);
    signingSeed = material.seed;
  } catch {
  }
  const inbox = {
    address: agent.address,
    api_key: agent.api_key,
    api_url: apiUrl,
    title: workspace.title,
    path: workspace.path,
    ...signingSeed ? { signing_seed: signingSeed } : {}
  };
  if (oldInbox.address === agent.address) {
    await replaceWorkspaceInbox(workspace.key, inbox);
    return { inbox, oldDisabled: false, forwarding: false, movedMail: null };
  }
  try {
    await setForwarding(oldInbox.api_url, oldInbox.api_key, agent.address);
  } catch (error) {
    throw new Error(L(
      "\u65E7\u5730\u5740 {old} \u7684\u8F6C\u53D1\u8BBE\u7F6E\u5931\u8D25\uFF08{reason}\uFF09\uFF0C\u8FC1\u79FB\u5DF2\u4E2D\u6B62\uFF1A\u672C\u5730\u914D\u7F6E\u672A\u6539\u52A8\uFF0C\u4ECD\u6307\u5411\u65E7\u4FE1\u7BB1\u3002",
      "Could not set forwarding on the old address {old} ({reason}); migration aborted \u2014 local state still points at the old inbox.",
      { old: oldInbox.address, reason: error?.message ?? String(error) }
    ));
  }
  await replaceWorkspaceInbox(workspace.key, inbox);
  const forwarding = true;
  let oldDisabled = false;
  let movedMail = null;
  let note;
  if (oldOwnerKey) {
    try {
      const moved = await ownerMoveMail(oldInbox.api_url, oldOwnerKey, oldInbox.address, { to: agent.address });
      movedMail = typeof moved.moved === "number" ? moved.moved : null;
    } catch (error) {
      note = L(
        "\u5386\u53F2\u90AE\u4EF6\u672A\u642C\u8FD0\uFF08{reason}\uFF09\u3002\u8DE8\u79DF\u6237\u65F6 msg9 \u4E0D\u652F\u6301\u642C\u4FE1\uFF0C\u65E7\u90AE\u4EF6\u7559\u5728\u65E7\u4FE1\u7BB1\u3002",
        "History not moved ({reason}). msg9 cannot move mail across tenants; old mail stays in the old inbox.",
        { reason: error?.message ?? String(error) }
      );
    }
    try {
      await ownerDisableAgent(oldInbox.api_url, oldOwnerKey, oldInbox.address);
      oldDisabled = true;
    } catch {
    }
  }
  return { inbox, oldDisabled, forwarding, movedMail, ...note ? { note } : {} };
}
function resolveInbox(ctx, exec) {
  return ensureInbox(resolveWorkspace(ctx, exec) ?? DEFAULT_WORKSPACE);
}

// src/host/http.ts
var BRIDGE_PREFIX = "/dsh-msg9";
function createBridgeEventBus() {
  const listeners = /* @__PURE__ */ new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
        }
      }
    },
    size: () => listeners.size
  };
}
var UNREAD_TTL_MS = 1e4;
var unreadCache;
var unreadInflight;
function invalidateUnreadCache() {
  unreadCache = void 0;
}
async function computeUnread(deps, signal, options) {
  const ttl = options?.ttlMs ?? UNREAD_TTL_MS;
  if (unreadInflight) return unreadInflight;
  if (unreadCache && Date.now() - unreadCache.at < ttl) return unreadCache.view;
  void signal;
  unreadInflight = (async () => {
    const state = await deps.loadState();
    const rows = Object.entries(state.workspaces).filter(([, inbox]) => Boolean(inbox.api_key));
    const settled = await Promise.allSettled(
      rows.map(async ([key, inbox]) => {
        const page = await deps.api.listInbox(inbox.api_url, inbox.api_key, { folder: "all", limit: 1 });
        return [key, Number(page?.unread_count ?? 0), Number(page?.total ?? (page?.messages ?? []).length)];
      })
    );
    const previous = unreadCache?.view;
    const byKey = {};
    const totalByKey = {};
    let total = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const [key] = rows[index];
      const result = settled[index];
      if (result.status === "fulfilled") {
        const [, count, mailboxSize] = result.value;
        byKey[key] = count;
        totalByKey[key] = mailboxSize;
        total += count;
      } else if (previous && key in previous.byKey) {
        byKey[key] = previous.byKey[key];
        totalByKey[key] = previous.totalByKey[key] ?? 0;
        total += byKey[key];
      }
    }
    const view = { total, byKey, totalByKey };
    unreadCache = { at: Date.now(), view };
    return view;
  })().finally(() => {
    unreadInflight = void 0;
  });
  return unreadInflight;
}
function defaultBridgeDeps(ctx, override = {}) {
  return {
    api: {
      listInbox,
      listOutbox,
      sendMessage,
      markRead,
      markProcessed,
      listContacts,
      addContact,
      deleteContact,
      resolveAddress,
      listDirectory,
      ownerListAgents,
      ownerAccountAgents,
      ownerOrgAgents,
      listGroups,
      getGroup,
      groupMessages,
      ...override
    },
    loadState,
    stateFilePath,
    defaultApiUrl,
    ensureInbox,
    listWorkspaces: () => listWorkspaces(ctx),
    matchWorkspaceByPath: (cwd) => matchWorkspaceByPath(ctx, cwd),
    log: (message) => {
      try {
        ctx.logger("msg9-kit:http").info(message);
      } catch {
      }
    }
  };
}
var BridgeError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "BridgeError";
  }
};
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}
function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}
function hostnameOf(host) {
  if (!host) return null;
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  if (bracketed) return bracketed[1].toLowerCase();
  const colon = host.lastIndexOf(":");
  const bare = colon > 0 ? host.slice(0, colon) : host;
  return bare.toLowerCase() || null;
}
function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(hostname);
}
function isLoopbackAddress(address) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(normalized);
}
function isTrustedRequest(req) {
  const host = hostnameOf(req.headers.host);
  if (!host) return false;
  const origin = req.headers.origin;
  if (origin) return isSameOrigin(origin, req.headers.host ?? "");
  const remote = req.socket?.remoteAddress;
  if (remote && !isLoopbackAddress(remote)) return false;
  return isLoopbackHostname(host);
}
function portOf(hostHeader) {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end < 0) return void 0;
    const rest = hostHeader.slice(end + 1);
    return rest.startsWith(":") ? rest.slice(1) : void 0;
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon > 0 ? hostHeader.slice(colon + 1) : void 0;
}
function isSameOrigin(origin, hostHeader) {
  try {
    const parsed = new URL(origin);
    const originHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (originHost !== hostnameOf(hostHeader)) return false;
    const expected = portOf(hostHeader) ?? (parsed.protocol === "https:" ? "443" : "80");
    const actual = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return actual === expected;
  } catch {
    return false;
  }
}
function addressDomain(apiUrl) {
  try {
    return new URL(apiUrl).hostname.replace(/^api\./, "") || "msg9.io";
  } catch {
    return "msg9.io";
  }
}
var MAX_BODY_BYTES = 1024 * 1024;
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, "body-too-large", "request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BridgeError(400, "invalid-body", "request body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(400, "invalid-body", "request body is not valid JSON");
  }
}
function str(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function intParam(value, fallback, min, max) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
function createMsg9Bridge(deps) {
  async function workspaceViews(currentKey, apiUrl, owner) {
    const state = await deps.loadState();
    const tenantMode = Boolean(owner?.api_key && owner.slug);
    const mailDomain = owner?.mail_domain || addressDomain(apiUrl);
    const domain = tenantMode ? owner?.address_domain ?? `${owner.slug}.${mailDomain}` : mailDomain;
    const planned = (workspace) => `${tenantMode ? deriveAddress(workspace, { tenant: true }) : deriveAddress(workspace)}@${domain}`;
    const rows = /* @__PURE__ */ new Map();
    for (const workspace of deps.listWorkspaces()) {
      rows.set(workspace.key, {
        key: workspace.key,
        title: workspace.title,
        path: workspace.path,
        address: null,
        // The address provisioning will assign, derived on the host so the
        // panel shows the real thing instead of guessing from the raw key.
        planned_address: planned(workspace),
        provisioned: false,
        cursor: null,
        current: workspace.key === currentKey
      });
    }
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      const existing = rows.get(key);
      const legacy = Boolean(inbox.api_key && tenantMode && inbox.address && !inbox.address.endsWith(`@${domain}`));
      rows.set(key, {
        key,
        title: inbox.title || existing?.title || key,
        path: inbox.path || existing?.path || "",
        address: inbox.address,
        planned_address: inbox.api_key ? legacy ? planned({ key, title: inbox.title || existing?.title || key, path: inbox.path || existing?.path || "" }) : null : existing?.planned_address ?? null,
        provisioned: Boolean(inbox.api_key),
        legacy,
        cursor: inbox.cursor ?? null,
        current: key === currentKey
      });
    }
    return [...rows.values()].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.provisioned !== b.provisioned) return a.provisioned ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
  }
  async function inboxFor(key, signal) {
    const state = await deps.loadState();
    const existing = state.workspaces[key];
    if (existing?.api_key) {
      return {
        workspace: { key, title: existing.title, path: existing.path },
        inbox: existing.signing_seed ? existing : await ensureSigningKey(key, existing, deps.log),
        provisioned: false
      };
    }
    const workspace = deps.listWorkspaces().find((row) => row.key === key);
    if (!workspace) throw new BridgeError(404, "unknown-workspace", `no workspace is registered as "${key}"`);
    return deps.ensureInbox(workspace, signal);
  }
  async function overview(url) {
    const cwd = str(url.searchParams.get("cwd"));
    const current = deps.matchWorkspaceByPath(cwd);
    const { owner, apiUrl } = await ownerContext();
    const workspaces = await workspaceViews(current?.key, apiUrl, owner);
    if (current && !workspaces.some((row) => row.key === current.key)) {
      const tenantMode = Boolean(owner?.api_key && owner.slug);
      const mailDomain = owner?.mail_domain || addressDomain(apiUrl);
      const currentDomain = tenantMode ? owner?.address_domain ?? `${owner.slug}.${mailDomain}` : mailDomain;
      workspaces.unshift({
        key: current.key,
        title: current.title,
        path: current.path,
        address: null,
        planned_address: `${tenantMode ? deriveAddress(current, { tenant: true }) : deriveAddress(current)}@${currentDomain}`,
        provisioned: false,
        cursor: null,
        current: true
      });
    }
    return {
      owner: owner ? {
        name: owner.name ?? null,
        id: owner.id ?? null,
        masked: maskKey(owner.api_key),
        slug: owner.slug ?? null,
        mail_domain: owner.mail_domain ?? null,
        address_domain: owner.address_domain ?? null
      } : null,
      api_url: owner?.api_url || apiUrl,
      state_file: deps.stateFilePath(),
      current: workspaces.find((row) => row.current) ?? null,
      workspaces
    };
  }
  async function peers(signal) {
    const state = await deps.loadState();
    const localByAddress = new Map(Object.values(state.workspaces).map((inbox) => [inbox.address, inbox]));
    const { owner } = await ownerContext();
    if (owner?.api_key) {
      const { agents } = await deps.api.ownerListAgents(owner.api_url, owner.api_key, 0, 200, signal);
      return (agents ?? []).map((row) => ({
        address: row.agent_address,
        title: localByAddress.get(row.agent_address)?.title ?? null,
        path: localByAddress.get(row.agent_address)?.path ?? null,
        local: localByAddress.has(row.agent_address),
        display_name: row.profile?.display_name ?? null,
        description: row.profile?.description ?? null,
        capabilities: row.profile?.capabilities ?? []
      }));
    }
    return Object.values(state.workspaces).map((inbox) => ({
      address: inbox.address,
      title: inbox.title,
      path: inbox.path,
      local: true
    }));
  }
  async function unread(signal) {
    return computeUnread(deps, signal);
  }
  async function route(req, res, url) {
    const path = url.pathname.replace(/\/+$/, "") || BRIDGE_PREFIX;
    const method = req.method ?? "GET";
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const signal = controller.signal;
    if (method === "GET" && path === `${BRIDGE_PREFIX}/overview`) return ok(res, await overview(url));
    if (method === "GET" && path === `${BRIDGE_PREFIX}/unread`) return ok(res, await unread(signal));
    if (method === "GET" && path === `${BRIDGE_PREFIX}/notify`) {
      return ok(res, { paused: await getNotifyPaused() });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/notify`) {
      const body = await readJsonBody(req);
      const paused = body.paused === true;
      await setNotifyPaused(paused);
      deps.events?.emit(paused ? "notify-paused" : "notify-resumed");
      return ok(res, { paused });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/events`) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      res.write(": connected\n\n");
      const heartbeat = setInterval(() => {
        try {
          res.write(": hb\n\n");
        } catch {
        }
      }, 25e3);
      const unsubscribe = deps.events?.subscribe((event) => {
        try {
          res.write(`data: ${JSON.stringify({ type: "invalidate", reason: event })}

`);
        } catch {
        }
      });
      res.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      });
      return;
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/peers`) return ok(res, { peers: await peers(signal) });
    if (method === "GET" && path === `${BRIDGE_PREFIX}/account/agents`) {
      const { owner } = await ownerContext();
      if (!owner?.api_key) throw new BridgeError(400, "no-tenant", "bind a tenant first (msg9_tk_\u2026)");
      const page = await deps.api.ownerOrgAgents(
        owner.api_url,
        owner.api_key,
        intParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
        intParam(url.searchParams.get("limit"), 50, 1, 200),
        signal
      );
      const agents = (page.agents ?? []).map((row) => ({
        owner_id: row.owner_id,
        owner_name: row.owner_name,
        owner_slug: row.owner_slug ?? null,
        address_domain: row.address_domain,
        address: row.agent_address,
        status: row.status,
        display_name: row.profile?.display_name ?? null,
        description: row.profile?.description ?? null,
        capabilities: row.profile?.capabilities ?? []
      }));
      return ok(res, { agents, total: page.total ?? agents.length, org_id: page.org_id ?? null, org_label: page.org_label ?? null });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/directory`) {
      const { apiUrl } = await ownerContext();
      const page = await deps.api.listDirectory(apiUrl, {
        limit: intParam(url.searchParams.get("limit"), 100, 1, 100),
        offset: intParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
        q: str(url.searchParams.get("q")),
        capability: str(url.searchParams.get("capability"))
      }, signal);
      const agents = (page.agents ?? []).map((row) => ({
        address: row.address,
        display_name: row.profile?.display_name ?? null,
        description: row.profile?.description ?? null,
        capabilities: row.profile?.capabilities ?? [],
        links: row.profile?.links ?? {},
        created_at: row.created_at
      }));
      return ok(res, { agents, total: page.total ?? agents.length });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/messages`) {
      const key = str(url.searchParams.get("key"));
      if (!key) throw new BridgeError(400, "missing-key", 'query parameter "key" is required');
      const { inbox, workspace } = await inboxFor(key, signal);
      const page = await deps.api.listInbox(inbox.api_url, inbox.api_key, {
        folder: str(url.searchParams.get("folder")) ?? "all",
        limit: intParam(url.searchParams.get("limit"), 20, 1, 100),
        offset: intParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
        ...str(url.searchParams.get("since")) ? { since: str(url.searchParams.get("since")) } : {}
      }, signal);
      const marks = inbox.marks ?? {};
      const messages = (page.messages ?? []).map((message) => {
        const mark = marks[message.message_id];
        if (!mark) return message;
        const readBy = message.read_by ?? mark.read_by;
        const processedBy = message.processed_by ?? mark.processed_by;
        const processedAt = message.processed_at ?? mark.processed_at;
        return {
          ...message,
          ...readBy ? { read_by: readBy } : {},
          ...processedBy ? { processed_by: processedBy, processed_at: processedAt } : {}
        };
      });
      return ok(res, {
        workspace: { key: workspace.key, title: workspace.title, address: inbox.address },
        messages,
        total: page.total ?? messages.length,
        unread_count: page.unread_count ?? 0,
        next_cursor: page.next_cursor ?? null
      });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/outbox`) {
      const key = str(url.searchParams.get("key"));
      if (!key) throw new BridgeError(400, "missing-key", 'query parameter "key" is required');
      const { inbox, workspace } = await inboxFor(key, signal);
      const page = await deps.api.listOutbox(inbox.api_url, inbox.api_key, {
        limit: intParam(url.searchParams.get("limit"), 20, 1, 100),
        offset: intParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)
      }, signal);
      return ok(res, {
        workspace: { key: workspace.key, title: workspace.title, address: inbox.address },
        messages: page.messages ?? [],
        total: page.total ?? 0
      });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/contacts`) {
      const key = str(url.searchParams.get("key"));
      if (!key) throw new BridgeError(400, "missing-key", 'query parameter "key" is required');
      const { inbox } = await inboxFor(key, signal);
      const page = await deps.api.listContacts(inbox.api_url, inbox.api_key, {}, signal);
      return ok(res, { contacts: page.contacts ?? [], total: page.total ?? 0 });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/groups`) {
      const key = str(url.searchParams.get("key"));
      if (!key) throw new BridgeError(400, "missing-key", 'query parameter "key" is required');
      const { inbox } = await inboxFor(key, signal);
      const address = str(url.searchParams.get("address"));
      if (address) {
        return ok(res, { group: await deps.api.getGroup(inbox.api_url, inbox.api_key, address, signal) });
      }
      const page = await deps.api.listGroups(inbox.api_url, inbox.api_key, signal);
      return ok(res, { groups: page.groups ?? [], total: page.total ?? (page.groups ?? []).length });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/groups/messages`) {
      const key = str(url.searchParams.get("key"));
      const address = str(url.searchParams.get("address"));
      if (!key) throw new BridgeError(400, "missing-key", 'query parameter "key" is required');
      if (!address) throw new BridgeError(400, "missing-address", 'query parameter "address" is required');
      const { inbox } = await inboxFor(key, signal);
      const page = await deps.api.groupMessages(inbox.api_url, inbox.api_key, address, {
        limit: intParam(url.searchParams.get("limit"), 50, 1, 100),
        offset: intParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)
      }, signal);
      return ok(res, { messages: page.messages ?? [], total: page.total ?? (page.messages ?? []).length });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/contacts`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      const contact = str(body.contact);
      if (!key) throw new BridgeError(400, "missing-key", 'field "key" is required');
      if (!contact) throw new BridgeError(400, "missing-contact", 'field "contact" is required');
      const { inbox } = await inboxFor(key, signal);
      const created = await deps.api.addContact(inbox.api_url, inbox.api_key, {
        contact,
        ...str(body.alias) ? { alias: str(body.alias) } : {},
        ...str(body.notes) ? { notes: str(body.notes) } : {}
      }, signal);
      return ok(res, { contact: created });
    }
    if (method === "DELETE" && path === `${BRIDGE_PREFIX}/contacts`) {
      const key = str(url.searchParams.get("key"));
      const address = str(url.searchParams.get("address"));
      if (!key) throw new BridgeError(400, "missing-key", 'query parameter "key" is required');
      if (!address) throw new BridgeError(400, "missing-address", 'query parameter "address" is required');
      const { inbox } = await inboxFor(key, signal);
      await deps.api.deleteContact(inbox.api_url, inbox.api_key, address, signal);
      return ok(res, { removed: address });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/send`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      const to = str(body.to);
      const text = typeof body.text === "string" ? body.text : void 0;
      if (!key) throw new BridgeError(400, "missing-key", 'field "key" is required');
      if (!to) throw new BridgeError(400, "missing-to", 'field "to" is required');
      if (!text) throw new BridgeError(400, "missing-text", 'field "text" is required');
      const { inbox, workspace } = await inboxFor(key, signal);
      const correlationId = str(body.correlation_id);
      const replyTo = str(body.reply_to);
      const result = await deps.api.sendMessage(inbox.api_url, inbox.api_key, {
        to,
        subject: str(body.subject),
        text,
        ...replyTo ? { replyTo } : {},
        ...correlationId ? { correlationId } : {},
        idempotencyKey: str(body.idempotency_key) ?? `dsh-ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      }, signal, inbox.signing_seed ? { from: inbox.address, seedBase64: inbox.signing_seed } : void 0);
      const closedId = replyTo ?? correlationId;
      if (closedId) await setMessageMark(key, closedId, { processed_by: "human" });
      deps.log(`sent ${result.message_id} from ${inbox.address} to ${to}`);
      return ok(res, { message_id: result.message_id, status: result.status, from: inbox.address, workspace: workspace.title });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/read`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      const messageId = str(body.message_id);
      if (!key) throw new BridgeError(400, "missing-key", 'field "key" is required');
      if (!messageId) throw new BridgeError(400, "missing-message", 'field "message_id" is required');
      const { inbox } = await inboxFor(key, signal);
      await deps.api.markRead(inbox.api_url, inbox.api_key, messageId, "human", signal);
      await setMessageMark(key, messageId, { read_by: "human" });
      invalidateUnreadCache();
      deps.events?.emit("read");
      return ok(res, { message_id: messageId, read: true });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/done`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      const messageId = str(body.message_id);
      if (!key) throw new BridgeError(400, "missing-key", 'field "key" is required');
      if (!messageId) throw new BridgeError(400, "missing-message", 'field "message_id" is required');
      const { inbox } = await inboxFor(key, signal);
      try {
        await deps.api.markProcessed(inbox.api_url, inbox.api_key, messageId, "human", signal);
      } catch {
        await deps.api.markRead(inbox.api_url, inbox.api_key, messageId, "human", signal).catch(() => {
        });
      }
      await setMessageMark(key, messageId, { read_by: "human", processed_by: "human" });
      invalidateUnreadCache();
      deps.events?.emit("done");
      return ok(res, { message_id: messageId, processed: true });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/setup`) {
      const body = await readJsonBody(req);
      const ownerKey = str(body.owner_key);
      if (!ownerKey) throw new BridgeError(400, "missing-owner-key", 'field "owner_key" is required');
      const apiUrl = (str(body.api_url) || defaultApiUrl()).replace(/\/+$/, "");
      let me;
      try {
        me = await ownerMe(apiUrl, ownerKey, signal);
      } catch (error) {
        if (error instanceof Msg9ApiError) {
          const code = error.code === void 0 ? "" : `, code ${error.code}`;
          throw new BridgeError(
            400,
            "owner-key-rejected",
            `msg9 rejected this key (HTTP ${error.status}${code}): ${error.message}`
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new BridgeError(400, "msg9-unreachable", `cannot reach ${apiUrl}: ${reason}`);
      }
      const id = typeof me.id === "string" ? me.id : void 0;
      const name2 = typeof me.name === "string" ? me.name : void 0;
      const slug = typeof me.slug === "string" ? me.slug : null;
      const mailDomain = typeof me.mail_domain === "string" ? me.mail_domain : void 0;
      const addressDomain2 = typeof me.address_domain === "string" ? me.address_domain : null;
      await setOwner({ api_key: ownerKey, api_url: apiUrl, id, name: name2, slug, mail_domain: mailDomain, address_domain: addressDomain2 });
      invalidateUnreadCache();
      return ok(res, {
        owner: {
          name: name2 ?? null,
          id: id ?? null,
          masked: maskKey(ownerKey),
          slug,
          mail_domain: mailDomain ?? null,
          address_domain: addressDomain2
        },
        api_url: apiUrl
      });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/migrate`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      if (!key) throw new BridgeError(400, "missing-key", 'field "key" is required');
      const state = await deps.loadState();
      const existing = state.workspaces[key];
      if (!existing?.api_key) throw new BridgeError(404, "unknown-workspace", `no inbox is registered as "${key}"`);
      const workspace = deps.listWorkspaces().find((row) => row.key === key) ?? { key, title: existing.title, path: existing.path };
      const result = await migrateInbox(workspace, existing, str(body.old_owner_key));
      invalidateUnreadCache();
      deps.log(`migrated ${key}: ${existing.address} -> ${result.inbox.address}`);
      deps.events?.emit("migrate");
      return ok(res, {
        key,
        old_address: existing.address,
        new_address: result.inbox.address,
        old_disabled: result.oldDisabled,
        forwarding: result.forwarding,
        moved_mail: result.movedMail,
        ...result.note ? { note: result.note } : {}
      });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/provision`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      const cwd = str(body.cwd);
      const title = str(body.title);
      const state = await deps.loadState();
      const known = key ? state.workspaces[key] : void 0;
      const workspace = (key ? deps.listWorkspaces().find((row) => row.key === key) : void 0) ?? (key && known ? { key, title: known.title, path: known.path } : void 0) ?? deps.matchWorkspaceByPath(cwd);
      if (!workspace) throw new BridgeError(400, "missing-workspace", 'field "key" (workspace) or "cwd" is required');
      const { inbox, provisioned } = await deps.ensureInbox(
        title ? { ...workspace, title } : workspace,
        signal
      );
      if (provisioned) invalidateUnreadCache();
      return ok(res, { key: workspace.key, address: inbox.address, provisioned });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/resolve`) {
      const body = await readJsonBody(req);
      const address = str(body.address);
      if (!address) throw new BridgeError(400, "missing-address", 'field "address" is required');
      const { apiUrl } = await ownerContext();
      return ok(res, { record: await deps.api.resolveAddress(apiUrl, address, signal) });
    }
    return fail(res, 404, "not-found", `no route for ${method} ${path}`);
  }
  return {
    async handle(req, res) {
      try {
        if (!isTrustedRequest(req)) {
          return fail(res, 403, "forbidden", "untrusted host or origin");
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        await route(req, res, url);
      } catch (error) {
        if (error instanceof BridgeError) {
          return fail(res, error.status, error.code, error.message);
        }
        const message = error?.message ?? String(error);
        const status = typeof error.status === "number" ? error.status : 502;
        const code = typeof error.code === "number" ? `msg9-${error.code}` : "msg9-error";
        deps.log(`bridge error: ${message}`);
        return fail(res, status >= 400 && status < 600 ? status : 502, code, message);
      }
    }
  };
}

// src/host/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }]
};
function errorText(error) {
  if (error instanceof Msg9ApiError) {
    return L(
      "msg9 \u8FD4\u56DE\u9519\u8BEF {status}\uFF08code {code}\uFF09\uFF1A{message}",
      "msg9 returned error {status} (code {code}): {message}",
      { status: error.status, code: error.code ?? "-", message: error.message }
    );
  }
  return L("msg9 \u8BF7\u6C42\u5931\u8D25\uFF1A{message}", "msg9 request failed: {message}", {
    message: error.message
  });
}
function withoutSeen(messages, lastId) {
  if (!lastId) return messages;
  const index = messages.findIndex((message) => message.message_id === lastId);
  if (index < 0) return messages;
  return messages.slice(0, index);
}
function statusOf(message) {
  const read = message.read_at ? "read" : "unread";
  const state = message.processed_at ? "processed" : "open";
  return `${read} \xB7 ${state}`;
}
function formatMessage(message, bodyLimit = 0) {
  const head = message.subject ? `${message.subject}
` : "";
  const meta = [
    `${message.from_address} \u2192 ${message.to_address ?? ""}`.trim(),
    message.created_at ? String(message.created_at).slice(0, 19).replace("T", " ") : "",
    statusOf(message),
    message.correlation_id ? `correlation ${message.correlation_id}` : "",
    `\`${message.message_id}\``
  ].filter(Boolean).join(" \xB7 ");
  const text = bodyText(message);
  const body = text ? bodyLimit > 0 ? truncate(text, bodyLimit) : text : L("\uFF08\u65E0\u6B63\u6587\uFF09", "(no body)");
  return `${head}${meta}

${body}`;
}
function formatMessages(messages, unread, note, opts = {}) {
  if (messages.length === 0) {
    return L("\u6CA1\u6709\u65B0\u6D88\u606F\uFF08\u672A\u8BFB {unread}\uFF09\u3002", "No new messages ({unread} unread).", { unread });
  }
  const lines = messages.map((message) => {
    const subject = message.subject ? ` ${message.subject}` : "";
    const text = bodyText(message);
    if (opts.full) {
      const body = opts.bodyLimit && opts.bodyLimit > 0 ? truncate(text, opts.bodyLimit) : text;
      const head2 = `${message.subject ? `${message.subject}
` : ""}${message.from_address} \xB7 ${statusOf(message)}${message.correlation_id ? ` \xB7 correlation ${message.correlation_id}` : ""} \xB7 \`${message.message_id}\``;
      return `${head2}

${body || L("\uFF08\u65E0\u6B63\u6587\uFF09", "(no body)")}
`;
    }
    const excerpt = text ? ` \u2014 ${truncate(text, 140)}` : "";
    return `\xB7 ${message.from_address}${subject}${excerpt}  \`${message.message_id}\``;
  });
  const head = L("{count} \u6761\u6D88\u606F\uFF08\u672A\u8BFB {unread}\uFF09\uFF1A", "{count} message(s) ({unread} unread):", {
    count: messages.length,
    unread
  });
  return `${head}
${lines.join("\n")}
${note}`;
}
function registerMsg9Tools(ctx) {
  ctx.tools.register(defineTool({
    name: "msg9_setup",
    description: "Configure the msg9.io owner (tenant) for this dsh instance by saving its owner key (msg9_tk_...). With an owner configured, each workspace gets its own inbox under that owner \u2014 so sibling workspaces can message each other and one key manages them all. Skip this to use per-workspace public registration instead. If the human has no key yet, guide them: sign up at msg9.io \u2192 Account page \u2192 create a tenant \u2192 copy the msg9_tk_ key (shown once). The\u300C\u6D88\u606F\u300Dpanel and Settings \u2192 \u6D88\u606F\u4FE1\u7BB1 show the same three steps.",
    parameters: {
      owner_key: { type: "string", required: true, description: 'The owner key, starting with "msg9_tk_".' },
      api_url: { type: "string", description: "msg9 API base (default: MSG9_API_URL or https://api.msg9.io)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const apiUrl = (args.api_url || defaultApiUrl()).replace(/\/+$/, "");
      try {
        const me = await ownerMe(apiUrl, args.owner_key, exec?.signal);
        const ownerId = typeof me?.id === "string" ? me.id : void 0;
        const ownerName = typeof me?.name === "string" ? me.name : void 0;
        await setOwner({ api_key: args.owner_key, api_url: apiUrl, id: ownerId, name: ownerName });
        const quota = me?.quota ?? {};
        const maxAgents = quota.max_agents;
        return L(
          "owner \u5DF2\u914D\u7F6E\uFF1A{name}\uFF08{id}\uFF09\uFF0CAPI {api}\uFF0C\u914D\u989D max_agents={maxAgents}\u3002\n\u4E4B\u540E\u6BCF\u4E2A workspace \u9996\u6B21\u4F7F\u7528\u4F1A\u81EA\u52A8\u5728\u8BE5 owner \u4E0B\u5F00\u901A\u6536\u4EF6\u7BB1\u3002",
          "Owner configured: {name} ({id}), API {api}, quota max_agents={maxAgents}.\nEach workspace will now be provisioned automatically under this owner.",
          {
            name: ownerName ?? "(unnamed)",
            id: ownerId ?? "(unknown)",
            api: apiUrl,
            maxAgents: typeof maxAgents === "number" ? maxAgents : "(n/a)"
          }
        );
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_inbox",
    description: 'Pull new msg9.io messages for the CURRENT workspace, provisioning its inbox on first use. By default it continues from the saved cursor and advances it, so each call returns only what is new. Pass an explicit "since" to read a specific span without moving the cursor. Reading is believing: every unread message RETURNED by this call is marked read automatically \u2014 pass mark_read:false to peek without touching the read state. The list shows a ~140-char preview per message; pass full:true (or call msg9_message for one id) when a letter is longer than the preview.',
    parameters: {
      folder: { type: "string", description: "all | unread | read (default: all)." },
      limit: { type: "integer", description: "Max messages to return (default 20, max 100)." },
      since: { type: "string", description: "Explicit opaque cursor to read from; does not advance the saved cursor." },
      advance: { type: "boolean", description: "Force cursor advancement even with an explicit since." },
      mark_read: { type: "boolean", description: "Auto-mark returned unread messages as read (default: true). Pass false to peek." },
      full: { type: "boolean", description: "Include each message FULL body instead of the ~140-char preview (default false)." },
      body_limit: { type: "integer", description: "With full:true, cap each body at N characters (default: no cap)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox, provisioned } = await resolveInbox(ctx, exec);
        const banner = L("[{title}] {address}", "[{title}] {address}", { title: workspace.title, address: inbox.address });
        const provisionNote = provisioned ? L("\n\uFF08\u5DF2\u4E3A\u672C\u7AD9\u5F00\u901A\u6536\u4EF6\u7BB1\uFF09", "\n(inbox provisioned for this workspace)") : "";
        const autoReadNote = async (messages, note) => {
          if (args.mark_read === false) {
            return `${note}${L("\uFF08\u9884\u89C8\u6A21\u5F0F\uFF1A\u672A\u6539\u52A8\u5DF2\u8BFB\u72B6\u6001\uFF09", "(peek \u2014 read state untouched)")}`;
          }
          const unread = messages.filter((message) => !message.read_at);
          if (unread.length === 0) return note;
          const settled = await Promise.allSettled(
            unread.map(async (message) => {
              await markRead(inbox.api_url, inbox.api_key, message.message_id, "agent", exec?.signal);
              await setMessageMark(workspace.key, message.message_id, { read_by: "agent" });
            })
          );
          const marked = settled.filter((result) => result.status === "fulfilled").length;
          return L(
            "{note}\uFF08\u5DF2\u81EA\u52A8\u6807\u8BB0 {n} \u5C01\u4E3A\u5DF2\u8BFB\uFF09",
            "{note} (auto-marked {n} as read)",
            { note, n: marked }
          );
        };
        const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
        const explicit = args.since;
        const since = explicit ?? inbox.cursor;
        if (since) {
          const page2 = await listInbox(inbox.api_url, inbox.api_key, { folder: args.folder, limit, since }, exec?.signal);
          const advance = args.advance ?? explicit === void 0;
          if (advance && page2.next_cursor) await setCursor(workspace.key, page2.next_cursor);
          const messages = page2.messages ?? [];
          return `${banner}${provisionNote}
${formatMessages(
            messages,
            page2.unread_count ?? 0,
            await autoReadNote(messages, advance ? L("\u6E38\u6807\u5DF2\u63A8\u8FDB\uFF0C\u4E0B\u6B21\u53EA\u8FD4\u56DE\u66F4\u65B0\u3002", "Cursor advanced; the next call returns only what is newer.") : L("\u672A\u63A8\u8FDB\u6E38\u6807\uFF0C\u53EF\u91CD\u590D\u8BFB\u53D6\u3002", "Cursor not advanced \u2014 safe to re-read.")),
            { full: args.full, bodyLimit: args.body_limit }
          )}`;
        }
        const page = await listInbox(inbox.api_url, inbox.api_key, { folder: args.folder, limit }, exec?.signal);
        const all = page.messages ?? [];
        if (page.next_cursor) {
          await setCursor(workspace.key, page.next_cursor);
          return `${banner}${provisionNote}
${formatMessages(
            all,
            page.unread_count ?? 0,
            await autoReadNote(all, L("\u6E38\u6807\u5DF2\u63A8\u8FDB\uFF0C\u4E0B\u6B21\u53EA\u8FD4\u56DE\u66F4\u65B0\u3002", "Cursor advanced; the next call returns only what is newer.")),
            { full: args.full, bodyLimit: args.body_limit }
          )}`;
        }
        const fresh = withoutSeen(all, inbox.last_message_id);
        const newest = all[0]?.message_id;
        if (newest) await setLastMessageId(workspace.key, newest);
        return `${banner}${provisionNote}
${formatMessages(
          fresh,
          page.unread_count ?? 0,
          await autoReadNote(fresh, L(
            "\uFF08\u9996\u6B21\u62C9\u53D6\uFF0C\u5DF2\u7528\u300C\u6700\u65B0\u6D88\u606F\u300D\u4F5C\u4E3A\u589E\u91CF\u57FA\u7EBF\uFF09",
            "(first pull \u2014 the newest message is now the incremental baseline)"
          )),
          { full: args.full, bodyLimit: args.body_limit }
        )}`;
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_message",
    description: "Read ONE msg9.io message IN FULL, by message_id. msg9_inbox only carries a ~140-char preview per row, so a long letter is unreadable from the list \u2014 use this before answering anything substantive. Marks the message read (pass mark_read:false to peek).",
    parameters: {
      message_id: { type: "string", required: true, description: "The message_id to read (from msg9_inbox, an outbox row, or a wake notice)." },
      body_limit: { type: "integer", description: "Cap the body at N characters (default: the whole letter)." },
      mark_read: { type: "boolean", description: "Mark it read (default true). Pass false to peek." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec);
        const message = await getMessage(inbox.api_url, inbox.api_key, args.message_id, exec?.signal);
        const banner = L("[{title}] {address}", "[{title}] {address}", { title: workspace.title, address: inbox.address });
        if (args.mark_read !== false && !message.read_at) {
          await markRead(inbox.api_url, inbox.api_key, message.message_id, "agent", exec?.signal).catch(() => {
          });
          await setMessageMark(workspace.key, message.message_id, { read_by: "agent" }).catch(() => {
          });
        }
        return `${banner}
${formatMessage(message, Math.max(0, args.body_limit ?? 0))}`;
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_send",
    description: "Send a msg9.io message as the CURRENT workspace (provisioning its inbox on first use). Use msg9_peers to discover the other workspaces of this dsh instance, then send to their addresses to sync information. Retries are safe: the same Idempotency-Key returns the original message.",
    parameters: {
      to: { type: "string", required: true, description: 'Recipient address, e.g. "dsh-msg9-io-a1b2@msg9.io".' },
      text: { type: "string", required: true, description: "Message body in markdown (readers render it: headings, lists, tables, and fenced code blocks with a language tag, e.g. ```ts)." },
      subject: { type: "string", description: "Optional subject line." },
      reply_to: { type: "string", description: "The message_id you are replying to. ALWAYS set it on replies: it closes (processed) the original precisely \u2014 correlation_id alone cannot when the original never carried one (typical for cross-system mail)." },
      correlation_id: { type: "string", description: "The THREAD id: copy it VERBATIM from the message you are answering; omit when it had none. Never invent one (e.g. reusing the message id) \u2014 that forks the thread and group convergence views never see your reply." },
      idempotency_key: { type: "string", description: "Optional idempotency key; defaults to a generated one." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec);
        const idempotencyKey = args.idempotency_key || `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const result = await sendMessage(inbox.api_url, inbox.api_key, {
          to: args.to,
          subject: args.subject,
          text: args.text,
          replyTo: args.reply_to,
          correlationId: args.correlation_id,
          idempotencyKey
        }, exec?.signal, inbox.signing_seed ? { from: inbox.address, seedBase64: inbox.signing_seed } : void 0);
        const closedId = args.reply_to ?? args.correlation_id;
        if (closedId) await setMessageMark(workspace.key, closedId, { processed_by: "agent" });
        return L("[{title}] \u5DF2\u53D1\u9001\u5230 {to}\uFF1A{id}\uFF08{status}\uFF09", "[{title}] Sent to {to}: {id} ({status})", {
          title: workspace.title,
          to: args.to,
          id: result.message_id,
          status: result.status
        });
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_read",
    description: "Mark a msg9.io message as read for the current workspace. Rarely needed: msg9_inbox already auto-marks what it returns \u2014 use this only after a mark_read:false peek.",
    parameters: {
      message_id: { type: "string", required: true, description: "The message_id returned by msg9_inbox." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec);
        await markRead(inbox.api_url, inbox.api_key, args.message_id, "agent", exec?.signal);
        await setMessageMark(workspace.key, args.message_id, { read_by: "agent" });
        return L("\u5DF2\u6807\u8BB0\u4E3A\u5DF2\u8BFB\uFF1A{id}", "Marked as read: {id}", { id: args.message_id });
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_done",
    description: "Mark a msg9.io message as HANDLED (processed) for the current workspace: you read it and nothing more is needed \u2014 no reply, no follow-up. Replying with msg9_send + correlation_id already marks the original as processed; use this for mail that is closed WITHOUT a reply. Processed mail drops out of the\u300C\u5F85\u5904\u7406\u300Dview, so the human stops re-checking it.",
    parameters: {
      message_id: { type: "string", required: true, description: "The message_id returned by msg9_inbox." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec);
        try {
          await markProcessed(inbox.api_url, inbox.api_key, args.message_id, "agent", exec?.signal);
        } catch {
          await markRead(inbox.api_url, inbox.api_key, args.message_id, "agent", exec?.signal).catch(() => {
          });
        }
        await setMessageMark(workspace.key, args.message_id, { read_by: "agent", processed_by: "agent" });
        return L("\u5DF2\u6807\u8BB0\u4E3A\u5DF2\u5904\u7406\uFF1A{id}", "Marked as processed: {id}", { id: args.message_id });
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_notify",
    description: "Pause or resume msg9 new-mail wake-ups for this dsh instance. While paused the watcher keeps tracking (no backlog replay later) but never interrupts sessions; the panel badge keeps updating, and unprocessed mail is still found by msg9_inbox. Use when the human is mid-task and mail keeps derailing the conversation.",
    parameters: {
      action: { type: "string", required: true, description: "on | off | status" }
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.action === "status") {
        const paused = await getNotifyPaused();
        return paused ? L("\u65B0\u90AE\u4EF6\u63D0\u9192\uFF1A\u9759\u97F3\u4E2D\uFF08\u9762\u677F\u5FBD\u6807\u4ECD\u66F4\u65B0\uFF0Cmsg9_inbox \u7167\u5E38\u53EF\u67E5\uFF09", "New-mail wake-ups: paused (badge still updates; msg9_inbox works as usual)") : L("\u65B0\u90AE\u4EF6\u63D0\u9192\uFF1A\u5F00\u542F", "New-mail wake-ups: on");
      }
      if (args.action === "off") {
        await setNotifyPaused(true);
        return L("\u5DF2\u9759\u97F3\uFF1A\u65B0\u90AE\u4EF6\u4E0D\u518D\u6253\u65AD\u4F1A\u8BDD\uFF08watcher \u7167\u5E38\u8DDF\u8E2A\uFF0C\u89E3\u9664\u540E\u4E0D\u91CD\u64AD\uFF09\u3002", "Paused: mail no longer interrupts sessions (tracked silently, no replay on resume).");
      }
      if (args.action === "on") {
        await setNotifyPaused(false);
        return L("\u5DF2\u6062\u590D\u65B0\u90AE\u4EF6\u63D0\u9192\u3002", "New-mail wake-ups resumed.");
      }
      return L("\u672A\u77E5\u52A8\u4F5C {action}\uFF1A\u7528 on | off | status\u3002", "Unknown action {action}: use on | off | status.", { action: String(args.action) });
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_resolve",
    description: "Resolve a msg9.io address to its public record (existence, public key, metadata). Public endpoint \u2014 no credentials needed.",
    parameters: {
      address: { type: "string", required: true, description: 'Address to resolve, e.g. "bob" or "bob@msg9.io".' }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const record = await resolveAddress(defaultApiUrl(), args.address, exec?.signal);
        return L("\u89E3\u6790 {input}\uFF1A\n{json}", "Resolved {input}:\n{json}", {
          input: args.address,
          json: JSON.stringify(record, null, 2)
        });
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_peers",
    description: "List the msg9.io inboxes of the other dsh workspaces (siblings under the same owner), so this workspace can message another one to sync information. With no owner configured, lists the inboxes registered on this machine.",
    parameters: {
      limit: { type: "integer", description: "Max rows (default 100)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const state = await loadState();
        const localByAddress = new Map(
          Object.values(state.workspaces).map((inbox) => [inbox.address, inbox])
        );
        const owner = await getOwner();
        if (owner?.api_key) {
          const limit = Math.max(1, Math.min(args.limit ?? 100, 200));
          const { agents, total } = await ownerListAgents(owner.api_url, owner.api_key, 0, limit, exec?.signal);
          if (!agents || agents.length === 0) {
            return L("owner \u540D\u4E0B\u8FD8\u6CA1\u6709\u6536\u4EF6\u7BB1\u3002", "The owner has no inboxes yet.");
          }
          const body2 = agents.map((row) => {
            const known = localByAddress.get(row.agent_address);
            const label = known ? `${known.title} \xB7 ${known.path}` : row.profile?.display_name ?? "";
            const role = row.profile?.description ? ` \u2014 ${row.profile.description}` : "";
            const caps = row.profile?.capabilities?.length ? ` [${row.profile.capabilities.join(", ")}]` : "";
            return `\xB7 ${row.agent_address}${label ? `  (${label})` : ""}${role}${caps}`;
          }).join("\n");
          return L(
            "owner\u300C{owner}\u300D\u540D\u4E0B\u7684\u6536\u4EF6\u7BB1\uFF08{count}\uFF09\uFF1A\n{body}",
            'Inboxes under owner "{owner}" ({count}):\n{body}',
            { owner: owner.name ?? owner.id ?? "owner", count: total ?? agents.length, body: body2 }
          );
        }
        const local = Object.values(state.workspaces);
        if (local.length === 0) {
          return L(
            "\u672C\u673A\u8FD8\u6CA1\u6709\u4E3A\u4EFB\u4F55 workspace \u5F00\u901A\u6536\u4EF6\u7BB1\uFF08\u4E5F\u672A\u914D\u7F6E owner\uFF09\u3002\u5148\u8FD0\u884C msg9_inbox \u5373\u53EF\u81EA\u52A8\u5F00\u901A\u5F53\u524D workspace\u3002",
            "No workspace inbox is registered on this machine yet (and no owner is configured). Run msg9_inbox to provision the current workspace."
          );
        }
        const body = local.map((inbox) => `\xB7 ${inbox.address}  (${inbox.title} \xB7 ${inbox.path})`).join("\n");
        return L(
          "\u672C\u673A\u5DF2\u767B\u8BB0\u7684\u6536\u4EF6\u7BB1\uFF08\u672A\u914D\u7F6E owner\uFF0C{count}\uFF09\uFF1A\n{body}",
          "Inboxes registered on this machine (no owner, {count}):\n{body}",
          { count: local.length, body }
        );
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_rotate",
    description: "Rotate the current workspace's msg9 agent key (owner path only) and save the new key. Use it to recover when the local key was lost or leaked; the old key stops working immediately.",
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec);
        const owner = await getOwner();
        if (!owner?.api_key) {
          return L(
            "\u672A\u914D\u7F6E owner\uFF0C\u65E0\u6CD5\u8F6E\u6362 key\u3002\u8BF7\u5148\u7528 msg9_setup \u914D\u7F6E owner\uFF08\u6216\u91CD\u65B0\u6CE8\u518C\u8BE5 workspace\uFF09\u3002",
            "No owner configured, so the key cannot be rotated. Run msg9_setup first (or re-register this workspace)."
          );
        }
        const { api_key } = await ownerRotateAgentKey(owner.api_url, owner.api_key, inbox.address, exec?.signal);
        await upsertWorkspaceInbox(workspace.key, { api_key });
        return L(
          "\u5DF2\u8F6E\u6362\u300C{title}\u300D({address}) \u7684 key\uFF0C\u65B0 key \u5DF2\u4FDD\u5B58\u3002",
          'Rotated the key for "{title}" ({address}); the new key is saved.',
          { title: workspace.title, address: inbox.address }
        );
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_status",
    description: "Show the msg9.io identity of this dsh instance and the current workspace: owner (masked key), workspace inbox address, saved cursor, state file, and how many workspaces are registered.",
    parameters: {
      verify: { type: "boolean", description: "Also call msg9 to validate the current workspace credentials." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const owner = await getOwner();
      const state = await loadState();
      const workspace = resolveWorkspace(ctx, exec) ?? DEFAULT_WORKSPACE;
      const inbox = state.workspaces[workspace.key];
      const inboxCount = Object.keys(state.workspaces).length;
      const lines = [
        L("owner\uFF1A{v}", "owner: {v}", {
          v: owner ? `${owner.name ?? owner.id ?? "owner"}\uFF08${maskKey(owner.api_key)}\uFF09` : L("\u672A\u914D\u7F6E\uFF08\u6BCF workspace \u516C\u5F00\u6CE8\u518C\uFF09", "not configured (per-workspace public registration)")
        }),
        L("API\uFF1A{v}", "api: {v}", { v: owner?.api_url ?? defaultApiUrl() }),
        L("\u5F53\u524D workspace\uFF1A{title}  {path}", "current workspace: {title}  {path}", {
          title: workspace.title,
          path: workspace.path
        }),
        L("\u6536\u4EF6\u7BB1\uFF1A{v}", "inbox: {v}", {
          v: inbox ? `${inbox.address}\uFF08${maskKey(inbox.api_key)}\uFF09` : L("\u5C1A\u672A\u5F00\u901A\uFF08\u9996\u6B21 msg9_inbox \u65F6\u81EA\u52A8\u5F00\u901A\uFF09", "not provisioned yet (created on first msg9_inbox)")
        }),
        L("\u6E38\u6807\uFF1A{v}", "cursor: {v}", { v: inbox?.cursor || "(none)" }),
        L("\u7B7E\u540D\uFF1A{v}", "signing: {v}", {
          v: inbox?.signing_seed ? L("\u5F00\uFF08Ed25519 \u5DF2\u5B89\u88C5\uFF09", "on (Ed25519 installed)") : L("\u5173\uFF08\u672A\u5B89\u88C5\uFF1A\u670D\u52A1\u7AEF\u65E0\u8EAB\u4EFD\u5C42\u6216\u5B89\u88C5\u5931\u8D25\uFF09", "off (not installed: pre-identity server or install failed)")
        }),
        L("\u5DF2\u767B\u8BB0 workspace\uFF1A{v}", "registered workspaces: {v}", { v: inboxCount }),
        L("\u72B6\u6001\u6587\u4EF6\uFF1A{v}", "state file: {v}", { v: stateFilePath() })
      ];
      if (args.verify && inbox?.api_key) {
        try {
          const me = await getMe(inbox.api_url, inbox.api_key, exec?.signal);
          lines.push(L("\u6821\u9A8C\uFF1Aok\uFF08{json}\uFF09", "verify: ok ({json})", { json: JSON.stringify(me) }));
        } catch (error) {
          lines.push(L("\u6821\u9A8C\uFF1A\u5931\u8D25\uFF08{err}\uFF09", "verify: failed ({err})", { err: errorText(error) }));
        }
      }
      return lines.join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_outbox",
    description: "List the messages the CURRENT workspace has sent (msg9 outbox), newest first. Use it to confirm what this workspace already told a peer before sending again.",
    parameters: {
      limit: { type: "integer", description: "Max messages to return (default 20, max 100)." },
      offset: { type: "integer", description: "Pagination offset (default 0)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec);
        const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
        const offset = Math.max(0, args.offset ?? 0);
        const page = await listOutbox(inbox.api_url, inbox.api_key, { limit, offset }, exec?.signal);
        const messages = page.messages ?? [];
        const banner = L("[{title}] {address} \u53D1\u4EF6\u7BB1", "[{title}] {address} outbox", {
          title: workspace.title,
          address: inbox.address
        });
        if (messages.length === 0) return `${banner}
${L("\u8FD8\u6CA1\u6709\u5DF2\u53D1\u9001\u7684\u6D88\u606F\u3002", "Nothing sent yet.")}`;
        const lines = messages.map((message) => {
          const subject = message.subject ? ` ${message.subject}` : "";
          const excerpt = bodyText(message) ? ` \u2014 ${truncate(bodyText(message), 140)}` : "";
          return `\xB7 \u2192 ${message.to_address}${subject}${excerpt}  \`${message.message_id}\``;
        });
        return `${banner}
${L("{count} \u6761\uFF08\u5171 {total}\uFF09\uFF1A", "{count} of {total}:", {
          count: messages.length,
          total: page.total ?? messages.length
        })}
${lines.join("\n")}`;
      } catch (error) {
        return errorText(error);
      }
    }
  }));
  ctx.tools.register(defineTool({
    name: "msg9_contacts",
    description: `Manage the CURRENT workspace inbox's msg9 address book (the same contacts the msg9 panel shows): action "list" shows the saved addresses, "add" saves one with an optional alias/notes, "remove" deletes one. Saved contacts are a convenient recipient list for msg9_send.`,
    parameters: {
      action: { type: "string", required: true, description: "list | add | remove" },
      address: { type: "string", description: "Contact address (required for add/remove)." },
      alias: { type: "string", description: "Display name to save with the contact (add only)." },
      notes: { type: "string", description: "Free-form note to save with the contact (add only)." }
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      try {
        const { workspace, inbox } = await resolveInbox(ctx, exec);
        const banner = L("[{title}] {address} \u8054\u7CFB\u4EBA", "[{title}] {address} contacts", {
          title: workspace.title,
          address: inbox.address
        });
        const action = (args.action || "list").toLowerCase();
        if (action === "list") {
          const page = await listContacts(inbox.api_url, inbox.api_key, { limit: 100 }, exec?.signal);
          const contacts = page.contacts ?? [];
          if (contacts.length === 0) {
            return `${banner}
${L("\u901A\u8BAF\u5F55\u4E3A\u7A7A\u3002", "The address book is empty.")}`;
          }
          const lines = contacts.map((contact) => {
            const alias = contact.alias ? `${contact.alias} ` : "";
            const notes = contact.notes ? `  \u2014 ${truncate(contact.notes, 80)}` : "";
            return `\xB7 ${alias}<${contact.contact}>${notes}`;
          });
          return `${banner}
${L("{count} \u4E2A\u8054\u7CFB\u4EBA\uFF1A", "{count} contact(s):", { count: page.total ?? contacts.length })}
${lines.join("\n")}`;
        }
        if (!args.address) {
          return L("action={action} \u9700\u8981 address\u3002", "action={action} requires an address.", { action });
        }
        if (action === "add") {
          const created = await addContact(inbox.api_url, inbox.api_key, {
            contact: args.address,
            ...args.alias ? { alias: args.alias } : {},
            ...args.notes ? { notes: args.notes } : {}
          }, exec?.signal);
          return L("{banner}\n\u5DF2\u6DFB\u52A0\u8054\u7CFB\u4EBA\uFF1A{contact}", "{banner}\nContact added: {contact}", {
            banner,
            contact: created?.contact ?? args.address
          });
        }
        if (action === "remove") {
          await deleteContact(inbox.api_url, inbox.api_key, args.address, exec?.signal);
          return L("{banner}\n\u5DF2\u5220\u9664\u8054\u7CFB\u4EBA\uFF1A{contact}", "{banner}\nContact removed: {contact}", {
            banner,
            contact: args.address
          });
        }
        return L("\u672A\u77E5 action\u300C{action}\u300D\uFF1A\u8BF7\u7528 list / add / remove\u3002", 'Unknown action "{action}": use list / add / remove.', {
          action
        });
      } catch (error) {
        return errorText(error);
      }
    }
  }));
}

// src/host/watch.ts
function pluginNotice(uuid, text, summary) {
  return {
    role: "user",
    id: uuid,
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "msg9-kit", form: "notice", summary: truncate(summary, 120) }
  };
}
function renderMailNotice(address, messages) {
  const ordered = [...messages].sort((a, b) => {
    const at = Date.parse(a.created_at ?? "") || 0;
    const bt = Date.parse(b.created_at ?? "") || 0;
    return at - bt;
  });
  const threadSizes = /* @__PURE__ */ new Map();
  for (const message of ordered) {
    if (message.correlation_id) threadSizes.set(message.correlation_id, (threadSizes.get(message.correlation_id) ?? 0) + 1);
  }
  const shown = ordered.slice(0, 5);
  const lines = shown.map((message, index) => {
    const subject = message.subject ? `\u300C${message.subject}\u300D` : "";
    const preview = truncate(bodyText(message), 90);
    const thread = message.correlation_id && (threadSizes.get(message.correlation_id) ?? 0) > 1 ? " [\u7EBF\u7A0B]" : "";
    return `${index + 1}. ${message.from_address} ${subject}${thread}${preview ? `\uFF1A${preview}` : ""}`;
  });
  const more = ordered.length > shown.length ? `
\u2026\u4EE5\u53CA\u53E6\u5916 ${ordered.length - shown.length} \u5C01\u3002` : "";
  const first = ordered[0];
  return {
    text: `[msg9 \u65B0\u90AE\u4EF6] \u4F60\u7684 inbox ${address} \u6536\u5230 ${ordered.length} \u5C01\u65B0\u90AE\u4EF6\uFF1A
` + lines.join("\n") + more + `
\u8BF7\u8C03\u7528 msg9_inbox\uFF08folder=unprocessed\uFF09\u67E5\u770B\u672A\u5904\u7406\u7684\u5E76\u9010\u4E00\u95ED\u73AF\uFF08\u56DE\u590D\u5E26 reply_to\uFF1B\u5DF2\u5728\u522B\u5904\u5904\u7406\u8FC7\u7684\u4E0D\u4F1A\u518D\u51FA\u73B0\uFF09\u3002`,
    summary: first ? `new msg9 mail from ${first.from_address}` : "new msg9 mail"
  };
}
var WakeBudget = class {
  constructor(maxWakes = 3, windowMs = 30 * 6e4) {
    this.maxWakes = maxWakes;
    this.windowMs = windowMs;
  }
  wakes = [];
  /** 'wake' and record, or 'inject' once the window is full. */
  decide(now) {
    this.wakes = this.wakes.filter((at) => now - at < this.windowMs);
    if (this.wakes.length >= this.maxWakes) return "inject";
    this.wakes.push(now);
    return "wake";
  }
};
function createWatchRuntime() {
  return { agentBudgets: /* @__PURE__ */ new Map(), inboxBudgets: /* @__PURE__ */ new Map(), batches: /* @__PURE__ */ new Map() };
}
function unseenMessages(messages, lastSeenId, lastSeenAt) {
  if (!lastSeenId) return messages;
  const index = messages.findIndex((message) => message.message_id === lastSeenId);
  if (index !== -1) return messages.slice(0, index);
  if (lastSeenAt) {
    const baseline = Date.parse(lastSeenAt);
    if (Number.isFinite(baseline)) {
      return messages.filter((message) => {
        const created = Date.parse(message.created_at ?? "");
        return Number.isFinite(created) ? created > baseline : true;
      });
    }
  }
  return messages;
}
function createNonReentrant(task) {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    void task().finally(() => {
      running = false;
    });
  };
}
async function pollOnce(deps, rt) {
  const state = await deps.loadState();
  for (const [key, inbox] of Object.entries(state.workspaces)) {
    if (!inbox.api_key) continue;
    try {
      await pollInbox(deps, rt, key, inbox);
    } catch (error) {
      deps.log(`watch poll failed for ${key}: ${error?.message ?? String(error)}`);
      const status = error?.status;
      if (status === 429) {
        const serverWait = error?.retryAfter;
        const backoff = typeof serverWait === "number" && serverWait > 0 ? serverWait * 1e3 : 6e4;
        deps.log(`watch poll rate-limited for ${key}; backing off ${backoff / 1e3}s`);
        await (deps.sleep ?? defaultSleep)(backoff);
      }
    }
  }
}
var StreamUnsupportedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StreamUnsupportedError";
  }
};
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
function mintStreamCursor(at) {
  return Buffer.from(`${at.toISOString()}|0`, "utf8").toString("base64url");
}
async function streamInboxLoop(deps, rt, key, signal) {
  let failures = 0;
  while (!signal.aborted) {
    const state = await deps.loadState();
    const inbox = state.workspaces[key];
    if (!inbox?.api_key) return;
    try {
      if (!inbox.watch_cursor) {
        await pollInbox(deps, rt, key, inbox);
        const after = await deps.loadState();
        if (!after.workspaces[key]?.watch_cursor) {
          await deps.setWatchState(key, { watch_cursor: mintStreamCursor(new Date(deps.now())) });
        }
        continue;
      }
      const page = await deps.streamInbox(inbox.api_url, inbox.api_key, { since: inbox.watch_cursor, wait: 25 }, signal);
      failures = 0;
      if (signal.aborted) return;
      if (page.next_cursor) await deps.setWatchState(key, { watch_cursor: page.next_cursor });
      const fresh = page.messages ?? [];
      if (fresh.length === 0) continue;
      await deps.setWatchState(key, {
        watch_last_message_id: fresh[0].message_id,
        ...fresh[0].created_at ? { watch_last_seen_at: fresh[0].created_at } : {}
      });
      deps.onEvent?.("mail");
      await enqueueDelivery(deps, rt, key, inbox, fresh);
    } catch (error) {
      if (signal.aborted) return;
      const status = error?.status;
      if (status === 400 || status === 404 || status === 501) {
        throw new StreamUnsupportedError(`/inbox/stream answered HTTP ${status}`);
      }
      failures += 1;
      const serverWait = error?.retryAfter;
      const backoff = typeof serverWait === "number" && serverWait > 0 ? serverWait * 1e3 : status === 429 ? 6e4 : Math.min(3e4, 2e3 * 2 ** Math.min(failures, 4));
      deps.log(`watch stream failed for ${key}: ${error?.message ?? String(error)}; retry in ${backoff / 1e3}s`);
      await deps.sleep(backoff, signal);
    }
  }
}
async function pollInbox(deps, rt, key, inbox) {
  const since = inbox.watch_cursor;
  if (since) {
    const page2 = await deps.listInbox(inbox.api_url, inbox.api_key, { folder: "all", limit: 20, since });
    if (page2.next_cursor) await deps.setWatchState(key, { watch_cursor: page2.next_cursor });
    const fresh2 = page2.messages ?? [];
    if (fresh2.length > 0) await deps.setWatchState(key, {
      watch_last_message_id: fresh2[0].message_id,
      ...fresh2[0].created_at ? { watch_last_seen_at: fresh2[0].created_at } : {}
    });
    if (fresh2.length > 0) deps.onEvent?.("mail");
    if (fresh2.length > 0) await enqueueDelivery(deps, rt, key, inbox, fresh2);
    return;
  }
  const page = await deps.listInbox(inbox.api_url, inbox.api_key, { folder: "all", limit: 20 });
  const all = page.messages ?? [];
  if (page.next_cursor) {
    await deps.setWatchState(key, { watch_cursor: page.next_cursor });
    if (all[0]) await deps.setWatchState(key, {
      watch_last_message_id: all[0].message_id,
      ...all[0].created_at ? { watch_last_seen_at: all[0].created_at } : {}
    });
    return;
  }
  const fresh = unseenMessages(all, inbox.watch_last_message_id, inbox.watch_last_seen_at);
  if (all[0]) await deps.setWatchState(key, {
    watch_last_message_id: all[0].message_id,
    ...all[0].created_at ? { watch_last_seen_at: all[0].created_at } : {}
  });
  if (inbox.watch_last_message_id && fresh.length > 0) deps.onEvent?.("mail");
  if (inbox.watch_last_message_id && fresh.length > 0) await enqueueDelivery(deps, rt, key, inbox, fresh);
}
async function enqueueDelivery(deps, rt, key, inbox, messages) {
  if (await deps.isPaused?.()) {
    deps.log(`watch: notify paused \u2014 ${messages.length} mail(s) for ${inbox.address} tracked silently`);
    return;
  }
  const windowMs = deps.batchWindowMs ?? 12e3;
  if (windowMs <= 0) return deliverBatch(deps, rt, key, inbox, messages);
  const batch = rt.batches.get(key) ?? { messages: /* @__PURE__ */ new Map() };
  for (const message of messages) batch.messages.set(message.message_id, message);
  rt.batches.set(key, batch);
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => void flushBatch(deps, rt, key, inbox), windowMs);
}
async function flushBatch(deps, rt, key, inbox) {
  const batch = rt.batches.get(key);
  if (!batch) return;
  if (batch.timer) clearTimeout(batch.timer);
  rt.batches.delete(key);
  const messages = [...batch.messages.values()].sort((a, b) => {
    const at = Date.parse(a.created_at ?? "") || 0;
    const bt = Date.parse(b.created_at ?? "") || 0;
    return at - bt;
  });
  await deliverBatch(deps, rt, key, inbox, messages);
}
async function onlyUnprocessed(deps, inbox, messages) {
  if (messages.length === 0) return messages;
  try {
    const page = await deps.listInbox(inbox.api_url, inbox.api_key, { folder: "unprocessed", limit: 100 });
    const live = new Set((page.messages ?? []).map((message) => message.message_id));
    const kept = messages.filter((message) => live.has(message.message_id));
    if (kept.length < messages.length) {
      deps.log(`watch: skipped ${messages.length - kept.length} mail(s) already closed server-side for ${inbox.address}`);
    }
    return kept;
  } catch (error) {
    deps.log(`watch: unprocessed reconcile failed for ${inbox.address} (${error?.message ?? String(error)}); falling back to processed_at`);
    return messages.filter((message) => !message.processed_at);
  }
}
async function deliverBatch(deps, rt, key, inbox, messages) {
  const actionable = await onlyUnprocessed(deps, inbox, messages);
  if (actionable.length === 0) return;
  let agent;
  if (inbox.last_wake_agent_id && deps.resolveAgentById) {
    agent = deps.resolveAgentById(inbox.last_wake_agent_id);
  }
  if (!agent) {
    agent = await deps.resolveAgent({ key, inbox });
    if (agent) await deps.setWatchState(key, { last_wake_agent_id: agent.id });
  }
  if (!agent) return;
  const { text, summary } = renderMailNotice(inbox.address, actionable);
  const message = pluginNotice(deps.uuid(), text, summary);
  const agentBudget = rt.agentBudgets.get(agent.id) ?? new WakeBudget();
  rt.agentBudgets.set(agent.id, agentBudget);
  const inboxBudget = rt.inboxBudgets.get(inbox.address) ?? new WakeBudget();
  rt.inboxBudgets.set(inbox.address, inboxBudget);
  const decision = agentBudget.decide(deps.now()) === "wake" && inboxBudget.decide(deps.now()) === "wake" ? "wake" : "inject";
  if (decision === "wake") {
    agent.followup(message);
    deps.log(`watch: woke ${agent.id} with ${actionable.length} new mail(s) for ${inbox.address}`);
  } else {
    agent.inject(message);
    deps.log(`watch: wake budget spent for ${agent.id}/${inbox.address}; injected ${actionable.length} mail(s) as context`);
  }
}

// src/host/index.ts
var name = "msg9-kit";
var inject = ["tools", "commands", "sessions"];
var WATCH_POLL_MS = Math.max(1e3, Number(process.env.MSG9_WATCH_MS ?? 3e4) || 3e4);
function apply(ctx) {
  const log = ctx.logger("msg9-kit");
  log.info("msg9-kit loaded");
  registerMsg9Tools(ctx);
  log.info("msg9 tools registered (setup, inbox, outbox, send, read, done, message, notify, resolve, contacts, peers, rotate, status)");
  registerMsg9Commands(ctx.commands);
  log.info("msg9 command registered (/msg9)");
  let registry;
  ctx.inject(["workspaceRegistry"], (child) => {
    registry = child.workspaceRegistry;
    setWorkspaceRegistry(registry);
    if (registry) log.info("msg9 workspace registry connected");
  });
  const events = createBridgeEventBus();
  const bridgeDeps = defaultBridgeDeps(ctx);
  bridgeDeps.events = events;
  const bridge = createMsg9Bridge(bridgeDeps);
  ctx.inject(["webServer"], (child) => {
    const server = child.webServer;
    if (!server) return;
    child.effect(() => server.register({
      kind: "prefix",
      path: BRIDGE_PREFIX,
      handler: (req, res) => void bridge.handle(
        req,
        res
      )
    }), "msg9-kit: browser bridge");
    log.info(`msg9 browser bridge mounted at ${BRIDGE_PREFIX}`);
  });
  const reconcileUnread = async () => {
    try {
      const view = await computeUnread(bridgeDeps, new AbortController().signal);
      const snapshot = JSON.stringify({ total: view.total, byKey: view.byKey });
      if (snapshot !== reconcileUnread.last) {
        reconcileUnread.last = snapshot;
        events.emit("sync");
      }
    } catch {
    }
  };
  reconcileUnread.last = "";
  ctx.inject(["systemPrompt"], (child) => {
    const systemPrompt = child.systemPrompt;
    if (!systemPrompt) return;
    systemPrompt.section({
      name: "msg9:mailbox",
      order: 5e3,
      text: L(
        "## msg9 \u90AE\u7BB1\n\u672C dsh \u5B9E\u4F8B\u4E3A\u6BCF\u4E2A workspace \u63D0\u4F9B\u4E86\u4E00\u4E2A msg9 \u6536\u4EF6\u7BB1\uFF08msg9_* \u5DE5\u5177\uFF09\u3002\u89C4\u5219\uFF1A\n- \u4F1A\u8BDD\u5F00\u59CB\u3001\u4EE5\u53CA\u6536\u5230 [msg9 \u65B0\u90AE\u4EF6] \u901A\u77E5\u65F6\uFF0C\u8C03\u7528 msg9_inbox \u8BFB\u53D6\u5E76\u5904\u7406\uFF08folder=unprocessed \u53EA\u770B\u672A\u95ED\u73AF\u7684\uFF1B\u8BFB\u53D6\u8FD4\u56DE\u7684\u672A\u8BFB\u6D88\u606F\u4F1A\u81EA\u52A8\u6807\u8BB0\u4E3A\u5DF2\u8BFB\uFF0C\u4E0D\u9700\u8981\u4EBA\u5DE5\u70B9\u300C\u5DF2\u8BFB\u300D\uFF1B\u53EA\u60F3\u9884\u89C8\u4F20 mark_read: false\uFF09\uFF1B\n- \u9700\u8981\u7ED9\u672C\u5B9E\u4F8B\u7684\u5176\u4ED6 workspace / Agent \u540C\u6B65\u8FDB\u5C55\u3001\u7ED3\u8BBA\u6216\u8BF7\u6C42\u534F\u52A9\u65F6\uFF0C\u5148\u7528 msg9_peers \u67E5\u5730\u5740\uFF0C\u518D\u7528 msg9_send \u53D1\u9001\uFF1B\u56DE\u590D\u52A1\u5FC5\u5E26 reply_to\uFF08\u539F\u6D88\u606F\u7684 message_id\uFF09\u2014\u2014\u5B83\u7CBE\u786E\u95ED\u73AF\u539F\u4FE1\uFF1B\u7EBF\u7A0B\u4E32\u8054\u7528 correlation_id\uFF0C**\u539F\u6837\u7167\u6284\u6765\u4FE1\u4E0A\u7684\u503C**\uFF08\u6765\u4FE1\u6CA1\u6709\u5C31\u4E0D\u4F20\uFF0C\u7EDD\u4E0D\u80FD\u62FF\u6D88\u606F id \u9876\u66FF\uFF0C\u5426\u5219\u7EBF\u7A0B\u5206\u53C9\uFF09\uFF1B\n- \u90AE\u4EF6\u6B63\u6587\u7528 markdown \u5199\uFF08\u53CC\u65B9\u90FD\u5728\u6D4F\u89C8\u5668\u9762\u677F\u91CC\u9605\u8BFB\uFF09\uFF1A\u6807\u9898\u3001\u5217\u8868\u3001\u8868\u683C\u90FD\u884C\uFF0C\u4EE3\u7801\u7528\u5E26\u8BED\u8A00\u6807\u6CE8\u7684\u56F4\u680F\uFF08```ts \u7B49\uFF09\uFF0C\u6709\u8BED\u6CD5\u9AD8\u4EAE\uFF1B\n- \u5904\u7406\u5B8C\u4E00\u5C01\u4E0D\u9700\u8981\u56DE\u590D\u7684\u90AE\u4EF6\uFF0C\u7528 msg9_done \u663E\u5F0F\u95ED\u73AF\u2014\u2014\u5B83\u624D\u4F1A\u4ECE\u300C\u5F85\u5904\u7406\u300D\u91CC\u6D88\u5931\uFF1B\n- msg9_status \u53EF\u968F\u65F6\u67E5\u770B\u4F60\u5F53\u524D workspace \u7684\u90AE\u7BB1\u5730\u5740\u4E0E\u72B6\u6001\u3002\n\u8EAB\u4EFD\u8FB9\u754C\uFF1A\n- \u4F60\u7684\u90AE\u7BB1\u7531\u672C\u63D2\u4EF6\u7BA1\u7406\uFF0Cmsg9_* \u5DE5\u5177\u662F\u4F60\u552F\u4E00\u7684\u6536\u53D1\u901A\u9053\uFF1B\u4E0D\u8981\u8BFB\u53D6\u6216\u4F7F\u7528\u5176\u4ED6 Agent \u7684\u51ED\u636E\u6587\u4EF6\uFF08\u5982 ~/.kimi-code/msg9.json\u3001\u5176\u4ED6\u5B9E\u4F8B\u7684 state.json\uFF09\uFF0C\u4E5F\u4E0D\u8981\u5192\u7528\u522B\u7684\u5B9E\u4F8B\u7684\u4FE1\u7BB1\u53D1\u4FE1\uFF1B\n- \u4E0E\u5176\u4ED6 Agent \u7684\u5F80\u6765\u4E2D\uFF0C\u9047\u5230\u4E0D\u786E\u5B9A\u7684\u4FE1\u606F\u3001\u672A\u62CD\u677F\u7684\u65B9\u6848\u6216\u4EFB\u4F55\u9700\u8981\u51B3\u7B56\u7684\u4E8B\uFF0C\u4E0D\u8981\u81EA\u4F5C\u4E3B\u5F20\u2014\u2014\u5148\u505C\u4E0B\u6765\u5411\u4EBA\u7C7B\u4E3B\u4EBA\u8BF4\u660E\u60C5\u51B5\u5E76\u8BF7\u793A\uFF0C\u786E\u8BA4\u540E\u518D\u884C\u52A8\u3002",
        "## msg9 mailbox\nThis dsh instance gives every workspace a msg9 inbox (msg9_* tools). Rules:\n- At session start, and whenever a [msg9 \u65B0\u90AE\u4EF6] notice arrives, call msg9_inbox and handle what is open (folder=unprocessed shows only unclosed mail; unread messages it returns are auto-marked as read \u2014 no human click needed; pass mark_read: false to peek);\n- To sync progress, conclusions or requests to sibling workspaces / agents of this instance, look up addresses with msg9_peers, then msg9_send; ALWAYS pass reply_to (the original message_id) when replying \u2014 it closes the original precisely; for threading, copy correlation_id VERBATIM from the incoming message (omit when it had none; never substitute the message id \u2014 that forks the thread);\n- Write mail bodies in markdown (both sides read in a browser panel): headings, lists, tables, and language-tagged fenced code blocks (```ts etc.) with syntax highlighting;\n- When a message needs no reply, close it explicitly with msg9_done \u2014 that clears it from\u300C\u5F85\u5904\u7406\u300D;\n- msg9_status shows the current workspace's address and state at any time.\nIdentity boundary:\n- Your mailbox is managed by this plugin; the msg9_* tools are your ONLY channel. Never read or use other agents' credential files (e.g. ~/.kimi-code/msg9.json, another instance's state.json), and never send mail impersonating another instance's inbox;\n- In correspondence with other agents, never act on uncertain information, unconfirmed proposals or anything that needs a decision \u2014 stop, explain to your human, and wait for confirmation first."
      )
    });
    log.info("msg9 mailbox rules added to the system prompt");
  });
  ctx.inject(["agents"], (child) => {
    const agents = child.agents;
    if (!agents) return;
    startWatcher(child, agents, () => registry, (message) => log.info(message), events, reconcileUnread);
    log.info(`msg9 new-mail watcher started (every ${WATCH_POLL_MS / 1e3}s, budget-capped wakeups)`);
  });
}
function startWatcher(ctx, agents, getRegistry, log, events, reconcileUnread) {
  const rt = createWatchRuntime();
  const deps = {
    loadState,
    setWatchState,
    listInbox: (apiUrl, apiKey, query) => listInbox(apiUrl, apiKey, query),
    onEvent: (event) => events.emit(event),
    isPaused: () => getNotifyPaused(),
    resolveAgentById: (id) => agents.get(id),
    batchWindowMs: Math.max(0, Number(process.env.MSG9_WATCH_BATCH_MS ?? 12e3) || 12e3),
    sleep: defaultSleep,
    resolveAgent: async ({ inbox }) => {
      const registry = getRegistry();
      if (registry?.resolveByPath) {
        try {
          const workspace = await registry.resolveByPath(inbox.path);
          const sessionId = workspace?.sessionIds?.[0];
          if (sessionId) {
            const agent = agents.get(sessionId);
            if (agent) return agent;
          }
        } catch {
        }
      }
      return agents.list().find((agent) => cwdOfAgentSession(ctx, agent.id) === inbox.path);
    },
    uuid: () => randomUUID(),
    now: () => Date.now(),
    log
  };
  if (process.env.MSG9_WATCH !== "0") {
    ctx.effect(() => {
      const streamDeps = {
        ...deps,
        streamInbox: (apiUrl, apiKey, query, signal) => streamInbox(apiUrl, apiKey, query, signal),
        sleep: defaultSleep
      };
      const master = new AbortController();
      const loopControllers = /* @__PURE__ */ new Map();
      let pollTimer;
      let reconcileTimer;
      let streamUnsupported = process.env.MSG9_WATCH_STREAM === "0";
      const stopLoops = () => {
        for (const controller of loopControllers.values()) controller.abort();
        loopControllers.clear();
      };
      const startPolling = () => {
        pollTimer ??= setInterval(createNonReentrant(() => pollOnce(deps, rt)), WATCH_POLL_MS);
      };
      const reconcile = async () => {
        if (streamUnsupported || master.signal.aborted) return;
        const state = await loadState();
        for (const [key, inbox] of Object.entries(state.workspaces)) {
          if (!inbox.api_key || loopControllers.has(key)) continue;
          const controller = new AbortController();
          loopControllers.set(key, controller);
          void streamInboxLoop(streamDeps, rt, key, controller.signal).catch((error) => {
            if (error instanceof StreamUnsupportedError) {
              if (!streamUnsupported) {
                streamUnsupported = true;
                log(`msg9 has no /inbox/stream \u2014 watcher falls back to ${WATCH_POLL_MS / 1e3}s polling`);
                stopLoops();
                startPolling();
              }
            } else if (!master.signal.aborted) {
              log(`watch stream loop for ${key} ended: ${error?.message ?? String(error)}`);
            }
          }).finally(() => {
            loopControllers.delete(key);
          });
        }
      };
      if (streamUnsupported) {
        startPolling();
      } else {
        void reconcile();
        reconcileTimer = setInterval(() => void reconcile(), 6e4);
      }
      return () => {
        master.abort();
        stopLoops();
        if (pollTimer) clearInterval(pollTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
      };
    }, "msg9-kit: mail watcher");
  }
  ctx.effect(() => {
    const timer = setInterval(() => void reconcileUnread(), 12e4);
    return () => clearInterval(timer);
  }, "msg9-kit: unread reconcile");
  ctx.on("agent/session-start", (payload) => {
    const { agent } = payload;
    void (async () => {
      const cwd = cwdOfAgentSession(ctx, agent.id);
      const workspace = matchWorkspaceByPath(ctx, cwd);
      if (!workspace) return;
      const state = await loadState();
      const inbox = state.workspaces[workspace.key];
      if (!inbox?.api_key) return;
      const siblings = Object.values(state.workspaces).filter((row) => row.api_key && row.address !== inbox.address);
      const roster = siblings.length > 0 ? L(
        "\n\u672C\u5B9E\u4F8B\u7684\u5176\u4ED6 workspace \u90AE\u7BB1\uFF08\u8DE8\u9879\u76EE\u534F\u4F5C\u5BF9\u8C61\uFF09\uFF1A\n{list}\n\u9700\u8981\u540C\u6B65\u8FDB\u5C55\u3001\u7ED3\u8BBA\u6216\u8BF7\u6C42\u534F\u52A9\u65F6\uFF0C\u7528 msg9_send \u76F4\u63A5\u53D1\u7ED9\u5B83\u4EEC\u3002",
        "\nSibling inboxes of this instance (your collaborators):\n{list}\nTo sync progress, conclusions or requests, msg9_send them directly.",
        { list: siblings.map((row) => `\xB7 ${row.title}\uFF08${row.path}\uFF09\uFF1A${row.address}`).join("\n") }
      ) : "";
      agent.inject(pluginNotice(
        randomUUID(),
        L(
          "\u4F60\u7684 msg9 \u90AE\u7BB1\u662F {address}\uFF08\u672C workspace \u7684\u6536\u4EF6\u7BB1\uFF09\u3002\u4F1A\u8BDD\u5F00\u59CB\uFF1A\u8C03\u7528 msg9_inbox\uFF08folder=unprocessed\uFF09\u770B\u6709\u6CA1\u6709\u672A\u5904\u7406\u7684\u90AE\u4EF6\u2014\u2014\u5DF2\u5728\u522B\u5904\u5904\u7406\u8FC7\u7684\u4E0D\u4F1A\u518D\u51FA\u73B0\u3002{roster}",
          "Your msg9 inbox is {address} (this workspace's mailbox). Session start: call msg9_inbox (folder=unprocessed) for anything still open \u2014 mail already handled anywhere else will not resurface.{roster}",
          { address: inbox.address, roster }
        ),
        `msg9 inbox for this workspace: ${inbox.address}`
      ));
    })().catch((error) => log(`session-start seed failed: ${error?.message ?? String(error)}`));
  });
}
function cwdOfAgentSession(ctx, agentId) {
  try {
    const sessions = ctx.sessions;
    return sessions?.get(agentId)?.header?.cwd;
  } catch {
    return void 0;
  }
}
export {
  BRIDGE_PREFIX,
  StreamUnsupportedError,
  WakeBudget,
  apply,
  computeUnread,
  createBridgeEventBus,
  createMsg9Bridge,
  createNonReentrant,
  createWatchRuntime,
  defaultBridgeDeps,
  ensureInbox,
  flushBatch,
  inject,
  invalidateUnreadCache,
  isTrustedRequest,
  listWorkspaces,
  loadState,
  matchWorkspaceByPath,
  migrateInbox,
  name,
  ownerContext,
  pluginNotice,
  pollOnce,
  renderMailNotice,
  resolveInbox,
  resolveWorkspace,
  setOwner,
  setWorkspaceRegistry,
  stateFilePath,
  streamInboxLoop,
  unseenMessages,
  upsertWorkspaceInbox
};
