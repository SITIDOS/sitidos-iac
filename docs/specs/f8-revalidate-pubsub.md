# F8 — Pub/Sub spec: `revalidate:bus`

Status: stable for F17 consumption.
Owner: F8 (Valkey integration).
Consumers: F17 (ISR revalidation worker). Others by ADR amendment only.

## Channel

- Name: `revalidate:bus`
- Transport: Valkey 8 native `PUBLISH` / `SUBSCRIBE`
- Encoding: UTF-8 JSON
- Authorization: in-network only (Docker bridge network `valkey` /
  the broader `sitidos` network when running inside `stack/compose/sitidos.yml`)

## Retention policy

**None.** Fire-and-forget. If F17 is offline at publish time, the event is
lost. F17's startup procedure handles missed events by reconciling against
the `revalidate:cursor:${tag}` keys (which DO persist, with a 24h TTL cap).

This is intentional and matches the D7 ISR-at-edge SLO: p95 < 800ms
commit-to-edge-invalidation. A durable queue (Streams / Cloudflare Queues)
adds tens of ms of overhead per event and is not worth the cost for a
best-effort cache-bust signal.

## Consumer-group discipline

**None.** Pure broadcast. Every subscriber sees every event. F17 is the
canonical consumer; secondary subscribers (e.g. F10 observability tap, F16
V-Observability UI live tail) are read-only and MUST NOT mutate state
based on events they receive.

## Payload schema (v1)

```ts
interface RevalidationEventV1 {
  v: 1;
  event_id: string;          // ULID; F17 dedupes against a 60s window
  source: string;            // producer service name (observability only)
  emitted_at: string;        // RFC3339 UTC
  tags: string[];            // D7 tag taxonomy; <= 128 entries
  iceberg_snapshot_id?: string;  // optional triggering snapshot id
}
```

### Tag taxonomy (D7, verbatim)

- `ws:${id}:${namespace}`
- `org:${slug}`
- `org:${slug}:catalog`
- `user:${id}:memberships`

Hard cap: 128 tags per event (Vercel `revalidateTag` ceiling). Producers
that need more tags MUST split into multiple events.

### Versioning

Producers MUST emit `v: 1`. Consumers MUST gracefully ignore events with
unknown future `v` values. Schema changes require an ADR amendment and a
new version number; the old version stays decodable until all producers
are migrated.

## Producer reference

```ts
import { ValkeyClient } from "@sitidos/valkey-client";
import { ulid } from "ulid";

const valkey = new ValkeyClient({ service: "iceberg-writer" });

await valkey.revalidate.publish({
  v: 1,
  event_id: ulid(),
  source: "iceberg-writer",
  emitted_at: new Date().toISOString(),
  tags: ["ws:abc:catalog", "org:acme"],
  iceberg_snapshot_id: snapshot.id,
});
```

## Consumer reference (F17)

```ts
import { ValkeyClient } from "@sitidos/valkey-client";

const valkey = new ValkeyClient({ service: "revalidator" });

const unsubscribe = await valkey.revalidate.subscribe(
  async (event) => {
    // 1. dedupe by event.event_id (60s LRU)
    // 2. call Vercel revalidateTag(event.tags)
    // 3. update revalidate:cursor:${tag} for each tag
  },
  (err) => log.error("revalidate sub error", err),
);

// On shutdown:
await unsubscribe();
```

## Observability

F10 expects the following OTel attributes on every publish/receive span:

- `sitidos.revalidate.event_id`
- `sitidos.revalidate.source`
- `sitidos.revalidate.tag_count`
- `sitidos.revalidate.has_snapshot_id`

(The valkey-client does not emit spans itself — wrap calls in your
service's tracer; F10 will publish a shared helper in Phase 1B.)

## SLOs

| Metric | Target |
|---|---|
| Publish latency (p95) | < 5ms |
| Subscriber delivery latency (p95) | < 50ms within stack |
| Commit-to-edge-invalidation end-to-end (p95) | < 800ms (D7) |
