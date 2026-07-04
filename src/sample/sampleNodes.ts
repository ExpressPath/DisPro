import type { NodeProfile, WorkloadKind } from "../domain/types.js";

const ALL_WORKLOADS: WorkloadKind[] = [
  "image.convert",
  "pdf.compress",
  "video.transcode",
  "data.transform",
  "proof.verify",
  "code.test",
  "hash.compute"
];

export const sampleNodes: NodeProfile[] = [
  {
    id: "node_mobile_tokyo_01",
    deviceClass: "mobile",
    capabilities: {
      cpuCores: 6,
      memoryGb: 6,
      bandwidthMbps: 80,
      hasGpu: false,
      supportedWorkloads: ["proof.verify", "hash.compute", "image.convert", "pdf.compress"]
    },
    reputation: {
      trustScore: 0.78,
      successRate: 0.98,
      uptimeRatio: 0.72,
      disputeRate: 0.01,
      completedTasks: 420,
      responseP95Ms: 2400
    },
    availability: {
      online: true,
      canAcceptCompute: true,
      canAcceptVerification: true,
      maxTaskBytes: 16_000_000,
      maxConcurrentTasks: 12,
      currentLeases: 0
    },
    telemetry: {
      batteryPercent: 82,
      temperatureC: 38,
      loadAverage: 0.35
    }
  },
  {
    id: "node_laptop_osaka_01",
    deviceClass: "laptop",
    capabilities: {
      cpuCores: 8,
      memoryGb: 16,
      bandwidthMbps: 180,
      hasGpu: false,
      supportedWorkloads: ALL_WORKLOADS.filter((workload) => workload !== "video.transcode")
    },
    reputation: {
      trustScore: 0.84,
      successRate: 0.985,
      uptimeRatio: 0.81,
      disputeRate: 0.006,
      completedTasks: 950,
      responseP95Ms: 1800
    },
    availability: {
      online: true,
      canAcceptCompute: true,
      canAcceptVerification: true,
      maxTaskBytes: 48_000_000,
      maxConcurrentTasks: 16,
      currentLeases: 1
    },
    telemetry: {
      temperatureC: 54,
      loadAverage: 0.42
    }
  },
  {
    id: "node_desktop_fukuoka_01",
    deviceClass: "desktop",
    capabilities: {
      cpuCores: 16,
      memoryGb: 32,
      bandwidthMbps: 350,
      hasGpu: false,
      supportedWorkloads: ["*"]
    },
    reputation: {
      trustScore: 0.9,
      successRate: 0.992,
      uptimeRatio: 0.88,
      disputeRate: 0.003,
      completedTasks: 2800,
      responseP95Ms: 1300
    },
    availability: {
      online: true,
      canAcceptCompute: true,
      canAcceptVerification: true,
      maxTaskBytes: 96_000_000,
      maxConcurrentTasks: 24,
      currentLeases: 2
    },
    telemetry: {
      temperatureC: 61,
      loadAverage: 0.47
    }
  },
  {
    id: "node_gpu_sapporo_01",
    deviceClass: "gpu",
    capabilities: {
      cpuCores: 24,
      memoryGb: 64,
      bandwidthMbps: 500,
      hasGpu: true,
      supportedWorkloads: ["*"]
    },
    reputation: {
      trustScore: 0.88,
      successRate: 0.989,
      uptimeRatio: 0.86,
      disputeRate: 0.004,
      completedTasks: 1900,
      responseP95Ms: 1200
    },
    availability: {
      online: true,
      canAcceptCompute: true,
      canAcceptVerification: false,
      maxTaskBytes: 256_000_000,
      maxConcurrentTasks: 20,
      currentLeases: 3
    },
    telemetry: {
      temperatureC: 66,
      loadAverage: 0.5
    }
  },
  {
    id: "node_server_tokyo_01",
    deviceClass: "server",
    capabilities: {
      cpuCores: 64,
      memoryGb: 256,
      bandwidthMbps: 1000,
      hasGpu: true,
      supportedWorkloads: ["*"]
    },
    reputation: {
      trustScore: 0.97,
      successRate: 0.997,
      uptimeRatio: 0.99,
      disputeRate: 0.001,
      completedTasks: 14000,
      responseP95Ms: 700
    },
    availability: {
      online: true,
      canAcceptCompute: true,
      canAcceptVerification: true,
      maxTaskBytes: 1_000_000_000,
      maxConcurrentTasks: 100,
      currentLeases: 12
    },
    telemetry: {
      temperatureC: 58,
      loadAverage: 0.4
    }
  }
];
