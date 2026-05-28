# F9 — Wildcard DNS for sitidos.app.
#
# D16: every org gets ${org_slug}.sitidos.app  → covered by *.sitidos.app
# D8:  every workspace gets mcp.${workspace_id}.sitidos.app → covered by mcp.*.sitidos.app
#
# Cloudflare auto-issues wildcard certs for proxied (orange-cloud) hostnames —
# this is Deliverable 4 (wildcard cert provisioning).
#
# Per-org *additional* records (e.g. apex pointed at Vercel for vanity domains)
# are created at runtime by F20 via @sitidos/cloudflare-client. F9 only
# declares the wildcard fallback.
#
# Hard prohibition: no DNS writes outside the sitidos.app zone.

# Wildcard for per-org subdomains: ${org_slug}.sitidos.app
resource "cloudflare_record" "wildcard_org" {
  zone_id = var.cloudflare_zone_id
  name    = "*"
  type    = "CNAME"
  content = "${cloudflare_tunnel.orchestrator.id}.cfargotunnel.com"
  proxied = true # orange-cloud → CF terminates TLS, wildcard cert auto-issued
  ttl     = 1    # required for proxied records

  comment = "F9 D16 — wildcard for $${org_slug}.sitidos.app via cloudflared tunnel"
}

# Wildcard for per-workspace MCP: mcp.${workspace_id}.sitidos.app
resource "cloudflare_record" "wildcard_mcp" {
  zone_id = var.cloudflare_zone_id
  name    = "mcp.*"
  type    = "CNAME"
  content = "${cloudflare_tunnel.orchestrator.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1

  comment = "F9 D8 — wildcard for mcp.$${workspace_id}.sitidos.app (only AI surface)"
}

# app.sitidos.app — Vercel-served Next.js shell. Grey-cloud (DNS-only) so we
# don't double-CDN through Cloudflare + Vercel. Matches root README guidance.
resource "cloudflare_record" "app_vercel" {
  zone_id = var.cloudflare_zone_id
  name    = "app"
  type    = "CNAME"
  content = var.vercel_project_cname
  proxied = false # grey-cloud — Vercel is its own edge
  ttl     = 300

  comment = "F9 — app.sitidos.app served by Vercel (no double-CDN)"
}
