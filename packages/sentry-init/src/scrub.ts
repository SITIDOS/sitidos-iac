// F10 — Sentry tag / breadcrumb scrubber.
//
// Final SDK-side defense before the wire. Collector also scrubs (defense in
// depth), but Sentry SaaS bypasses the collector for some paths, so we MUST
// not let raw PII / role / auth-provider strings into the SDK.

/** Tag keys that are absolutely banned (PII or operational secrets). */
export const BANNED_TAG_KEYS = new Set<string>([
  "email",
  "user_email",
  "phone",
  "user_phone",
  "password",
  "secret",
  "token",
  "api_key",
  "authorization",
  "cookie",
  "set_cookie",
  "credit_card",
  "iban",
  "ssn",
]);

/**
 * Banned tag VALUES (substring match, case-insensitive).
 * Enforces D13 (no "Auth0" / "DuckDB") and D14 (no native role names) per F10
 * prompt's hard prohibitions. Keep this list in sync with
 * `_LAWS.md` D13 / D14 and `tools/lint/banned-strings.json` when that exists.
 */
export const BANNED_TAG_VALUE_SUBSTRINGS = [
  "auth0",
  "duckdb",
  // Conceptual role names that I6 forbids hardcoding. These are NOT
  // upstream-claim strings (which are allowed); these are the
  // sitidos-conceptual role labels that must never leave the PDP.
  "sitidos_admin",
  "sitidos_owner",
  "sitidos_member",
  "sitidos_viewer",
  "sitidos_billing_admin",
];

/** PII regex set — applied to all string tag values and breadcrumb messages. */
export const PII_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/\+?[1-9]\d{7,14}/g, "[REDACTED_PHONE]"],
  [/\b(?:\d[ \-]?){12,18}\d\b/g, "[REDACTED_PAN]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[REDACTED_IBAN]"],
  [/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[REDACTED_JWT]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED_APIKEY]"],
  [/\bghp_[A-Za-z0-9]{30,}\b/g, "[REDACTED_GHTOKEN]"],
  [/\bxox[baprs]-[A-Za-z0-9\-]{10,}/g, "[REDACTED_SLACK]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_AK]"],
];

export function scrubString(input: string): string {
  let out = input;
  for (const [re, replacement] of PII_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function isTagKeyAllowed(key: string): boolean {
  return !BANNED_TAG_KEYS.has(key.toLowerCase());
}

export function isTagValueAllowed(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const lower = value.toLowerCase();
  for (const banned of BANNED_TAG_VALUE_SUBSTRINGS) {
    if (lower.includes(banned)) return false;
  }
  return true;
}

/** Walk an arbitrary object and scrub all string values in place. */
export function scrubObject<T>(obj: T): T {
  if (obj == null) return obj;
  if (typeof obj === "string") return scrubString(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map((v) => scrubObject(v)) as unknown as T;
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = isTagKeyAllowed(k) ? scrubObject(v) : "[REDACTED_KEY]";
    }
    return out as unknown as T;
  }
  return obj;
}
