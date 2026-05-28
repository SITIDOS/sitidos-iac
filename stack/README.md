# Sitidos backplane stack (dev = macbook, prod = Oracle ARM Ampere)

Per ADR-0002 + ADR-0003 (pending), this directory holds the **portable** backplane that runs:
- on macbook (dev, today)
- on Oracle Always Free ARM Ampere (prod cutover, Phase 3)

All images are pinned to `linux/arm64` so the stack is bit-identical between hosts. **Do not** introduce x86-only images, `host` network mode, or `/Users/...` bind mounts — any of those break the lift-and-shift at cutover.

## Services

| Service | Container | Host port → Container | Purpose |
|---|---|---|---|
| Valkey 8 | `sitidos-valkey` | 6380 → 6379 | Perms cache (60s TTL, keyed `user:workspace:gen`) |
| OpenSearch | `sitidos-opensearch` | 9200 → 9200 | OTel log sink + p95 dashboards |
| OpenSearch Dashboards | `sitidos-opensearch-dashboards` | 5601 → 5601 | Log UI |
| OpenBao | `sitidos-openbao` | 8200 → 8200 | Cryptoshred KMS + PKI for e-sign certs |
| Documenso (Tier-2 e-sign) | `sitidos-documenso` | 3500 → 3000 | Multi-signer flows (AGPL-boundary clean) |
| Documenso Postgres | `sitidos-documenso-db` | (internal) | Documenso's own DB; ours stays Turso libSQL |
| unoserver | `sitidos-unoserver` | 2003 → 2003 | LibreOffice headless for Office → PDF |
| uts-server (TSA fallback) | `sitidos-uts-server` | 8318 → 2020 | PAdES-B-T local fallback (profile: `tsa-fallback`) |

Primary TSA is **FreeTSA.org** (per ADR-0002); uts-server is only enabled when FreeTSA is unreachable, via:
```bash
docker compose -f compose/sitidos.yml --profile tsa-fallback up -d uts-server
```

## Commands

```bash
cd ~/sitidos-stack
docker compose -f compose/sitidos.yml up -d         # bring up
docker compose -f compose/sitidos.yml ps            # status
docker compose -f compose/sitidos.yml logs -f       # tail all
docker compose -f compose/sitidos.yml logs -f valkey opensearch  # tail subset
docker compose -f compose/sitidos.yml down          # stop
docker compose -f compose/sitidos.yml down -v       # stop + wipe volumes
```

## Health checks

```bash
curl -s http://localhost:6380 -X PING               # valkey (use valkey-cli)
docker exec sitidos-valkey valkey-cli ping          # expect PONG
curl -s http://localhost:9200/_cluster/health | jq  # opensearch
curl -s http://localhost:8200/v1/sys/health | jq    # openbao
curl -s http://localhost:3500/api/health            # documenso (may 404 initially)
curl -s http://localhost:5601/api/status            # opensearch dashboards
```

## Migration to Oracle ARM (Phase 3)

Because every image is `linux/arm64` and all bind mounts use **relative** paths (`../data/...`, `../config/...`), migration is:

1. `rsync -a ~/sitidos-stack/ sitidos-arm:/opt/sitidos-stack/`
2. `ssh sitidos-arm 'cd /opt/sitidos-stack && docker compose -f compose/sitidos.yml up -d'`
3. Cut DNS over.

Data volumes go with the rsync. Container IDs change; service identities don't.

## Things F2 will replace before cutover

- OpenBao dev mode → prod auto-unseal (Cloudflare KMS or self-managed Shamir).
- Documenso `CHANGE-ME` secrets → OpenBao-sourced.
- Valkey no-auth → ACL users + TLS.
- OpenSearch security disabled → enabled with self-signed CA + role-based access.
- Postgres for Documenso is the only Postgres in the entire stack and it is **internal to Documenso only**. Sitidos itself stores nothing there.

## What is NOT in this stack (and why)

- **Postgres for Sitidos** — banned by architecture. Turso libSQL handles control plane.
- **Keycloak** — runs in `sitidos-auth` repo's own compose stack (F7 territory).
- **MCP gateway (FastMCP)** — owned by `sitidos-mcp` repo (F6); will be added as a separate compose file that joins the `sitidos` network.
- **RPC (Hono)** — owned by `sitidos-rpc` repo (F8); same pattern.
- **Next.js website** — Vercel Pro, not local Docker.
