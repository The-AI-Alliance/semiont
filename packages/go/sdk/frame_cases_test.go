package semiont

// What a stream's reader takes for a frame, held to
// protocol/specs/src/bus/frame-cases.json: the table every SDK's stream reader runs.
//
// Each case's line is carried by a stream, and after it a frame of
// beckon:focus that is read cleanly, so the stream is seen to go on past it.
// What the transport delivers, what a typed read of beckon:focus is given,
// and what the failure report is told are each held to the case.

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

type frameCase struct {
	Why   string          `json:"why"`
	Frame json.RawMessage `json:"frame"`
	// Data is the line of a case that is no JSON, in place of a frame.
	Data    string          `json:"data"`
	Refused bool            `json:"refused"`
	Member  string          `json:"member"`
	Reason  required.Reason `json:"reason"`
	Told    string          `json:"told"`
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

// after is the frame each case's line is followed by.
const after = `{"channel":"beckon:focus","payload":{"resourceId":"after"}}`

func isAfter(t *testing.T, frame Frame) bool {
	return frame.Channel == bus.BeckonFocus.Channel() && sameJSON(t, string(frame.Payload), `{"resourceId":"after"}`)
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
	nextFrame, stopFrames := iter.Pull(raw)
	defer stopFrames()
	focused, err := Frames(reading, NewWire(transport), bus.BeckonFocus)
	if err != nil {
		t.Fatal(err)
	}
	nextFocus, stopFocus := iter.Pull2(focused)
	defer stopFocus()
	until(t, "the stream to open", func() bool { return transport.State().Value() == ConnectionStateOpen })

	for at, c := range readFrameCases(t) {
		gateway.sendData(fmt.Sprintf("line-%d", at), c.line())
		gateway.sendData(fmt.Sprintf("after-%d", at), after)

		var delivered []Frame
		for {
			frame, ok := nextFrame()
			if !ok {
				t.Fatalf("%s: the transport's frames ended", c.Why)
			}
			if isAfter(t, frame) {
				break
			}
			delivered = append(delivered, frame)
		}
		var refusals []error
		for {
			focus, err, ok := nextFocus()
			if !ok {
				t.Fatalf("%s: the typed read of beckon:focus ended", c.Why)
			}
			if err == nil && focus.Payload.ResourceId.String() == "after" {
				break
			}
			if err != nil {
				refusals = append(refusals, err)
			}
		}
		failures, _ := told.drain()
		var reported []string
		for _, failure := range failures {
			_, stated := failure.Status()
			reported = append(reported, fmt.Sprintf("%s %v %s", failure.Code, stated, failure.Message))
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
			if len(refusals) != 0 || len(reported) != 0 {
				t.Errorf("%s: a frame delivered is refused to its reader as %v, or told to the failure report as %v", c.Why, refusals, reported)
			}
			continue
		}

		fault := required.Fault{Member: c.Member, Reason: c.Reason}
		switch c.Told {
		case "readers":
			var named struct {
				Channel bus.Channel `json:"channel"`
			}
			if err := json.Unmarshal(c.Frame, &named); err != nil {
				t.Fatal(err)
			}
			if named.Channel != bus.BeckonFocus.Channel() {
				t.Fatalf("%s: the case is told to the readers of %s, and this runner reads beckon:focus", c.Why, named.Channel)
			}
			want := "a frame on beckon:focus is not that channel's: " + fault.String()
			if len(refusals) != 1 || refusals[0].Error() != want {
				t.Errorf("%s: its reader is given %v, and the table says it is given one refusal, %q", c.Why, refusals, want)
			}
			if len(reported) != 0 {
				t.Errorf("%s: told to the failure report as %v, and the table says it is told to its readers", c.Why, reported)
			}
		case "failure-report":
			want := fmt.Sprintf("%s false the stream carried what is not a frame: %s", TransportErrorCodeError, fault)
			if len(reported) != 1 || reported[0] != want {
				t.Errorf("%s: the failure report is told %v, and the table says it is told %q", c.Why, reported, want)
			}
			if len(refusals) != 0 {
				t.Errorf("%s: the reader of beckon:focus is given %v, and the table says the frame names no reader", c.Why, refusals)
			}
		default:
			t.Fatalf("%s: told to whom the table does not give: %q", c.Why, c.Told)
		}
	}
}
