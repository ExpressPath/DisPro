# Dispro Use Orders v1

Use側は公式サイトAPIだけを通して注文します。

```text
Use app / SDK -> Dispro API -> Process network -> Dispro API -> Use app / SDK
```

## Auth

1. `POST /auth/request-code`
2. `POST /auth/verify`
3. `POST /auth/api-keys` with `purpose: "use"`

Use注文APIは `purpose: "use"` のAPIキーだけを受け付けます。

## Billing

1. `POST /billing/setup-session`
2. Stripe Checkoutで支払い方法を登録
3. `GET /billing/status`

処理完了後、Dispro APIが処理重量から最終料金を確定し、保存済み支払い方法へ後払い課金します。
小口注文が `DISPRO_STRIPE_MIN_CHARGE_YEN` 未満の場合は台帳に保留され、まとめ請求の対象になります。

## Order API

```http
POST /use/orders
Authorization: Bearer <DISPRO_USE_API_KEY>
Content-Type: application/json
```

```json
{
  "source": {
    "kind": "url",
    "uri": "https://example.com/input.txt",
    "byteSize": 1024,
    "contentHash": "sha256..."
  },
  "workload": "hash.compute",
  "priority": "standard",
  "verificationLevel": "standard",
  "maxChargeMicroYen": 100000000
}
```

```http
GET /use/orders/:id
GET /use/orders/:id/result
```

## SDK

JavaScript:

```js
import { DisproClient } from "./sdk/js/dispro-client.js";

const client = new DisproClient();
const created = await client.createOrder(order);
const result = await client.waitForResult(created.order.id);
```

Python:

```py
from dispro_client import DisproClient

client = DisproClient()
created = client.create_order(order)
result = client.wait_for_result(created["order"]["id"])
```

Both SDKs read `DISPRO_USE_API_KEY` and default to `https://dis-pro-liart.vercel.app`.
