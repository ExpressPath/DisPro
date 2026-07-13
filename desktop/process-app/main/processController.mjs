import { cpus, hostname, platform, release, totalmem } from "node:os";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { shell } from "electron";
import { executeSignedProcessJob, supportedWorkloads } from "../worker/runners.mjs";

const POLL_INTERVAL_MS = 3000;

export class ProcessController {
  constructor({ credentials, onStatus, appVersion }) {
    this.credentials = credentials;
    this.onStatus = onStatus;
    this.appVersion = appVersion ?? "0.1.7";
    this.status = {
      mode: "stopped",
      connected: false,
      processedJobs: 0,
      failedJobs: 0,
      verificationJobs: 0,
      provisionalMicroYen: 0,
      confirmedMicroYen: 0,
      update: null,
      message: "Not signed in"
    };
    this.timer = undefined;
    this.auth = undefined;
    this.node = undefined;
    this.publicKey = undefined;
    this.resultKeyPair = generateKeyPairSync("ed25519");
    this.benchmarkScores = runLightweightBenchmark();
  }

  async loadStoredAuth() {
    const auth = await this.credentials.loadAuth();
    if (!auth) {
      return { signedIn: false };
    }
    let me;
    try {
      me = await apiFetch(auth.apiBaseUrl, "/auth/me", {
        token: auth.processApiKey
      });
    } catch (error) {
      await this.credentials.clearAuth();
      this.auth = undefined;
      this.status.connected = false;
      this.status.message = "Stored sign-in is invalid. Verify your email again.";
      this.emit();
      return { signedIn: false };
    }
    this.auth = auth;
    this.status.connected = true;
    this.status.message = `Signed in as ${me.user.email}`;
    this.emit();
    return {
      signedIn: true,
      user: me.user,
      apiBaseUrl: auth.apiBaseUrl,
      hasUseApiKey: Boolean(auth.useApiKey)
    };
  }

  async requestSignInLink(input) {
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
    await this.checkApiHealth(apiBaseUrl);
    return apiFetch(apiBaseUrl, "/auth/request-code", {
      method: "POST",
      body: {
        email: input.email
      }
    });
  }

  async verifySignIn(input) {
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
    await this.checkApiHealth(apiBaseUrl);
    const code = normalizeVerificationCode(input.code);
    const session = await apiFetch(apiBaseUrl, "/auth/verify", {
      method: "POST",
      body: {
        email: input.email,
        code
      }
    });
    const me = await apiFetch(apiBaseUrl, "/auth/me", {
      token: session.sessionToken
    });
    const processApiKey =
      input.existingProcessApiKey ??
      (
        await apiFetch(apiBaseUrl, "/auth/api-keys", {
          method: "POST",
          token: session.sessionToken,
          body: {
            label: "process-windows-v1",
            purpose: "process"
          }
        })
      ).secret;
    if (!processApiKey) {
      throw new Error("Existing process API keys cannot be recovered. Revoke the old key and create a new one.");
    }
    const useApiKey =
      input.existingUseApiKey ??
      (
        await apiFetch(apiBaseUrl, "/auth/api-keys", {
          method: "POST",
          token: session.sessionToken,
          body: {
            label: "use-windows-v1",
            purpose: "use"
          }
        })
      ).secret;

    this.auth = {
      apiBaseUrl,
      sessionToken: session.sessionToken,
      processApiKey,
      useApiKey
    };
    await this.credentials.saveAuth(this.auth);
    this.status.connected = true;
    this.status.message = `Signed in as ${session.user.email}`;
    this.emit();
    return {
      signedIn: true,
      user: session.user
    };
  }

  async clearStoredAuth() {
    await this.stop().catch(() => undefined);
    await this.credentials.clearAuth();
    this.auth = undefined;
    this.node = undefined;
    this.publicKey = undefined;
    this.status = {
      mode: "stopped",
      connected: false,
      processedJobs: 0,
      failedJobs: 0,
      verificationJobs: 0,
      provisionalMicroYen: 0,
      confirmedMicroYen: 0,
      update: null,
      message: "Stored sign-in cleared"
    };
    this.emit();
    return { ok: true };
  }

  async start() {
    if (!this.auth) {
      await this.loadStoredAuth();
    }
    if (!this.auth) {
      throw new Error("Sign in before starting Process mode.");
    }

    this.publicKey = await apiFetch(this.auth.apiBaseUrl, "/process/signing-key");
    this.node = await this.registerNode();
    this.status.mode = "waiting";
    this.status.message = "Waiting for signed jobs";
    this.emit();
    this.schedulePoll(0);
    return this.status;
  }

  async stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.auth && this.node) {
      await apiFetch(this.auth.apiBaseUrl, "/process/heartbeat", {
        method: "POST",
        token: this.auth.processApiKey,
        body: {
          nodeId: this.node.id,
          mode: "stopped"
        }
      }).catch(() => undefined);
    }
    this.status.mode = "stopped";
    this.status.message = "Stopped";
    this.emit();
    return this.status;
  }

  getStatus() {
    return this.status;
  }

  async getBillingStatus(setupSessionId) {
    await this.ensureSignedIn();
    const query = setupSessionId ? `?setup_session_id=${encodeURIComponent(setupSessionId)}` : "";
    return apiFetch(this.auth.apiBaseUrl, `/billing/status${query}`, {
      token: this.auth.sessionToken
    });
  }

  async getAccountProfile() {
    await this.ensureSignedIn();
    return apiFetch(this.auth.apiBaseUrl, "/account/profile", {
      token: this.auth.sessionToken
    });
  }

  async getWallet() {
    await this.ensureSignedIn();
    return apiFetch(this.auth.apiBaseUrl, "/wallet", { token: this.auth.sessionToken });
  }

  async startPayoutOnboarding() {
    await this.ensureSignedIn();
    const response = await apiFetch(this.auth.apiBaseUrl, "/payouts/connect/onboarding", {
      method: "POST",
      token: this.auth.sessionToken,
      body: {}
    });
    if (response.url) await shell.openExternal(response.url);
    return response;
  }

  async startBillingSetup() {
    await this.ensureSignedIn();
    const response = await apiFetch(this.auth.apiBaseUrl, "/billing/setup-session", {
      method: "POST",
      token: this.auth.sessionToken,
      body: {}
    });
    if (response.url) {
      await shell.openExternal(response.url);
    }
    return response;
  }

  async createUseOrder(input) {
    await this.ensureUseApiKey();
    return apiFetch(this.auth.apiBaseUrl, "/use/orders", {
      method: "POST",
      token: this.auth.useApiKey,
      body: normalizeUseOrderInput(input),
      headers: { "idempotency-key": randomUUID() }
    });
  }

  async getUseOrder(orderId) {
    await this.ensureUseApiKey();
    return apiFetch(this.auth.apiBaseUrl, `/use/orders/${encodeURIComponent(orderId)}`, {
      token: this.auth.useApiKey
    });
  }

  async getUseOrderResult(orderId) {
    await this.ensureUseApiKey();
    return apiFetch(this.auth.apiBaseUrl, `/use/orders/${encodeURIComponent(orderId)}/result`, {
      token: this.auth.useApiKey
    });
  }

  async ensureSignedIn() {
    if (!this.auth) {
      await this.loadStoredAuth();
    }
    if (!this.auth) {
      throw new Error("Sign in before using Dispro.");
    }
  }

  async ensureUseApiKey() {
    await this.ensureSignedIn();
    if (this.auth.useApiKey) {
      return this.auth.useApiKey;
    }

    const created = await apiFetch(this.auth.apiBaseUrl, "/auth/api-keys", {
      method: "POST",
      token: this.auth.sessionToken,
      body: {
        label: "use-windows-v1",
        purpose: "use"
      }
    });
    this.auth = {
      ...this.auth,
      useApiKey: created.secret
    };
    await this.credentials.saveAuth(this.auth);
    return created.secret;
  }

  async registerNode() {
    const response = await apiFetch(this.auth.apiBaseUrl, "/process/register", {
      method: "POST",
      token: this.auth.processApiKey,
      body: {
        machineId: `${hostname()}-${platform()}-${release()}`,
        deviceName: hostname(),
        os: `${platform()} ${release()}`,
        appVersion: this.appVersion,
        cpuCores: cpus().length,
        memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
        supportedWorkloads,
        deviceClass: inferDeviceClass(),
        benchmarkScores: this.benchmarkScores,
        bandwidthMbps: 50,
        thermalState: "nominal",
        batteryState: "unknown",
        maxConcurrentJobs: Math.max(1, Math.min(8, Math.floor(cpus().length / 2))),
        runnerFamily: "electron-process-v1",
        clusterWords: createClusterWords(),
        nodePublicKey: this.resultKeyPair.publicKey.export({ type: "spki", format: "pem" })
      }
    });
    this.applyEarnings(response.earnings);
    return response.node;
  }

  async checkApiHealth(apiBaseUrl) {
    await apiFetch(apiBaseUrl, "/health").catch((error) => {
      throw new Error(`${error.message} Start the Dispro API with npm.cmd run server, or enter the official API URL.`);
    });
  }

  schedulePoll(delayMs = POLL_INTERVAL_MS) {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.pollOnce().catch((error) => {
        this.status.mode = "error";
        this.status.message = error instanceof Error ? error.message : String(error);
        this.emit();
        this.schedulePoll(POLL_INTERVAL_MS);
      });
    }, delayMs);
  }

  async pollOnce() {
    if (!this.auth || !this.node) {
      return;
    }

    const lease = await apiFetch(this.auth.apiBaseUrl, "/process/lease", {
      method: "POST",
      token: this.auth.processApiKey,
      body: {
        nodeId: this.node.id,
        supportedWorkloads
      }
    });

    if (lease.status === "idle") {
      this.status.mode = "waiting";
      this.status.message = "Waiting for signed jobs";
      this.emit();
      this.schedulePoll();
      return;
    }

    this.status.mode = "running";
    this.status.message = `Running ${lease.job.workload}`;
    this.emit();
    const startedAt = Date.now();
    const execution = await executeSignedProcessJob(lease.job, {
      publicKey: this.publicKey.publicKey
    });
    const statusMessage = this.applyExecutionSideEffects(lease.job, execution);
    const response = await apiFetch(this.auth.apiBaseUrl, "/process/results", {
      method: "POST",
      token: this.auth.processApiKey,
      body: {
        nodeId: this.node.id,
        jobId: lease.job.jobId,
        status: execution.status,
        resultHash: execution.resultHash,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: Date.now() - startedAt,
        metrics: execution.metrics,
        ...this.createResultSignature(lease.job, execution),
        errorMessage: execution.errorMessage
      }
    });

    this.applyEarnings(response.earnings);
    this.status.mode = "submitted";
    this.status.message = statusMessage ?? `Submitted ${lease.job.jobId}`;
    this.emit();
    this.schedulePoll(500);
  }

  createResultSignature(job, execution) {
    const resultNonce = `rnonce_${createHash("sha256")
      .update(`${job.jobId}:${job.nonce}:${execution.resultHash}:${Date.now()}`)
      .digest("hex")}`;
    const payload = {
      nodeId: this.node.id,
      jobId: job.jobId,
      resultHash: execution.resultHash,
      status: execution.status,
      resultNonce
    };
    const nodeSignature = cryptoSign(null, Buffer.from(stableStringify(payload)), this.resultKeyPair.privateKey).toString(
      "base64url"
    );
    return {
      resultNonce,
      nodePublicKey: this.resultKeyPair.publicKey.export({ type: "spki", format: "pem" }),
      nodeSignature
    };
  }

  applyExecutionSideEffects(job, execution) {
    if (job.workload !== "dispro.app.update" || execution.status !== "completed") {
      return undefined;
    }

    const payload = parseJsonObject(execution.stdout);
    const manifest = isObject(payload.manifest) ? payload.manifest : {};
    const version = typeof manifest.version === "string" ? manifest.version : "unknown";
    const channel = typeof manifest.channel === "string" ? manifest.channel : "stable";
    this.status.update = {
      ...manifest,
      version,
      channel,
      receivedAt: new Date().toISOString(),
      sourceJobId: job.jobId
    };
    return `Update manifest received: ${version} (${channel})`;
  }

  applyEarnings(earnings) {
    if (!earnings) {
      return;
    }
    this.status.processedJobs = earnings.processedCount;
    this.status.failedJobs = earnings.failedCount;
    this.status.verificationJobs = earnings.verificationCount;
    this.status.provisionalMicroYen = earnings.provisionalMicroYen;
    this.status.confirmedMicroYen = earnings.confirmedMicroYen ?? 0;
  }

  emit() {
    this.onStatus?.({ ...this.status });
  }
}

async function apiFetch(apiBaseUrl, path, options = {}) {
  const headers = {
    "content-type": "application/json"
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  Object.assign(headers, options.headers ?? {});

  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reach Dispro API at ${apiBaseUrl}: ${reason}.`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message ?? `API request failed with ${response.status}`;
    if (response.status === 403 && /Process API key/i.test(message)) {
      throw new Error(`${message} Clear stored sign-in and sign in again to create a Process key.`);
    }
    throw new Error(message);
  }
  return payload;
}

function normalizeApiBaseUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error("API base URL must start with http:// or https://");
  }
  return trimmed;
}

function normalizeVerificationCode(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{6}$/.test(raw)) {
    throw new Error("Enter the 6-digit email verification code.");
  }
  return raw;
}

function normalizeUseOrderInput(input) {
  const sourceKind = String(input.sourceKind ?? "url").trim();
  const sourceUri = String(input.sourceUri ?? "").trim();
  const contentHash = String(input.contentHash ?? "").trim();
  const workload = String(input.workload ?? "hash.compute").trim();
  const byteSize = Number.parseInt(String(input.byteSize ?? "0"), 10);
  const maxChargeMicroYen = Number.parseInt(String(input.maxChargeMicroYen ?? "0"), 10);

  if (!["file", "folder", "url", "code", "proof"].includes(sourceKind)) {
    throw new Error("Source kind must be file, folder, url, code, or proof.");
  }
  if (!sourceUri) {
    throw new Error("Source URL or CID is required.");
  }
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    throw new Error("Byte size must be greater than zero.");
  }
  if (!contentHash || contentHash.length < 8) {
    throw new Error("Content hash is required.");
  }
  if (!workload) {
    throw new Error("Workload is required.");
  }

  const order = {
    source: {
      kind: sourceKind,
      uri: sourceUri,
      byteSize,
      contentHash
    },
    workload,
    priority: input.priority ?? "standard",
    verificationLevel: input.verificationLevel ?? "standard"
  };

  if (maxChargeMicroYen > 0) {
    order.maxChargeMicroYen = maxChargeMicroYen;
  }
  return order;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runLightweightBenchmark() {
  const startedAt = Date.now();
  let digest = "dispro";
  let iterations = 0;
  while (Date.now() - startedAt < 80) {
    digest = createHash("sha256").update(digest).digest("hex");
    iterations += 1;
  }
  const perSecond = Math.round(iterations / Math.max(0.08, (Date.now() - startedAt) / 1000));
  return {
    cpu: perSecond,
    hash: perSecond,
    memory: Math.round((totalmem() / 1024 ** 3) * 100)
  };
}

function inferDeviceClass() {
  const cpuCount = cpus().length;
  const memoryGb = totalmem() / 1024 ** 3;
  if (supportedWorkloads.some((workload) => workload.includes("gpu"))) {
    return "gpu";
  }
  if (cpuCount >= 24 || memoryGb >= 96) {
    return "server";
  }
  if (cpuCount >= 12 || memoryGb >= 24) {
    return "desktop";
  }
  if (cpuCount >= 4 || memoryGb >= 6) {
    return "laptop";
  }
  return "mobile";
}

function createClusterWords() {
  return [...new Set(["electron-process-v1", inferDeviceClass(), ...supportedWorkloads.map((workload) => workload.split(".")[0])])];
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
