package launcher

// BROWSER-HANDOFF P1–P3, in process.
//
// The subject is the COLD case: `browse --browser` published a signal and
// nobody was there to receive it. What the launcher says next is the whole
// user-facing feature (D6/O1 — it never opens a window), so these tests assert
// the message and the exit code, not just the branch taken.

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// liveOrigin is a Browser that answers — enough for probeHealth, which asks
// only whether the origin responds.
func liveOrigin(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// deadOrigin is an address nothing listens on: bind a port, learn its number,
// release it. Picking a number by hand is how a test starts passing for the
// wrong reason on a machine that happens to run something there.
func deadOrigin(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return "http://" + addr
}

// noRuntimes empties PATH so installedRuntimes() finds nothing — the "no
// Browser container anywhere" half of the absent case, without depending on
// what the developer's machine has installed.
func noRuntimes(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
}

// recordBrowserFixture writes a Browser record into the fixture's stack.json,
// which is what browserTarget reads when no --browser-url overrides it.
func recordBrowserFixture(t *testing.T, b *serviceState) {
	t.Helper()
	path := filepath.Join(stateDir(), "stack.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var ss stackSet
	if err := json.Unmarshal(raw, &ss); err != nil {
		t.Fatal(err)
	}
	ss.Browser = b
	out, _ := json.MarshalIndent(&ss, "", "  ")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
}

// ── P1: the probe ───────────────────────────────────────────────────────

// The case the stable-name fallback exists for: the record carries a container
// ID that no longer resolves, while the endpoint is plainly live. Before the
// fallback, status printed "absent" beside a ✓.
func TestBrowserTargetFallsBackToTheStableNameForAStaleID(t *testing.T) {
	shim := t.TempDir()
	// A docker that knows only `semiont-browser`, so a lookup by the stale
	// recorded ID fails exactly as the real one would.
	script := "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = semiont-browser ] && { echo running; exit 0; }; done\nexit 1\n"
	if err := os.WriteFile(filepath.Join(shim, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", shim)

	ss := &stackSet{Browser: &serviceState{
		ID: "0000deadbeef", Runtime: "docker", Endpoint: liveOrigin(t),
	}}
	p := browserTarget(ss, "")
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
	noRuntimes(t)
	live := liveOrigin(t)
	ss := &stackSet{Browser: &serviceState{Endpoint: deadOrigin(t)}}

	if p := browserTarget(ss, live); !p.Running || p.Endpoint != live {
		t.Errorf("override ignored: endpoint %q running %v, want %q true", p.Endpoint, p.Running, live)
	}
	if p := browserTarget(&stackSet{}, ""); p.Endpoint != "http://localhost:3000" {
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
	if roleHealthy("gateway", deadOrigin(t)+"/api/health") {
		t.Error("an unreachable gateway must not read healthy")
	}
	// A gateway record that is not the health route falls back rather than
	// guessing at an origin it cannot derive.
	if roleHealthy("gateway", deadOrigin(t)) {
		t.Error("an unreachable gateway must not read healthy on the fallback path either")
	}
}

// ── P2: what it says when nobody was there ──────────────────────────────

func TestBrowseBrowserRefusesWhenNoOneIsWatching(t *testing.T) {
	for _, c := range []struct {
		name    string
		origin  func(*testing.T) string
		want    []string
		notWant []string
	}{
		{
			// Row 2: the container is up, so the origin is the useful thing to
			// print — someone has to point a web browser at it and log in.
			name:    "Browser running, nobody watching",
			origin:  liveOrigin,
			want:    []string{"Nobody saw res-42", "no web browser is watching", "log in"},
			notWant: []string{"--launch"},
		},
		{
			// Row 3: there is nothing to open, so naming the origin would send
			// the user to a refused connection. Name the commands instead.
			name:    "no Browser at all",
			origin:  deadOrigin,
			want:    []string{"Nobody saw res-42", "No Browser is running", "--launch", "semiont start --service browser"},
			notWant: []string{"log in"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			noRuntimes(t)
			fake.Subscribers = 0

			out, errOut := captureOutput(t, func() {
				if code := Browse([]string{"res-42", "--browser", "--browser-url", c.origin(t)}); code != 1 {
					t.Errorf("exit %d, want 1 — a tour script must be able to stop here", code)
				}
			})
			all := out + errOut
			mustContainAll(t, "refusal", all, c.want...)
			for _, n := range c.notWant {
				if strings.Contains(all, n) {
					t.Errorf("refusal should not mention %q; full text:\n%s", n, all)
				}
			}
			// The signal still went out. Publishing to an empty room is not an
			// error, and suppressing the emit would make the count unknowable.
			if len(fake.Emits) != 1 {
				t.Errorf("want the emit to have happened anyway, got %v", fake.Emits)
			}
		})
	}
}

// A container that exists but does not answer is neither row: saying "no
// Browser is running" would be false, and offering its origin would be
// useless. It gets its own sentence and the same two fix-its.
func TestBrowseBrowserNamesAContainerThatIsNotAnswering(t *testing.T) {
	shim := t.TempDir()
	if err := os.WriteFile(filepath.Join(shim, "docker"), []byte("#!/bin/sh\necho exited\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	fake, restore := withFake(t)
	defer restore()
	t.Setenv("PATH", shim)
	fake.Subscribers = 0
	recordBrowserFixture(t, &serviceState{Runtime: "docker", Endpoint: deadOrigin(t)})

	out, errOut := captureOutput(t, func() {
		if code := Browse([]string{"res-42", "--browser"}); code != 1 {
			t.Errorf("exit %d, want 1", code)
		}
	})
	mustContainAll(t, "stale container", out+errOut,
		"container is exited", "semiont start --service browser")
}

// A count of -1 means the server did not tell us. That is not an empty room,
// and treating it as one would fail every tour step against a gateway too old
// to report the count.
func TestBrowseBrowserDoesNotRefuseOnAnUnknownCount(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Subscribers = -1

	out := captureStdout(t, func() {
		if code := Browse([]string{"res-42", "--browser"}); code != 0 {
			t.Fatalf("an unknown count must not fail the command: exit %d", code)
		}
	})
	mustContainAll(t, "unknown count", out, "no delivery confirmation")
}

// ── P3: --launch is opt-in, and only means one thing ────────────────────

func TestBrowseLaunchAndBrowserURLRequireBrowser(t *testing.T) {
	for _, args := range [][]string{
		{"res-42", "--launch"},
		{"res-42", "--browser-url", "http://localhost:3000"},
	} {
		fake, restore := withFake(t)
		out, errOut := captureOutput(t, func() {
			if code := Browse(args); code == 0 {
				t.Errorf("%v must refuse", args)
			}
		})
		mustContainAll(t, "refusal", out+errOut, "only applies with --browser")
		if len(fake.Emits) != 0 || len(fake.Requests) != 0 {
			t.Errorf("%v still reached the wire: %v %v", args, fake.Emits, fake.Ops())
		}
		restore()
	}
}

// Without --launch the launcher must not start anything — D4: a read verb's
// flag does not get to bring a container up as a side effect. An empty PATH
// makes any attempt fail loudly rather than silently succeeding on a machine
// that has a runtime installed.
func TestBrowseBrowserDoesNotStartTheBrowserUnasked(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	noRuntimes(t)
	fake.Subscribers = 0

	_, errOut := captureOutput(t, func() {
		if code := Browse([]string{"res-42", "--browser", "--browser-url", deadOrigin(t)}); code != 1 {
			t.Errorf("exit %d, want 1", code)
		}
	})
	if strings.Contains(errOut, "No container runtime found") {
		t.Error("browse --browser tried to start the Browser without --launch")
	}
}
