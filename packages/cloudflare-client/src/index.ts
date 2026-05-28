// F9 — Typed Cloudflare API client.
//
// Three surfaces only: DNS write, cache purge, WAF rule list.
// Per-service scoped tokens; no "god token".
//
// Hard prohibitions (F9.md):
//  - No DNS writes outside the wildcard zones owned by sitidos.
//  - No granting any service credentials wider than necessary.

import { z } from "zod";

const SITIDOS_ZONE_SUFFIX = ".sitidos.app";
const CF_API = "https://api.cloudflare.com/client/v4";

/** Thrown when a DNS write would touch a hostname outside `*.sitidos.app`. */
export class OutOfZoneError extends Error {
  constructor(hostname: string) {
    super(
      `Refusing DNS write for "${hostname}": only subdomains of sitidos.app are permitted (F9 hard prohibition).`,
    );
    this.name = "OutOfZoneError";
  }
}

/** Thrown when a cache-purge call exceeds Cloudflare's per-call limits. */
export class TagLimitError extends Error {
  constructor(count: number) {
    super(`Cloudflare cache-purge allows at most 30 tags per call; got ${count}.`);
    this.name = "TagLimitError";
  }
}

/** Thrown when the Cloudflare API returns a non-2xx. Never includes the token. */
export class CloudflareApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly errors: unknown,
  ) {
    super(`Cloudflare API ${status} on ${path}: ${JSON.stringify(errors)}`);
    this.name = "CloudflareApiError";
  }
}

export interface CloudflareClientOpts {
  zoneId: string;
  /** Scoped: Zone:Edit on sitidos.app only. Required for createOrgDNS. */
  dnsWriterToken?: string;
  /** Scoped: Zone:Cache Purge on sitidos.app only. Required for purgeCacheByTag. */
  cachePurgeToken?: string;
  /** Scoped: Zone:Read on sitidos.app only. Required for listWafRules. */
  wafReaderToken?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

const cfEnvelope = z.object({
  success: z.boolean(),
  errors: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  result: z.unknown().optional(),
});

const dnsRecordResult = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
});

const purgeResult = z.object({
  id: z.string(),
});

const wafRuleResult = z.object({
  id: z.string(),
  description: z.string().optional(),
  action: z.string(),
  enabled: z.boolean(),
  expression: z.string(),
});

const wafRulesetResult = z.object({
  id: z.string(),
  name: z.string(),
  rules: z.array(wafRuleResult).optional(),
});

export type DnsRecord = z.infer<typeof dnsRecordResult>;
export type WafRule = z.infer<typeof wafRuleResult>;

export interface CreateOrgDNSInput {
  /** Org slug. The hostname `${org_slug}.sitidos.app` will be created/verified. */
  org_slug: string;
  /** Defaults to the wildcard's tunnel target (proxied). Set false for vanity CNAMEs. */
  proxied?: boolean;
  /** Override the CNAME content. Defaults to the wildcard target injected at construction. */
  content?: string;
}

export interface PurgeCacheByTagInput {
  /** Up to 30 cache tags. Format: `org:acme:catalog`, `ws:abc123:catalog`, etc. */
  tags: string[];
}

export class CloudflareClient {
  private readonly zoneId: string;
  private readonly dnsWriterToken: string | undefined;
  private readonly cachePurgeToken: string | undefined;
  private readonly wafReaderToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudflareClientOpts) {
    this.zoneId = opts.zoneId;
    this.dnsWriterToken = opts.dnsWriterToken;
    this.cachePurgeToken = opts.cachePurgeToken;
    this.wafReaderToken = opts.wafReaderToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Create (or verify-exists) a CNAME for `${org_slug}.sitidos.app`.
   *
   * Phase-1: the wildcard `*.sitidos.app` already covers every org, so this
   * call is typically a no-op verification. The method exists for F20 to
   * call unconditionally at org-create time so the org-creation flow is
   * provider-agnostic.
   *
   * Throws OutOfZoneError if the resulting hostname is not a subdomain of
   * sitidos.app.
   */
  async createOrgDNS(input: CreateOrgDNSInput): Promise<DnsRecord> {
    if (!this.dnsWriterToken) {
      throw new Error("createOrgDNS requires `dnsWriterToken` at construction time.");
    }
    const hostname = `${input.org_slug}.sitidos.app`;
    this.assertInZone(hostname);

    const body = {
      type: "CNAME",
      name: hostname,
      content: input.content ?? "tunnel.sitidos.app", // wildcard's effective target
      proxied: input.proxied ?? true,
      ttl: 1,
      comment: `F9/F20 — per-org subdomain for ${input.org_slug}`,
    };

    const json = await this.call({
      path: `/zones/${this.zoneId}/dns_records`,
      method: "POST",
      token: this.dnsWriterToken,
      body,
    });
    return dnsRecordResult.parse(json);
  }

  /**
   * Purge cached responses by tag. Used by F17 as the BACKUP path for ISR
   * invalidation (primary path is Vercel's own `revalidateTag`).
   *
   * Throws TagLimitError if more than 30 tags are passed.
   */
  async purgeCacheByTag(input: PurgeCacheByTagInput): Promise<{ id: string }> {
    if (!this.cachePurgeToken) {
      throw new Error("purgeCacheByTag requires `cachePurgeToken` at construction time.");
    }
    if (input.tags.length === 0) {
      throw new Error("purgeCacheByTag requires at least one tag.");
    }
    if (input.tags.length > 30) {
      throw new TagLimitError(input.tags.length);
    }

    const json = await this.call({
      path: `/zones/${this.zoneId}/purge_cache`,
      method: "POST",
      token: this.cachePurgeToken,
      body: { tags: input.tags },
    });
    return purgeResult.parse(json);
  }

  /**
   * List WAF rules in the zone's custom-firewall ruleset (F9 baseline).
   * Read-only; used by vertical agents to assert the baseline is intact
   * before adding surface-specific rules.
   */
  async listWafRules(rulesetId: string): Promise<WafRule[]> {
    if (!this.wafReaderToken) {
      throw new Error("listWafRules requires `wafReaderToken` at construction time.");
    }
    const json = await this.call({
      path: `/zones/${this.zoneId}/rulesets/${rulesetId}`,
      method: "GET",
      token: this.wafReaderToken,
    });
    const ruleset = wafRulesetResult.parse(json);
    return ruleset.rules ?? [];
  }

  // ---- internals ----

  private assertInZone(hostname: string): void {
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

  private async call(args: {
    path: string;
    method: "GET" | "POST" | "DELETE";
    token: string;
    body?: unknown;
  }): Promise<unknown> {
    const init: RequestInit = {
      method: args.method,
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
      },
    };
    if (args.body !== undefined) {
      init.body = JSON.stringify(args.body);
    }
    const res = await this.fetchImpl(`${CF_API}${args.path}`, init);

    // Parse envelope without ever surfacing the token.
    let parsed: z.infer<typeof cfEnvelope>;
    try {
      const raw = await res.json();
      parsed = cfEnvelope.parse(raw);
    } catch (err) {
      throw new CloudflareApiError(res.status, args.path, {
        message: "non-JSON or unrecognized response",
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    if (!res.ok || !parsed.success) {
      throw new CloudflareApiError(res.status, args.path, parsed.errors ?? []);
    }
    return parsed.result;
  }
}
