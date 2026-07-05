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
  keyPrefix: string;
  keyHash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}
