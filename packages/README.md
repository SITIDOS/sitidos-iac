# `packages/`

TypeScript packages published as `@sitidos/*` for internal consumption by
the orchestrator, F-prompts, and the Next.js shell.

| Package | Owner | Purpose |
|---|---|---|
| `cloudflare-client/` | F9 | Typed Cloudflare API wrapper: DNS write, cache purge, WAF rule list. Per-service scoped tokens. |
| `vercel-alias-client/` | F9 | Typed wrapper for Vercel project-domain alias creation. Used by F20 at org-create time. |

## Layout convention

Each package:
- ESM-only (`"type": "module"`).
- Source ships in `src/` (no build step in Phase-1; bundlers consume `.ts`).
- Zod-validated I/O at API boundaries.
- Vitest unit tests adjacent (`src/*.test.ts`).
- `tsc --noEmit` typecheck via `npm run typecheck`.
- Vitest run via `npm run test`.

The dispatch contract `@sitidos/iac-clients` mentioned in F9.md is the
forthcoming meta-package that re-exports both clients; tracking issue to
be opened once F20 lands and the bundle layout is finalized.
