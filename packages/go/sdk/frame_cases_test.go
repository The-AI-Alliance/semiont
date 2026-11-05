package semiont

// What a stream's reader takes for a frame, held to
// protocol/specs/src/bus/frame-cases.json: the table every SDK's stream reader runs.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

type frameCase struct {
	Why     string          `json:"why"`
	Frame   json.RawMessage `json:"frame"`
	Refused bool            `json:"refused"`
	Member  string          `json:"member"`
	Reason  required.Reason `json:"reason"`
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

func TestEachFrameOfTheTableIsDeliveredAsItStatesOrRefused(t *testing.T) {
	for _, c := range readFrameCases(t) {
		frame, fault, ok := carried(string(c.Frame))
		if c.Refused {
			if want := (required.Fault{Member: c.Member, Reason: c.Reason}); ok || fault != want {
				t.Errorf("%s: read as %+v, or refused for %+v, and the table says it is refused for %+v", c.Why, frame, fault, want)
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
