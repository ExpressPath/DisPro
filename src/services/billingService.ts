import Stripe from "stripe";
import { makeId } from "../domain/ids.js";
import type { BillingCustomer, UserAccount, UseOrderRecord } from "../domain/types.js";
import type { AuthContext } from "./authService.js";
import type { DisproStore } from "../storage/disproStore.js";
import { settleOrderRevenue } from "./revenueDistributionService.js";

export interface BillingSetupInput {
  successUrl?: string;
  cancelUrl?: string;
  baseUrl: string;
}

export interface BillingStatus {
  configured: boolean;
  publishableKey?: string;
  setupComplete: boolean;
  stripeCustomerId?: string;
  defaultPaymentMethodId?: string;
}

export interface SetupSessionResult {
  configured: boolean;
  setupComplete: boolean;
  stripeCustomerId: string;
  sessionId?: string;
  url?: string;
  publishableKey?: string;
}

export interface StripeChargeResult {
  status: "succeeded" | "pending" | "failed";
  paymentIntentId: string;
  amountYen: number;
  failureMessage?: string;
}

export async function getBillingStatus(
  store: DisproStore,
  auth: AuthContext,
  setupSessionId: string | undefined,
  now = new Date()
): Promise<BillingStatus> {
  if (setupSessionId) {
    await refreshSetupSession(store, auth.user, setupSessionId, now);
  }

  const customer = await store.getBillingCustomerByUserId(auth.user.id);
  const status: BillingStatus = {
    configured: isStripeConfigured(),
    setupComplete: customer?.setupComplete ?? false
  };
  const publishableKey = getStripePublishableKey();
  if (publishableKey !== undefined) {
    status.publishableKey = publishableKey;
  }
  if (customer?.stripeCustomerId !== undefined) {
    status.stripeCustomerId = customer.stripeCustomerId;
  }
  if (customer?.defaultPaymentMethodId !== undefined) {
    status.defaultPaymentMethodId = customer.defaultPaymentMethodId;
  }
  return status;
}

export async function createBillingSetupSession(
  store: DisproStore,
  auth: AuthContext,
  input: BillingSetupInput,
  now = new Date()
): Promise<SetupSessionResult> {
  const customer = await ensureBillingCustomer(store, auth.user, now);
  if (isStripeMockEnabled()) {
    const updated = {
      ...customer,
      defaultPaymentMethodId: customer.defaultPaymentMethodId ?? `pm_mock_${auth.user.id}`,
      setupComplete: true,
      updatedAt: now.toISOString()
    };
    await store.saveBillingCustomer(updated);
    const result: SetupSessionResult = {
      configured: true,
      setupComplete: true,
      stripeCustomerId: updated.stripeCustomerId,
      sessionId: `cs_mock_${makeId("setup", { userId: auth.user.id, at: now.toISOString() })}`,
      url: `${input.baseUrl}/billing/status?setup_session_id=mock`
    };
    const publishableKey = getStripePublishableKey();
    if (publishableKey !== undefined) {
      result.publishableKey = publishableKey;
    }
    return result;
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customer.stripeCustomerId,
    payment_method_types: ["card"],
    success_url: input.successUrl ?? `${input.baseUrl}/billing/status?setup_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: input.cancelUrl ?? input.baseUrl,
    metadata: {
      disproUserId: auth.user.id
    }
  });

  const result: SetupSessionResult = {
    configured: true,
    setupComplete: customer.setupComplete,
    stripeCustomerId: customer.stripeCustomerId,
    sessionId: session.id
  };
  if (session.url !== null) {
    result.url = session.url;
  }
  const publishableKey = getStripePublishableKey();
  if (publishableKey !== undefined) {
    result.publishableKey = publishableKey;
  }
  return result;
}

export async function chargeSavedPaymentMethod(
  store: DisproStore,
  user: UserAccount,
  useOrderId: string,
  amountMicroYen: number,
  now = new Date()
): Promise<StripeChargeResult> {
  const customer = await store.getBillingCustomerByUserId(user.id);
  if (!customer?.setupComplete || !customer.defaultPaymentMethodId) {
    throw new BillingError(402, "Payment method setup is required before charging this order.");
  }

  const amountYen = microYenToStripeYen(amountMicroYen);
  if (isStripeMockEnabled()) {
    return {
      status: "succeeded",
      paymentIntentId: `pi_mock_${makeId("pay", { userId: user.id, useOrderId, amountYen, at: now.toISOString() })}`,
      amountYen
    };
  }

  const stripe = getStripe();
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountYen,
      currency: "jpy",
      customer: customer.stripeCustomerId,
      payment_method: customer.defaultPaymentMethodId,
      off_session: true,
      confirm: true,
      description: `Dispro usage charge for ${useOrderId}`,
      metadata: {
        disproUserId: user.id,
        useOrderId,
        amountMicroYen: String(amountMicroYen)
      }
    });

    return {
      status: paymentIntent.status === "succeeded" ? "succeeded" : "pending",
      paymentIntentId: paymentIntent.id,
      amountYen
    };
  } catch (error) {
    const stripeError = error as { payment_intent?: { id?: string }; message?: string };
    return {
      status: "failed",
      paymentIntentId: stripeError.payment_intent?.id ?? `pi_failed_${makeId("pay", { useOrderId, at: now.toISOString() })}`,
      amountYen,
      failureMessage: stripeError.message ?? "Stripe payment failed."
    };
  }
}

export async function handleStripeWebhook(
  store: DisproStore,
  rawBody: string,
  signature: string | undefined,
  now = new Date()
): Promise<{ received: true; type: string }> {
  if (!signature) {
    throw new BillingError(400, "Missing Stripe signature.");
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new BillingError(503, "Stripe webhook secret is not configured.");
  }

  const event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  if (event.type === "checkout.session.completed") {
    await handleCheckoutSessionCompleted(store, event.data.object as Stripe.Checkout.Session, now);
  }
  if (event.type === "payment_intent.succeeded") {
    await handlePaymentIntentUpdated(store, event.data.object as Stripe.PaymentIntent, "succeeded", now);
  }
  if (event.type === "payment_intent.payment_failed") {
    await handlePaymentIntentUpdated(store, event.data.object as Stripe.PaymentIntent, "failed", now);
  }

  return {
    received: true,
    type: event.type
  };
}

export function isStripeConfigured(): boolean {
  return isStripeMockEnabled() || Boolean(process.env.STRIPE_SECRET_KEY && getStripePublishableKey());
}

export function microYenToStripeYen(amountMicroYen: number): number {
  return Math.max(1, Math.ceil(amountMicroYen / 1_000_000));
}

export function getStripeMinimumChargeMicroYen(): number {
  const yen = Number.parseInt(process.env.DISPRO_STRIPE_MIN_CHARGE_YEN ?? "50", 10);
  return Math.max(1, Number.isFinite(yen) ? yen : 50) * 1_000_000;
}

async function ensureBillingCustomer(
  store: DisproStore,
  user: UserAccount,
  now: Date
): Promise<BillingCustomer> {
  const existing = await store.getBillingCustomerByUserId(user.id);
  if (existing) {
    return existing;
  }

  const stripeCustomerId = isStripeMockEnabled()
    ? `cus_mock_${user.id}`
    : (
        await getStripe().customers.create({
          email: user.email,
          metadata: {
            disproUserId: user.id
          }
        })
      ).id;

  const customer: BillingCustomer = {
    userId: user.id,
    stripeCustomerId,
    setupComplete: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await store.saveBillingCustomer(customer);
  return customer;
}

async function refreshSetupSession(
  store: DisproStore,
  user: UserAccount,
  setupSessionId: string,
  now: Date
): Promise<void> {
  if (setupSessionId === "mock" && isStripeMockEnabled()) {
    const customer = await ensureBillingCustomer(store, user, now);
    await store.saveBillingCustomer({
      ...customer,
      defaultPaymentMethodId: customer.defaultPaymentMethodId ?? `pm_mock_${user.id}`,
      setupComplete: true,
      updatedAt: now.toISOString()
    });
    return;
  }

  if (!isStripeConfigured()) {
    return;
  }

  const session = await getStripe().checkout.sessions.retrieve(setupSessionId, {
    expand: ["setup_intent"]
  });
  if (session.mode !== "setup" || session.status !== "complete") {
    return;
  }

  const stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!stripeCustomerId) {
    return;
  }

  const customer = await store.getBillingCustomerByUserId(user.id);
  if (!customer || customer.stripeCustomerId !== stripeCustomerId) {
    return;
  }

  const setupIntent = session.setup_intent as Stripe.SetupIntent | null;
  const paymentMethodId =
    typeof setupIntent?.payment_method === "string" ? setupIntent.payment_method : setupIntent?.payment_method?.id;
  await store.saveBillingCustomer({
    ...customer,
    ...(paymentMethodId === undefined ? {} : { defaultPaymentMethodId: paymentMethodId }),
    setupComplete: true,
    updatedAt: now.toISOString()
  });
}

async function handleCheckoutSessionCompleted(
  store: DisproStore,
  session: Stripe.Checkout.Session,
  now: Date
): Promise<void> {
  if (session.mode !== "setup") {
    return;
  }

  const stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!stripeCustomerId) {
    return;
  }

  const customer = await store.getBillingCustomerByStripeCustomerId(stripeCustomerId);
  if (!customer) {
    return;
  }

  const setupIntentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  const setupIntent = setupIntentId ? await getStripe().setupIntents.retrieve(setupIntentId) : undefined;
  const paymentMethodId =
    typeof setupIntent?.payment_method === "string" ? setupIntent.payment_method : setupIntent?.payment_method?.id;

  await store.saveBillingCustomer({
    ...customer,
    ...(paymentMethodId === undefined ? {} : { defaultPaymentMethodId: paymentMethodId }),
    setupComplete: true,
    updatedAt: now.toISOString()
  });
}

async function handlePaymentIntentUpdated(
  store: DisproStore,
  paymentIntent: Stripe.PaymentIntent,
  status: "succeeded" | "failed",
  now: Date
): Promise<void> {
  const useOrderId = paymentIntent.metadata?.useOrderId;
  if (!useOrderId) {
    return;
  }

  const order = await store.getUseOrder(useOrderId);
  if (!order) {
    return;
  }

  const updatedOrder: UseOrderRecord =
    status === "succeeded"
      ? {
          ...order,
          status: "paid",
          billingStatus: "paid",
          billedMicroYen: order.finalMicroYen ?? order.estimatedMicroYen,
          stripePaymentIntentId: paymentIntent.id,
          updatedAt: now.toISOString()
        }
      : {
          ...order,
          status: "payment_failed",
          billingStatus: "failed",
          stripePaymentIntentId: paymentIntent.id,
          updatedAt: now.toISOString()
        };
  await store.saveUseOrder(updatedOrder);

  const transactions = await store.listUserTransactions(order.userId);
  for (const transaction of transactions.filter((candidate) => candidate.stripePaymentIntentId === paymentIntent.id)) {
    await store.saveUserTransaction({
      ...transaction,
      status: status === "succeeded" ? "settled" : "failed",
      updatedAt: now.toISOString()
    });
  }
  if (status === "succeeded") {
    await settleOrderRevenue(store, updatedOrder, now);
  }
}

function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new BillingError(503, "Stripe secret key is not configured.");
  }

  return new Stripe(secretKey);
}

function getStripePublishableKey(): string | undefined {
  return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? process.env.STRIPE_PUBLISHABLE_KEY;
}

function isStripeMockEnabled(): boolean {
  return process.env.DISPRO_STRIPE_MOCK === "true";
}

export class BillingError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
