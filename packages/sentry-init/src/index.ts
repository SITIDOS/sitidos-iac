// @sitidos/sentry-init — F10 drop-in Sentry SDK wiring.
//
// Init contract (F10 prompt verbatim):
//   Sentry.init({ dsn: env.SENTRY_DSN, environment, release })
//
// Per-environment release tagging via git SHA: SITIDOS_RELEASE env (set by CI).
//
// Auto-tags `org_id` + `workspace_id` from a request-scoped context provided
// by the caller via `withSitidosContext()`.
//
// Hard prohibitions enforced HERE (not only at collector):
//   - No PII in tags / extras: `beforeSend` and `beforeBreadcrumb` scrub.
//   - No D13 ("Auth0", "DuckDB") or D14 (native role names) in tag values:
//     `setSitidosTag()` filter rejects them.

import * as Sentry from "@sentry/node";

import { isTagKeyAllowed, isTagValueAllowed, scrubObject, scrubString } from "./scrub.js";

export interface SentryInitOptions {
  /** Service name (becomes server_name). REQUIRED. */
  service: string;
  /** DSN; defaults to env.SENTRY_DSN. */
  dsn?: string;
  /** Environment; defaults to env.DEPLOYMENT_ENV || "dev". */
  environment?: string;
  /** Release; defaults to env.SITIDOS_RELEASE || "dev". MUST be git SHA in CI. */
  release?: string;
  /** Sample rate for transactions. Defaults to 0.1; clamped to 0.1 in production. */
  tracesSampleRate?: number;
}

let initialized = false;

export function initSentry(opts: SentryInitOptions): typeof Sentry {
  if (initialized) return Sentry;

  const dsn = opts.dsn ?? process.env.SENTRY_DSN;
  const environment = opts.environment ?? process.env.DEPLOYMENT_ENV ?? "dev";
  const release = opts.release ?? process.env.SITIDOS_RELEASE ?? "dev";

  if (!dsn) {
    // Soft-fail: dev environments often run without a DSN. Production CI gates
    // catch a missing DSN before deploy (F10 acceptance test).
    if (environment === "production") {
      throw new Error("[@sitidos/sentry-init] SENTRY_DSN required in production");
    }
    return Sentry;
  }

  const requested = opts.tracesSampleRate ?? 0.1;
  const tracesSampleRate = environment === "production" ? Math.min(requested, 0.1) : requested;

  Sentry.init({
    dsn,
    environment,
    release,
    serverName: opts.service,
    tracesSampleRate,
    sendDefaultPii: false,

    beforeSend(event) {
      // Strip server_name PII risk, scrub all string fields.
      if (event.user) {
        // PII forbidden — keep only opaque id if present.
        event.user = event.user.id ? { id: event.user.id } : undefined;
      }
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, string>;
        delete h.authorization;
        delete h.cookie;
        delete h["set-cookie"];
        delete h["x-api-key"];
        delete h["x-sitidos-api-key"];
        delete h["proxy-authorization"];
      }
      if (event.message) event.message = scrubString(event.message);
      if (event.tags) event.tags = scrubObject(event.tags);
      if (event.extra) event.extra = scrubObject(event.extra);
      if (event.contexts) event.contexts = scrubObject(event.contexts);
      return event;
    },

    beforeBreadcrumb(crumb) {
      if (crumb.message) crumb.message = scrubString(crumb.message);
      if (crumb.data) crumb.data = scrubObject(crumb.data);
      return crumb;
    },
  });

  initialized = true;
  return Sentry;
}

// ---------------------------------------------------------------------------
// Request context helpers — auto-tag org_id + workspace_id.
// ---------------------------------------------------------------------------

export interface SitidosRequestContext {
  org_id?: string;
  workspace_id?: string;
  /** Opaque user id (NEVER an email). */
  user_id?: string;
  /** Upstream trace id from OTel (set automatically by initObservability). */
  trace_id?: string;
}

/**
 * Run `fn` inside a Sentry scope tagged with the given sitidos context.
 * Use this at the top of every request handler / RPC method / queue consumer.
 *
 * Example:
 *   await withSitidosContext({ org_id, workspace_id }, async () => {
 *     await doWork();
 *   });
 */
export async function withSitidosContext<T>(
  ctx: SitidosRequestContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  return Sentry.withScope(async (scope) => {
    if (ctx.org_id) setSitidosTag(scope, "org_id", ctx.org_id);
    if (ctx.workspace_id) setSitidosTag(scope, "workspace_id", ctx.workspace_id);
    if (ctx.trace_id) setSitidosTag(scope, "trace_id", ctx.trace_id);
    if (ctx.user_id) scope.setUser({ id: ctx.user_id });
    return await fn();
  });
}

/** Set a tag with key + value validation (D13 / D14 / PII enforcement). */
export function setSitidosTag(
  scope: Sentry.Scope,
  key: string,
  value: string,
): void {
  if (!isTagKeyAllowed(key)) {
    // Silent drop — log to OTel diag, never to Sentry itself.
    return;
  }
  if (!isTagValueAllowed(value)) {
    // D13 / D14 violation — drop.
    return;
  }
  scope.setTag(key, scrubString(value));
}

export { Sentry };
