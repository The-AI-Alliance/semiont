package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A person's DID has one rule in three languages: @semiont/core's userToDid,
// the Rust gateway's person_did, and this. specs/src/principals/cases.json
// holds all three to the same cases.
func TestPersonDIDAgreesWithTheSpec(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "principals", "cases.json"))
	if err != nil {
		t.Fatalf("reading the spec: %v", err)
	}
	var spec struct {
		People []struct{ Why, Domain, Subject, Did string } `json:"people"`
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatalf("parsing the spec: %v", err)
	}
	if len(spec.People) == 0 {
		t.Fatal("the spec lists no people: a gate that compares nothing passes on silence")
	}
	for _, c := range spec.People {
		if got := personDID(c.Domain, c.Subject); got != c.Did {
			t.Errorf("%s: personDID(%q, %q) = %q, want %q", c.Why, c.Domain, c.Subject, got, c.Did)
		}
	}
}
