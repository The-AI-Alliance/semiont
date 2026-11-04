import OpenTelemetryApi

struct TraceMap: Getter, Setter {
  func get(carrier: [String: String], key: String) -> [String]? { carrier[key].map { [$0] } }
  func set(carrier: inout [String: String], key: String, value: String) { carrier[key] = value }
}
func transportSpan(
  _ role: TransportSpan, channel: String? = nil, scope: ResourceId? = nil,
  attributes: [String: AttributeValue] = [:], parent: [String: String]? = nil
) -> any Span {
  guard let row = telemetrySpans.first(where: { $0.name == role.rawValue }),
    let kind = SpanKind(rawValue: row.kind)
  else {
    preconditionFailure("Unsupported telemetry span \(role)")
  }
  let name: String
  if let channel {
    name = role.rawValue.replacingOccurrences(of: "{channel}", with: channel)
  } else {
    precondition(!role.rawValue.contains("{channel}"), "A bus span needs its channel")
    name = role.rawValue
  }
  let builder = OpenTelemetry.instance.tracerProvider.get(instrumentationName: "Semiont")
    .spanBuilder(spanName: name)
    .setSpanKind(spanKind: kind)
  if let parent {
    if let context = OpenTelemetry.instance.propagators.textMapPropagator.extract(
      carrier: parent, getter: TraceMap())
    {
      builder.setParent(context)
    } else {
      builder.setNoParent()
    }
  }
  if let channel { builder.setAttribute(key: "bus.channel", value: channel) }
  if let scope { builder.setAttribute(key: "bus.scope", value: scope.value) }
  for (key, value) in attributes { builder.setAttribute(key: key, value: value) }
  return builder.startSpan()
}

func traceCarrier(_ span: any Span) -> [String: String] {
  var fields: [String: String] = [:]
  OpenTelemetry.instance.propagators.textMapPropagator.inject(
    spanContext: span.context, carrier: &fields, setter: TraceMap())
  return fields
}

extension HttpTransport {
  func sent(channel: String, scope: ResourceId?) {
    if sentCounter == nil {
      sentCounter = OpenTelemetry.instance.meterProvider.get(name: "Semiont").counterBuilder(
        name: TransportMetric.semiontBusSent.rawValue
      ).build()
    }
    var attributes: [String: AttributeValue] = ["bus.channel": .string(channel)]
    if let scope { attributes["bus.scope"] = .string(scope.value) }
    sentCounter?.add(value: 1, attributes: attributes)
  }
}

actor StreamingReadTrace {
  private let span: any Span
  init(_ resource: ResourceId) {
    span = transportSpan(
      .contentGet,
      attributes: ["resource.id": .string(resource.value), "content.stream": .bool(true)])
  }
  func headers() -> [String: String] { traceCarrier(span) }
  func end() { span.end() }
}
