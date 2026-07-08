import { DisproClient } from "./dispro-client.js";

const client = new DisproClient();

const created = await client.createOrder({
  source: {
    kind: "url",
    uri: "https://example.com/input.txt",
    byteSize: 1024,
    contentHash: "example-sha256-content-hash"
  },
  workload: "hash.compute",
  priority: "standard",
  verificationLevel: "standard"
});

console.log("created", created.order.id);
console.log(await client.waitForResult(created.order.id));
