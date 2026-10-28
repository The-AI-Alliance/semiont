package semiont

// What this SDK's transports tell OpenTelemetry: the spans and the count the
// SDK telemetry table lists (telemetry_gen.go), a span for each frame sent and
// each received, one for each upload and each read, and a count of the emits
// sent. It takes OpenTelemetry's API alone, so every OpenTelemetry choice is
// the application's: nothing here is recorded or sent until the process
// installs a provider, and no trace context travels until it installs a
// propagator (W3C's, for the traceparent and tracestate every Semiont service
// reads). The tracer, the meter and the propagator are taken at each use, so
// what is installed after a client opened is used all the same.
//
// A request carries the trace it was made in. A frame brings the trace it was
// sent under, and the span that marks its arrival continues it.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// instrumentationScope is the scope every span and count here is made under.
const instrumentationScope = "semiont"

// TraceContext is a trace as the wire carries one: what a frame was sent
// under. Its zero value is no trace.
type TraceContext struct {
	Traceparent string
	Tracestate  string
}

// IsZero reports whether t is no trace.
func (t TraceContext) IsZero() bool { return t.Traceparent == "" }

func (t TraceContext) carrier() propagation.MapCarrier {
	carrier := propagation.MapCarrier{"traceparent": t.Traceparent}
	if t.Tracestate != "" {
		carrier["tracestate"] = t.Tracestate
	}
	return carrier
}

// Continuing is ctx holding trace: a span started under it continues that
// trace, as the work done for a frame continues the trace the frame brought
// (Frame.Trace). With no trace, or no propagator installed to read one, it is
// ctx.
func Continuing(ctx context.Context, trace TraceContext) context.Context {
	if trace.IsZero() {
		return ctx
	}
	return otel.GetTextMapPropagator().Extract(ctx, trace.carrier())
}

// activeTrace is the trace ctx is in, as the wire carries one: none when it is
// in none, or no propagator is installed to write one.
func activeTrace(ctx context.Context) TraceContext {
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return TraceContext{Traceparent: carrier.Get("traceparent"), Tracestate: carrier.Get("tracestate")}
}

// carryTrace puts the trace ctx is in on a request's headers: none when it is
// in none, or no propagator is installed to write one.
func carryTrace(ctx context.Context, header http.Header) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(header))
}

// withoutTrace is a frame's payload without the trace it rides in, and that
// trace. ok is false when the payload, having a trace, cannot be written
// again without it: such a payload is not a frame's.
func withoutTrace(payload json.RawMessage) (rest json.RawMessage, sentUnder TraceContext, ok bool) {
	if !bytes.Contains(payload, []byte(`"`+bus.TraceField+`"`)) {
		return payload, TraceContext{}, true
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return nil, TraceContext{}, false
	}
	carried, has := fields[bus.TraceField]
	if !has {
		return payload, TraceContext{}, true
	}
	delete(fields, bus.TraceField)
	rest, err := json.Marshal(fields)
	if err != nil {
		return nil, TraceContext{}, false
	}
	var stated struct {
		Traceparent *string `json:"traceparent"`
		Tracestate  *string `json:"tracestate"`
	}
	if json.Unmarshal(carried, &stated) != nil || stated.Traceparent == nil {
		return rest, TraceContext{}, true
	}
	sentUnder.Traceparent = *stated.Traceparent
	if stated.Tracestate != nil {
		sentUnder.Tracestate = *stated.Tracestate
	}
	return rest, sentUnder, true
}

// named is the span's name for a frame on channel.
func (s telemetrySpan) named(channel bus.Channel) string {
	return strings.Replace(s.name, telemetryChannel, string(channel), 1)
}

// startSpan starts a span of the table under ctx.
func startSpan(ctx context.Context, row telemetrySpan, name string, attributes ...attribute.KeyValue) (context.Context, trace.Span) {
	return otel.Tracer(instrumentationScope).Start(ctx, name, trace.WithSpanKind(row.kind), trace.WithAttributes(attributes...))
}

// onTheBus is what a span or a count of the bus carries: the channel, and
// the scope when there is one.
func onTheBus(channel bus.Channel, scope api.ResourceId) []attribute.KeyValue {
	attributes := []attribute.KeyValue{keyBusChannel.String(string(channel))}
	if !scope.IsZero() {
		attributes = append(attributes, keyBusScope.String(scope.String()))
	}
	return attributes
}

// emitting counts an emit as sent and starts its span, which the emit ends.
func emitting(ctx context.Context, channel bus.Channel, scope api.ResourceId) (context.Context, trace.Span) {
	attributes := onTheBus(channel, scope)
	sent, err := otel.Meter(instrumentationScope).Int64Counter(metricSemiontBusSent.name, metric.WithDescription(metricSemiontBusSent.meaning))
	if err != nil {
		otel.Handle(err)
	} else {
		sent.Add(ctx, 1, metric.WithAttributes(attributes...))
	}
	return startSpan(ctx, spanBusEmit, spanBusEmit.named(channel), attributes...)
}

// received marks a frame's arrival, in the trace it was sent under, and is
// the trace the work done for the frame continues: the arrival's own span
// when one is recorded, and what the frame brought otherwise.
func received(channel bus.Channel, scope api.ResourceId, sentUnder TraceContext) TraceContext {
	ctx, span := startSpan(Continuing(context.Background(), sentUnder), spanBusRecv, spanBusRecv.named(channel), onTheBus(channel, scope)...)
	defer span.End()
	if active := activeTrace(ctx); !active.IsZero() {
		return active
	}
	return sentUnder
}

// uploading starts an upload's span.
func uploading(ctx context.Context, format string, sizeBytes int) (context.Context, trace.Span) {
	return startSpan(ctx, spanContentPut, spanContentPut.name, keyContentFormat.String(format), keyContentSizeBytes.Int(sizeBytes))
}

// getting starts the span of a read of a resource's bytes, whole or as a
// stream.
func getting(ctx context.Context, resource api.ResourceId, stream bool) (context.Context, trace.Span) {
	attributes := []attribute.KeyValue{keyResourceID.String(resource.String())}
	if stream {
		attributes = append(attributes, keyContentStream.Bool(true))
	}
	return startSpan(ctx, spanContentGet, spanContentGet.name, attributes...)
}

// reading starts the span of another read of a resource: its graph, its
// annotations or its anchored text.
func reading(ctx context.Context, row telemetrySpan, resource api.ResourceId) (context.Context, trace.Span) {
	return startSpan(ctx, row, row.name, keyResourceID.String(resource.String()))
}
