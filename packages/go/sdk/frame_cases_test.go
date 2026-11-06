package semiont

// What a stream's reader takes for a frame, held to
// protocol/specs/src/bus/frame-cases.json: the table every SDK's stream reader runs.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

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

func TestEachFrameOfTheTableIsDeliveredAsItStatesOrRefusedAndToldToWhomItStates(t *testing.T) {
	for _, c := range readFrameCases(t) {
		frame, refused, ok := carried(c.line())
		if c.Refused {
			want := refusedFrame{fault: required.Fault{Member: c.Member, Reason: c.Reason}}
			switch c.Told {
			case "readers":
				var named struct {
					Channel bus.Channel `json:"channel"`
				}
				if err := json.Unmarshal(c.Frame, &named); err != nil {
					t.Fatal(err)
				}
				want.channel = named.Channel
			case "failure-report":
			default:
				t.Fatalf("%s: told to whom the table does not give: %q", c.Why, c.Told)
			}
			if ok || refused != want {
				t.Errorf("%s: read as %+v, or refused as %+v, and the table says it is refused as %+v", c.Why, frame, refused, want)
			}
			continue
		}
		if !ok {
			t.Errorf("%s: refused, and the table says it is delivered", c.Why)
			continue
		}
		var stated struct {
			Channel       string          `json:"channel"`
			CorrelationID string          `json:"correlationId"`
			Payload       json.RawMessage `json:"payload"`
			Scope         string          `json:"scope"`
		}
		if err := json.Unmarshal(c.Frame, &stated); err != nil {
			t.Fatal(err)
		}
		if string(frame.Channel) != stated.Channel || frame.CorrelationID != stated.CorrelationID || frame.Scope.String() != stated.Scope || !sameJSON(t, string(frame.Payload), string(stated.Payload)) {
			t.Errorf("%s: read as %+v, and the table states %s", c.Why, frame, c.Frame)
		}
	}
}
