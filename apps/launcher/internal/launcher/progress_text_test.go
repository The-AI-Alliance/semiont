package launcher

// The English progress map's completeness census — WIRE-UNION-DISCRIMINANTS
// P5b. `progressText` has a `default: ""` that degrades SILENTLY on an
// unknown code, so nothing but this census notices when a new code lands in
// `JobProgressMessage` without copy. The list below is deliberately frozen:
// adding a variant to the schema means adding copy to `progressText` AND a
// row here — the same acknowledgment-gate idiom as the TS side's
// exhaustive `never` switch in assist-progress-copy.

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
		`{"code":"complete-created","count":4,"kind":"reference"}`,
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
