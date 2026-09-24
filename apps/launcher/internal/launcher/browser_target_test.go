package launcher

// BROWSER-HANDOFF P1–P3, in process.
//
// The subject is the COLD case: `browse --browser` published a signal and
// nobody was there to receive it. What the launcher says next is the whole
// user-facing feature (D6/O1 — it never opens a window), so these tests assert
// the message and the exit code, not just the branch taken.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// liveOrigin is a Browser that answers — enough for probeHealth, which asks
// only whether the origin responds.

// deadOrigin is an address nothing listens on: bind a port, learn its number,
// release it. Picking a number by hand is how a test starts passing for the
// wrong reason on a machine that happens to run something there.
func TestBrowserTargetFallsBackToTheStableNameForAStaleID(t *testing.T) {
	shim := t.TempDir()
	// A docker that knows only `semiont-browser`, so a lookup by the stale
	// recorded ID fails exactly as the real one would.
	script := "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = semiont-browser ] && { echo running; exit 0; }; done\nexit 1\n"
	if err := os.WriteFile(filepath.Join(shim, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", shim)

	ss := &StackSet{Browser: &ServiceState{
		ID: "0000deadbeef", Runtime: "docker", Endpoint: harness.LiveOrigin(t),
	}}
	p := BrowserTarget(ss, "")
	if !p.Running {
		t.Errorf("Running = false for an endpoint that answers")
	}
	if p.State != "running" {
		t.Errorf("State = %q, want %q from the semiont-browser fallback", p.State, "running")
	}
}

// Precedence is flag → record → default, and the flag has to win or
// --browser-url could not name a Browser the record has never heard of.
func TestBrowserTargetPrefersTheOverrideOverTheRecord(t *testing.T) {
	harness.NoRuntimes(t)
	live := harness.LiveOrigin(t)
	ss := &StackSet{Browser: &ServiceState{Endpoint: harness.DeadOrigin(t)}}

	if p := BrowserTarget(ss, live); !p.Running || p.Endpoint != live {
		t.Errorf("override ignored: endpoint %q running %v, want %q true", p.Endpoint, p.Running, live)
	}
	if p := BrowserTarget(&StackSet{}, ""); p.Endpoint != "http://localhost:3000" {
		t.Errorf("no record, no flag: endpoint %q, want the default", p.Endpoint)
	}
}

// ── the gateway's probe goes through the SDK ────────────────────────────

// The gateway is the one role in the status table with a generated client,
// and its probe must use it — that is the whole of "the launcher does not
// touch the wire". Asserted by watching the ROUTE: the generic prober fetches
// the recorded endpoint verbatim, the SDK asks its own /api/health.
func TestRoleHealthyProbesTheGatewayThroughTheSDK(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy"}`))
	}))
	defer srv.Close()

	if !roleHealthy("gateway", srv.URL+"/api/health") {
		t.Error("a serving gateway must read healthy")
	}
	// A sidecar serves /health and has no client of its own; it keeps the
	// generic prober, and the recorded path must survive untouched.
	if !roleHealthy("worker", srv.URL+"/health") {
		t.Error("a serving sidecar must read healthy")
	}
	want := []string{"/api/health", "/health"}
	if len(paths) != 2 || paths[0] != want[0] || paths[1] != want[1] {
		t.Errorf("probed %v, want %v", paths, want)
	}
}

func TestRoleHealthyReportsADeadGateway(t *testing.T) {
	if roleHealthy("gateway", harness.DeadOrigin(t)+"/api/health") {
		t.Error("an unreachable gateway must not read healthy")
	}
	// A gateway record that is not the health route falls back rather than
	// guessing at an origin it cannot derive.
	if roleHealthy("gateway", harness.DeadOrigin(t)) {
		t.Error("an unreachable gateway must not read healthy on the fallback path either")
	}
}

// ── P2: what it says when nobody was there ──────────────────────────────
