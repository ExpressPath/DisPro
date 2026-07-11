import type { Order, PriceQuote, Priority, VerificationLevel } from "./types.js";
import { getWorkloadProfile } from "./workloads.js";

/** The API-side service fee applied to measured compute and verification cost. */
export const PLATFORM_FEE_RATE = 0.1;
export const DATA_UNIT_BYTES = 64 * 1024 * 1024;
export const ISOLATED_CODE_CREDIT_MICRO_YEN = 500_000;

const DATA_RATES_MICRO_YEN: Record<string, number> = {
  "hash.compute": 50_000,
  "proof.verify": 50_000,
  "image.convert": 250_000,
  "pdf.compress": 250_000,
  "data.transform": 250_000,
  "code.test": 250_000,
  "video.transcode": 5_000_000
};

const PRIORITY_MULTIPLIER: Record<Priority, number> = {
  economy: 0.8,
  standard: 1,
  urgent: 1.8
};

const VERIFICATION_MULTIPLIER: Record<VerificationLevel, number> = {
  light: 0.04,
  standard: 0.08,
  strict: 0.18
};

export function estimateComputeUnits(order: Order): number {
  return Math.max(1, Math.ceil(Math.max(1, order.source.byteSize) / DATA_UNIT_BYTES));
}

export function quoteOrder(order: Order): PriceQuote {
  const profile = getWorkloadProfile(order.workload, order.requirements.workloadProfile);
  const computeUnits = estimateComputeUnits(order);
  const executionCredits = normalizeExecutionCredits(order.requirements.executionCredits, order.workload);
  const priorityMultiplier = PRIORITY_MULTIPLIER[order.priority];
  const rate = DATA_RATES_MICRO_YEN[order.workload] ?? DATA_RATES_MICRO_YEN["data.transform"]!;
  const computeMicroYen = Math.ceil(computeUnits * rate * priorityMultiplier);
  const verificationMicroYen = Math.ceil(computeMicroYen * VERIFICATION_MULTIPLIER[order.verificationLevel]);
  const baseMicroYen = executionCredits * ISOLATED_CODE_CREDIT_MICRO_YEN;
  const subtotalMicroYen = baseMicroYen + computeMicroYen + verificationMicroYen;
  const platformFeeMicroYen = Math.ceil(subtotalMicroYen * PLATFORM_FEE_RATE);
  const totalMicroYen = subtotalMicroYen + platformFeeMicroYen;

  return {
    currency: "JPY_MICRO",
    computeUnits,
    dataUnits: computeUnits,
    executionCredits,
    inputBytes: order.source.byteSize,
    baseMicroYen,
    computeMicroYen,
    verificationMicroYen,
    priorityMultiplier,
    subtotalMicroYen,
    platformFeeRate: PLATFORM_FEE_RATE,
    platformFeeMicroYen,
    totalMicroYen
  };
}

function normalizeExecutionCredits(value: number | undefined, workload: string): number {
  const defaultCredits = workload === "code.test" ? 1 : 0;
  if (value === undefined) {
    return defaultCredits;
  }
  return Math.max(0, Math.min(100, Math.floor(value)));
}

export function microYenToYen(value: number): number {
  return value / 1_000_000;
}

function roundUp(value: number, decimals: number): number {
  const multiplier = 10 ** decimals;
  return Math.ceil(value * multiplier) / multiplier;
}
