# `@sitidos/logger`

F10 structured logger. Every event has `service`, `workspace_id?`, `org_id?`,
`trace_id`, `severity`, `event_type` (F10 prompt contract).

## Usage

```ts
import { createLogger } from "@sitidos/logger";

const log = createLogger({ service: "rpc-backplane" });

log.info("rpc call dispatched", {
  event_type: "rpc.call",
  workspace_id,
  org_id,
  attrs: { method: "Iceberg.GetTable" },
});
```

## Contract

Every emitted record contains:

| Field | Source |
|---|---|
| `service` | Constructor arg. |
| `severity` | One of `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |
| `event_type` | Caller-supplied, e.g. `rpc.call`, `iceberg.commit`. |
| `workspace_id` | Optional; pulled from caller context. |
| `org_id` | Optional; pulled from caller context. |
| `trace_id` | Auto-pulled from active OTel span. |
| `span_id` | Auto-pulled from active OTel span. |

## Hard prohibitions

- **No `console.log` in production code** — F10 prompt. This logger's stdout
  emission is the *only* permitted process.stdout writer; it's auto-disabled
  in production.
- Logger never throws — observability cannot break the request path.
