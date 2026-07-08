import { cpus, hostname, platform, release, totalmem } from "node:os";
import { executeSignedProcessJob, supportedWorkloads } from "../worker/runners.mjs";

const APP_VERSION = "0.1.0";
const POLL_INTERVAL_MS = 3000;

export class ProcessController {
  constructor({ credentials, onStatus }) {
    this.credentials = credentials;
    this.onStatus = onStatus;
    this.status = {
      mode: "stopped",
      connected: false,
      processedJobs: 0,
      failedJobs: 0,
      verificationJobs: 0,
      provisionalMicroYen: 0,
      update: null,
      message: "Not signed in"
    };
    this.timer = undefined;
    this.auth = undefined;
    this.node = undefined;
    this.publicKey = undefined;
  }

  async loadStoredAuth() {
    const auth = await this.credentials.loadAuth();
    if (!auth) {
      return { signedIn: false };
    }
    this.auth = auth;
    const me = await apiFetch(auth.apiBaseUrl, "/auth/me", {
      token: auth.processApiKey
    });
    this.status.connected = true;
    this.status.message = `Signed in as ${me.user.email}`;
    this.emit();
    return {
      signedIn: true,
      user: me.user,
      apiBaseUrl: auth.apiBaseUrl
    };
  }

  async requestSignInLink(input) {
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
    return apiFetch(apiBaseUrl, "/auth/request-link", {
      method: "POST",
      body: {
        email: input.email,
        baseUrl: apiBaseUrl
      }
    });
  }

  async verifySignIn(input) {
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
    const token = extractToken(input.tokenOrLink);
    const session = await apiFetch(apiBaseUrl, "/auth/verify", {
      method: "POST",
      body: { token }
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

    this.auth = {
      apiBaseUrl,
      sessionToken: session.sessionToken,
      processApiKey
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

  async registerNode() {
    const response = await apiFetch(this.auth.apiBaseUrl, "/process/register", {
      method: "POST",
      token: this.auth.processApiKey,
      body: {
        machineId: `${hostname()}-${platform()}-${release()}`,
        deviceName: hostname(),
        os: `${platform()} ${release()}`,
        appVersion: APP_VERSION,
        cpuCores: cpus().length,
        memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
        supportedWorkloads
      }
    });
    this.applyEarnings(response.earnings);
    return response.node;
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
        errorMessage: execution.errorMessage
      }
    });

    this.applyEarnings(response.earnings);
    this.status.mode = "submitted";
    this.status.message = statusMessage ?? `Submitted ${lease.job.jobId}`;
    this.emit();
    this.schedulePoll(500);
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

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `API request failed with ${response.status}`);
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

function extractToken(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Sign-in token or link is required.");
  }
  try {
    const url = new URL(raw);
    return url.searchParams.get("token") ?? raw;
  } catch {
    return raw;
  }
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
