import type { JsonRecord, Order, OrderRequest, Priority, VerificationLevel, WorkloadProfileOverrides } from "./types.js";
import { makeId } from "./ids.js";

const DEFAULT_PRIORITY: Priority = "standard";
const DEFAULT_VERIFICATION_LEVEL: VerificationLevel = "standard";

export function normalizeOrderRequest(request: OrderRequest, now = new Date()): Order {
  validateOrderRequest(request);

  const submittedAt = request.submittedAt ?? now.toISOString();
  const priority = request.priority ?? DEFAULT_PRIORITY;
  const verificationLevel = request.verificationLevel ?? DEFAULT_VERIFICATION_LEVEL;
  const parameters: JsonRecord = request.parameters ?? {};
  const requirements = request.requirements ?? {};

  const id =
    request.id ??
    makeId("ord", {
      customerId: request.customerId,
      sourceHash: request.source.contentHash,
      workload: request.workload,
      submittedAt
    });

  return {
    id,
    customerId: request.customerId,
    source: request.source,
    workload: request.workload,
    parameters,
    priority,
    verificationLevel,
    submittedAt,
    requirements
  };
}

function validateOrderRequest(request: OrderRequest): void {
  if (request.customerId.trim().length === 0) {
    throw new Error("customerId is required.");
  }

  if (request.source.uri.trim().length === 0) {
    throw new Error("source.uri is required.");
  }

  if (request.source.contentHash.trim().length < 16) {
    throw new Error("source.contentHash must be at least 16 characters.");
  }

  if (typeof request.workload !== "string" || request.workload.trim().length === 0) {
    throw new Error("workload is required.");
  }

  if (!Number.isFinite(request.source.byteSize) || request.source.byteSize < 0) {
    throw new Error("source.byteSize must be a non-negative number.");
  }

  const maxChunkBytes = request.requirements?.maxChunkBytes;
  if (maxChunkBytes !== undefined && (!Number.isFinite(maxChunkBytes) || maxChunkBytes <= 0)) {
    throw new Error("requirements.maxChunkBytes must be positive when provided.");
  }

  validateWorkloadProfile(request.requirements?.workloadProfile);
  validateExecutionEnvelope(request.requirements);
}

function validateExecutionEnvelope(requirements: OrderRequest["requirements"]): void {
  const credits = requirements?.executionCredits;
  if (credits !== undefined && (!Number.isInteger(credits) || credits < 0 || credits > 100)) {
    throw new Error("requirements.executionCredits must be an integer between 0 and 100.");
  }
  const hosts = requirements?.allowedEgressHosts;
  if (hosts !== undefined && (!Array.isArray(hosts) || hosts.some((host) => !/^[a-z0-9.-]+$/i.test(host)))) {
    throw new Error("requirements.allowedEgressHosts must contain valid host names.");
  }
}

function validateWorkloadProfile(profile: WorkloadProfileOverrides | undefined): void {
  if (profile === undefined) {
    return;
  }

  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new Error("requirements.workloadProfile must be an object when provided.");
  }

  validatePositive(profile.unitBytes, "requirements.workloadProfile.unitBytes");
  validatePositive(profile.defaultChunkBytes, "requirements.workloadProfile.defaultChunkBytes");
  validateNonNegative(profile.baseMicroYen, "requirements.workloadProfile.baseMicroYen");
  validateNonNegative(profile.computeMicroYenPerUnit, "requirements.workloadProfile.computeMicroYenPerUnit");
  validatePositive(profile.estimatedSecondsPerUnit, "requirements.workloadProfile.estimatedSecondsPerUnit");
  validatePositive(profile.estimatedMemoryGb, "requirements.workloadProfile.estimatedMemoryGb");
}

function validatePositive(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${field} must be positive when provided.`);
  }
}

function validateNonNegative(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${field} must be non-negative when provided.`);
  }
}
