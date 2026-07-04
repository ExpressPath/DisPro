import type { NodeProfile, NodeScore, ScoreBreakdown, TaskSpec } from "./types.js";
import { supportsWorkload } from "./workloads.js";

export function scoreNodeForTask(task: TaskSpec, node: NodeProfile): NodeScore {
  const reasons: string[] = [];

  if (!node.availability.online) {
    reasons.push("node is offline");
  }

  if (!supportsWorkload(node.capabilities.supportedWorkloads, task.workload)) {
    reasons.push(`workload ${task.workload} is not supported`);
  }

  if (!task.requirements.allowedDeviceClasses.includes(node.deviceClass)) {
    reasons.push(`device class ${node.deviceClass} is not allowed`);
  }

  if (task.requirements.requiresGpu && !node.capabilities.hasGpu) {
    reasons.push("gpu is required");
  }

  if (task.kind === "verification" && !node.availability.canAcceptVerification) {
    reasons.push("node does not accept verification tasks");
  }

  if ((task.kind === "compute" || task.kind === "canary") && !node.availability.canAcceptCompute) {
    reasons.push("node does not accept compute tasks");
  }

  if (node.availability.maxTaskBytes < task.estimatedBytes) {
    reasons.push("task exceeds node max task bytes");
  }

  if (node.availability.currentLeases >= node.availability.maxConcurrentTasks) {
    reasons.push("node has no free lease slots");
  }

  if (node.capabilities.memoryGb < task.requirements.estimatedMemoryGb) {
    reasons.push("node memory is below task requirement");
  }

  if (node.reputation.trustScore < task.requirements.minTrustScore) {
    reasons.push("node trust score is below task requirement");
  }

  const breakdown = calculateBreakdown(task, node);
  const rawScore =
    breakdown.performance * 0.28 +
    breakdown.trust * 0.34 +
    breakdown.network * 0.14 +
    breakdown.availability * 0.14 +
    breakdown.workloadFit * 0.1 -
    breakdown.penalty;
  const score = reasons.length > 0 ? 0 : clamp(Math.round(rawScore * 100), 0, 100);

  return {
    nodeId: node.id,
    taskId: task.id,
    eligible: reasons.length === 0,
    score,
    reasons,
    breakdown
  };
}

function calculateBreakdown(task: TaskSpec, node: NodeProfile): ScoreBreakdown {
  const cpu = clamp(node.capabilities.cpuCores / 16, 0, 1);
  const memory = clamp(node.capabilities.memoryGb / Math.max(task.requirements.estimatedMemoryGb * 4, 1), 0, 1);
  const gpu = node.capabilities.hasGpu ? 1 : 0;
  const performance = clamp(cpu * 0.55 + memory * 0.3 + gpu * 0.15, 0, 1);

  const completedConfidence = clamp(Math.log10(node.reputation.completedTasks + 1) / 4, 0, 1);
  const trust = clamp(
    node.reputation.trustScore * 0.45 +
      node.reputation.successRate * 0.25 +
      node.reputation.uptimeRatio * 0.15 +
      (1 - node.reputation.disputeRate) * 0.1 +
      completedConfidence * 0.05,
    0,
    1
  );

  const network = clamp(node.capabilities.bandwidthMbps / 500, 0, 1);
  const freeSlots = Math.max(0, node.availability.maxConcurrentTasks - node.availability.currentLeases);
  const availability = clamp(freeSlots / Math.max(1, node.availability.maxConcurrentTasks), 0, 1);
  const workloadFit = estimateWorkloadFit(task, node);
  const penalty = estimatePenalty(node);

  return {
    performance,
    trust,
    network,
    availability,
    workloadFit,
    penalty
  };
}

function estimateWorkloadFit(task: TaskSpec, node: NodeProfile): number {
  if (task.kind === "verification" && node.deviceClass === "mobile") {
    return 0.9;
  }

  if (task.requirements.requiresGpu && node.deviceClass === "gpu") {
    return 1;
  }

  if (task.workload === "video.transcode" && node.capabilities.hasGpu) {
    return 1;
  }

  if (task.workload === "proof.verify" || task.workload === "hash.compute") {
    return node.deviceClass === "mobile" ? 0.85 : 0.75;
  }

  if (node.deviceClass === "server") {
    return 0.95;
  }

  return 0.75;
}

function estimatePenalty(node: NodeProfile): number {
  let penalty = 0;
  const telemetry = node.telemetry;

  if (telemetry?.batteryPercent !== undefined && telemetry.batteryPercent < 25) {
    penalty += 0.12;
  }

  if (telemetry?.temperatureC !== undefined && telemetry.temperatureC > 80) {
    penalty += 0.16;
  }

  if (telemetry?.loadAverage !== undefined && telemetry.loadAverage > 0.85) {
    penalty += 0.1;
  }

  if (node.reputation.responseP95Ms > 10_000) {
    penalty += 0.08;
  }

  return penalty;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
