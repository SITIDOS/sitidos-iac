// @sitidos/observability — F10 hand-off contract.
//
// One call wires OTel + Sentry + logger. This is what every other foundation
// imports at boot (F10 acceptance criterion #6).
//
//   import { initObservability } from "@sitidos/observability";
//   initObservability({ service: "rpc-backplane" });

import { createLogger, type Logger } from "@sitidos/logger";
import { initOtelSdk, type OtelSdkOptions } from "@sitidos/otel-sdk";
import { initSentry, type SentryInitOptions } from "@sitidos/sentry-init";

export interface ObservabilityOptions {
  /** Service name (e.g. "rpc-backplane"). REQUIRED. */
  service: string;
  /** Environment override; defaults to env.DEPLOYMENT_ENV || "dev". */
  environment?: string;
  /** Release override; defaults to env.SITIDOS_RELEASE || "dev". */
  release?: string;
  /** Sub-options forwarded to each layer. */
  otel?: Partial<Omit<OtelSdkOptions, "service" | "environment" | "release">>;
  sentry?: Partial<Omit<SentryInitOptions, "service" | "environment" | "release">>;
}

export interface ObservabilityHandles {
  logger: Logger;
}

let handles: ObservabilityHandles | undefined;

export function initObservability(opts: ObservabilityOptions): ObservabilityHandles {
  if (handles) return handles;

  const environment = opts.environment ?? process.env.DEPLOYMENT_ENV ?? "dev";
  const release = opts.release ?? process.env.SITIDOS_RELEASE ?? "dev";

  // 1) OTel SDK FIRST — so Sentry + logger can emit into the active context.
  initOtelSdk({
    service: opts.service,
    environment,
    release,
    ...(opts.otel ?? {}),
  });

  // 2) Sentry.
  initSentry({
    service: opts.service,
    environment,
    release,
    ...(opts.sentry ?? {}),
  });

  // 3) Logger bound to this service.
  const logger = createLogger({ service: opts.service });

  handles = { logger };
  return handles;
}

/** Get the process-wide logger; throws if initObservability() not called. */
export function getLogger(): Logger {
  if (!handles) {
    throw new Error(
      "[@sitidos/observability] initObservability() must be called before getLogger()",
    );
  }
  return handles.logger;
}

export { withSitidosContext, setSitidosTag, Sentry } from "@sitidos/sentry-init";
export { getTracer, trace } from "@sitidos/otel-sdk";
export type { Severity, LogContext } from "@sitidos/logger";
