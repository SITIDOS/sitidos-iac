/**
 * F8 — Sitidos Valkey client
 *
 * Typed, namespace-disciplined client. The four declared namespaces are
 * compile-time constants; key construction outside them is impossible.
 *
 * Hard prohibitions (F8 + D1):
 *   - No persistent user data; Iceberg-only persistence.
 *   - No keys outside the four declared namespaces.
 *   - No TTLs > 24h. Enforced by MAX_TTL_MS at runtime.
 *
 * Hand-off contract (F8 spec):
 *   const c = new ValkeyClient({ service: "rpc-backplane" });
 *   await c.ratelimit.bump({ key: principal_id, window: "1m" });
 *   await c.coalesce({ key, ttl_ms: 100 }, async () => fetchUpstream());
 */

export { ValkeyClient } from "./client.js";
export type { ValkeyClientOptions, RatelimitWindow, RatelimitResult } from "./client.js";
export type { JwksNamespace, RevalidateNamespace } from "./namespaces.js";
export { REVALIDATE_PUBSUB_CHANNEL, MAX_TTL_MS } from "./namespaces.js";
export type { RevalidationEvent } from "./pubsub.js";
