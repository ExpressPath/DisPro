const loginForm = document.querySelector("#login-form");
const verifyForm = document.querySelector("#verify-form");
const apiBaseUrl = document.querySelector("#api-base-url");
const email = document.querySelector("#email");
const tokenOrLink = document.querySelector("#token-or-link");
const log = document.querySelector("#log");
const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");

window.dispro.process.onStatus(renderStatus);

window.dispro.auth
  .load()
  .then((result) => {
    if (result.signedIn) {
      apiBaseUrl.value = result.apiBaseUrl;
      appendLog(`Signed in as ${result.user.email}`);
    }
  })
  .catch((error) => appendLog(error.message));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await window.dispro.auth.requestLink({
      apiBaseUrl: apiBaseUrl.value,
      email: email.value
    });
    verifyForm.classList.remove("hidden");
    if (result.devSignInUrl) {
      tokenOrLink.value = result.devSignInUrl;
      appendLog("Development sign-in link received. Verify to continue.");
    } else {
      appendLog(`Sign-in link sent to ${result.email}.`);
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
      tokenOrLink: tokenOrLink.value
    });
    appendLog(`Verified ${result.user.email}. Process API key is ready.`);
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

function renderStatus(status) {
  document.querySelector("#status-mode").textContent = status.mode;
  document.querySelector("#processed-count").textContent = String(status.processedJobs);
  document.querySelector("#failed-count").textContent = String(status.failedJobs);
  document.querySelector("#earnings").textContent = `${(status.provisionalMicroYen / 1_000_000).toFixed(4)} JPY`;
  appendLog(status.message);
}

function appendLog(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  log.textContent = `${line}\n${log.textContent}`.slice(0, 8000);
}
