const API_BASE_URL = "https://dis-pro-liart.vercel.app";
const APP_VERSION = chrome.runtime.getManifest().version;
const POLL_ALARM = "dispro-process-poll";
const POLL_INTERVAL_MINUTES = 0.5;
const MAX_OUTPUT_BYTES = 128 * 1024;
const SUPPORTED_WORKLOADS = [
  "hash.compute",
  "proof.verify",
  "echo.test",
  "data.transform.basic",
  "dispro.storage.anchor",
  "dispro.transaction.anchor",
  "dispro.app.update"
];

let polling = false;

chrome.runtime.onInstalled.addListener(async () => {
  const { status } = await chrome.storage.session.get("status");
  if (!status) await setStatus(defaultStatus());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollOnce().catch(recordError);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "auth:load":
      return loadStoredAuth();
    case "auth:request-code":
      return requestVerificationCode(message.email);
    case "auth:verify":
      return verifyEmail(message.email, message.code);
    case "auth:clear":
      return clearAuth();
    case "process:start":
      return startProcessing();
    case "process:stop":
      return stopProcessing();
    case "process:status":
      return getStatus();
    case "billing:status":
      return withSession((auth) => apiFetch("/billing/status", { token: auth.sessionToken }));
    case "billing:setup":
      return withSession(async (auth) => {
        const result = await apiFetch("/billing/setup-session", { method: "POST", token: auth.sessionToken, body: {} });
        if (result.url) await chrome.tabs.create({ url: result.url });
        return result;
      });
    case "wallet:summary":
      return withSession((auth) => apiFetch("/wallet", { token: auth.sessionToken }));
    case "wallet:onboarding":
      return withSession(async (auth) => {
        const result = await apiFetch("/payouts/connect/onboarding", { method: "POST", token: auth.sessionToken, body: {} });
        if (result.url) await chrome.tabs.create({ url: result.url });
        return result;
      });
    case "use:create-order":
      return withSession((auth) =>
        apiFetch("/use/orders", {
          method: "POST",
          token: auth.useApiKey,
          headers: { "idempotency-key": crypto.randomUUID() },
          body: normalizeUseOrder(message.input)
        })
      );
    case "use:get-order":
      return withSession((auth) => apiFetch(`/use/orders/${encodeURIComponent(message.orderId)}`, { token: auth.useApiKey }));
    case "use:get-result":
      return withSession((auth) => apiFetch(`/use/orders/${encodeURIComponent(message.orderId)}/result`, { token: auth.useApiKey }));
    case "update:install":
      return openUpdate();
    default:
      throw new Error("Unsupported Dispro extension action.");
  }
}

async function requestVerificationCode(email) {
  return apiFetch("/auth/request-code", { method: "POST", body: { email: normalizeEmail(email) } });
}

async function verifyEmail(email, code) {
  const session = await apiFetch("/auth/verify", {
    method: "POST",
    body: { email: normalizeEmail(email), code: normalizeVerificationCode(code) }
  });
  const processKey = await apiFetch("/auth/api-keys", {
    method: "POST",
    token: session.sessionToken,
    body: { label: "process-chrome-v1", purpose: "process" }
  });
  const useKey = await apiFetch("/auth/api-keys", {
    method: "POST",
    token: session.sessionToken,
    body: { label: "use-chrome-v1", purpose: "use" }
  });
  if (!processKey.secret || !useKey.secret) throw new Error("Could not create this browser session's API keys.");

  const auth = { sessionToken: session.sessionToken, processApiKey: processKey.secret, useApiKey: useKey.secret, user: session.user };
  await chrome.storage.session.set({ auth });
  await setStatus({ ...defaultStatus(), connected: true, message: `Signed in as ${session.user.email}` });
  return { signedIn: true, user: session.user };
}

async function loadStoredAuth() {
  const { auth } = await chrome.storage.session.get("auth");
  if (!auth) return { signedIn: false };
  try {
    const me = await apiFetch("/auth/me", { token: auth.processApiKey });
    await setStatus({ ...(await getStatus()), connected: true, message: `Signed in as ${me.user.email}` });
    return { signedIn: true, user: me.user };
  } catch {
    await clearAuth();
    return { signedIn: false };
  }
}

async function clearAuth() {
  await stopProcessing().catch(() => undefined);
  await chrome.storage.session.clear();
  await setStatus({ ...defaultStatus(), message: "Signed out. Verify your email again to use Dispro." });
  return { ok: true };
}

async function startProcessing() {
  const auth = await requireAuth();
  const publicKey = await apiFetch("/process/signing-key");
  const nodeKeyPair = await getOrCreateNodeKeyPair();
  const registration = await apiFetch("/process/register", {
    method: "POST",
    token: auth.processApiKey,
    body: await createNodeRegistration(nodeKeyPair.publicKeyPem)
  });
  await chrome.storage.session.set({ publicKey: publicKey.publicKey, node: registration.node, nodeKeyPair });
  await setStatus({ ...(await getStatus()), mode: "waiting", connected: true, message: "Waiting for signed browser jobs", ...earningsStatus(registration.earnings) });
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
  await pollOnce();
  return getStatus();
}

async function stopProcessing() {
  await chrome.alarms.clear(POLL_ALARM);
  const { auth, node } = await chrome.storage.session.get(["auth", "node"]);
  if (auth?.processApiKey && node?.id) {
    await apiFetch("/process/heartbeat", {
      method: "POST",
      token: auth.processApiKey,
      body: { nodeId: node.id, mode: "stopped" }
    }).catch(() => undefined);
  }
  await setStatus({ ...(await getStatus()), mode: "stopped", message: "Stopped" });
  return getStatus();
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const { auth, node, publicKey, nodeKeyPair } = await chrome.storage.session.get(["auth", "node", "publicKey", "nodeKeyPair"]);
    if (!auth?.processApiKey || !node?.id || !publicKey || !nodeKeyPair) return;
    const lease = await apiFetch("/process/lease", {
      method: "POST",
      token: auth.processApiKey,
      body: { nodeId: node.id, supportedWorkloads: SUPPORTED_WORKLOADS }
    });
    if (lease.status === "idle") {
      await setStatus({ ...(await getStatus()), mode: "waiting", message: "Waiting for signed browser jobs" });
      return;
    }

    await setStatus({ ...(await getStatus()), mode: "running", message: `Running ${lease.job.workload}` });
    const execution = await executeSignedJob(lease.job, publicKey);
    const signedResult = await createResultSignature(node.id, lease.job, execution, nodeKeyPair.privateKeyJwk, nodeKeyPair.publicKeyPem);
    const response = await apiFetch("/process/results", {
      method: "POST",
      token: auth.processApiKey,
      body: {
        nodeId: node.id,
        jobId: lease.job.jobId,
        status: execution.status,
        resultHash: execution.resultHash,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.metrics.durationMs,
        metrics: execution.metrics,
        errorMessage: execution.errorMessage,
        ...signedResult
      }
    });
    const updateMessage = await applySpecialJob(lease.job, execution);
    await setStatus({
      ...(await getStatus()),
      mode: "submitted",
      message: updateMessage ?? `Submitted ${lease.job.jobId}`,
      ...earningsStatus(response.earnings)
    });
  } catch (error) {
    await recordError(error);
  } finally {
    polling = false;
  }
}

async function executeSignedJob(envelope, publicKeyPem) {
  const startedAt = Date.now();
  if (!(await verifySignedEnvelope(envelope, publicKeyPem))) return rejected("Invalid job signature.");
  if (new Date(envelope.expiresAt).getTime() <= Date.now()) return rejected("Job lease expired.");
  if (!SUPPORTED_WORKLOADS.includes(envelope.workload)) return rejected(`Unsupported workload: ${envelope.workload}`);
  try {
    const output = await runWorkload(envelope.workload, envelope.inputRef ?? {});
    const stdout = JSON.stringify(output);
    if (new TextEncoder().encode(stdout).byteLength > MAX_OUTPUT_BYTES) throw new Error("Runner output exceeds the browser safety limit.");
    return completed(stdout, envelope.inputRef ?? {}, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(message, envelope.inputRef ?? {}, startedAt);
  }
}

async function runWorkload(workload, inputRef) {
  if (workload === "echo.test") return { echo: inputRef };
  if (workload === "hash.compute") {
    const value = inputRef.text ?? inputRef.payload ?? stableStringify(inputRef);
    return { algorithm: "sha256", hash: await sha256(typeof value === "string" ? value : stableStringify(value)) };
  }
  if (workload === "proof.verify") {
    const payload = inputRef.payload ?? "";
    const actualHash = await sha256(typeof payload === "string" ? payload : stableStringify(payload));
    return { verified: typeof inputRef.expectedHash === "string" && inputRef.expectedHash === actualHash, actualHash };
  }
  if (workload === "data.transform.basic") {
    const records = Array.isArray(inputRef.records) ? inputRef.records : [];
    return { records: records.map(normalizeRecord) };
  }
  if (workload === "dispro.storage.anchor" || workload === "dispro.transaction.anchor") {
    const encryptedJson = String(inputRef.encryptedJson ?? "");
    const payloadHash = await sha256(encryptedJson);
    return {
      status: "anchored",
      provider: inputRef.provider ?? "local",
      cid: `${inputRef.provider ?? "local"}-${payloadHash.slice(0, 46)}`,
      payloadHash,
      contractHash: await sha256(`${inputRef.recordType ?? "record"}:${payloadHash}`)
    };
  }
  if (workload === "dispro.app.update") return { updateAvailable: true, manifest: isObject(inputRef.manifest) ? inputRef.manifest : {} };
  throw new Error(`Unsupported workload: ${workload}`);
}

async function applySpecialJob(job, execution) {
  if (job.workload !== "dispro.app.update" || execution.status !== "completed") return undefined;
  const result = parseJson(execution.stdout);
  const manifest = isObject(result.manifest) ? result.manifest : {};
  await setStatus({
    ...(await getStatus()),
    update: { ...manifest, receivedAt: new Date().toISOString(), sourceJobId: job.jobId },
    message: `Chrome update available: ${manifest.version ?? "unknown"}`
  });
  return `Chrome update available: ${manifest.version ?? "unknown"}`;
}

async function openUpdate() {
  const { status } = await chrome.storage.session.get("status");
  const update = status?.update;
  const destination = update?.webStoreUrl || update?.downloadUrl;
  if (!destination || !/^https:\/\//.test(destination)) throw new Error("No signed Chrome update is waiting.");
  await chrome.tabs.create({ url: destination });
  return { opened: true };
}

async function createNodeRegistration(nodePublicKey) {
  const machineId = await getMachineId();
  const cpuCores = Math.max(1, navigator.hardwareConcurrency ?? 2);
  const memoryGb = Math.max(1, navigator.deviceMemory ?? 4);
  return {
    machineId,
    deviceName: "Chrome Process Extension",
    os: navigator.userAgent.slice(0, 240),
    appVersion: APP_VERSION,
    cpuCores,
    memoryGb,
    supportedWorkloads: SUPPORTED_WORKLOADS,
    deviceClass: cpuCores >= 8 || memoryGb >= 16 ? "desktop" : "laptop",
    benchmarkScores: { cpu: cpuCores * 100, hash: cpuCores * 100, memory: Math.round(memoryGb * 100) },
    bandwidthMbps: connectionMbps(),
    thermalState: "nominal",
    batteryState: "unknown",
    maxConcurrentJobs: 1,
    runnerFamily: "chrome-extension-process-v1",
    clusterWords: ["chrome-extension-process-v1", "browser", "hash", "proof", "data", "anchor"],
    nodePublicKey
  };
}

async function getMachineId() {
  const { machineId } = await chrome.storage.local.get("machineId");
  if (machineId) return machineId;
  const created = `chrome-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ machineId: created });
  return created;
}

async function getOrCreateNodeKeyPair() {
  const { nodeKeyPair } = await chrome.storage.session.get("nodeKeyPair");
  if (nodeKeyPair?.privateKeyJwk && nodeKeyPair?.publicKeyPem) return nodeKeyPair;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKeyPem = toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
  const created = { privateKeyJwk, publicKeyPem };
  await chrome.storage.session.set({ nodeKeyPair: created });
  return created;
}

async function createResultSignature(nodeId, job, execution, privateKeyJwk, nodePublicKey) {
  const resultNonce = `rnonce_${await sha256(`${job.jobId}:${job.nonce}:${execution.resultHash}:${Date.now()}`)}`;
  const privateKey = await crypto.subtle.importKey("jwk", privateKeyJwk, { name: "Ed25519" }, false, ["sign"]);
  const payload = { nodeId, jobId: job.jobId, resultHash: execution.resultHash, status: execution.status, resultNonce };
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(stableStringify(payload)));
  return { resultNonce, nodePublicKey, nodeSignature: bytesToBase64Url(new Uint8Array(signature)) };
}

async function verifySignedEnvelope(envelope, publicKeyPem) {
  try {
    const { signature, ...unsigned } = envelope;
    if (!signature) return false;
    const key = await crypto.subtle.importKey("spki", pemToArrayBuffer(publicKeyPem), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, base64UrlToBytes(signature), new TextEncoder().encode(stableStringify(unsigned)));
  } catch {
    return false;
  }
}

async function withSession(callback) {
  return callback(await requireAuth());
}

async function requireAuth() {
  const { auth } = await chrome.storage.session.get("auth");
  if (!auth?.sessionToken || !auth?.processApiKey || !auth?.useApiKey) throw new Error("Verify your email before using Dispro.");
  return auth;
}

async function apiFetch(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "omit"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? `API request failed with ${response.status}`);
  return payload;
}

function normalizeUseOrder(input) {
  const sourceUri = String(input?.sourceUri ?? "").trim();
  const contentHash = String(input?.contentHash ?? "").trim();
  const byteSize = Number.parseInt(String(input?.byteSize ?? "0"), 10);
  if (!sourceUri || !contentHash || contentHash.length < 8 || !Number.isFinite(byteSize) || byteSize <= 0) {
    throw new Error("A source URL/CID, content hash, and byte size are required.");
  }
  const output = {
    source: { kind: "url", uri: sourceUri, contentHash, byteSize },
    workload: String(input?.workload ?? "hash.compute").trim(),
    priority: "standard",
    verificationLevel: "standard"
  };
  const maxCharge = Number.parseInt(String(input?.maxChargeMicroYen ?? "0"), 10);
  if (Number.isFinite(maxCharge) && maxCharge > 0) output.maxChargeMicroYen = maxCharge;
  return output;
}

function completed(stdout, inputRef, startedAt) {
  return sha256(stdout).then((resultHash) => ({ status: "completed", resultHash, stdout, stderr: "", metrics: metrics(inputRef, stdout, startedAt) }));
}

function failed(message, inputRef, startedAt) {
  return sha256(message).then((resultHash) => ({ status: "failed", resultHash, stdout: "", stderr: "", errorMessage: message, metrics: metrics(inputRef, "", startedAt) }));
}

function rejected(message) {
  return failed(message, {}, Date.now()).then((result) => ({ ...result, status: "rejected" }));
}

function metrics(inputRef, stdout, startedAt) {
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(stableStringify(inputRef)).byteLength;
  const outputBytes = encoder.encode(stdout).byteLength;
  return {
    durationMs: Math.max(0, Date.now() - startedAt),
    inputBytes,
    outputBytes,
    computeUnits: Math.max(1, Math.ceil(inputBytes / 1_000_000)),
    runnerWorkUnits: Math.max(1, Math.ceil((inputBytes + outputBytes) / 1_000_000))
  };
}

function normalizeRecord(record) {
  if (!isObject(record)) return record;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key.trim(), typeof value === "string" ? value.trim() : value]));
}

function defaultStatus() {
  return { mode: "stopped", connected: false, processedJobs: 0, failedJobs: 0, verificationJobs: 0, provisionalMicroYen: 0, confirmedMicroYen: 0, update: null, message: "Not signed in" };
}

async function getStatus() {
  const { status } = await chrome.storage.session.get("status");
  return status ?? defaultStatus();
}

async function setStatus(status) {
  await chrome.storage.session.set({ status });
}

function earningsStatus(earnings) {
  if (!earnings) return {};
  return { processedJobs: earnings.processedCount, failedJobs: earnings.failedCount, verificationJobs: earnings.verificationCount, provisionalMicroYen: earnings.provisionalMicroYen, confirmedMicroYen: earnings.confirmedMicroYen ?? 0 };
}

async function recordError(error) {
  await setStatus({ ...(await getStatus()), mode: "error", message: error instanceof Error ? error.message : String(error) });
}

function normalizeEmail(email) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a valid email address.");
  return normalized;
}

function normalizeVerificationCode(code) {
  const normalized = String(code ?? "").trim();
  if (!/^\d{6}$/.test(normalized)) throw new Error("Enter the 6-digit email verification code.");
  return normalized;
}

function connectionMbps() {
  const downlink = navigator.connection?.downlink;
  return typeof downlink === "number" && downlink > 0 ? Math.round(downlink) : 25;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toPem(label, buffer) {
  const encoded = btoa(String.fromCharCode(...new Uint8Array(buffer))).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
}

function pemToArrayBuffer(pem) {
  const body = String(pem).replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s/g, "");
  return base64ToBytes(body).buffer;
}

function base64UrlToBytes(value) {
  return base64ToBytes(String(value).replace(/-/g, "+").replace(/_/g, "/"));
}

function base64ToBytes(value) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
