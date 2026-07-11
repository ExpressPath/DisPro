export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export type KnownWorkloadKind =
  | "image.convert"
  | "pdf.compress"
  | "video.transcode"
  | "data.transform"
  | "proof.verify"
  | "code.test"
  | "hash.compute";
export type WorkloadKind = KnownWorkloadKind | (string & {});

export type Priority = "economy" | "standard" | "urgent";
export type VerificationLevel = "light" | "standard" | "strict";
export type DeviceClass = "mobile" | "laptop" | "desktop" | "gpu" | "server";
export type TaskKind = "compute" | "verification" | "canary";
export type AssignmentRole = "compute" | "verification" | "canary";

export interface OrderInputSource {
  kind: "file" | "folder" | "url" | "code" | "proof";
  uri: string;
  byteSize: number;
  contentHash: string;
}

export interface OrderRequirements {
  maxChunkBytes?: number;
  requiresGpu?: boolean;
  minTrustScore?: number;
  deterministic?: boolean;
  allowMobileVerification?: boolean;
  region?: string;
  /** Prepaid operation envelope for isolated code runners; never billed by wall-clock time. */
  executionCredits?: number;
  /** Only the server-side egress proxy may use these hosts. */
  allowedEgressHosts?: string[];
  workloadProfile?: WorkloadProfileOverrides;
}

export interface WorkloadProfileOverrides {
  label?: string;
  unitBytes?: number;
  defaultChunkBytes?: number;
  baseMicroYen?: number;
  computeMicroYenPerUnit?: number;
  estimatedSecondsPerUnit?: number;
  estimatedMemoryGb?: number;
  gpuPreferred?: boolean;
  deterministic?: boolean;
}

export interface OrderRequest {
  id?: string;
  customerId: string;
  source: OrderInputSource;
  workload: WorkloadKind;
  parameters?: JsonRecord;
  priority?: Priority;
  verificationLevel?: VerificationLevel;
  submittedAt?: string;
  requirements?: OrderRequirements;
}

export interface Order {
  id: string;
  customerId: string;
  source: OrderInputSource;
  workload: WorkloadKind;
  parameters: JsonRecord;
  priority: Priority;
  verificationLevel: VerificationLevel;
  submittedAt: string;
  requirements: OrderRequirements;
}

export interface WorkloadProfile {
  workload: WorkloadKind;
  label: string;
  unitBytes: number;
  defaultChunkBytes: number;
  baseMicroYen: number;
  computeMicroYenPerUnit: number;
  estimatedSecondsPerUnit: number;
  estimatedMemoryGb: number;
  gpuPreferred: boolean;
  deterministic: boolean;
}

export interface PriceQuote {
  currency: "JPY_MICRO";
  computeUnits: number;
  dataUnits: number;
  executionCredits: number;
  inputBytes: number;
  baseMicroYen: number;
  computeMicroYen: number;
  verificationMicroYen: number;
  priorityMultiplier: number;
  subtotalMicroYen: number;
  platformFeeRate: number;
  platformFeeMicroYen: number;
  totalMicroYen: number;
}

export interface TaskChunk {
  index: number;
  total: number;
  byteStart: number;
  byteEnd: number;
}

export interface TaskInputRef {
  sourceUri: string;
  sourceHash: string;
  chunk: TaskChunk;
}

export interface TaskRequirements {
  allowedDeviceClasses: DeviceClass[];
  requiresGpu: boolean;
  minTrustScore: number;
  estimatedMemoryGb: number;
  maxRuntimeSeconds: number;
}

export interface TaskVerificationPolicy {
  level: VerificationLevel;
  strategy: "primary" | "random-sample" | "known-answer";
  requiredReplicas: number;
  verificationOfTaskId?: string;
  canaryAnswerHash?: string;
}

export interface TaskSpec {
  id: string;
  orderId: string;
  kind: TaskKind;
  workload: WorkloadKind;
  estimatedBytes: number;
  estimatedComputeUnits: number;
  input: TaskInputRef;
  requirements: TaskRequirements;
  verification: TaskVerificationPolicy;
}

export interface NodeCapabilities {
  cpuCores: number;
  memoryGb: number;
  bandwidthMbps: number;
  hasGpu: boolean;
  supportedWorkloads: string[];
}

export interface NodeReputation {
  trustScore: number;
  successRate: number;
  uptimeRatio: number;
  disputeRate: number;
  completedTasks: number;
  responseP95Ms: number;
}

export interface NodeAvailability {
  online: boolean;
  canAcceptCompute: boolean;
  canAcceptVerification: boolean;
  maxTaskBytes: number;
  maxConcurrentTasks: number;
  currentLeases: number;
}

export interface NodeTelemetry {
  batteryPercent?: number;
  temperatureC?: number;
  loadAverage?: number;
}

export interface NodeProfile {
  id: string;
  deviceClass: DeviceClass;
  capabilities: NodeCapabilities;
  reputation: NodeReputation;
  availability: NodeAvailability;
  telemetry?: NodeTelemetry;
}

export interface ScoreBreakdown {
  performance: number;
  trust: number;
  network: number;
  availability: number;
  workloadFit: number;
  penalty: number;
}

export interface NodeScore {
  nodeId: string;
  taskId: string;
  eligible: boolean;
  score: number;
  reasons: string[];
  breakdown: ScoreBreakdown;
}

export interface TaskAssignment {
  id: string;
  taskId: string;
  nodeId: string;
  role: AssignmentRole;
  score: number;
  assignedAt: string;
  leaseExpiresAt: string;
}

export interface UnassignedTask {
  taskId: string;
  reasons: string[];
}

export interface AuditEvent {
  id: string;
  type: string;
  orderId: string;
  taskId?: string;
  actorNodeId?: string;
  payloadHash: string;
  previousHash: string;
  eventHash: string;
  createdAt: string;
}

export interface PlannedOrder {
  order: Order;
  quote: PriceQuote;
  tasks: TaskSpec[];
  assignments: TaskAssignment[];
  unassignedTasks: UnassignedTask[];
  auditEvents: AuditEvent[];
}

export interface UserAccount {
  id: string;
  email: string;
  status: "pending" | "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  lastSignedInAt?: string;
}

export interface EmailSignInChallenge {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface UserSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export interface UserApiKey {
  id: string;
  userId: string;
  label: string;
  purpose: "general" | "process" | "use";
  keyPrefix: string;
  keyHash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface BillingCustomer {
  userId: string;
  stripeCustomerId: string;
  defaultPaymentMethodId?: string;
  setupComplete: boolean;
  stripeConnectAccountId?: string;
  payoutsEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProcessNodeMode = "idle" | "waiting" | "running" | "stopped" | "error";
export type ProcessJobStatus = "queued" | "leased" | "running" | "completed" | "failed" | "rejected";
export type WorkUnitStatus = "queued" | "replicating" | "canonical" | "failed";
export type ProcessPaymentMode = "internal" | "external" | "smart_contract";
export type ProcessResultStatus = "completed" | "failed" | "rejected";
export type DistributedRecordType =
  | "user.profile"
  | "transaction"
  | "process.result"
  | "app.update"
  | "order.contract"
  | "order.result"
  | "billing.charge"
  | "revenue.distribution";
export type DistributedStorageProvider = "ipfs" | "filecoin" | "arweave" | "local";

export interface ProcessNodeInfo {
  machineId: string;
  deviceName: string;
  os: string;
  appVersion: string;
  cpuCores: number;
  memoryGb: number;
  supportedWorkloads: string[];
  deviceClass?: DeviceClass | undefined;
  benchmarkScores?: NodeBenchmarkScores | undefined;
  bandwidthMbps?: number | undefined;
  thermalState?: "nominal" | "warm" | "hot" | undefined;
  batteryState?: "plugged" | "battery" | "low" | "unknown" | undefined;
  maxConcurrentJobs?: number | undefined;
  peerId?: string | undefined;
  clusterWords?: string[] | undefined;
  regionLatencyBucket?: string | undefined;
  runnerFamily?: string | undefined;
  nodePublicKey?: string | undefined;
}

export interface NodeBenchmarkScores {
  cpu?: number | undefined;
  memory?: number | undefined;
  hash?: number | undefined;
}

export interface ProcessNodeRecord {
  id: string;
  userId: string;
  machineId: string;
  deviceName: string;
  os: string;
  appVersion: string;
  cpuCores: number;
  memoryGb: number;
  supportedWorkloads: string[];
  deviceClass?: DeviceClass | undefined;
  benchmarkScores?: NodeBenchmarkScores | undefined;
  bandwidthMbps?: number | undefined;
  thermalState?: "nominal" | "warm" | "hot" | undefined;
  batteryState?: "plugged" | "battery" | "low" | "unknown" | undefined;
  maxConcurrentJobs?: number | undefined;
  peerId?: string | undefined;
  clusterWords?: string[] | undefined;
  regionLatencyBucket?: string | undefined;
  runnerFamily?: string | undefined;
  nodePublicKey?: string | undefined;
  mode: ProcessNodeMode;
  currentJobId?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeCapabilitySnapshot {
  id: string;
  processNodeId: string;
  userId: string;
  deviceClass: DeviceClass;
  cpuCores: number;
  memoryGb: number;
  bandwidthMbps: number;
  benchmarkScores: NodeBenchmarkScores;
  thermalState: "nominal" | "warm" | "hot";
  batteryState: "plugged" | "battery" | "low" | "unknown";
  maxConcurrentJobs: number;
  supportedWorkloads: string[];
  clusterWords: string[];
  capturedAt: string;
}

export interface WorkUnit {
  id: string;
  orderId: string;
  taskId: string;
  workload: string;
  status: WorkUnitStatus;
  targetReplicas: number;
  minConsensus: number;
  requiredSuccessfulReplicas: number;
  maxReplicas: number;
  canonicalResultHash?: string | undefined;
  canonicalJobId?: string | undefined;
  batchKey: string;
  inputPrivacy: JsonRecord;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessJob {
  id: string;
  orderId: string;
  taskId: string;
  workUnitId?: string | undefined;
  replicaIndex?: number | undefined;
  targetReplicas?: number | undefined;
  minConsensus?: number | undefined;
  requiredSuccessfulReplicas?: number | undefined;
  workload: string;
  inputRef: JsonRecord;
  inputPrivacy?: JsonRecord | undefined;
  batchKey?: string | undefined;
  contractHash: string;
  cid: string;
  paymentMode: ProcessPaymentMode;
  status: ProcessJobStatus;
  nonce: string;
  attempts: number;
  provisionalMicroYen: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  assignedProcessNodeId?: string;
  assignedUserId?: string;
  assignedMachineId?: string | undefined;
  leaseExpiresAt?: string;
}

export interface SignedProcessJobEnvelope {
  jobId: string;
  orderId: string;
  taskId: string;
  workUnitId?: string | undefined;
  replicaIndex?: number | undefined;
  targetReplicas?: number | undefined;
  minConsensus?: number | undefined;
  requiredSuccessfulReplicas?: number | undefined;
  workload: string;
  inputRef: JsonRecord;
  inputPrivacy?: JsonRecord | undefined;
  batchKey?: string | undefined;
  contractHash: string;
  cid: string;
  paymentMode: ProcessPaymentMode;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface ProcessJobResult {
  id: string;
  jobId: string;
  processNodeId: string;
  userId: string;
  status: ProcessResultStatus;
  resultHash: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  metrics?: ProcessResultMetrics;
  resultNonce?: string | undefined;
  nodePublicKey?: string | undefined;
  nodeSignature?: string | undefined;
  canonical?: boolean | undefined;
  errorMessage?: string;
  createdAt: string;
}

export interface ProcessResultMetrics {
  durationMs: number;
  inputBytes?: number;
  outputBytes?: number;
  computeUnits?: number;
  runnerWorkUnits?: number;
}

export interface ProcessEarnings {
  userId: string;
  provisionalMicroYen: number;
  confirmedMicroYen: number;
  pendingPayoutMicroYen: number;
  processedCount: number;
  failedCount: number;
  verificationCount: number;
}

export interface ConsensusRecord {
  id: string;
  workUnitId: string;
  orderId: string;
  taskId: string;
  status: WorkUnitStatus;
  targetReplicas: number;
  minConsensus: number;
  requiredSuccessfulReplicas: number;
  successfulReplicaCount: number;
  bestResultHash?: string | undefined;
  bestResultCount: number;
  canonicalResultHash?: string | undefined;
  canonicalJobId?: string | undefined;
  participantJobIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DistributedRecord {
  id: string;
  userId: string;
  type: DistributedRecordType;
  provider: DistributedStorageProvider;
  cid: string;
  contractHash: string;
  payloadHash: string;
  sourceId?: string;
  status: "pending" | "anchored" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface UserTransaction {
  id: string;
  userId: string;
  kind:
    | "provisional_earning"
    | "confirmed_earning"
    | "external_payment"
    | "smart_contract_payment"
    | "usage_charge"
    | "stripe_payment"
    | "stripe_payment_failed"
    | "platform_fee";
  amountMicroYen: number;
  currency: "JPY_MICRO" | "USDC" | "ETH";
  status: "pending" | "anchored" | "failed" | "settled";
  relatedJobId?: string;
  relatedOrderId?: string;
  stripePaymentIntentId?: string;
  distributedRecordId?: string;
  settlementId?: string;
  contributionUnits?: number;
  contributionShareBps?: number;
  createdAt: string;
  updatedAt: string;
}

export type UseOrderStatus =
  | "queued"
  | "processing"
  | "completed"
  | "paid"
  | "payment_pending"
  | "payment_failed"
  | "failed";

export type UseOrderBillingStatus = "requires_payment_method" | "pending" | "held" | "paid" | "failed";

export interface UseOrderResultRef {
  resultHash: string;
  resultUrl?: string;
  resultCid?: string;
  outputBytes?: number;
  completedAt: string;
}

export interface UseOrderRecord {
  id: string;
  userId: string;
  plannedOrderId: string;
  status: UseOrderStatus;
  billingStatus: UseOrderBillingStatus;
  estimatedMicroYen: number;
  maxChargeMicroYen: number;
  finalMicroYen?: number;
  billedMicroYen?: number;
  platformFeeMicroYen?: number;
  workerPoolMicroYen?: number;
  distributionStatus?: "pending" | "settled";
  stripePaymentIntentId?: string;
  contractHash: string;
  cid: string;
  metrics: ProcessResultMetrics;
  inputPrivacy?: JsonRecord;
  result?: UseOrderResultRef;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
