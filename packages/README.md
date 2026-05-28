# packages/

F8-owned TypeScript packages. Each is independently buildable.

| Package | Purpose | Foundation |
|---|---|---|
| `valkey-client/` | Typed, namespace-disciplined Valkey SDK | F8 |
| `coalescer/` | In-process per-key request coalescer (F4 D9b slow path) | F8 |
| `ratelimit/` | Sliding-window rate limiter (F3 per-route) | F8 |

## Conventions

- Node 22, ARM64-first (matches stack/ images).
- TypeScript strict mode, ESM output.
- Vitest for unit tests; integration tests live in `sitidos-tests` (F13).
- Public exports go through `src/index.ts`; everything else is internal.

## Build

Each package has its own `package.json`. There is intentionally no monorepo
toolchain in this repo today; F19 may introduce pnpm workspaces if the
package count grows. For now:

```bash
cd packages/valkey-client && npm install && npm run build && npm test
cd packages/coalescer     && npm install && npm run build && npm test
cd packages/ratelimit     && npm install && npm run build && npm test
```
