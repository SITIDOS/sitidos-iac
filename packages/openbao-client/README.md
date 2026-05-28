# @sitidos/openbao-client

Thin typed client for the F7 OpenBao integration. Implements the F7 hand-off contract
verbatim:

```ts
import { OpenBaoClient } from "@sitidos/openbao-client";
const c = new OpenBaoClient({ service: "data-writer" });
const ciphertext = await c.encrypt({ workspace_id, plaintext });
const plaintext  = await c.decrypt({ workspace_id, ciphertext });
await c.destroyKey({ workspace_id });   // CRYPTOSHRED — irreversible
```

## Guarantees enforced by this client

- **Transit mode only.** No method ever returns or accepts raw key material. `encrypt` /
  `decrypt` round-trip through `transit/encrypt/*` and `transit/decrypt/*`. There is no
  `getKeyMaterial` method, and there will never be one.
- **`destroyKey` is privileged.** Constructing the client with `service: "org-service"`
  REQUIRES an mTLS cert + key pair. Other services calling `destroyKey` will throw at
  the SDK layer (before even reaching the OpenBao policy layer). Belt-and-suspenders
  with the `f20-org-service.hcl` policy.
- **`destroyKey` is permanent.** It flips `deletion_allowed=true` then issues
  `DELETE transit/keys/${name}?force=true`. No soft-delete option; no `undestroyKey`.
- **Cryptoshred event emission.** `destroyKey` emits a `cryptoshred.destroyed` event to
  the configured `obs.events` sink (pluggable; defaults to an HTTP POST). The destroy is
  only considered successful after the event is acknowledged — partial failure is loud.
- **Per-workspace audit.** Every `encrypt` / `decrypt` / `destroyKey` call passes
  `workspace_id` and `requesting_service` in the OpenBao request metadata, which the
  audit log captures.

## Auth modes

| Service constructor          | Auth method        | Default policy bundle            |
|---|---|---|
| `{ service: "data-writer" }` | AppRole (env)      | `f1-data-writer` + `deny-list`   |
| `{ service: "data-reader" }` | AppRole (env)      | `f2-data-reader` + `deny-list`   |
| `{ service: "rotator" }`     | AppRole (env)      | `f7-rotator` + `deny-list`       |
| `{ service: "org-service" }` | mTLS (cert + key)  | `f20-org-service` + `deny-list`  |

AppRole credentials are read from env vars `OPENBAO_ROLE_ID` + `OPENBAO_SECRET_ID` (per
service deployment; loaded from `kv/services/<role>/openbao_creds` by an init container
in production).

mTLS material for `org-service` is read from env vars `OPENBAO_MTLS_CERT_PATH` +
`OPENBAO_MTLS_KEY_PATH`. Both files must exist; the constructor throws if either is
missing or unreadable.

## Install

This package is intentionally NOT published to npm yet. It is consumed via workspace
linking from the sibling monorepos (`sitidos-data`, `sitidos-rpc`, `sitidos-mcp`).
Phase 2 will publish to a private GitHub Packages registry once the org-level npm
namespace is provisioned.

## Out of scope

- Cryptoshred-wrapping logic (lives in F1 writer + F2 reader; this just provides the
  encrypt/decrypt primitives).
- Workspace lifecycle (F20 calls `createWorkspaceKey` / `destroyWorkspaceKey`; that's
  F20's domain, not this SDK's).
