import assert from "node:assert/strict";
import test from "node:test";
import { verifyAuditChain } from "../src/domain/auditLog.js";
import { quoteOrder } from "../src/domain/pricing.js";
import type { OrderRequest } from "../src/domain/types.js";
import { sampleNodes } from "../src/sample/sampleNodes.js";
import { planOrder } from "../src/services/orderOrchestrator.js";

const baseOrder: OrderRequest = {
  id: "ord_test_pdf_001",
  customerId: "customer_test_001",
  source: {
    kind: "file",
    uri: "dispro://upload/test.pdf",
    byteSize: 37_500_000,
    contentHash: "6e34f6df00f1925c2d9f3bc36ef37d60f7c9f239d263ccacf56ecb113ba759ac"
  },
  workload: "pdf.compress",
  priority: "standard",
  verificationLevel: "standard",
  requirements: {
    allowMobileVerification: true
  }
};

test("plans an order into compute, verification, and canary tasks", () => {
  const plan = planOrder(baseOrder, sampleNodes, {
    now: new Date("2026-07-04T00:00:00.000Z"),
    seed: "test-seed"
  });

  const computeTasks = plan.tasks.filter((task) => task.kind === "compute");
  const verificationTasks = plan.tasks.filter((task) => task.kind === "verification");
  const canaryTasks = plan.tasks.filter((task) => task.kind === "canary");

  assert.equal(computeTasks.length, 4);
  assert.equal(verificationTasks.length, 1);
  assert.equal(canaryTasks.length, 1);
  assert.equal(plan.unassignedTasks.length, 0);
  assert.equal(plan.assignments.length, plan.tasks.length);
});

test("keeps verification tasks away from their original compute node", () => {
  const plan = planOrder(baseOrder, sampleNodes, {
    now: new Date("2026-07-04T00:00:00.000Z"),
    seed: "test-seed"
  });

  const assignmentByTaskId = new Map(plan.assignments.map((assignment) => [assignment.taskId, assignment]));
  const verificationTasks = plan.tasks.filter((task) => task.kind === "verification");

  assert.ok(verificationTasks.length > 0);

  for (const task of verificationTasks) {
    const sourceTaskId = task.verification.verificationOfTaskId;
    assert.ok(sourceTaskId);

    const sourceAssignment = assignmentByTaskId.get(sourceTaskId);
    const verificationAssignment = assignmentByTaskId.get(task.id);

    assert.ok(sourceAssignment);
    assert.ok(verificationAssignment);
    assert.notEqual(verificationAssignment.nodeId, sourceAssignment.nodeId);
  }
});

test("uses micro-yen pricing with a five percent platform fee", () => {
  const plan = planOrder(baseOrder, sampleNodes, {
    now: new Date("2026-07-04T00:00:00.000Z"),
    seed: "test-seed"
  });
  const quote = quoteOrder(plan.order);

  assert.deepEqual(plan.quote, quote);
  assert.equal(plan.quote.platformFeeMicroYen, Math.ceil(plan.quote.subtotalMicroYen * 0.05));
  assert.ok(plan.quote.totalMicroYen > plan.quote.subtotalMicroYen);
});

test("creates a verifiable audit hash chain", () => {
  const plan = planOrder(baseOrder, sampleNodes, {
    now: new Date("2026-07-04T00:00:00.000Z"),
    seed: "test-seed"
  });

  assert.ok(plan.auditEvents.length > plan.tasks.length);
  assert.equal(verifyAuditChain(plan.auditEvents), true);

  const tampered = plan.auditEvents.map((event) => ({ ...event }));
  const second = tampered[1];
  assert.ok(second);
  second.previousHash = "tampered";

  assert.equal(verifyAuditChain(tampered), false);
});
