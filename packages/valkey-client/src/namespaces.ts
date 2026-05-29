/**
 * F8 — Namespace discipline.
 *
 * The four namespaces are the ONLY legal key prefixes. Each builder is a
 * pure function returning a fully-qualified key string. Callers cannot
 * concatenate prefixes themselves: the client only exposes typed methods
 * that route through these builders.
 *
 * Adding a fifth namespace requires an ADR amendment to F8.md.
 */

// ---------------------------------------------------------------------------
// Hard caps
// ---------------------------------------------------------------------------

/** F8 hard prohibition: no key may live longer than 24h. */
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Namespace 1 — ratelimit:${service}:${principal_id}:${window}
// ---------------------------------------------------------------------------

/**
 * Sliding-window labels. Only fixed values to keep the key space bounded
 * and so F8 dashboards can group by window without cardinality explosion.
 */
export type RatelimitWindow = "1s" | "10s" | "1m" | "5m" | "1h";

const RATELIMIT_PREFIX = "ratelimit" as const;

export function ratelimitKey(args: {
  service: string;
  principalId: string;
  window: RatelimitWindow;
}): string {
  assertSafeSegment("service", args.service);
  assertSafeSegment("principal_id", args.principalId);
  return `${RATELIMIT_PREFIX}:${args.service}:${args.principalId}:${args.window}`;
}

// ---------------------------------------------------------------------------
// Namespace 2 — jwks:${issuer}
// ---------------------------------------------------------------------------

export type JwksNamespace = "jwks";

const JWKS_PREFIX = "jwks" as const;

export function jwksKey(issuer: string): string {
  assertSafeIssuer(issuer);
  return `${JWKS_PREFIX}:${issuer}`;
}

// ---------------------------------------------------------------------------
// Namespace 3 — coalescer:${user_id}:${action}:${resource_id}
// ---------------------------------------------------------------------------

const COALESCER_PREFIX = "coalescer" as const;

export function coalescerKey(args: {
  userId: string;
  action: string;
  resourceId: string;
}): string {
  assertSafeSegment("user_id", args.userId);
  assertSafeSegment("action", args.action);
  assertSafeSegment("resource_id", args.resourceId);
  return `${COALESCER_PREFIX}:${args.userId}:${args.action}:${args.resourceId}`;
}

// ---------------------------------------------------------------------------
// Namespace 4 — revalidate:cursor:${tag}
// ---------------------------------------------------------------------------

export type RevalidateNamespace = "revalidate";

const REVALIDATE_CURSOR_PREFIX = "revalidate:cursor" as const;

export function revalidateCursorKey(tag: string): string {
  assertSafeSegment("tag", tag);
  return `${REVALIDATE_CURSOR_PREFIX}:${tag}`;
}

/**
 * Pub/Sub channel for ISR revalidation events (F17 consumes).
 * Single broadcast channel; no consumer groups (fire-and-forget per F8 spec).
 */
export const REVALIDATE_PUBSUB_CHANNEL = "revalidate:bus" as const;

// ---------------------------------------------------------------------------
// Segment validation
// ---------------------------------------------------------------------------

/**
 * Key segments must be ASCII-printable, no whitespace, no `:` (would break
 * namespace parsing). Tags (D7) include `:` themselves (e.g. `ws:${id}:catalog`)
 * so the tag check is separate.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._\-@]{1,256}$/;
const SAFE_TAG = /^[A-Za-z0-9._\-@:]{1,512}$/;

/**
 * JWKS issuers are RFC 7591 `issuer` URLs. We enforce a strict shape:
 * `https://<host>[/<path>]` where host + path use the conservative URL
 * character class. Length capped to discourage cardinality explosion.
 */
function assertSafeIssuer(issuer: string): void {
  if (issuer.length > 512 || !/^https:\/\/[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-\/]*)?$/.test(issuer)) {
    throw new TypeError(
      `[valkey-client] illegal jwks issuer: ${JSON.stringify(issuer)}`,
    );
  }
}

function assertSafeSegment(field: string, value: string): void {
  if (field === "tag") {
    if (!SAFE_TAG.test(value)) {
      throw new TypeError(
        `[valkey-client] illegal tag segment for ${field}: ${JSON.stringify(value)}`,
      );
    }
    return;
  }
  if (!SAFE_SEGMENT.test(value)) {
    throw new TypeError(
      `[valkey-client] illegal key segment for ${field}: ${JSON.stringify(value)}`,
    );
  }
}
