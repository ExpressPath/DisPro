import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import test from "node:test";
import { createDisproHttpServer } from "../src/api/httpServer.js";
import type { PlannedOrder, NodeProfile, OrderRequest } from "../src/domain/types.js";
import { sampleNodes } from "../src/sample/sampleNodes.js";
import { createProcessJobFromTask, verifyProcessJobEnvelope } from "../src/services/processService.js";
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
    const sessionToken = await signInAndGetSessionToken(baseUrl, "owner@example.com");
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
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    assert.equal(createResponse.status, 201);

    const plan = (await createResponse.json()) as PlannedOrder;
    assert.equal(plan.order.id, "ord_api_custom_001");
    assert.notEqual(plan.order.customerId, "customer_api_001");
    assert.equal(plan.order.workload, "custom.thumbnail.extract");
    assert.equal(plan.tasks.filter((task) => task.kind === "compute").length, 3);
    assert.equal(plan.unassignedTasks.length, 0);

    const listResponse = await fetch(`${baseUrl}/orders`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    const list = (await listResponse.json()) as OrderListResponse;
    assert.equal(list.orders.length, 1);
    assert.equal(list.orders[0]?.id, "ord_api_custom_001");
    assert.equal(list.orders[0]?.taskCount, plan.tasks.length);

    const getResponse = await fetch(`${baseUrl}/orders/ord_api_custom_001`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    const persistedPlan = (await getResponse.json()) as PlannedOrder;
    assert.equal(persistedPlan.order.id, plan.order.id);
    assert.equal(persistedPlan.tasks.length, plan.tasks.length);

    const tasksResponse = await fetch(`${baseUrl}/orders/ord_api_custom_001/tasks`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    const tasks = (await tasksResponse.json()) as TasksResponse;
    assert.equal(tasks.orderId, "ord_api_custom_001");
    assert.equal(tasks.tasks.length, plan.tasks.length);
    assert.equal(tasks.assignments.length, plan.assignments.length);

    const auditResponse = await fetch(`${baseUrl}/orders/ord_api_custom_001/audit`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
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
    const sessionToken = await signInAndGetSessionToken(baseUrl, "node-owner@example.com");
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
        authorization: `Bearer ${sessionToken}`,
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

test("creates an API key from email sign-in and uses it for protected API calls", async () => {
  const { baseUrl, close } = await createTestApi();

  try {
    const sessionToken = await signInAndGetSessionToken(baseUrl, "api-owner@example.com");
    const apiKeyResponse = await fetch(`${baseUrl}/auth/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ label: "test key" })
    });

    assert.equal(apiKeyResponse.status, 201);
    const apiKeyBody = (await apiKeyResponse.json()) as {
      apiKey: { keyPrefix: string; label: string };
      secret: string;
    };
    assert.equal(apiKeyBody.apiKey.label, "test key");
    assert.equal((apiKeyBody.apiKey as { purpose?: string }).purpose, "general");
    assert.ok(apiKeyBody.secret.startsWith("dsk_"));
    assert.equal(apiKeyBody.secret.startsWith(apiKeyBody.apiKey.keyPrefix), true);

    const meResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`
      }
    });
    assert.equal(meResponse.status, 200);

    const ordersResponse = await fetch(`${baseUrl}/orders`, {
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`
      }
    });
    assert.equal(ordersResponse.status, 200);
  } finally {
    await close();
  }
});

test("rejects reused email verification codes", async () => {
  const { baseUrl, close } = await createTestApi();
  const email = "reused-code@example.com";

  try {
    const requestResponse = await fetch(`${baseUrl}/auth/request-code`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ email })
    });
    assert.equal(requestResponse.status, 202);
    const requestBody = (await requestResponse.json()) as { devVerificationCode?: string };
    assert.match(requestBody.devVerificationCode ?? "", /^\d{6}$/);

    const firstVerifyResponse = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ email, code: requestBody.devVerificationCode })
    });
    assert.equal(firstVerifyResponse.status, 200);

    const secondVerifyResponse = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ email, code: requestBody.devVerificationCode })
    });
    assert.equal(secondVerifyResponse.status, 401);
    const secondVerifyBody = (await secondVerifyResponse.json()) as { error: { message: string } };
    assert.match(secondVerifyBody.error.message, /already been used/i);
  } finally {
    await close();
  }
});

test("sets a secure session cookie, supports cookie auth, and logs out", async () => {
  const { baseUrl, close } = await createTestApi();
  const email = "cookie-owner@example.com";

  try {
    const requestResponse = await fetch(`${baseUrl}/auth/request-code`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ email })
    });
    const requestBody = (await requestResponse.json()) as { devVerificationCode?: string };

    const verifyResponse = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ email, code: requestBody.devVerificationCode })
    });
    assert.equal(verifyResponse.status, 200);
    const cookie = verifyResponse.headers.get("set-cookie") ?? "";
    assert.match(cookie, /dispro_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);

    const profileResponse = await fetch(`${baseUrl}/account/profile`, {
      headers: {
        cookie
      }
    });
    assert.equal(profileResponse.status, 200);

    const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST"
    });
    assert.equal(logoutResponse.status, 200);
    assert.match(logoutResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
  } finally {
    await close();
  }
});

test("registers a process node, leases a signed job, submits result, and reports earnings", async () => {
  const { baseUrl, close, store } = await createTestApi();

  try {
    const sessionToken = await signInAndGetSessionToken(baseUrl, "processor@example.com");
    const apiKeyResponse = await fetch(`${baseUrl}/auth/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ label: "process-windows-v1", purpose: "process" })
    });
    assert.equal(apiKeyResponse.status, 201);
    const apiKeyBody = (await apiKeyResponse.json()) as { secret: string; apiKey: { purpose: string } };
    assert.equal(apiKeyBody.apiKey.purpose, "process");

    const registerResponse = await fetch(`${baseUrl}/process/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        machineId: "machine-test-001",
        deviceName: "Test Windows Node",
        os: "Windows 11",
        appVersion: "0.1.0",
        cpuCores: 8,
        memoryGb: 16,
        supportedWorkloads: ["echo.test", "hash.compute"]
      })
    });
    assert.equal(registerResponse.status, 201);
    const registered = (await registerResponse.json()) as { node: { id: string } };

    const idleResponse = await fetch(`${baseUrl}/process/lease`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeId: registered.node.id })
    });
    assert.equal(idleResponse.status, 200);
    assert.equal(((await idleResponse.json()) as { status: string }).status, "idle");

    await store.saveProcessJob(
      createProcessJobFromTask(
        "ord_process_001",
        { id: "task_process_001", workload: "echo.test" },
        { message: "hello process" },
        new Date("2026-07-04T00:00:00.000Z")
      )
    );

    const leaseResponse = await fetch(`${baseUrl}/process/lease`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeId: registered.node.id })
    });
    assert.equal(leaseResponse.status, 200);
    const lease = (await leaseResponse.json()) as { status: string; job: { jobId: string; signature: string } };
    assert.equal(lease.status, "leased");
    assert.ok(lease.job.signature);
    assert.equal(verifyProcessJobEnvelope(lease.job as never), true);

    const resultResponse = await fetch(`${baseUrl}/process/results`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        nodeId: registered.node.id,
        jobId: lease.job.jobId,
        status: "completed",
        resultHash: "abc123",
        stdout: "done",
        stderr: "",
        durationMs: 12
      })
    });
    assert.equal(resultResponse.status, 200);
    const result = (await resultResponse.json()) as { earnings: { provisionalMicroYen: number; processedCount: number } };
    assert.equal(result.earnings.processedCount, 1);
    assert.equal(result.earnings.provisionalMicroYen, 10_000);

    const earningsResponse = await fetch(`${baseUrl}/process/earnings`, {
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`
      }
    });
    assert.equal(earningsResponse.status, 200);
  } finally {
    await close();
  }
});

test("anchors user profile and process earning transactions through signed special workloads", async () => {
  const { baseUrl, close, store } = await createTestApi();

  try {
    const sessionToken = await signInAndGetSessionToken(baseUrl, "anchor-processor@example.com");
    const apiKeyResponse = await fetch(`${baseUrl}/auth/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ label: "process-anchor", purpose: "process" })
    });
    assert.equal(apiKeyResponse.status, 201);
    const apiKeyBody = (await apiKeyResponse.json()) as { secret: string };

    const registerResponse = await fetch(`${baseUrl}/process/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        machineId: "machine-anchor-001",
        deviceName: "Anchor Windows Node",
        os: "Windows 11",
        appVersion: "0.1.0",
        cpuCores: 8,
        memoryGb: 16,
        supportedWorkloads: ["dispro.storage.anchor", "dispro.transaction.anchor", "echo.test"]
      })
    });
    assert.equal(registerResponse.status, 201);
    const registered = (await registerResponse.json()) as { node: { id: string } };

    const profileLeaseResponse = await fetch(`${baseUrl}/process/lease`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeId: registered.node.id })
    });
    assert.equal(profileLeaseResponse.status, 200);
    const profileLease = (await profileLeaseResponse.json()) as {
      status: string;
      job: { jobId: string; workload: string; signature: string };
    };
    assert.equal(profileLease.status, "leased");
    assert.equal(profileLease.job.workload, "dispro.storage.anchor");
    assert.equal(verifyProcessJobEnvelope(profileLease.job as never), true);

    const profileResultResponse = await fetch(`${baseUrl}/process/results`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        nodeId: registered.node.id,
        jobId: profileLease.job.jobId,
        status: "completed",
        resultHash: "profile-result-hash",
        stdout: JSON.stringify({
          cid: "local-profile-cid",
          payloadHash: "profile-payload-hash",
          contractHash: "profile-contract-hash"
        }),
        stderr: "",
        durationMs: 10
      })
    });
    assert.equal(profileResultResponse.status, 200);

    const recordsResponse = await fetch(`${baseUrl}/account/distributed-records`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    assert.equal(recordsResponse.status, 200);
    const records = (await recordsResponse.json()) as { records: Array<{ type: string; cid: string }> };
    assert.equal(records.records.some((record) => record.type === "user.profile" && record.cid === "local-profile-cid"), true);

    await store.saveProcessJob(
      createProcessJobFromTask(
        "ord_anchor_001",
        { id: "task_anchor_001", workload: "echo.test" },
        { message: "earning source" },
        new Date("2026-07-04T00:00:00.000Z")
      )
    );

    const workLeaseResponse = await fetch(`${baseUrl}/process/lease`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeId: registered.node.id })
    });
    assert.equal(workLeaseResponse.status, 200);
    const workLease = (await workLeaseResponse.json()) as { job: { jobId: string; workload: string } };
    assert.equal(workLease.job.workload, "echo.test");

    const workResultResponse = await fetch(`${baseUrl}/process/results`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        nodeId: registered.node.id,
        jobId: workLease.job.jobId,
        status: "completed",
        resultHash: "earning-result-hash",
        stdout: "done",
        stderr: "",
        durationMs: 12
      })
    });
    assert.equal(workResultResponse.status, 200);

    const pendingTransactionsResponse = await fetch(`${baseUrl}/account/transactions`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    assert.equal(pendingTransactionsResponse.status, 200);
    const pendingTransactions = (await pendingTransactionsResponse.json()) as {
      transactions: Array<{ id: string; status: string; amountMicroYen: number }>;
    };
    assert.equal(pendingTransactions.transactions.length, 1);
    assert.equal(pendingTransactions.transactions[0]?.status, "pending");
    assert.equal(pendingTransactions.transactions[0]?.amountMicroYen, 10_000);

    const transactionLeaseResponse = await fetch(`${baseUrl}/process/lease`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeId: registered.node.id })
    });
    assert.equal(transactionLeaseResponse.status, 200);
    const transactionLease = (await transactionLeaseResponse.json()) as {
      job: { jobId: string; workload: string; signature: string };
    };
    assert.equal(transactionLease.job.workload, "dispro.transaction.anchor");
    assert.equal(verifyProcessJobEnvelope(transactionLease.job as never), true);

    const transactionAnchorResponse = await fetch(`${baseUrl}/process/results`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyBody.secret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        nodeId: registered.node.id,
        jobId: transactionLease.job.jobId,
        status: "completed",
        resultHash: "transaction-anchor-result-hash",
        stdout: JSON.stringify({
          cid: "local-transaction-cid",
          payloadHash: "transaction-payload-hash",
          contractHash: "transaction-contract-hash"
        }),
        stderr: "",
        durationMs: 8
      })
    });
    assert.equal(transactionAnchorResponse.status, 200);

    const anchoredTransactionsResponse = await fetch(`${baseUrl}/account/transactions`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    const anchoredTransactions = (await anchoredTransactionsResponse.json()) as {
      transactions: Array<{ status: string; distributedRecordId?: string }>;
    };
    assert.equal(anchoredTransactions.transactions[0]?.status, "anchored");
    assert.ok(anchoredTransactions.transactions[0]?.distributedRecordId);

    const profileResponse = await fetch(`${baseUrl}/account/profile`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    assert.equal(profileResponse.status, 200);
    const profile = (await profileResponse.json()) as {
      transactions: unknown[];
      distributedRecords: Array<{ type: string; cid: string }>;
    };
    assert.equal(profile.transactions.length, 1);
    assert.equal(
      profile.distributedRecords.some(
        (record) => record.type === "transaction" && record.cid === "local-transaction-cid"
      ),
      true
    );
  } finally {
    await close();
  }
});

test("serves Windows and Chrome Process downloads and redirects to their release assets", async () => {
  const { baseUrl, close } = await createTestApi();

  try {
    const manifestResponse = await fetch(`${baseUrl}/downloads`);
    assert.equal(manifestResponse.status, 200);
    const manifest = (await manifestResponse.json()) as {
      downloads: Array<{ platform: string; app: string; sha256: string; downloadUrl: string }>;
    };
    const windows = manifest.downloads.find((download) => download.platform === "windows");
    const chrome = manifest.downloads.find((download) => download.platform === "chrome");
    assert.equal(windows?.app, "process");
    assert.match(windows?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(chrome?.app, "process");
    assert.match(chrome?.sha256 ?? "", /^[a-f0-9]{64}$/);

    const redirectResponse = await fetch(`${baseUrl}/downloads/windows/process/latest`, {
      redirect: "manual"
    });
    assert.equal(redirectResponse.status, 302);
    assert.match(redirectResponse.headers.get("location") ?? "", /github\.com\/ExpressPath\/DisPro\/releases/);

    const chromeRedirectResponse = await fetch(`${baseUrl}/downloads/chrome/process/latest`, {
      redirect: "manual"
    });
    assert.equal(chromeRedirectResponse.status, 302);
    assert.match(chromeRedirectResponse.headers.get("location") ?? "", /Dispro-Process-Chrome\.zip/);
  } finally {
    await close();
  }
});

test("permits Chrome extension bearer API CORS without allowing it as a cookie-auth origin", async () => {
  const previous = process.env.DISPRO_ALLOW_CHROME_EXTENSION_ORIGINS;
  process.env.DISPRO_ALLOW_CHROME_EXTENSION_ORIGINS = "true";
  const { baseUrl, close } = await createTestApi();

  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { origin: "chrome-extension://disprotestextensionid" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "chrome-extension://disprotestextensionid");
  } finally {
    if (previous === undefined) delete process.env.DISPRO_ALLOW_CHROME_EXTENSION_ORIGINS;
    else process.env.DISPRO_ALLOW_CHROME_EXTENSION_ORIGINS = previous;
    await close();
  }
});

test("creates Use API keys, requires billing setup, finalizes metered results, and records mock Stripe payment", async () => {
  const previousMock = process.env.DISPRO_STRIPE_MOCK;
  const previousPublishable = process.env.STRIPE_PUBLISHABLE_KEY;
  process.env.DISPRO_STRIPE_MOCK = "true";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_mock";
  const { baseUrl, close, store } = await createTestApi();

  try {
    const sessionToken = await signInAndGetSessionToken(baseUrl, "use-owner@example.com");
    const useApiKeyResponse = await fetch(`${baseUrl}/auth/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ label: "use-windows-v1", purpose: "use" })
    });
    assert.equal(useApiKeyResponse.status, 201);
    const useApiKeyBody = (await useApiKeyResponse.json()) as { secret: string; apiKey: { purpose: string } };
    assert.equal(useApiKeyBody.apiKey.purpose, "use");

    const rejectedOrderResponse = await fetch(`${baseUrl}/use/orders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${useApiKeyBody.secret}`,
        "content-type": "application/json",
        "idempotency-key": "rejected-use-order-0001"
      },
      body: JSON.stringify({
        source: {
          kind: "url",
          uri: "https://example.test/input.txt",
          byteSize: 1024,
          contentHash: "use-order-content-hash"
        },
        workload: "hash.compute"
      })
    });
    assert.equal(rejectedOrderResponse.status, 402);

    const setupResponse = await fetch(`${baseUrl}/billing/setup-session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    assert.equal(setupResponse.status, 201);

    const billingStatusResponse = await fetch(`${baseUrl}/billing/status`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    assert.equal(billingStatusResponse.status, 200);
    const billingStatus = (await billingStatusResponse.json()) as { setupComplete: boolean };
    assert.equal(billingStatus.setupComplete, true);

    const createOrderResponse = await fetch(`${baseUrl}/use/orders?seed=use-order-seed`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${useApiKeyBody.secret}`,
        "content-type": "application/json",
        "idempotency-key": "use-order-00000001"
      },
      body: JSON.stringify({
        id: "use_order_001",
        source: {
          kind: "url",
          uri: "https://example.test/input.txt",
          byteSize: 1024,
          contentHash: "use-order-content-hash"
        },
        workload: "hash.compute",
        maxChargeMicroYen: 100_000_000
      })
    });
    assert.equal(createOrderResponse.status, 201);
    const created = (await createOrderResponse.json()) as { order: { id: string; estimatedMicroYen: number } };
    assert.equal(created.order.id, "use_order_001");
    assert.ok(created.order.estimatedMicroYen > 0);

    const processJobs = (await store.listProcessJobs()).filter((job) => job.orderId === "use_order_001");
    assert.ok(processJobs.length > 0);
    for (const job of processJobs) {
      await store.saveProcessJob({
        ...job,
        status: "completed",
        updatedAt: "2026-07-04T00:00:01.000Z"
      });
      await store.saveProcessJobResult({
        id: `result-${job.id}`,
        jobId: job.id,
        processNodeId: "test-node",
        userId: "processor-user",
        status: "completed",
        resultHash: `hash-${job.workUnitId ?? job.id}`,
        stdout: JSON.stringify({ ok: true, jobId: job.id }),
        stderr: "",
        durationMs: 25,
        metrics: {
          durationMs: 25,
          inputBytes: typeof job.inputRef.sourceHash === "string" ? job.inputRef.sourceHash.length : 16,
          outputBytes: 64,
          computeUnits: 3000,
          runnerWorkUnits: 3000
        },
        createdAt: "2026-07-04T00:00:01.000Z"
      });
    }

    const finalizedResponse = await fetch(`${baseUrl}/use/orders/use_order_001`, {
      headers: {
        authorization: `Bearer ${useApiKeyBody.secret}`
      }
    });
    assert.equal(finalizedResponse.status, 200);
    const finalized = (await finalizedResponse.json()) as {
      order: {
        status: string;
        billingStatus: string;
        result?: unknown;
        finalMicroYen?: number;
        stripePaymentIntentId?: string;
        workerPoolMicroYen?: number;
        platformFeeMicroYen?: number;
        distributionStatus?: string;
      };
    };
    assert.equal(finalized.order.status, "paid");
    assert.equal(finalized.order.billingStatus, "paid");
    assert.ok(finalized.order.result);
    assert.ok(finalized.order.finalMicroYen);
    assert.ok(finalized.order.stripePaymentIntentId?.startsWith("pi_mock_"));
    assert.equal(finalized.order.distributionStatus, "settled");
    assert.equal(
      (finalized.order.workerPoolMicroYen ?? 0) + (finalized.order.platformFeeMicroYen ?? 0),
      finalized.order.finalMicroYen
    );
    assert.equal(
      finalized.order.workerPoolMicroYen,
      Math.floor((finalized.order.finalMicroYen ?? 0) * 0.9)
    );

    const processorTransactions = await store.listUserTransactions("processor-user");
    assert.equal(
      processorTransactions.some(
        (transaction) =>
          transaction.kind === "confirmed_earning" && transaction.amountMicroYen === finalized.order.workerPoolMicroYen
      ),
      true
    );
    const treasuryTransactions = await store.listUserTransactions("dispro-treasury");
    assert.equal(
      treasuryTransactions.some(
        (transaction) =>
          transaction.kind === "platform_fee" && transaction.amountMicroYen === finalized.order.platformFeeMicroYen
      ),
      true
    );

    const resultResponse = await fetch(`${baseUrl}/use/orders/use_order_001/result`, {
      headers: {
        authorization: `Bearer ${useApiKeyBody.secret}`
      }
    });
    assert.equal(resultResponse.status, 200);

    const transactionsResponse = await fetch(`${baseUrl}/account/transactions`, {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    });
    const transactions = (await transactionsResponse.json()) as {
      transactions: Array<{ kind: string; relatedOrderId?: string }>;
    };
    assert.equal(
      transactions.transactions.some(
        (transaction) => transaction.kind === "usage_charge" && transaction.relatedOrderId === "use_order_001"
      ),
      true
    );
    assert.equal(
      transactions.transactions.some(
        (transaction) => transaction.kind === "stripe_payment" && transaction.relatedOrderId === "use_order_001"
      ),
      true
    );
  } finally {
    if (previousMock === undefined) {
      delete process.env.DISPRO_STRIPE_MOCK;
    } else {
      process.env.DISPRO_STRIPE_MOCK = previousMock;
    }
    if (previousPublishable === undefined) {
      delete process.env.STRIPE_PUBLISHABLE_KEY;
    } else {
      process.env.STRIPE_PUBLISHABLE_KEY = previousPublishable;
    }
    await close();
  }
});

test("requires three successful compute replicas before Use billing finalizes", async () => {
  const previousMock = process.env.DISPRO_STRIPE_MOCK;
  const previousPublishable = process.env.STRIPE_PUBLISHABLE_KEY;
  process.env.DISPRO_STRIPE_MOCK = "true";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_mock";
  const { baseUrl, close, store } = await createTestApi();

  try {
    const sessionToken = await signInAndGetSessionToken(baseUrl, "triple-use-owner@example.com");
    const useApiKeyResponse = await fetch(`${baseUrl}/auth/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ label: "use-triple", purpose: "use" })
    });
    const useApiKeyBody = (await useApiKeyResponse.json()) as { secret: string };

    await fetch(`${baseUrl}/billing/setup-session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    const createOrderResponse = await fetch(`${baseUrl}/use/orders?seed=triple-seed`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${useApiKeyBody.secret}`,
        "content-type": "application/json",
        "idempotency-key": "triple-order-000001"
      },
      body: JSON.stringify({
        id: "use_order_triple_001",
        source: {
          kind: "url",
          uri: "https://example.test/triple.txt",
          byteSize: 1024,
          contentHash: "triple-order-content-hash"
        },
        workload: "hash.compute",
        maxChargeMicroYen: 100_000_000
      })
    });
    assert.equal(createOrderResponse.status, 201);

    const plan = await store.getPlannedOrder("use_order_triple_001");
    const jobs = (await store.listProcessJobs()).filter((job) => job.orderId === "use_order_triple_001");
    const computeTask = plan?.tasks.find((task) => task.kind === "compute");
    assert.ok(computeTask);
    const computeJobs = jobs.filter((job) => job.taskId === computeTask.id);
    assert.equal(computeJobs.length, 3);
    assert.equal(new Set(computeJobs.map((job) => job.workUnitId)).size, 1);

    for (const job of computeJobs.slice(0, 2)) {
      await completeStoredJob(store, job.id, `hash-${job.workUnitId}`);
    }
    for (const job of jobs.filter((job) => job.taskId !== computeTask.id)) {
      await completeStoredJob(store, job.id, `hash-${job.workUnitId ?? job.id}`);
    }

    const pendingResponse = await fetch(`${baseUrl}/use/orders/use_order_triple_001`, {
      headers: {
        authorization: `Bearer ${useApiKeyBody.secret}`
      }
    });
    const pending = (await pendingResponse.json()) as { order: { status: string; billingStatus: string } };
    assert.notEqual(pending.order.status, "paid");

    await completeStoredJob(store, computeJobs[2]?.id ?? "", `hash-${computeJobs[2]?.workUnitId}`);
    const paidResponse = await fetch(`${baseUrl}/use/orders/use_order_triple_001`, {
      headers: {
        authorization: `Bearer ${useApiKeyBody.secret}`
      }
    });
    const paid = (await paidResponse.json()) as { order: { status: string; billingStatus: string } };
    assert.equal(paid.order.status, "paid");
    assert.equal(paid.order.billingStatus, "paid");
  } finally {
    if (previousMock === undefined) {
      delete process.env.DISPRO_STRIPE_MOCK;
    } else {
      process.env.DISPRO_STRIPE_MOCK = previousMock;
    }
    if (previousPublishable === undefined) {
      delete process.env.STRIPE_PUBLISHABLE_KEY;
    } else {
      process.env.STRIPE_PUBLISHABLE_KEY = previousPublishable;
    }
    await close();
  }
});

test("quotes Use work, enforces idempotency, and rejects plaintext secrets", async () => {
  const previousMock = process.env.DISPRO_STRIPE_MOCK;
  process.env.DISPRO_STRIPE_MOCK = "true";
  const { baseUrl, close } = await createTestApi();

  try {
    const sessionToken = await signInAndGetSessionToken(baseUrl, "secure-use@example.com");
    const keyResponse = await fetch(`${baseUrl}/auth/api-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "secure-use", purpose: "use" })
    });
    const { secret } = (await keyResponse.json()) as { secret: string };
    await fetch(`${baseUrl}/billing/setup-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: "{}"
    });
    const order = {
      source: { kind: "url", uri: "https://example.test/input.json", byteSize: 64 * 1024 * 1024, contentHash: "secure-content-hash-001" },
      workload: "data.transform"
    };
    const quote = await fetch(`${baseUrl}/use/quotes`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(order)
    });
    const quoteBody = (await quote.json()) as { quote?: { dataUnits: number }; error?: { message?: string } };
    assert.equal(quote.status, 200, quoteBody.error?.message);
    assert.equal(quoteBody.quote?.dataUnits, 1);

    const withoutKey = await fetch(`${baseUrl}/use/orders`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(order)
    });
    assert.equal(withoutKey.status, 400);

    const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json", "idempotency-key": "secure-order-key-0001" };
    const first = await fetch(`${baseUrl}/use/orders`, { method: "POST", headers, body: JSON.stringify(order) });
    const second = await fetch(`${baseUrl}/use/orders`, { method: "POST", headers, body: JSON.stringify(order) });
    const firstBody = (await first.json()) as { order: { id: string } };
    const secondBody = (await second.json()) as { order: { id: string } };
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(firstBody.order.id, secondBody.order.id);

    const secretOrder = await fetch(`${baseUrl}/use/quotes`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ ...order, parameters: { privateKey: "never-send-this" } })
    });
    assert.equal(secretOrder.status, 400);
  } finally {
    if (previousMock === undefined) delete process.env.DISPRO_STRIPE_MOCK;
    else process.env.DISPRO_STRIPE_MOCK = previousMock;
    await close();
  }
});

test("rejects protected order APIs without bearer authentication", async () => {
  const { baseUrl, close } = await createTestApi();

  try {
    const response = await fetch(`${baseUrl}/orders`);
    assert.equal(response.status, 401);
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
  store: FileDisproStore;
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
    store,
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

async function signInAndGetSessionToken(baseUrl: string, email: string): Promise<string> {
  const requestResponse = await fetch(`${baseUrl}/auth/request-code`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ email })
  });
  assert.equal(requestResponse.status, 202);

  const requestBody = (await requestResponse.json()) as { devVerificationCode?: string };
  assert.match(requestBody.devVerificationCode ?? "", /^\d{6}$/);

  const verifyResponse = await fetch(`${baseUrl}/auth/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ email, code: requestBody.devVerificationCode })
  });
  assert.equal(verifyResponse.status, 200);

  const verifyBody = (await verifyResponse.json()) as { sessionToken?: string };
  assert.ok(verifyBody.sessionToken);
  return verifyBody.sessionToken;
}

async function completeStoredJob(store: FileDisproStore, jobId: string, resultHash: string): Promise<void> {
  const job = await store.getProcessJob(jobId);
  assert.ok(job);
  await store.saveProcessJob({
    ...job,
    status: "completed",
    updatedAt: "2026-07-04T00:00:01.000Z"
  });
  await store.saveProcessJobResult({
    id: `result-${job.id}`,
    jobId: job.id,
    processNodeId: `node-${job.id}`,
    userId: "processor-user",
    status: "completed",
    resultHash,
    stdout: JSON.stringify({ ok: true, jobId: job.id }),
    stderr: "",
    durationMs: 25,
    metrics: {
      durationMs: 25,
      inputBytes: 16,
      outputBytes: 64,
      computeUnits: 3000,
      runnerWorkUnits: 3000
    },
    createdAt: "2026-07-04T00:00:01.000Z"
  });
}
