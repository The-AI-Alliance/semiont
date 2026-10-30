package semiont.conformance

import io.opentelemetry.api.baggage.propagation.W3CBaggagePropagator
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator
import io.opentelemetry.context.propagation.ContextPropagators
import io.opentelemetry.context.propagation.TextMapPropagator
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporter
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader
import io.opentelemetry.sdk.resources.Resource
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor

/**
 * Export the SDK's telemetry over OTLP/HTTP when the suite says where
 * (tests/conformance/sdk/README.md): the global OpenTelemetry the SDK tells,
 * with W3C's propagators. Closing it sends the last of it.
 */
public fun exporting(): OpenTelemetrySdk? {
    val endpoint = System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")?.trimEnd('/') ?: return null
    val resource = Resource.getDefault().merge(Resource.create(Attributes.of(AttributeKey.stringKey("service.name"), "semiont-conformance-driver")))
    val spans = SdkTracerProvider.builder()
        .setResource(resource)
        .addSpanProcessor(BatchSpanProcessor.builder(OtlpHttpSpanExporter.builder().setEndpoint("$endpoint/v1/traces").build()).build())
        .build()
    val meters = SdkMeterProvider.builder()
        .setResource(resource)
        .registerMetricReader(PeriodicMetricReader.builder(OtlpHttpMetricExporter.builder().setEndpoint("$endpoint/v1/metrics").build()).build())
        .build()
    return OpenTelemetrySdk.builder()
        .setTracerProvider(spans)
        .setMeterProvider(meters)
        .setPropagators(ContextPropagators.create(TextMapPropagator.composite(W3CTraceContextPropagator.getInstance(), W3CBaggagePropagator.getInstance())))
        .buildAndRegisterGlobal()
}
