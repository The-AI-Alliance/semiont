package api_test

import (
	"encoding/json"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// A timestamp read and written again is the text the gateway sent: a client
// that passes a value on passes the value it was given (the wire case
// content-read reads an annotation's `created` back unchanged).
func TestATimestampIsWrittenBackAsTheWireCarriedIt(t *testing.T) {
	sent := `{"annotations":[{"@context":"http://www.w3.org/ns/anno.jsonld","created":"2026-01-01T00:00:00.000Z","id":"a-1","motivation":"highlighting","target":{"source":"r-1"},"type":"Annotation"}],"total":1}`
	var read api.GetAnnotationsResponse
	if err := json.Unmarshal([]byte(sent), &read); err != nil {
		t.Fatal(err)
	}
	written, err := json.Marshal(read.Annotations[0])
	if err != nil {
		t.Fatal(err)
	}
	var back struct {
		Created string `json:"created"`
	}
	if err := json.Unmarshal(written, &back); err != nil {
		t.Fatal(err)
	}
	if back.Created != "2026-01-01T00:00:00.000Z" {
		t.Errorf("created was sent as 2026-01-01T00:00:00.000Z and written back as %s", back.Created)
	}
}
