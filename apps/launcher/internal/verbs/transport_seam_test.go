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

// The transport seam: a verb's wire behaviour, tested IN PROCESS.
//
// A black-box bus-verb test builds the launcher binary, spawns it, and points
// it at `fakert`'s HTTP server. This test injects a transport instead. No
// binary, no socket, no ports: it asserts the channel, the payload, and that the
// verb reports the subscriber count the transport returned.
//
// A black-box suite of these takes minutes; this takes microseconds.

// verbFixture puts the on-disk state `VerbSession` reads — a recorded local
// stack and a stored token — under a temp HOME, so a verb can run without a
// started stack.
func verbFixture(t *testing.T) {
	t.Helper()
	harness.Home(t)
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
	toks, _ := json.Marshal(map[string]launcher.SignIn{"local": {Token: "test-token", Email: "t@example.com"}})
	if err := os.WriteFile(filepath.Join(dir, "tokens.json"), toks, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestBeckonDrivesTheInjectedTransport(t *testing.T) {
	verbFixture(t)
	fake := bustest.NewFake()
	fake.Counted(2)
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

// The count the transport reports must reach the user's line: without it, a
// signal that reaches an empty room says nothing.
func TestBeckonReportsTheTransportsSubscriberCount(t *testing.T) {
	for _, c := range []struct {
		subscribers int
		counted     bool
		want        string
	}{
		{0, true, "nothing is subscribed"},
		{3, true, "3 subscribers"},
		{0, false, "no delivery confirmation"},
	} {
		verbFixture(t)
		fake := bustest.NewFake()
		if c.counted {
			fake.Counted(c.subscribers)
		}
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
