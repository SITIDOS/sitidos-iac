# OpenBao (F7) — per-workspace cryptoshred key management

Owner: **F7**. Coordinates with F1 (writer encrypt), F2 (reader decrypt), F20 (workspace lifecycle).

This directory holds the **declarative configuration** for the OpenBao instance running in
`stack/compose/sitidos.yml` (service `openbao`). It is the canonical source of truth for:

- Transit engine mounts (per-workspace + org-level cryptoshred keys, per D4).
- Policies scoped per service (least-privilege; tenant-isolated).
- Auth methods (AppRole for service identity; mTLS for `destroyKey` privilege escalation).
- Bootstrap + rotation + DR scripts.

## Layout

```
iac/openbao/
├── README.md                          # this file
├── policies/                          # HCL policies, one file per service role
│   ├── f1-data-writer.hcl             # encrypt only, per-workspace path glob
│   ├── f2-data-reader.hcl             # decrypt only, per-workspace path glob
│   ├── f20-org-service.hcl            # create + destroy keys; mTLS-gated
│   ├── f7-rotator.hcl                 # rotate existing keys; never destroy
│   └── deny-list.hcl                  # baseline deny: no list keys cross-tenant
├── bootstrap/
│   ├── 00-enable-engines.sh           # transit + kv-v2 + pki mounts
│   ├── 01-write-policies.sh           # apply all policies/*.hcl
│   ├── 02-enable-approle.sh           # AppRole auth method for service identity
│   └── 03-create-org-key.sh           # org-level key for cryptoshred.key_binding='org'
├── jobs/
│   └── rotate-keys.sh                 # monthly cron — rotates every workspace + org key
└── runbooks/
    └── disaster-recovery.md           # restore from sealed backup; verify cryptoshred
```

## Key model (D4 — VERBATIM)

> **D4** Per-workspace OpenBao key = cryptoshred unit. Every Iceberg table carries a
> `cryptoshred_coverage` declaration (`workspace` | `org` | `none`).

Concretely:

| Iceberg `cryptoshred_coverage` | OpenBao transit key path                | Destroyed by |
|---|---|---|
| `workspace`                    | `transit/keys/workspace-${workspace_id}` | F20 on workspace deletion |
| `org`                          | `transit/keys/org-${org_id}`             | F20 on org deletion (rare) |
| `none`                         | n/a (plaintext at rest)                  | n/a |

Key material **never leaves OpenBao**. F1/F2 call transit encrypt/decrypt endpoints; the
ciphertext returned by OpenBao is what lands in Iceberg parquet. Destroying a key with
`DELETE transit/keys/${path}?force=true` is cryptographically irreversible (no soft delete,
no backup of unsealed material — see Hard prohibitions in F7 prompt).

## Transit key versioning + rotation

OpenBao's transit engine supports versioned keys. Rotation creates a new version while old
versions remain decryptable. This is how monthly rotation (deliverable 4) works without
breaking past Iceberg snapshots:

- `POST transit/keys/${path}/rotate` → new latest version, old versions retained.
- `min_decryption_version` stays at `1` (so historical snapshots decrypt).
- `min_encryption_version` advances to the latest (new writes use newest version).

When F20 calls `destroyKey`, ALL versions go away → cryptoshred is complete.

## Service identity

| Service        | Auth method | Policy file                | Capabilities                                  |
|---|---|---|---|
| F1 data-writer | AppRole     | `f1-data-writer.hcl`       | `transit/encrypt/workspace-*` (update only)   |
| F2 data-reader | AppRole     | `f2-data-reader.hcl`       | `transit/decrypt/workspace-*` (update only)   |
| F20 org-svc    | mTLS cert   | `f20-org-service.hcl`      | `transit/keys/workspace-*` (create+destroy)   |
| F7 rotator     | AppRole     | `f7-rotator.hcl`           | `transit/keys/+/rotate` (update only)         |

mTLS is required for F20 because `destroyKey` is irreversible — AppRole alone is insufficient
attestation per the F7 prompt's hand-off contract.

## Tenant isolation (no cross-workspace key access)

Policies use OpenBao's path templating with `{{identity.entity.aliases.<accessor>.metadata.workspace_id}}`
where applicable. For service identities that legitimately span workspaces (F1 / F2 batch
processes), policies are scoped by **path glob** to `workspace-*` and isolation is enforced
by the **calling service** passing the correct `workspace_id` — which is then audit-logged
on every encrypt/decrypt call. The `obs.events` cryptoshred event is the auditable trail.

## Secrets surfaced for founder provisioning

The dev compose stack uses `BAO_DEV_ROOT_TOKEN_ID=sitidos-dev-root-CHANGE-ME`. Production
requires:

- `OPENBAO_ROOT_TOKEN` — initial root token from `bao operator init` (rotated immediately
  after bootstrap).
- `OPENBAO_UNSEAL_KEYS` — 5 Shamir shares, threshold 3. **Never** stored together; founder
  distributes per the DR runbook.
- `OPENBAO_RECOVERY_KEYS` — if cloud auto-unseal (Cloudflare KMS) is configured.
- mTLS client cert + key for F20 — issued by the OpenBao PKI engine itself once bootstrapped.

All flagged in the PR body for founder provisioning before prod cutover.
