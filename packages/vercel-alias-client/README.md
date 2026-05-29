# `@sitidos/vercel-alias-client`

F9 — typed wrapper for Vercel's project-domain (alias) API.

Single responsibility: at org-create time (called by F20), attach
`${org_slug}.sitidos.app` as an alias on the canonical Vercel project that
hosts the Next.js shell, so requests for the org subdomain resolve to the
correct project.

## Hand-off contract (verbatim from F9.md)

```ts
import { VercelAliasClient } from "@sitidos/vercel-alias-client";

await new VercelAliasClient({
  token:     await openbao.read("services/vercel/alias_writer_token"),
  projectId: process.env.VERCEL_PROJECT_ID!,
}).createOrgAlias({ org_slug: "acme" });
```

## Token scoping (F9 hard prohibition)

The Vercel token MUST be scoped to a single project (`scope = project:${id}`)
and the Project Domains permission only. NOT a team-wide token.

OpenBao path: `services/vercel/alias_writer_token`.

The `VERCEL_TOKEN` secret is flagged for org-secret provisioning per the
dispatch instructions (no commit).

## Hard prohibitions enforced in code

- Refuses to attach a domain that is not a subdomain of `sitidos.app`
  (D16 — orgs ARE the slug under `sitidos.app`; vanity domains use a
  separate, explicit code path that is out of F9's scope).
- The client never logs the token, never echoes it in error messages.
- Idempotent: if Vercel returns 409 (`domain_already_in_use` on this same
  project), it is treated as success.

## Endpoint

`POST https://api.vercel.com/v10/projects/{projectId}/domains`

(Vercel renamed the API version; v9 was deprecated. Headers and shape are
otherwise stable.)
