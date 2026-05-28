# `@sitidos/observability`

F10 hand-off contract. One call wires OTel + Sentry + logger.

## Usage (every sitidos service, at boot)

```ts
import { initObservability, getLogger } from "@sitidos/observability";

initObservability({ service: "rpc-backplane" });

// anywhere after:
const log = getLogger();
log.info("up", { event_type: "service.boot" });
```

## What it does

1. Initializes `@sitidos/otel-sdk` (traces + metrics + logs → otel-collector).
2. Initializes `@sitidos/sentry-init` (errors → Sentry SaaS; PII-scrubbed).
3. Creates a process-wide structured logger.

## Acceptance criterion (F10 prompt #6)

> Every other foundation imports `@sitidos/otel-sdk` + `@sitidos/sentry-init` at boot.

Importing this barrel satisfies both. F13 (tests) will assert each
foundation's boot path calls `initObservability()` exactly once.
