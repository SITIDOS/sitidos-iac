# `packages/`

TypeScript packages for internal consumption (`@sitidos/*`), built and tested
per-package. There is intentionally no monorepo toolchain in this repo yet;
F19 may introduce pnpm workspaces if the package count grows.

| Package | Owner | Purpose |
|---|---|---|
| `valkey-client/` | F8 | Typed, namespace-disciplined Valkey SDK. |
| `coalescer/` | F8 | In-process per-key request coalescer (F4 D9b slow path). |
| `ratelimit/` | F8 | Sliding-window rate limiter (F3 per-route). |
| `cloudflare-client/` | F9 | Typed Cloudflare API wrapper (DNS write, cache purge, WAF list); per-service scoped tokens. |
| `vercel-alias-client/` | F9 | Typed Vercel project-domain alias creation; used by F20 at org-create. |
| `otel-sdk/` | F10 | Trace + metric + log auto-instrumentation, sampling policy. |
| `sentry-init/` | F10 | Sentry SDK wiring; auto-tags `org_id` + `workspace_id`. |
| `logger/` | F10 | Structured logger emitting OTel-compatible log records. |
| `observability/` | F10 | Barrel — exports `initObservability()` (F10 hand-off contract). |

## Conventions

- Node 22, ARM64-first (matches `stack/` images).
- TypeScript strict mode, ESM-only (`"type": "module"`).
- Public exports go through `src/index.ts`; everything else is internal.
- Zod-validated I/O at API boundaries (clients).
- Vitest unit tests adjacent; integration tests live in `sitidos-tests` (F13).
- `tsc --noEmit` typecheck via `npm run typecheck`; tests via `npm run test`.

## Build

Each package carries its own `package.json`:

```bash
cd packages/<name> && npm install && npm run build && npm test
```

## Observability hand-off (F10)

```ts
import { initObservability } from "@sitidos/observability";
initObservability({ service: "rpc-backplane" });
```

That single call wires the OTLP exporter (pointing at the local otel-collector),
the Sentry SDK, and a logger bound to the active OTel context (so every log
record carries `trace_id`). Hard prohibitions enforced in code: no `console.log`
in production; no PII in attributes; no role names (D14) or auth-provider names
(D13) in Sentry tags; success-trace sampling clamped to ≤ 0.1 in production.
