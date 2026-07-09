import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import { URL } from "node:url";
import { verifyAuditChain } from "../domain/auditLog.js";
import type { NodeProfile, OrderRequest } from "../domain/types.js";
import {
  BillingError,
  createBillingSetupSession,
  getBillingStatus,
  handleStripeWebhook
} from "../services/billingService.js";
import {
  AuthError,
  ConsoleMailer,
  authenticateBearerToken,
  createApiKeyForUser,
  publicApiKey,
  publicUser,
  requestEmailSignIn,
  verifyEmailSignIn,
  type AuthContext,
  type Mailer
} from "../services/authService.js";
import { planOrder } from "../services/orderOrchestrator.js";
import {
  ProcessError,
  calculateProcessEarnings,
  enqueueProcessJobsForPlan,
  getProcessJobPublicKey,
  leaseProcessJob,
  recordProcessHeartbeat,
  registerProcessNode,
  submitProcessResult
} from "../services/processService.js";
import {
  UseOrderError,
  createUseOrder,
  getUseOrder,
  getUseOrderResult,
  listUseOrders
} from "../services/useOrderService.js";
import { getDownloadManifest, getWindowsProcessDownload } from "../services/downloadService.js";
import type { DisproStore } from "../storage/disproStore.js";

const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

export interface DisproHttpServerOptions {
  store: DisproStore;
  staticDirectory?: string;
  auth?: {
    mailer?: Mailer;
    baseUrl?: string;
    exposeDevSignInLinks?: boolean;
  };
  now?: () => Date;
}

interface JsonResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string | string[]>;
  redirectLocation?: string;
}

export function createDisproHttpServer(options: DisproHttpServerOptions): Server {
  const handler = createDisproHttpRequestHandler(options);
  return createServer(handler);
}

export function createDisproHttpRequestHandler(
  options: DisproHttpServerOptions
): (request: IncomingMessage, response: ServerResponse) => void {
  const now = options.now ?? (() => new Date());
  const mailer = options.auth?.mailer ?? new ConsoleMailer();
  const exposeDevSignInLinks =
    options.auth?.exposeDevSignInLinks ?? process.env.NODE_ENV !== "production";

  return (request, response) => {
    const context: RequestContext = {
      store: options.store,
      now,
      mailer,
      exposeDevSignInLinks
    };

    if (options.staticDirectory !== undefined) {
      context.staticDirectory = options.staticDirectory;
    }
    if (options.auth?.baseUrl !== undefined) {
      context.authBaseUrl = options.auth.baseUrl;
    }

    handleRequest(request, response, context).catch((error: unknown) => {
      const status =
        error instanceof ApiError ||
        error instanceof AuthError ||
        error instanceof ProcessError ||
        error instanceof BillingError ||
        error instanceof UseOrderError
          ? error.status
          : 500;
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      writeJson(response, status, {
        error: {
          status,
          message
        }
      });
    });
  };
}

interface RequestContext {
  store: DisproStore;
  now: () => Date;
  staticDirectory?: string;
  mailer: Mailer;
  authBaseUrl?: string;
  exposeDevSignInLinks: boolean;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: RequestContext): Promise<void> {
  if (request.method === "OPTIONS") {
    writeJson(response, 204, null);
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "GET") {
    const staticResponse = await tryServeStatic(url.pathname, response, context.staticDirectory);
    if (staticResponse) {
      return;
    }
  }

  const result = await route(method, parts, request, context, url);
  writeJson(response, result.status, result.body, result.headers, result.redirectLocation);
}

async function route(
  method: string,
  parts: readonly string[],
  request: IncomingMessage,
  context: RequestContext,
  url: URL
): Promise<JsonResponse> {
  const { store, now } = context;

  if (method === "GET" && parts.length === 1 && parts[0] === "health") {
    return {
      status: 200,
      body: {
        ok: true,
        service: "dispro-api",
        phase: "2"
      }
    };
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "nodes") {
    return {
      status: 200,
      body: {
        nodes: await store.listNodes()
      }
    };
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "downloads") {
    return {
      status: 200,
      body: await getDownloadManifest()
    };
  }

  if (
    method === "GET" &&
    parts.length === 4 &&
    parts[0] === "downloads" &&
    parts[1] === "windows" &&
    parts[2] === "process" &&
    parts[3] === "latest"
  ) {
    const download = await getWindowsProcessDownload();
    return {
      status: 302,
      body: null,
      redirectLocation: download.downloadUrl
    };
  }

  if (
    method === "POST" &&
    parts.length === 2 &&
    parts[0] === "auth" &&
    (parts[1] === "request-link" || parts[1] === "request-code")
  ) {
    const body = await readJson<{ email?: string; baseUrl?: string }>(request);
    const result = await requestEmailSignIn(
      store,
      context.mailer,
      {
        email: body.email ?? "",
        baseUrl: body.baseUrl ?? context.authBaseUrl ?? getRequestBaseUrl(request),
        exposeDevLink: context.exposeDevSignInLinks
      },
      now()
    );

    return {
      status: 202,
      body: {
        ok: true,
        ...result
      }
    };
  }

  if (
    (method === "POST" || method === "GET") &&
    parts.length === 2 &&
    parts[0] === "auth" &&
    parts[1] === "verify"
  ) {
    const input =
      method === "GET"
        ? { token: url.searchParams.get("token") ?? "" }
        : await readJson<{ token?: string; email?: string; code?: string }>(request);
    const result = await verifyEmailSignIn(store, input, now());

    return {
      status: 200,
      headers: {
        "set-cookie": buildSessionCookie(result.sessionToken, result.sessionExpiresAt)
      },
      body: {
        user: publicUser(result.user),
        sessionToken: result.sessionToken,
        sessionExpiresAt: result.sessionExpiresAt
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "auth" && parts[1] === "logout") {
    return {
      status: 200,
      headers: {
        "set-cookie": clearSessionCookie()
      },
      body: {
        ok: true
      }
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "auth" && parts[1] === "me") {
    const auth = await requireAuth(store, request, now);
    const apiKeys = await store.listApiKeysForUser(auth.user.id);

    return {
      status: 200,
      body: {
        user: publicUser(auth.user),
        credential: auth.credential,
        apiKeys: apiKeys.map((apiKey) => publicApiKey(apiKey))
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "auth" && parts[1] === "api-keys") {
    const auth = await requireAuth(store, request, now);
    const body = await readJson<{ label?: string; purpose?: "general" | "process" | "use" }>(request);
    const result = await createApiKeyForUser(
      store,
      auth.user,
      {
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.purpose === undefined ? {} : { purpose: body.purpose })
      },
      now()
    );

    return {
      status: 201,
      body: {
        apiKey: publicApiKey(result.apiKey),
        secret: result.secret
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "billing" && parts[1] === "setup-session") {
    const auth = await requireAuth(store, request, now);
    const body = await readJson<{ successUrl?: string; cancelUrl?: string }>(request);
    return {
      status: 201,
      body: await createBillingSetupSession(
        store,
        auth,
        {
          baseUrl: getRequestBaseUrl(request),
          ...(body.successUrl === undefined ? {} : { successUrl: body.successUrl }),
          ...(body.cancelUrl === undefined ? {} : { cancelUrl: body.cancelUrl })
        },
        now()
      )
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "billing" && parts[1] === "status") {
    const auth = await requireAuth(store, request, now);
    return {
      status: 200,
      body: await getBillingStatus(store, auth, url.searchParams.get("setup_session_id") ?? undefined, now())
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "billing" && parts[1] === "webhook") {
    const rawBody = await readRawBody(request);
    return {
      status: 200,
      body: await handleStripeWebhook(store, rawBody, firstHeader(request.headers["stripe-signature"]), now())
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "use" && parts[1] === "orders") {
    const auth = await requireUseAuth(store, request, now);
    return {
      status: 200,
      body: {
        orders: await listUseOrders(store, auth, now())
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "use" && parts[1] === "orders") {
    const auth = await requireUseAuth(store, request, now);
    const body = await readJson<OrderRequest & { maxChargeMicroYen?: number }>(request);
    const seed = url.searchParams.get("seed") ?? body.id ?? body.source?.contentHash;
    try {
      return {
        status: 201,
        body: await createUseOrder(store, auth, body, now(), seed)
      };
    } catch (error) {
      if (error instanceof UseOrderError || error instanceof BillingError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Invalid Use order request.";
      throw new ApiError(400, message);
    }
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "use" && parts[1] === "orders") {
    const auth = await requireUseAuth(store, request, now);
    return {
      status: 200,
      body: await getUseOrder(store, auth, parts[2] ?? "", now())
    };
  }

  if (method === "GET" && parts.length === 4 && parts[0] === "use" && parts[1] === "orders" && parts[3] === "result") {
    const auth = await requireUseAuth(store, request, now);
    return {
      status: 200,
      body: await getUseOrderResult(store, auth, parts[2] ?? "", now())
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "process" && parts[1] === "signing-key") {
    return {
      status: 200,
      body: {
        algorithm: "Ed25519",
        publicKey: getProcessJobPublicKey()
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "process" && parts[1] === "register") {
    const auth = await requireProcessAuth(store, request, now);
    const body = await readJson<Parameters<typeof registerProcessNode>[2]>(request);
    const node = await registerProcessNode(store, auth, body, now());
    return {
      status: 201,
      body: {
        node,
        earnings: await calculateProcessEarnings(store, auth.user.id)
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "process" && parts[1] === "heartbeat") {
    const auth = await requireProcessAuth(store, request, now);
    const body = await readJson<Parameters<typeof recordProcessHeartbeat>[2]>(request);
    const node = await recordProcessHeartbeat(store, auth, body, now());
    return {
      status: 200,
      body: {
        node
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "process" && parts[1] === "lease") {
    const auth = await requireProcessAuth(store, request, now);
    const body = await readJson<Parameters<typeof leaseProcessJob>[2]>(request);
    return {
      status: 200,
      body: await leaseProcessJob(store, auth, body, now())
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "process" && parts[1] === "results") {
    const auth = await requireProcessAuth(store, request, now);
    const body = await readJson<Parameters<typeof submitProcessResult>[2]>(request);
    return {
      status: 200,
      body: await submitProcessResult(store, auth, body, now())
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "process" && parts[1] === "earnings") {
    const auth = await requireProcessAuth(store, request, now);
    return {
      status: 200,
      body: {
        earnings: await calculateProcessEarnings(store, auth.user.id)
      }
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "account" && parts[1] === "profile") {
    const auth = await requireAuth(store, request, now);
    const [apiKeys, processNodes, transactions, distributedRecords, useOrders, billing, earnings] = await Promise.all([
      store.listApiKeysForUser(auth.user.id),
      store.listProcessNodesForUser(auth.user.id),
      store.listUserTransactions(auth.user.id),
      store.listDistributedRecordsForUser(auth.user.id),
      store.listUseOrdersForUser(auth.user.id),
      getBillingStatus(store, auth, undefined, now()),
      calculateProcessEarnings(store, auth.user.id)
    ]);

    return {
      status: 200,
      body: {
        user: publicUser(auth.user),
        credential: auth.credential,
        apiKeys: apiKeys.map((apiKey) => publicApiKey(apiKey)),
        processNodes,
        useOrders,
        billing,
        transactions,
        distributedRecords,
        earnings
      }
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "account" && parts[1] === "transactions") {
    const auth = await requireAuth(store, request, now);
    return {
      status: 200,
      body: {
        transactions: await store.listUserTransactions(auth.user.id)
      }
    };
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "account" && parts[1] === "distributed-records") {
    const auth = await requireAuth(store, request, now);
    return {
      status: 200,
      body: {
        records: await store.listDistributedRecordsForUser(auth.user.id)
      }
    };
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "nodes" && parts[1] === "register") {
    await requireAuth(store, request, now);
    const node = await readJson<NodeProfile>(request);
    validateNode(node);
    await store.upsertNode(node);
    return {
      status: 201,
      body: {
        node
      }
    };
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "orders") {
    const auth = await requireAuth(store, request, now);
    const summaries = await store.listOrderSummaries();

    return {
      status: 200,
      body: {
        orders: summaries.filter((summary) => summary.customerId === auth.user.id)
      }
    };
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "orders") {
    const auth = await requireAuth(store, request, now);
    const orderRequest = await readJson<OrderRequest>(request);
    const nodes = await store.listNodes();
    const seed = url.searchParams.get("seed") ?? orderRequest.id ?? orderRequest.source?.contentHash;

    try {
      const plan = planOrder({ ...orderRequest, customerId: auth.user.id }, nodes, { now: now(), seed });
      await store.savePlannedOrder(plan);
      await enqueueProcessJobsForPlan(store, plan, now());
      return {
        status: 201,
        body: plan
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid order request.";
      throw new ApiError(400, message);
    }
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "orders") {
    const auth = await requireAuth(store, request, now);
    const plan = await getOrderOrThrow(store, parts[1], auth);
    return {
      status: 200,
      body: plan
    };
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "orders" && parts[2] === "tasks") {
    const auth = await requireAuth(store, request, now);
    const plan = await getOrderOrThrow(store, parts[1], auth);
    return {
      status: 200,
      body: {
        orderId: plan.order.id,
        tasks: plan.tasks,
        assignments: plan.assignments,
        unassignedTasks: plan.unassignedTasks
      }
    };
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "orders" && parts[2] === "audit") {
    const auth = await requireAuth(store, request, now);
    const plan = await getOrderOrThrow(store, parts[1], auth);
    return {
      status: 200,
      body: {
        orderId: plan.order.id,
        auditEvents: plan.auditEvents,
        valid: verifyAuditChain(plan.auditEvents)
      }
    };
  }

  throw new ApiError(404, `Route not found: ${method} /${parts.join("/")}`);
}

async function getOrderOrThrow(store: DisproStore, orderId: string | undefined, auth: AuthContext) {
  if (!orderId) {
    throw new ApiError(404, "Order not found.");
  }

  const plan = await store.getPlannedOrder(orderId);
  if (!plan) {
    throw new ApiError(404, `Order not found: ${orderId}`);
  }

  if (plan.order.customerId !== auth.user.id) {
    throw new ApiError(404, `Order not found: ${orderId}`);
  }

  return plan;
}

async function requireAuth(store: DisproStore, request: IncomingMessage, now: () => Date): Promise<AuthContext> {
  const authorization = request.headers.authorization ?? bearerFromSessionCookie(request.headers.cookie);
  return authenticateBearerToken(store, authorization, now());
}

async function requireProcessAuth(store: DisproStore, request: IncomingMessage, now: () => Date): Promise<AuthContext> {
  const auth = await requireAuth(store, request, now);
  if (auth.credential !== "apiKey" || auth.apiKey?.purpose !== "process") {
    throw new AuthError(403, "A Process API key is required for this endpoint.");
  }
  return auth;
}

async function requireUseAuth(store: DisproStore, request: IncomingMessage, now: () => Date): Promise<AuthContext> {
  const auth = await requireAuth(store, request, now);
  if (auth.credential !== "apiKey" || auth.apiKey?.purpose !== "use") {
    throw new AuthError(403, "A Use API key is required for this endpoint.");
  }
  return auth;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new ApiError(413, "JSON body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new ApiError(400, "JSON body is required.");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new ApiError(400, "Invalid JSON body.");
  }
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new ApiError(413, "Request body is too large.");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function validateNode(node: NodeProfile): void {
  if (!isRecord(node) || typeof node.id !== "string" || node.id.trim().length === 0) {
    throw new ApiError(400, "node.id is required.");
  }

  if (!isRecord(node.capabilities) || !Array.isArray(node.capabilities.supportedWorkloads)) {
    throw new ApiError(400, "node.capabilities.supportedWorkloads must be an array.");
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
  redirectLocation?: string
): void {
  response.statusCode = status;
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization, stripe-signature");
  response.setHeader("access-control-allow-credentials", "true");

  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }

  if (redirectLocation) {
    response.setHeader("location", redirectLocation);
    response.end();
    return;
  }

  if (status === 204) {
    response.end();
    return;
  }

  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function tryServeStatic(
  pathname: string,
  response: ServerResponse,
  staticDirectory: string | undefined
): Promise<boolean> {
  if (!staticDirectory) {
    return false;
  }

  const safePathname = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const requestedPath = resolve(staticDirectory, normalize(safePathname).replace(/^([/\\])+/, ""));
  const staticRoot = resolve(staticDirectory);

  if (!requestedPath.startsWith(staticRoot)) {
    throw new ApiError(403, "Static path is outside the public directory.");
  }

  try {
    const content = await readFile(requestedPath);
    response.statusCode = 200;
    response.setHeader("content-type", contentTypeFor(requestedPath));
    response.setHeader("cache-control", requestedPath.endsWith("index.html") ? "no-cache" : "public, max-age=3600");
    response.end(content);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }

  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function getRequestBaseUrl(request: IncomingMessage): string {
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const proto = forwardedProto ?? "http";
  const host = forwardedHost ?? request.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearerFromSessionCookie(cookieHeader: string | undefined): string | undefined {
  const cookies = parseCookies(cookieHeader);
  const token = cookies.dispro_session;
  return token ? `Bearer ${token}` : undefined;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  return Object.fromEntries(
    cookieHeader.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      if (index < 0) {
        return [];
      }
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      return key ? [[key, decodeURIComponent(value)]] : [];
    })
  );
}

function buildSessionCookie(sessionToken: string, sessionExpiresAt: string): string {
  const maxAgeSeconds = Math.max(0, Math.floor((new Date(sessionExpiresAt).getTime() - Date.now()) / 1000));
  return [
    `dispro_session=${encodeURIComponent(sessionToken)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ].join("; ");
}

function clearSessionCookie(): string {
  return "dispro_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}
