# `packages/` — F10 Observability Core

This directory hosts the drop-in observability packages every sitidos service
imports at boot. Owned by F10.

| Package | Purpose |
|---|---|
| `@sitidos/otel-sdk` | Trace + metric + log auto-instrumentation, sampling policy. |
| `@sitidos/sentry-init` | Sentry SDK wiring; auto-tags `org_id` + `workspace_id`. |
| `@sitidos/logger` | Structured logger emitting OTel-compatible log records. |
| `@sitidos/observability` | Barrel — exports `initObservability()` (F10 hand-off contract). |

## Hand-off contract

```ts
import { initObservability } from "@sitidos/observability";
initObservability({ service: "rpc-backplane" });
```

That single call wires:
- OTLP exporter pointing at the local otel-collector (`http://otel-collector:4318`).
- Sentry SDK with `dsn`, `environment`, `release` from env.
- Logger bound to the active OTel context (so every log gets `trace_id`).

## Hard prohibitions (re-stated, enforced in code)

- No `console.log` in production. Logger throws in `NODE_ENV=production` if
  the host hasn't called `initObservability()` yet.
- No PII in attributes — collector layer is final defense, but these SDKs
  refuse to set attributes whose key matches the deny-list in
  `packages/sentry-init/src/scrub.ts`.
- No Sentry tags containing role names (D14) or auth-provider names (D13);
  enforced at `setTag()` wrapper level.
- No sampling rate > 0.1 for non-error traces — the OTel SDK clamps
  user-supplied success-sampling above 0.1 down to 0.1 in production.

## Publishing

These are workspace-internal packages; they're consumed via path or
workspace alias by the other foundation repos. When the
`SITIDOS/sitidos-packages` umbrella exists they will be republished there.
