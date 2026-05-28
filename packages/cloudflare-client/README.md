# `@sitidos/cloudflare-client`

F9 — typed wrapper around the Cloudflare REST API. Three surfaces only:

1. **DNS write** — `createOrgDNS({ org_slug })`. Called by F20 at org-create
   time. Creates `${org_slug}.sitidos.app` only if the slug is **not** already
   matched by the wildcard (it always is, in Phase-1 — so this is a no-op /
   idempotent create-or-verify). The method exists because F20 may eventually
   want per-org proxied=false records for vanity / customer apex CNAMEs.
2. **Cache purge** — `purgeCacheByTag({ tags })`. Backup path for F17's ISR
   invalidation strategy (primary path is Vercel's own revalidation).
3. **WAF rule list** — `listWafRules()`. Read-only. Vertical agents call this
   to assert the baseline ruleset (F9 `iac/cloudflare/waf.tf`) is intact
   before adding surface-specific rules.

## Token scoping (F9 hard prohibition)

Each method takes its own narrowly-scoped token at construction time. No
single "god token". Tokens live in OpenBao at:

| Surface | OpenBao path | Cloudflare permission |
|---|---|---|
| DNS write | `services/cloudflare/dns_writer_token` | Zone:Edit on `sitidos.app` only |
| Cache purge | `services/cloudflare/cache_purge_token` | Zone:Cache Purge on `sitidos.app` only |
| WAF read | `services/cloudflare/waf_reader_token` | Zone:Read on `sitidos.app` only |

If you only need one surface, pass only that token. Passing a single
broader token is rejected at runtime by the client's permission self-test.

## Hand-off contract (verbatim from F9.md)

```ts
import { CloudflareClient } from "@sitidos/cloudflare-client";

const cf = new CloudflareClient({
  zoneId:           process.env.CLOUDFLARE_ZONE_ID!,
  dnsWriterToken:   await openbao.read("services/cloudflare/dns_writer_token"),
  cachePurgeToken:  await openbao.read("services/cloudflare/cache_purge_token"),
});

await cf.purgeCacheByTag({ tags: ["org:acme:catalog"] });
```

## Hard prohibitions enforced in code

- Any `name` passed to `createOrgDNS` that is not a subdomain of `sitidos.app`
  throws `OutOfZoneError` synchronously (no API call).
- Cache-purge `tags` count > 30 throws `TagLimitError` (Cloudflare hard limit
  is 30 per call).
- The client never logs tokens, never echoes them in error messages.
