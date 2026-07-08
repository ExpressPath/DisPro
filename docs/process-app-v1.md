# Dispro Process App v1

This document describes the Windows Process app and the special signed intake used for distributed records, transactions, and update manifests.

## Process App

- Desktop entry: `desktop/process-app/main.mjs`
- Renderer entry: `desktop/process-app/renderer/index.html`
- Allowed runner modules: `desktop/process-app/worker/runners.mjs`
- Build scripts:
  - `npm.cmd run desktop:dev`
  - `npm.cmd run desktop:pack:dir`
  - `npm.cmd run desktop:pack`
  - `npm.cmd run desktop:pack:installer`

The default package target is a Windows portable exe. The NSIS installer target is kept as `desktop:pack:installer`, but CI/local Windows environments may need installer tooling and signing setup before it is reliable.

## Auth Flow

1. User requests an email magic link from the app.
2. User pastes the token/link into the app.
3. The app creates a `purpose: "process"` API key.
4. The API key is stored through the OS credential store via `keytar`.
5. Process endpoints require a Process API key, not a general key.

No Gmail password or mail-provider secret belongs in the repo. Production mail credentials must stay in environment variables.

## Signed Process Intake

The exe receives all work through:

- `POST /process/register`
- `POST /process/heartbeat`
- `POST /process/lease`
- `POST /process/results`
- `GET /process/earnings`

`/process/lease` returns either idle or a signed job envelope. The app verifies the Ed25519 signature and rejects unsigned, expired, malformed, unsupported, or tampered jobs.

Version 1 does not run arbitrary shell commands. It only executes bundled workloads:

- `hash.compute`
- `proof.verify`
- `echo.test`
- `data.transform.basic`
- `dispro.storage.anchor`
- `dispro.transaction.anchor`
- `dispro.app.update`

## Distributed Records

The v1 distributed storage adapter is deterministic and local-first. It produces CID-like records from hashes, then stores proof metadata in the API state. This keeps the protocol compatible with later IPFS, Filecoin, Arweave, and blockchain anchoring.

User profile anchoring:

- When a Process node registers, the API creates a signed `dispro.storage.anchor` job.
- The job input contains a hashed/sanitized user snapshot.
- The app returns `cid`, `payloadHash`, and `contractHash`.
- The API stores a `DistributedRecord` with `type: "user.profile"`.

Transaction anchoring:

- When a paid Process job completes, the API creates a provisional earning transaction.
- The API then creates a signed `dispro.transaction.anchor` job.
- The app returns the anchor proof.
- The API marks the transaction as `anchored` and links it to a `DistributedRecord`.

Read APIs:

- `GET /account/profile`
- `GET /account/transactions`
- `GET /account/distributed-records`

## Update Manifests

App update information is delivered through the same signed Process intake.

Set all three environment variables to queue update jobs for Process nodes:

- `DISPRO_PROCESS_UPDATE_VERSION`
- `DISPRO_PROCESS_UPDATE_URL`
- `DISPRO_PROCESS_UPDATE_SHA256`

Optional:

- `DISPRO_PROCESS_UPDATE_CHANNEL`
- `DISPRO_PROCESS_UPDATE_MANDATORY`
- `DISPRO_PROCESS_UPDATE_NOTES`

The API creates a signed `dispro.app.update` job. The app verifies the signature, accepts the manifest, reports it back to the API as execution evidence, and displays the update status. Full installer replacement should be enabled only after signed release artifacts and a production update distribution channel are in place.
