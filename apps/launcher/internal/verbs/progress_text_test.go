package verbs

// The English progress map's completeness census. `JobProgressMessage` is a
// union discriminated on a single-valued `code`, which is what lets a map be
// checked against it. `progressText` has a `default: ""` that degrades
// SILENTLY on an unknown code, so nothing but this census notices when a new
// code lands in `JobProgressMessage` without copy. The list below is
// deliberately frozen: adding a variant to the schema means adding copy to
// `progressText` AND a row here — the same acknowledgment-gate idiom as the
// exhaustive `never` switch react-ui words the same codes with.

import (
	"encoding/json"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

func TestProgressTextCoversEveryCode(t *testing.T) {
	// One wire-faithful payload per discriminator value, params included.
	payloads := []string{
		`{"code":"loading"}`,
		`{"code":"analyzing"}`,
		`{"code":"analyzing-tags"}`,
		`{"code":"generating-resource"}`,
		`{"code":"creating-resource"}`,
		`{"code":"complete-generated","truncated":false}`,
		`{"code":"detecting-entities","entityType":"Person"}`,
		`{"code":"creating-annotations","count":3}`,
		`{"code":"creating-tag-annotations","count":2}`,
		`{"code":"complete-created","count":4,"motivation":"linking"}`,
	}
	for _, raw := range payloads {
		var m semiont.JobProgressMessage
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatalf("unmarshal %s: %v", raw, err)
		}
		if got := progressText(&m); got == "" {
			t.Errorf("progressText has no copy for %s — the silent default fired", raw)
		}
	}
}

// What a mark job created is worded from its motivation. One this launcher has
// no noun for, as a newer stack's may be, prints nothing, as a code it does
// not know does: a count with no noun says nothing.
func TestProgressTextSaysNothingOfAMotivationWithNoNoun(t *testing.T) {
	var m semiont.JobProgressMessage
	if err := json.Unmarshal([]byte(`{"code":"complete-created","count":2,"motivation":"bookmarking"}`), &m); err != nil {
		t.Fatal(err)
	}
	if got := progressText(&m); got != "" {
		t.Errorf("a motivation with no noun is worded %q", got)
	}
}
