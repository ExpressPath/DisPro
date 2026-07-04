import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import { URL } from "node:url";
import { verifyAuditChain } from "../domain/auditLog.js";
import type { NodeProfile, OrderRequest } from "../domain/types.js";
import { planOrder } from "../services/orderOrchestrator.js";
import type { DisproStore } from "../storage/disproStore.js";

const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

export interface DisproHttpServerOptions {
  store: DisproStore;
  staticDirectory?: string;
  now?: () => Date;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

export function createDisproHttpServer(options: DisproHttpServerOptions): Server {
  const now = options.now ?? (() => new Date());

  return createServer((request, response) => {
    handleRequest(request, response, options.store, now, options.staticDirectory).catch((error: unknown) => {
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      writeJson(response, status, {
        error: {
          status,
          message
        }
      });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: DisproStore,
  now: () => Date,
  staticDirectory: string | undefined
): Promise<void> {
  if (request.method === "OPTIONS") {
    writeJson(response, 204, null);
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  if (method === "GET") {
    const staticResponse = await tryServeStatic(url.pathname, response, staticDirectory);
    if (staticResponse) {
      return;
    }
  }

  const result = await route(method, parts, request, store, now, url);
  writeJson(response, result.status, result.body);
}

async function route(
  method: string,
  parts: readonly string[],
  request: IncomingMessage,
  store: DisproStore,
  now: () => Date,
  url: URL
): Promise<JsonResponse> {
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

  if (method === "POST" && parts.length === 2 && parts[0] === "nodes" && parts[1] === "register") {
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
    return {
      status: 200,
      body: {
        orders: await store.listOrderSummaries()
      }
    };
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "orders") {
    const orderRequest = await readJson<OrderRequest>(request);
    const nodes = await store.listNodes();
    const seed = url.searchParams.get("seed") ?? orderRequest.id ?? orderRequest.source?.contentHash;

    try {
      const plan = planOrder(orderRequest, nodes, { now: now(), seed });
      await store.savePlannedOrder(plan);
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
    const plan = await getOrderOrThrow(store, parts[1]);
    return {
      status: 200,
      body: plan
    };
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "orders" && parts[2] === "tasks") {
    const plan = await getOrderOrThrow(store, parts[1]);
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
    const plan = await getOrderOrThrow(store, parts[1]);
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

async function getOrderOrThrow(store: DisproStore, orderId: string | undefined) {
  if (!orderId) {
    throw new ApiError(404, "Order not found.");
  }

  const plan = await store.getPlannedOrder(orderId);
  if (!plan) {
    throw new ApiError(404, `Order not found: ${orderId}`);
  }

  return plan;
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

function validateNode(node: NodeProfile): void {
  if (!isRecord(node) || typeof node.id !== "string" || node.id.trim().length === 0) {
    throw new ApiError(400, "node.id is required.");
  }

  if (!isRecord(node.capabilities) || !Array.isArray(node.capabilities.supportedWorkloads)) {
    throw new ApiError(400, "node.capabilities.supportedWorkloads must be an array.");
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");

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
