# @sitidos/ratelimit

F8 deliverable. Per-route sliding-window rate limiter for F3 (Hono RPC).
Backed by `@sitidos/valkey-client`'s `ratelimit` namespace.

## Usage

```ts
import { ValkeyClient } from "@sitidos/valkey-client";
import { Ratelimiter } from "@sitidos/ratelimit";

const valkey = new ValkeyClient({ service: "rpc-backplane" });
const rl = new Ratelimiter({
  valkey,
  onDegraded: (err) => log.warn("ratelimit degraded", err),
});

const decision = await rl.check({
  principal: ctx.principal.id,
  budget: { max: 100, window: "1m" },
});

if (!decision.allowed) {
  return new Response("Too Many Requests", { status: 429 });
}
```

## Failure mode

If Valkey is unreachable, the limiter FAILS OPEN with `decision.degraded=true`
and invokes `onDegraded`. This is acceptable for per-route HTTP quotas but
**must not** be the sole gate on the auth path — F4's PDP enforces its own
fail-CLOSED circuit-breaker (D9b).

## Budgets

Recommended starting budgets (F3 will tighten per route):

| Route family | Budget |
|---|---|
| Public unauth (e.g. `/healthz`) | 60 / 1m per IP |
| Auth'd RPC reads | 600 / 1m per principal |
| Auth'd RPC mutations | 60 / 1m per principal |
| MCP tool calls | 120 / 1m per principal |
| Signed-URL minting | 30 / 1m per principal |
