# Chrome Process Extension v1

`chrome/process-extension` is a Manifest V3 Chrome extension for the Dispro **Earn - Process** and **Use** flows. Build it with `npm run chrome:build`; load `dist/chrome-process` through Chrome's developer extension page for local testing.

## Security boundary

- The extension only connects to `https://dis-pro-liart.vercel.app` and ships no content scripts or remote JavaScript.
- The API permits configured Chrome extension origins for bearer-token CORS only; cookie-authenticated mutations remain restricted to the official site origin.
- Email verification is mandatory before Process, Use, billing, payout, or order actions.
- Session token, Process API key, Use API key, and node signing key live in `chrome.storage.session`, so they are removed when the browser session ends. `chrome.storage.local` contains only a random non-secret machine identifier.
- Every lease is verified with the API Ed25519 public key. Expired, unsigned, replayed by the API, or unsupported workloads are rejected.
- The browser runner executes only `hash.compute`, `proof.verify`, `echo.test`, `data.transform.basic`, and Dispro's anchoring/update workloads. It never runs shell commands, downloaded executables, or page content.

## Process and updates

The extension registers a browser capability snapshot, polls signed leases with a Chrome alarm, signs results with a per-browser-session Ed25519 node key, and submits them through the same Process routes as Windows:

- `POST /process/register`
- `POST /process/lease`
- `POST /process/results`
- `POST /process/heartbeat`

`dispro.app.update` is delivered through that same signed special-job route. It carries an update version, SHA-256, download URL, and optional Chrome Web Store URL. The extension only displays the signed notification; Chrome Web Store is the preferred mechanism for automatic extension code updates. A ZIP from GitHub Releases is for developer-mode installation and verification, not a silent browser install.

## Release settings

Set these production values after publishing a Chrome release asset or Web Store listing:

- `DISPRO_CHROME_PROCESS_DOWNLOAD_VERSION`
- `DISPRO_CHROME_PROCESS_DOWNLOAD_URL`
- `DISPRO_CHROME_PROCESS_SHA256`
- `DISPRO_CHROME_PROCESS_SIZE_BYTES`
- `DISPRO_CHROME_PROCESS_UPDATE_VERSION`
- `DISPRO_CHROME_PROCESS_UPDATE_URL`
- `DISPRO_CHROME_PROCESS_UPDATE_SHA256`
- `DISPRO_CHROME_PROCESS_WEB_STORE_URL` (when available)
- `DISPRO_CHROME_EXTENSION_IDS` after Chrome Web Store publication. Until then, set `DISPRO_ALLOW_CHROME_EXTENSION_ORIGINS=true` only for the signed Dispro extension rollout.
