import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * OpenTelemetry tracing.
 *
 * Loaded dynamically and behind a flag for two reasons: the SDK must
 * initialise before the modules it instruments are imported, and a tracing
 * backend that is unreachable must never stop the service from booting.
 *
 * With OTEL_ENABLED=true and the compose stack running, every request produces
 * a trace spanning Express, Postgres and Redis, correlated with the logs by
 * the same request id.
 */
export async function startTracing(): Promise<() => Promise<void>> {
  if (!config.OTEL_ENABLED) {
    logger.debug('tracing disabled (set OTEL_ENABLED=true to export traces)');
    return async () => {};
  }

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { getNodeAutoInstrumentations }, { resourceFromAttributes }] =
      await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/auto-instrumentations-node'),
        import('@opentelemetry/resources'),
      ]);

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': config.OTEL_SERVICE_NAME,
        'deployment.environment': config.NODE_ENV,
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Health and metrics scrapes would otherwise dominate the trace
          // volume while carrying no diagnostic value.
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (req) =>
              Boolean(req.url?.startsWith('/health') || req.url?.startsWith('/metrics')),
          },
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    sdk.start();
    logger.info({ endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT }, 'tracing started');
    return () => sdk.shutdown();
  } catch (err) {
    // Missing optional dependencies or an unreachable collector degrade to
    // no tracing. Observability failing closed would be worse than the gap.
    logger.warn({ err: (err as Error).message }, 'tracing unavailable — continuing without traces');
    return async () => {};
  }
}
