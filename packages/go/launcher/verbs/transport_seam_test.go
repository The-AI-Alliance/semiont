package verbs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	launcher "github.com/The-AI-Alliance/semiont/packages/go/launcher"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// The transport seam: a verb's wire behaviour, tested IN PROCESS.
//
// A black-box bus-verb test builds the launcher binary, spawns it, and points
// it at `fakert`'s HTTP server. This test injects a transport instead. No
// binary, no socket, no ports: it asserts the channel, the payload, and that the
// verb reports the subscriber count the transport returned.
//
// A black-box suite of these takes minutes; this takes microseconds.

// localStack: the knowledge base's local stack the fixtures record, its
// gateway as given.
func localStack(gateway launcher.ServiceState) *launcher.StackState {
	return &launcher.StackState{Runtime: "container", KBDid: "did:web:example.org:kb", KBRoot: "/kb",
		Services: map[string]launcher.ServiceState{"gateway": gateway}}
}

// localKey: the key the launcher records localStack's stack, and keeps its
// sign-in, under.
var localKey = launcher.StackKey(localStack(launcher.ServiceState{}))

// recordLocalStack writes a record holding st alone, keyed as the launcher
// keys it.
func recordLocalStack(t *testing.T, st *launcher.StackState) {
	t.Helper()
	ss := &launcher.StackSet{Stacks: map[string]*launcher.StackState{launcher.StackKey(st): st}}
	b, _ := json.MarshalIndent(ss, "", "  ")
	if err := os.WriteFile(filepath.Join(launcher.StateDir(), "stack.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

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
	recordLocalStack(t, localStack(launcher.ServiceState{Endpoint: "http://localhost:4000/api/health"}))
	toks, _ := json.Marshal(map[string]semiont.SignIn{localKey: {Token: "test-token", Email: "t@example.com"}})
	if err := os.WriteFile(filepath.Join(dir, "tokens.json"), toks, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestBeckonDrivesTheInjectedTransport(t *testing.T) {
	verbFixture(t)
	fake := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	fake.Counted(2)
	var built []semiont.HTTPTransportConfig
	restore := launcher.UseTransport(func(config semiont.HTTPTransportConfig) semiont.Transport {
		built = append(built, config)
		return fake
	})
	defer restore()

	if code := Beckon([]string{"--resource", "res-1", "--annotation", "ann-2"}); code != 0 {
		t.Fatalf("beckon: exit %d", code)
	}

	if len(signals(fake)) != 1 {
		t.Fatalf("want exactly one emit, got %d", len(signals(fake)))
	}
	got := signals(fake)[0]
	if got.Channel != bus.BeckonFocus.Channel() {
		t.Errorf("channel = %q, want %q", got.Channel, bus.BeckonFocus.Channel())
	}
	payload, _ := json.Marshal(got.Payload)
	for _, want := range []string{`"resourceId":"res-1"`, `"annotationId":"ann-2"`} {
		if !strings.Contains(string(payload), want) {
			t.Errorf("payload %s missing %s", payload, want)
		}
	}
	// The transport is also how the token and base reach the wire — a seam that
	// dropped either would still emit, and still be wrong.
	if len(built) != 1 {
		t.Fatalf("want exactly one transport for one command, got %d", len(built))
	}
	config := built[0]
	if config.Token.Value() != "test-token" {
		t.Errorf("transport built with token %q, want the stored one", config.Token.Value())
	}
	if config.BaseURL != "http://localhost:4000" {
		t.Errorf("transport built for %q, want the recorded gateway", config.BaseURL)
	}
	if config.Refresher == nil {
		t.Error("transport built with no refresher: a refused token could never be renewed")
	}
	// The command's own stream is no audience for its signal: a stream that
	// named beckon:focus would be counted among the subscribers it reports.
	if slices.Contains(config.Channels, bus.BeckonFocus.Channel()) {
		t.Errorf("the command's stream names %s, the channel it emits on", bus.BeckonFocus.Channel())
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
		fake := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
		if c.counted {
			fake.Counted(c.subscribers)
		}
		restore := launcher.UseTransport(func(semiont.HTTPTransportConfig) semiont.Transport { return fake })
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
