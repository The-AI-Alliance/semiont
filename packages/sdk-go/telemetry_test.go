package semiont

// What the conformance suite's telemetry case cannot see: the trace a frame
// brings, taken off its payload, and the trace the work done for it
// continues, with no provider installed. The spans and the count are the
// suite's to hold, from what a driver exports.

import (
	"context"
	"encoding/json"
	"testing"

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

func TestWorkContinuingATraceIsInThatTrace(t *testing.T) {
	sent := TraceContext{Traceparent: aTraceparent, Tracestate: aTracestate}
	if got := activeTrace(Continuing(context.Background(), sent)); got != sent {
		t.Fatalf("work continuing %+v is in %+v", sent, got)
	}
	if got := activeTrace(Continuing(context.Background(), TraceContext{})); !got.IsZero() {
		t.Fatalf("work continuing no trace is in %+v", got)
	}
}

func TestWithNoProviderAFrameIsContinuedInTheTraceItBrought(t *testing.T) {
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
