async function refreshStatus() {
  const apiStatus = document.querySelector("#api-status");
  const nodeCount = document.querySelector("#node-count");

  try {
    const [healthResponse, nodesResponse] = await Promise.all([fetch("health"), fetch("nodes")]);
    const health = await healthResponse.json();
    const nodes = await nodesResponse.json();

    if (apiStatus) {
      apiStatus.textContent = health.ok ? "online" : "degraded";
    }

    if (nodeCount) {
      nodeCount.textContent = Array.isArray(nodes.nodes) ? String(nodes.nodes.length) : "-";
    }
  } catch {
    if (apiStatus) {
      apiStatus.textContent = "offline";
    }

    if (nodeCount) {
      nodeCount.textContent = "-";
    }
  }
}

await refreshStatus();
await refreshDownloads();
await refreshAccount();

const loginForm = document.querySelector("#site-login-form");
const verifyForm = document.querySelector("#site-verify-form");
const logoutButton = document.querySelector("#site-logout-button");
let pendingEmail = "";

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#site-email")?.value ?? "";
  pendingEmail = email;
  try {
    const response = await fetch("auth/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? "Could not send verification code.");
    }
    verifyForm?.classList.remove("hidden");
    if (payload.devVerificationCode) {
      const codeInput = document.querySelector("#site-code");
      if (codeInput) {
        codeInput.value = payload.devVerificationCode;
      }
    }
    renderAccountMessage(`Verification code sent to ${payload.email}.`);
  } catch (error) {
    renderAccountMessage(error instanceof Error ? error.message : String(error));
  }
});

verifyForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = document.querySelector("#site-code")?.value ?? "";
  try {
    const response = await fetch("auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: pendingEmail, code })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? "Could not verify code.");
    }
    renderAccountMessage(`Signed in as ${payload.user.email}.`);
    await refreshAccount();
  } catch (error) {
    renderAccountMessage(error instanceof Error ? error.message : String(error));
  }
});

logoutButton?.addEventListener("click", async () => {
  await fetch("auth/logout", {
    method: "POST",
    credentials: "same-origin"
  }).catch(() => undefined);
  renderAccountMessage("Signed out.");
});

async function refreshDownloads() {
  const rows = document.querySelector("#download-rows");
  if (!rows) {
    return;
  }

  try {
    const response = await fetch("downloads");
    const payload = await response.json();
    const downloads = Array.isArray(payload.downloads) ? payload.downloads : [];
    rows.innerHTML = downloads
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(`${item.platform} ${item.architecture}`)}</td>
            <td>${escapeHtml(item.role)}</td>
            <td>${escapeHtml(item.version)}</td>
            <td>${escapeHtml(item.recommendedDevice)}</td>
            <td><code>${escapeHtml(shortHash(item.sha256))}</code></td>
            <td><a class="button button-primary" href="downloads/windows/process/latest">Download</a></td>
          </tr>
        `
      )
      .join("");
  } catch {
    rows.innerHTML = `<tr><td colspan="6">Downloads are temporarily unavailable.</td></tr>`;
  }
}

async function refreshAccount() {
  try {
    const response = await fetch("account/profile", {
      credentials: "same-origin"
    });
    const payload = await response.json();
    if (!response.ok) {
      renderAccountMessage("Not signed in.");
      return;
    }
    renderAccountProfile(payload);
  } catch {
    renderAccountMessage("Not signed in.");
  }
}

function renderAccountProfile(payload) {
  const summary = {
    user: payload.user,
    apiKeys: summarizeList(payload.apiKeys, "label"),
    processNodes: summarizeList(payload.processNodes, "deviceName"),
    useOrders: summarizeList(payload.useOrders, "id"),
    transactions: summarizeList(payload.transactions, "kind"),
    distributedRecords: summarizeList(payload.distributedRecords, "type"),
    earnings: payload.earnings,
    billing: payload.billing
  };
  renderAccountMessage(JSON.stringify(summary, null, 2));
}

function renderAccountMessage(message) {
  const output = document.querySelector("#account-output");
  if (output) {
    output.textContent = message;
  }
}

function summarizeList(items, labelKey) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, 8).map((item) => ({
    id: item.id,
    label: item[labelKey],
    status: item.status ?? item.billingStatus ?? item.mode
  }));
}

function shortHash(value) {
  const hash = String(value ?? "");
  return hash.length > 20 ? `${hash.slice(0, 12)}...${hash.slice(-8)}` : hash;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
