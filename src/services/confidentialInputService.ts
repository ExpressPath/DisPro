import { createHash } from "node:crypto";
import type { JsonRecord, JsonValue, OrderRequest } from "../domain/types.js";

const SECRET_KEY_PATTERN = /(private[_-]?key|secret|seed|mnemonic|pass(word|phrase)?|api[_-]?key|access[_-]?token|authorization)/i;
const PRIVATE_HOST_PATTERN = /^(localhost|.+\.local|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})$/i;

export interface ConfidentialInputPolicy {
  encrypted: true;
  scheme: "aes-256-gcm-envelope-ref";
  keyScope: "per-order-per-chunk";
  plaintextRequiredAtRunner: boolean;
  payloadHash: string;
  metadataPolicy: "minimal";
  egressMode: "deny" | "allowlist-proxy";
  allowedEgressHosts: string[];
}

/** Reject credentials before they can enter persistence, leases, audit logs, or node memory. */
export function assertConfidentialOrderInput(input: Pick<OrderRequest, "source" | "parameters" | "requirements">): void {
  assertSafeSourceUri(input.source.uri, input.source.kind);
  if (input.parameters) {
    assertNoPlaintextSecrets(input.parameters);
  }
  const hosts = input.requirements?.allowedEgressHosts ?? [];
  for (const host of hosts) {
    if (PRIVATE_HOST_PATTERN.test(host) || host.includes("..")) {
      throw new ConfidentialInputError("Private, local, and malformed egress hosts are not allowed.");
    }
  }
}

export function createConfidentialInputPolicy(input: Pick<OrderRequest, "source" | "parameters" | "requirements">): ConfidentialInputPolicy {
  const allowedEgressHosts = [...new Set(input.requirements?.allowedEgressHosts ?? [])].sort();
  return {
    encrypted: true,
    scheme: "aes-256-gcm-envelope-ref",
    keyScope: "per-order-per-chunk",
    plaintextRequiredAtRunner: true,
    payloadHash: createHash("sha256").update(JSON.stringify({ source: input.source, parameters: input.parameters ?? {} })).digest("hex"),
    metadataPolicy: "minimal",
    egressMode: allowedEgressHosts.length === 0 ? "deny" : "allowlist-proxy",
    allowedEgressHosts
  };
}

function assertSafeSourceUri(uri: string, kind: OrderRequest["source"]["kind"]): void {
  if (kind !== "url") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ConfidentialInputError("Source URL must be valid.");
  }
  if (parsed.protocol !== "https:") {
    throw new ConfidentialInputError("Only HTTPS source URLs are accepted for distributed processing.");
  }
  if (PRIVATE_HOST_PATTERN.test(parsed.hostname) || parsed.username || parsed.password) {
    throw new ConfidentialInputError("Source URL must not target private hosts or include credentials.");
  }
}

function assertNoPlaintextSecrets(value: JsonValue, path = "parameters"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPlaintextSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      const isOpaqueReference = /(?:ref|id)$/i.test(key) && typeof entry === "string" && /^sec_[a-zA-Z0-9_-]{12,}$/.test(entry);
      if (SECRET_KEY_PATTERN.test(key) && entry !== null && entry !== "" && !isOpaqueReference) {
        throw new ConfidentialInputError(`Plaintext secret material is not accepted (${childPath}). Use a server-side secret reference.`);
      }
      assertNoPlaintextSecrets(entry, childPath);
    }
  }
}

export class ConfidentialInputError extends Error {
  readonly status = 400;
}
