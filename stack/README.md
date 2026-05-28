# Sitidos backplane stack (dev = macbook, prod = Oracle ARM Ampere)

Per ADR-0002 + ADR-0003 + **ADR-0005** (pure Iceberg everywhere), this directory holds the
**portable** backplane that runs:

- on macbook (dev, today)
- on Oracle Always Free ARM Ampere (prod cutover, Phase 3)

All images are pinned to `linux/arm64` so the stack is bit-identical between hosts. **Do not**
introduce x86-only images, `host` network mode, or `/Users/...` bind mounts — any of those break
the lift-and-shift at cutover.

## Services (post-ADR-0005)

| Service | Container | Host port → Container | Foundation | Purpose |
|---|---|---|---|---|
| Valkey 8 | `sitidos-valkey` | 6380 → 6379 | F8 | Cache + ISR pub/sub + coalescer |
| OpenBao | `sitidos-openbao` | 8200 → 8200 | F7 | Per-workspace cryptoshred keys (D4) + PKI |
| **Apache Polaris** | `sitidos-polaris` | 8181, 8182 | **F14** | Iceberg catalog (`apache/polaris:1.5.0`, ARM64 PASS per memo) |
| **OTel Collector** | `sitidos-otel-collector` | 4317, 4318, 8888 | **F10** | Traces/metrics/logs ingest |
| **parquet-writer** | `sitidos-parquet-writer` | (internal) | **F15** | OTel → Iceberg `obs.*` pipeline (profile: `f15`) |
| **revalidator** | `sitidos-revalidator` | (internal) | **F17** | ISR-at-edge invalidation bus (profile: `f17`) |
| unoserver | `sitidos-unoserver` | 2003 → 2003 | — | LibreOffice headless for Office → PDF |
| uts-server (fallback) | `sitidos-uts-server` | 8318 → 2020 | — | PAdES-B-T local TSA fallback (profile: `tsa-fallback`) |

Primary TSA is **FreeTSA.org** (per ADR-0002); uts-server is only enabled when FreeTSA is
unreachable, via:

```bash
docker compose -f compose/sitidos.yml --profile tsa-fallback up -d uts-server
```

The F15 parquet-writer and F17 revalidator services use placeholder image refs
(`ghcr.io/sitidos/...:0.1.0-placeholder`) until the F15 and F17 agents ship them. They are
gated by compose profiles (`f15` and `f17` respectively) so they don't fail boot:

```bash
docker compose -f compose/sitidos.yml --profile f15 --profile f17 up -d
```

## ADR-0005 stack delta (what changed from pre-ADR state)

**ADDED:**
- `polaris` — F14 Iceberg catalog (`apache/polaris:1.5.0`).
- `otel-collector` — F10 observability core.
- `parquet-writer` — F15 OTel→Iceberg pipeline (writes `obs.events`, `obs.traces`,
  `obs.error_groups`).
- `revalidator` — F17 ISR-at-edge invalidation bus.

**REMOVED:**
- `opensearch` + `opensearch-dashboards` — replaced by `obs.*` Iceberg tables queried via F2
  reader / F16 UI. (D1: Iceberg-only persistence.)
- `documenso` + `documenso-db` — moved to private `SITIDOS/sitidos-esign` repo. The Documenso
  fork there uses a Prisma-Iceberg adapter (no Postgres anywhere). AGPL §13 containment via
  separate repo + network-boundary access.

Stale `config/documenso/` and `config/opensearch/` directories will be deleted in this PR.

## Commands

```bash
cd ~/sitidos-stack
docker compose -f compose/sitidos.yml up -d         # bring up (skips f15/f17 profile services)
docker compose -f compose/sitidos.yml ps            # status
docker compose -f compose/sitidos.yml logs -f       # tail all
docker compose -f compose/sitidos.yml down          # stop
docker compose -f compose/sitidos.yml down -v       # stop + wipe volumes
```

To enable the F15/F17 services once their agents ship real images:

```bash
docker compose -f compose/sitidos.yml --profile f15 --profile f17 up -d
```

## Health checks

```bash
docker exec sitidos-valkey valkey-cli ping          # PONG
curl -s http://localhost:8200/v1/sys/health | jq    # openbao
curl -s http://localhost:8181/api/catalog/v1/oauth/tokens  # polaris (expects auth challenge)
curl -s http://localhost:8182/q/health/ready | jq   # polaris management API
curl -s http://localhost:8888/metrics | head        # otel-collector self-metrics
```

## Migration to Oracle ARM (Phase 3)

Because every image is `linux/arm64` and all bind mounts use **relative** paths
(`../data/...`, `../config/...`), migration is:

1. `rsync -a ~/sitidos-stack/ sitidos-arm:/opt/sitidos-stack/`
2. `ssh sitidos-arm 'cd /opt/sitidos-stack && docker compose -f compose/sitidos.yml up -d'`
3. Cut DNS over.

Data volumes go with the rsync. Container IDs change; service identities don't.

## Things foundation agents will tighten before cutover

- **F7**: OpenBao dev mode → prod auto-unseal (Cloudflare KMS or self-managed Shamir).
- **F7**: All `CHANGE-ME` secrets → OpenBao-sourced via env-file pattern.
- **F8**: Valkey no-auth → ACL users + TLS.
- **F14**: Polaris bootstrap script under `iac/polaris/bootstrap.sh` declaring all 7 namespaces
  (control, identity, esign, acl, obs, dataroom, crm) with per-service-principal grants.
- **F15**: ship real `parquet-writer:0.1.0` image to `ghcr.io/sitidos/parquet-writer`.
- **F17**: ship real `revalidator:0.1.0` image to `ghcr.io/sitidos/revalidator`.

## What is NOT in this stack (and why)

- **Postgres** — banned by D1 (Iceberg-only persistence). The Documenso fork in
  `sitidos-esign` uses a Prisma-Iceberg adapter; no Postgres lives anywhere in sitidos
  infrastructure.
- **OpenSearch** — replaced by `obs.*` Iceberg namespace. Query via F16 V-Observability UI.
- **Auth0 / Keycloak containers** — Auth0 is the SaaS broker (D5, hidden behind F18 projection
  layer). No identity-broker container runs locally.
- **MCP gateway (FastMCP)** — owned by `sitidos-mcp` repo (F5); will be added as a separate
  compose file that joins the `sitidos` network.
- **RPC (Hono)** — owned by `sitidos-rpc` repo (F3); same pattern.
- **Next.js website** — Vercel Pro, not local Docker.
