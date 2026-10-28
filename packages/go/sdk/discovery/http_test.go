package discovery_test

// The launcher's document over HTTP.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/discovery"
)

// served is the discovery document a launcher stand-in serves: its status,
// content type, body and tag, and how many times it was read.
type served struct {
	mu          sync.Mutex
	status      int
	contentType string
	body        string
	etag        string
	reads       int
}

func (s *served) serve(status int, contentType, body, etag string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status, s.contentType, s.body, s.etag = status, contentType, body, etag
}

func (s *served) timesRead() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reads
}

func (s *served) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	if s.etag != "" && r.Header.Get("If-None-Match") == s.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", s.contentType)
	if s.etag != "" {
		w.Header().Set("ETag", s.etag)
	}
	w.WriteHeader(s.status)
	_, _ = w.Write([]byte(s.body))
}

// launcher is a stand-in serving its document at /discovery/kbs.json, and a
// transport reading it there.
func launcher(t *testing.T) (*served, discovery.DiscoveryTransport) {
	t.Helper()
	document := &served{status: http.StatusNotFound, contentType: "text/plain"}
	routes := http.NewServeMux()
	routes.Handle("/discovery/kbs.json", document)
	server := httptest.NewServer(routes)
	t.Cleanup(server.Close)
	return document, discovery.HttpDiscovery(server.URL+"/discovery/kbs.json", server.Client())
}

func absentFor(read discovery.DiscoveryRead) (discovery.DiscoveryAbsentReason, bool) {
	absent, isAbsent := read.(discovery.Absent)
	return absent.Reason, isAbsent
}

func TestADocumentThatHasNotChangedIsNotReadAgain(t *testing.T) {
	document, reader := launcher(t)
	document.serve(http.StatusOK, "application/json", written(t, map[string]any{"version": 1, "kbs": []any{map[string]any{
		"host": "localhost", "port": 4000, "placement": "local",
		"managedBy": "semiont-launcher", "did": a,
	}}}), `"v1"`)
	ctx := context.Background()

	read := reader.Read(ctx)
	if managed, isManaged := read.(discovery.Managed); !isManaged || len(managed.KBs) != 1 {
		t.Fatalf("a managed state of one was expected, not %#v", read)
	}
	if got := reader.Read(ctx); got != (discovery.Unchanged{}) {
		t.Fatalf("read %#v", got)
	}

	// A new document has a new tag, and is read.
	document.serve(http.StatusOK, "application/json; charset=utf-8", written(t, map[string]any{"version": 1, "kbs": []any{}}), `"v2"`)
	if got, want := reader.Read(ctx), (discovery.Managed{KBs: []api.DiscoveredKB{}}); !reflect.DeepEqual(got, want) {
		t.Errorf("read %#v, not %#v", got, want)
	}
	if reads := document.timesRead(); reads != 3 {
		t.Errorf("read %d times", reads)
	}
}

func TestWhatIsNotADocumentAtTheAddressIsAbsent(t *testing.T) {
	document, reader := launcher(t)
	ctx := context.Background()
	absentAs := func(expected discovery.DiscoveryAbsentReason, why string) {
		t.Helper()
		if got, isAbsent := absentFor(reader.Read(ctx)); !isAbsent || got != expected {
			t.Errorf("%s: not absent as %s", why, expected)
		}
	}

	// A server that answers every path with its own page.
	document.serve(http.StatusOK, "text/html", "<!doctype html>", `"page"`)
	absentAs(discovery.NotFound, "a page")
	// Its tag was not kept: it is not believed the next time.
	absentAs(discovery.NotFound, "the page again")

	document.serve(http.StatusNotFound, "text/plain", "", "")
	absentAs(discovery.NotFound, "nothing there")

	document.serve(http.StatusOK, "application/json", "{", `"bad"`)
	absentAs(discovery.NotJSON, "a document that is not JSON")
	document.serve(http.StatusOK, "application/json", "{", `"bad"`)
	absentAs(discovery.NotJSON, "the document that is not JSON again")

	nowhere := discovery.HttpDiscovery("http://127.0.0.1:9/discovery/kbs.json", &http.Client{})
	if got, isAbsent := absentFor(nowhere.Read(ctx)); !isAbsent || got != discovery.Unreadable {
		t.Errorf("a launcher that is not there read as %#v", got)
	}
}

// neverAnswers is a round trip that is never answered: it ends only when its
// request does.
type neverAnswers struct{}

func (neverAnswers) RoundTrip(request *http.Request) (*http.Response, error) {
	<-request.Context().Done()
	return nil, request.Context().Err()
}

func TestALaunchersDocumentThatIsNeverServedIsUnreadableAtTheDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		reader := discovery.HttpDiscovery("http://launcher.test/discovery/kbs.json", &http.Client{Transport: neverAnswers{}})
		started := time.Now()

		read := reader.Read(context.Background())

		deadline := semiont.DefaultTiming().HttpRequestTimeout
		if took := time.Since(started); took < deadline || took >= deadline+2*time.Second {
			t.Errorf("took %s", took)
		}
		if want := (discovery.Absent{Reason: discovery.Unreadable, Diagnostic: "the document was not served within 30s"}); read != want {
			t.Errorf("read %#v, not %#v", read, want)
		}
	})
}
