package verbs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bustest"
)

// SDK-GO-TRANSPORT P1: a verb's wire behaviour, tested IN PROCESS.
//
// Every other bus-verb test in this repo builds the launcher binary, spawns it,
// and points it at `fakert`'s HTTP server — because `bus.Client` is concrete and
// there is nothing to substitute. This test injects a transport instead. No
// binary, no socket, no ports: it asserts the channel, the payload, and that the
// verb reports the subscriber count the transport returned.
//
// The suite it replaces takes minutes; this takes microseconds.

// verbFixture puts the on-disk state `VerbSession` reads — a recorded local
// stack and a stored token — under a temp HOME, so a verb can run without a
// started stack.
func verbFixture(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "state"))
	dir := launcher.StateDir()
	if dir == "" {
		t.Fatal("StateDir() is empty under the fixture HOME")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	ss := &launcher.StackSet{Stacks: map[string]*launcher.StackState{
		"local": {Runtime: "container", Services: map[string]launcher.ServiceState{
			"gateway": {Endpoint: "http://localhost:4000/api/health"},
		}},
	}}
	b, _ := json.MarshalIndent(ss, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "stack.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	toks, _ := json.Marshal(map[string]launcher.TokenEntry{"local": {Token: "test-token", Email: "t@example.com"}})
	if err := os.WriteFile(filepath.Join(dir, "tokens.json"), toks, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestBeckonDrivesTheInjectedTransport(t *testing.T) {
	verbFixture(t)
	fake := bustest.NewFake()
	fake.Subscribers = 2
	restore := launcher.UseTransport(func(base, token string) bus.Transport {
		fake.Base, fake.Token = base, token
		return fake
	})
	defer restore()

	if code := Beckon([]string{"--resource", "res-1", "--annotation", "ann-2"}); code != 0 {
		t.Fatalf("beckon: exit %d", code)
	}

	if len(fake.Emits) != 1 {
		t.Fatalf("want exactly one emit, got %d", len(fake.Emits))
	}
	got := fake.Emits[0]
	if got.Channel != bus.BeckonFocus {
		t.Errorf("channel = %q, want %q", got.Channel, bus.BeckonFocus)
	}
	payload, _ := json.Marshal(got.Payload)
	for _, want := range []string{`"resourceId":"res-1"`, `"annotationId":"ann-2"`} {
		if !strings.Contains(string(payload), want) {
			t.Errorf("payload %s missing %s", payload, want)
		}
	}
	// The transport is also how the token and base reach the wire — a seam that
	// dropped either would still emit, and still be wrong.
	if fake.Token != "test-token" {
		t.Errorf("transport built with token %q, want the stored one", fake.Token)
	}
}

// The count the transport reports must reach the user's line, or the seam has
// widened the gap GUIDED-TOUR P1 closed.
func TestBeckonReportsTheTransportsSubscriberCount(t *testing.T) {
	for _, c := range []struct {
		subscribers int
		want        string
	}{
		{0, "nothing is subscribed"},
		{3, "3 subscribers"},
		{-1, "no delivery confirmation"},
	} {
		verbFixture(t)
		fake := bustest.NewFake()
		fake.Subscribers = c.subscribers
		restore := launcher.UseTransport(func(base, token string) bus.Transport {
			fake.Base, fake.Token = base, token
			return fake
		})
		out := harness.CaptureStdout(t, func() {
			if code := Beckon([]string{"--resource", "res-1", "--annotation", "ann-2"}); code != 0 {
				t.Fatalf("beckon: exit %d", code)
			}
		})
		restore()
		if !strings.Contains(out, c.want) {
			t.Errorf("subscribers=%d: output %q missing %q", c.subscribers, out, c.want)
		}
	}
}

// captureOutput runs fn with both standard streams redirected and returns what
// each received. Verbs print results to stdout and refusals to stderr, so a
// helper that saw only one would silently miss half the behaviour under test.

// harness.CaptureStdout is the stdout-only convenience the earlier tests read better with.

// mustContainAll is the in-process twin of the black-box suite's mustContain
// (that one lives in package launcher_test and is not importable here).
