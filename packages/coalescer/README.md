# @sitidos/coalescer

F8 deliverable. Per-key in-process request coalescer. Within a sliding window,
concurrent callers for the same key share one inner producer call.

## Why

F4's D9b slow path (`source_native_acl` / `idp_passthrough` contracts) calls
upstream identity providers on every PDP check. Without coalescing, a single
MCP tool call that fans out 50 permission checks per (user, resource) pair
would trigger 50 round-trips to the upstream. The coalescer collapses those
into one within a 100ms window.

## Usage

```ts
import { Coalescer } from "@sitidos/coalescer";

const coalescer = new Coalescer({ defaultTtlMs: 100 });

async function checkPermission(user: string, action: string, res: string) {
  return coalescer.run(`${user}:${action}:${res}`, async () => {
    return await fetchUpstreamPermission(user, action, res);
  });
}
```

## Semantics

- Concurrent callers under the same key receive the same Promise.
- After resolve, the value is cached until `ttlMs` from FIRST call (sliding
  window does NOT reset on hit — F4 wants a hard 100ms staleness cap).
- After reject, the entry is dropped immediately. No negative caching. F4's
  circuit-breaker layer handles persistent upstream failure (D9b "fails
  CLOSED").
- Hard upper bound on `ttlMs` is 5000ms.

## Composing with Valkey for cross-process coalescing

```ts
import { ValkeyClient } from "@sitidos/valkey-client";
import { Coalescer } from "@sitidos/coalescer";

const valkey = new ValkeyClient({ service: "cedar-pdp" });
const local = new Coalescer({ defaultTtlMs: 100 });

await local.run(`${user}:${action}:${res}`, async () => {
  // Cross-process leader election via Valkey
  const acquired = await valkey.coalescerLow.tryAcquire({
    userId: user, action, resourceId: res, ttl_ms: 100,
  });
  if (acquired) {
    return fetchUpstream();
  }
  // Lost the race; another replica is fetching. F4 may either:
  //  (a) await a short backoff and re-check the cache, or
  //  (b) fail the check (preferred under D9b fails CLOSED).
  throw new Error("coalesced elsewhere");
});
```
