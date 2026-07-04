import type {
  Order,
  TaskInputRef,
  TaskRequirements,
  TaskSpec,
  VerificationLevel
} from "./types.js";
import { makeId } from "./ids.js";
import { createSeededRandom } from "./random.js";
import {
  getComputeDeviceClasses,
  getVerificationDeviceClasses,
  getWorkloadProfile
} from "./workloads.js";

interface VerificationSettings {
  sampleRate: number;
  minSamples: number;
  replicas: number;
  canaryRatio: number;
  minCanaries: number;
}

const VERIFICATION_SETTINGS: Record<VerificationLevel, VerificationSettings> = {
  light: {
    sampleRate: 0.1,
    minSamples: 1,
    replicas: 1,
    canaryRatio: 0,
    minCanaries: 0
  },
  standard: {
    sampleRate: 0.25,
    minSamples: 1,
    replicas: 1,
    canaryRatio: 0.05,
    minCanaries: 1
  },
  strict: {
    sampleRate: 0.5,
    minSamples: 2,
    replicas: 2,
    canaryRatio: 0.1,
    minCanaries: 1
  }
};

export function splitOrderIntoComputeTasks(order: Order): TaskSpec[] {
  const profile = getWorkloadProfile(order.workload, order.requirements.workloadProfile);
  const requestedChunkBytes = order.requirements.maxChunkBytes ?? profile.defaultChunkBytes;
  const chunkBytes = Math.max(1, Math.min(requestedChunkBytes, Math.max(1, order.source.byteSize || requestedChunkBytes)));
  const total = Math.max(1, Math.ceil(Math.max(1, order.source.byteSize) / chunkBytes));
  const tasks: TaskSpec[] = [];

  for (let index = 0; index < total; index += 1) {
    const byteStart = index * chunkBytes;
    const byteEnd = Math.min(order.source.byteSize, byteStart + chunkBytes);
    const estimatedBytes = Math.max(1, byteEnd - byteStart);
    const estimatedComputeUnits = Math.max(1, roundUp(estimatedBytes / profile.unitBytes, 2));
    const input = createInputRef(order, index, total, byteStart, byteEnd);
    const requirements = createComputeRequirements(order, estimatedComputeUnits);

    tasks.push({
      id: makeId("task", {
        orderId: order.id,
        kind: "compute",
        index,
        byteStart,
        byteEnd
      }),
      orderId: order.id,
      kind: "compute",
      workload: order.workload,
      estimatedBytes,
      estimatedComputeUnits,
      input,
      requirements,
      verification: {
        level: order.verificationLevel,
        strategy: "primary",
        requiredReplicas: 1
      }
    });
  }

  return tasks;
}

export function createVerificationTasks(order: Order, computeTasks: readonly TaskSpec[], seed = order.id): TaskSpec[] {
  const settings = VERIFICATION_SETTINGS[order.verificationLevel];
  const random = createSeededRandom(`${seed}:verification`);
  const sampleCount = Math.min(
    computeTasks.length,
    Math.max(settings.minSamples, Math.ceil(computeTasks.length * settings.sampleRate))
  );
  const sampledTasks = random.pick(computeTasks, sampleCount);
  const verificationTasks: TaskSpec[] = [];

  for (const task of sampledTasks) {
    for (let replicaIndex = 0; replicaIndex < settings.replicas; replicaIndex += 1) {
      verificationTasks.push(createVerificationTask(order, task, replicaIndex));
    }
  }

  const canaryCount = Math.max(settings.minCanaries, Math.floor(computeTasks.length * settings.canaryRatio));
  for (let index = 0; index < canaryCount; index += 1) {
    verificationTasks.push(createCanaryTask(order, index));
  }

  return verificationTasks;
}

function createInputRef(order: Order, index: number, total: number, byteStart: number, byteEnd: number): TaskInputRef {
  return {
    sourceUri: order.source.uri,
    sourceHash: order.source.contentHash,
    chunk: {
      index,
      total,
      byteStart,
      byteEnd
    }
  };
}

function createComputeRequirements(order: Order, estimatedComputeUnits: number): TaskRequirements {
  const profile = getWorkloadProfile(order.workload, order.requirements.workloadProfile);
  const requiresGpu = order.requirements.requiresGpu ?? profile.gpuPreferred;
  const minTrustScore = order.requirements.minTrustScore ?? minTrustForOrder(order);

  return {
    allowedDeviceClasses: getComputeDeviceClasses(order.workload, requiresGpu, order.requirements.workloadProfile),
    requiresGpu,
    minTrustScore,
    estimatedMemoryGb: profile.estimatedMemoryGb,
    maxRuntimeSeconds: Math.ceil(profile.estimatedSecondsPerUnit * estimatedComputeUnits * 4)
  };
}

function createVerificationRequirements(order: Order): TaskRequirements {
  const profile = getWorkloadProfile(order.workload, order.requirements.workloadProfile);
  const allowMobile = order.requirements.allowMobileVerification ?? true;

  return {
    allowedDeviceClasses: getVerificationDeviceClasses(allowMobile),
    requiresGpu: false,
    minTrustScore: Math.max(0.55, order.requirements.minTrustScore ?? 0.55),
    estimatedMemoryGb: Math.max(0.25, profile.estimatedMemoryGb / 2),
    maxRuntimeSeconds: Math.max(15, Math.ceil(profile.estimatedSecondsPerUnit * 2))
  };
}

function createVerificationTask(order: Order, sourceTask: TaskSpec, replicaIndex: number): TaskSpec {
  const estimatedBytes = Math.max(1, Math.ceil(sourceTask.estimatedBytes * 0.08));

  return {
    id: makeId("task", {
      orderId: order.id,
      kind: "verification",
      sourceTaskId: sourceTask.id,
      replicaIndex
    }),
    orderId: order.id,
    kind: "verification",
    workload: order.workload,
    estimatedBytes,
    estimatedComputeUnits: Math.max(1, roundUp(sourceTask.estimatedComputeUnits * 0.15, 2)),
    input: sourceTask.input,
    requirements: createVerificationRequirements(order),
    verification: {
      level: order.verificationLevel,
      strategy: "random-sample",
      requiredReplicas: 1,
      verificationOfTaskId: sourceTask.id
    }
  };
}

function createCanaryTask(order: Order, index: number): TaskSpec {
  const profile = getWorkloadProfile(order.workload, order.requirements.workloadProfile);
  const estimatedBytes = Math.max(1, Math.min(profile.unitBytes, order.source.byteSize || profile.unitBytes));
  const byteEnd = estimatedBytes;
  const input = createInputRef(order, index, 1, 0, byteEnd);
  const canaryAnswerHash = makeId("known", {
    orderId: order.id,
    workload: order.workload,
    index,
    sourceHash: order.source.contentHash
  }, 32);

  return {
    id: makeId("task", {
      orderId: order.id,
      kind: "canary",
      index
    }),
    orderId: order.id,
    kind: "canary",
    workload: order.workload,
    estimatedBytes,
    estimatedComputeUnits: 1,
    input,
    requirements: createComputeRequirements(order, 1),
    verification: {
      level: order.verificationLevel,
      strategy: "known-answer",
      requiredReplicas: 1,
      canaryAnswerHash
    }
  };
}

function minTrustForOrder(order: Order): number {
  if (order.priority === "urgent") {
    return 0.75;
  }

  if (order.verificationLevel === "strict") {
    return 0.7;
  }

  if (order.priority === "economy") {
    return 0.45;
  }

  return 0.6;
}

function roundUp(value: number, decimals: number): number {
  const multiplier = 10 ** decimals;
  return Math.ceil(value * multiplier) / multiplier;
}
