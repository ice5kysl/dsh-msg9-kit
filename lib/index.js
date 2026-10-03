// src/host/index.ts
import { randomUUID as randomUUID3 } from "node:crypto";

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
function issueWsTicket(apiUrl, apiKey, signal) {
  return msg9Request(apiUrl, "/api/v1/ws-ticket", { method: "POST", apiKey, signal });
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
async function orgInfo(apiUrl, orgKey, signal) {
  const data = await msg9Request(apiUrl, "/api/v1/org", { apiKey: orgKey, signal });
  const org = data?.org;
  if (!org?.label) {
    throw new Error("msg9 \u672A\u8FD4\u56DE ORG label\uFF08GET /api/v1/org \u7684 data.org.label \u4E3A\u7A7A\uFF09");
  }
  return org;
}
async function orgListPods(apiUrl, orgKey, signal) {
  const data = await msg9Request(apiUrl, "/api/v1/org/pods", { apiKey: orgKey, signal });
  return data?.pods ?? [];
}
function orgCreatePod(apiUrl, orgKey, input, signal) {
  return msg9Request(apiUrl, "/api/v1/org/pods", {
    method: "POST",
    apiKey: orgKey,
    signal,
    body: { label: input.label, ...input.name ? { name: input.name } : {} }
  });
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

// src/host/credentials.ts
import { createHash as createHash2 } from "node:crypto";
import { chmod, mkdir as mkdir2, readFile as readFile2, readdir, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, join as join2 } from "node:path";

// src/host/store.ts
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function isTenantOwner(owner) {
  return Boolean(owner && (owner.slug || owner.address_domain));
}
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
      // ORG 绑定（2026-09-30 新增）。**必须在这里显式 re-hydrate**，
      // 否则它会变成"写得进、读不出"的字段 —— 上面那条注释警告的正是这个。
      org: parsed?.org,
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
function withStateLock(task) {
  return enqueueWrite(task);
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
async function relinkWorkspaceInbox(fromKey, toKey, patch = {}) {
  return enqueueWrite(async () => {
    const state = await loadState();
    const source = state.workspaces[fromKey];
    if (!source) return void 0;
    if (state.workspaces[toKey]) {
      throw new Error(`workspace "${toKey}" already has an inbox record`);
    }
    const moved = { ...source, ...patch };
    state.workspaces[toKey] = moved;
    delete state.workspaces[fromKey];
    await saveState(state);
    return moved;
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
function listRegisteredWorkspaces() {
  try {
    return (injectedRegistry?.list?.() ?? []).map(toCurrent);
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
var HARNESS_AGENT_NAMES = {
  dsh: "dsh",
  kimi: "kimi",
  claude: "cc"
};
var HARNESS = "dsh";
function harnessAgentName(harness = HARNESS) {
  return HARNESS_AGENT_NAMES[harness] ?? harness;
}
function deriveAddress(workspace, options) {
  if (options?.tenant) return harnessAgentName();
  const slug = slugify(workspace.title) || slugify(basename(workspace.path)) || "ws";
  const address = `dsh-${slug}-${shortHash(workspace.key)}`;
  return address.slice(0, 30).replace(/[^a-z0-9]+$/, "");
}
function tenantAddressCandidates(workspace, preferred) {
  void workspace;
  const base = harnessAgentName();
  return [.../* @__PURE__ */ new Set([
    ...preferred ? [preferred] : [],
    base,
    `${base}-2`,
    `${base}-3`,
    `${base}-4`
  ])];
}
function isValidLocalPart(value) {
  return /^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/.test(value);
}

// src/host/credentials.ts
function msg9Home() {
  return process.env.MSG9_HOME || join2(homedir2(), ".msg9");
}
function tenantsDir() {
  return join2(msg9Home(), "tenants");
}
function projectsDir() {
  return join2(msg9Home(), "projects", "dsh");
}
function orgsDir() {
  return join2(msg9Home(), "orgs");
}
function orgKeyPath(orgLabel) {
  return join2(orgsDir(), `${sanitizeKey(orgLabel)}.key`);
}
function tenantKeyPath() {
  return join2(tenantsDir(), "dsh.key");
}
function projectYamlPath(projectKey) {
  return join2(projectsDir(), `${projectKey}.yaml`);
}
function signingYamlPath(projectKey) {
  return join2(projectsDir(), `${projectKey}.signing.yaml`);
}
function defaultDeps() {
  return { listWorkspaces: listRegisteredWorkspaces, log: () => {
  } };
}
function sanitizeKey(text) {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
async function gitRemoteKey(path) {
  let raw;
  try {
    raw = await readFile2(join2(path, ".git", "config"), "utf8");
  } catch {
    return void 0;
  }
  const match = /^\s*url\s*=\s*(\S+)\s*$/m.exec(raw);
  const url = match?.[1];
  if (!url) return void 0;
  let hostPath;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp) {
    hostPath = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const parsed = new URL(url);
      hostPath = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return void 0;
    }
  }
  const normalized = hostPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  const key = normalized.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || void 0;
}
async function deriveProjectKey(workspace) {
  const remote = await gitRemoteKey(workspace.path);
  if (remote) return remote;
  const hash = createHash2("sha256").update(workspace.path).digest("hex").slice(0, 6);
  const name2 = sanitizeKey(basename2(workspace.path.replace(/\/+$/, ""))) || "workspace";
  return `${name2}-${hash}`;
}
async function allocateProjectKey(workspace, address, taken, log) {
  const base = await deriveProjectKey(workspace);
  const holder = taken.get(base);
  if (!holder || holder === address) {
    taken.set(base, address);
    return base;
  }
  const suffixed = `${base}-${workspace.key.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 4)}`;
  log(`msg9 credentials: project-key conflict "${base}" (${holder} vs ${address}); using "${suffixed}" for ${address}`);
  taken.set(suffixed, address);
  return suffixed;
}
function parseYaml(raw) {
  const out = {};
  for (const line of raw.split("\n")) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}
async function ensureDir(path) {
  await mkdir2(path, { recursive: true, mode: 448 });
  await chmod(path, 448).catch(() => {
  });
}
async function readProjectCredentials(projectKey) {
  let raw;
  try {
    raw = await readFile2(projectYamlPath(projectKey), "utf8");
  } catch {
    return void 0;
  }
  const parsed = parseYaml(raw);
  if (!parsed.address || !parsed.api_key) return void 0;
  return {
    address: parsed.address,
    api_key: parsed.api_key,
    api_url: parsed.api_url || defaultApiUrl(),
    ...parsed.created_at ? { created_at: parsed.created_at } : {}
  };
}
async function readSigningSeed(projectKey) {
  let raw;
  try {
    raw = await readFile2(signingYamlPath(projectKey), "utf8");
  } catch {
    return void 0;
  }
  return parseYaml(raw).signing_seed || void 0;
}
async function writeProjectCredentials(projectKey, creds, options) {
  await ensureDir(projectsDir());
  const path = projectYamlPath(projectKey);
  if (!options?.overwrite && await readProjectCredentials(projectKey)) return false;
  const created = (await readProjectCredentials(projectKey))?.created_at ?? (/* @__PURE__ */ new Date()).toISOString();
  await writeFile2(
    path,
    `address: ${creds.address}
api_key: ${creds.api_key}
api_url: ${creds.api_url}
created_at: ${created}
`,
    { mode: 384 }
  );
  await chmod(path, 384).catch(() => {
  });
  return true;
}
async function writeSigningSeed(projectKey, seed, options) {
  await ensureDir(projectsDir());
  const path = signingYamlPath(projectKey);
  if (!options?.overwrite && await readSigningSeed(projectKey)) return false;
  await writeFile2(path, `signing_seed: ${seed}
created_at: ${(/* @__PURE__ */ new Date()).toISOString()}
`, { mode: 384 });
  await chmod(path, 384).catch(() => {
  });
  return true;
}
async function removeProjectCredentials(projectKey) {
  const removed = [];
  for (const path of [projectYamlPath(projectKey), signingYamlPath(projectKey)]) {
    try {
      await rm2(path, { force: true });
      removed.push(path);
    } catch {
    }
  }
  return removed;
}
var TenantKeyAmbiguousError = class extends Error {
  candidates;
  constructor(candidates) {
    super(
      `msg9 \u79DF\u6237 key \u4E0D\u552F\u4E00\uFF0C\u62D2\u7EDD\u66FF\u4F60\u731C\uFF08\u89C4\u8303 address-format.md \xA75\uFF09\u3002\u5019\u9009\u53D6\u81EA ${tenantsDir()}/\uFF1A${candidates.join(", ")}\u3002\u8BF7\u663E\u5F0F\u6307\u5B9A\uFF1Aenv MSG9_TENANT_KEY=<\u8DEF\u5F84>\uFF0C\u6216\u5728\u8BBE\u7F6E\u91CC\u4E3A\u8BE5\u9879\u76EE\u9009\u5B9A pod key\u3002`
    );
    this.name = "TenantKeyAmbiguousError";
    this.candidates = candidates;
  }
};
async function listTenantKeyFiles() {
  let names;
  try {
    names = await readdir(tenantsDir());
  } catch {
    return [];
  }
  return names.filter((name2) => name2.endsWith(".key") && !name2.includes(".bak")).sort();
}
async function readTenantKeyWithSource() {
  const envPath = process.env.MSG9_TENANT_KEY;
  if (envPath) {
    try {
      const key = (await readFile2(envPath, "utf8")).trim();
      if (key) return { key, source: `MSG9_TENANT_KEY=${envPath}` };
    } catch {
    }
  }
  const files = await listTenantKeyFiles();
  const known = await knownTenantKeyName();
  if (known && files.includes(known)) {
    const key = await readTenantKeyFile(known);
    if (key) return { key, source: `tenants/${known}` };
  }
  const orgLabel = (await loadState()).org?.label;
  if (orgLabel) {
    const guessed = await guessPodKeyName(orgLabel, files);
    if (guessed) {
      const key = await readTenantKeyFile(guessed);
      if (key) return { key, source: `tenants/${guessed}\uFF08\u6309 ORG \u7ED1\u5B9A\u7684 pod \u63A8\u5BFC\uFF09` };
    }
  }
  const legacy = "dsh.key";
  if (files.length === 1 && files[0] === legacy) {
    const key = await readTenantKeyFile(legacy);
    if (key) return { key, source: `tenants/${legacy}\uFF08\u65E7\u6A21\u578B\u5B58\u91CF\uFF09` };
  }
  if (files.length === 1) {
    const key = await readTenantKeyFile(files[0]);
    if (key) return { key, source: `tenants/${files[0]}` };
  }
  if (files.length > 1) {
    throw new TenantKeyAmbiguousError(files);
  }
  return void 0;
}
async function readTenantKeyFile(name2) {
  try {
    const key = (await readFile2(join2(tenantsDir(), name2), "utf8")).trim();
    return key || void 0;
  } catch {
    return void 0;
  }
}
async function knownTenantKeyName() {
  const state = await loadState();
  const orgLabel = state.org?.label;
  const podFromOrg = state.org?.pod_label;
  if (orgLabel && podFromOrg) return `${sanitizeKey(podFromOrg)}-${sanitizeKey(orgLabel)}.key`;
  const label = state.owner?.pod_label;
  const org = state.owner?.org_label;
  if (!label || !org) return void 0;
  return `${sanitizeKey(label)}-${sanitizeKey(org)}.key`;
}
async function guessPodKeyName(orgLabel, files) {
  const suffix = `-${sanitizeKey(orgLabel)}.key`;
  const matches = files.filter((name2) => name2.endsWith(suffix));
  if (matches.length === 0) return void 0;
  return matches.sort()[0];
}
async function readTenantKey() {
  return (await readTenantKeyWithSource())?.key;
}
async function writeTenantKey(key, scope) {
  await ensureDir(tenantsDir());
  const name2 = scope?.podLabel && scope?.orgLabel ? `${sanitizeKey(scope.podLabel)}-${sanitizeKey(scope.orgLabel)}.key` : "dsh.key";
  const path = join2(tenantsDir(), name2);
  let backedUp;
  const previous = await readFile2(path, "utf8").catch(() => void 0);
  if (previous !== void 0 && previous.trim() && previous.trim() !== key.trim()) {
    const candidate = `${path}.bak-${Date.now()}`;
    await writeFile2(candidate, previous, { mode: 384 }).then(() => {
      backedUp = candidate;
    }).catch(() => {
      backedUp = void 0;
    });
  }
  await writeFile2(path, `${key}
`, { mode: 384 });
  await chmod(path, 384).catch(() => {
  });
  return { path, ...backedUp ? { backedUp } : {} };
}
async function readOrgKey(orgLabel) {
  const envKey = process.env.MSG9_ORG_KEY;
  if (envKey) return { key: envKey, label: orgLabel ?? "env", source: "MSG9_ORG_KEY" };
  if (orgLabel) {
    const path = orgKeyPath(orgLabel);
    try {
      const key = (await readFile2(path, "utf8")).trim();
      if (key) return { key, label: orgLabel, source: `orgs/${sanitizeKey(orgLabel)}.key` };
    } catch {
    }
  }
  let names;
  try {
    names = (await readdir(orgsDir())).filter((n) => n.endsWith(".key") && !n.includes(".bak")).sort();
  } catch {
    return void 0;
  }
  if (names.length !== 1) return void 0;
  const name2 = names[0];
  try {
    const key = (await readFile2(join2(orgsDir(), name2), "utf8")).trim();
    if (!key) return void 0;
    return { key, label: name2.replace(/\.key$/, ""), source: `orgs/${name2}` };
  } catch {
    return void 0;
  }
}
async function writeOrgKey(orgLabel, key) {
  await ensureDir(orgsDir());
  const path = orgKeyPath(orgLabel);
  await writeFile2(path, `${key}
`, { mode: 384 });
  await chmod(path, 384).catch(() => {
  });
}
async function removeOrgKey(orgLabel) {
  await rm2(orgKeyPath(orgLabel), { force: true }).catch(() => {
  });
}
function hasLegacyCredentials(state) {
  if (state.owner?.api_key) return true;
  return Object.values(state.workspaces).some((inbox) => Boolean(inbox.api_key || inbox.signing_seed));
}
function mergeMarks(base, extra) {
  const out = { ...base };
  for (const [id, mark] of Object.entries(extra)) {
    const existing = out[id];
    if (!existing) {
      out[id] = { ...mark };
      continue;
    }
    for (const field of ["read_by", "processed_by"]) {
      if (mark[field] && !existing[field]) {
        existing[field] = mark[field];
        const atField = field === "read_by" ? "read_at" : "processed_at";
        existing[atField] = mark[atField];
      } else if (mark[field] && existing[field]) {
        const atField = field === "read_by" ? "read_at" : "processed_at";
        if ((mark[atField] ?? "") > (existing[atField] ?? "")) {
          existing[field] = mark[field];
          existing[atField] = mark[atField];
        }
      }
    }
  }
  return out;
}
function ensureCredentialsMigrated(deps = {}) {
  const { listWorkspaces: listWorkspaces2, log } = { ...defaultDeps(), ...deps };
  return withStateLock(async () => {
    const state = await loadState();
    let dirty = false;
    const registered = listWorkspaces2();
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      if (!key.startsWith("cwd:")) continue;
      const target = registered.find((workspace) => workspace.path === (inbox.path || key.slice(4)));
      if (!target || target.key === key) continue;
      const existing = state.workspaces[target.key];
      if (!existing) {
        state.workspaces[target.key] = { ...inbox };
      } else {
        existing.address ??= inbox.address;
        existing.api_key ??= inbox.api_key;
        existing.api_url ??= inbox.api_url;
        existing.signing_seed ??= inbox.signing_seed;
        existing.cursor ??= inbox.cursor;
        existing.last_message_id ??= inbox.last_message_id;
        existing.watch_cursor ??= inbox.watch_cursor;
        existing.watch_last_message_id ??= inbox.watch_last_message_id;
        existing.watch_last_seen_at = [existing.watch_last_seen_at ?? "", inbox.watch_last_seen_at ?? ""].sort()[1] || void 0;
        if (inbox.marks) existing.marks = mergeMarks(existing.marks ?? {}, inbox.marks);
      }
      delete state.workspaces[key];
      dirty = true;
      log(`msg9 credentials: merged legacy bucket "${key}" into "${target.key}"`);
    }
    const taken = /* @__PURE__ */ new Map();
    for (const inbox of Object.values(state.workspaces)) {
      if (inbox.project_key) {
        const known = await readProjectCredentials(inbox.project_key);
        if (known) taken.set(inbox.project_key, known.address);
      }
    }
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      if (!inbox.api_key && !inbox.signing_seed) continue;
      try {
        const address = inbox.address ?? "";
        const projectKey = inbox.project_key ?? await allocateProjectKey({ key, title: inbox.title, path: inbox.path }, address, taken, log);
        if (inbox.api_key && address) {
          const written = await writeProjectCredentials(projectKey, {
            address,
            api_key: inbox.api_key,
            api_url: inbox.api_url || defaultApiUrl()
          });
          if (!written) {
            const kept = await readProjectCredentials(projectKey);
            if (kept && kept.address !== address) {
              log(`msg9 credentials: ${projectYamlPath(projectKey)} already exists for ${kept.address}; it wins over the state residue (${address})`);
            }
          }
        }
        if (inbox.signing_seed) await writeSigningSeed(projectKey, inbox.signing_seed);
        delete inbox.address;
        delete inbox.api_key;
        delete inbox.api_url;
        delete inbox.signing_seed;
        inbox.project_key = projectKey;
        inbox.migrated_at = (/* @__PURE__ */ new Date()).toISOString();
        dirty = true;
      } catch (error) {
        log(`msg9 credentials: migration of "${key}" failed (${error?.message ?? String(error)}); legacy fields kept, will retry`);
      }
    }
    if (state.owner?.api_key) {
      try {
        if (!await readTenantKey()) await writeTenantKey(state.owner.api_key);
        delete state.owner.api_key;
        state.owner.migrated_at = (/* @__PURE__ */ new Date()).toISOString();
        dirty = true;
      } catch (error) {
        log(`msg9 credentials: owner key migration failed (${error?.message ?? String(error)}); legacy field kept, will retry`);
      }
    }
    if (dirty) await saveState(state);
  });
}
async function resolveCredentials(key, deps = {}) {
  const log = deps.log ?? (() => {
  });
  let state = await loadState();
  let inbox = state.workspaces[key];
  if (!inbox) return void 0;
  if (inbox.api_key || inbox.signing_seed || !inbox.project_key) {
    await ensureCredentialsMigrated(deps);
    state = await loadState();
    inbox = state.workspaces[key];
    if (!inbox) return void 0;
  }
  if (inbox.project_key) {
    const creds = await readProjectCredentials(inbox.project_key);
    if (creds) {
      const seed = await readSigningSeed(inbox.project_key);
      return {
        ...inbox,
        address: creds.address,
        api_key: creds.api_key,
        api_url: creds.api_url,
        ...seed ? { signing_seed: seed } : {}
      };
    }
    log(`msg9 credentials: ${projectYamlPath(inbox.project_key)} is missing; falling back to state residue`);
  }
  if (inbox.address && inbox.api_key) {
    return { ...inbox, address: inbox.address, api_key: inbox.api_key, api_url: inbox.api_url || defaultApiUrl() };
  }
  return void 0;
}
async function resolveOwner(deps = {}) {
  const envKey = process.env.MSG9_OWNER_KEY;
  if (envKey) {
    return { api_key: envKey, api_url: defaultApiUrl(), name: process.env.MSG9_OWNER_NAME };
  }
  let state = await loadState();
  if (state.owner?.api_key) {
    await ensureCredentialsMigrated(deps);
    state = await loadState();
  }
  const meta = state.owner;
  const key = await readTenantKey();
  if (!key) {
    return meta?.api_key ? { ...meta, api_key: meta.api_key } : void 0;
  }
  return { ...meta ?? { api_url: defaultApiUrl() }, api_key: key };
}
async function saveOwner(owner) {
  await writeTenantKey(owner.api_key);
  return withStateLock(async () => {
    const state = await loadState();
    const { api_key: _secret, ...meta } = owner;
    state.owner = { ...meta, migrated_at: (/* @__PURE__ */ new Date()).toISOString() };
    await saveState(state);
  });
}
async function credentialsMigrated() {
  return !hasLegacyCredentials(await loadState());
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
      const owner = await resolveOwner();
      const state = await loadState();
      const rows = [];
      for (const key of Object.keys(state.workspaces)) {
        const resolved = await resolveCredentials(key);
        if (resolved) rows.push({ title: resolved.title, address: resolved.address });
      }
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

// src/host/http.ts
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

// src/host/service.ts
import { createHash as createHash3 } from "node:crypto";
import { readFile as readFile3 } from "node:fs/promises";
import { basename as basename3, join as join3 } from "node:path";

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
  const owner = await resolveOwner();
  const org = (await loadState()).org;
  const apiUrl = org?.api_url || owner?.api_url || defaultApiUrl();
  if (owner?.api_key && (owner.slug === void 0 || owner.slug === "" || owner.address_domain === void 0) && !process.env.MSG9_OWNER_KEY && Date.now() - ownerProbeFailedAt >= OWNER_PROBE_RETRY_MS) {
    try {
      const me = await ownerMe(apiUrl, owner.api_key);
      const probed = {
        ...owner,
        slug: typeof me.slug === "string" ? me.slug : null,
        ...typeof me.mail_domain === "string" ? { mail_domain: me.mail_domain } : {},
        address_domain: typeof me.address_domain === "string" ? me.address_domain : null
      };
      await saveOwner(probed);
      ownerProbeFailedAt = 0;
      return { owner: probed, apiUrl };
    } catch {
      ownerProbeFailedAt = Date.now();
    }
  }
  return { owner, apiUrl };
}
var provisioning = /* @__PURE__ */ new Map();
function ensureInbox(workspace, signal, preferred, options) {
  const pending = provisioning.get(workspace.key);
  if (pending) return pending;
  const task = provision(workspace, void 0, preferred, options?.allowSelfRegister ?? false).finally(() => provisioning.delete(workspace.key));
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
async function takenProjectKeys() {
  const state = await loadState();
  const taken = /* @__PURE__ */ new Map();
  for (const inbox of Object.values(state.workspaces)) {
    if (!inbox.project_key) continue;
    const creds = await readProjectCredentials(inbox.project_key);
    if (creds) taken.set(inbox.project_key, creds.address);
  }
  return taken;
}
async function ownerForWorkspace(workspace, owner, apiUrl, orgLabel) {
  if (!orgLabel || !owner?.api_key) return owner;
  const targetPod = await podLabelFor(workspace);
  const podKey = await readTenantKeyForPod(targetPod, orgLabel, apiUrl);
  if (!podKey) {
    throw new Error(L(
      "\u672C\u5730\u6CA1\u6709 Pod\u300C{pod}\u300D\u7684\u79DF\u6237 key\uFF0C\u65E0\u6CD5\u5728\u8BE5 Pod \u4E0B\u5F00\u901A\u4FE1\u7BB1\u3002\u5148\u70B9\u8BE5\u884C\u7684\u300C\u5F00\u901A\u300D\u6309\u63D0\u793A\u53D6\u5F97 pod key\uFF08\u8BE5 Pod \u5DF2\u5B58\u5728\u65F6\uFF0C\u9700\u8981\u63D0\u4F9B\u5B83\u81EA\u5DF1\u7684\u79DF\u6237 key\uFF09\uFF0C\u518D\u91CD\u8BD5\u3002",
      'No local tenant key for pod "{pod}", so no inbox can be created under it.',
      { pod: targetPod }
    ));
  }
  return {
    ...owner,
    api_key: podKey.key,
    ...podKey.domain ? { address_domain: podKey.domain, slug: "" } : {}
  };
}
async function provision(workspace, log, preferred, allowSelfRegister = false) {
  let existing = await resolveCredentials(workspace.key, { log });
  if (!existing) {
    const state = await loadState();
    if (Object.keys(state.workspaces).some((key) => key.startsWith("cwd:"))) {
      await ensureCredentialsMigrated({ log });
      existing = await resolveCredentials(workspace.key, { log });
    }
  }
  if (existing) return { workspace, inbox: await ensureSigningKey(existing, log), provisioned: false };
  const { owner, apiUrl } = await ownerContext();
  const profile = workspaceProfile(workspace);
  const stateForProvision = await loadState();
  const orgLabel = stateForProvision.org?.label;
  const preferredAddress = preferred ?? stateForProvision.workspaces[workspace.key]?.preferred_address;
  if (!owner?.api_key && !allowSelfRegister) {
    throw new Error(
      "msg9 \u672A\u914D\u7F6E pod \u79DF\u6237 key\uFF0C\u62D2\u7EDD\u81EA\u52A8\u5F00\u901A\u6536\u4EF6\u7BB1\uFF08\u4E0D\u4F1A\u518D\u9000\u56DE\u516C\u5F00\u81EA\u52A9\u6CE8\u518C\uFF09\u3002\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 \u6D88\u606F\u4FE1\u7BB1\u300D\u586B\u5165 ORG key\uFF08msg9_ok_\u2026\uFF09\uFF0C\u518D\u5BF9\u672C workspace \u70B9\u300C\u5F00\u542F\u300D\u3002"
    );
  }
  const ownerForKey = await ownerForWorkspace(workspace, owner, apiUrl, orgLabel);
  if (!ownerForKey?.api_key) {
    throw new Error(L(
      "\u81EA\u52A9\u6CE8\u518C\uFF08/api/v1/register\uFF09\u5DF2\u505C\u7528\uFF1A\u8BE5\u63A5\u53E3\u9700\u8981 user JWT\uFF0C\u672C\u63D2\u4EF6\u65E0\u6CD5\u63D0\u4F9B\u3002\u8BF7\u914D\u7F6E ORG key\uFF0C\u5E76\u53D6\u5F97\u8BE5\u9879\u76EE Pod \u7684\u79DF\u6237 key \u540E\u91CD\u8BD5\u3002",
      "Self-registration is retired: /api/v1/register requires a user JWT that this plugin cannot provide. Configure an ORG key and obtain this project's pod tenant key, then retry."
    ));
  }
  const agent = await provisionUnderOwner(
    apiUrl,
    ownerForKey,
    workspace,
    profile,
    preferredAddress
  );
  const projectKey = await allocateProjectKey(workspace, agent.address, await takenProjectKeys(), log ?? (() => {
  }));
  await writeProjectCredentials(projectKey, { address: agent.address, api_key: agent.api_key, api_url: apiUrl });
  await upsertWorkspaceInbox(workspace.key, {
    title: workspace.title,
    path: workspace.path,
    project_key: projectKey,
    ...preferredAddress ? { preferred_address: preferredAddress } : {}
  });
  const inbox = {
    title: workspace.title,
    path: workspace.path,
    project_key: projectKey,
    address: agent.address,
    api_key: agent.api_key,
    api_url: apiUrl
  };
  return { workspace, inbox: await ensureSigningKey(inbox, log), provisioned: true };
}
async function ensureSigningKey(inbox, log) {
  if (inbox.signing_seed) return inbox;
  if (!inbox.project_key) return inbox;
  const material = generateSigningMaterial();
  try {
    await setSigningKey(inbox.api_url, inbox.api_key, material.publicKey);
  } catch (error) {
    log?.(`msg9 signing key install failed for ${inbox.address}: ${error?.message ?? String(error)}`);
    return inbox;
  }
  await writeSigningSeed(inbox.project_key, material.seed);
  return { ...inbox, signing_seed: material.seed };
}
async function provisionUnderOwner(apiUrl, owner, workspace, profile, preferred) {
  const candidates = isTenantOwner(owner) ? tenantAddressCandidates(workspace, preferred) : [deriveAddress(workspace)];
  let lastAddress = candidates[0];
  let lastReason = "no agent returned";
  let lastCode;
  for (const address of candidates) {
    lastAddress = address;
    const result = await ownerCreateAgents(apiUrl, owner.api_key, [address], { workspace: workspace.title }, profile);
    const created = result.created?.[0];
    if (created?.api_key) return created;
    const first = result.errors?.[0];
    lastReason = first ? `${first.message} (${first.code})` : "no agent returned";
    lastCode = first?.code;
    if (first?.code !== 40900) break;
  }
  if (lastCode === 40900 && lastAddress.startsWith(harnessAgentName())) {
    throw new Error(L(
      "\u672C\u9879\u76EE\u4E0B\u300Cdsh\u300D\u300Cdsh-2\u300D\u300Cdsh-3\u300D\u300Cdsh-4\u300D\u90FD\u5DF2\u88AB\u5360\u7528\uFF0C\u81EA\u52A8\u7F16\u53F7\u7528\u5B8C\u4E86\u3002\n\u8BF7\u7ED9\u8FD9\u4E2A workspace **\u663E\u5F0F\u6307\u5B9A\u4E00\u4E2A\u53EF\u8BFB\u7684 Agent \u540D**\uFF08\u4F8B\u5982 dsh-dev\u3001dsh-fe\uFF09\u540E\u91CD\u8BD5\u3002",
      'In this project "dsh", "dsh-2", "dsh-3" and "dsh-4" are all taken; auto-numbering is exhausted.\nGive this workspace an explicit, readable agent name (e.g. dsh-dev, dsh-fe) and retry.'
    ));
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
async function migrateInbox(workspace, oldInbox, oldOwnerKey, preferred) {
  const { owner, apiUrl } = await ownerContext();
  if (!owner?.api_key) {
    throw new Error(L("\u8FD8\u6CA1\u6709\u7ED1\u5B9A\u79DF\u6237\uFF0C\u65E0\u6CD5\u8FC1\u79FB\u3002", "No tenant is bound; cannot migrate."));
  }
  const stateForMigrate = await loadState();
  const ownerForKey = await ownerForWorkspace(workspace, owner, apiUrl, stateForMigrate.org?.label) ?? owner;
  const agent = await provisionUnderOwner(apiUrl, ownerForKey, workspace, workspaceProfile(workspace), preferred);
  let signingSeed;
  try {
    const material = generateSigningMaterial();
    await setSigningKey(apiUrl, agent.api_key, material.publicKey);
    signingSeed = material.seed;
  } catch {
  }
  const activate = async () => {
    const entry = (await loadState()).workspaces[workspace.key];
    const taken = await takenProjectKeys();
    if (entry?.project_key) taken.delete(entry.project_key);
    const projectKey = entry?.project_key ?? await allocateProjectKey(workspace, agent.address, taken, () => {
    });
    await writeProjectCredentials(projectKey, { address: agent.address, api_key: agent.api_key, api_url: apiUrl }, { overwrite: true });
    if (signingSeed) await writeSigningSeed(projectKey, signingSeed, { overwrite: true });
    await replaceWorkspaceInbox(workspace.key, {
      title: workspace.title,
      path: workspace.path,
      project_key: projectKey,
      ...preferred ? { preferred_address: preferred } : {}
    });
    return {
      title: workspace.title,
      path: workspace.path,
      project_key: projectKey,
      address: agent.address,
      api_key: agent.api_key,
      api_url: apiUrl,
      ...signingSeed ? { signing_seed: signingSeed } : {}
    };
  };
  if (oldInbox.address === agent.address) {
    const inbox2 = await activate();
    return { inbox: inbox2, oldDisabled: false, forwarding: false, movedMail: null };
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
  const inbox = await activate();
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
var GENERIC_POD_LABELS = /* @__PURE__ */ new Set([
  "workspace",
  "ws",
  "wip",
  "tmp",
  "temp",
  "test",
  "tests",
  "src",
  "app",
  "code",
  "codes"
]);
function isMeaningfulPodLabel(label) {
  const stem = label.replace(/-[0-9a-f]{4}$/, "");
  return stem.length >= 3 && !GENERIC_POD_LABELS.has(stem);
}
function podSlugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
}
async function podLabelFor(workspace, explicit) {
  const state = await loadState();
  return explicit ?? state.org?.pod_labels?.[workspace.key] ?? derivePodLabel(workspace);
}
function derivePodLabel(workspace) {
  const candidates = [workspace.title, basename3(workspace.path.replace(/\/+$/, ""))];
  for (const raw of candidates) {
    const slug2 = podSlugify(raw);
    if (!slug2 || GENERIC_POD_LABELS.has(slug2)) continue;
    if (slug2.length >= 3) return slug2.slice(0, 30).replace(/[^a-z0-9]+$/, "");
  }
  const slug = podSlugify(workspace.title) || podSlugify(basename3(workspace.path)) || "ws";
  return `${slug}-${shortHash2(workspace.key)}`.slice(0, 30).replace(/[^a-z0-9]+$/, "");
}
function shortHash2(input) {
  return createHash3("sha256").update(input).digest("hex").slice(0, 4);
}
async function podState(workspace) {
  if (await resolveCredentials(workspace.key)) return "ready";
  const org = await readOrgKey((await loadState()).org?.label ?? void 0);
  return org?.key ? "pod_closed" : "unconfigured";
}
async function openPod(workspace, options) {
  const log = options?.log ?? (() => {
  });
  const state = await loadState();
  const orgLabel = state.org?.label;
  const org = await readOrgKey(orgLabel);
  if (!org?.key) {
    throw new Error(L(
      "\u672A\u914D\u7F6E ORG key\uFF0C\u65E0\u6CD5\u5F00\u542F Pod\u3002\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 \u6D88\u606F\u4FE1\u7BB1\u300D\u586B\u5165 ORG key\uFF08msg9_ok_\u2026\uFF09\u3002",
      "No ORG key configured, so the pod cannot be opened. Add one in Settings \u2192 Mailbox."
    ));
  }
  const apiUrl = state.org?.api_url ?? defaultApiUrl();
  const label = await podLabelFor(workspace, options?.podLabel);
  let pods;
  try {
    pods = await orgListPods(apiUrl, org.key);
  } catch (error) {
    throw new Error(L(
      "\u8BFB\u53D6 ORG \u4E0B\u7684 Pod \u5217\u8868\u5931\u8D25\uFF1A{reason}",
      "Could not list pods under the ORG: {reason}",
      { reason: error?.message ?? String(error) }
    ));
  }
  const existingPod = pods.find((pod) => pod.pod_label === label);
  let podKey;
  let podCreated = false;
  let addressDomain2 = existingPod?.address_domain;
  const existingAgents = existingPod?.agents;
  if (existingPod) {
    podKey = (await readTenantKeyForPod(label, orgLabel, apiUrl))?.key;
    if (!podKey) {
      throw new Error(L(
        "Pod\u300C{pod}\u300D\u5DF2\u5B58\u5728\u4E8E ORG\u300C{org}\u300D\u4E0B\uFF08\u5DF2\u6709 {agents} \u4E2A agent\uFF09\uFF0C\u4F46\u672C\u5730\u6CA1\u6709\u5B83\u7684 pod key\u3002\u8BF7\u63D0\u4F9B\u8BE5 Pod \u7684\u79DF\u6237 key\uFF08\u6216\u5148\u5220\u9664\u8BE5 Pod \u518D\u91CD\u5F00\uFF09\u3002\u672C\u63D2\u4EF6\u4E0D\u4F1A\u91CD\u5EFA\u4E00\u4E2A\u5DF2\u5B58\u5728\u7684 Pod\u3002",
        'Pod "{pod}" already exists under ORG "{org}" but its key is not stored locally.',
        { pod: label, org: orgLabel ?? "?", agents: existingAgents ?? 0 }
      ));
    }
    log(`msg9 openPod: reusing existing pod ${label} (${addressDomain2 ?? "?"})`);
  } else {
    const created = await orgCreatePod(apiUrl, org.key, { label, name: workspace.title }).catch((error) => {
      throw new Error(L(
        "\u5728 ORG \u4E0B\u521B\u5EFA Pod\u300C{pod}\u300D\u5931\u8D25\uFF1A{reason}",
        'Failed to create pod "{pod}" under the ORG: {reason}',
        { pod: label, reason: error?.message ?? String(error) }
      ));
    });
    podKey = created.api_key;
    podCreated = true;
    addressDomain2 = created.pod?.address_domain ?? addressDomain2;
  }
  if (!podKey) {
    throw new Error(L(
      "Pod \u5DF2\u521B\u5EFA\u4F46\u6CA1\u6709\u8FD4\u56DE pod key\uFF1B\u5DF2\u4E2D\u6B62\uFF08\u672A\u5199\u4EFB\u4F55\u51ED\u636E\uFF09\u3002",
      "The pod was created but no pod key came back; aborting without writing credentials."
    ));
  }
  await writeTenantKey(podKey, { podLabel: label, orgLabel });
  await ensureInbox(workspace);
  return {
    state: "ready",
    podCreated,
    podLabel: label,
    orgLabel,
    addressDomain: addressDomain2,
    existingAgents,
    note: podCreated ? void 0 : L("\u590D\u7528\u4E86\u5DF2\u5B58\u5728\u7684 Pod\uFF08\u672A\u65B0\u5EFA\uFF09", "Reused the existing pod")
  };
}
async function readTenantKeyForPod(podLabel, orgLabel, apiUrl) {
  const candidates = [
    ...orgLabel ? [`${podLabel}-${orgLabel}.key`] : [],
    `${podLabel}.key`
  ];
  for (const name2 of candidates) {
    let key;
    try {
      key = (await readFile3(join3(msg9Home(), "tenants", name2), "utf8")).trim() || void 0;
    } catch {
      continue;
    }
    if (!key) continue;
    const probe = apiUrl ? await podKeyProbe(apiUrl, key, podLabel) : { manages: null };
    if (probe.manages === false) continue;
    return { key, source: `tenants/${name2}`, ...probe.domain ? { domain: probe.domain } : {} };
  }
  const state = await loadState();
  const mine = state.org?.pod_label ?? state.owner?.pod_label;
  if (mine && mine === podLabel) {
    const resolved = await readTenantKeyWithSource().catch(() => void 0);
    if (resolved) return { key: resolved.key, source: resolved.source };
  }
  return null;
}
async function podKeyProbe(apiUrl, key, podLabel) {
  try {
    const me = await ownerMe(apiUrl, key);
    const domain = typeof me.address_domain === "string" ? me.address_domain : typeof me.mail_domain === "string" ? me.mail_domain : void 0;
    if (!domain) return { manages: null };
    return { manages: domain.split(".")[0] === podLabel, domain };
  } catch {
    return { manages: null };
  }
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
function resolveVia(deps, key) {
  return deps.resolveCredentials ? deps.resolveCredentials(key) : resolveCredentials(key, { log: deps.log });
}
var UNREAD_TTL_MS = 1e4;
var unreadCache;
var unreadInflight;
function invalidateUnreadCache() {
  unreadCache = void 0;
  unreadInflight = void 0;
}
async function computeUnread(deps, signal, options) {
  const ttl = options?.ttlMs ?? UNREAD_TTL_MS;
  if (unreadInflight) return unreadInflight;
  if (unreadCache && Date.now() - unreadCache.at < ttl) return unreadCache.view;
  void signal;
  const task = (async () => {
    const state = await deps.loadState();
    const keys = Object.keys(state.workspaces);
    const resolved = await Promise.all(keys.map((key) => resolveVia(deps, key)));
    const rows = keys.map((key, index) => [key, resolved[index]]).filter((pair) => Boolean(pair[1]));
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
  })();
  const tracked = task.finally(() => {
    if (unreadInflight === tracked) unreadInflight = void 0;
  });
  unreadInflight = tracked;
  return tracked;
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
      orgInfo,
      orgListPods,
      listGroups,
      getGroup,
      groupMessages,
      ...override
    },
    loadState,
    stateFilePath,
    defaultApiUrl,
    ensureInbox,
    openPod,
    podState,
    derivePodLabel,
    // ORG 绑定等元数据的原子更新（走同一把 state 锁，避免与别的写互相覆盖）。
    updateState: (mutate) => withStateLock(async () => {
      const next = await loadState();
      mutate(next);
      await saveState(next);
    }),
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
function assertWorkspaceDirExists(path) {
  if (path && existsSync(path)) return;
  throw new BridgeError(409, "workspace-dir-missing", L(
    "\u5DE5\u4F5C\u533A\u76EE\u5F55 {path} \u5DF2\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u5F00\u901A\uFF08\u5F00\u901A\u4F1A\u5728\u4F60\u7684 ORG \u91CC\u771F\u7684\u5EFA Pod/Agent\u3001\u5360\u7528\u540D\u989D\uFF09\u3002\u8BF7\u5728 dsh \u91CC\u91CD\u65B0\u767B\u8BB0\u8FD9\u4E2A\u5DE5\u4F5C\u533A\uFF0C\u6216\u76F4\u63A5\u79FB\u9664\u8FD9\u6761\u8BB0\u5F55\u3002",
    "the workspace directory {path} does not exist, so it cannot be opened (opening really creates pods/agents in your ORG). Re-register the workspace in dsh, or remove this record.",
    { path: path || "(\u672A\u63D0\u4F9B)" }
  ));
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
function tokenMatches(expected, presented) {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
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
    const tenantMode = Boolean(owner?.api_key && isTenantOwner(owner));
    const mailDomain = owner?.mail_domain || addressDomain(apiUrl);
    const domain = tenantMode ? owner?.address_domain ?? `${owner.slug}.${mailDomain}` : mailDomain;
    const resolvedByKey = /* @__PURE__ */ new Map();
    await Promise.all(Object.keys(state.workspaces).map(async (key) => {
      const resolved = await resolveVia(deps, key);
      if (resolved) resolvedByKey.set(key, resolved);
    }));
    const planned = (workspace) => {
      if (!tenantMode) return `${deriveAddress(workspace)}@${domain}`;
      const preferred = state.workspaces[workspace.key]?.preferred_address;
      return `${preferred ?? deriveAddress(workspace, { tenant: true })}@${domain}`;
    };
    const rows = /* @__PURE__ */ new Map();
    const orgMeta = state.org;
    const orgKey = orgMeta?.label ? await readOrgKey(orgMeta.label).catch(() => void 0) : void 0;
    const orgReady = Boolean(orgKey?.key);
    const podStats = /* @__PURE__ */ new Map();
    let podProbeOk = false;
    if (orgReady) {
      const pods = await deps.api.orgListPods(orgMeta?.api_url || defaultApiUrl(), orgKey.key).then((rows2) => {
        podProbeOk = true;
        return rows2;
      }).catch(() => []);
      for (const pod of pods) {
        podStats.set(pod.pod_label, {
          agents: typeof pod.agents === "number" ? pod.agents : null,
          max: typeof pod.max_agents === "number" ? pod.max_agents : null
        });
      }
    }
    const podLabelFromAddress = (address, orgLabel) => {
      if (!address || !orgLabel) return null;
      const at = address.indexOf("@");
      if (at < 0) return null;
      const domain2 = address.slice(at + 1);
      const marker = `.${orgLabel}.`;
      const idx = domain2.indexOf(marker);
      if (idx <= 0) return null;
      return domain2.slice(0, idx) || null;
    };
    const podFor = (workspace, address, domain2) => {
      const custom = Boolean(state.org?.pod_labels?.[workspace.key]);
      const fromAddress = podLabelFromAddress(address, orgMeta?.label);
      const expected = custom ? state.org.pod_labels[workspace.key] : deps.derivePodLabel(workspace);
      const label = fromAddress ?? expected;
      const stats = podStats.get(label);
      const mismatch = Boolean(fromAddress) && fromAddress !== expected;
      return {
        state: address ? "ready" : orgReady ? "pod_closed" : "unconfigured",
        pod_label: label,
        // 「已自定义」只在"还没开通、且用户改过候选名"时有意义
        custom: !fromAddress && custom,
        domain: domain2,
        agents: stats?.agents ?? null,
        max_agents: stats?.max ?? null,
        // 应有的 Agent 名（harness 名）：判据的另一半，随行给出
        ...address ? { expected_agent: harnessAgentName() } : {},
        // 「应有 pod」只在**与现址不同**时给出 —— 这正是"没开在自己的 pod 里"。
        // 不论候选名有没有语义都给（分类要靠它）；有无语义另用一个字段表达，
        // 好让界面把"ws-89fa 这种名字本来就不合法"和"名字好好的却开错了"分开说。
        ...mismatch ? {
          suggested_label: expected,
          suggested_meaningful: isMeaningfulPodLabel(expected),
          ...podProbeOk ? { suggested_exists: podStats.has(expected) } : {}
        } : {},
        // 现址的归属事实（用于面板分"合规 / 不合规"）：
        //   pod_form=false ⇒ 扁平域或 Default Pod（没有 pod 归属）
        //   pod_exists=false ⇒ 地址指向一个 ORG 里不存在的 pod（探测成功才敢这么说）
        ...address ? {
          pod_form: Boolean(fromAddress),
          ...podProbeOk && fromAddress ? { pod_exists: podStats.has(fromAddress) } : {}
        } : {}
      };
    };
    const byAddress = /* @__PURE__ */ new Map();
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      const addr = resolvedByKey.get(key)?.address ?? inbox.address ?? null;
      if (!addr) continue;
      const p = inbox.path ?? "";
      byAddress.set(addr, [...byAddress.get(addr) ?? [], {
        key,
        pathMissing: Boolean(p) && !existsSync(p)
      }]);
    }
    const healthFor = (key, address, path, stale, pathSource) => {
      const pathMissing = Boolean(path) && !existsSync(path);
      const holders = address ? byAddress.get(address) ?? [] : [];
      const others = holders.filter((h) => h.key !== key);
      const duplicateOf = holders.length > 1 ? address : null;
      const liveRemains = others.some((h) => !h.pathMissing);
      const removable = pathMissing ? true : liveRemains;
      let reason;
      if (!removable) {
        reason = holders.length > 1 ? L(
          "\u53E6\u4E00\u6761\u540C\u5740\u8BB0\u5F55\u6307\u5411\u7684\u76EE\u5F55\u5DF2\u4E0D\u5B58\u5728\uFF1B\u5220\u6389\u672C\u6761\u4F1A\u8BA9 {address} \u53EA\u5269\u90A3\u6761\u65E0\u6548\u8BB0\u5F55\u3002\u8BF7\u5148\u5220\u90A3\u4E00\u6761\u3002",
          "The other record for {address} points at a missing directory; removing this one would leave only that dead record. Remove that one first.",
          { address: address ?? "" }
        ) : L(
          "\u8FD9\u662F\u5730\u5740 {address} \u7684\u552F\u4E00\u8BB0\u5F55\uFF0C\u79FB\u9664\u540E\u8BE5\u4FE1\u7BB1\u5C06\u4E0D\u518D\u88AB\u7BA1\u7406\u3002",
          "This is the only record for {address}; removing it leaves that inbox unmanaged.",
          { address: address ?? "" }
        );
      }
      return {
        pathMissing,
        duplicateOf,
        removable,
        ...reason ? { reason } : {},
        // 两处记录对"目录在哪"说法不一致 —— 以注册表为准，但把差异摆出来
        ...stale ? { stalePath: stale.statePath, registryPath: stale.registryPath } : {},
        ...pathSource ? { pathSource } : {}
      };
    };
    for (const workspace of deps.listWorkspaces()) {
      rows.set(workspace.key, {
        key: workspace.key,
        title: workspace.title,
        path: workspace.path,
        address: null,
        // 只在注册表里、state 没有记录（没有可移除的东西）
        stored: false,
        // The address provisioning will assign, derived on the host so the
        // panel shows the real thing instead of guessing from the raw key.
        planned_address: planned(workspace),
        provisioned: false,
        cursor: null,
        current: workspace.key === currentKey,
        pod: podFor(workspace, null, null),
        health: healthFor(workspace.key, null, workspace.path, null, "registry")
      });
    }
    for (const [key, inbox] of Object.entries(state.workspaces)) {
      const existing = rows.get(key);
      const resolved = resolvedByKey.get(key);
      const address = resolved?.address ?? null;
      const legacy = Boolean(resolved && tenantMode && address && !address.endsWith(`@${domain}`));
      const title = inbox.title || existing?.title || key;
      const registryPath = existing?.path ?? "";
      const statePath = inbox.path || "";
      const path = registryPath || statePath;
      const stalePathInfo = registryPath && statePath && registryPath !== statePath ? { registryPath, statePath } : null;
      rows.set(key, {
        key,
        title,
        path,
        // state 里有记录（哪怕凭据文件丢了 —— 那条记录本身仍可移除）
        stored: true,
        address,
        planned_address: resolved ? legacy ? planned({ key, title, path }) : null : existing?.planned_address ?? null,
        provisioned: Boolean(resolved),
        legacy,
        cursor: inbox.cursor ?? null,
        current: key === currentKey,
        // 已开通 ⇒ ready；pod 域取地址里 `@` 之后那一段（真实值，不是推导值）。
        pod: podFor({ key, title, path }, address, address ? address.slice(address.indexOf("@") + 1) : null),
        pod_domain: address ? address.slice(address.indexOf("@") + 1) : null,
        // 显示的 path 是注册表优先；注册表没有这条时才来自 state
        health: healthFor(key, address, path, stalePathInfo, registryPath ? "registry" : "state")
      });
    }
    return [...rows.values()];
  }
  async function inboxFor(key, signal) {
    const resolved = await resolveVia(deps, key);
    if (resolved) {
      return {
        workspace: { key, title: resolved.title, path: resolved.path },
        inbox: resolved.signing_seed ? resolved : await ensureSigningKey(resolved, deps.log),
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
      const tenantMode = Boolean(owner?.api_key && isTenantOwner(owner));
      const mailDomain = owner?.mail_domain || addressDomain(apiUrl);
      const currentDomain = tenantMode ? owner?.address_domain ?? `${owner.slug}.${mailDomain}` : mailDomain;
      workspaces.unshift({
        key: current.key,
        title: current.title,
        path: current.path,
        address: null,
        // 当前会话所属但不在注册表/state 里 ⇒ 还没有记录
        stored: false,
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
      org: await orgView(),
      api_url: owner?.api_url || apiUrl,
      state_file: deps.stateFilePath(),
      // 在 workspaceViews 之后取：解析过程可能刚完成惰性迁移。
      credentials_migrated: await credentialsMigrated(),
      current: workspaces.find((row) => row.current) ?? null,
      workspaces
    };
  }
  async function orgView() {
    const state = await deps.loadState();
    const meta = state.org;
    if (!meta?.label) return null;
    const resolved = await readOrgKey(meta.label).catch(() => void 0);
    let podCount = null;
    let maxPods = meta.max_pods ?? null;
    if (resolved?.key) {
      const orgApiUrl = meta.api_url || defaultApiUrl();
      podCount = await deps.api.orgListPods(orgApiUrl, resolved.key).then((pods) => pods.length).catch(() => null);
      if (maxPods === null) {
        maxPods = await deps.api.orgInfo(orgApiUrl, resolved.key).then((info) => typeof info.max_pods === "number" ? info.max_pods : null).catch(() => null);
        if (maxPods !== null) {
          await deps.updateState((next) => {
            if (next.org) next.org.max_pods = maxPods;
          }).catch(() => {
          });
        }
      }
    }
    return {
      label: meta.label,
      id: meta.id ?? null,
      name: meta.name ?? null,
      masked: resolved?.key ? maskKey(resolved.key) : "\u2014",
      verified_at: meta.verified_at ?? null,
      pod_count: podCount,
      max_pods: maxPods
    };
  }
  async function peers(signal) {
    const state = await deps.loadState();
    const localByAddress = /* @__PURE__ */ new Map();
    await Promise.all(Object.keys(state.workspaces).map(async (key) => {
      const resolved = await resolveVia(deps, key);
      if (resolved) localByAddress.set(resolved.address, resolved);
    }));
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
    return [...localByAddress.values()].map((inbox) => ({
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
    if (method === "POST" && path === `${BRIDGE_PREFIX}/deliver`) {
      const presented = req.headers["x-msg9-daemon-token"];
      const expected = deps.deliver?.token();
      if (!deps.deliver || !expected || typeof presented !== "string" || !tokenMatches(expected, presented)) {
        throw new BridgeError(401, "bad-daemon-token", "a valid daemon delivery token is required");
      }
      const body = await readJsonBody(req);
      const projectKey = str(body.project_key);
      const messages = Array.isArray(body.messages) ? body.messages : void 0;
      const mode = body.mode === "followup" || body.mode === "inject" ? body.mode : void 0;
      if (!projectKey || !messages || !mode) {
        throw new BridgeError(400, "invalid-delivery", 'fields "project_key", "messages" and "mode" (followup|inject) are required');
      }
      return ok(res, await deps.deliver.handle({
        inbox: str(body.inbox) ?? "",
        project_key: projectKey,
        messages,
        mode,
        ...body.downgraded === true ? { downgraded: true } : {}
      }));
    }
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
      await saveOwner({ api_key: ownerKey, api_url: apiUrl, id, name: name2, slug, mail_domain: mailDomain, address_domain: addressDomain2 });
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
      const existing = await resolveVia(deps, key);
      if (!existing) throw new BridgeError(404, "unknown-workspace", `no inbox is registered as "${key}"`);
      const workspace = deps.listWorkspaces().find((row) => row.key === key) ?? { key, title: existing.title, path: existing.path };
      const preferred = str(body.preferred_address);
      if (preferred && !isValidLocalPart(preferred)) {
        throw new BridgeError(400, "invalid-address", `"${preferred}" is not a valid msg9 local part (3-30 chars, a-z0-9-_ inside)`);
      }
      const result = await migrateInbox(workspace, existing, str(body.old_owner_key), preferred || void 0);
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
      assertWorkspaceDirExists(workspace.path);
      const preferred = str(body.preferred_address);
      if (preferred && !isValidLocalPart(preferred)) {
        throw new BridgeError(400, "invalid-address", `"${preferred}" is not a valid msg9 local part (3-30 chars, a-z0-9-_ inside)`);
      }
      const { inbox, provisioned } = await deps.ensureInbox(
        title ? { ...workspace, title } : workspace,
        signal,
        preferred || void 0
      );
      if (provisioned) invalidateUnreadCache();
      return ok(res, { key: workspace.key, address: inbox.address, provisioned });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/org`) {
      const body = await readJsonBody(req);
      const orgKey = str(body.org_key);
      if (!orgKey) throw new BridgeError(400, "missing-org-key", 'field "org_key" is required');
      const apiUrl = (str(body.api_url) || defaultApiUrl()).replace(/\/+$/, "");
      let info;
      try {
        info = await deps.api.orgInfo(apiUrl, orgKey, signal);
      } catch (error) {
        throw new BridgeError(
          400,
          "org-key-rejected",
          `ORG key \u6821\u9A8C\u5931\u8D25\uFF08${error?.message ?? String(error)}\uFF09\u3002\u8BF7\u786E\u8BA4\u5B83\u662F msg9_ok_\u2026 \u5F00\u5934\u7684 ORG key\u3002`
        );
      }
      const podCount = await deps.api.orgListPods(apiUrl, orgKey, signal).then((pods) => pods.length).catch(() => null);
      await writeOrgKey(info.label, orgKey);
      await deps.updateState((state) => {
        state.org = {
          label: info.label,
          id: info.id,
          ...info.name ? { name: info.name } : {},
          api_url: apiUrl,
          // pod 上限：面板显示「已有 Pod N / 上限」用
          ...typeof info.max_pods === "number" ? { max_pods: info.max_pods } : {},
          verified_at: (/* @__PURE__ */ new Date()).toISOString(),
          ...str(body.pod_label) ? { pod_label: str(body.pod_label) } : {}
        };
      });
      invalidateUnreadCache();
      return ok(res, {
        label: info.label,
        id: info.id,
        name: info.name ?? null,
        domain: info.domain ?? null,
        api_url: apiUrl,
        pod_count: podCount
      });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/open-pod`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      const cwd = str(body.cwd);
      const state = await deps.loadState();
      const known = key ? state.workspaces[key] : void 0;
      const workspace = (key ? deps.listWorkspaces().find((row) => row.key === key) : void 0) ?? (key && known ? { key, title: known.title, path: known.path } : void 0) ?? deps.matchWorkspaceByPath(cwd);
      if (!workspace) throw new BridgeError(400, "missing-workspace", 'field "key" (workspace) or "cwd" is required');
      assertWorkspaceDirExists(workspace.path);
      const preferredLabel = str(body.pod_label);
      const result = await deps.openPod(workspace, preferredLabel ? { podLabel: preferredLabel } : void 0);
      invalidateUnreadCache();
      return ok(res, { key: workspace.key, ...result });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/remove-workspace`) {
      const body = await readJsonBody(req);
      const key = str(body.key);
      if (!key) throw new BridgeError(400, "missing-workspace", 'field "key" is required');
      const state = await deps.loadState();
      const inbox = state.workspaces[key];
      if (!inbox) throw new BridgeError(404, "unknown-workspace", `no workspace record is registered as "${key}"`);
      const selfAddress = (await resolveVia(deps, key))?.address ?? inbox.address ?? null;
      const holders = selfAddress ? (await Promise.all(Object.keys(state.workspaces).map(async (k) => ({
        k,
        address: (await resolveVia(deps, k))?.address ?? state.workspaces[k]?.address ?? null
      })))).filter((row) => row.address === selfAddress) : [];
      const pathMissing = Boolean(inbox.path) && !existsSync(inbox.path);
      if (holders.length <= 1 && !pathMissing) {
        throw new BridgeError(
          409,
          "sole-holder",
          L(
            '"{key}" \u662F\u5730\u5740 {address} \u7684\u552F\u4E00\u8BB0\u5F55\uFF0C\u79FB\u9664\u540E\u8BE5\u4FE1\u7BB1\u5C06\u4E0D\u518D\u88AB\u7BA1\u7406\uFF1B\u5DF2\u62D2\u7EDD\u3002',
            '"{key}" is the only record for {address}; removing it would leave that inbox unmanaged.',
            { key, address: selfAddress ?? "" }
          )
        );
      }
      const removedFiles = inbox.project_key ? await removeProjectCredentials(inbox.project_key) : [];
      await deleteWorkspaceInbox(key);
      invalidateUnreadCache();
      deps.log(`msg9: removed local record ${key} (${removedFiles.length} credential file(s))`);
      return ok(res, {
        key,
        address: selfAddress,
        removed_files: removedFiles,
        // 明确回给界面：远端什么都没动
        remote_untouched: true
      });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/relink-targets`) {
      const url3 = new URL(req.url ?? "/", "http://localhost");
      const fromKey = url3.searchParams.get("key") ?? "";
      const state = await deps.loadState();
      const source = state.workspaces[fromKey];
      if (!source) throw new BridgeError(404, "unknown-workspace", `no workspace record is registered as "${fromKey}"`);
      const sourceBase = (source.path || "").split("/").filter(Boolean).pop() ?? "";
      const targets = deps.listWorkspaces().filter((workspace) => workspace.key !== fromKey).filter((workspace) => !state.workspaces[workspace.key]).filter((workspace) => Boolean(workspace.path) && existsSync(workspace.path)).map((workspace) => ({
        key: workspace.key,
        title: workspace.title,
        path: workspace.path,
        same_title: workspace.title === source.title,
        same_dir: (workspace.path.split("/").filter(Boolean).pop() ?? "") === sourceBase
      })).sort((a, b) => {
        if (a.same_title !== b.same_title) return a.same_title ? -1 : 1;
        if (a.same_dir !== b.same_dir) return a.same_dir ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
      return ok(res, { from_key: fromKey, targets });
    }
    if (method === "POST" && path === `${BRIDGE_PREFIX}/relink-workspace`) {
      const body = await readJsonBody(req);
      const fromKey = str(body.from_key);
      const toKey = str(body.to_key);
      if (!fromKey || !toKey) {
        throw new BridgeError(400, "missing-key", 'fields "from_key" and "to_key" are required');
      }
      if (fromKey === toKey) {
        throw new BridgeError(400, "same-workspace", "from_key and to_key must differ");
      }
      const state = await deps.loadState();
      const source = state.workspaces[fromKey];
      if (!source) {
        throw new BridgeError(404, "unknown-workspace", `no workspace record is registered as "${fromKey}"`);
      }
      if (state.workspaces[toKey]) {
        throw new BridgeError(409, "target-taken", L(
          '\u76EE\u6807\u5DE5\u4F5C\u533A "{to}" \u5DF2\u7ECF\u6709\u4FE1\u7BB1\u8BB0\u5F55\u4E86\uFF0C\u91CD\u6302\u4F1A\u8986\u76D6\u5B83\uFF1B\u5DF2\u62D2\u7EDD\u3002',
          'workspace "{to}" already has an inbox record; relinking would overwrite it.',
          { to: toKey }
        ));
      }
      const target = deps.listWorkspaces().find((workspace) => workspace.key === toKey);
      if (!target) {
        throw new BridgeError(400, "unknown-target", L(
          '"{to}" \u4E0D\u5728 dsh \u7684\u5DE5\u4F5C\u533A\u6CE8\u518C\u8868\u91CC\uFF1B\u5DF2\u62D2\u7EDD\u3002',
          '"{to}" is not a registered dsh workspace.',
          { to: toKey }
        ));
      }
      if (!existsSync(target.path)) {
        throw new BridgeError(409, "target-path-missing", L(
          "\u76EE\u6807\u5DE5\u4F5C\u533A\u7684\u76EE\u5F55 {path} \u5DF2\u4E0D\u5B58\u5728\uFF1B\u5DF2\u62D2\u7EDD\u3002",
          "the target workspace directory {path} does not exist.",
          { path: target.path }
        ));
      }
      const sourcePathMissing = Boolean(source.path) && !existsSync(source.path);
      if (!sourcePathMissing) {
        throw new BridgeError(409, "source-alive", L(
          "\u6E90\u5DE5\u4F5C\u533A\u7684\u76EE\u5F55\uFF08{path}\uFF09\u4ECD\u7136\u5B58\u5728\uFF0C\u4E0D\u9700\u8981\u91CD\u6302\uFF1B\u5DF2\u62D2\u7EDD\u3002",
          "the source workspace directory ({path}) still exists; nothing to relink.",
          { path: source.path }
        ));
      }
      const moved = await relinkWorkspaceInbox(fromKey, toKey, { path: target.path });
      invalidateUnreadCache();
      const movedAddress = (await resolveVia(deps, toKey))?.address ?? null;
      deps.log(`msg9: relinked inbox record ${fromKey} -> ${toKey} (local only)`);
      return ok(res, {
        from_key: fromKey,
        to_key: toKey,
        address: movedAddress,
        project_key: moved?.project_key ?? null,
        path: target.path,
        // 明确回给界面：远端与凭据都没动
        remote_untouched: true,
        credentials_untouched: true
      });
    }
    if (method === "GET" && path === `${BRIDGE_PREFIX}/pod-state`) {
      const url2 = new URL(req.url ?? "/", "http://localhost");
      const cwd = url2.searchParams.get("cwd") ?? void 0;
      const key = url2.searchParams.get("key") ?? void 0;
      const state = await deps.loadState();
      const known = key ? state.workspaces[key] : void 0;
      const workspace = (key ? deps.listWorkspaces().find((row) => row.key === key) : void 0) ?? (key && known ? { key, title: known.title, path: known.path } : void 0) ?? deps.matchWorkspaceByPath(cwd);
      if (!workspace) throw new BridgeError(400, "missing-workspace", 'query "key" or "cwd" is required');
      return ok(res, {
        key: workspace.key,
        state: await deps.podState(workspace),
        planned_pod_label: deps.derivePodLabel(workspace),
        org: state.org ? { label: state.org.label, name: state.org.name ?? null } : null
      });
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
        await saveOwner({ api_key: args.owner_key, api_url: apiUrl, id: ownerId, name: ownerName });
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
      folder: { type: "string", description: "all | unprocessed | unread | read (default: all). `unprocessed` is the server-side open list and ignores the cursor." },
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
        const unprocessed = args.folder === "unprocessed";
        const since = explicit ?? (unprocessed ? void 0 : inbox.cursor);
        if (unprocessed && !explicit) {
          const page2 = await listInbox(inbox.api_url, inbox.api_key, { folder: "unprocessed", limit }, exec?.signal);
          const open3 = page2.messages ?? [];
          return `${banner}${provisionNote}
${formatMessages(
            open3,
            page2.unread_count ?? 0,
            await autoReadNote(open3, L(
              "\u672A\u5904\u7406\u89C6\u56FE\uFF1A\u4E0D\u53D7\u6E38\u6807\u5F71\u54CD\uFF0C\u95ED\u73AF\uFF08\u56DE\u590D\u6216\u6807\u4E3A\u5DF2\u5904\u7406\uFF09\u540E\u624D\u4F1A\u6D88\u5931\u3002",
              "Unprocessed view \u2014 not narrowed by the cursor; a letter stays until it is closed."
            )),
            { full: args.full, bodyLimit: args.body_limit }
          )}`;
        }
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
        const localByAddress = /* @__PURE__ */ new Map();
        await Promise.all(Object.keys(state.workspaces).map(async (key) => {
          const resolved = await resolveCredentials(key);
          if (resolved) localByAddress.set(resolved.address, resolved);
        }));
        const owner = await resolveOwner();
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
        const local = [...localByAddress.values()];
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
        const owner = await resolveOwner();
        if (!owner?.api_key) {
          return L(
            "\u672A\u914D\u7F6E owner\uFF0C\u65E0\u6CD5\u8F6E\u6362 key\u3002\u8BF7\u5148\u7528 msg9_setup \u914D\u7F6E owner\uFF08\u6216\u91CD\u65B0\u6CE8\u518C\u8BE5 workspace\uFF09\u3002",
            "No owner configured, so the key cannot be rotated. Run msg9_setup first (or re-register this workspace)."
          );
        }
        if (!inbox.project_key) {
          return L("\u51ED\u636E\u8FC1\u79FB\u672A\u5B8C\u6210\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", "Credentials migration is not complete; try again.");
        }
        const { api_key } = await ownerRotateAgentKey(owner.api_url, owner.api_key, inbox.address, exec?.signal);
        await writeProjectCredentials(inbox.project_key, { address: inbox.address, api_key, api_url: inbox.api_url }, { overwrite: true });
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
      const owner = await resolveOwner();
      const state = await loadState();
      const workspace = resolveWorkspace(ctx, exec) ?? DEFAULT_WORKSPACE;
      const inbox = await resolveCredentials(workspace.key);
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

// src/host/daemonclient.ts
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createHash as createHash5, randomUUID as randomUUID2 } from "node:crypto";
import { homedir as homedir4 } from "node:os";
import { join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/host/daemon/main.ts
import { randomUUID } from "node:crypto";
import { mkdir as mkdir4, open as open2, readFile as readFile5, rm as rm4 } from "node:fs/promises";
import { join as join6 } from "node:path";
import { fileURLToPath } from "node:url";

// src/host/watch.ts
function pluginNotice(uuid, text, summary) {
  return {
    role: "user",
    id: uuid,
    content: [{ type: "text", text }],
    source: { kind: "plugin:msg9-kit", form: "notice", summary: truncate(summary, 120) }
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
    if (!inbox.api_key || !inbox.api_url || !inbox.address) continue;
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
    const raw = state.workspaces[key];
    if (!raw?.api_key || !raw.api_url || !raw.address) return;
    const inbox = raw;
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
async function deliverDaemonBatch(deps, key, inbox, body) {
  const messages = body.messages.filter((message2) => message2 && typeof message2.message_id === "string");
  if (messages.length === 0) return true;
  let agent;
  if (inbox.last_wake_agent_id && deps.resolveAgentById) {
    agent = deps.resolveAgentById(inbox.last_wake_agent_id);
  }
  if (!agent) {
    agent = await deps.resolveAgent({ key, inbox });
    if (agent) await deps.setWatchState(key, { last_wake_agent_id: agent.id });
  }
  if (!agent) return false;
  const address = body.inbox || inbox.address;
  const rendered = renderMailNotice(address, messages);
  const text = body.downgraded ? `${rendered.text}
\uFF08\u672C\u6279\u4E3A\u964D\u7EA7\u6295\u9012\uFF1A\u5524\u9192\u9884\u7B97\u5DF2\u7528\u5C3D\uFF0C\u4EC5\u6CE8\u5165\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u4F1A\u4E3B\u52A8\u5524\u9192\u4F1A\u8BDD\u3002 / downgraded delivery: the wake budget was spent, so this batch is context-only.\uFF09` : rendered.text;
  const message = pluginNotice(deps.uuid(), text, rendered.summary);
  if (body.mode === "followup") {
    agent.followup(message);
    deps.log(`watch: daemon delivered ${messages.length} mail(s) for ${address} to ${agent.id} (followup)`);
  } else {
    agent.inject(message);
    deps.log(`watch: daemon delivered ${messages.length} mail(s) for ${address} to ${agent.id} (inject${body.downgraded ? ", downgraded" : ""})`);
  }
  return true;
}

// src/host/daemon/wsclient.ts
import { createHash as createHash4, randomBytes as randomBytes2 } from "node:crypto";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
var WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var OPCODES = {
  CONTINUATION: 0,
  TEXT: 1,
  BINARY: 2,
  CLOSE: 8,
  PING: 9,
  PONG: 10
};
var WsError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "WsError";
  }
};
var MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
var FrameParser = class {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    for (; ; ) {
      const frame = this.readFrame();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }
  readFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return void 0;
    const fin = (buffer[0] & 128) !== 0;
    const opcode = buffer[0] & 15;
    const masked = (buffer[1] & 128) !== 0;
    let length = buffer[1] & 127;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return void 0;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return void 0;
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      if (high > 2097151) throw new WsError("websocket frame exceeds the size ceiling");
      length = high * 2 ** 32 + low;
      offset += 8;
    }
    if (length > MAX_MESSAGE_BYTES) throw new WsError(`websocket frame too large (${length} bytes)`);
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) return void 0;
    let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) {
      const mask2 = buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask2[index % 4];
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }
    this.buffer = buffer.subarray(offset + maskLength + length);
    return { fin, opcode, payload };
  }
};
function encodeFrame(opcode, payload, mask2) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header.writeUInt16BE(length, 2);
    header[1] = 126;
  } else {
    header = Buffer.allocUnsafe(10);
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
    header[1] = 127;
  }
  header[0] = 128 | opcode;
  if (!mask2) return Buffer.concat([header, payload]);
  header[1] = header[1] | 128;
  const maskKey2 = randomBytes2(4);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ maskKey2[index % 4];
  return Buffer.concat([header, maskKey2, masked]);
}
function acceptKey(secKey) {
  return createHash4("sha1").update(secKey + WS_GUID).digest("base64");
}
var WsConnection = class {
  ontext;
  onclose;
  onerror;
  /** Monotonic-ish liveness marker for the engine's watchdog. */
  lastFrameAt = Date.now();
  /** The subprotocol the server accepted, when it answered one. */
  protocol;
  /**
   * Whether the socket has already closed. The engine needs this to close a
   * window its `onclose` handler cannot see: a socket that dies between
   * `wsConnect()` and the handler being installed has already fired (and
   * swallowed) its close event, so nothing would ever wake the loop.
   */
  get isClosed() {
    return this.closed;
  }
  socket;
  parser = new FrameParser();
  fragments = [];
  fragmentBytes = 0;
  closeSent = false;
  closed = false;
  constructor(socket, protocol) {
    this.socket = socket;
    this.protocol = protocol;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => {
      if (this.closed) return;
      this.onerror?.(error);
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.(1006, "abnormal closure");
    });
  }
  onData(chunk) {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      this.onerror?.(error);
      this.destroy();
      return;
    }
    for (const frame of frames) {
      this.lastFrameAt = Date.now();
      try {
        this.handleFrame(frame);
      } catch (error) {
        this.onerror?.(error);
        this.destroy();
        return;
      }
    }
  }
  handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODES.PING:
        this.sendFrame(OPCODES.PONG, frame.payload);
        return;
      case OPCODES.PONG:
        return;
      case OPCODES.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1e3;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        if (!this.closeSent) this.sendFrame(OPCODES.CLOSE, frame.payload);
        this.finish(code, reason);
        return;
      }
      case OPCODES.TEXT:
      case OPCODES.BINARY:
      case OPCODES.CONTINUATION: {
        this.fragments.push(frame.payload);
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new WsError("websocket message exceeds the size ceiling");
        if (!frame.fin) return;
        const whole = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        if (frame.opcode === OPCODES.BINARY) return;
        this.ontext?.(whole.toString("utf8"));
        return;
      }
      default:
        throw new WsError(`unsupported websocket opcode ${frame.opcode}`);
    }
  }
  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload, true));
  }
  sendText(data) {
    this.sendFrame(OPCODES.TEXT, Buffer.from(data, "utf8"));
  }
  /** Graceful close: send the close frame; the peer's reply ends the socket. */
  close(code = 1e3, reason = "") {
    if (this.closed) return;
    this.closeSent = true;
    const reasonBytes = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.sendFrame(OPCODES.CLOSE, payload);
    setTimeout(() => this.destroy(), 1e3).unref();
  }
  /** Hard teardown (watchdog, abort): no close handshake. */
  destroy() {
    if (this.closed) return;
    this.socket.destroy();
    this.finish(1006, "abnormal closure");
  }
  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onclose?.(code, reason);
  }
};
function connectWebSocket(rawUrl, options = {}) {
  const url = new URL(rawUrl);
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  if (!secure && url.protocol !== "ws:" && url.protocol !== "http:") {
    return Promise.reject(new WsError(`unsupported websocket scheme: ${url.protocol}`));
  }
  const port = Number(url.port) || (secure ? 443 : 80);
  const host = url.hostname;
  const timeoutMs = options.timeoutMs ?? 1e4;
  const secKey = randomBytes2(16).toString("base64");
  const path = `${url.pathname || "/"}${url.search}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail3 = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail3(new WsError("websocket connect aborted"));
    const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    socket.setTimeout(timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let handshaken = false;
    let head = Buffer.alloc(0);
    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${secKey}`,
        "Sec-WebSocket-Version: 13"
      ];
      if (options.protocols?.length) lines.push(`Sec-WebSocket-Protocol: ${options.protocols.join(", ")}`);
      for (const [name2, value] of Object.entries(options.headers ?? {})) lines.push(`${name2}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r
\r
`);
    });
    socket.on("timeout", () => fail3(new WsError(`websocket handshake timed out after ${Math.round(timeoutMs / 1e3)}s`)));
    socket.on("error", (error) => {
      if (!handshaken) fail3(error);
    });
    socket.on("data", (chunk) => {
      if (handshaken) return;
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 16384) fail3(new WsError("websocket handshake response too large"));
        return;
      }
      handshaken = true;
      socket.setTimeout(0);
      options.signal?.removeEventListener("abort", onAbort);
      const text = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + 4);
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(text);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (status !== 101) {
        fail3(new WsError(`websocket upgrade rejected (HTTP ${status || "???"})`, status || void 0));
        return;
      }
      const headers = /* @__PURE__ */ new Map();
      for (const line of text.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      if (headers.get("sec-websocket-accept") !== acceptKey(secKey)) {
        fail3(new WsError("websocket handshake failed: bad Sec-WebSocket-Accept"));
        return;
      }
      settled = true;
      const connection = new WsConnection(socket, headers.get("sec-websocket-protocol"));
      resolve(connection);
      if (rest.length > 0) socket.emit("data", rest);
    });
  });
}

// src/host/daemon/state.ts
import { mkdir as mkdir3, readFile as readFile4, rename as rename2, rm as rm3, stat as stat2, writeFile as writeFile3 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2, join as join4 } from "node:path";
function daemonHome() {
  return process.env.MSG9_DAEMON_HOME || join4(homedir3(), ".dsh", "msg9-daemon");
}
function daemonInfoPath(home = daemonHome()) {
  return join4(home, "daemon.json");
}
function daemonStatePath(home = daemonHome()) {
  return join4(home, "state.json");
}
async function readDaemonInfo(home = daemonHome()) {
  let raw;
  try {
    raw = await readFile4(daemonInfoPath(home), "utf8");
  } catch {
    return void 0;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number" || typeof parsed.token !== "string") return void 0;
    return {
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      started_at: parsed.started_at ?? "",
      version: parsed.version ?? "unknown",
      protocol: parsed.protocol ?? 0
    };
  } catch {
    return void 0;
  }
}
async function writeDaemonInfo(info, home = daemonHome()) {
  await atomicWrite(daemonInfoPath(home), `${JSON.stringify(info, null, 2)}
`);
}
async function removeDaemonInfo(pid, home = daemonHome()) {
  const current = await readDaemonInfo(home);
  if (current && current.pid !== pid) return;
  await rm3(daemonInfoPath(home), { force: true });
}
function emptyState() {
  return { inboxes: {}, pending: [] };
}
async function atomicWrite(path, content) {
  await mkdir3(dirname2(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile3(temp, content, { mode: 384 });
  await rename2(temp, path);
}
async function openDaemonStore(home = daemonHome()) {
  let state = emptyState();
  try {
    const raw = await readFile4(daemonStatePath(home), "utf8");
    const parsed = JSON.parse(raw);
    state = {
      notify_paused: parsed.notify_paused === true,
      inboxes: parsed.inboxes ?? {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      const backup = `${daemonStatePath(home)}.corrupt-${Date.now()}`;
      await writeFile3(backup, await readFile4(daemonStatePath(home), "utf8").catch(() => ""), { mode: 384 }).catch(() => {
      });
      throw new Error(`msg9 daemon state file is not valid JSON (a copy was kept at ${backup}): ${error.message}`);
    }
  }
  let queue = Promise.resolve();
  return {
    home,
    get: () => state,
    mutate(fn) {
      const run = queue.then(async () => {
        fn(state);
        await atomicWrite(daemonStatePath(home), `${JSON.stringify(state, null, 2)}
`);
      });
      queue = run.catch(() => {
      });
      return run;
    }
  };
}
function computeFlushAt(batch, now, windowMs) {
  return Math.min(now + windowMs, batch.max_wait_until);
}
function backoffMs(failures, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, failures), 6));
}
function mergeDeliveredIds(existing, acked, cap = 200) {
  const seen = new Set(existing ?? []);
  const merged = [...existing ?? []];
  for (const id of acked) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
function selectOrphanPending(pending, options) {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) return { archive: [], keep: [...pending] };
  const archive = [];
  const keep = [];
  for (const item of pending) {
    const enqueuedAt = Date.parse(item.enqueued_at);
    const oldEnough = Number.isFinite(enqueuedAt) && options.now - enqueuedAt >= options.ttlMs;
    if (!options.isLive(item.project_key) && oldEnough) archive.push(item);
    else keep.push(item);
  }
  return { archive, keep };
}
function acceptArchivedBatch(inbox, item) {
  const atSeq = item.cursor_seq ?? inbox.cursor_seq ?? 0;
  if (atSeq >= (inbox.acked_seq ?? 0)) {
    if (item.next_cursor) inbox.watch_cursor = item.next_cursor;
    else if (inbox.fetch_cursor) inbox.watch_cursor = inbox.fetch_cursor;
    inbox.acked_seq = atSeq;
  }
  inbox.delivered_ids = mergeDeliveredIds(inbox.delivered_ids, item.messages.map((message) => message.message_id));
}
function knownMessageIds(state, projectKey) {
  const inbox = state.inboxes[projectKey];
  const known = new Set(inbox?.delivered_ids ?? []);
  for (const message of inbox?.batch?.messages ?? []) known.add(message.message_id);
  for (const item of state.pending) {
    if (item.project_key !== projectKey) continue;
    for (const message of item.messages) known.add(message.message_id);
  }
  return known;
}
async function isStalePidFile(path, staleMs = 3e4) {
  let info;
  try {
    info = await stat2(path);
  } catch {
    return true;
  }
  if (Date.now() - info.mtimeMs > staleMs) return true;
  const raw = await readFile4(path, "utf8").catch(() => "");
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

// src/host/daemon/engine.ts
var INSTANCE_STALE_MS = 3 * 6e4;
function createRegistry() {
  const instances = /* @__PURE__ */ new Map();
  return {
    upsert(reg, now) {
      const existing = instances.get(reg.instance_id);
      const record = {
        ...reg,
        registered_at: existing?.registered_at ?? new Date(now).toISOString(),
        last_seen: now
      };
      instances.set(reg.instance_id, record);
      return record;
    },
    touch(instanceId, patch, now) {
      const existing = instances.get(instanceId);
      if (!existing) return false;
      if (patch.port !== void 0 && patch.port > 0) existing.port = patch.port;
      if (patch.workspaces) existing.workspaces = patch.workspaces;
      existing.last_seen = now;
      return true;
    },
    remove(instanceId) {
      instances.delete(instanceId);
    },
    get: (instanceId) => instances.get(instanceId),
    forProjectKey(projectKey) {
      let winner;
      for (const instance of instances.values()) {
        if (instance.workspaces.some((row) => row.project_key === projectKey)) {
          if (!winner || instance.last_seen >= winner.last_seen) winner = instance;
        }
      }
      return winner;
    },
    list: () => [...instances.values()]
  };
}
function defaultEngineConfig() {
  return {
    reconcileMs: 6e4,
    safetyNetMs: 12e4,
    batchWindowMs: 12e3,
    batchMaxWaitMs: 6e4,
    deliverRetryBaseMs: 2e3,
    deliverRetryMaxMs: 6e4,
    reconnectBaseMs: 2e3,
    reconnectMaxMs: 3e4,
    wsWatchdogMs: 12e4,
    wakeMaxWakes: 3,
    wakeWindowMs: 30 * 6e4,
    pendingSweepMs: 6e4,
    pendingCap: 50,
    // 24h ≫ 重连预算（心跳 45s / 实例过期 3min / 退避上限 30s）：正常重连窗口
    // 里的 pending 绝不会被误判成孤儿。真实事故里的死 key 压了整整两天。
    orphanPendingTtlMs: 24 * 60 * 6e4,
    fetchPageLimit: 20,
    fetchMaxPages: 10,
    unprocessedMaxPages: 50
  };
}
var DeliverHttpError = class extends Error {
  constructor(message, status, noSession) {
    super(message);
    this.status = status;
    this.noSession = noSession;
    this.name = "DeliverHttpError";
  }
};
function wsUrlFor(apiUrl) {
  const url = new URL(`${apiUrl.replace(/\/+$/, "")}/api/v1/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
var InboxRunner = class {
  constructor(projectKey, engine) {
    this.projectKey = projectKey;
    this.engine = engine;
    const { config } = engine.deps;
    this.budget = new WakeBudget(config.wakeMaxWakes, config.wakeWindowMs);
  }
  /** Last FETCHED cursor (uncommitted); restored from state on boot. */
  fetchCursor;
  ws;
  wsWaiter;
  watchdog;
  safety;
  flushTimer;
  retryTimer;
  fetching = false;
  fetchAgain = false;
  flushing = false;
  stopped = false;
  abort = new AbortController();
  budget;
  get connected() {
    return this.ws !== void 0;
  }
  start() {
    const state = this.engine.deps.store.get().inboxes[this.projectKey];
    this.fetchCursor = state?.fetch_cursor ?? state?.watch_cursor;
    if (state?.batch) this.scheduleFlush();
    void this.loop();
    this.safety = setInterval(() => void this.fetchNew("safety-net"), this.engine.deps.config.safetyNetMs);
  }
  stop() {
    this.stopped = true;
    this.abort.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.safety) clearInterval(this.safety);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.destroy();
    this.releaseWs();
  }
  log(message) {
    this.engine.deps.log(message);
  }
  // ------------------------------------------------------------- ws loop
  async loop() {
    const { deps } = this.engine;
    let failures = 0;
    while (!this.abort.signal.aborted && !this.stopped) {
      const identity = this.engine.identities.get(this.projectKey);
      if (!identity) return;
      try {
        const { ticket } = await deps.issueWsTicket(identity.api_url, identity.api_key, this.abort.signal);
        const ws = await deps.wsConnect(wsUrlFor(identity.api_url), {
          protocols: ["msg9-l0", ticket],
          timeoutMs: 1e4,
          signal: this.abort.signal
        });
        if (this.abort.signal.aborted || this.stopped) {
          ws.destroy();
          return;
        }
        const closed = new Promise((resolve) => {
          this.wsWaiter = resolve;
        });
        this.attachWs(ws);
        failures = 0;
        await this.fetchNew("catch-up");
        if (this.abort.signal.aborted || this.stopped) return;
        if (this.ws !== ws) continue;
        await closed;
      } catch (error) {
        if (this.abort.signal.aborted || this.stopped) return;
        failures += 1;
        const wait = backoffMs(failures, deps.config.reconnectBaseMs, deps.config.reconnectMaxMs);
        this.log(`msg9 daemon: ws for ${identity.address} failed: ${error?.message ?? String(error)}; retry in ${Math.round(wait / 1e3)}s`);
        await deps.sleep(wait, this.abort.signal);
      } finally {
        this.releaseWs();
      }
    }
  }
  attachWs(ws) {
    this.ws = ws;
    ws.ontext = (data) => {
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (event?.type === "ping") {
        ws.sendText('{"type":"pong"}');
        return;
      }
      if (event?.type === "new_message") {
        const messageId = event.message?.message_id;
        if (typeof messageId === "string" && messageId !== "") {
          ws.sendText(JSON.stringify({ type: "ack", message_id: messageId }));
        }
        void this.fetchNew("ws-push");
      }
    };
    ws.onerror = (error) => {
      this.log(`msg9 daemon: ws error for ${this.projectKey}: ${error.message}`);
      ws.destroy();
    };
    ws.onclose = (code, reason) => {
      this.log(`msg9 daemon: ws closed for ${this.projectKey} (${code}${reason ? ` ${reason}` : ""}) \u2014 reconnecting`);
      this.releaseWs();
    };
    if (ws.isClosed) {
      this.log(`msg9 daemon: ws for ${this.projectKey} was already closed before attach \u2014 retrying`);
      this.releaseWs();
    }
    if (this.watchdog) clearInterval(this.watchdog);
    const watchdogMs = this.engine.deps.config.wsWatchdogMs;
    const cadence = Math.max(50, Math.min(15e3, Math.floor(watchdogMs / 4)));
    this.watchdog = setInterval(() => {
      if (Date.now() - ws.lastFrameAt > watchdogMs) {
        this.log(`msg9 daemon: ws for ${this.projectKey} silent past the watchdog window; reconnecting`);
        ws.destroy();
      }
    }, cadence);
  }
  releaseWs() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = void 0;
    }
    this.ws = void 0;
    const waiter = this.wsWaiter;
    this.wsWaiter = void 0;
    waiter?.();
  }
  // ------------------------------------------------------------- fetching
  identityAddress() {
    return this.engine.identities.get(this.projectKey)?.address ?? this.projectKey;
  }
  /** Non-reentrant fetch; concurrent triggers collapse into one extra pass. */
  async fetchNew(trigger) {
    if (this.stopped) return;
    if (this.fetching) {
      this.fetchAgain = true;
      return;
    }
    this.fetching = true;
    try {
      do {
        this.fetchAgain = false;
        await this.fetchPass(trigger);
      } while (this.fetchAgain && !this.stopped);
    } catch (error) {
      this.log(`msg9 daemon: fetch failed for ${this.identityAddress()}: ${error?.message ?? String(error)}`);
    } finally {
      this.fetching = false;
    }
  }
  async fetchPass(_trigger) {
    const { deps } = this.engine;
    const identity = this.engine.identities.get(this.projectKey);
    if (!identity) return;
    const inboxState = deps.store.get().inboxes[this.projectKey];
    const since = this.fetchCursor ?? inboxState?.fetch_cursor ?? inboxState?.watch_cursor;
    if (!since) return this.bootstrap(identity, inboxState);
    let cursor = since;
    const fresh = [];
    let lastCursor;
    for (let page = 0; page < deps.config.fetchMaxPages; page += 1) {
      const result = await deps.listInbox(identity.api_url, identity.api_key, {
        folder: "all",
        limit: deps.config.fetchPageLimit,
        since: cursor
      });
      if (result.next_cursor) {
        lastCursor = result.next_cursor;
        cursor = result.next_cursor;
      }
      fresh.push(...result.messages ?? []);
      if (!result.has_more) break;
    }
    if (!lastCursor || lastCursor === since) {
      if (lastCursor) this.fetchCursor = lastCursor;
      return;
    }
    this.fetchCursor = lastCursor;
    const seq = await this.noteFetchCursor(lastCursor, fresh);
    if (fresh.length === 0) return;
    if (deps.store.get().notify_paused) {
      await this.commitCursor(seq, fresh.map((message) => message.message_id));
      this.log(`msg9 daemon: notify paused \u2014 ${fresh.length} mail(s) for ${identity.address} tracked silently`);
      return;
    }
    await this.enqueue(fresh, lastCursor, seq);
  }
  /** Record the fetched (uncommitted) cursor + bump its monotonic sequence. */
  async noteFetchCursor(cursor, fresh) {
    const { deps } = this.engine;
    let seq = 0;
    await deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state);
      seq = (inbox.cursor_seq ?? 0) + 1;
      inbox.cursor_seq = seq;
      inbox.fetch_cursor = cursor;
      const newest = fresh[fresh.length - 1];
      if (newest) {
        inbox.watch_last_message_id = newest.message_id;
        if (newest.created_at) inbox.watch_last_seen_at = newest.created_at;
      }
    });
    return seq;
  }
  /** First observation: establish the baseline without announcing history. */
  async bootstrap(identity, inboxState) {
    const { deps } = this.engine;
    const page = await deps.listInbox(identity.api_url, identity.api_key, { folder: "all", limit: deps.config.fetchPageLimit });
    const messages = page.messages ?? [];
    if (!page.next_cursor) {
      if (!inboxState?.bootstrap_pending) {
        await deps.store.mutate((state) => {
          this.ensureInbox(state).bootstrap_pending = true;
        });
      }
      return;
    }
    this.fetchCursor = page.next_cursor;
    if (inboxState?.bootstrap_pending) {
      let all = messages;
      const total = page.total ?? messages.length;
      for (let extra = 0; all.length < total && extra < deps.config.fetchMaxPages; extra += 1) {
        const more = await deps.listInbox(identity.api_url, identity.api_key, {
          folder: "all",
          limit: deps.config.fetchPageLimit,
          offset: all.length
        });
        const rows = more.messages ?? [];
        if (rows.length === 0) break;
        all = all.concat(rows);
      }
      let seq = 0;
      await deps.store.mutate((state) => {
        const inbox = this.ensureInbox(state);
        delete inbox.bootstrap_pending;
        seq = (inbox.cursor_seq ?? 0) + 1;
        inbox.cursor_seq = seq;
        inbox.fetch_cursor = page.next_cursor;
        if (messages[0]) {
          inbox.watch_last_message_id = messages[0].message_id;
          if (messages[0].created_at) inbox.watch_last_seen_at = messages[0].created_at;
        }
      });
      if (deps.store.get().notify_paused) {
        await this.commitCursor(seq, all.map((message) => message.message_id));
        this.log(`msg9 daemon: notify paused \u2014 ${all.length} mail(s) for ${identity.address} tracked silently`);
        return;
      }
      await this.enqueue(all, page.next_cursor, seq);
      return;
    }
    await deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state);
      delete inbox.bootstrap_pending;
      inbox.watch_cursor = page.next_cursor;
      inbox.fetch_cursor = page.next_cursor;
      inbox.cursor_seq = (inbox.cursor_seq ?? 0) + 1;
      inbox.acked_seq = inbox.cursor_seq;
      if (messages[0]) {
        inbox.watch_last_message_id = messages[0].message_id;
        if (messages[0].created_at) inbox.watch_last_seen_at = messages[0].created_at;
      }
    });
  }
  ensureInbox(state) {
    const identity = this.engine.identities.get(this.projectKey);
    const inbox = state.inboxes[this.projectKey] ??= {
      address: identity?.address ?? "",
      api_url: identity?.api_url ?? ""
    };
    if (identity) {
      inbox.address = identity.address;
      inbox.api_url = identity.api_url;
    }
    return inbox;
  }
  // -------------------------------------------------------- batch + flush
  async enqueue(messages, nextCursor, seq) {
    const { deps } = this.engine;
    let added = 0;
    await deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state);
      const known = knownMessageIds(state, this.projectKey);
      const fresh = messages.filter((message) => message.message_id && !known.has(message.message_id));
      if (fresh.length === 0) return;
      const nowMs = deps.now();
      const batch = inbox.batch ??= {
        messages: [],
        first_queued_at: new Date(nowMs).toISOString(),
        deliver_after: nowMs + deps.config.batchWindowMs,
        max_wait_until: nowMs + deps.config.batchMaxWaitMs
      };
      batch.messages.push(...fresh);
      batch.next_cursor = nextCursor;
      batch.cursor_seq = seq;
      batch.deliver_after = computeFlushAt(batch, nowMs, deps.config.batchWindowMs);
      added = fresh.length;
    });
    if (added > 0) this.scheduleFlush();
  }
  scheduleFlush() {
    if (this.stopped) return;
    const batch = this.engine.deps.store.get().inboxes[this.projectKey]?.batch;
    if (!batch) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const delay = Math.max(0, batch.deliver_after - this.engine.deps.now());
    this.flushTimer = setTimeout(() => void this.flush(), delay);
  }
  async flush() {
    if (this.stopped || this.flushing) return;
    this.flushing = true;
    try {
      await this.flushPass();
    } catch (error) {
      this.log(`msg9 daemon: flush failed for ${this.identityAddress()}: ${error?.message ?? String(error)}`);
    } finally {
      this.flushing = false;
      if (!this.stopped && this.engine.deps.store.get().inboxes[this.projectKey]?.batch && !this.retryTimer) {
        this.scheduleFlush();
      }
    }
  }
  async flushPass() {
    const { deps } = this.engine;
    const identity = this.engine.identities.get(this.projectKey);
    const batch = deps.store.get().inboxes[this.projectKey]?.batch;
    if (!identity || !batch) return;
    if (batch.messages.length === 0) {
      await deps.store.mutate((state) => {
        delete this.ensureInbox(state).batch;
      });
      return;
    }
    const actionable = await this.onlyUnprocessed(identity, batch.messages);
    if (actionable.length === 0) {
      this.log(`msg9 daemon: ${batch.messages.length} mail(s) for ${identity.address} already closed server-side; skipping delivery`);
      await this.ackBatch(batch.messages.map((message) => message.message_id), batch.next_cursor, batch.cursor_seq);
      return;
    }
    const mode = this.budget.decide(deps.now()) === "wake" ? "followup" : "inject";
    const body = {
      inbox: identity.address,
      project_key: this.projectKey,
      messages: actionable,
      mode,
      ...mode === "inject" ? { downgraded: true } : {}
    };
    const target = deps.registry.forProjectKey(this.projectKey);
    if (!target || target.port <= 0) {
      this.log(`msg9 daemon: no live instance for ${identity.address}; ${actionable.length} mail(s) queued for redelivery`);
      await this.toPending(void 0, body, batch.next_cursor, batch.cursor_seq);
      return;
    }
    try {
      await deps.deliverPost(target, body, 15e3);
      await this.ackBatch(batch.messages.map((message) => message.message_id), batch.next_cursor, batch.cursor_seq);
      this.log(`msg9 daemon: delivered ${actionable.length} mail(s) for ${identity.address} to ${target.instance_id} (${mode}${body.downgraded ? ", downgraded" : ""})`);
    } catch (error) {
      if (error instanceof DeliverHttpError && error.noSession) {
        this.log(`msg9 daemon: ${target.instance_id} has no live session for ${identity.address}; ${actionable.length} mail(s) queued for redelivery`);
        await this.toPending(target.instance_id, body, batch.next_cursor, batch.cursor_seq);
        return;
      }
      this.retryFailures += 1;
      const wait = backoffMs(this.retryFailures, deps.config.deliverRetryBaseMs, deps.config.deliverRetryMaxMs);
      this.log(`msg9 daemon: deliver to ${target.instance_id} failed (${error?.message ?? String(error)}); retry in ${Math.round(wait / 1e3)}s`);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = void 0;
        void this.flush();
      }, wait);
    }
  }
  retryFailures = 0;
  /** Cursor advance happens HERE — after the ack — never earlier. */
  async ackBatch(messageIds, nextCursor, seq) {
    this.retryFailures = 0;
    await this.commitCursor(seq, messageIds, nextCursor);
    await this.engine.deps.store.mutate((state) => {
      const inbox = state.inboxes[this.projectKey];
      if (inbox) delete inbox.batch;
    });
  }
  async commitCursor(seq, messageIds, cursor) {
    await this.engine.deps.store.mutate((state) => {
      const inbox = this.ensureInbox(state);
      const atSeq = seq ?? inbox.cursor_seq ?? 0;
      if (atSeq >= (inbox.acked_seq ?? 0)) {
        if (cursor) inbox.watch_cursor = cursor;
        else if (inbox.fetch_cursor) inbox.watch_cursor = inbox.fetch_cursor;
        inbox.acked_seq = atSeq;
      }
      inbox.delivered_ids = mergeDeliveredIds(inbox.delivered_ids, messageIds);
    });
  }
  async toPending(instanceId, body, nextCursor, seq) {
    const { deps } = this.engine;
    this.retryFailures = 0;
    await deps.store.mutate((state) => {
      const inbox = state.inboxes[this.projectKey];
      if (inbox) delete inbox.batch;
      const mine = state.pending.filter((item2) => item2.project_key === this.projectKey);
      if (mine.length >= deps.config.pendingCap) {
        const oldest = mine[0];
        state.pending.splice(state.pending.indexOf(oldest), 1);
        this.log(`msg9 daemon: pending overflow for ${body.inbox}; dropped the oldest item (cursor still covers it)`);
      }
      const item = {
        id: deps.uuid(),
        project_key: this.projectKey,
        ...instanceId ? { instance_id: instanceId } : {},
        messages: body.messages,
        ...nextCursor ? { next_cursor: nextCursor } : {},
        mode: body.mode,
        downgraded: body.downgraded === true,
        enqueued_at: new Date(deps.now()).toISOString(),
        attempts: 0,
        next_retry_at: deps.now(),
        ...seq !== void 0 ? { cursor_seq: seq } : {}
      };
      state.pending.push(item);
    });
  }
  /**
   * Paged reconcile against folder=unprocessed (the v1.20 rule, without the
   * old limit=100 truncation): pages of 100 until a short page. Falls back to
   * the payload's processed_at when the reconcile call itself fails — a broken
   * reconcile degrades to the old behaviour, never to "wake for everything".
   */
  async onlyUnprocessed(identity, messages) {
    const { deps } = this.engine;
    if (messages.length === 0) return messages;
    try {
      const live = /* @__PURE__ */ new Set();
      let offset = 0;
      for (let page = 0; page < deps.config.unprocessedMaxPages; page += 1) {
        const result = await deps.listInbox(identity.api_url, identity.api_key, { folder: "unprocessed", limit: 100, offset });
        const rows = result.messages ?? [];
        for (const row of rows) live.add(row.message_id);
        if (rows.length < 100) break;
        offset += rows.length;
      }
      return messages.filter((message) => live.has(message.message_id));
    } catch (error) {
      this.log(`msg9 daemon: unprocessed reconcile failed for ${identity.address} (${error?.message ?? String(error)}); falling back to processed_at`);
      return messages.filter((message) => !message.processed_at);
    }
  }
};
function summarizeIds(ids, cap = 5) {
  return ids.length <= cap ? ids.join(", ") : `${ids.slice(0, cap).join(", ")}, +${ids.length - cap}`;
}
function createEngine(deps) {
  const context = { deps, identities: /* @__PURE__ */ new Map() };
  const runners = /* @__PURE__ */ new Map();
  let reconcileTimer;
  let sweepTimer;
  let replaying = false;
  let stopped = false;
  let sawRegistration = false;
  const hasLiveRegistration = (projectKey, now) => {
    const instance = deps.registry.forProjectKey(projectKey);
    return instance !== void 0 && now - instance.last_seen < INSTANCE_STALE_MS;
  };
  const sweepOrphanPending = async () => {
    if (deps.registry.list().length > 0) sawRegistration = true;
    if (!sawRegistration) return;
    const now = deps.now();
    const ttl = deps.config.orphanPendingTtlMs;
    const { archive } = selectOrphanPending(deps.store.get().pending, {
      now,
      ttlMs: ttl,
      isLive: (projectKey) => hasLiveRegistration(projectKey, now)
    });
    if (archive.length === 0) return;
    await deps.store.mutate((state2) => {
      const archivedIds = new Set(archive.map((item) => item.id));
      state2.pending = state2.pending.filter((item) => !archivedIds.has(item.id));
      for (const item of archive) {
        const inbox = state2.inboxes[item.project_key];
        if (inbox) acceptArchivedBatch(inbox, item);
      }
    });
    const state = deps.store.get();
    const ttlHours = Math.round(ttl / 36e5);
    for (const key of [...new Set(archive.map((item) => item.project_key))]) {
      const items = archive.filter((item) => item.project_key === key);
      const mails = items.reduce((total, item) => total + item.messages.length, 0);
      const mailIds = [...new Set(items.flatMap((item) => item.messages.map((message) => message.message_id)))];
      const oldest = Math.min(...items.map((item) => Date.parse(item.enqueued_at)).filter(Number.isFinite));
      const ageHours = Number.isFinite(oldest) ? Math.round((now - oldest) / 36e5 * 10) / 10 : "?";
      const inbox = state.inboxes[key];
      deps.log(
        `msg9 daemon: archived ${mails} orphan mail(s) in ${items.length} batch(es) for ${inbox?.address ?? key} (${key}): no live instance for ${ageHours}h (> ${ttlHours}h reconnect budget); batches [${summarizeIds(items.map((item) => item.id))}] mails [${summarizeIds(mailIds)}]; cursor advanced to ${inbox?.watch_cursor ?? "?"} \u2014 this address is no longer pinned`
      );
    }
  };
  const reconcile = async () => {
    const identities = await deps.enumerate();
    const next = new Map(identities.map((identity) => [identity.project_key, identity]));
    context.identities = next;
    for (const [key, identity] of next) {
      const runner = runners.get(key);
      if (runner) continue;
      const fresh = new InboxRunner(key, context);
      runners.set(key, fresh);
      fresh.start();
      deps.log(`msg9 daemon: watching ${identity.address} (${key})`);
    }
    for (const [key, runner] of [...runners]) {
      if (next.has(key)) continue;
      runner.stop();
      runners.delete(key);
      deps.log(`msg9 daemon: inbox ${key} disappeared; watcher stopped`);
    }
    await deps.store.mutate((state) => {
      for (const [key, identity] of next) {
        const inbox = state.inboxes[key] ??= { address: identity.address, api_url: identity.api_url };
        inbox.address = identity.address;
        inbox.api_url = identity.api_url;
      }
    });
  };
  const replayPending = async (projectKey) => {
    if (replaying) return;
    replaying = true;
    try {
      const now = deps.now();
      const due = deps.store.get().pending.filter((item) => item.next_retry_at <= now && (!projectKey || item.project_key === projectKey));
      const skippedKeys = /* @__PURE__ */ new Set();
      for (const item of due) {
        if (skippedKeys.has(item.project_key)) continue;
        const target = deps.registry.forProjectKey(item.project_key);
        if (!target || target.port <= 0) continue;
        const address = context.identities.get(item.project_key)?.address ?? deps.store.get().inboxes[item.project_key]?.address ?? item.project_key;
        try {
          await deps.deliverPost(target, {
            inbox: address,
            project_key: item.project_key,
            messages: item.messages,
            mode: item.mode,
            ...item.downgraded ? { downgraded: true } : {}
          }, 15e3);
          await deps.store.mutate((state) => {
            const index = state.pending.findIndex((row) => row.id === item.id);
            if (index !== -1) state.pending.splice(index, 1);
            const inbox = state.inboxes[item.project_key];
            if (inbox) {
              const atSeq = item.cursor_seq ?? inbox.cursor_seq ?? 0;
              if (atSeq >= (inbox.acked_seq ?? 0)) {
                if (item.next_cursor) inbox.watch_cursor = item.next_cursor;
                inbox.acked_seq = atSeq;
              }
              inbox.delivered_ids = mergeDeliveredIds(inbox.delivered_ids, item.messages.map((message) => message.message_id));
            }
          });
          deps.log(`msg9 daemon: redelivered ${item.messages.length} queued mail(s) for ${address} to ${target.instance_id}`);
        } catch (error) {
          const attempts = item.attempts + 1;
          const wait = backoffMs(attempts, deps.config.deliverRetryBaseMs, deps.config.deliverRetryMaxMs);
          await deps.store.mutate((state) => {
            const row = state.pending.find((entry) => entry.id === item.id);
            if (row) {
              row.attempts = attempts;
              row.next_retry_at = deps.now() + wait;
            }
          });
          if (!(error instanceof DeliverHttpError && error.noSession)) {
            deps.log(`msg9 daemon: redelivery for ${address} failed (${error?.message ?? String(error)}); retry in ${Math.round(wait / 1e3)}s`);
          }
          skippedKeys.add(item.project_key);
        }
      }
    } finally {
      replaying = false;
    }
  };
  return {
    async start() {
      await reconcile();
      reconcileTimer = setInterval(() => {
        void reconcile().then(() => sweepOrphanPending()).catch((error) => deps.log(`msg9 daemon: reconcile failed: ${error?.message ?? String(error)}`));
      }, deps.config.reconcileMs);
      sweepTimer = setInterval(() => void replayPending(), deps.config.pendingSweepMs);
    },
    async stop() {
      stopped = true;
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      for (const runner of runners.values()) runner.stop();
      runners.clear();
    },
    replayPending(projectKey) {
      if (stopped) return;
      void replayPending(projectKey);
    },
    status() {
      const state = deps.store.get();
      return [...context.identities.keys()].sort().map((key) => ({
        project_key: key,
        address: context.identities.get(key).address,
        ws_connected: runners.get(key)?.connected ?? false,
        has_cursor: Boolean(state.inboxes[key]?.watch_cursor),
        batch_size: state.inboxes[key]?.batch?.messages.length ?? 0,
        pending: state.pending.filter((item) => item.project_key === key).length
      }));
    }
  };
}

// src/host/daemon/identity.ts
import { readdir as readdir2 } from "node:fs/promises";
import { join as join5 } from "node:path";
function dshProjectsDir() {
  return join5(msg9Home(), "projects", "dsh");
}
async function enumerateIdentities(log = () => {
}) {
  let entries;
  try {
    entries = await readdir2(dshProjectsDir());
  } catch {
    return [];
  }
  const identities = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml") || entry.endsWith(".signing.yaml")) continue;
    const projectKey = entry.slice(0, -".yaml".length);
    if (!projectKey) continue;
    try {
      const creds = await readProjectCredentials(projectKey);
      if (!creds) {
        log(`msg9 daemon: skipping unreadable credential ${entry}`);
        continue;
      }
      identities.push({
        project_key: projectKey,
        address: creds.address,
        api_key: creds.api_key,
        api_url: creds.api_url
      });
    } catch (error) {
      log(`msg9 daemon: skipping credential ${entry}: ${error?.message ?? String(error)}`);
    }
  }
  return identities;
}

// src/host/daemon/server.ts
import { createServer } from "node:http";
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";
var MAX_BODY_BYTES2 = 1024 * 1024;
function sendJson2(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}
function ok2(res, data) {
  sendJson2(res, 200, { ok: true, data });
}
function fail2(res, status, code, message) {
  sendJson2(res, status, { ok: false, error: { code, message } });
}
function tokenMatches2(expected, presented) {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual2(a, b);
}
async function readJsonBody2(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES2) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
  return parsed;
}
function str2(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function parseWorkspaces(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row;
    const projectKey = str2(record.project_key);
    if (!projectKey) continue;
    rows.push({
      project_key: projectKey,
      key: str2(record.key) ?? projectKey,
      title: str2(record.title) ?? projectKey,
      path: str2(record.path) ?? ""
    });
  }
  return rows;
}
function startControlServer(deps) {
  const staleAfterMs = INSTANCE_STALE_MS;
  const pruneStale = () => {
    const now = Date.now();
    for (const instance of deps.registry.list()) {
      if (now - instance.last_seen < staleAfterMs) continue;
      const probe = new Promise((resolve) => {
        if (instance.port <= 0) {
          resolve(false);
          return;
        }
        import("node:net").then(({ connect }) => {
          const socket = connect({ host: "127.0.0.1", port: instance.port });
          socket.setTimeout(1e3);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
          });
          socket.once("error", () => resolve(false));
        }).catch(() => resolve(false));
      });
      void probe.then((alive) => {
        if (!alive) {
          deps.registry.remove(instance.instance_id);
          deps.log(`msg9 daemon: instance ${instance.instance_id} missed heartbeats and its port refuses; unregistered`);
        }
      });
    }
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";
      if (method === "GET" && path === "/healthz") {
        return ok2(res, {
          status: "ok",
          version: deps.version,
          protocol: deps.protocol,
          started_at: deps.startedAt,
          uptime_s: Math.round((Date.now() - Date.parse(deps.startedAt)) / 1e3)
        });
      }
      const auth = req.headers.authorization ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!presented || !tokenMatches2(deps.token, presented)) {
        return fail2(res, 401, "unauthorized", "a valid daemon token is required");
      }
      if (method === "POST" && path === "/register") {
        const body = await readJsonBody2(req);
        const instanceId = str2(body.instance_id);
        const deliverToken = str2(body.deliver_token);
        const protocol = typeof body.protocol === "number" ? body.protocol : 0;
        if (!instanceId) return fail2(res, 400, "missing-instance", 'field "instance_id" is required');
        if (!deliverToken) return fail2(res, 400, "missing-token", 'field "deliver_token" is required');
        if (protocol !== deps.protocol) {
          return fail2(res, 409, "protocol-mismatch", `daemon speaks protocol ${deps.protocol}, plugin offered ${protocol}`);
        }
        const registration = {
          instance_id: instanceId,
          pid: typeof body.pid === "number" ? body.pid : 0,
          dsh_home: str2(body.dsh_home) ?? "",
          port: typeof body.port === "number" && body.port > 0 ? body.port : 0,
          deliver_token: deliverToken,
          protocol,
          workspaces: parseWorkspaces(body.workspaces)
        };
        deps.registry.upsert(registration, Date.now());
        deps.log(`msg9 daemon: instance ${instance_id_redact(instanceId)} registered (${registration.workspaces.length} workspace(s), port ${registration.port || "unknown"})`);
        deps.engine.replayPending();
        return ok2(res, {
          instance_id: instanceId,
          notify_paused: deps.store.get().notify_paused === true,
          daemon_version: deps.version,
          protocol: deps.protocol
        });
      }
      if (method === "POST" && path === "/heartbeat") {
        const body = await readJsonBody2(req);
        const instanceId = str2(body.instance_id);
        if (!instanceId) return fail2(res, 400, "missing-instance", 'field "instance_id" is required');
        const touched = deps.registry.touch(instanceId, {
          ...typeof body.port === "number" && body.port > 0 ? { port: body.port } : {},
          ...body.workspaces !== void 0 ? { workspaces: parseWorkspaces(body.workspaces) } : {}
        }, Date.now());
        if (!touched) return fail2(res, 404, "unknown-instance", "instance is not registered; register first");
        const pending = deps.store.get().pending.length;
        if (pending > 0) deps.engine.replayPending();
        return ok2(res, {
          notify_paused: deps.store.get().notify_paused === true,
          pending
        });
      }
      if (method === "GET" && path === "/notify") {
        return ok2(res, { paused: deps.store.get().notify_paused === true });
      }
      if (method === "POST" && path === "/notify") {
        const body = await readJsonBody2(req);
        const paused = body.paused === true;
        await deps.store.mutate((state) => {
          state.notify_paused = paused;
        });
        deps.log(`msg9 daemon: notify ${paused ? "paused" : "resumed"}`);
        return ok2(res, { paused });
      }
      if (method === "GET" && path === "/events") {
        const state = deps.store.get();
        return ok2(res, {
          notify_paused: state.notify_paused === true,
          inboxes: deps.engine.status(),
          instances: deps.registry.list().map((instance) => ({
            instance_id: instance.instance_id,
            pid: instance.pid,
            dsh_home: instance.dsh_home,
            port: instance.port,
            protocol: instance.protocol,
            workspaces: instance.workspaces,
            registered_at: instance.registered_at,
            last_seen_ago_s: Math.round((Date.now() - instance.last_seen) / 1e3)
          })),
          pending: state.pending.map((item) => ({
            id: item.id,
            project_key: item.project_key,
            instance_id: item.instance_id ?? null,
            messages: item.messages.length,
            mode: item.mode,
            downgraded: item.downgraded,
            attempts: item.attempts,
            enqueued_at: item.enqueued_at
          }))
        });
      }
      return fail2(res, 404, "not-found", `no route for ${method} ${path}`);
    })().catch((error) => {
      fail2(res, 500, "internal", error?.message ?? String(error));
    });
  });
  const pruneTimer = setInterval(pruneStale, 6e4);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("control server did not bind a TCP port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => {
          clearInterval(pruneTimer);
          server.close(() => done());
        })
      });
    });
  });
}
function instance_id_redact(id) {
  return id.length <= 24 ? id : `${id.slice(0, 24)}\u2026`;
}

// src/host/daemon/main.ts
var DAEMON_PROTOCOL = 1;
async function daemonVersion() {
  try {
    const raw = await readFile5(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    return JSON.parse(raw).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
async function httpDeliver(target, body, timeoutMs) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/dsh-msg9/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-msg9-daemon-token": target.deliver_token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new DeliverHttpError(`deliver request failed: ${error?.message ?? String(error)}`, void 0, false);
  }
  if (response.status === 409) throw new DeliverHttpError("instance reports no live session", 409, true);
  if (!response.ok) throw new DeliverHttpError(`deliver answered HTTP ${response.status}`, response.status, false);
}
async function createDaemon(config = {}) {
  const home = config.home ?? daemonHome();
  const log = config.log ?? ((message) => console.log(message));
  const version = config.version ?? await daemonVersion();
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const token = randomUUID();
  const store = await openDaemonStore(home);
  const registry = createRegistry();
  const engineConfig = { ...defaultEngineConfig() };
  for (const key of Object.keys(engineConfig)) {
    const value = config[key];
    if (typeof value === "number") engineConfig[key] = value;
  }
  const engine = createEngine({
    store,
    registry,
    config: engineConfig,
    log,
    uuid: () => randomUUID(),
    now: () => Date.now(),
    listInbox: (apiUrl, apiKey, query) => listInbox(apiUrl, apiKey, query),
    issueWsTicket: (apiUrl, apiKey, signal) => issueWsTicket(apiUrl, apiKey, signal),
    wsConnect: (url, options) => connectWebSocket(url, options),
    deliverPost: config.deliverPost ?? httpDeliver,
    sleep: defaultSleep,
    enumerate: () => enumerateIdentities(log)
  });
  const server = await startControlServer({
    store,
    registry,
    engine,
    token,
    version,
    protocol: DAEMON_PROTOCOL,
    startedAt,
    log
  });
  await engine.start();
  await writeDaemonInfo({ pid: process.pid, port: server.port, token, started_at: startedAt, version, protocol: DAEMON_PROTOCOL }, home);
  log(`msg9 daemon: ${Object.keys(store.get().inboxes).length} known inbox(es); control on 127.0.0.1:${server.port}`);
  return {
    port: server.port,
    token,
    home,
    engine,
    store,
    registry,
    async close() {
      await engine.stop();
      await server.close();
      await removeDaemonInfo(process.pid, home);
    }
  };
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}
async function runDaemon() {
  const home = daemonHome();
  const log = (message) => console.log(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`);
  const existing = await readDaemonInfo(home);
  if (existing && pidAlive(existing.pid) && await healthy(existing.port)) {
    console.log(`msg9 daemon already running (pid ${existing.pid}, port ${existing.port})`);
    return 0;
  }
  await mkdir4(home, { recursive: true });
  const lockPath = join6(home, "daemon.start.lock");
  for (let attempt = 0; ; attempt += 1) {
    let handle;
    try {
      handle = await open2(lockPath, "wx", 384);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
      await handle.close();
      break;
    } catch (error) {
      await handle?.close().catch(() => {
      });
      if (error.code !== "EEXIST") throw error;
      if (await isStalePidFile(lockPath)) {
        await rm4(lockPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const winner = await readDaemonInfo(home);
      if (winner && winner.pid !== process.pid && await healthy(winner.port)) {
        console.log(`msg9 daemon already running (pid ${winner.pid}, port ${winner.port})`);
        return 0;
      }
      if (attempt >= 40) {
        console.error("msg9 daemon: another instance holds the startup lock but never came up");
        return 1;
      }
    }
  }
  let daemon;
  try {
    daemon = await createDaemon({ home, log });
  } finally {
    await rm4(lockPath, { force: true });
  }
  log(`msg9 watcher daemon up on 127.0.0.1:${daemon.port} (pid ${process.pid})`);
  return new Promise((resolve) => {
    const shutdown = (signal) => {
      log(`msg9 daemon: ${signal} received; shutting down`);
      void daemon.close().then(() => resolve(0), () => resolve(0));
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
}

// src/host/daemonclient.ts
function defaultSleep3(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function defaultDshHome() {
  return process.env.DSH_HOME || join7(homedir4(), ".dsh");
}
function daemonInstanceId(dshHome) {
  return `dsh-${createHash5("sha256").update(dshHome).digest("hex").slice(0, 16)}`;
}
async function healthy2(info) {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/healthz`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}
function createDaemonClient(deps) {
  const home = deps.home ?? daemonHome();
  const log = deps.log;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep3;
  const dshHome = deps.dshHome ?? defaultDshHome;
  const bootTimeoutMs = deps.bootTimeoutMs ?? 1e4;
  const heartbeatMs = deps.heartbeatMs ?? 45e3;
  const deliverToken = randomUUID2();
  const instanceId = daemonInstanceId(dshHome());
  let daemon;
  let heartbeatTimer;
  let heartbeating = false;
  async function post(path, body) {
    if (!daemon) throw new Error("no daemon connection");
    const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5e3)
    });
    let data;
    try {
      data = await response.json();
    } catch {
    }
    return { status: response.status, data };
  }
  async function register() {
    const workspaces = await deps.getWorkspaces();
    const { status, data } = await post("/register", {
      instance_id: instanceId,
      pid: process.pid,
      dsh_home: dshHome(),
      port: deps.getPort(),
      deliver_token: deliverToken,
      protocol: DAEMON_PROTOCOL,
      workspaces
    });
    if (status === 200) {
      log(`msg9 daemon: registered as ${instanceId} (${workspaces.length} workspace(s))`);
      return true;
    }
    const detail = data && typeof data.error === "object" && data.error !== null ? String(data.error.message ?? "") : "";
    log(`msg9 daemon: register answered HTTP ${status}${detail ? ` (${detail})` : ""}`);
    return false;
  }
  async function findDaemon() {
    const info = await readDaemonInfo(home);
    if (!info) return void 0;
    if (!await healthy2(info)) return void 0;
    return info;
  }
  function spawnDaemon(binPath) {
    if (deps.spawnDaemon) {
      deps.spawnDaemon(binPath);
      return;
    }
    const logPath = join7(home, "daemon.log");
    try {
      mkdirSync(home, { recursive: true });
      const logFd = openSync(logPath, "a");
      try {
        spawn(process.execPath, [binPath], { detached: true, stdio: ["ignore", logFd, logFd] }).unref();
      } finally {
        closeSync(logFd);
      }
    } catch (error) {
      log(`msg9 daemon: spawn failed: ${error?.message ?? String(error)}`);
    }
  }
  async function ensureDaemon() {
    const existing = await findDaemon();
    if (existing) return existing;
    const binPath = deps.binPath ?? fileURLToPath2(new URL("../bin/msg9-watcher-daemon.mjs", import.meta.url));
    spawnDaemon(binPath);
    const deadline = now() + bootTimeoutMs;
    while (now() < deadline) {
      await sleep(200);
      const info = await findDaemon();
      if (info) return info;
    }
    return void 0;
  }
  async function heartbeat() {
    if (heartbeating) return;
    heartbeating = true;
    try {
      const workspaces = await deps.getWorkspaces();
      const port = deps.getPort();
      const { status } = await post("/heartbeat", {
        instance_id: instanceId,
        ...port > 0 ? { port } : {},
        workspaces
      });
      if (status === 404) {
        log("msg9 daemon: heartbeat answered unknown-instance; re-registering");
        await register();
      }
    } catch {
      try {
        const info = await ensureDaemon();
        if (info) {
          daemon = info;
          await register();
        }
      } catch (error) {
        log(`msg9 daemon: reconnect failed: ${error?.message ?? String(error)}`);
      }
    } finally {
      heartbeating = false;
    }
  }
  return {
    deliverToken,
    instanceId,
    async start() {
      try {
        const info = await ensureDaemon();
        if (!info) {
          log("msg9 daemon: no healthy daemon came up in time");
          return false;
        }
        daemon = info;
        if (!await register()) return false;
        heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs);
        return true;
      } catch (error) {
        log(`msg9 daemon: unavailable (${error?.message ?? String(error)})`);
        return false;
      }
    },
    async stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = void 0;
    }
  };
}

// src/host/ledger.ts
import { mkdir as mkdir5, readFile as readFile6, rename as rename3, writeFile as writeFile4 } from "node:fs/promises";
import { dirname as dirname3, join as join8 } from "node:path";
var LEDGER_SCHEMA_VERSION = 1;
var DEFAULT_CONSUMER = "dsh-msg9-kit";
var DEFAULT_LAG_TOPUP_MS = 5 * 6e4;
var SEEN_RING_CAP = 200;
function spoolDir() {
  return join8(msg9Home(), "spool");
}
function ledgerPath(address, spool = spoolDir()) {
  return join8(spool, `${address}.jsonl`);
}
function consumerCursorPath(address, consumer = DEFAULT_CONSUMER, spool = spoolDir()) {
  assertConsumerName(consumer);
  return join8(spool, `${address}.${consumer}.cursor`);
}
function assertConsumerName(consumer) {
  if (!consumer || consumer.includes(".") || consumer.includes("/") || consumer.includes("\\")) {
    throw new Error(
      `msg9 ledger: consumer name must be non-empty and free of "." / "/" (the platform splits it out of <address>.<consumer>.cursor): ${JSON.stringify(consumer)}`
    );
  }
}
function parseLedgerLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return void 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
  const row = parsed;
  const messageId = row.message_id;
  if (typeof messageId !== "string" || messageId === "") return void 0;
  const receivedAt = typeof row.received_at === "string" ? row.received_at : "";
  return {
    v: typeof row.v === "number" ? row.v : 0,
    type: typeof row.type === "string" ? row.type : "",
    address: typeof row.address === "string" ? row.address : "",
    message_id: messageId,
    received_at: receivedAt,
    received_ms: Date.parse(receivedAt)
  };
}
function parseLedgerLines(text) {
  const events = [];
  let blank_lines = 0;
  let bad_lines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      blank_lines += 1;
      continue;
    }
    const event = parseLedgerLine(line);
    if (!event) {
      bad_lines += 1;
      continue;
    }
    events.push(event);
  }
  return { events, blank_lines, bad_lines };
}
async function readLedger(path) {
  let raw;
  try {
    raw = await readFile6(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], blank_lines: 0, bad_lines: 0 };
    throw error;
  }
  return parseLedgerLines(raw);
}
async function readConsumerCursor(path) {
  try {
    const raw = await readFile6(path, "utf8");
    const anchor = raw.trim();
    return anchor || void 0;
  } catch {
    return void 0;
  }
}
async function writeConsumerCursor(path, messageId) {
  const anchor = messageId.trim();
  if (!anchor) throw new Error("msg9 ledger: refusing to write an empty consumer cursor");
  await mkdir5(dirname3(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile4(temp, `${anchor}
`, { mode: 384 });
  await rename3(temp, path);
}
function selectFreshEvents(events, options = {}) {
  const anchor = options.anchor;
  let anchorIndex;
  if (anchor) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.message_id === anchor) {
        anchorIndex = index;
        break;
      }
    }
  }
  const candidates = anchorIndex === void 0 ? [...events] : events.slice(anchorIndex + 1);
  const seen = new Set(options.seen ?? []);
  const fresh = [];
  for (const event of candidates) {
    if (seen.has(event.message_id)) continue;
    seen.add(event.message_id);
    fresh.push(event);
  }
  fresh.sort((a, b) => (Number.isFinite(a.received_ms) ? a.received_ms : 0) - (Number.isFinite(b.received_ms) ? b.received_ms : 0));
  const last = candidates[candidates.length - 1];
  return {
    fresh,
    ...anchor === void 0 ? {} : { anchor },
    anchor_index: anchorIndex,
    anchor_found: anchor !== void 0 && anchorIndex !== void 0,
    unconsumed: candidates.length,
    duplicates: candidates.length - fresh.length,
    next_anchor: last?.message_id ?? anchor
  };
}
function mergeSeenIds(existing, acked, cap = SEEN_RING_CAP) {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const id of acked) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
function computeCursorLag(events, selection, nowMs) {
  const anchor = selection.anchor;
  if (anchor === void 0) return void 0;
  if (!selection.anchor_found) {
    return { anchor_message_id: anchor, anchor_found: false, unconsumed: selection.unconsumed, lag_seconds: 0 };
  }
  const anchorEvent = selection.anchor_index === void 0 ? void 0 : events[selection.anchor_index];
  const unconsumedEvents = selection.unconsumed > 0 ? events.slice(events.length - selection.unconsumed) : [];
  const oldestUnconsumed = unconsumedEvents.reduce(
    (oldest, event) => oldest === void 0 || Number.isFinite(event.received_ms) && event.received_ms < oldest.received_ms ? event : oldest,
    void 0
  );
  const lagMs = oldestUnconsumed && Number.isFinite(oldestUnconsumed.received_ms) ? Math.max(0, nowMs - oldestUnconsumed.received_ms) : 0;
  const cursorAgeMs = anchorEvent && Number.isFinite(anchorEvent.received_ms) ? Math.max(0, nowMs - anchorEvent.received_ms) : void 0;
  return {
    anchor_message_id: anchor,
    anchor_found: true,
    unconsumed: selection.unconsumed,
    lag_seconds: Math.round(lagMs / 1e3),
    ...cursorAgeMs === void 0 ? {} : { cursor_age_seconds: Math.round(cursorAgeMs / 1e3) }
  };
}
function decideTopUp(input) {
  if (input.force) return { topUp: true, reason: "explicit" };
  if (!input.hasCursor) {
    return { topUp: false, bootstrap: true, detail: "no consumer cursor yet: establish the baseline, never announce history" };
  }
  if (!input.anchorFound) return { topUp: true, reason: "anchor-lost", detail: "the cursor anchor is no longer in the ledger" };
  if (input.daemon === "stalled" || input.daemon === "dead") {
    return { topUp: true, reason: "daemon-down", detail: `platform daemon reports ${input.daemon}` };
  }
  const threshold = input.lagThresholdMs ?? DEFAULT_LAG_TOPUP_MS;
  if (threshold > 0 && typeof input.lagSeconds === "number" && Number.isFinite(input.lagSeconds) && input.lagSeconds * 1e3 > threshold) {
    return { topUp: true, reason: "lag", detail: `cursor lag ${input.lagSeconds}s > ${Math.round(threshold / 1e3)}s` };
  }
  return { topUp: false };
}
function selectTopUpMessages(messages, seen = []) {
  const known = new Set(seen);
  const picked = [];
  for (const message of messages) {
    const id = message?.message_id;
    if (typeof id !== "string" || id === "" || known.has(id)) continue;
    known.add(id);
    picked.push(message);
  }
  return picked;
}
function createLedgerConsumer(deps) {
  const consumer = deps.consumer ?? DEFAULT_CONSUMER;
  const spool = deps.spoolDir ?? spoolDir();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {
  });
  const lagThresholdMs = deps.lagThresholdMs ?? DEFAULT_LAG_TOPUP_MS;
  const ledger = ledgerPath(deps.address, spool);
  const cursorFile = consumerCursorPath(deps.address, consumer, spool);
  let seen = [];
  return {
    async pollOnce(options = {}) {
      const parsed = await readLedger(ledger);
      const anchor = await readConsumerCursor(cursorFile);
      const baseline = anchor === void 0;
      const selection = selectFreshEvents(parsed.events, { ...anchor === void 0 ? {} : { anchor }, seen });
      const lag = baseline ? void 0 : computeCursorLag(parsed.events, selection, now());
      let daemon = "unknown";
      if (deps.daemonHealth) {
        try {
          daemon = await deps.daemonHealth();
        } catch (error) {
          log(`msg9 ledger: daemon health unavailable (${error?.message ?? String(error)})`);
        }
      }
      const topUp = decideTopUp({
        hasCursor: !baseline,
        anchorFound: selection.anchor_found,
        ...lag === void 0 ? {} : { lagSeconds: lag.lag_seconds },
        lagThresholdMs,
        daemon,
        ...options.force === void 0 ? {} : { force: options.force }
      });
      if (parsed.bad_lines > 0) log(`msg9 ledger: skipped ${parsed.bad_lines} bad line(s) in ${ledger}`);
      let topUpMessages = [];
      if (topUp.topUp && deps.fetchUnread) {
        try {
          const exclude = new Set(seen);
          if (anchor !== void 0) exclude.add(anchor);
          for (const event of selection.fresh) exclude.add(event.message_id);
          topUpMessages = selectTopUpMessages(await deps.fetchUnread(), exclude);
          log(`msg9 ledger: top-up (${topUp.reason}) fetched ${topUpMessages.length} unconfirmed mail(s)`);
        } catch (error) {
          log(`msg9 ledger: top-up failed (${error?.message ?? String(error)}); ledger batch still delivered`);
        }
      }
      const fresh = baseline ? [] : selection.fresh;
      let committed = false;
      const ackedIds = [...selection.fresh.map((event) => event.message_id), ...topUpMessages.map((message) => message.message_id)];
      return {
        fresh,
        baseline,
        top_up: topUp,
        top_up_messages: topUpMessages,
        ...lag === void 0 ? {} : { lag },
        duplicates: selection.duplicates,
        bad_lines: parsed.bad_lines,
        ledger_path: ledger,
        cursor_path: cursorFile,
        async commit() {
          if (committed) return;
          committed = true;
          seen = mergeSeenIds(seen, ackedIds);
          if (selection.next_anchor) await writeConsumerCursor(cursorFile, selection.next_anchor);
        }
      };
    }
  };
}
async function readConsumerLag(address, consumer = DEFAULT_CONSUMER, options = {}) {
  const spool = options.spoolDir ?? spoolDir();
  const parsed = await readLedger(ledgerPath(address, spool));
  const anchor = await readConsumerCursor(consumerCursorPath(address, consumer, spool));
  if (anchor === void 0) return void 0;
  const selection = selectFreshEvents(parsed.events, { anchor });
  return computeCursorLag(parsed.events, selection, options.now ?? Date.now());
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
  const daemonDelivery = {};
  bridgeDeps.deliver = {
    token: () => daemonDelivery.token,
    handle: async (body) => {
      if (!daemonDelivery.handle) {
        throw new BridgeError(409, "no-live-session", "this instance has no session service yet");
      }
      return daemonDelivery.handle(body);
    }
  };
  let webServerRef;
  const bridge = createMsg9Bridge(bridgeDeps);
  ctx.inject(["webServer"], (child) => {
    const server = child.webServer;
    if (!server) return;
    webServerRef = server;
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
    startWatcher(
      child,
      agents,
      () => registry,
      (message) => log.info(message),
      events,
      reconcileUnread,
      () => webServerRef?.port ?? 0,
      daemonDelivery
    );
    log.info(`msg9 new-mail watcher started (daemon-first, in-process fallback every ${WATCH_POLL_MS / 1e3}s)`);
  });
}
function startWatcher(ctx, agents, getRegistry, log, events, reconcileUnread, getPort, daemonDelivery) {
  const rt = createWatchRuntime();
  const deps = {
    // state.json 只存热状态：watcher 的 loadState 经 resolveCredentials 回填
    // 身份与密钥（含惰性迁移），watch.ts 逻辑不变。
    loadState: async () => {
      const state = await loadState();
      await Promise.all(Object.keys(state.workspaces).map(async (key) => {
        const inbox = state.workspaces[key];
        if (!inbox.api_key || !inbox.api_url || !inbox.address) {
          const resolved = await resolveCredentials(key, { log });
          if (resolved) state.workspaces[key] = resolved;
        }
      }));
      return state;
    },
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
    uuid: () => randomUUID3(),
    now: () => Date.now(),
    log
  };
  daemonDelivery.handle = async (body) => {
    let key;
    let inbox;
    const state = await deps.loadState();
    for (const [candidate, row] of Object.entries(state.workspaces)) {
      const resolved = await resolveCredentials(candidate, { log });
      const projectKey = row.project_key ?? await deriveProjectKey({ title: row.title, path: row.path }).catch(() => void 0);
      if (projectKey === body.project_key || resolved && resolved.address === body.inbox) {
        key = candidate;
        inbox = resolved;
        if (projectKey === body.project_key) break;
      }
    }
    if (!key || !inbox) {
      throw new BridgeError(404, "unknown-project", `no workspace of this instance serves ${body.project_key}`);
    }
    const delivered = await deliverDaemonBatch({
      resolveAgent: (workspace) => deps.resolveAgent(workspace),
      resolveAgentById: deps.resolveAgentById,
      setWatchState,
      uuid: () => randomUUID3(),
      log
    }, key, inbox, body);
    if (!delivered) {
      throw new BridgeError(409, "no-live-session", `no live session for ${body.project_key}; the daemon will retry`);
    }
    deps.onEvent?.("mail");
    return { delivered: body.messages.length, mode: body.mode };
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
      const startInProcessWatcher = () => {
        if (streamUnsupported) {
          startPolling();
        } else {
          void reconcile();
          reconcileTimer = setInterval(() => void reconcile(), 6e4);
        }
      };
      let daemonClient;
      let disposed = false;
      if (process.env.MSG9_WATCH_DAEMON !== "0") {
        daemonClient = createDaemonClient({
          getPort,
          getWorkspaces: async () => {
            const state = await loadState();
            const rows = [];
            for (const [key, row] of Object.entries(state.workspaces)) {
              const projectKey = row.project_key ?? await deriveProjectKey({ title: row.title, path: row.path }).catch(() => key);
              rows.push({ project_key: projectKey, key, title: row.title, path: row.path });
            }
            return rows;
          },
          log
        });
        daemonDelivery.token = daemonClient.deliverToken;
      }
      void (async () => {
        const connected = daemonClient ? await daemonClient.start() : false;
        if (disposed) {
          if (connected) await daemonClient?.stop();
          return;
        }
        if (connected) {
          log("msg9 watcher daemon connected; this instance is a delivery target only");
        } else {
          if (daemonClient) log("msg9 watcher daemon unavailable; falling back to the in-process watcher");
          daemonClient = void 0;
          daemonDelivery.token = void 0;
          startInProcessWatcher();
        }
      })();
      return () => {
        disposed = true;
        master.abort();
        stopLoops();
        if (pollTimer) clearInterval(pollTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
        if (daemonClient) {
          daemonDelivery.token = void 0;
          void daemonClient.stop();
        }
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
      if (!state.workspaces[workspace.key]) return;
      const inbox = await resolveCredentials(workspace.key, { log });
      if (!inbox) return;
      const siblings = [];
      for (const key of Object.keys(state.workspaces)) {
        if (key === workspace.key) continue;
        const resolved = await resolveCredentials(key, { log });
        if (resolved && resolved.address !== inbox.address) siblings.push(resolved);
      }
      const roster = siblings.length > 0 ? L(
        "\n\u672C\u5B9E\u4F8B\u7684\u5176\u4ED6 workspace \u90AE\u7BB1\uFF08\u8DE8\u9879\u76EE\u534F\u4F5C\u5BF9\u8C61\uFF09\uFF1A\n{list}\n\u9700\u8981\u540C\u6B65\u8FDB\u5C55\u3001\u7ED3\u8BBA\u6216\u8BF7\u6C42\u534F\u52A9\u65F6\uFF0C\u7528 msg9_send \u76F4\u63A5\u53D1\u7ED9\u5B83\u4EEC\u3002",
        "\nSibling inboxes of this instance (your collaborators):\n{list}\nTo sync progress, conclusions or requests, msg9_send them directly.",
        { list: siblings.map((row) => `\xB7 ${row.title}\uFF08${row.path}\uFF09\uFF1A${row.address}`).join("\n") }
      ) : "";
      agent.inject(pluginNotice(
        randomUUID3(),
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
  BridgeError,
  DAEMON_PROTOCOL,
  DEFAULT_CONSUMER,
  DEFAULT_LAG_TOPUP_MS,
  DeliverHttpError,
  FrameParser,
  HARNESS_AGENT_NAMES,
  INSTANCE_STALE_MS,
  LEDGER_SCHEMA_VERSION,
  OPCODES,
  SEEN_RING_CAP,
  StreamUnsupportedError,
  TenantKeyAmbiguousError,
  WakeBudget,
  WsConnection,
  WsError,
  acceptArchivedBatch,
  apply,
  assertConsumerName,
  backoffMs,
  computeCursorLag,
  computeFlushAt,
  computeUnread,
  connectWebSocket,
  consumerCursorPath,
  createBridgeEventBus,
  createDaemon,
  createDaemonClient,
  createEngine,
  createLedgerConsumer,
  createMsg9Bridge,
  createNonReentrant,
  createRegistry,
  createWatchRuntime,
  credentialsMigrated,
  daemonHome,
  daemonInstanceId,
  decideTopUp,
  defaultBridgeDeps,
  defaultEngineConfig,
  deliverDaemonBatch,
  derivePodLabel,
  deriveProjectKey,
  encodeFrame,
  ensureCredentialsMigrated,
  ensureInbox,
  enumerateIdentities,
  flushBatch,
  harnessAgentName,
  inject,
  invalidateUnreadCache,
  isStalePidFile,
  isTrustedRequest,
  knownMessageIds,
  ledgerPath,
  listWorkspaces,
  loadState,
  matchWorkspaceByPath,
  mergeDeliveredIds,
  mergeSeenIds,
  migrateInbox,
  msg9Home,
  name,
  openDaemonStore,
  openPod,
  orgKeyPath,
  ownerContext,
  parseLedgerLine,
  parseLedgerLines,
  pluginNotice,
  podState,
  pollOnce,
  projectYamlPath,
  readConsumerCursor,
  readConsumerLag,
  readDaemonInfo,
  readLedger,
  readOrgKey,
  readProjectCredentials,
  readSigningSeed,
  readTenantKey,
  readTenantKeyWithSource,
  removeDaemonInfo,
  removeOrgKey,
  renderMailNotice,
  resolveCredentials,
  resolveInbox,
  resolveOwner,
  resolveWorkspace,
  runDaemon,
  saveOwner,
  selectFreshEvents,
  selectOrphanPending,
  selectTopUpMessages,
  setWorkspaceRegistry,
  signingYamlPath,
  spoolDir,
  stateFilePath,
  streamInboxLoop,
  tenantKeyPath,
  unseenMessages,
  upsertWorkspaceInbox,
  withStateLock,
  writeConsumerCursor,
  writeDaemonInfo,
  writeOrgKey,
  writeTenantKey,
  wsUrlFor
};
