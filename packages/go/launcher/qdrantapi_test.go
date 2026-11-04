package launcher

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// What a Qdrant that refused a request said is reported from the error its
// envelope states, from the plain text it refuses a key in, or as its status
// alone when it says nothing.
func TestAQdrantRefusalIsReportedAsItSaidIt(t *testing.T) {
	for _, c := range []struct {
		why, status, body, want string
	}{
		{"in its envelope", "404 Not Found", `{"status":{"error":"Not found: Collection ` + "`x`" + ` doesn't exist!"},"time":0}`, "404 Not Found: Not found: Collection `x` doesn't exist!"},
		{"in plain text", "401 Unauthorized", "Invalid API key or JWT\n", "401 Unauthorized: Invalid API key or JWT"},
		{"nothing", "401 Unauthorized", "", "401 Unauthorized"},
	} {
		t.Run(c.why, func(t *testing.T) {
			resp := &http.Response{Status: c.status, Body: io.NopCloser(strings.NewReader(c.body))}
			if got := qdrantRefusal(resp); got != c.want {
				t.Errorf("reported %q, want %q", got, c.want)
			}
		})
	}
}
