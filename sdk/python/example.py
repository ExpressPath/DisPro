from dispro_client import DisproClient


client = DisproClient()

created = client.create_order(
    {
        "source": {
            "kind": "url",
            "uri": "https://example.com/input.txt",
            "byteSize": 1024,
            "contentHash": "example-sha256-content-hash",
        },
        "workload": "hash.compute",
        "priority": "standard",
        "verificationLevel": "standard",
    }
)

print("created", created["order"]["id"])
print(client.wait_for_result(created["order"]["id"]))
