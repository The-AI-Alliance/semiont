package semiont

// What the conformance suite's telemetry case cannot see: the trace a frame
// brings, taken off its payload, and the trace the work done for it
// continues, with no provider installed, and with and without a propagator.
// The spans and the count are the suite's to hold, from what a driver exports.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const (
	aTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	aTracestate  = "congo=t61rcWkgMzE"
)

func TestAFrameWithNoTraceKeepsItsPayloadAsItCame(t *testing.T) {
	payload := json.RawMessage(`{"annotationId":"a-1","note":{"_trace":"inside a value, not the frame's"}}`)
	rest, sentUnder, ok := withoutTrace(payload)
	if !ok || string(rest) != string(payload) || !sentUnder.IsZero() {
		t.Fatalf("got %s, %+v, %v: a payload with no trace of its own is the frame's as it came", rest, sentUnder, ok)
	}
}

func TestAFramesTraceIsTakenOffItsPayload(t *testing.T) {
	payload := json.RawMessage(`{"annotationId":"a-1","_trace":{"traceparent":"` + aTraceparent + `","tracestate":"` + aTracestate + `"}}`)
	rest, sentUnder, ok := withoutTrace(payload)
	if !ok {
		t.Fatal("a payload with a trace is a frame's")
	}
	if string(rest) != `{"annotationId":"a-1"}` {
		t.Fatalf("the payload delivered is %s: it carries the trace still, or lost a field", rest)
	}
	if sentUnder != (TraceContext{Traceparent: aTraceparent, Tracestate: aTracestate}) {
		t.Fatalf("the trace read is %+v", sentUnder)
	}
}

func TestATraceWithNoTraceparentIsNoTraceAndIsStillTakenOff(t *testing.T) {
	rest, sentUnder, ok := withoutTrace(json.RawMessage(`{"annotationId":"a-1","_trace":{"tracestate":"` + aTracestate + `"}}`))
	if !ok || string(rest) != `{"annotationId":"a-1"}` || !sentUnder.IsZero() {
		t.Fatalf("got %s, %+v, %v", rest, sentUnder, ok)
	}
}

// propagating installs propagator as the process's for the test, as an
// application installs its OpenTelemetry, and leaves none installed after.
func propagating(t *testing.T, propagator propagation.TextMapPropagator) {
	t.Helper()
	otel.SetTextMapPropagator(propagator)
	t.Cleanup(func() { otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator()) })
}

func TestWorkContinuingATraceIsInThatTrace(t *testing.T) {
	propagating(t, propagation.TraceContext{})
	sent := TraceContext{Traceparent: aTraceparent, Tracestate: aTracestate}
	if got := activeTrace(Continuing(context.Background(), sent)); got != sent {
		t.Fatalf("work continuing %+v is in %+v", sent, got)
	}
	if got := activeTrace(Continuing(context.Background(), TraceContext{})); !got.IsZero() {
		t.Fatalf("work continuing no trace is in %+v", got)
	}
	header := http.Header{}
	carryTrace(Continuing(context.Background(), sent), header)
	if header.Get("traceparent") != aTraceparent {
		t.Errorf("a request made in a trace carries %q", header.Get("traceparent"))
	}
}

// Which propagator carries a trace is the application's to say: with none
// installed, no trace travels, and a frame keeps the one it brought.
func TestWithNoPropagatorNoTraceTravels(t *testing.T) {
	propagating(t, propagation.NewCompositeTextMapPropagator())
	sent := TraceContext{Traceparent: aTraceparent, Tracestate: aTracestate}
	if got := activeTrace(Continuing(context.Background(), sent)); !got.IsZero() {
		t.Errorf("with no propagator, work continuing a trace is in %+v", got)
	}
	// Work that is in a trace, however it came to be: still none travels.
	traceID, _ := trace.TraceIDFromHex("0af7651916cd43dd8448eb211c80319c")
	spanID, _ := trace.SpanIDFromHex("b7ad6b7169203331")
	inTrace := trace.ContextWithRemoteSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled, Remote: true,
	}))
	if got := activeTrace(inTrace); !got.IsZero() {
		t.Errorf("with no propagator, work in a trace says it is in %+v", got)
	}
	header := http.Header{}
	carryTrace(inTrace, header)
	if len(header) != 0 {
		t.Errorf("with no propagator, a request made in a trace carries %v", header)
	}
	if got := received(bus.Channel("beckon:focus"), api.ResourceId{}, sent); got != sent {
		t.Errorf("with no propagator, a frame sent under %+v is continued in %+v, not what it brought", sent, got)
	}
}

func TestWithNoProviderAFrameIsContinuedInTheTraceItBrought(t *testing.T) {
	propagating(t, propagation.TraceContext{})
	scope, err := api.ParseResourceId("r-1")
	if err != nil {
		t.Fatal(err)
	}
	sent := TraceContext{Traceparent: aTraceparent, Tracestate: aTracestate}
	if got := received(bus.Channel("beckon:focus"), scope, sent); got != sent {
		t.Fatalf("a frame sent under %+v is continued in %+v", sent, got)
	}
	if got := received(bus.Channel("beckon:focus"), api.ResourceId{}, TraceContext{}); !got.IsZero() {
		t.Fatalf("a frame sent under no trace is continued in %+v", got)
	}
}
