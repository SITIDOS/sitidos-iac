# `@sitidos/otel-sdk`

F10 drop-in OpenTelemetry SDK for sitidos services.

## Usage

```ts
import { initOtelSdk } from "@sitidos/otel-sdk";
initOtelSdk({ service: "rpc-backplane" });
```

Or use the barrel from `@sitidos/observability` which calls this for you.

## Defaults

| Env var | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4318` | OTLP HTTP base URL. |
| `DEPLOYMENT_ENV` | `dev` | Environment tag. |
| `SITIDOS_RELEASE` | `dev` | Release tag (set by CI to git SHA). |
| `OTEL_DIAG` | `0` | `1` enables diag console logger. |

## Sampling

Per F10 contract:
- ERROR-status traces: 1.0 (always sampled — enforced at collector tail-sampling).
- Success traces: 0.1 head-sampling; **clamped to 0.1 in production**.

## Auto-instrumentation

Loads `@opentelemetry/auto-instrumentations-node` minus `fs` (too noisy).
Covers http, https, fetch, undici, pg, mysql, redis, ioredis, grpc, express,
fastify, koa, hono (via http), aws-sdk, and more.
