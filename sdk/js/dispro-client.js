export class DisproClient {
  constructor({ apiKey = process.env.DISPRO_USE_API_KEY, baseUrl = "https://dis-pro-liart.vercel.app" } = {}) {
    if (!apiKey) {
      throw new Error("DISPRO_USE_API_KEY is required.");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createQuote(order) {
    return this.request("/use/quotes", { method: "POST", body: order });
  }

  async createOrder(order, { idempotencyKey = crypto.randomUUID() } = {}) {
    return this.request("/use/orders", {
      method: "POST",
      body: order,
      headers: { "idempotency-key": idempotencyKey }
    });
  }

  async getOrder(orderId) {
    return this.request(`/use/orders/${encodeURIComponent(orderId)}`);
  }

  async getResult(orderId) {
    return this.request(`/use/orders/${encodeURIComponent(orderId)}/result`);
  }

  async waitForResult(orderId, { intervalMs = 3000, timeoutMs = 300000 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const order = await this.getOrder(orderId);
      if (order.order?.result) {
        return this.getResult(orderId);
      }
      if (["failed", "payment_failed"].includes(order.order?.status)) {
        throw new Error(`Dispro order ${orderId} ended with status ${order.order.status}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for Dispro order ${orderId}.`);
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(options.headers ?? {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? `Dispro API request failed with ${response.status}`);
    }
    return payload;
  }
}
