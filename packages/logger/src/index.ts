// @sitidos/logger — F10 structured logger.
//
// CONTRACT (F10 prompt §Scope):
//   Every log event has: service, workspace_id?, org_id?, trace_id, severity, event_type.
//
// Emits as OpenTelemetry log records via the Logs API (picked up by the SDK
// initialized in @sitidos/otel-sdk) AND as a JSON line on stdout for local
// dev. The collector ingests via OTLP; nothing else parses stdout in prod.
//
// HARD PROHIBITION: no `console.log` anywhere in sitidos production code.
// Always import this logger.

import { context, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

export type Severity =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

const SEVERITY_TO_OTEL: Record<Severity, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export interface LogContext {
  workspace_id?: string;
  org_id?: string;
  /** Distinct event identifier — e.g. "rpc.call", "iceberg.commit", "auth.deny". */
  event_type: string;
  /** Arbitrary structured attributes. Will be PII-scrubbed at the collector. */
  attrs?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Service name. REQUIRED. */
  service: string;
  /** When true, also emit JSON lines to stdout (default: dev / non-production). */
  stdout?: boolean;
}

export class Logger {
  readonly service: string;
  readonly stdout: boolean;

  constructor(opts: LoggerOptions) {
    this.service = opts.service;
    this.stdout =
      opts.stdout ??
      (process.env.DEPLOYMENT_ENV ?? "dev") !== "production";
  }

  trace(message: string, ctx: LogContext): void { this.emit("trace", message, ctx); }
  debug(message: string, ctx: LogContext): void { this.emit("debug", message, ctx); }
  info(message: string, ctx: LogContext): void { this.emit("info", message, ctx); }
  warn(message: string, ctx: LogContext): void { this.emit("warn", message, ctx); }
  error(message: string, ctx: LogContext): void { this.emit("error", message, ctx); }
  fatal(message: string, ctx: LogContext): void { this.emit("fatal", message, ctx); }

  private emit(severity: Severity, message: string, ctx: LogContext): void {
    const span = trace.getSpan(context.active());
    const sc = span?.spanContext();
    const trace_id = sc?.traceId;
    const span_id = sc?.spanId;

    const record = {
      service: this.service,
      severity,
      event_type: ctx.event_type,
      workspace_id: ctx.workspace_id,
      org_id: ctx.org_id,
      trace_id,
      span_id,
      message,
      ...ctx.attrs,
    };

    // 1) OTel logs API — picked up by the SDK's BatchLogRecordProcessor.
    try {
      logs.getLogger(this.service).emit({
        severityNumber: SEVERITY_TO_OTEL[severity],
        severityText: severity.toUpperCase(),
        body: message,
        attributes: {
          service: this.service,
          event_type: ctx.event_type,
          ...(ctx.workspace_id ? { workspace_id: ctx.workspace_id } : {}),
          ...(ctx.org_id ? { org_id: ctx.org_id } : {}),
          ...(trace_id ? { trace_id } : {}),
          ...(span_id ? { span_id } : {}),
          ...(ctx.attrs ?? {}),
        },
      });
    } catch {
      // Logger MUST NOT throw — observability cannot break the request path.
    }

    // 2) Optional stdout JSON line for local dev.
    if (this.stdout) {
      // eslint-disable-next-line no-console -- the ONE permitted call site
      process.stdout.write(JSON.stringify(record) + "\n");
    }
  }
}

/** Create a logger bound to a given service. */
export function createLogger(opts: LoggerOptions): Logger {
  return new Logger(opts);
}
