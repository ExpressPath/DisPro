# Process Update Graph

Dispro Process updates are published as a Git-like graph so every app can propagate update information quickly and verify it exactly.

## Shape

`GET /updates/process` returns:

- `refs`: stable refs such as `refs/process/windows/stable`
- `commits`: content-addressed update commits keyed by SHA-256 id
- `tree`: SHA-256 over the platform asset list
- `signature`: Ed25519 signature over the canonical commit payload
- `etag`: cache validator for fast polling

`GET /updates/process/:platform/stable` returns a single ref and commit for:

- `windows`
- `linux`
- `chrome`
- `android`

## Propagation

Process nodes receive the same information in signed `dispro.app.update` jobs:

- `updateRef`
- `updateCommit`
- `updateTree`
- `updateSignature`
- `updatePublicKey`

The normal polling path can use ETag/304 responses. The Process job path can carry the same commit id through the distributed network when a node is already connected for work.

## Signing

Production should set:

- `DISPRO_UPDATE_SIGNING_PRIVATE_KEY`
- `DISPRO_UPDATE_SIGNING_PUBLIC_KEY`

If those are absent, the API falls back to the Process job signing key env values, then the development key.
