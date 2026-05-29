# `iac/`

Infrastructure-as-code declarations.

| Subdir | Owner | Scope |
|---|---|---|
| `cloudflare/` | F9 | cloudflared tunnel, wildcard DNS (`*.sitidos.app`, `mcp.*.sitidos.app`), WAF baseline. Wildcard cert via Cloudflare ACME. |
| `openbao/` | F7 | (sibling foundation) |
| `polaris/` | TBD | (Iceberg catalog) |

F11 will later add `terraform/vercel/`, `terraform/turso/` per the root README.
F9 lives at `iac/cloudflare/` rather than `terraform/cloudflare/` to match
the dispatch instruction's explicit path; the two are equivalent and F11
may consolidate later.
