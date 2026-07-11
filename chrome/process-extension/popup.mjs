const $ = (selector) => document.querySelector(selector);
let emailVerified = false;
let currentOrderId;
let statusTimer;

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await send("auth:request-code", { email: $("#email").value });
    $("#verify-form").classList.remove("hidden");
    if (result.devVerificationCode) $("#verification-code").value = result.devVerificationCode;
    log(`Verification code sent to ${result.email}.`);
  } catch (error) {
    log(error.message);
  }
});

$("#verify-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await send("auth:verify", { email: $("#email").value, code: $("#verification-code").value });
    setVerified(true);
    log(`Verified ${result.user.email}. Browser session keys are ready.`);
    await refreshAccount();
  } catch (error) {
    log(error.message);
  }
});

$("#process-tab").addEventListener("click", () => setMode("process"));
$("#use-tab").addEventListener("click", () => setMode("use"));
$("#start-button").addEventListener("click", () => run(() => send("process:start")));
$("#stop-button").addEventListener("click", () => run(() => send("process:stop")));
$("#sign-out").addEventListener("click", async () => {
  await run(() => send("auth:clear"));
  setVerified(false);
});
$("#billing-button").addEventListener("click", () => run(() => send("billing:setup")));
$("#payout-button").addEventListener("click", () => run(() => send("wallet:onboarding")));
$("#update-button").addEventListener("click", () => run(() => send("update:install")));
$("#refresh-order").addEventListener("click", () => run(refreshOrder));
$("#result-button").addEventListener("click", () => run(getResult));

$("#order-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    requireVerified();
    const result = await send("use:create-order", {
      input: {
        sourceUri: $("#source-uri").value,
        contentHash: $("#content-hash").value,
        byteSize: $("#byte-size").value,
        workload: $("#workload").value,
        maxChargeMicroYen: $("#max-charge").value
      }
    });
    currentOrderId = result.order.id;
    renderOrder(result.order);
    log(`Use order created: ${currentOrderId}`);
  } catch (error) {
    log(error.message);
  }
});

await initialize();

async function initialize() {
  try {
    const auth = await send("auth:load");
    setVerified(auth.signedIn);
    if (auth.signedIn) {
      log(`Signed in as ${auth.user.email}`);
      await refreshAccount();
    }
  } catch (error) {
    log(error.message);
    setVerified(false);
  }
  await refreshStatus();
  statusTimer = setInterval(() => refreshStatus().catch(() => undefined), 2000);
  window.addEventListener("unload", () => clearInterval(statusTimer));
}

function setVerified(value) {
  emailVerified = Boolean(value);
  const controls = [
    "#process-tab",
    "#use-tab",
    "#start-button",
    "#stop-button",
    "#billing-button",
    "#payout-button",
    "#update-button",
    "#refresh-order",
    "#result-button",
    ...$("#order-form").querySelectorAll("input, button")
  ];
  controls.forEach((element) => {
    element.disabled = !emailVerified;
  });
  $("#auth-lock").classList.toggle("hidden", emailVerified);
  if (!emailVerified) {
    setMode("process", true);
    $("#status-mode").textContent = "locked";
  }
}

function setMode(mode, force = false) {
  if (!emailVerified && !force) {
    log("Verify your email before switching modes or using Dispro actions.");
    return;
  }
  const useMode = mode === "use";
  $("#process-section").classList.toggle("hidden", useMode);
  $("#use-section").classList.toggle("hidden", !useMode);
  $("#process-tab").classList.toggle("active", !useMode);
  $("#use-tab").classList.toggle("active", useMode);
}

async function refreshStatus() {
  const status = await send("process:status");
  $("#status-mode").textContent = status.mode;
  $("#processed-count").textContent = String(status.processedJobs ?? 0);
  $("#failed-count").textContent = String(status.failedJobs ?? 0);
  $("#provisional").textContent = money(status.provisionalMicroYen ?? 0);
  $("#confirmed").textContent = money(status.confirmedMicroYen ?? 0);
  $("#update-button").classList.toggle("hidden", !status.update);
}

async function refreshAccount() {
  if (!emailVerified) return;
  const [billing, wallet] = await Promise.all([send("billing:status"), send("wallet:summary")]);
  $("#billing-status").textContent = billing.setupComplete ? "ready" : "setup";
  $("#available").textContent = money(wallet.availableMicroYen ?? 0);
  $("#payout-button").textContent = wallet.payout?.payoutsEnabled ? "Payout account ready" : "Set up payouts";
}

async function refreshOrder() {
  requireVerified();
  if (!currentOrderId) throw new Error("Create an order first.");
  const result = await send("use:get-order", { orderId: currentOrderId });
  renderOrder(result.order);
}

async function getResult() {
  requireVerified();
  if (!currentOrderId) throw new Error("Create an order first.");
  const result = await send("use:get-result", { orderId: currentOrderId });
  renderOrder(result.order);
  log(JSON.stringify(result.result, null, 2));
}

function renderOrder(order) {
  $("#order-status").textContent = order.status;
  $("#order-estimate").textContent = money(order.estimatedMicroYen ?? 0);
  $("#order-final").textContent = money(order.finalMicroYen ?? 0);
}

async function run(action) {
  try {
    requireVerified();
    const result = await action();
    if (result?.message) log(result.message);
    await refreshStatus();
    await refreshAccount();
  } catch (error) {
    log(error.message);
  }
}

function requireVerified() {
  if (!emailVerified) throw new Error("Email verification is required before using Dispro.");
}

function money(value) {
  return `${(Number(value) / 1_000_000).toFixed(4)} JPY`;
}

function log(message) {
  $("#log").textContent = `[${new Date().toLocaleTimeString()}] ${message}\n${$("#log").textContent}`.slice(0, 6000);
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? "Extension request failed.");
  return response.value;
}
