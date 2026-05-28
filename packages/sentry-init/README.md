# `@sitidos/sentry-init`

F10 drop-in Sentry SDK wiring. Auto-tags `org_id` + `workspace_id` from a
request-scoped context.

## Usage

```ts
import { initSentry, withSitidosContext } from "@sitidos/sentry-init";

initSentry({ service: "rpc-backplane" });

// per request:
await withSitidosContext({ org_id, workspace_id, user_id }, async () => {
  await handleRequest();
});
```

## Hard prohibitions (enforced in code)

- `setSitidosTag()` rejects banned keys (`email`, `phone`, `token`, …) and
  banned value substrings (D13: "Auth0"/"DuckDB"; D14: native role names).
- `beforeSend` strips PII from user, headers, message, tags, extras, contexts.
- `sendDefaultPii: false` — Sentry SDK is configured to never auto-collect PII.
- In `production`, `tracesSampleRate` is clamped to <= 0.1.
- Missing `SENTRY_DSN` is fatal in production (CI gate).

## Provisioning

`SENTRY_DSN` is an **org-secret**. Per the validation memo §5, missing org
secrets are surfaced in the consuming PR's description, not embedded in code.
The compose stack reads it as `${SENTRY_DSN}` from the env file at runtime.
