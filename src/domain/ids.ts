import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const fields = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${fields.join(",")}}`;
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

export function makeId(prefix: string, payload: unknown, length = 16): string {
  return `${prefix}_${hashObject(payload).slice(0, length)}`;
}
