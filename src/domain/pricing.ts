import type { Order, PriceQuote, Priority, VerificationLevel } from "./types.js";
import { getWorkloadProfile } from "./workloads.js";

const PLATFORM_FEE_RATE = 0.05;

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
  const profile = getWorkloadProfile(order.workload, order.requirements.workloadProfile);
  const rawUnits = Math.max(1, order.source.byteSize / profile.unitBytes);
  return roundUp(rawUnits, 2);
}

export function quoteOrder(order: Order): PriceQuote {
  const profile = getWorkloadProfile(order.workload, order.requirements.workloadProfile);
  const computeUnits = estimateComputeUnits(order);
  const priorityMultiplier = PRIORITY_MULTIPLIER[order.priority];
  const computeMicroYen = Math.ceil(computeUnits * profile.computeMicroYenPerUnit * priorityMultiplier);
  const verificationMicroYen = Math.ceil(computeMicroYen * VERIFICATION_MULTIPLIER[order.verificationLevel]);
  const subtotalMicroYen = profile.baseMicroYen + computeMicroYen + verificationMicroYen;
  const platformFeeMicroYen = Math.ceil(subtotalMicroYen * PLATFORM_FEE_RATE);
  const totalMicroYen = subtotalMicroYen + platformFeeMicroYen;

  return {
    currency: "JPY_MICRO",
    computeUnits,
    baseMicroYen: profile.baseMicroYen,
    computeMicroYen,
    verificationMicroYen,
    priorityMultiplier,
    subtotalMicroYen,
    platformFeeRate: PLATFORM_FEE_RATE,
    platformFeeMicroYen,
    totalMicroYen
  };
}

export function microYenToYen(value: number): number {
  return value / 1_000_000;
}

function roundUp(value: number, decimals: number): number {
  const multiplier = 10 ** decimals;
  return Math.ceil(value * multiplier) / multiplier;
}
