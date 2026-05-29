# F9 — WAF baseline.
#
# Deliberately MINIMAL. Vertical agents tune per surface (e.g. F5/MCP gets
# its own rate-limit ruleset, F19/App Store gets bot-protection for the
# search endpoint).
#
# Goal: managed-challenge known-abusive patterns at the zone edge so they
# never reach the tunnel.

resource "cloudflare_ruleset" "sitidos_waf_baseline" {
  zone_id     = var.cloudflare_zone_id
  name        = "sitidos-waf-baseline"
  description = "F9 baseline WAF — block/challenge known abusive patterns. Tuned by vertical agents per surface."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  # Rule 1: Known credential-stuffing / scanner UAs → managed challenge.
  rules {
    action      = "managed_challenge"
    description = "F9 baseline: challenge known-bad UA fingerprints"
    expression  = <<-EOT
      (http.user_agent contains "sqlmap") or
      (http.user_agent contains "nikto") or
      (http.user_agent contains "masscan") or
      (http.user_agent contains "nmap-scripting-engine") or
      (http.user_agent eq "")
    EOT
    enabled     = true
  }

  # Rule 2: Common admin/wp-* probes on a non-WordPress host.
  rules {
    action      = "block"
    description = "F9 baseline: block WordPress/PHP scanner probes (we run no PHP)"
    expression  = <<-EOT
      (http.request.uri.path contains "/wp-admin") or
      (http.request.uri.path contains "/wp-login") or
      (http.request.uri.path contains "/xmlrpc.php") or
      (http.request.uri.path contains "/.env") or
      (http.request.uri.path contains "/phpmyadmin")
    EOT
    enabled     = true
  }

  # Rule 3: Block requests to the MCP wildcard from non-MCP-shaped paths.
  # MCP-Streamable-HTTP requests are POST + Accept: application/json or
  # application/jsonl. Pure browser GETs at the root are almost always
  # scanners or misrouted traffic.
  rules {
    action      = "managed_challenge"
    description = "F9 baseline: challenge non-MCP-shaped traffic on mcp.*.sitidos.app"
    expression  = <<-EOT
      (http.host matches "^mcp\\..+\\.sitidos\\.app$") and
      (http.request.method eq "GET") and
      (http.request.uri.path eq "/") and
      (not http.user_agent contains "MCP")
    EOT
    enabled     = true
  }
}

output "waf_ruleset_id" {
  value       = cloudflare_ruleset.sitidos_waf_baseline.id
  description = "Baseline WAF ruleset ID — vertical agents reference this when adding rules."
}
