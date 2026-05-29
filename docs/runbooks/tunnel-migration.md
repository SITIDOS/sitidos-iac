# Runbook — Tunnel Migration (macbook → Oracle ARM, Phase 3)

**Owner:** F9
**Trigger:** ADR-0003 Phase-3 cutover. Orchestrator-bearing machine moves from
Ayoub's macbook (Phase 1/2) to an Oracle Cloud ARM Ampere instance.
**Estimated downtime:** ≤ 60 seconds (DNS-less cutover; tunnel credentials
just need to be installed on the new host).

## Why this is cheap

The cloudflared tunnel is a single named Cloudflare resource keyed by a
credentials file (`*.json`) and a `--token`. Migrating it from one machine
to another is literally:

1. Copy / re-issue the credentials.
2. Stop cloudflared on the old machine.
3. Start cloudflared on the new machine.

The wildcard DNS records (`*.sitidos.app`, `mcp.*.sitidos.app`) keep pointing
at `${tunnel-id}.cfargotunnel.com` — they don't change. There is no DNS TTL
to wait on. Cloudflare's edge re-routes within seconds of the new
cloudflared connection being established.

## Pre-cutover checklist

- [ ] Oracle ARM instance provisioned, SSH reachable, hostname `oracle-arm-1`.
- [ ] `cloudflared` installed on the Oracle instance
      (`arm64` deb / rpm — verify `cloudflared --version` ≥ 2024.x).
- [ ] Orchestrator service (`hive-orchestrator`) running on Oracle and binding
      to `127.0.0.1:3131` (per `iac/cloudflare/tunnel.tf` ingress rule).
- [ ] MCP gateway running on Oracle, binding to `127.0.0.1:3132`.
- [ ] OpenBao reachable from Oracle (F7 owns this — read `infra/cloudflare/tunnel_token`).
- [ ] `tunnel_target_machine` Terraform var staged in PR for flip to `oracle-arm-phase3`.

## Cutover (≤ 60 s)

```bash
# --- on Oracle ARM (the new host) ---
TOKEN=$(bao kv get -field=token infra/cloudflare/tunnel_token)
sudo cloudflared service install "$TOKEN"
sudo systemctl enable --now cloudflared

# Verify the tunnel reports HEALTHY connections to ALL 4 CF edges:
sudo systemctl status cloudflared --no-pager | tail -20
cloudflared tunnel info sitidos-orchestrator-macbook
# expect 8 connections total: 4 from macbook + 4 from oracle (overlap phase)

# --- on macbook (the old host) ---
# Confirm Oracle is taking traffic from a third machine:
curl -sS https://app.sitidos.app/health
# Stop cloudflared cleanly (drains connections):
sudo launchctl unload /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
# Wait ~5s, re-check:
cloudflared tunnel info sitidos-orchestrator-macbook
# expect 4 connections (Oracle only)
```

## Post-cutover

1. Open PR flipping `tunnel_target_machine = "oracle-arm-phase3"` in
   `iac/cloudflare/envs/phase1.tfvars` (or the renamed Phase-3 tfvars file).
2. `terraform apply` — this renames the tunnel resource to
   `sitidos-orchestrator-oracle-arm-phase3`. The tunnel UUID does NOT change
   (Terraform only updates the `name` field; the underlying tunnel
   resource is `update-in-place`). DNS wildcards continue pointing at the
   same `${tunnel-id}.cfargotunnel.com` — no change.
3. Verify smoke endpoints:
   - `curl https://app.sitidos.app/health`
   - `curl https://acme.sitidos.app/health` (replace `acme` with a live org slug)
   - `curl -H "Accept: application/json" https://mcp.<workspace_id>.sitidos.app/`
4. Update `~/sitidos/CLAUDE.md` Section 2 to reflect Oracle as the
   orchestrator-bearing machine.

## Rollback

```bash
# on macbook
sudo launchctl load /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
# on Oracle
sudo systemctl stop cloudflared
```

DNS does not change; rollback is symmetric with the cutover.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `cloudflared` on Oracle shows 0 healthy connections | Outbound 7844/udp blocked | Open `7844/udp` egress on Oracle security list |
| `502` from `*.sitidos.app` after cutover | Orchestrator not bound to `127.0.0.1:3131` on Oracle | `ss -ltnp | grep 3131` — fix service config |
| `526` (invalid cert from origin) | Should not occur — tunnel uses CF-issued cert | Re-run `cloudflared service install` |
| MCP hosts `530` | `mcp.*.sitidos.app` proxied=true requires CF universal SSL; verify it's active in CF dashboard |
| Wildcard cert missing | First-time provisioning — wait ≤ 15 min after `terraform apply` for Cloudflare ACME |

## References

- ADR-0003 (Phase-3 orchestrator location)
- `iac/cloudflare/tunnel.tf` — tunnel + ingress declaration
- `iac/cloudflare/dns.tf` — wildcard DNS records
- F9.md (Deliverable 5)
