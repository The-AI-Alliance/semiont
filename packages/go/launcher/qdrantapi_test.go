package launcher

import (
	"io"
	"net/http"
	"net/http/httptest"
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

// Something at a Qdrant's port that takes its key but answers no list of
// collections is not taken for a Qdrant that holds none.
func TestAnAnswerThatIsNoListOfCollectionsIsRefused(t *testing.T) {
	notQdrant := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "<html>a dashboard</html>")
	}))
	defer notQdrant.Close()
	names, err := qdrantCollections(notQdrant.URL, "the-key")
	if err == nil || !strings.Contains(err.Error(), "it answered no list of collections") {
		t.Errorf("an answer that is no list of collections read as %q (%v)", names, err)
	}
}
