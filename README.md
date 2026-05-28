# sitidos-iac

Infrastructure-as-code + the live backplane compose stack.

## Scope

- `stack/` — Docker compose stack (Valkey, OpenSearch+Dashboards, OpenBao, Documenso+pg, unoserver, uts-server[deferred]). All images `linux/arm64` so macbook (dev) and Oracle ARM Ampere (prod cutover) are bit-identical.
- `terraform/cloudflare/` — Tunnel, R2 buckets per workspace, Queues, Vectorize (not used — DuckDB vss), Workers AI bindings
- `terraform/vercel/` — Next.js website project (`app.sitidos.app`, DNS-only/grey at CF — no double-CDN)
- `terraform/turso/` — control plane libSQL databases
- `openbao/` — bootstrap: workspace cryptoshred keys, PKI engine roots, KV-v2 mounts, auto-unseal
- `launchd/` — macOS launchd plists for stack supervisor + caffeinate watchdog (dev host only)
- `migration/` — `rsync` + `compose up` runbook for Phase 3 macbook → Oracle ARM cutover

## Owners

F2 (OpenBao + secrets engines)
F3 (compose stack + supervisor + launchd)
F11 (Terraform: CF / Vercel / Turso)

## Local dev

`cd stack && docker compose -f compose/sitidos.yml up -d`
