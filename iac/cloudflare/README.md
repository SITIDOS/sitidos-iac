# `iac/cloudflare/`

Terraform module for the F9 public network plane.

## What this declares

- One **named cloudflared tunnel** (`sitidos-orchestrator`) terminating on the
  current orchestrator-bearing machine per ADR-0003 (Phase 1/2 = macbook,
  Phase 3 = Oracle ARM Ampere). Tunnel termination is always `cloudflared`,
  never a public IP (F9 hard prohibition).
- Wildcard DNS:
  - `*.sitidos.app` CNAME → `<tunnel-id>.cfargotunnel.com` (per-org subdomains, D16).
  - `mcp.*.sitidos.app` CNAME → same tunnel (per-workspace MCP, D8).
  - `app.sitidos.app` CNAME → Vercel (DNS-only / grey-cloud, no double-CDN — matches
    root README `stack/` note).
- Wildcard cert provisioning is implicit: Cloudflare handles ACME for proxied
  hostnames; no `cert-manager` / `acme.sh` required (Deliverable 4).
- WAF baseline ruleset (`sitidos-waf-baseline`): managed challenge for known abusive
  patterns (UA fingerprints, path scanners, credential stuffing signatures).
  Deliberately minimal — vertical agents tune per surface.

## What this does NOT declare

- Per-org subdomain *records* (F20 calls F9's `CloudflareClient.createOrgDNS` at
  org-create time).
- ISR invalidation strategy (F17 calls `CloudflareClient.purgeCacheByTag` as the
  primitive).
- Vercel project itself (CD pipeline in `sitidos/` repo).
- OpenBao / Polaris / Valkey infra (other foundations).

## Variables

| Var | Source | Notes |
|---|---|---|
| `cloudflare_api_token` | env `TF_VAR_cloudflare_api_token` → OpenBao `infra/cloudflare/terraform_token` | Scoped: Zone:Edit + Account:Cloudflare Tunnel:Edit on `sitidos.app` only |
| `cloudflare_account_id` | env | Stable, non-secret |
| `cloudflare_zone_id` | env | `sitidos.app` zone |
| `tunnel_target_machine` | tfvars per env | `macbook` / `oracle-arm-phase3` — drives the runbook label only; the tunnel itself is identical |

## Token scoping (F9 hard prohibition: per-service scoped tokens)

Three tokens, three OpenBao paths, three Terraform providers — never a single
"god token":

| Token | Scope | Consumer |
|---|---|---|
| `infra/cloudflare/terraform_token` | Zone:Edit + Tunnel:Edit on `sitidos.app` | `iac/cloudflare/` Terraform only |
| `services/cloudflare/dns_writer_token` | Zone:Edit on `sitidos.app` only | `@sitidos/cloudflare-client` runtime (F20 DNS writes) |
| `services/cloudflare/cache_purge_token` | Zone:Cache Purge on `sitidos.app` only | `@sitidos/cloudflare-client` runtime (F17 ISR backup) |

Each token issued from the Cloudflare dashboard with **only** the listed
permissions. Never wider. Lint check: no `Account:Read` or `User:Read` on any
service-runtime token.

## Apply

```bash
cd iac/cloudflare
terraform init
terraform plan  -var-file=envs/phase1.tfvars
terraform apply -var-file=envs/phase1.tfvars
```

State backend: deferred to F11 (Terraform foundations agent). Until F11 lands,
`terraform.tfstate` is local + gitignored (already in root `.gitignore`).

## Cutover

See [`docs/runbooks/tunnel-migration.md`](../../docs/runbooks/tunnel-migration.md)
for the Phase-3 macbook → Oracle ARM cutover procedure.
