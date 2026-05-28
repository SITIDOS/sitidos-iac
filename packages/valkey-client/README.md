# @sitidos/valkey-client

F8 deliverable. Typed, namespace-disciplined Valkey client for Sitidos.

## Why this exists

Valkey is a free-for-all key-value store. Without discipline, any service can
mint any key with any TTL and we lose the property that Valkey state is fully
rebuildable from Iceberg (D1). This client makes that discipline a compile-time
invariant: the only way to touch Valkey from Sitidos code is through one of the
four declared namespaces, and TTLs are hard-capped at 24h.

## Namespaces

| Namespace | Key shape | Owner | Use |
|---|---|---|---|
| `ratelimit` | `ratelimit:${service}:${principal}:${window}` | F3 | per-route sliding-window counters |
| `jwks` | `jwks:${issuer}` | F18 / F4 | JWK set cache, 10m TTL |
| `coalescer` | `coalescer:${user}:${action}:${resource}` | F4 | D9b 100ms PDP coalescer |
| `revalidate:cursor` | `revalidate:cursor:${tag}` | F17 | ISR-at-edge invalidation cursors, 24h TTL |

Plus the pub/sub channel `revalidate:bus` (broadcast, no retention, no consumer
groups — F17 is the canonical consumer).

## Hand-off (verbatim from F8.md)

```ts
import { ValkeyClient } from "@sitidos/valkey-client";

const c = new ValkeyClient({ service: "rpc-backplane" });

// Ratelimit
const { count } = await c.ratelimit.bump({ key: principal_id, window: "1m" });

// JWKS
await c.jwks.set({ issuer: "https://sitidos.us.auth0.com", jwks });
const set = await c.jwks.get("https://sitidos.us.auth0.com");

// Coalescer (compose with @sitidos/coalescer for in-process dedup)
await c.coalesce({ key: `${user}:${action}:${res}`, ttl_ms: 100 }, async () =>
  fetchUpstream(),
);

// ISR cursor + pub/sub
await c.revalidate.setCursor({ tag: "ws:abc:catalog", cursor: snapshotId });
await c.revalidate.publish({
  v: 1,
  event_id: ulid(),
  source: "iceberg-writer",
  emitted_at: new Date().toISOString(),
  tags: ["ws:abc:catalog", "org:acme"],
});
```

## Prohibitions enforced at compile time

- No way to construct a key outside the four namespaces — there is no
  `client.set(arbitrary_key, value)` method, period.
- No way to pass a TTL > 24h — `assertTtl()` throws.
- No way to construct a key with whitespace, control chars, or oversized
  segments — `assertSafeSegment()` throws.

## Tests

```
pnpm --filter @sitidos/valkey-client test
```

Unit tests cover namespace builders, segment validation, and the revalidation
envelope codec. Integration tests against a real Valkey live in `sitidos-tests`
(F13) once the stack is wired.
