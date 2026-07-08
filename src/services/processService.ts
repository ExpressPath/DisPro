import { randomBytes, sign, verify } from "node:crypto";
import { makeId, stableStringify, hashObject } from "../domain/ids.js";
import type {
  DistributedRecord,
  JsonRecord,
  PlannedOrder,
  ProcessEarnings,
  ProcessJob,
  ProcessJobResult,
  ProcessNodeInfo,
  ProcessNodeMode,
  ProcessNodeRecord,
  ProcessResultStatus,
  SignedProcessJobEnvelope,
  TaskSpec,
  UserAccount,
  UserTransaction
} from "../domain/types.js";
import type { AuthContext } from "./authService.js";
import type { DisproStore } from "../storage/disproStore.js";

const LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PROVISIONAL_MICRO_YEN = 10_000;
const SPECIAL_PROCESS_WORKLOADS = [
  "dispro.storage.anchor",
  "dispro.transaction.anchor",
  "dispro.app.update"
] as const;
const SUPPORTED_V1_WORKLOADS = new Set([
  "hash.compute",
  "proof.verify",
  "echo.test",
  "data.transform.basic",
  ...SPECIAL_PROCESS_WORKLOADS
]);

const DEV_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKZ4/Q3gtCK2Qx2Zcvv8iU9hsEwI4gb5IuKGojPYKzfc
-----END PRIVATE KEY-----`;

export const DEFAULT_PROCESS_JOB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbTYmuTvvI6+vd7NsDhpMOgbnGvaQoqxFUE8cgIqk7ds=
-----END PUBLIC KEY-----`;

export interface RegisterProcessNodeInput extends ProcessNodeInfo {
  mode?: ProcessNodeMode;
}

export interface HeartbeatInput {
  nodeId: string;
  mode: ProcessNodeMode;
  currentJobId?: string;
}

export interface LeaseInput {
  nodeId: string;
  supportedWorkloads?: string[];
}

export interface SubmitResultInput {
  nodeId: string;
  jobId: string;
  status: ProcessResultStatus;
  resultHash: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  errorMessage?: string;
}

export interface LeaseResult {
  status: "idle" | "leased";
  job?: SignedProcessJobEnvelope;
}

export function getProcessJobPublicKey(): string {
  return process.env.DISPRO_JOB_SIGNING_PUBLIC_KEY ?? DEFAULT_PROCESS_JOB_PUBLIC_KEY;
}

export async function registerProcessNode(
  store: DisproStore,
  auth: AuthContext,
  input: RegisterProcessNodeInput,
  now = new Date()
): Promise<ProcessNodeRecord> {
  validateProcessNodeInfo(input);
  const existing = await store.getProcessNodeByMachine(auth.user.id, input.machineId);
  const nowIso = now.toISOString();
  const node: ProcessNodeRecord = {
    id: existing?.id ?? makeId("pnode", { userId: auth.user.id, machineId: input.machineId }),
    userId: auth.user.id,
    machineId: input.machineId,
    deviceName: input.deviceName,
    os: input.os,
    appVersion: input.appVersion,
    cpuCores: input.cpuCores,
    memoryGb: input.memoryGb,
    supportedWorkloads: input.supportedWorkloads,
    mode: input.mode ?? existing?.mode ?? "stopped",
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso
  };

  if (existing?.currentJobId !== undefined) {
    node.currentJobId = existing.currentJobId;
  }
  if (existing?.lastHeartbeatAt !== undefined) {
    node.lastHeartbeatAt = existing.lastHeartbeatAt;
  }

  await store.upsertProcessNode(node);
  await ensureUserSnapshotAnchorJob(store, auth.user, now);
  await ensureAppUpdateJob(store, auth.user.id, node, input.appVersion, now);
  return node;
}

export async function recordProcessHeartbeat(
  store: DisproStore,
  auth: AuthContext,
  input: HeartbeatInput,
  now = new Date()
): Promise<ProcessNodeRecord> {
  const node = await requireOwnedNode(store, auth, input.nodeId);
  const updated: ProcessNodeRecord = {
    ...node,
    mode: input.mode,
    updatedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString()
  };

  if (input.currentJobId !== undefined) {
    updated.currentJobId = input.currentJobId;
  } else {
    delete updated.currentJobId;
  }

  await store.upsertProcessNode(updated);
  return updated;
}

export async function leaseProcessJob(
  store: DisproStore,
  auth: AuthContext,
  input: LeaseInput,
  now = new Date()
): Promise<LeaseResult> {
  const node = await requireOwnedNode(store, auth, input.nodeId);
  const workloads = input.supportedWorkloads ?? node.supportedWorkloads;
  const jobs = await store.listProcessJobs();
  const nowMs = now.getTime();

  for (const job of jobs) {
    if (job.status === "leased" && job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= nowMs) {
      const requeued: ProcessJob = {
        ...job,
        status: "queued",
        updatedAt: now.toISOString()
      };
      delete requeued.assignedProcessNodeId;
      delete requeued.assignedUserId;
      delete requeued.leaseExpiresAt;
      await store.saveProcessJob(requeued);
    }
  }

  const queued = (await store.listProcessJobs())
    .filter((job) => job.status === "queued")
    .find((job) => isSupportedByNode(job.workload, workloads));

  if (!queued) {
    await store.upsertProcessNode({
      ...node,
      mode: "waiting",
      updatedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString()
    });
    return { status: "idle" };
  }

  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  const leased: ProcessJob = {
    ...queued,
    status: "leased",
    attempts: queued.attempts + 1,
    updatedAt: now.toISOString(),
    expiresAt,
    assignedProcessNodeId: node.id,
    assignedUserId: auth.user.id,
    leaseExpiresAt: expiresAt
  };
  await store.saveProcessJob(leased);
  await store.upsertProcessNode({
    ...node,
    mode: "running",
    currentJobId: leased.id,
    updatedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString()
  });

  return {
    status: "leased",
    job: signProcessJob(leased)
  };
}

export async function submitProcessResult(
  store: DisproStore,
  auth: AuthContext,
  input: SubmitResultInput,
  now = new Date()
): Promise<{ job: ProcessJob; result: ProcessJobResult; earnings: ProcessEarnings }> {
  const node = await requireOwnedNode(store, auth, input.nodeId);
  const job = await store.getProcessJob(input.jobId);
  if (!job || job.assignedProcessNodeId !== node.id || job.assignedUserId !== auth.user.id) {
    throw new ProcessError(404, "Process job not found for this node.");
  }

  if (!["leased", "running"].includes(job.status)) {
    throw new ProcessError(409, "Process job is not accepting results.");
  }

  const result: ProcessJobResult = {
    id: makeId("presult", { jobId: job.id, nodeId: node.id, createdAt: now.toISOString() }),
    jobId: job.id,
    processNodeId: node.id,
    userId: auth.user.id,
    status: input.status,
    resultHash: input.resultHash,
    stdout: clampOutput(input.stdout ?? ""),
    stderr: clampOutput(input.stderr ?? ""),
    durationMs: Math.max(0, input.durationMs),
    createdAt: now.toISOString()
  };

  if (input.errorMessage !== undefined) {
    result.errorMessage = clampOutput(input.errorMessage);
  }

  const updatedJob: ProcessJob = {
    ...job,
    status: input.status,
    updatedAt: now.toISOString()
  };
  await store.saveProcessJob(updatedJob);
  await store.saveProcessJobResult(result);
  await handleSpecialProcessResult(store, auth.user.id, updatedJob, result, now);
  if (updatedJob.status === "completed" && updatedJob.provisionalMicroYen > 0) {
    const transaction = await createProvisionalEarningTransaction(store, updatedJob, auth.user.id, now);
    await ensureTransactionAnchorJob(store, transaction, now);
  }
  const updatedNode: ProcessNodeRecord = {
    ...node,
    mode: "waiting",
    updatedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString()
  };
  delete updatedNode.currentJobId;
  await store.upsertProcessNode(updatedNode);

  return {
    job: updatedJob,
    result,
    earnings: await calculateProcessEarnings(store, auth.user.id)
  };
}

export async function calculateProcessEarnings(store: DisproStore, userId: string): Promise<ProcessEarnings> {
  const [jobs, results] = await Promise.all([store.listProcessJobs(), store.listProcessJobResultsForUser(userId)]);
  const userJobs = jobs.filter((job) => job.assignedUserId === userId);
  const completed = userJobs.filter((job) => job.status === "completed" && job.provisionalMicroYen > 0);
  const failed = results.filter((result) => result.status === "failed" || result.status === "rejected");

  return {
    userId,
    provisionalMicroYen: completed.reduce((sum, job) => sum + job.provisionalMicroYen, 0),
    confirmedMicroYen: 0,
    processedCount: completed.length,
    failedCount: failed.length,
    verificationCount: completed.filter((job) => job.workload === "proof.verify").length
  };
}

export async function createDistributedRecordForUser(
  store: DisproStore,
  user: UserAccount,
  now = new Date()
): Promise<ProcessJob> {
  return ensureUserSnapshotAnchorJob(store, user, now);
}

export async function enqueueProcessJobsForPlan(
  store: DisproStore,
  plan: PlannedOrder,
  now = new Date()
): Promise<ProcessJob[]> {
  const jobs: ProcessJob[] = [];
  for (const task of plan.tasks) {
    if (!SUPPORTED_V1_WORKLOADS.has(task.workload)) {
      continue;
    }
    const job = createProcessJobFromTask(plan.order.id, task, task.input as unknown as JsonRecord, now);
    await store.saveProcessJob(job);
    jobs.push(job);
  }
  return jobs;
}

export function createProcessJobFromTask(
  orderId: string,
  task: Pick<TaskSpec, "id" | "workload">,
  inputRef: JsonRecord,
  now = new Date()
): ProcessJob {
  const nowIso = now.toISOString();
  return {
    id: makeId("pjob", { orderId, taskId: task.id, workload: task.workload, createdAt: nowIso }),
    orderId,
    taskId: task.id,
    workload: task.workload,
    inputRef,
    contractHash: hashObject({ orderId, taskId: task.id, workload: task.workload }),
    cid: `local-${task.id}`,
    paymentMode: "internal",
    status: "queued",
    nonce: randomBytes(16).toString("hex"),
    attempts: 0,
    provisionalMicroYen: DEFAULT_PROVISIONAL_MICRO_YEN,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

export function createSpecialProcessJob(
  userId: string,
  workload: string,
  inputRef: JsonRecord,
  sourceId: string,
  now = new Date()
): ProcessJob {
  const nowIso = now.toISOString();
  return {
    id: makeId("pjob", { userId, workload, sourceId, createdAt: nowIso }),
    orderId: "system",
    taskId: sourceId,
    workload,
    inputRef,
    contractHash: hashObject({ userId, workload, sourceId, inputRef }),
    cid: `pending-${sourceId}`,
    paymentMode: "internal",
    status: "queued",
    nonce: randomBytes(16).toString("hex"),
    attempts: 0,
    provisionalMicroYen: 0,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

export function signProcessJob(job: ProcessJob): SignedProcessJobEnvelope {
  if (!job.expiresAt) {
    throw new ProcessError(500, "Cannot sign a job without an expiration.");
  }
  const envelope = toUnsignedEnvelope(job);
  const signature = sign(null, Buffer.from(stableStringify(envelope)), getSigningPrivateKey()).toString("base64url");
  return {
    ...envelope,
    signature
  };
}

export function verifyProcessJobEnvelope(envelope: SignedProcessJobEnvelope, publicKey = getProcessJobPublicKey()): boolean {
  const { signature, ...unsigned } = envelope;
  try {
    return verify(null, Buffer.from(stableStringify(unsigned)), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function toUnsignedEnvelope(job: ProcessJob): Omit<SignedProcessJobEnvelope, "signature"> {
  if (!job.expiresAt) {
    throw new ProcessError(500, "Cannot create a job envelope without expiration.");
  }
  return {
    jobId: job.id,
    orderId: job.orderId,
    taskId: job.taskId,
    workload: job.workload,
    inputRef: job.inputRef,
    contractHash: job.contractHash,
    cid: job.cid,
    paymentMode: job.paymentMode,
    expiresAt: job.expiresAt,
    nonce: job.nonce
  };
}

function getSigningPrivateKey(): string {
  return process.env.DISPRO_JOB_SIGNING_PRIVATE_KEY ?? DEV_PRIVATE_KEY;
}

async function ensureUserSnapshotAnchorJob(store: DisproStore, user: UserAccount, now: Date): Promise<ProcessJob> {
  const sourceId = `user-profile-${user.id}`;
  return ensureSpecialJob(
    store,
    user.id,
    "dispro.storage.anchor",
    sourceId,
    {
      recordType: "user.profile",
      ownerUserId: user.id,
      sourceId,
      provider: "local",
      encryptedJson: stableStringify({
        userId: user.id,
        emailHash: hashObject({ email: user.email }),
        status: user.status,
        updatedAt: user.updatedAt
      })
    },
    now
  );
}

async function ensureTransactionAnchorJob(
  store: DisproStore,
  transaction: UserTransaction,
  now: Date
): Promise<ProcessJob> {
  const sourceId = `transaction-${transaction.id}`;
  return ensureSpecialJob(
    store,
    transaction.userId,
    "dispro.transaction.anchor",
    sourceId,
    {
      recordType: "transaction",
      ownerUserId: transaction.userId,
      sourceId,
      transactionId: transaction.id,
      provider: "local",
      encryptedJson: stableStringify({
        id: transaction.id,
        userId: transaction.userId,
        kind: transaction.kind,
        amountMicroYen: transaction.amountMicroYen,
        currency: transaction.currency,
        status: transaction.status,
        relatedJobId: transaction.relatedJobId
      })
    },
    now
  );
}

async function ensureAppUpdateJob(
  store: DisproStore,
  userId: string,
  node: ProcessNodeRecord,
  currentVersion: string,
  now: Date
): Promise<ProcessJob | undefined> {
  const updateVersion = process.env.DISPRO_PROCESS_UPDATE_VERSION;
  const downloadUrl = process.env.DISPRO_PROCESS_UPDATE_URL;
  const sha256 = process.env.DISPRO_PROCESS_UPDATE_SHA256;
  if (!updateVersion || !downloadUrl || !sha256 || updateVersion === currentVersion) {
    return undefined;
  }

  const sourceId = `app-update-${node.id}-${updateVersion}`;
  return ensureSpecialJob(
    store,
    userId,
    "dispro.app.update",
    sourceId,
    {
      recordType: "app.update",
      ownerUserId: userId,
      sourceId,
      provider: "local",
      manifest: {
        version: updateVersion,
        platform: "win32",
        channel: process.env.DISPRO_PROCESS_UPDATE_CHANNEL ?? "stable",
        downloadUrl,
        sha256,
        mandatory: process.env.DISPRO_PROCESS_UPDATE_MANDATORY === "true",
        notes: process.env.DISPRO_PROCESS_UPDATE_NOTES ?? ""
      }
    },
    now
  );
}

async function ensureSpecialJob(
  store: DisproStore,
  userId: string,
  workload: string,
  sourceId: string,
  inputRef: JsonRecord,
  now: Date
): Promise<ProcessJob> {
  const existing = (await store.listProcessJobs()).find(
    (job) => job.taskId === sourceId && job.workload === workload && job.status !== "failed" && job.status !== "rejected"
  );
  if (existing) {
    return existing;
  }

  const job = createSpecialProcessJob(userId, workload, inputRef, sourceId, now);
  await store.saveProcessJob(job);
  return job;
}

async function createProvisionalEarningTransaction(
  store: DisproStore,
  job: ProcessJob,
  userId: string,
  now: Date
): Promise<UserTransaction> {
  const existing = (await store.listUserTransactions(userId)).find((transaction) => transaction.relatedJobId === job.id);
  if (existing) {
    return existing;
  }

  const nowIso = now.toISOString();
  const transaction: UserTransaction = {
    id: makeId("txn", { userId, jobId: job.id, createdAt: nowIso }),
    userId,
    kind: "provisional_earning",
    amountMicroYen: job.provisionalMicroYen,
    currency: "JPY_MICRO",
    status: "pending",
    relatedJobId: job.id,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  await store.saveUserTransaction(transaction);
  return transaction;
}

async function handleSpecialProcessResult(
  store: DisproStore,
  userId: string,
  job: ProcessJob,
  result: ProcessJobResult,
  now: Date
): Promise<void> {
  if (!["dispro.storage.anchor", "dispro.transaction.anchor", "dispro.app.update"].includes(job.workload)) {
    return;
  }

  if (result.status !== "completed") {
    return;
  }

  const parsed = parseResultJson(result.stdout);
  const sourceId = typeof job.inputRef.sourceId === "string" ? job.inputRef.sourceId : job.id;
  const recordType = job.workload === "dispro.app.update" ? "app.update" : job.workload === "dispro.transaction.anchor" ? "transaction" : "user.profile";
  const nowIso = now.toISOString();
  const record: DistributedRecord = {
    id: makeId("drec", { userId, sourceId, cid: parsed.cid ?? result.resultHash }),
    userId,
    type: recordType,
    provider: parseProvider(job.inputRef.provider),
    cid: typeof parsed.cid === "string" ? parsed.cid : `local-${result.resultHash}`,
    contractHash: typeof parsed.contractHash === "string" ? parsed.contractHash : job.contractHash,
    payloadHash: typeof parsed.payloadHash === "string" ? parsed.payloadHash : result.resultHash,
    sourceId,
    status: "anchored",
    createdAt: nowIso,
    updatedAt: nowIso
  };
  await store.saveDistributedRecord(record);

  if (record.type === "transaction" && typeof job.inputRef.transactionId === "string") {
    const transaction = await store.getUserTransaction(job.inputRef.transactionId);
    if (transaction) {
      await store.saveUserTransaction({
        ...transaction,
        status: "anchored",
        distributedRecordId: record.id,
        updatedAt: nowIso
      });
    }
  }
}

function parseResultJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseProvider(value: unknown): "ipfs" | "filecoin" | "arweave" | "local" {
  return value === "ipfs" || value === "filecoin" || value === "arweave" || value === "local" ? value : "local";
}

async function requireOwnedNode(store: DisproStore, auth: AuthContext, nodeId: string): Promise<ProcessNodeRecord> {
  const node = await store.getProcessNode(nodeId);
  if (!node || node.userId !== auth.user.id) {
    throw new ProcessError(404, "Process node not found.");
  }
  return node;
}

function validateProcessNodeInfo(input: ProcessNodeInfo): void {
  if (!input.machineId || input.machineId.trim().length < 3) {
    throw new ProcessError(400, "machineId is required.");
  }
  if (!input.deviceName || input.deviceName.trim().length === 0) {
    throw new ProcessError(400, "deviceName is required.");
  }
  if (!Array.isArray(input.supportedWorkloads) || input.supportedWorkloads.length === 0) {
    throw new ProcessError(400, "supportedWorkloads must not be empty.");
  }
}

function isSupportedByNode(workload: string, supportedWorkloads: readonly string[]): boolean {
  return supportedWorkloads.includes("*") || supportedWorkloads.includes(workload);
}

function clampOutput(value: string): string {
  return value.slice(0, 32_000);
}

export class ProcessError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
