import { hashObject, makeId, stableStringify } from "../domain/ids.js";
import { PLATFORM_FEE_RATE } from "../domain/pricing.js";
import type {
  DistributedRecord,
  JsonRecord,
  OrderRequest,
  PlannedOrder,
  ProcessJob,
  ProcessJobResult,
  ProcessResultMetrics,
  UseOrderRecord,
  UserAccount,
  UserTransaction
} from "../domain/types.js";
import { planOrder } from "./orderOrchestrator.js";
import type { AuthContext } from "./authService.js";
import {
  chargeSavedPaymentMethod,
  getBillingStatus,
  getStripeMinimumChargeMicroYen
} from "./billingService.js";
import {
  enqueueDistributedRecordAnchorJob,
  enqueueProcessJobsForPlan,
  enqueueTransactionAnchorJob,
  getOrderProcessingState
} from "./processService.js";
import type { DisproStore } from "../storage/disproStore.js";
import { settleOrderRevenue } from "./revenueDistributionService.js";

export type CreateUseOrderInput = OrderRequest & {
  maxChargeMicroYen?: number;
};

export interface UseOrderView {
  order: UseOrderRecord;
  plan: PlannedOrder;
}

export async function createUseOrder(
  store: DisproStore,
  auth: AuthContext,
  input: CreateUseOrderInput,
  now = new Date(),
  seed?: string
): Promise<UseOrderView> {
  const billing = await getBillingStatus(store, auth, undefined, now);
  if (!billing.setupComplete) {
    throw new UseOrderError(402, "Register a payment method before creating Use orders.");
  }

  const nodes = await store.listNodes();
  const plan = planOrder({ ...input, customerId: auth.user.id }, nodes, {
    now,
    seed: seed ?? input.id ?? input.source?.contentHash
  });
  const estimatedMicroYen = plan.quote.totalMicroYen;
  const maxChargeMicroYen = normalizeMaxCharge(input.maxChargeMicroYen, estimatedMicroYen);
  const contractHash = hashObject({
    type: "use.order.contract",
    userId: auth.user.id,
    orderId: plan.order.id,
    source: plan.order.source,
    workload: plan.order.workload,
    maxChargeMicroYen
  });
  const useOrder: UseOrderRecord = {
    id: plan.order.id,
    userId: auth.user.id,
    plannedOrderId: plan.order.id,
    status: "queued",
    billingStatus: "pending",
    estimatedMicroYen,
    maxChargeMicroYen,
    contractHash,
    cid: `local-contract-${contractHash.slice(0, 32)}`,
    metrics: {
      durationMs: 0,
      inputBytes: plan.order.source.byteSize,
      outputBytes: 0,
      computeUnits: plan.quote.computeUnits,
      runnerWorkUnits: 0
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };

  await store.savePlannedOrder(plan);
  await store.saveUseOrder(useOrder);
  await enqueueProcessJobsForPlan(store, plan, now);
  await enqueueRecordAnchor(store, auth.user.id, "order.contract", `use-contract-${useOrder.id}`, {
    orderId: useOrder.id,
    contractHash,
    cid: useOrder.cid,
    estimatedMicroYen,
    maxChargeMicroYen,
    source: { ...plan.order.source },
    workload: plan.order.workload,
    createdAt: useOrder.createdAt
  }, now);

  return {
    order: useOrder,
    plan
  };
}

export async function getUseOrder(
  store: DisproStore,
  auth: AuthContext,
  orderId: string,
  now = new Date()
): Promise<UseOrderView> {
  const order = await requireOwnedUseOrder(store, auth.user.id, orderId);
  const plan = await requirePlan(store, order.plannedOrderId, auth.user.id);
  const refreshed = await refreshUseOrder(store, auth.user, order, plan, now);
  return {
    order: refreshed,
    plan
  };
}

export async function listUseOrders(
  store: DisproStore,
  auth: AuthContext,
  now = new Date()
): Promise<UseOrderRecord[]> {
  const orders = await store.listUseOrdersForUser(auth.user.id);
  const refreshed: UseOrderRecord[] = [];
  for (const order of orders) {
    const plan = await store.getPlannedOrder(order.plannedOrderId);
    refreshed.push(plan ? await refreshUseOrder(store, auth.user, order, plan, now) : order);
  }
  return refreshed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getUseOrderResult(
  store: DisproStore,
  auth: AuthContext,
  orderId: string,
  now = new Date()
): Promise<{ order: UseOrderRecord; result?: UseOrderRecord["result"] }> {
  const view = await getUseOrder(store, auth, orderId, now);
  if (!view.order.result) {
    throw new UseOrderError(404, "Order result is not ready yet.");
  }

  return {
    order: view.order,
    result: view.order.result
  };
}

export async function markUseOrderPaymentFromStripe(
  store: DisproStore,
  paymentIntentId: string,
  status: "succeeded" | "failed",
  now = new Date()
): Promise<void> {
  const orders = await Promise.all((await store.listPlannedOrders()).map((plan) => store.getUseOrder(plan.order.id)));
  const order = orders.find((candidate) => candidate?.stripePaymentIntentId === paymentIntentId);
  if (!order) {
    return;
  }

  const updated: UseOrderRecord = {
    ...order,
    status: status === "succeeded" ? "paid" : "payment_failed",
    billingStatus: status === "succeeded" ? "paid" : "failed",
    updatedAt: now.toISOString()
  };
  await store.saveUseOrder(updated);
}

async function refreshUseOrder(
  store: DisproStore,
  user: UserAccount,
  order: UseOrderRecord,
  plan: PlannedOrder,
  now: Date
): Promise<UseOrderRecord> {
  if (["paid", "payment_pending", "payment_failed", "failed"].includes(order.status)) {
    return order;
  }

  const processingState = await getOrderProcessingState(store, plan.order.id);
  if (!processingState.ready && !processingState.failed && processingState.pendingWorkUnitIds.length === 0) {
    return order;
  }

  if (processingState.failed) {
    const failed = {
      ...order,
      status: "failed" as const,
      updatedAt: now.toISOString()
    };
    await store.saveUseOrder(failed);
    return failed;
  }

  if (!processingState.ready) {
    const status: UseOrderRecord["status"] = processingState.processing ? "processing" : "queued";
    const processing: UseOrderRecord = {
      ...order,
      status,
      updatedAt: now.toISOString()
    };
    await store.saveUseOrder(processing);
    return processing;
  }

  const results = processingState.results;
  if (results.length === 0) {
    return order;
  }

  const metrics = combineMetrics(plan, results);
  const finalMicroYen = calculateFinalMicroYen(plan, metrics, order.maxChargeMicroYen);
  const completedAt = now.toISOString();
  const resultHash = hashObject({
    orderId: order.id,
    results: results.map((result) => ({
      jobId: result.jobId,
      resultHash: result.resultHash,
      metrics: result.metrics
    }))
  });
  const resultUrl = parseResultUrl(results);
  const result: NonNullable<UseOrderRecord["result"]> = {
    resultHash,
    resultCid: `local-result-${resultHash.slice(0, 32)}`,
    completedAt
  };
  if (resultUrl !== undefined) {
    result.resultUrl = resultUrl;
  }
  if (metrics.outputBytes !== undefined) {
    result.outputBytes = metrics.outputBytes;
  }

  const baseCompleted: UseOrderRecord = {
    ...order,
    status: "completed",
    billingStatus: "pending",
    metrics,
    finalMicroYen,
    result,
    completedAt,
    updatedAt: completedAt
  };
  await store.saveUseOrder(baseCompleted);
  await ensureUsageChargeTransaction(store, user.id, baseCompleted, "pending", now);
  await enqueueRecordAnchor(store, user.id, "order.result", `use-result-${order.id}`, {
    orderId: order.id,
    result: toJsonRecord(result),
    metrics: toJsonRecord(metrics),
    finalMicroYen
  }, now);

  if (finalMicroYen < getStripeMinimumChargeMicroYen()) {
    const held: UseOrderRecord = {
      ...baseCompleted,
      status: "payment_pending",
      billingStatus: "held",
      billedMicroYen: 0,
      updatedAt: now.toISOString()
    };
    await store.saveUseOrder(held);
    await enqueueRecordAnchor(store, user.id, "billing.charge", `use-billing-held-${order.id}`, {
      orderId: order.id,
      finalMicroYen,
      status: "held"
    }, now);
    return held;
  }

  const charge = await chargeSavedPaymentMethod(store, user, order.id, finalMicroYen, now);
  const charged: UseOrderRecord = {
    ...baseCompleted,
    status: charge.status === "succeeded" ? "paid" : charge.status === "failed" ? "payment_failed" : "completed",
    billingStatus: charge.status === "succeeded" ? "paid" : charge.status === "failed" ? "failed" : "pending",
    billedMicroYen: charge.status === "succeeded" ? finalMicroYen : 0,
    stripePaymentIntentId: charge.paymentIntentId,
    updatedAt: now.toISOString()
  };
  await store.saveUseOrder(charged);
  await ensureStripePaymentTransaction(store, user.id, charged, charge, now);
  await enqueueRecordAnchor(store, user.id, "billing.charge", `use-billing-${order.id}`, {
    orderId: order.id,
    finalMicroYen,
    amountYen: charge.amountYen,
    status: charge.status,
    stripePaymentIntentId: charge.paymentIntentId
  }, now);
  if (charge.status === "succeeded") {
    const distribution = await settleOrderRevenue(store, charged, now);
    return {
      ...charged,
      ...(distribution === undefined
        ? {}
        : {
            platformFeeMicroYen: distribution.platformFeeMicroYen,
            workerPoolMicroYen: distribution.workerPoolMicroYen,
            distributionStatus: "settled" as const
          })
    };
  }
  return charged;
}

async function getResultsForJobs(store: DisproStore, jobs: readonly ProcessJob[]): Promise<ProcessJobResult[]> {
  const jobIds = new Set(jobs.map((job) => job.id));
  return (await store.listProcessJobResults()).filter((result) => jobIds.has(result.jobId));
}

function combineMetrics(plan: PlannedOrder, results: readonly ProcessJobResult[]): ProcessResultMetrics {
  return {
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    inputBytes: plan.order.source.byteSize,
    outputBytes: results.reduce((sum, result) => sum + (result.metrics?.outputBytes ?? result.stdout.length), 0),
    computeUnits: results.reduce((sum, result) => sum + (result.metrics?.computeUnits ?? 0), 0),
    runnerWorkUnits: results.reduce((sum, result) => sum + (result.metrics?.runnerWorkUnits ?? 0), 0)
  };
}

function calculateFinalMicroYen(
  plan: PlannedOrder,
  metrics: ProcessResultMetrics,
  maxChargeMicroYen: number
): number {
  const measuredUnits =
    metrics.computeUnits && metrics.computeUnits > 0
      ? metrics.computeUnits
      : metrics.runnerWorkUnits && metrics.runnerWorkUnits > 0
        ? metrics.runnerWorkUnits
        : plan.quote.computeUnits;
  const scale = Math.max(1, measuredUnits / Math.max(1, plan.quote.computeUnits));
  const variable = Math.ceil((plan.quote.computeMicroYen + plan.quote.verificationMicroYen) * scale);
  const subtotal = plan.quote.baseMicroYen + variable;
  const platformFee = Math.ceil(subtotal * PLATFORM_FEE_RATE);
  return Math.min(maxChargeMicroYen, subtotal + platformFee);
}

async function ensureUsageChargeTransaction(
  store: DisproStore,
  userId: string,
  order: UseOrderRecord,
  status: UserTransaction["status"],
  now: Date
): Promise<UserTransaction> {
  const existing = (await store.listUserTransactions(userId)).find(
    (transaction) => transaction.kind === "usage_charge" && transaction.relatedOrderId === order.id
  );
  if (existing) {
    return existing;
  }

  const transaction: UserTransaction = {
    id: makeId("txn", { userId, orderId: order.id, kind: "usage_charge" }),
    userId,
    kind: "usage_charge",
    amountMicroYen: order.finalMicroYen ?? order.estimatedMicroYen,
    currency: "JPY_MICRO",
    status,
    relatedOrderId: order.id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await store.saveUserTransaction(transaction);
  await enqueueTransactionAnchorJob(store, transaction, now);
  return transaction;
}

async function ensureStripePaymentTransaction(
  store: DisproStore,
  userId: string,
  order: UseOrderRecord,
  charge: { status: "succeeded" | "pending" | "failed"; paymentIntentId: string; failureMessage?: string },
  now: Date
): Promise<UserTransaction> {
  const kind = charge.status === "failed" ? "stripe_payment_failed" : "stripe_payment";
  const existing = (await store.listUserTransactions(userId)).find(
    (transaction) => transaction.kind === kind && transaction.stripePaymentIntentId === charge.paymentIntentId
  );
  if (existing) {
    return existing;
  }

  const transaction: UserTransaction = {
    id: makeId("txn", { userId, orderId: order.id, kind, paymentIntentId: charge.paymentIntentId }),
    userId,
    kind,
    amountMicroYen: order.finalMicroYen ?? order.estimatedMicroYen,
    currency: "JPY_MICRO",
    status: charge.status === "failed" ? "failed" : "settled",
    relatedOrderId: order.id,
    stripePaymentIntentId: charge.paymentIntentId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await store.saveUserTransaction(transaction);
  await enqueueTransactionAnchorJob(store, transaction, now);
  return transaction;
}

async function enqueueRecordAnchor(
  store: DisproStore,
  userId: string,
  recordType: DistributedRecord["type"],
  sourceId: string,
  payload: JsonRecord,
  now: Date
): Promise<void> {
  const encryptedJson = stableStringify(payload);
  await enqueueDistributedRecordAnchorJob(
    store,
    userId,
    {
      recordType,
      ownerUserId: userId,
      sourceId,
      provider: "local",
      encryptedJson
    },
    sourceId,
    now
  );
}

async function requireOwnedUseOrder(store: DisproStore, userId: string, orderId: string): Promise<UseOrderRecord> {
  const order = await store.getUseOrder(orderId);
  if (!order || order.userId !== userId) {
    throw new UseOrderError(404, `Use order not found: ${orderId}`);
  }
  return order;
}

async function requirePlan(store: DisproStore, orderId: string, userId: string): Promise<PlannedOrder> {
  const plan = await store.getPlannedOrder(orderId);
  if (!plan || plan.order.customerId !== userId) {
    throw new UseOrderError(404, `Order plan not found: ${orderId}`);
  }
  return plan;
}

function normalizeMaxCharge(value: number | undefined, estimatedMicroYen: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.ceil(estimatedMicroYen * 1.25);
  }
  return Math.max(1, Math.floor(value));
}

function parseResultUrl(results: readonly ProcessJobResult[]): string | undefined {
  for (const result of results) {
    const parsed = parseJsonObject(result.stdout);
    if (typeof parsed.resultUrl === "string") {
      return parsed.resultUrl;
    }
    if (typeof parsed.url === "string") {
      return parsed.url;
    }
  }
  return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toJsonRecord(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

export class UseOrderError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
