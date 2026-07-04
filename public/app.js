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
