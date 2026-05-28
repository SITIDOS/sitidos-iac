# F14 — Polaris Catalog IaC

Apache Polaris (`apache/polaris:1.5.0`, ARM64 PASS per
[`foundation-validation-2026-05-28.md`](../../docs/agents/foundation-validation-2026-05-28.md))
is the single source of truth for "which Iceberg snapshots exist where" across
sitidos.

## Files

| File | Purpose |
|---|---|
| [`bootstrap.sh`](./bootstrap.sh) | Idempotent: warehouse + 7 namespaces + 4 service principals + grants. Stores principal credentials in OpenBao. |
| [`r2-backend.json`](./r2-backend.json) | Declarative R2 backend + IAM model. References `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` as org-scope GitHub secrets. |
| [`snapshot-publisher/`](./snapshot-publisher/) | Sidecar: polls Polaris and publishes snapshot events on Valkey channel `polaris.snapshots` for F2 + F17. |
| [`runbooks/catalog-recovery.md`](./runbooks/catalog-recovery.md) | Recovery from container loss, persistence loss, bad snapshot, and quarterly rotation. |

The compose service definition lives at
[`../../compose/polaris.yaml`](../../compose/polaris.yaml) and is mirrored
inline in `stack/compose/sitidos.yml` (F3-maintained convenience copy).

## Namespaces (7)

`control`, `identity`, `esign`, `acl`, `obs`, `dataroom`, `crm`.

## Service principals (least-privilege)

| Principal | Consumer | Write namespaces | Read namespaces |
|---|---|---|---|
| `f1-writer` | F1 Iceberg writer | control, identity, esign, acl, dataroom, crm | same |
| `f2-reader` | F2 DuckDB reader | — | all 7 |
| `f15-otel-pipeline` | F15 OTel → Iceberg | obs | obs |
| `f14-publisher` | F14 snapshot-publisher (this foundation) | — | all 7 (metadata only) |

**Hard prohibition:** no principal gets cross-namespace `TABLE_WRITE_DATA`.

## Required org-scope GitHub secrets

When this foundation is first dispatched, the founder MUST provision:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

(See dispatch memo §5 "Open carve-outs and risks" — Phase-0 step 2 deferred.)

## Hand-off contract

```yaml
polaris:
  endpoint: http://polaris:8181
  credentials_ref: openbao:polaris-creds-${service_name}
```
