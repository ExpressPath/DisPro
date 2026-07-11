import Stripe from "stripe";
import { makeId } from "../domain/ids.js";
import type { BillingCustomer, UserAccount, UserTransaction } from "../domain/types.js";
import type { DisproStore } from "../storage/disproStore.js";

const MIN_PAYOUT_MICRO_YEN = 1_000 * 1_000_000;

export interface WalletSummary {
  currency: "JPY_MICRO";
  provisionalMicroYen: number;
  availableMicroYen: number;
  reservedMicroYen: number;
  paidOutMicroYen: number;
  minimumPayoutMicroYen: number;
  payout: { connected: boolean; payoutsEnabled: boolean; accountId?: string };
}

export async function getWalletSummary(store: DisproStore, userId: string): Promise<WalletSummary> {
  const [transactions, customer] = await Promise.all([store.listUserTransactions(userId), store.getBillingCustomerByUserId(userId)]);
  const provisionalMicroYen = sum(transactions, (transaction) => transaction.kind === "provisional_earning" && transaction.status !== "failed");
  const confirmedMicroYen = sum(transactions, (transaction) => transaction.kind === "confirmed_earning" && transaction.status !== "failed");
  const pendingPayoutMicroYen = sum(transactions, (transaction) => transaction.kind === "external_payment" && transaction.status === "pending");
  const paidOutMicroYen = sum(transactions, (transaction) => transaction.kind === "external_payment" && transaction.status === "settled");
  return {
    currency: "JPY_MICRO",
    provisionalMicroYen,
    availableMicroYen: Math.max(0, confirmedMicroYen - pendingPayoutMicroYen - paidOutMicroYen),
    reservedMicroYen: pendingPayoutMicroYen,
    paidOutMicroYen,
    minimumPayoutMicroYen: MIN_PAYOUT_MICRO_YEN,
    payout: publicPayoutCustomer(customer)
  };
}

export async function createConnectOnboarding(
  store: DisproStore,
  user: UserAccount,
  baseUrl: string,
  now = new Date()
): Promise<{ url: string; accountId: string }> {
  const customer = await ensureCustomer(store, user, now);
  const stripe = getStripe();
  const accountId = customer.stripeConnectAccountId ?? (
    await stripe.accounts.create({
      type: "express",
      email: user.email,
      capabilities: { transfers: { requested: true } },
      metadata: { disproUserId: user.id }
    })
  ).id;
  await store.saveBillingCustomer({ ...customer, stripeConnectAccountId: accountId, updatedAt: now.toISOString() });
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${baseUrl}/account`,
    return_url: `${baseUrl}/account`,
    type: "account_onboarding"
  });
  return { url: link.url, accountId };
}

export async function refreshConnectStatus(store: DisproStore, user: UserAccount, now = new Date()): Promise<WalletSummary> {
  const customer = await store.getBillingCustomerByUserId(user.id);
  if (!customer?.stripeConnectAccountId || !isStripeConfigured()) return getWalletSummary(store, user.id);
  const account = await getStripe().accounts.retrieve(customer.stripeConnectAccountId);
  await store.saveBillingCustomer({ ...customer, payoutsEnabled: account.payouts_enabled, updatedAt: now.toISOString() });
  return getWalletSummary(store, user.id);
}

export async function requestPayout(
  store: DisproStore,
  user: UserAccount,
  amountMicroYen: number,
  now = new Date()
): Promise<{ transaction: UserTransaction; wallet: WalletSummary }> {
  if (!process.env.DISPRO_ENABLE_PAYOUTS || process.env.DISPRO_ENABLE_PAYOUTS !== "true") {
    throw new WalletError(503, "Payouts are not enabled yet.");
  }
  const wallet = await refreshConnectStatus(store, user, now);
  if (!wallet.payout.payoutsEnabled || !wallet.payout.accountId) throw new WalletError(403, "Complete Stripe Connect verification before requesting a payout.");
  if (!Number.isSafeInteger(amountMicroYen) || amountMicroYen < MIN_PAYOUT_MICRO_YEN || amountMicroYen > wallet.availableMicroYen) {
    throw new WalletError(400, "Payout amount is outside the available balance or minimum payout threshold.");
  }
  const transfer = await getStripe().transfers.create({
    amount: Math.ceil(amountMicroYen / 1_000_000),
    currency: "jpy",
    destination: wallet.payout.accountId,
    metadata: { disproUserId: user.id, amountMicroYen: String(amountMicroYen) }
  });
  const nowIso = now.toISOString();
  const transaction: UserTransaction = {
    id: makeId("txn", { userId: user.id, transferId: transfer.id }),
    userId: user.id,
    kind: "external_payment",
    amountMicroYen,
    currency: "JPY_MICRO",
    status: "settled",
    createdAt: nowIso,
    updatedAt: nowIso
  };
  await store.saveUserTransaction(transaction);
  return { transaction, wallet: await getWalletSummary(store, user.id) };
}

function sum(transactions: readonly UserTransaction[], predicate: (transaction: UserTransaction) => boolean): number {
  return transactions.filter(predicate).reduce((total, transaction) => total + transaction.amountMicroYen, 0);
}

function publicPayoutCustomer(customer: BillingCustomer | undefined): WalletSummary["payout"] {
  const result: WalletSummary["payout"] = { connected: Boolean(customer?.stripeConnectAccountId), payoutsEnabled: customer?.payoutsEnabled ?? false };
  if (customer?.stripeConnectAccountId) result.accountId = customer.stripeConnectAccountId;
  return result;
}

async function ensureCustomer(store: DisproStore, user: UserAccount, now: Date): Promise<BillingCustomer> {
  const existing = await store.getBillingCustomerByUserId(user.id);
  if (existing) return existing;
  const nowIso = now.toISOString();
  const stripeCustomerId = (await getStripe().customers.create({ email: user.email, metadata: { disproUserId: user.id } })).id;
  const customer: BillingCustomer = { userId: user.id, stripeCustomerId, setupComplete: false, createdAt: nowIso, updatedAt: nowIso };
  await store.saveBillingCustomer(customer);
  return customer;
}

function getStripe(): Stripe {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new WalletError(503, "Stripe is not configured.");
  return new Stripe(secret);
}

function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export class WalletError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
