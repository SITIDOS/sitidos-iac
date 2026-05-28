variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token, scoped to Zone:Edit + Account:Cloudflare Tunnel:Edit
    on the sitidos.app zone ONLY. Sourced from OpenBao at
    infra/cloudflare/terraform_token. Never committed.
  EOT
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID owning the sitidos.app zone. Stable, not secret."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for sitidos.app. Stable, not secret."
  type        = string
}

variable "tunnel_target_machine" {
  description = <<-EOT
    Logical label of the machine currently bearing the cloudflared tunnel
    per ADR-0003. Phase 1/2 = 'macbook', Phase 3 = 'oracle-arm-phase3'.
    Surfaces in the tunnel name + WAF rule descriptions only; the tunnel
    itself is identical across machines (it's just a credentials file).
  EOT
  type        = string
  default     = "macbook"

  validation {
    condition     = contains(["macbook", "oracle-arm-phase3"], var.tunnel_target_machine)
    error_message = "tunnel_target_machine must be 'macbook' or 'oracle-arm-phase3'."
  }
}

variable "vercel_project_cname" {
  description = "CNAME target for app.sitidos.app — Vercel project DNS target (grey-cloud / DNS-only)."
  type        = string
  default     = "cname.vercel-dns.com"
}
