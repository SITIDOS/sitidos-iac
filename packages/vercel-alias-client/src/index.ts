// F9 — Typed Vercel project-domain (alias) client.
//
// Single use: F20 calls createOrgAlias() at org-create to attach
// ${org_slug}.sitidos.app to the canonical Vercel project hosting the
// Next.js shell.
//
// Hard prohibitions:
//  - No domain attachment outside *.sitidos.app.
//  - Token never logged or echoed in error messages.
//  - Per-project scoped token only; no team-wide tokens.

import { z } from "zod";

const SITIDOS_ZONE_SUFFIX = ".sitidos.app";
// Vercel renamed v9 → v10 in 2023; v10 is the supported endpoint.
const VERCEL_API = "https://api.vercel.com";

export class OutOfZoneError extends Error {
  constructor(hostname: string) {
    super(
      `Refusing Vercel alias for "${hostname}": only subdomains of sitidos.app are permitted (F9 hard prohibition).`,
    );
    this.name = "OutOfZoneError";
  }
}

export class VercelApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Vercel API ${status} on ${path}: ${JSON.stringify(body)}`);
    this.name = "VercelApiError";
  }
}

export interface VercelAliasClientOpts {
  /** Per-project scoped Vercel token (OpenBao: services/vercel/alias_writer_token). */
  token: string;
  /** The Vercel project ID hosting the canonical Sitidos Next.js shell. */
  projectId: string;
  /** Optional teamId — required iff the project lives under a team account. */
  teamId?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface CreateOrgAliasInput {
  /** Org slug. The alias `${org_slug}.sitidos.app` will be attached. */
  org_slug: string;
}

export interface CreateOrgAliasResult {
  hostname: string;
  /** True if Vercel reported "already attached" — request was a no-op. */
  alreadyExisted: boolean;
}

const vercelDomainResult = z.object({
  name: z.string(),
  // Vercel returns many extra fields; we don't model them.
}).passthrough();

const vercelErrorResult = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

export class VercelAliasClient {
  private readonly token: string;
  private readonly projectId: string;
  private readonly teamId: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VercelAliasClientOpts) {
    this.token = opts.token;
    this.projectId = opts.projectId;
    this.teamId = opts.teamId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Attach `${org_slug}.sitidos.app` to the configured Vercel project.
   *
   * Idempotent: a Vercel 409 "domain_already_in_use" on this same project
   * is treated as success (`alreadyExisted: true`).
   */
  async createOrgAlias(input: CreateOrgAliasInput): Promise<CreateOrgAliasResult> {
    const hostname = `${input.org_slug}.sitidos.app`;
    this.assertInZone(hostname);

    const url = this.buildUrl(`/v10/projects/${encodeURIComponent(this.projectId)}/domains`);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: hostname }),
    });

    if (res.status === 200 || res.status === 201) {
      const raw = await safeJson(res);
      const parsed = vercelDomainResult.parse(raw);
      return { hostname: parsed.name, alreadyExisted: false };
    }

    // Idempotent path: Vercel returns 409 with error.code === "domain_already_in_use"
    // OR "forbidden" when the domain is already attached to the SAME project.
    if (res.status === 409) {
      const raw = await safeJson(res);
      const parsed = vercelErrorResult.safeParse(raw);
      const code = parsed.success ? parsed.data.error?.code : undefined;
      if (code === "domain_already_in_use" || code === "alias_in_use") {
        return { hostname, alreadyExisted: true };
      }
      throw new VercelApiError(res.status, url, raw);
    }

    const raw = await safeJson(res);
    throw new VercelApiError(res.status, url, raw);
  }

  // ---- internals ----

  private assertInZone(hostname: string): void {
    // Must end with .sitidos.app, must not be the apex, and the label
    // immediately preceding the suffix must be non-empty (rejects ".sitidos.app").
    if (!hostname.endsWith(SITIDOS_ZONE_SUFFIX)) {
      throw new OutOfZoneError(hostname);
    }
    if (hostname === "sitidos.app") {
      throw new OutOfZoneError(hostname);
    }
    const label = hostname.slice(0, -SITIDOS_ZONE_SUFFIX.length);
    if (label.length === 0) {
      throw new OutOfZoneError(hostname);
    }
  }

  private buildUrl(path: string): string {
    const url = new URL(`${VERCEL_API}${path}`);
    if (this.teamId) {
      url.searchParams.set("teamId", this.teamId);
    }
    return url.toString();
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { __nonJson: true, status: res.status };
  }
}
