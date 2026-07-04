import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import test from "node:test";
import { createDisproHttpServer } from "../src/api/httpServer.js";
import type { PlannedOrder, NodeProfile, OrderRequest } from "../src/domain/types.js";
import { sampleNodes } from "../src/sample/sampleNodes.js";
import { FileDisproStore } from "../src/storage/fileDisproStore.js";

interface OrderListResponse {
  orders: Array<{
    id: string;
    workload: string;
    taskCount: number;
  }>;
}

interface TasksResponse {
  orderId: string;
  tasks: PlannedOrder["tasks"];
  assignments: PlannedOrder["assignments"];
}

interface AuditResponse {
  orderId: string;
  valid: boolean;
}

test("creates and reads a custom workload order through the API", async () => {
  const { baseUrl, close } = await createTestApi();

  try {
    const request: OrderRequest = {
      id: "ord_api_custom_001",
      customerId: "customer_api_001",
      source: {
        kind: "url",
        uri: "https://example.test/input.bin",
        byteSize: 5_500_000,
        contentHash: "d6f8d5c842ec2c594f3a26f48b7b45f3a9f7c924d4b574245d4bfe1c997f24ba"
      },
      workload: "custom.thumbnail.extract",
      priority: "economy",
      verificationLevel: "standard",
      requirements: {
        maxChunkBytes: 2_000_000,
        workloadProfile: {
          label: "Thumbnail extraction",
          unitBytes: 1_000_000,
          defaultChunkBytes: 2_000_000,
          baseMicroYen: 200_000,
          computeMicroYenPerUnit: 40_000,
          estimatedSecondsPerUnit: 0.8,
          estimatedMemoryGb: 1,
          deterministic: true
        }
      }
    };

    const createResponse = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    assert.equal(createResponse.status, 201);

    const plan = (await createResponse.json()) as PlannedOrder;
    assert.equal(plan.order.id, "ord_api_custom_001");
    assert.equal(plan.order.workload, "custom.thumbnail.extract");
    assert.equal(plan.tasks.filter((task) => task.kind === "compute").length, 3);
    assert.equal(plan.unassignedTasks.length, 0);

    const listResponse = await fetch(`${baseUrl}/orders`);
    const list = (await listResponse.json()) as OrderListResponse;
    assert.equal(list.orders.length, 1);
    assert.equal(list.orders[0]?.id, "ord_api_custom_001");
    assert.equal(list.orders[0]?.taskCount, plan.tasks.length);

    const getResponse = await fetch(`${baseUrl}/orders/ord_api_custom_001`);
    const persistedPlan = (await getResponse.json()) as PlannedOrder;
    assert.equal(persistedPlan.order.id, plan.order.id);
    assert.equal(persistedPlan.tasks.length, plan.tasks.length);

    const tasksResponse = await fetch(`${baseUrl}/orders/ord_api_custom_001/tasks`);
    const tasks = (await tasksResponse.json()) as TasksResponse;
    assert.equal(tasks.orderId, "ord_api_custom_001");
    assert.equal(tasks.tasks.length, plan.tasks.length);
    assert.equal(tasks.assignments.length, plan.assignments.length);

    const auditResponse = await fetch(`${baseUrl}/orders/ord_api_custom_001/audit`);
    const audit = (await auditResponse.json()) as AuditResponse;
    assert.equal(audit.orderId, "ord_api_custom_001");
    assert.equal(audit.valid, true);
  } finally {
    await close();
  }
});

test("registers a node and persists it in the store", async () => {
  const { baseUrl, close, statePath } = await createTestApi([]);

  try {
    const node: NodeProfile = {
      id: "node_generic_worker_001",
      deviceClass: "desktop",
      capabilities: {
        cpuCores: 12,
        memoryGb: 32,
        bandwidthMbps: 250,
        hasGpu: false,
        supportedWorkloads: ["*"]
      },
      reputation: {
        trustScore: 0.8,
        successRate: 0.99,
        uptimeRatio: 0.8,
        disputeRate: 0.01,
        completedTasks: 120,
        responseP95Ms: 1700
      },
      availability: {
        online: true,
        canAcceptCompute: true,
        canAcceptVerification: true,
        maxTaskBytes: 64_000_000,
        maxConcurrentTasks: 8,
        currentLeases: 0
      }
    };

    const registerResponse = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(node)
    });

    assert.equal(registerResponse.status, 201);

    const store = await FileDisproStore.open(statePath);
    const persistedNode = await store.getNode("node_generic_worker_001");
    assert.equal(persistedNode?.id, "node_generic_worker_001");
    assert.deepEqual(persistedNode?.capabilities.supportedWorkloads, ["*"]);
  } finally {
    await close();
  }
});

test("serves the official site from the API server", async () => {
  const { baseUrl, close } = await createTestApi(sampleNodes, join(process.cwd(), "public"));

  try {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /<title>Dispro - Verifiable Distributed Compute<\/title>/);
    assert.match(html, /Official Dispro Platform/);
  } finally {
    await close();
  }
});

async function createTestApi(
  seedNodes: readonly NodeProfile[] = sampleNodes,
  staticDirectory?: string
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  statePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "dispro-api-"));
  const statePath = join(directory, "state.json");
  const store = await FileDisproStore.open(statePath, seedNodes);
  const serverOptions = {
    store,
    now: () => new Date("2026-07-04T00:00:00.000Z")
  };
  const server = createDisproHttpServer(
    staticDirectory === undefined ? serverOptions : { ...serverOptions, staticDirectory }
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    statePath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}
