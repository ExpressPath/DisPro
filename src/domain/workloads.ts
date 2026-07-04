import type { DeviceClass, KnownWorkloadKind, WorkloadKind, WorkloadProfile, WorkloadProfileOverrides } from "./types.js";

export const WORKLOAD_PROFILES: Record<KnownWorkloadKind, WorkloadProfile> = {
  "image.convert": {
    workload: "image.convert",
    label: "Image conversion",
    unitBytes: 2_000_000,
    defaultChunkBytes: 8_000_000,
    baseMicroYen: 300_000,
    computeMicroYenPerUnit: 55_000,
    estimatedSecondsPerUnit: 1.2,
    estimatedMemoryGb: 1,
    gpuPreferred: false,
    deterministic: true
  },
  "pdf.compress": {
    workload: "pdf.compress",
    label: "PDF compression",
    unitBytes: 3_000_000,
    defaultChunkBytes: 12_000_000,
    baseMicroYen: 350_000,
    computeMicroYenPerUnit: 70_000,
    estimatedSecondsPerUnit: 1.6,
    estimatedMemoryGb: 1.5,
    gpuPreferred: false,
    deterministic: true
  },
  "video.transcode": {
    workload: "video.transcode",
    label: "Video transcode",
    unitBytes: 10_000_000,
    defaultChunkBytes: 40_000_000,
    baseMicroYen: 1_500_000,
    computeMicroYenPerUnit: 420_000,
    estimatedSecondsPerUnit: 5,
    estimatedMemoryGb: 4,
    gpuPreferred: true,
    deterministic: false
  },
  "data.transform": {
    workload: "data.transform",
    label: "Data transform",
    unitBytes: 5_000_000,
    defaultChunkBytes: 20_000_000,
    baseMicroYen: 400_000,
    computeMicroYenPerUnit: 95_000,
    estimatedSecondsPerUnit: 1.4,
    estimatedMemoryGb: 2,
    gpuPreferred: false,
    deterministic: true
  },
  "proof.verify": {
    workload: "proof.verify",
    label: "Proof verification",
    unitBytes: 500_000,
    defaultChunkBytes: 2_000_000,
    baseMicroYen: 150_000,
    computeMicroYenPerUnit: 35_000,
    estimatedSecondsPerUnit: 0.8,
    estimatedMemoryGb: 0.5,
    gpuPreferred: false,
    deterministic: true
  },
  "code.test": {
    workload: "code.test",
    label: "Code test",
    unitBytes: 1_000_000,
    defaultChunkBytes: 4_000_000,
    baseMicroYen: 500_000,
    computeMicroYenPerUnit: 140_000,
    estimatedSecondsPerUnit: 2,
    estimatedMemoryGb: 2,
    gpuPreferred: false,
    deterministic: false
  },
  "hash.compute": {
    workload: "hash.compute",
    label: "Hash compute",
    unitBytes: 8_000_000,
    defaultChunkBytes: 64_000_000,
    baseMicroYen: 100_000,
    computeMicroYenPerUnit: 25_000,
    estimatedSecondsPerUnit: 0.5,
    estimatedMemoryGb: 0.25,
    gpuPreferred: false,
    deterministic: true
  }
};

const KNOWN_WORKLOADS = new Set<string>(Object.keys(WORKLOAD_PROFILES));

const DEFAULT_CUSTOM_PROFILE: Omit<WorkloadProfile, "workload"> = {
  label: "Custom workload",
  unitBytes: 4_000_000,
  defaultChunkBytes: 16_000_000,
  baseMicroYen: 450_000,
  computeMicroYenPerUnit: 110_000,
  estimatedSecondsPerUnit: 2,
  estimatedMemoryGb: 2,
  gpuPreferred: false,
  deterministic: false
};

export const DEVICE_ORDER: Record<DeviceClass, number> = {
  mobile: 1,
  laptop: 2,
  desktop: 3,
  gpu: 4,
  server: 5
};

export function getWorkloadProfile(workload: WorkloadKind, overrides?: WorkloadProfileOverrides): WorkloadProfile {
  const base = isKnownWorkloadKind(workload)
    ? { ...WORKLOAD_PROFILES[workload] }
    : {
        workload,
        ...DEFAULT_CUSTOM_PROFILE,
        label: `Custom workload (${workload})`
      };

  return applyProfileOverrides(base, overrides);
}

export function getComputeDeviceClasses(
  workload: WorkloadKind,
  requiresGpu: boolean,
  overrides?: WorkloadProfileOverrides
): DeviceClass[] {
  if (requiresGpu || getWorkloadProfile(workload, overrides).gpuPreferred) {
    return ["gpu", "server"];
  }

  if (workload === "proof.verify" || workload === "hash.compute") {
    return ["mobile", "laptop", "desktop", "gpu", "server"];
  }

  if (workload === "video.transcode") {
    return ["desktop", "gpu", "server"];
  }

  return ["laptop", "desktop", "gpu", "server"];
}

export function getVerificationDeviceClasses(allowMobile: boolean): DeviceClass[] {
  return allowMobile ? ["mobile", "laptop", "desktop", "server"] : ["laptop", "desktop", "server"];
}

export function isKnownWorkloadKind(workload: WorkloadKind): workload is KnownWorkloadKind {
  return KNOWN_WORKLOADS.has(workload);
}

export function supportsWorkload(supportedWorkloads: readonly string[], workload: WorkloadKind): boolean {
  return supportedWorkloads.includes("*") || supportedWorkloads.includes(workload);
}

function applyProfileOverrides(base: WorkloadProfile, overrides?: WorkloadProfileOverrides): WorkloadProfile {
  if (!overrides) {
    return base;
  }

  const profile = { ...base };

  if (overrides.label !== undefined) {
    profile.label = overrides.label;
  }
  if (overrides.unitBytes !== undefined) {
    profile.unitBytes = overrides.unitBytes;
  }
  if (overrides.defaultChunkBytes !== undefined) {
    profile.defaultChunkBytes = overrides.defaultChunkBytes;
  }
  if (overrides.baseMicroYen !== undefined) {
    profile.baseMicroYen = overrides.baseMicroYen;
  }
  if (overrides.computeMicroYenPerUnit !== undefined) {
    profile.computeMicroYenPerUnit = overrides.computeMicroYenPerUnit;
  }
  if (overrides.estimatedSecondsPerUnit !== undefined) {
    profile.estimatedSecondsPerUnit = overrides.estimatedSecondsPerUnit;
  }
  if (overrides.estimatedMemoryGb !== undefined) {
    profile.estimatedMemoryGb = overrides.estimatedMemoryGb;
  }
  if (overrides.gpuPreferred !== undefined) {
    profile.gpuPreferred = overrides.gpuPreferred;
  }
  if (overrides.deterministic !== undefined) {
    profile.deterministic = overrides.deterministic;
  }

  return profile;
}
