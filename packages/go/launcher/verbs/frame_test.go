package verbs

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// `semiont frame`, in process against the fake transport. These were
// black-box tests: build the binary, `start` a fake stack, `login`, then run
// the verb against fakert's HTTP server — ~3 s each to observe two requests.
// The verb's behaviour is entirely about WHAT it sends and WHEN it stops,
// which the transport seam exposes directly.
//
// What is deliberately NOT covered here, and stays end-to-end: that the built
// binary speaks HTTP the gateway understands. One wire test per verb family
// keeps that honest — see TestFrameOverTheWire.

// withFake wires a faulty transport plus the on-disk session state a verb
// needs, and returns the transport and a restore func.
func withFake(t *testing.T) (*semionttest.FaultyTransport, func()) {
	t.Helper()
	verbFixture(t)
	fake := semionttest.NewFaultyTransport(semionttest.FaultyConfig{})
	restore := launcher.UseTransport(func(semiont.HTTPTransportConfig) semiont.Transport { return fake })
	return fake, restore
}

// signals is every frame a verb emitted that is no request, in order.
func signals(fake *semionttest.FaultyTransport) []semiont.Frame {
	var sent []semiont.Frame
	for _, frame := range fake.Emitted() {
		if _, request := bus.Operations[frame.Channel]; !request {
			sent = append(sent, frame)
		}
	}
	return sent
}

// ops is the channel of every request a verb sent, in order.
func ops(fake *semionttest.FaultyTransport) []bus.Channel {
	var channels []bus.Channel
	for _, request := range fake.RequestLog() {
		channels = append(channels, request.Channel)
	}
	return channels
}

// refusing has the gateway refuse every request on channel with failure.
func refusing(channel bus.Channel, failure string) semionttest.Refuse {
	return func(operation bus.Channel, _ json.RawMessage) json.RawMessage {
		if operation != channel {
			return nil
		}
		return json.RawMessage(failure)
	}
}

func TestFrameAddsEachEntityTypeSeparatelyInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("frame:add-entity-type", json.RawMessage(`{}`), json.RawMessage(`{}`))

	out := harness.CaptureStdout(t, func() {
		if code := Frame([]string{"--entity-type", "Person", "--entity-type", "Organization"}); code != 0 {
			t.Fatalf("frame: exit %d", code)
		}
	})
	harness.MustContainAll(t, "stdout", out, "Person", "Organization")

	// TWO commands, in order — one per entity type. A verb that batched them
	// into a single request, or dropped the second, passes any assertion that
	// only looks at the last call.
	if len(fake.RequestLog()) != 2 {
		t.Fatalf("want 2 requests, got %d: %v", len(fake.RequestLog()), fake.RequestLog())
	}
	for i, want := range []bus.Channel{"frame:add-entity-type", "frame:add-entity-type"} {
		if fake.RequestLog()[i].Channel != want {
			t.Errorf("request %d = %q, want %q", i, fake.RequestLog()[i].Channel, want)
		}
	}
	// One tag per command, in the order given.
	for i, tag := range []string{"Person", "Organization"} {
		if got := string(fake.RequestLog()[i].Payload); !strings.Contains(got, tag) {
			t.Errorf("request %d payload %s missing %q", i, got, tag)
		}
	}
}

func TestFrameStopsAtTheFirstRejectionInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	// A rejection arrives on the operation's failure channel, which the SDK
	// surfaces as a *semiont.BusRequestError carrying it — what busFail reads
	// to print the gateway's own words. A plain error would take a different
	// branch.
	fake.RefuseWhen(refusing("frame:add-entity-type", `{"message":"vocabulary is frozen"}`))

	out, errOut := harness.CaptureOutput(t, func() {
		if code := Frame([]string{"--entity-type", "Person", "--entity-type", "Organization"}); code == 0 {
			t.Fatal("a rejected add must fail the command")
		}
	})
	harness.MustContainAll(t, "rejection", out+errOut, "vocabulary is frozen")

	if len(fake.RequestLog()) != 1 {
		t.Errorf("frame kept going after a rejection: %d requests: %v", len(fake.RequestLog()), fake.RequestLog())
	}
}

// Argument refusals never reach a transport — they land before launcher.VerbSession, so
// nothing should be sent, whichever stream the message goes to.
func TestFrameArgumentRefusals(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want string
	}{
		{"nothing to add", nil, "Usage: semiont frame"},
		{"bare positional", []string{"Person"}, "--entity-type"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			out, errOut := harness.CaptureOutput(t, func() {
				if code := Frame(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, c.want)
			if len(fake.RequestLog()) != 0 || len(signals(fake)) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", fake.RequestLog(), signals(fake))
			}
		})
	}
}
