// @sitidos/otel-sdk — F10 drop-in OpenTelemetry SDK.
//
// Wires trace + metric + log exporters at the OTLP endpoint of the local
// otel-collector (compose/otel-collector.yaml). Applies the F10 sampling
// contract:
//   - 1.0 for traces marked ERROR by status_code.
//   - 0.1 for success traces (head-sampling).
//
// HARD CAP: in production, success-sampling cannot exceed 0.1 (clamped).

import { diag, DiagConsoleLogger, DiagLogLevel, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export interface OtelSdkOptions {
  /** Service name (e.g. "rpc-backplane"). REQUIRED. */
  service: string;
  /** Environment (defaults to env.DEPLOYMENT_ENV || "dev"). */
  environment?: string;
  /** Release tag (defaults to env.SITIDOS_RELEASE || "dev"). */
  release?: string;
  /** OTLP endpoint base URL (defaults to env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318"). */
  endpoint?: string;
  /** Success-trace sampling ratio (0..1). Clamped to <= 0.1 in production. */
  successSamplingRatio?: number;
}

let sdk: NodeSDK | undefined;

/** Initialize the OTel SDK. Idempotent. */
export function initOtelSdk(opts: OtelSdkOptions): NodeSDK {
  if (sdk) return sdk;

  if (process.env.OTEL_DIAG === "1") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const environment = opts.environment ?? process.env.DEPLOYMENT_ENV ?? "dev";
  const release = opts.release ?? process.env.SITIDOS_RELEASE ?? "dev";
  const endpoint =
    opts.endpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "http://otel-collector:4318";

  // F10 prohibition: no sampling > 0.1 for non-error traces in production.
  const requested = opts.successSamplingRatio ?? 0.1;
  const ratio =
    environment === "production" ? Math.min(requested, 0.1) : requested;
  if (environment === "production" && requested > 0.1) {
    diag.warn(
      `[@sitidos/otel-sdk] success-sampling ${requested} clamped to 0.1 (F10 production cap)`,
    );
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.service,
    [ATTR_SERVICE_VERSION]: release,
    "service.namespace": "sitidos",
    "deployment.environment": environment,
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
      ),
    ],
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(ratio),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Reduce noise from fs (very chatty, low signal).
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Graceful shutdown — flush exporters on SIGTERM/SIGINT.
  const shutdown = () => {
    sdk
      ?.shutdown()
      .catch((err) => diag.error("OTel SDK shutdown failed", err))
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return sdk;
}

/** Get the OTel tracer for ad-hoc spans. */
export function getTracer(name: string, version?: string) {
  return trace.getTracer(name, version);
}

export { trace };
