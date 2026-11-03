import Foundation
import OpenTelemetryApi
import OpenTelemetryProtocolExporterHttp
import OpenTelemetrySdk

/// The conformance application chooses exporters; the SDK links only the telemetry API.
@MainActor
final class DriverTelemetry {
  private let traces: TracerProviderSdk
  private let metrics: MeterProviderSdk
  init?(endpoint: String?) {
    guard let endpoint, let url = URL(string: endpoint) else { return nil }
    let exporter = OtlpHttpTraceExporter(
      endpoint: url.appendingPathComponent("v1/traces"), envVarHeaders: [])
    traces = TracerProviderBuilder().add(spanProcessor: SimpleSpanProcessor(spanExporter: exporter))
      .build()
    let reader = PeriodicMetricReaderBuilder(
      exporter: OtlpHttpMetricExporter(
        endpoint: url.appendingPathComponent("v1/metrics"), envVarHeaders: [])
    )
    .setInterval(timeInterval: 0.1).build()
    metrics = MeterProviderSdk.builder().registerMetricReader(reader: reader)
      .registerView(
        selector: InstrumentSelector.builder().setInstrument(type: .counter).build(),
        view: View.builder().withAggregation(aggregation: Aggregations.sum()).build()
      ).build()
    OpenTelemetry.registerTracerProvider(tracerProvider: traces)
    OpenTelemetry.registerMeterProvider(meterProvider: metrics)
  }
  func flush() {
    traces.forceFlush()
    _ = metrics.forceFlush()
  }
  func finish() {
    traces.forceFlush()
    _ = metrics.forceFlush()
    traces.shutdown()
    _ = metrics.shutdown()
  }
}
