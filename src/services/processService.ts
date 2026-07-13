import { randomBytes, sign, verify } from "node:crypto";
import { makeId, stableStringify, hashObject } from "../domain/ids.js";
import type {
  DistributedRecord,
  ConsensusRecord,
  DeviceClass,
  JsonRecord,
  NodeCapabilitySnapshot,
  NodeProfile,
  PlannedOrder,
  ProcessEarnings,
  ProcessJob,
  ProcessJobResult,
  ProcessNodeInfo,
  ProcessNodeMode,
  ProcessNodeRecord,
  ProcessResultMetrics,
  ProcessResultStatus,
  SignedProcessJobEnvelope,
  TaskSpec,
  UserAccount,
  UserTransaction,
  WorkUnit,
  WorkUnitStatus
} from "../domain/types.js";
import type { AuthContext } from "./authService.js";
import type { DisproStore } from "../storage/disproStore.js";
import { getProcessUpdateRef } from "./updateGraphService.js";

const LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PROVISIONAL_MICRO_YEN = 10_000;
const DEFAULT_TARGET_REPLICAS = 3;
const DEFAULT_MIN_CONSENSUS = 2;
const DEFAULT_REQUIRED_SUCCESSFUL_REPLICAS = 3;
const MAX_REPLICAS_PER_WORK_UNIT = 7;
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
  bandwidthMbps?: number;
  thermalState?: ProcessNodeInfo["thermalState"];
  batteryState?: ProcessNodeInfo["batteryState"];
  benchmarkScores?: ProcessNodeInfo["benchmarkScores"];
  clusterWords?: string[];
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
  metrics?: Partial<ProcessResultMetrics>;
  resultNonce?: string;
  nodePublicKey?: string;
  nodeSignature?: string;
  errorMessage?: string;
}

export interface LeaseResult {
  status: "idle" | "leased";
  job?: SignedProcessJobEnvelope;
}

export interface OrderProcessingState {
  ready: boolean;
  failed: boolean;
  processing: boolean;
  results: ProcessJobResult[];
  pendingWorkUnitIds: string[];
  failedWorkUnitIds: string[];
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
    deviceClass: inferDeviceClass(input),
    benchmarkScores: normalizeBenchmarkScores(input.benchmarkScores),
    bandwidthMbps: normalizePositiveNumber(input.bandwidthMbps, 50),
    thermalState: normalizeThermalState(input.thermalState),
    batteryState: normalizeBatteryState(input.batteryState),
    maxConcurrentJobs: normalizeConcurrency(input.maxConcurrentJobs, input.cpuCores),
    peerId: sanitizeOptionalString(input.peerId, 120),
    clusterWords: normalizeClusterWords(input.clusterWords, input),
    regionLatencyBucket: sanitizeOptionalString(input.regionLatencyBucket, 80),
    runnerFamily: sanitizeOptionalString(input.runnerFamily, 80),
    nodePublicKey: sanitizeOptionalString(input.nodePublicKey, 2000),
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
  await store.upsertNode(toSchedulableNodeProfile(node));
  await store.saveNodeCapabilitySnapshot(createCapabilitySnapshot(node, auth.user.id, now));
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
    bandwidthMbps: normalizePositiveNumber(input.bandwidthMbps, node.bandwidthMbps ?? 50),
    thermalState: normalizeThermalState(input.thermalState ?? node.thermalState),
    batteryState: normalizeBatteryState(input.batteryState ?? node.batteryState),
    benchmarkScores: normalizeBenchmarkScores(input.benchmarkScores ?? node.benchmarkScores),
    clusterWords: normalizeClusterWords(input.clusterWords ?? node.clusterWords, node),
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
  await store.upsertNode(toSchedulableNodeProfile(updated));
  await store.saveNodeCapabilitySnapshot(createCapabilitySnapshot(updated, auth.user.id, now));
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
      delete requeued.assignedMachineId;
      delete requeued.leaseExpiresAt;
      await store.saveProcessJob(requeued);
    }
  }

  const queued = chooseLeaseCandidate(await store.listProcessJobs(), node, workloads, now);

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
    assignedMachineId: node.machineId,
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

  const replayNonce = input.resultNonce ?? makeResultNonce(job, node, input.resultHash);
  const replayed = (await store.listProcessJobResults()).some((result) => result.resultNonce === replayNonce);
  if (replayed) {
    throw new ProcessError(409, "Process result nonce has already been submitted.");
  }

  if (input.nodePublicKey && input.nodeSignature) {
    verifyNodeResultSignature(input.nodePublicKey, input.nodeSignature, {
      nodeId: node.id,
      jobId: job.id,
      resultHash: input.resultHash,
      status: input.status,
      resultNonce: replayNonce
    });
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
    metrics: normalizeResultMetrics(input.durationMs, input.metrics),
    resultNonce: replayNonce,
    createdAt: now.toISOString()
  };

  if (input.nodePublicKey !== undefined) {
    result.nodePublicKey = input.nodePublicKey;
  }
  if (input.nodeSignature !== undefined) {
    result.nodeSignature = input.nodeSignature;
  }
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
  const consensus = await updateConsensusAfterResult(store, updatedJob, result, now);
  await handleSpecialProcessResult(store, auth.user.id, updatedJob, result, now);
  if (updatedJob.status === "completed" && updatedJob.provisionalMicroYen > 0 && consensus === "canonical") {
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
  const [jobs, results, transactions] = await Promise.all([
    store.listProcessJobs(),
    store.listProcessJobResultsForUser(userId),
    store.listUserTransactions(userId)
  ]);
  const userJobs = jobs.filter((job) => job.assignedUserId === userId);
  const completed = userJobs.filter((job) => job.status === "completed" && job.provisionalMicroYen > 0);
  const failed = results.filter((result) => result.status === "failed" || result.status === "rejected");
  const confirmedMicroYen = transactions
    .filter((transaction) => transaction.kind === "confirmed_earning" && transaction.status !== "failed")
    .reduce((sum, transaction) => sum + transaction.amountMicroYen, 0);

  return {
    userId,
    provisionalMicroYen: completed.reduce((sum, job) => sum + job.provisionalMicroYen, 0),
    confirmedMicroYen,
    pendingPayoutMicroYen: confirmedMicroYen,
    processedCount: completed.length,
    failedCount: failed.length,
    verificationCount: completed.filter((job) => job.workload === "proof.verify").length
  };
}

export async function getOrderProcessingState(store: DisproStore, orderId: string): Promise<OrderProcessingState> {
  const [jobs, results] = await Promise.all([store.listProcessJobs(), store.listProcessJobResults()]);
  const orderJobs = jobs.filter((job) => job.orderId === orderId);
  if (orderJobs.length === 0) {
    return {
      ready: false,
      failed: false,
      processing: false,
      results: [],
      pendingWorkUnitIds: [],
      failedWorkUnitIds: []
    };
  }

  const groups = groupJobsByLogicalUnit(orderJobs);
  const readyResults: ProcessJobResult[] = [];
  const pendingWorkUnitIds: string[] = [];
  const failedWorkUnitIds: string[] = [];

  for (const [logicalId, groupJobs] of groups) {
    const state = deriveConsensusFromJobs(logicalId, groupJobs, results);
    if (state.status === "failed") {
      failedWorkUnitIds.push(logicalId);
      continue;
    }
    if (state.status !== "canonical") {
      pendingWorkUnitIds.push(logicalId);
      continue;
    }
    readyResults.push(
      ...results.filter((result) => groupJobs.some((job) => job.id === result.jobId) && result.status === "completed")
    );
  }

  return {
    ready: pendingWorkUnitIds.length === 0 && failedWorkUnitIds.length === 0,
    failed: failedWorkUnitIds.length > 0,
    processing: orderJobs.some((job) => job.status === "leased" || job.status === "running"),
    results: readyResults,
    pendingWorkUnitIds,
    failedWorkUnitIds
  };
}

export async function createDistributedRecordForUser(
  store: DisproStore,
  user: UserAccount,
  now = new Date()
): Promise<ProcessJob> {
  return ensureUserSnapshotAnchorJob(store, user, now);
}

export async function enqueueDistributedRecordAnchorJob(
  store: DisproStore,
  userId: string,
  inputRef: JsonRecord,
  sourceId: string,
  now = new Date()
): Promise<ProcessJob> {
  return ensureSpecialJob(store, userId, "dispro.storage.anchor", sourceId, inputRef, now);
}

export async function enqueueTransactionAnchorJob(
  store: DisproStore,
  transaction: UserTransaction,
  now = new Date()
): Promise<ProcessJob> {
  return ensureTransactionAnchorJob(store, transaction, now);
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

    const replicaCount = task.kind === "compute" ? DEFAULT_TARGET_REPLICAS : Math.max(1, task.verification.requiredReplicas);
    const workUnit = createWorkUnitFromTask(plan.order.id, task, task.input as unknown as JsonRecord, now, {
      targetReplicas: replicaCount,
      minConsensus: task.kind === "compute" ? DEFAULT_MIN_CONSENSUS : 1,
      requiredSuccessfulReplicas: task.kind === "compute" ? DEFAULT_REQUIRED_SUCCESSFUL_REPLICAS : replicaCount
    });
    await store.saveWorkUnit(workUnit);

    for (let replicaIndex = 0; replicaIndex < replicaCount; replicaIndex += 1) {
      const job = createProcessJobFromTask(plan.order.id, task, task.input as unknown as JsonRecord, now, {
        workUnit,
        replicaIndex
      });
      await store.saveProcessJob(job);
      jobs.push(job);
    }
  }
  return jobs;
}

export function createWorkUnitFromTask(
  orderId: string,
  task: Pick<TaskSpec, "id" | "workload">,
  inputRef: JsonRecord,
  now = new Date(),
  options: {
    targetReplicas: number;
    minConsensus: number;
    requiredSuccessfulReplicas: number;
  } = {
    targetReplicas: DEFAULT_TARGET_REPLICAS,
    minConsensus: DEFAULT_MIN_CONSENSUS,
    requiredSuccessfulReplicas: DEFAULT_REQUIRED_SUCCESSFUL_REPLICAS
  }
): WorkUnit {
  const nowIso = now.toISOString();
  const batchKey = createBatchKey(task.workload, inputRef);
  return {
    id: makeId("wu", { orderId, taskId: task.id, workload: task.workload, batchKey }),
    orderId,
    taskId: task.id,
    workload: task.workload,
    status: "queued",
    targetReplicas: options.targetReplicas,
    minConsensus: options.minConsensus,
    requiredSuccessfulReplicas: options.requiredSuccessfulReplicas,
    maxReplicas: MAX_REPLICAS_PER_WORK_UNIT,
    batchKey,
    inputPrivacy: createInputPrivacyRef(orderId, task.id, inputRef),
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

export function createProcessJobFromTask(
  orderId: string,
  task: Pick<TaskSpec, "id" | "workload">,
  inputRef: JsonRecord,
  now = new Date(),
  options: { workUnit?: WorkUnit; replicaIndex?: number } = {}
): ProcessJob {
  const nowIso = now.toISOString();
  const batchKey = options.workUnit?.batchKey ?? createBatchKey(task.workload, inputRef);
  const inputPrivacy = options.workUnit?.inputPrivacy ?? createInputPrivacyRef(orderId, task.id, inputRef);
  return {
    id: makeId("pjob", {
      orderId,
      taskId: task.id,
      workload: task.workload,
      replicaIndex: options.replicaIndex ?? 0,
      createdAt: nowIso
    }),
    orderId,
    taskId: task.id,
    ...(options.workUnit === undefined ? {} : { workUnitId: options.workUnit.id }),
    ...(options.replicaIndex === undefined ? {} : { replicaIndex: options.replicaIndex }),
    ...(options.workUnit === undefined
      ? {}
      : {
          targetReplicas: options.workUnit.targetReplicas,
          minConsensus: options.workUnit.minConsensus,
          requiredSuccessfulReplicas: options.workUnit.requiredSuccessfulReplicas
        }),
    workload: task.workload,
    inputRef: minimizeInputRef(inputRef),
    inputPrivacy,
    batchKey,
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
    ...(job.workUnitId === undefined ? {} : { workUnitId: job.workUnitId }),
    ...(job.replicaIndex === undefined ? {} : { replicaIndex: job.replicaIndex }),
    ...(job.targetReplicas === undefined ? {} : { targetReplicas: job.targetReplicas }),
    ...(job.minConsensus === undefined ? {} : { minConsensus: job.minConsensus }),
    ...(job.requiredSuccessfulReplicas === undefined ? {} : { requiredSuccessfulReplicas: job.requiredSuccessfulReplicas }),
    workload: job.workload,
    inputRef: job.inputRef,
    ...(job.inputPrivacy === undefined ? {} : { inputPrivacy: job.inputPrivacy }),
    ...(job.batchKey === undefined ? {} : { batchKey: job.batchKey }),
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

function chooseLeaseCandidate(
  jobs: readonly ProcessJob[],
  node: ProcessNodeRecord,
  workloads: readonly string[],
  now: Date
): ProcessJob | undefined {
  const candidates = jobs
    .filter((job) => job.status === "queued")
    .filter((job) => isSupportedByNode(job.workload, workloads))
    .filter((job) => isReplicaDiverseForNode(job, node, jobs))
    .map((job) => ({
      job,
      score: scoreNodeForProcessJob(node, job) + deterministicJitter(`${node.id}:${job.id}:${now.toISOString()}`)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.job;
}

function isReplicaDiverseForNode(
  job: ProcessJob,
  node: ProcessNodeRecord,
  jobs: readonly ProcessJob[]
): boolean {
  if (!job.workUnitId) {
    return true;
  }

  return !jobs.some(
    (candidate) =>
      candidate.id !== job.id &&
      candidate.workUnitId === job.workUnitId &&
      (candidate.assignedProcessNodeId === node.id || candidate.assignedMachineId === node.machineId)
  );
}

function scoreNodeForProcessJob(node: ProcessNodeRecord, job: ProcessJob): number {
  if (node.thermalState === "hot" || node.batteryState === "low") {
    return 0;
  }

  const device = node.deviceClass ?? inferDeviceClass(node);
  const cpu = Math.min(1, Math.max(0.05, node.cpuCores / 16));
  const memory = Math.min(1, Math.max(0.05, node.memoryGb / 32));
  const bandwidth = Math.min(1, Math.max(0.05, (node.bandwidthMbps ?? 50) / 500));
  const benchmark = Math.min(1, Math.max(0.05, (node.benchmarkScores?.hash ?? node.benchmarkScores?.cpu ?? 250) / 2000));
  const fit = workloadFitForDevice(job.workload, device);
  const thermalPenalty = node.thermalState === "warm" ? 0.12 : 0;
  const batchBoost = job.batchKey && node.clusterWords?.some((word) => job.batchKey?.includes(word)) ? 0.05 : 0;

  return cpu * 0.25 + memory * 0.18 + bandwidth * 0.15 + benchmark * 0.18 + fit * 0.29 + batchBoost - thermalPenalty;
}

function workloadFitForDevice(workload: string, device: DeviceClass): number {
  if (workload === "proof.verify" || workload === "hash.compute") {
    return device === "mobile" ? 0.82 : device === "laptop" ? 0.88 : 0.95;
  }
  if (workload === "video.transcode") {
    return device === "gpu" || device === "server" ? 1 : device === "desktop" ? 0.62 : 0;
  }
  if (workload.startsWith("dispro.")) {
    return device === "mobile" ? 0.72 : 0.9;
  }
  return device === "mobile" ? 0.2 : device === "laptop" ? 0.72 : 0.9;
}

function deterministicJitter(seed: string): number {
  const hash = hashObject(seed).slice(0, 8);
  return (Number.parseInt(hash, 16) / 0xffffffff) * 0.02;
}

async function updateConsensusAfterResult(
  store: DisproStore,
  job: ProcessJob,
  result: ProcessJobResult,
  now: Date
): Promise<WorkUnitStatus> {
  if (!job.workUnitId) {
    return result.status === "completed" ? "canonical" : "failed";
  }

  const [jobs, results] = await Promise.all([store.listProcessJobs(), store.listProcessJobResults()]);
  const groupJobs = jobs.filter((candidate) => candidate.workUnitId === job.workUnitId);
  const consensus = deriveConsensusFromJobs(job.workUnitId, groupJobs, results);
  const workUnit = await store.getWorkUnit(job.workUnitId);
  const updatedWorkUnit: WorkUnit | undefined = workUnit
    ? {
        ...workUnit,
        status: consensus.status,
        canonicalResultHash: consensus.canonicalResultHash,
        canonicalJobId: consensus.canonicalJobId,
        updatedAt: now.toISOString()
      }
    : undefined;

  if (updatedWorkUnit) {
    await store.saveWorkUnit(updatedWorkUnit);
  }

  await store.saveConsensusRecord({
    id: makeId("cons", { workUnitId: job.workUnitId, updatedAt: now.toISOString() }),
    workUnitId: job.workUnitId,
    orderId: job.orderId,
    taskId: job.taskId,
    status: consensus.status,
    targetReplicas: job.targetReplicas ?? DEFAULT_TARGET_REPLICAS,
    minConsensus: job.minConsensus ?? DEFAULT_MIN_CONSENSUS,
    requiredSuccessfulReplicas: job.requiredSuccessfulReplicas ?? DEFAULT_REQUIRED_SUCCESSFUL_REPLICAS,
    successfulReplicaCount: consensus.successfulReplicaCount,
    bestResultHash: consensus.bestResultHash,
    bestResultCount: consensus.bestResultCount,
    canonicalResultHash: consensus.canonicalResultHash,
    canonicalJobId: consensus.canonicalJobId,
    participantJobIds: groupJobs.map((candidate) => candidate.id),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });

  if (consensus.status !== "canonical" && consensus.status !== "failed") {
    await maybeCreateAdditionalReplica(store, job, groupJobs, consensus, now);
  }

  return consensus.status;
}

function groupJobsByLogicalUnit(jobs: readonly ProcessJob[]): Map<string, ProcessJob[]> {
  const groups = new Map<string, ProcessJob[]>();
  for (const job of jobs) {
    const logicalId = job.workUnitId ?? job.id;
    const existing = groups.get(logicalId) ?? [];
    existing.push(job);
    groups.set(logicalId, existing);
  }
  return groups;
}

function deriveConsensusFromJobs(
  logicalId: string,
  jobs: readonly ProcessJob[],
  results: readonly ProcessJobResult[]
): {
  status: WorkUnitStatus;
  successfulReplicaCount: number;
  bestResultHash?: string | undefined;
  bestResultCount: number;
  canonicalResultHash?: string | undefined;
  canonicalJobId?: string | undefined;
} {
  const completedResults = results.filter(
    (result) => result.status === "completed" && jobs.some((job) => job.id === result.jobId)
  );
  const successfulReplicaCount = completedResults.length;
  const target = jobs[0]?.targetReplicas ?? (jobs[0]?.workUnitId ? DEFAULT_TARGET_REPLICAS : 1);
  const minConsensus = jobs[0]?.minConsensus ?? (jobs[0]?.workUnitId ? DEFAULT_MIN_CONSENSUS : 1);
  const requiredSuccessful = jobs[0]?.requiredSuccessfulReplicas ?? target;
  const counts = new Map<string, ProcessJobResult[]>();
  for (const result of completedResults) {
    const bucket = counts.get(result.resultHash) ?? [];
    bucket.push(result);
    counts.set(result.resultHash, bucket);
  }
  const best = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const bestResultHash = best?.[0];
  const bestResultCount = best?.[1].length ?? 0;
  const canonicalResultHash =
    successfulReplicaCount >= requiredSuccessful && bestResultCount >= minConsensus ? bestResultHash : undefined;
  const canonicalJobId = canonicalResultHash ? best?.[1][0]?.jobId : undefined;
  const terminalCount = jobs.filter((job) => ["completed", "failed", "rejected"].includes(job.status)).length;
  const hasActive = jobs.some((job) => job.status === "queued" || job.status === "leased" || job.status === "running");
  const maxReplicas = Math.max(...jobs.map((job) => job.targetReplicas ?? target), MAX_REPLICAS_PER_WORK_UNIT);

  if (canonicalResultHash) {
    return {
      status: "canonical",
      successfulReplicaCount,
      bestResultHash,
      bestResultCount,
      canonicalResultHash,
      canonicalJobId
    };
  }

  if (!hasActive && terminalCount >= maxReplicas) {
    return {
      status: "failed",
      successfulReplicaCount,
      bestResultHash,
      bestResultCount
    };
  }

  return {
    status: successfulReplicaCount > 0 || logicalId.startsWith("wu_") ? "replicating" : "queued",
    successfulReplicaCount,
    bestResultHash,
    bestResultCount
  };
}

async function maybeCreateAdditionalReplica(
  store: DisproStore,
  sourceJob: ProcessJob,
  groupJobs: readonly ProcessJob[],
  consensus: ReturnType<typeof deriveConsensusFromJobs>,
  now: Date
): Promise<void> {
  const active = groupJobs.some((job) => job.status === "queued" || job.status === "leased" || job.status === "running");
  const nextReplicaIndex = Math.max(...groupJobs.map((job) => job.replicaIndex ?? 0)) + 1;
  if (active || nextReplicaIndex >= MAX_REPLICAS_PER_WORK_UNIT) {
    return;
  }
  const replica: ProcessJob = {
    ...sourceJob,
    id: makeId("pjob", {
      orderId: sourceJob.orderId,
      taskId: sourceJob.taskId,
      workload: sourceJob.workload,
      replicaIndex: nextReplicaIndex,
      createdAt: now.toISOString()
    }),
    status: "queued",
    replicaIndex: nextReplicaIndex,
    nonce: randomBytes(16).toString("hex"),
    attempts: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  delete replica.expiresAt;
  delete replica.assignedProcessNodeId;
  delete replica.assignedUserId;
  delete replica.assignedMachineId;
  delete replica.leaseExpiresAt;
  await store.saveProcessJob(replica);
}

function createBatchKey(workload: string, inputRef: JsonRecord): string {
  return [
    "batch",
    workload,
    String(inputRef.chunk && typeof inputRef.chunk === "object" ? "chunked" : "inline"),
    hashObject({ workload, parameters: inputRef.parameters ?? {}, chunkSize: estimateInputBytes(inputRef) }).slice(0, 16)
  ].join(":");
}

function createInputPrivacyRef(orderId: string, taskId: string, inputRef: JsonRecord): JsonRecord {
  const payloadHash = hashObject(inputRef);
  return {
    encrypted: true,
    scheme: "aes-256-gcm-envelope-ref",
    keyScope: "per-order-per-chunk",
    plaintextRequiredAtRunner: true,
    payloadHash,
    chunkKeyRef: `local-key-${hashObject({ orderId, taskId, payloadHash }).slice(0, 32)}`,
    metadataPolicy: "minimal"
  };
}

function minimizeInputRef(inputRef: JsonRecord): JsonRecord {
  const minimized: JsonRecord = { ...inputRef };
  delete minimized.customerId;
  delete minimized.customerName;
  delete minimized.email;
  delete minimized.fileName;
  delete minimized.originalFileName;
  if (typeof minimized.sourceUri === "string") {
    minimized.sourceRef = hashObject({ sourceUri: minimized.sourceUri });
    delete minimized.sourceUri;
  }
  return minimized;
}

function estimateInputBytes(inputRef: JsonRecord): number {
  if (typeof inputRef.byteSize === "number") {
    return inputRef.byteSize;
  }
  if (typeof inputRef.estimatedBytes === "number") {
    return inputRef.estimatedBytes;
  }
  return Buffer.byteLength(stableStringify(inputRef), "utf8");
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
        relatedJobId: transaction.relatedJobId,
        relatedOrderId: transaction.relatedOrderId,
        stripePaymentIntentId: transaction.stripePaymentIntentId,
        settlementId: transaction.settlementId,
        contributionUnits: transaction.contributionUnits,
        contributionShareBps: transaction.contributionShareBps
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
  const updateTarget = processUpdateTargetFor(node);
  const updateVersion = updateTarget.version;
  const downloadUrl = updateTarget.downloadUrl;
  const sha256 = updateTarget.sha256;
  if (!updateVersion || !downloadUrl || !sha256 || updateVersion === currentVersion) {
    return undefined;
  }

  const updateRef = await getProcessUpdateRef(updateTarget.refPlatform, now).catch(() => undefined);
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
        platform: updateTarget.platform,
        channel: updateTarget.channel,
        downloadUrl,
        sha256,
        mandatory: updateTarget.mandatory,
        notes: updateTarget.notes,
        webStoreUrl: updateTarget.webStoreUrl,
        playStoreUrl: updateTarget.playStoreUrl,
        updateRef: updateRef?.ref ?? `refs/process/${updateTarget.refPlatform}/stable`,
        updateCommit: updateRef?.commit.id ?? "",
        updateTree: updateRef?.commit.tree ?? "",
        updateSignature: updateRef?.commit.signature ?? "",
        updatePublicKey: updateRef?.publicKey ?? ""
      }
    },
    now
  );
}

function processUpdateTargetFor(node: ProcessNodeRecord): {
  platform: "win32" | "linux" | "chrome" | "android";
  refPlatform: "windows" | "linux" | "chrome" | "android";
  version: string | undefined;
  downloadUrl: string | undefined;
  sha256: string | undefined;
  channel: string;
  mandatory: boolean;
  notes: string;
  webStoreUrl: string;
  playStoreUrl: string;
} {
  if (node.runnerFamily?.startsWith("chrome-extension-")) {
    return {
      platform: "chrome",
      refPlatform: "chrome",
      version: process.env.DISPRO_CHROME_PROCESS_UPDATE_VERSION,
      downloadUrl: process.env.DISPRO_CHROME_PROCESS_UPDATE_URL,
      sha256: process.env.DISPRO_CHROME_PROCESS_UPDATE_SHA256,
      channel: process.env.DISPRO_CHROME_PROCESS_UPDATE_CHANNEL ?? "stable",
      mandatory: process.env.DISPRO_CHROME_PROCESS_UPDATE_MANDATORY === "true",
      notes: process.env.DISPRO_CHROME_PROCESS_UPDATE_NOTES ?? "",
      webStoreUrl: process.env.DISPRO_CHROME_PROCESS_WEB_STORE_URL ?? "",
      playStoreUrl: ""
    };
  }

  if (node.runnerFamily?.startsWith("android-process-")) {
    return {
      platform: "android",
      refPlatform: "android",
      version: process.env.DISPRO_ANDROID_PROCESS_UPDATE_VERSION,
      downloadUrl: process.env.DISPRO_ANDROID_PROCESS_UPDATE_URL,
      sha256: process.env.DISPRO_ANDROID_PROCESS_UPDATE_SHA256,
      channel: process.env.DISPRO_ANDROID_PROCESS_UPDATE_CHANNEL ?? "stable",
      mandatory: process.env.DISPRO_ANDROID_PROCESS_UPDATE_MANDATORY === "true",
      notes: process.env.DISPRO_ANDROID_PROCESS_UPDATE_NOTES ?? "",
      webStoreUrl: "",
      playStoreUrl: process.env.DISPRO_ANDROID_PROCESS_PLAY_STORE_URL ?? ""
    };
  }

  return {
    platform: node.os.toLowerCase().includes("linux") ? "linux" : "win32",
    refPlatform: node.os.toLowerCase().includes("linux") ? "linux" : "windows",
    version: node.os.toLowerCase().includes("linux")
      ? process.env.DISPRO_LINUX_PROCESS_UPDATE_VERSION
      : process.env.DISPRO_PROCESS_UPDATE_VERSION,
    downloadUrl: node.os.toLowerCase().includes("linux")
      ? process.env.DISPRO_LINUX_PROCESS_UPDATE_URL
      : process.env.DISPRO_PROCESS_UPDATE_URL,
    sha256: node.os.toLowerCase().includes("linux")
      ? process.env.DISPRO_LINUX_PROCESS_UPDATE_SHA256
      : process.env.DISPRO_PROCESS_UPDATE_SHA256,
    channel: node.os.toLowerCase().includes("linux")
      ? process.env.DISPRO_LINUX_PROCESS_UPDATE_CHANNEL ?? "stable"
      : process.env.DISPRO_PROCESS_UPDATE_CHANNEL ?? "stable",
    mandatory: node.os.toLowerCase().includes("linux")
      ? process.env.DISPRO_LINUX_PROCESS_UPDATE_MANDATORY === "true"
      : process.env.DISPRO_PROCESS_UPDATE_MANDATORY === "true",
    notes: node.os.toLowerCase().includes("linux")
      ? process.env.DISPRO_LINUX_PROCESS_UPDATE_NOTES ?? ""
      : process.env.DISPRO_PROCESS_UPDATE_NOTES ?? "",
    webStoreUrl: "",
    playStoreUrl: ""
  };
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
  const recordType = parseDistributedRecordType(
    job.inputRef.recordType,
    job.workload === "dispro.app.update" ? "app.update" : job.workload === "dispro.transaction.anchor" ? "transaction" : "user.profile"
  );
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

function parseDistributedRecordType(value: unknown, fallback: DistributedRecord["type"]): DistributedRecord["type"] {
  return value === "user.profile" ||
    value === "transaction" ||
    value === "process.result" ||
    value === "app.update" ||
    value === "order.contract" ||
    value === "order.result" ||
    value === "billing.charge" ||
    value === "revenue.distribution"
    ? value
    : fallback;
}

function normalizeResultMetrics(durationMs: number, metrics: Partial<ProcessResultMetrics> | undefined): ProcessResultMetrics {
  const normalized: ProcessResultMetrics = {
    durationMs: Math.max(0, durationMs)
  };

  if (!metrics) {
    return normalized;
  }

  assignPositiveNumber(normalized, "inputBytes", metrics.inputBytes);
  assignPositiveNumber(normalized, "outputBytes", metrics.outputBytes);
  assignPositiveNumber(normalized, "computeUnits", metrics.computeUnits);
  assignPositiveNumber(normalized, "runnerWorkUnits", metrics.runnerWorkUnits);
  return normalized;
}

function assignPositiveNumber(
  target: ProcessResultMetrics,
  key: "inputBytes" | "outputBytes" | "computeUnits" | "runnerWorkUnits",
  value: unknown
): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    target[key] = value;
  }
}

function verifyNodeResultSignature(
  publicKey: string,
  signature: string,
  payload: { nodeId: string; jobId: string; resultHash: string; status: ProcessResultStatus; resultNonce: string }
): void {
  try {
    const valid = verify(null, Buffer.from(stableStringify(payload)), publicKey, Buffer.from(signature, "base64url"));
    if (!valid) {
      throw new ProcessError(401, "Process result signature is invalid.");
    }
  } catch (error) {
    if (error instanceof ProcessError) {
      throw error;
    }
    throw new ProcessError(401, "Process result signature is malformed.");
  }
}

function makeResultNonce(job: ProcessJob, node: ProcessNodeRecord, resultHash: string): string {
  return makeId("rnonce", {
    jobId: job.id,
    nodeId: node.id,
    nonce: job.nonce,
    resultHash
  });
}

async function requireOwnedNode(store: DisproStore, auth: AuthContext, nodeId: string): Promise<ProcessNodeRecord> {
  const node = await store.getProcessNode(nodeId);
  if (!node || node.userId !== auth.user.id) {
    throw new ProcessError(404, "Process node not found.");
  }
  return node;
}

function toSchedulableNodeProfile(node: ProcessNodeRecord): NodeProfile {
  const deviceClass = node.deviceClass ?? inferDeviceClass(node);
  const benchmarkScore = node.benchmarkScores?.hash ?? node.benchmarkScores?.cpu ?? node.cpuCores * 120;
  const trustScore = Math.min(0.95, 0.55 + Math.log10(Math.max(1, benchmarkScore)) / 10);
  const currentLeases = node.currentJobId ? 1 : 0;

  return {
    id: node.id,
    deviceClass,
    capabilities: {
      cpuCores: node.cpuCores,
      memoryGb: node.memoryGb,
      bandwidthMbps: node.bandwidthMbps ?? 50,
      hasGpu: deviceClass === "gpu" || node.supportedWorkloads.some((workload) => workload.includes("gpu")),
      supportedWorkloads: node.supportedWorkloads
    },
    reputation: {
      trustScore,
      successRate: 0.96,
      uptimeRatio: node.mode === "stopped" ? 0.4 : 0.8,
      disputeRate: 0.02,
      completedTasks: 0,
      responseP95Ms: deviceClass === "mobile" ? 4000 : 1800
    },
    availability: {
      online: node.mode !== "stopped" && node.mode !== "error",
      canAcceptCompute: node.mode !== "stopped" && node.thermalState !== "hot" && node.batteryState !== "low",
      canAcceptVerification: node.mode !== "stopped",
      maxTaskBytes: maxTaskBytesForNode(node),
      maxConcurrentTasks: node.maxConcurrentJobs ?? normalizeConcurrency(undefined, node.cpuCores),
      currentLeases
    },
    telemetry: {
      loadAverage: currentLeases > 0 ? 0.7 : 0.2
    }
  };
}

function createCapabilitySnapshot(
  node: ProcessNodeRecord,
  userId: string,
  now: Date
): NodeCapabilitySnapshot {
  return {
    id: makeId("caps", { nodeId: node.id, capturedAt: now.toISOString() }),
    processNodeId: node.id,
    userId,
    deviceClass: node.deviceClass ?? inferDeviceClass(node),
    cpuCores: node.cpuCores,
    memoryGb: node.memoryGb,
    bandwidthMbps: node.bandwidthMbps ?? 50,
    benchmarkScores: node.benchmarkScores ?? {},
    thermalState: node.thermalState ?? "nominal",
    batteryState: node.batteryState ?? "unknown",
    maxConcurrentJobs: node.maxConcurrentJobs ?? normalizeConcurrency(undefined, node.cpuCores),
    supportedWorkloads: node.supportedWorkloads,
    clusterWords: node.clusterWords ?? normalizeClusterWords(undefined, node),
    capturedAt: now.toISOString()
  };
}

function maxTaskBytesForNode(node: ProcessNodeRecord): number {
  const deviceClass = node.deviceClass ?? inferDeviceClass(node);
  if (deviceClass === "mobile") {
    return 2_000_000;
  }
  if (deviceClass === "laptop") {
    return 32_000_000;
  }
  if (deviceClass === "desktop") {
    return 96_000_000;
  }
  return 256_000_000;
}

function inferDeviceClass(
  input: Pick<ProcessNodeInfo, "cpuCores" | "memoryGb"> & {
    deviceClass?: DeviceClass | undefined;
    supportedWorkloads?: string[] | undefined;
  }
): DeviceClass {
  if (input.deviceClass) {
    return input.deviceClass;
  }
  const workloads = input.supportedWorkloads ?? [];
  if (workloads.some((workload) => workload.includes("gpu"))) {
    return "gpu";
  }
  if (input.cpuCores >= 24 || input.memoryGb >= 96) {
    return "server";
  }
  if (input.cpuCores >= 12 || input.memoryGb >= 24) {
    return "desktop";
  }
  if (input.cpuCores >= 4 || input.memoryGb >= 6) {
    return "laptop";
  }
  return "mobile";
}

function normalizeBenchmarkScores(value: ProcessNodeInfo["benchmarkScores"]): ProcessNodeInfo["benchmarkScores"] {
  if (!value) {
    return {};
  }
  const result: NonNullable<ProcessNodeInfo["benchmarkScores"]> = {};
  if (typeof value.cpu === "number" && Number.isFinite(value.cpu) && value.cpu >= 0) {
    result.cpu = value.cpu;
  }
  if (typeof value.memory === "number" && Number.isFinite(value.memory) && value.memory >= 0) {
    result.memory = value.memory;
  }
  if (typeof value.hash === "number" && Number.isFinite(value.hash) && value.hash >= 0) {
    result.hash = value.hash;
  }
  return result;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeConcurrency(value: unknown, cpuCores: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(16, Math.max(1, Math.floor(value)));
  }
  return Math.min(8, Math.max(1, Math.floor(cpuCores / 2)));
}

function normalizeThermalState(value: unknown): NonNullable<ProcessNodeInfo["thermalState"]> {
  return value === "warm" || value === "hot" || value === "nominal" ? value : "nominal";
}

function normalizeBatteryState(value: unknown): NonNullable<ProcessNodeInfo["batteryState"]> {
  return value === "plugged" || value === "battery" || value === "low" || value === "unknown" ? value : "unknown";
}

function sanitizeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

function normalizeClusterWords(value: unknown, input: Pick<ProcessNodeInfo, "supportedWorkloads"> & Partial<ProcessNodeInfo>): string[] {
  const words = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const base = [
    ...(input.supportedWorkloads ?? []).map((workload) => workload.split(".")[0] ?? workload),
    inferDeviceClass({
      cpuCores: input.cpuCores ?? 4,
      memoryGb: input.memoryGb ?? 8,
      deviceClass: input.deviceClass,
      supportedWorkloads: input.supportedWorkloads
    }),
    input.runnerFamily ?? "runner-v1",
    input.regionLatencyBucket ?? "global"
  ];
  return [...new Set([...words, ...base].map((word) => word.trim().toLowerCase()).filter(Boolean))].slice(0, 16);
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
