import { createHash, verify } from "node:crypto";

export const supportedWorkloads = [
  "hash.compute",
  "proof.verify",
  "echo.test",
  "data.transform.basic",
  "dispro.storage.anchor",
  "dispro.transaction.anchor",
  "dispro.app.update"
];

export async function executeSignedProcessJob(envelope, options) {
  if (!verifySignedProcessJobEnvelope(envelope, options.publicKey)) {
    return rejected("Invalid job signature.");
  }

  if (new Date(envelope.expiresAt).getTime() <= Date.now()) {
    return rejected("Job lease expired.");
  }

  if (!supportedWorkloads.includes(envelope.workload)) {
    return rejected(`Unsupported workload: ${envelope.workload}`);
  }

  try {
    const output = await runWorkload(envelope.workload, envelope.inputRef);
    const stdout = JSON.stringify(output);
    return {
      status: "completed",
      resultHash: sha256(stdout),
      stdout,
      stderr: ""
    };
  } catch (error) {
    return {
      status: "failed",
      resultHash: sha256(String(error instanceof Error ? error.message : error)),
      stdout: "",
      stderr: "",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

export function verifySignedProcessJobEnvelope(envelope, publicKey) {
  const { signature, ...unsigned } = envelope;
  if (!signature || !publicKey) {
    return false;
  }
  try {
    return verify(null, Buffer.from(stableStringify(unsigned)), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

async function runWorkload(workload, inputRef) {
  if (workload === "echo.test") {
    return {
      echo: inputRef
    };
  }

  if (workload === "hash.compute") {
    const value = inputRef.text ?? inputRef.payload ?? stableStringify(inputRef);
    return {
      algorithm: "sha256",
      hash: sha256(typeof value === "string" ? value : stableStringify(value))
    };
  }

  if (workload === "proof.verify") {
    const payload = inputRef.payload ?? "";
    const expectedHash = inputRef.expectedHash;
    const actualHash = sha256(typeof payload === "string" ? payload : stableStringify(payload));
    return {
      verified: typeof expectedHash === "string" && expectedHash === actualHash,
      actualHash
    };
  }

  if (workload === "data.transform.basic") {
    const records = Array.isArray(inputRef.records) ? inputRef.records : [];
    return {
      records: records.map((record) => normalizeRecord(record))
    };
  }

  if (workload === "dispro.storage.anchor" || workload === "dispro.transaction.anchor") {
    const encryptedJson = String(inputRef.encryptedJson ?? "");
    const payloadHash = sha256(encryptedJson);
    return {
      status: "anchored",
      provider: inputRef.provider ?? "local",
      cid: `${inputRef.provider ?? "local"}-${payloadHash.slice(0, 46)}`,
      payloadHash,
      contractHash: sha256(`${inputRef.recordType ?? "record"}:${payloadHash}`)
    };
  }

  if (workload === "dispro.app.update") {
    const manifest = inputRef.manifest && typeof inputRef.manifest === "object" ? inputRef.manifest : {};
    return {
      updateAvailable: true,
      manifest
    };
  }

  throw new Error(`Unsupported workload: ${workload}`);
}

function normalizeRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.trim(), typeof value === "string" ? value.trim() : value])
  );
}

function rejected(errorMessage) {
  return {
    status: "rejected",
    resultHash: sha256(errorMessage),
    stdout: "",
    stderr: "",
    errorMessage
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
