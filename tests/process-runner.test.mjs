import assert from "node:assert/strict";
import test from "node:test";
import { createProcessJobFromTask, createSpecialProcessJob, signProcessJob } from "../src/services/processService.ts";
import { executeSignedProcessJob, verifySignedProcessJobEnvelope } from "../desktop/process-app/worker/runners.mjs";

const defaultPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbTYmuTvvI6+vd7NsDhpMOgbnGvaQoqxFUE8cgIqk7ds=
-----END PUBLIC KEY-----`;

test("executes a signed allowed process workload", async () => {
  const job = createProcessJobFromTask(
    "ord_runner_001",
    { id: "task_runner_001", workload: "hash.compute" },
    { text: "hello" },
    new Date("2026-07-04T00:00:00.000Z")
  );
  const envelope = signProcessJob({
    ...job,
    status: "leased",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(verifySignedProcessJobEnvelope(envelope, defaultPublicKey), true);

  const result = await executeSignedProcessJob(envelope, {
    publicKey: defaultPublicKey
  });

  assert.equal(result.status, "completed");
  assert.match(result.stdout, /sha256/);
});

test("rejects tampered process workload envelopes", async () => {
  const job = createProcessJobFromTask(
    "ord_runner_002",
    { id: "task_runner_002", workload: "echo.test" },
    { message: "safe" },
    new Date("2026-07-04T00:00:00.000Z")
  );
  const envelope = signProcessJob({
    ...job,
    status: "leased",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  const tampered = {
    ...envelope,
    workload: "arbitrary.command"
  };
  const result = await executeSignedProcessJob(tampered, {
    publicKey: defaultPublicKey
  });

  assert.equal(result.status, "rejected");
  assert.match(result.errorMessage, /signature/i);
});

test("executes signed distributed storage anchor workloads", async () => {
  const job = createSpecialProcessJob(
    "usr_runner_001",
    "dispro.storage.anchor",
    {
      recordType: "user.profile",
      ownerUserId: "usr_runner_001",
      sourceId: "user-profile-usr_runner_001",
      provider: "local",
      encryptedJson: "{\"emailHash\":\"abc\"}"
    },
    "user-profile-usr_runner_001",
    new Date("2026-07-04T00:00:00.000Z")
  );
  const envelope = signProcessJob({
    ...job,
    status: "leased",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  const result = await executeSignedProcessJob(envelope, {
    publicKey: defaultPublicKey
  });

  assert.equal(result.status, "completed");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "anchored");
  assert.equal(payload.provider, "local");
  assert.match(payload.cid, /^local-/);
  assert.equal(typeof payload.payloadHash, "string");
});
