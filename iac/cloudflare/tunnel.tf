# F9 — cloudflared tunnel.
#
# Per ADR-0003 the orchestrator-bearing machine moves from macbook (Phase 1/2)
# to Oracle ARM Ampere (Phase 3). The tunnel itself is a single named CF resource;
# the cutover is just installing the credentials file on the new host and
# starting cloudflared there (see docs/runbooks/tunnel-migration.md).
#
# Hard prohibition: tunnel termination NEVER on a public IP.

resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_tunnel" "orchestrator" {
  account_id = var.cloudflare_account_id
  name       = "sitidos-orchestrator-${var.tunnel_target_machine}"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare" # remotely-managed config; ingress declared below
}

# Remotely-managed ingress: routes wildcard hostnames to local services on
# the host running cloudflared.
#
# - app.sitidos.app             → Vercel (handled by DNS CNAME, not tunnel)
# - *.sitidos.app               → orchestrator HTTP on :3131 (per-org sites)
# - mcp.*.sitidos.app           → MCP gateway on :3132 (D8 — only AI surface)
#
# Per-workspace MCP hostnames (mcp.${workspace_id}.sitidos.app) match
# `mcp.*.sitidos.app` via the wildcard cert + ingress rule. No per-workspace
# DNS record needed (one wildcard handles all).
resource "cloudflare_tunnel_config" "orchestrator" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_tunnel.orchestrator.id

  config {
    ingress_rule {
      hostname = "mcp.*.sitidos.app"
      service  = "http://localhost:3132"
      origin_request {
        http_host_header = ""
        no_tls_verify    = false
        connect_timeout  = "10s"
      }
    }

    # Catch-all org subdomains. Specific names like app.sitidos.app are
    # handled by their own DNS CNAME (grey-cloud → Vercel) and never enter
    # the tunnel.
    ingress_rule {
      hostname = "*.sitidos.app"
      service  = "http://localhost:3131"
      origin_request {
        http_host_header = ""
        no_tls_verify    = false
        connect_timeout  = "10s"
      }
    }

    # Mandatory terminal rule.
    ingress_rule {
      service = "http_status:404"
    }
  }
}

output "tunnel_id" {
  value       = cloudflare_tunnel.orchestrator.id
  description = "Tunnel UUID — also the prefix of the cfargotunnel.com CNAME target."
}

output "tunnel_cname" {
  value       = "${cloudflare_tunnel.orchestrator.id}.cfargotunnel.com"
  description = "CNAME target for wildcard DNS records."
}

output "tunnel_token" {
  value       = cloudflare_tunnel.orchestrator.tunnel_token
  description = "cloudflared --token value. Push to OpenBao at infra/cloudflare/tunnel_token; never commit."
  sensitive   = true
}
