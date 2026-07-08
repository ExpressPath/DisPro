import json
import os
import time
import urllib.error
import urllib.request


class DisproClient:
    def __init__(self, api_key=None, base_url="https://dis-pro-liart.vercel.app"):
        self.api_key = api_key or os.environ.get("DISPRO_USE_API_KEY")
        if not self.api_key:
            raise ValueError("DISPRO_USE_API_KEY is required.")
        self.base_url = base_url.rstrip("/")

    def create_order(self, order):
        return self._request("/use/orders", method="POST", body=order)

    def get_order(self, order_id):
        return self._request(f"/use/orders/{order_id}")

    def get_result(self, order_id):
        return self._request(f"/use/orders/{order_id}/result")

    def wait_for_result(self, order_id, interval_seconds=3, timeout_seconds=300):
        started_at = time.time()
        while time.time() - started_at <= timeout_seconds:
            payload = self.get_order(order_id)
            order = payload.get("order", {})
            if order.get("result"):
                return self.get_result(order_id)
            if order.get("status") in ("failed", "payment_failed"):
                raise RuntimeError(f"Dispro order {order_id} ended with status {order.get('status')}.")
            time.sleep(interval_seconds)
        raise TimeoutError(f"Timed out waiting for Dispro order {order_id}.")

    def _request(self, path, method="GET", body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            payload = json.loads(error.read().decode("utf-8") or "{}")
            message = payload.get("error", {}).get("message", f"Dispro API request failed with {error.code}")
            raise RuntimeError(message) from error
