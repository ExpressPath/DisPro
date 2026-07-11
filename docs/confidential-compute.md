# Dispro Confidential Compute Boundary

Dispro never sends a user private key, seed phrase, exchange API key, password, or bearer token to a Process node.

## V1 data path

1. The client encrypts each input chunk with a fresh AES-256-GCM data-encryption key (DEK).
2. The DEK is wrapped by the order key-encryption key and is never put in a job envelope.
3. The API signs a minimal envelope containing only the encrypted chunk reference, content hash, nonce, expiry, and egress policy.
4. A Process node receives one chunk reference. It cannot obtain a user secret and cannot directly open arbitrary network connections.
5. Allowlisted market-data requests go through an egress proxy using a short-lived, read-only capability. The proxy owns any upstream credential and rejects trading, withdrawals, and private-network destinations.
6. Results are signed by the node, verified by replicas, and anchored without plaintext customer metadata.

## Cryptographic choices

- Content: AES-256-GCM with a fresh DEK per order/chunk and authenticated metadata.
- Key wrapping: HPKE (RFC 9180) for recipient-bound DEK delivery when an attested confidential worker is available.
- Identity: Ed25519 for API job signatures and node result signatures.
- Storage: envelope encryption with a managed KEK; DEKs are short-lived and revocable.

## Trust tiers

- `standard`: encrypted references and split inputs. The runner may only see the minimum plaintext required for its assigned chunk.
- `confidential`: only remote-attested TEE workers may receive a wrapped DEK. No general desktop Process node is eligible.
- `secret`: no distributed execution. The operation runs behind the secret broker or is rejected.

V1 does not claim to hide plaintext from an untrusted machine while it is executing arbitrary code. Such a claim requires confidential hardware plus remote attestation.
