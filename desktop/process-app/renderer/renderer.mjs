const loginForm = document.querySelector("#login-form");
const verifyForm = document.querySelector("#verify-form");
const apiBaseUrl = document.querySelector("#api-base-url");
const email = document.querySelector("#email");
const verificationCode = document.querySelector("#verification-code");
const log = document.querySelector("#log");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const clearAuthButton = document.querySelector("#clear-auth-button");
const processModeButton = document.querySelector("#process-mode-button");
const useModeButton = document.querySelector("#use-mode-button");
const processSection = document.querySelector("#process-section");
const useSection = document.querySelector("#use-section");
const billingStatusButton = document.querySelector("#billing-status-button");
const billingSetupButton = document.querySelector("#billing-setup-button");
const useOrderForm = document.querySelector("#use-order-form");
const useRefreshOrderButton = document.querySelector("#use-refresh-order-button");
const useResultButton = document.querySelector("#use-result-button");
let currentUseOrderId;

window.dispro.process.onStatus(renderStatus);

window.dispro.auth
  .load()
  .then((result) => {
    if (result.signedIn) {
      apiBaseUrl.value = result.apiBaseUrl;
      appendLog(`Signed in as ${result.user.email}`);
      refreshBillingStatus().catch((error) => appendLog(error.message));
    }
  })
  .catch((error) => appendLog(error.message));

processModeButton.addEventListener("click", () => setMode("process"));
useModeButton.addEventListener("click", () => setMode("use"));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await window.dispro.auth.requestLink({
      apiBaseUrl: apiBaseUrl.value,
      email: email.value
    });
    verifyForm.classList.remove("hidden");
    if (result.devVerificationCode) {
      verificationCode.value = result.devVerificationCode;
      appendLog("Development verification code received. Verify to continue.");
    } else {
      appendLog(`Verification code sent to ${result.email}.`);
    }
  } catch (error) {
    appendLog(error.message);
  }
});

verifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await window.dispro.auth.verify({
      apiBaseUrl: apiBaseUrl.value,
      email: email.value,
      code: verificationCode.value
    });
    appendLog(`Verified ${result.user.email}. Process API key is ready.`);
    await refreshBillingStatus();
  } catch (error) {
    appendLog(error.message);
  }
});

startButton.addEventListener("click", async () => {
  try {
    await window.dispro.process.start();
  } catch (error) {
    appendLog(error.message);
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await window.dispro.process.stop();
  } catch (error) {
    appendLog(error.message);
  }
});

clearAuthButton.addEventListener("click", async () => {
  try {
    await window.dispro.auth.clear();
    appendLog("Stored sign-in cleared. Sign in again to create a fresh Process API key.");
  } catch (error) {
    appendLog(error.message);
  }
});

billingStatusButton.addEventListener("click", async () => {
  try {
    await refreshBillingStatus();
  } catch (error) {
    appendLog(error.message);
  }
});

billingSetupButton.addEventListener("click", async () => {
  try {
    const result = await window.dispro.billing.setup();
    appendLog(result.url ? "Payment setup opened in your browser." : "Payment setup is ready.");
    await refreshBillingStatus();
  } catch (error) {
    appendLog(error.message);
  }
});

useOrderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await window.dispro.use.createOrder({
      sourceKind: "url",
      sourceUri: document.querySelector("#use-source-uri").value,
      contentHash: document.querySelector("#use-content-hash").value,
      byteSize: document.querySelector("#use-byte-size").value,
      workload: document.querySelector("#use-workload").value,
      maxChargeMicroYen: document.querySelector("#use-max-charge").value,
      priority: "standard",
      verificationLevel: "standard"
    });
    currentUseOrderId = result.order.id;
    renderUseOrder(result.order);
    appendLog(`Use order created: ${currentUseOrderId}`);
  } catch (error) {
    appendLog(error.message);
  }
});

useRefreshOrderButton.addEventListener("click", async () => {
  try {
    await refreshUseOrder();
  } catch (error) {
    appendLog(error.message);
  }
});

useResultButton.addEventListener("click", async () => {
  try {
    if (!currentUseOrderId) {
      throw new Error("Create or refresh an order first.");
    }
    const result = await window.dispro.use.getResult(currentUseOrderId);
    renderUseOrder(result.order);
    appendLog(JSON.stringify(result.result, null, 2));
  } catch (error) {
    appendLog(error.message);
  }
});

function setMode(mode) {
  const useMode = mode === "use";
  useSection.classList.toggle("hidden", !useMode);
  processSection.classList.toggle("hidden", useMode);
  useModeButton.classList.toggle("active", useMode);
  processModeButton.classList.toggle("active", !useMode);
}

function renderStatus(status) {
  document.querySelector("#status-mode").textContent = status.mode;
  document.querySelector("#processed-count").textContent = String(status.processedJobs);
  document.querySelector("#failed-count").textContent = String(status.failedJobs);
  document.querySelector("#earnings").textContent = `${(status.provisionalMicroYen / 1_000_000).toFixed(4)} JPY`;
  appendLog(status.message);
}

async function refreshBillingStatus() {
  const status = await window.dispro.billing.status();
  document.querySelector("#billing-status").textContent = status.setupComplete ? "ready" : "setup";
  appendLog(status.setupComplete ? "Billing is ready." : "Payment method is not registered.");
  return status;
}

async function refreshUseOrder() {
  if (!currentUseOrderId) {
    throw new Error("Create a Use order first.");
  }
  const result = await window.dispro.use.getOrder(currentUseOrderId);
  renderUseOrder(result.order);
}

function renderUseOrder(order) {
  document.querySelector("#use-order-status").textContent = order.status;
  document.querySelector("#use-estimate").textContent = formatMicroYen(order.estimatedMicroYen);
  document.querySelector("#use-final").textContent = formatMicroYen(order.finalMicroYen ?? 0);
}

function formatMicroYen(value) {
  return `${(value / 1_000_000).toFixed(4)} JPY`;
}

function appendLog(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.textContent = `${line}\n${log.textContent}`.slice(0, 8000);
}
