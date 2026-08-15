package semiont

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A healthy backend answers, and the parsed body comes back.
func TestHealthCheckReportsAServingBackend(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Errorf("asked for %q, want /api/health — the route is the generated client's to know", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy"}`))
	}))
	defer srv.Close()

	cli, err := NewHealthClient(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	got, err := cli.HealthCheck(context.Background())
	if err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	if got == nil {
		t.Fatal("a 2xx with a JSON body must parse")
	}
}

// A backend that answers with a failure status is DOWN, and says which status
// — a caller that only wanted liveness compares against nil, but one deciding
// whether to wait or abort needs the reason.
func TestHealthCheckFailsOnANonSuccessStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	cli, _ := NewHealthClient(srv.URL)
	if _, err := cli.HealthCheck(context.Background()); err == nil {
		t.Fatal("503 must be an error")
	}
}

// A 2xx that does not parse is still a LIVE service. Reporting it as down
// over a schema mismatch is the opposite of what a liveness check is for.
func TestHealthCheckTreatsAnUnparsableSuccessAsAlive(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`not json`))
	}))
	defer srv.Close()

	cli, _ := NewHealthClient(srv.URL)
	if _, err := cli.HealthCheck(context.Background()); err != nil {
		t.Fatalf("a 2xx is alive whatever the body says: %v", err)
	}
}

// The method imposes no budget of its own, so a caller's deadline is the only
// thing bounding it. A probe whose ctx expired must return rather than hang.
func TestHealthCheckHonoursTheContextDeadline(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer func() { close(block); srv.Close() }()

	cli, _ := NewHealthClient(srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := cli.HealthCheck(ctx); err == nil {
		t.Fatal("an expired context must surface as an error")
	}
}
