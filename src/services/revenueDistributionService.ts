import { hashObject, makeId, stableStringify } from "../domain/ids.js";
import type { JsonRecord, ProcessJob, ProcessJobResult, UseOrderRecord, UserTransaction, WorkUnit } from "../domain/types.js";
import type { DisproStore } from "../storage/disproStore.js";
import { enqueueDistributedRecordAnchorJob, enqueueTransactionAnchorJob } from "./processService.js";

const DEFAULT_WORKER_SHARE_BPS = 9_000;
const TREASURY_USER_ID = "dispro-treasury";

export interface RevenueAllocation {
  userId: string;
  amountMicroYen: number;
  contributionUnits: number;
  contributionShareBps: number;
  jobIds: string[];
  processNodeIds: string[];
}

export interface RevenueDistributionSummary {
  settlementId: string;
  grossMicroYen: number;
  platformFeeMicroYen: number;
  workerPoolMicroYen: number;
  workerShareBps: number;
  allocations: RevenueAllocation[];
}

/**
 * Converts a successfully collected Use charge into immutable, idempotent ledger entries.
 * Actual bank/crypto withdrawals are deliberately a separate, KYC-gated payout step.
 */
export async function settleOrderRevenue(
  store: DisproStore,
  order: UseOrderRecord,
  now = new Date()
): Promise<RevenueDistributionSummary | undefined> {
  const grossMicroYen = order.billedMicroYen ?? order.finalMicroYen;
  if (order.billingStatus !== "paid" || !grossMicroYen || grossMicroYen <= 0) {
    return undefined;
  }

  const settlementId = `settlement:${order.id}`;
  const existing = await loadExistingDistribution(store, settlementId, order.id);
  if (existing) {
    return existing;
  }

  const [jobs, results, workUnits] = await Promise.all([
    store.listProcessJobs(),
    store.listProcessJobResults(),
    store.listWorkUnits()
  ]);
  const allocations = calculateAllocations(order.id, jobs, results, workUnits);
  if (allocations.length === 0) {
    throw new RevenueDistributionError("Cannot settle an order without canonical Process contributions.");
  }

  const workerShareBps = getWorkerShareBps();
  const workerPoolMicroYen = Math.floor((grossMicroYen * workerShareBps) / 10_000);
  const platformFeeMicroYen = grossMicroYen - workerPoolMicroYen;
  allocateMicroYen(workerPoolMicroYen, allocations);

  const summary: RevenueDistributionSummary = {
    settlementId,
    grossMicroYen,
    platformFeeMicroYen,
    workerPoolMicroYen,
    workerShareBps,
    allocations
  };
  const nowIso = now.toISOString();

  const platformTransaction: UserTransaction = {
    id: makeId("txn", { settlementId, kind: "platform_fee" }),
    userId: TREASURY_USER_ID,
    kind: "platform_fee",
    amountMicroYen: platformFeeMicroYen,
    currency: "JPY_MICRO",
    status: "settled",
    relatedOrderId: order.id,
    ...(order.stripePaymentIntentId === undefined ? {} : { stripePaymentIntentId: order.stripePaymentIntentId }),
    settlementId,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  await store.saveUserTransaction(platformTransaction);
  await enqueueTransactionAnchorJob(store, platformTransaction, now);

  for (const allocation of allocations) {
    const transaction: UserTransaction = {
      id: makeId("txn", { settlementId, userId: allocation.userId, kind: "confirmed_earning" }),
      userId: allocation.userId,
      kind: "confirmed_earning",
      amountMicroYen: allocation.amountMicroYen,
      currency: "JPY_MICRO",
      status: "settled",
      relatedOrderId: order.id,
      ...(order.stripePaymentIntentId === undefined ? {} : { stripePaymentIntentId: order.stripePaymentIntentId }),
      settlementId,
      contributionUnits: allocation.contributionUnits,
      contributionShareBps: allocation.contributionShareBps,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    await store.saveUserTransaction(transaction);
    await enqueueTransactionAnchorJob(store, transaction, now);
  }

  await enqueueDistributedRecordAnchorJob(
    store,
    TREASURY_USER_ID,
    {
      recordType: "revenue.distribution",
      ownerUserId: TREASURY_USER_ID,
      sourceId: settlementId,
      provider: "local",
      encryptedJson: stableStringify({
        ...summary,
        orderId: order.id,
        paymentIntentHash: order.stripePaymentIntentId ? hashObject({ id: order.stripePaymentIntentId }) : undefined,
        createdAt: nowIso
      })
    },
    settlementId,
    now
  );

  await store.saveUseOrder({
    ...order,
    platformFeeMicroYen,
    workerPoolMicroYen,
    distributionStatus: "settled",
    updatedAt: nowIso
  });
  return summary;
}

async function loadExistingDistribution(
  store: DisproStore,
  settlementId: string,
  orderId: string
): Promise<RevenueDistributionSummary | undefined> {
  const jobs = (await store.listProcessJobs()).filter((job) => job.orderId === orderId);
  const userIds = new Set(jobs.map((job) => job.assignedUserId).filter((value): value is string => Boolean(value)));
  const transactions = await Promise.all([...userIds].map((userId) => store.listUserTransactions(userId)));
  const earnings = transactions.flat().filter(
    (transaction) => transaction.kind === "confirmed_earning" && transaction.settlementId === settlementId
  );
  if (earnings.length === 0) {
    return undefined;
  }
  const workerPoolMicroYen = earnings.reduce((sum, transaction) => sum + transaction.amountMicroYen, 0);
  const workerShareBps = getWorkerShareBps();
  if (workerShareBps === 0) {
    return undefined;
  }
  const platformFeeMicroYen = Math.ceil((workerPoolMicroYen * (10_000 - workerShareBps)) / workerShareBps);
  return {
    settlementId,
    grossMicroYen: workerPoolMicroYen + platformFeeMicroYen,
    platformFeeMicroYen,
    workerPoolMicroYen,
    workerShareBps,
    allocations: earnings.map((transaction) => ({
      userId: transaction.userId,
      amountMicroYen: transaction.amountMicroYen,
      contributionUnits: transaction.contributionUnits ?? 0,
      contributionShareBps: transaction.contributionShareBps ?? 0,
      jobIds: [],
      processNodeIds: []
    }))
  };
}

function calculateAllocations(
  orderId: string,
  allJobs: readonly ProcessJob[],
  allResults: readonly ProcessJobResult[],
  allWorkUnits: readonly WorkUnit[]
): RevenueAllocation[] {
  const jobs = new Map(allJobs.filter((job) => job.orderId === orderId).map((job) => [job.id, job]));
  const canonicalHashes = new Map(
    allWorkUnits
      .filter((workUnit) => workUnit.orderId === orderId && workUnit.status === "canonical" && workUnit.canonicalResultHash)
      .map((workUnit) => [workUnit.id, workUnit.canonicalResultHash as string])
  );
  // The order read path already requires consensus. Derive the same canonical hash
  // here as a fallback so webhook settlement is robust to an older stored snapshot.
  for (const job of jobs.values()) {
    if (!job.workUnitId || canonicalHashes.has(job.workUnitId)) {
      continue;
    }
    const completed = allResults.filter((result) => result.status === "completed" && result.jobId === job.id);
    if (completed.length === 0) {
      continue;
    }
    const groupJobs = [...jobs.values()].filter((candidate) => candidate.workUnitId === job.workUnitId);
    const groupResults = allResults.filter(
      (result) => result.status === "completed" && groupJobs.some((candidate) => candidate.id === result.jobId)
    );
    const counts = new Map<string, number>();
    for (const result of groupResults) {
      counts.set(result.resultHash, (counts.get(result.resultHash) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const requiredSuccessful = groupJobs[0]?.requiredSuccessfulReplicas ?? groupJobs.length;
    const minConsensus = groupJobs[0]?.minConsensus ?? 1;
    if (groupResults.length >= requiredSuccessful && (best?.[1] ?? 0) >= minConsensus && best) {
      canonicalHashes.set(job.workUnitId, best[0]);
    }
  }
  const byUser = new Map<string, RevenueAllocation>();

  for (const result of allResults) {
    const job = jobs.get(result.jobId);
    const contributorUserId = job?.assignedUserId ?? result.userId;
    if (!job || result.status !== "completed" || !job.workUnitId || !contributorUserId) {
      continue;
    }
    if (canonicalHashes.get(job.workUnitId) !== result.resultHash) {
      continue;
    }
    const contributionUnits = calculateContributionUnits(result);
    const allocation = byUser.get(contributorUserId) ?? {
      userId: contributorUserId,
      amountMicroYen: 0,
      contributionUnits: 0,
      contributionShareBps: 0,
      jobIds: [],
      processNodeIds: []
    };
    allocation.contributionUnits += contributionUnits;
    allocation.jobIds.push(job.id);
    if (result.processNodeId && !allocation.processNodeIds.includes(result.processNodeId)) {
      allocation.processNodeIds.push(result.processNodeId);
    }
    byUser.set(allocation.userId, allocation);
  }

  return [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}

function calculateContributionUnits(result: ProcessJobResult): number {
  const metrics = result.metrics;
  const runnerUnits = positive(metrics?.runnerWorkUnits);
  const computeUnits = positive(metrics?.computeUnits);
  const measuredDurationUnits = Math.floor(Math.min(3_600_000, Math.max(0, result.durationMs)) / 10);
  return Math.max(1, Math.min(1_000_000_000, Math.max(runnerUnits, computeUnits, measuredDurationUnits)));
}

function allocateMicroYen(workerPoolMicroYen: number, allocations: RevenueAllocation[]): void {
  const totalUnits = allocations.reduce((sum, allocation) => sum + allocation.contributionUnits, 0);
  let assigned = 0;
  const remainders = allocations.map((allocation) => {
    const exactNumerator = workerPoolMicroYen * allocation.contributionUnits;
    allocation.amountMicroYen = Math.floor(exactNumerator / totalUnits);
    allocation.contributionShareBps = Math.floor((allocation.contributionUnits * 10_000) / totalUnits);
    assigned += allocation.amountMicroYen;
    return { allocation, remainder: exactNumerator % totalUnits };
  });
  remainders.sort((a, b) => b.remainder - a.remainder || a.allocation.userId.localeCompare(b.allocation.userId));
  for (let index = 0; index < workerPoolMicroYen - assigned; index += 1) {
    remainders[index % remainders.length]!.allocation.amountMicroYen += 1;
  }
}

function getWorkerShareBps(): number {
  const configured = Number.parseInt(process.env.DISPRO_WORKER_SHARE_BPS ?? String(DEFAULT_WORKER_SHARE_BPS), 10);
  return Number.isFinite(configured) ? Math.max(0, Math.min(10_000, configured)) : DEFAULT_WORKER_SHARE_BPS;
}

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export class RevenueDistributionError extends Error {}
