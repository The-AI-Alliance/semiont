package verbs

// browse_browser_test.go — `semiont browse --browser`, split out of the
// launcher's browser_target_test.go when the verbs moved (P1). That file had
// become two subjects under one name: BrowserTarget and roleHealthy, which are
// the launcher's, and these, which drive the Browse verb.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"
)

func recordBrowserFixture(t *testing.T, b *launcher.ServiceState) {
	t.Helper()
	path := filepath.Join(launcher.StateDir(), "stack.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var ss launcher.StackSet
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
			origin:  harness.LiveOrigin,
			want:    []string{"Nobody saw res-42", "no web browser is watching", "log in"},
			notWant: []string{"--launch"},
		},
		{
			// Row 3: there is nothing to open, so naming the origin would send
			// the user to a refused connection. Name the commands instead.
			name:    "no Browser at all",
			origin:  harness.DeadOrigin,
			want:    []string{"Nobody saw res-42", "No Browser is running", "--launch", "semiont start --service browser"},
			notWant: []string{"log in"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			harness.NoRuntimes(t)
			fake.Subscribers = 0

			out, errOut := harness.CaptureOutput(t, func() {
				if code := Browse([]string{"res-42", "--browser", "--browser-url", c.origin(t)}); code != 1 {
					t.Errorf("exit %d, want 1 — a tour script must be able to stop here", code)
				}
			})
			all := out + errOut
			harness.MustContainAll(t, "refusal", all, c.want...)
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
	recordBrowserFixture(t, &launcher.ServiceState{Runtime: "docker", Endpoint: harness.DeadOrigin(t)})

	out, errOut := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"res-42", "--browser"}); code != 1 {
			t.Errorf("exit %d, want 1", code)
		}
	})
	harness.MustContainAll(t, "stale container", out+errOut,
		"container is exited", "semiont start --service browser")
}

// A count of -1 means the server did not tell us. That is not an empty room,
// and treating it as one would fail every tour step against a gateway too old
// to report the count.
func TestBrowseBrowserDoesNotRefuseOnAnUnknownCount(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Subscribers = -1

	out := harness.CaptureStdout(t, func() {
		if code := Browse([]string{"res-42", "--browser"}); code != 0 {
			t.Fatalf("an unknown count must not fail the command: exit %d", code)
		}
	})
	harness.MustContainAll(t, "unknown count", out, "no delivery confirmation")
}

// ── P3: --launch is opt-in, and only means one thing ────────────────────

func TestBrowseLaunchAndBrowserURLRequireBrowser(t *testing.T) {
	for _, args := range [][]string{
		{"res-42", "--launch"},
		{"res-42", "--browser-url", "http://localhost:3000"},
	} {
		fake, restore := withFake(t)
		out, errOut := harness.CaptureOutput(t, func() {
			if code := Browse(args); code == 0 {
				t.Errorf("%v must refuse", args)
			}
		})
		harness.MustContainAll(t, "refusal", out+errOut, "only applies with --browser")
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
	harness.NoRuntimes(t)
	fake.Subscribers = 0

	_, errOut := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"res-42", "--browser", "--browser-url", harness.DeadOrigin(t)}); code != 1 {
			t.Errorf("exit %d, want 1", code)
		}
	})
	if strings.Contains(errOut, "No container runtime found") {
		t.Error("browse --browser tried to start the Browser without --launch")
	}
}
