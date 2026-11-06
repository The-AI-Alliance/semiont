package semiont

// What a stream's reader takes for a frame, held to
// protocol/specs/src/bus/frame-cases.json: the table every SDK's stream reader runs.
//
// Each case's line is carried by a stream, and after it a frame of
// browse:resource-result and one of beckon:focus that are read cleanly, so
// the stream is seen to go on past it. What the transport delivers or
// refuses, what a typed read of beckon:focus and of browse:resource-result
// is given, what the failure report is told, and what becomes of a request
// awaiting the case's reply are each held to the case.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

type frameCase struct {
	Why   string          `json:"why"`
	Frame json.RawMessage `json:"frame"`
	// Data is the line of a case that is no JSON, in place of a frame.
	Data    string                 `json:"data"`
	Refused bool                   `json:"refused"`
	Member  string                 `json:"member"`
	Reason  bus.FrameRefusalReason `json:"reason"`
	Told    string                 `json:"told"`
	// CorrelationID is the correlation id the case's refusal carries; empty
	// when it carries none.
	CorrelationID string `json:"correlationId"`
	// Request is what becomes of a request awaiting the reply awaitedID
	// names on the frame's channel, `fails` or `waits`; empty for a case
	// that states no request.
	Request string `json:"request"`
}

// line is the data line the case's stream carries.
func (c frameCase) line() string {
	if c.Frame == nil {
		return c.Data
	}
	return string(c.Frame)
}

func readFrameCases(t *testing.T) []frameCase {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "specs", "src", "bus", "frame-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []frameCase `json:"cases"`
	}
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table was not read")
	}
	return table.Cases
}

// awaitedID is the correlation id a request's case names its request's by.
const awaitedID = "c-1"

// after is the frame each case's line is followed by, last.
const after = `{"channel":"beckon:focus","payload":{"resourceId":"after"}}`

// afterResult is the frame of browse:resource-result each case's line is
// followed by, before after.
const afterResult = `{"channel":"browse:resource-result","payload":{"response":{"resource":{"@context":"https://schema.org/","@id":"after","name":"after","representations":[]},"lastSequence":1}}}`

func isAfter(t *testing.T, frame Frame) bool {
	return frame.Channel == bus.BeckonFocus.Channel() && sameJSON(t, string(frame.Payload), `{"resourceId":"after"}`)
}

func isAfterResult(t *testing.T, frame Frame) bool {
	return frame.Channel == bus.BrowseResourceResult.Channel() && sameJSON(t, string(frame.Payload), `{"response":{"resource":{"@context":"https://schema.org/","@id":"after","name":"after","representations":[]},"lastSequence":1}}`)
}

// typedRefusals is what a typed read gives in place of frames until the
// frame it stops at: each error, and each must be a *FrameRefusal.
func typedRefusals[P any](t *testing.T, why string, next func() (Delivered[P], error, bool), stop func(Delivered[P]) bool) []*FrameRefusal {
	t.Helper()
	var refusals []*FrameRefusal
	for {
		read, err, ok := next()
		if !ok {
			t.Fatalf("%s: a typed read ended", why)
		}
		if err == nil {
			if stop(read) {
				return refusals
			}
			continue
		}
		var refusal *FrameRefusal
		if !errors.As(err, &refusal) {
			t.Fatalf("%s: a typed read gives %v in a frame's place, which is no *FrameRefusal", why, err)
		}
		refusals = append(refusals, refusal)
	}
}

// refusedAsStated is whether refusal is the case's refusal of a frame on
// channel whose payload is payload: on no scope, naming the member and
// reason it states, and carrying the correlation id it states.
func refusedAsStated(t *testing.T, c frameCase, channel bus.Channel, payload json.RawMessage, refusal *FrameRefusal) bool {
	samePayload := (refusal.Payload == nil) == (payload == nil) && (payload == nil || sameJSON(t, string(refusal.Payload), string(payload)))
	return refusal.Channel == channel && refusal.Member == c.Member && refusal.Reason == c.Reason && refusal.CorrelationID == c.CorrelationID && refusal.Scope.IsZero() && samePayload
}

func TestEachFrameOfTheTableIsDeliveredAsItStatesOrRefusedAndToldToWhomItStates(t *testing.T) {
	gateway := newRecordingGateway(t)
	transport := NewHTTPTransport(HTTPTransportConfig{
		BaseURL:  gateway.URL,
		Token:    NewVariable("t"),
		Channels: []bus.Channel{bus.BeckonFocus.Channel(), bus.BrowseResourceResult.Channel()},
		HTTP:     &http.Client{Transport: &http.Transport{}},
		Timing:   DefaultTiming(),
	})
	defer transport.Close()
	told := transport.shared.failures.b.listen()
	reading, stop := context.WithTimeout(context.Background(), time.Minute)
	defer stop()
	raw, err := transport.Frames(reading, bus.BeckonFocus.Channel(), bus.BrowseResourceResult.Channel())
	if err != nil {
		t.Fatal(err)
	}
	nextFrame, stopFrames := iter.Pull2(raw)
	defer stopFrames()
	focused, err := Frames(reading, NewWire(transport), bus.BeckonFocus)
	if err != nil {
		t.Fatal(err)
	}
	nextFocus, stopFocus := iter.Pull2(focused)
	defer stopFocus()
	results, err := Frames(reading, NewWire(transport), bus.BrowseResourceResult)
	if err != nil {
		t.Fatal(err)
	}
	nextResult, stopResults := iter.Pull2(results)
	defer stopResults()
	until(t, "the stream to open", func() bool { return transport.State().Value() == ConnectionStateOpen })

	for at, c := range readFrameCases(t) {
		var pending *PendingReply
		if c.Request != "" {
			pending = transport.TrackReply(awaitedID, bus.BrowseResourceRequested.Result().Channel(), bus.BrowseResourceRequested.Failure().Channel())
		}
		gateway.sendData(fmt.Sprintf("line-%d", at), c.line())
		gateway.sendData(fmt.Sprintf("after-result-%d", at), afterResult)
		gateway.sendData(fmt.Sprintf("after-%d", at), after)

		var delivered []Frame
		var refused []*FrameRefusal
		for {
			frame, err, ok := nextFrame()
			if !ok {
				t.Fatalf("%s: the transport's frames ended", c.Why)
			}
			if err != nil {
				refusal, isRefusal := err.(*FrameRefusal)
				if !isRefusal {
					t.Fatalf("%s: the transport gives %v in a frame's place, which is no *FrameRefusal", c.Why, err)
				}
				if frame.Channel != refusal.Channel || frame.Envelope != refusal.Envelope || frame.Payload != nil {
					t.Errorf("%s: the transport gives %+v beside its refusal, and not the channel and envelope it names", c.Why, frame)
				}
				refused = append(refused, refusal)
				continue
			}
			if isAfter(t, frame) {
				break
			}
			if isAfterResult(t, frame) {
				continue
			}
			delivered = append(delivered, frame)
		}
		readBy := map[bus.Channel][]*FrameRefusal{
			bus.BeckonFocus.Channel(): typedRefusals(t, c.Why, nextFocus, func(focus Delivered[api.BeckonFocusEvent]) bool {
				return focus.Payload.ResourceId.String() == "after"
			}),
			bus.BrowseResourceResult.Channel(): typedRefusals(t, c.Why, nextResult, func(result Delivered[api.BrowseResourceResult]) bool {
				return result.Payload.Response.Resource.Name == "after"
			}),
		}
		failures, _ := told.drain()
		var reported []string
		for _, failure := range failures {
			_, stated := failure.Status()
			reported = append(reported, fmt.Sprintf("%s %v %s", failure.Code, stated, failure.Message))
		}

		if pending != nil {
			var stated struct {
				Channel bus.Channel     `json:"channel"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(c.Frame, &stated); err != nil {
				t.Fatal(err)
			}
			switch c.Request {
			case "fails":
				select {
				case refusal := <-pending.Refused():
					if !refusedAsStated(t, c, stated.Channel, stated.Payload, refusal) {
						t.Errorf("%s: the request awaiting %s is told %+v, and the table states %s refused at %q, %s", c.Why, awaitedID, refusal, c.Frame, c.Member, c.Reason)
					}
				case reply := <-pending.Reply():
					t.Errorf("%s: the request awaiting %s is answered with %+v, and the table says it fails with the refusal", c.Why, awaitedID, reply)
				default:
					t.Errorf("%s: the request awaiting %s is told nothing, and the table says it fails with the refusal", c.Why, awaitedID)
				}
			case "waits":
				select {
				case refusal := <-pending.Refused():
					t.Errorf("%s: the request awaiting %s is told %+v, and the table says it goes on waiting", c.Why, awaitedID, refusal)
				case reply := <-pending.Reply():
					t.Errorf("%s: the request awaiting %s is answered with %+v, and the table says it goes on waiting", c.Why, awaitedID, reply)
				default:
				}
			default:
				t.Fatalf("%s: a request the table does not give: %q", c.Why, c.Request)
			}
			pending.Release()
		}

		if !c.Refused {
			var stated struct {
				Channel       string          `json:"channel"`
				CorrelationID string          `json:"correlationId"`
				Payload       json.RawMessage `json:"payload"`
				Scope         string          `json:"scope"`
			}
			if err := json.Unmarshal(c.Frame, &stated); err != nil {
				t.Fatal(err)
			}
			if len(delivered) != 1 {
				t.Errorf("%s: delivered %+v, and the table states one frame", c.Why, delivered)
			} else if frame := delivered[0]; string(frame.Channel) != stated.Channel || frame.CorrelationID != stated.CorrelationID || frame.Scope.String() != stated.Scope || !sameJSON(t, string(frame.Payload), string(stated.Payload)) {
				t.Errorf("%s: read as %+v, and the table states %s", c.Why, frame, c.Frame)
			}
			// The table states what its transport delivers, and a reply it delivers may not be its channel's by type: only beckon:focus's typed reader is held here.
			if refusals := readBy[bus.BeckonFocus.Channel()]; len(refused) != 0 || len(refusals) != 0 || len(reported) != 0 {
				t.Errorf("%s: a frame delivered is refused as %v, to the reader of beckon:focus as %v, or told to the failure report as %v", c.Why, refused, refusals, reported)
			}
			continue
		}

		fault := required.Fault{Member: c.Member, Reason: c.Reason}
		switch c.Told {
		case "readers":
			var stated struct {
				Channel bus.Channel     `json:"channel"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(c.Frame, &stated); err != nil {
				t.Fatal(err)
			}
			refusals, read := readBy[stated.Channel]
			if !read {
				t.Fatalf("%s: the case is told to the readers of %s, and this runner reads beckon:focus and browse:resource-result", c.Why, stated.Channel)
			}
			want := fmt.Sprintf("a frame on %s is not that channel's: %s", stated.Channel, fault)
			if len(refusals) != 1 || refusals[0].Error() != want || !refusedAsStated(t, c, stated.Channel, stated.Payload, refusals[0]) {
				t.Errorf("%s: its reader is given %+v, and the table says it is given one refusal, %q, carrying %q", c.Why, refusals, want, c.CorrelationID)
			}
			for channel, others := range readBy {
				if channel != stated.Channel && len(others) != 0 {
					t.Errorf("%s: the reader of %s is given %+v, and the frame is on %s", c.Why, channel, others, stated.Channel)
				}
			}
			if len(reported) != 0 {
				t.Errorf("%s: told to the failure report as %v, and the table says it is told to its readers", c.Why, reported)
			}
			// BusFrame takes any object for a payload: a fault within one is its channel's reader's to find, and the transport delivers the frame.
			if strings.HasPrefix(c.Member, "payload.") {
				if len(delivered) != 1 || len(refused) != 0 {
					t.Errorf("%s: the transport delivers %+v and refuses %+v, and BusFrame allows the frame", c.Why, delivered, refused)
				}
				continue
			}
			if len(delivered) != 0 || len(refused) != 1 {
				t.Errorf("%s: the transport delivers %+v and refuses %+v, and the table says it refuses the frame once", c.Why, delivered, refused)
				continue
			}
			if !refusedAsStated(t, c, stated.Channel, stated.Payload, refused[0]) {
				t.Errorf("%s: refused as %+v, and the table states %s refused at %q, %s, carrying %q", c.Why, refused[0], c.Frame, c.Member, c.Reason, c.CorrelationID)
			}
		case "failure-report":
			want := fmt.Sprintf("%s false the stream carried what is not a frame: %s", TransportErrorCodeError, fault)
			if len(reported) != 1 || reported[0] != want {
				t.Errorf("%s: the failure report is told %v, and the table says it is told %q", c.Why, reported, want)
			}
			if len(delivered) != 0 || len(refused) != 0 || len(readBy[bus.BeckonFocus.Channel()]) != 0 || len(readBy[bus.BrowseResourceResult.Channel()]) != 0 {
				t.Errorf("%s: delivered as %+v, refused as %+v, or given to a typed reader as %v, and the table says the frame names no reader", c.Why, delivered, refused, readBy)
			}
		default:
			t.Fatalf("%s: told to whom the table does not give: %q", c.Why, c.Told)
		}
	}
}
