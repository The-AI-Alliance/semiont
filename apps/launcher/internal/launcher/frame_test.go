package launcher

import (
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bustest"
)

// `semiont frame`, in process (SDK-GO-TRANSPORT P2). These were black-box
// tests: build the binary, `start` a fake stack, `login`, then run the verb
// against fakert's HTTP server — ~3 s each to observe two requests. The verb's
// behaviour is entirely about WHAT it sends and WHEN it stops, which the
// transport seam exposes directly.
//
// What is deliberately NOT covered here, and stays end-to-end: that the built
// binary speaks HTTP the backend understands. One wire test per verb family
// keeps that honest — see TestFrameOverTheWire.

// withFake wires a fake transport plus the on-disk session state a verb needs,
// and returns the fake and a restore func.
func withFake(t *testing.T) (*bustest.Fake, func()) {
	t.Helper()
	verbFixture(t)
	fake := bustest.NewFake()
	restore := useTransport(func(base, token string) bus.Transport {
		fake.Base, fake.Token = base, token
		return fake
	})
	return fake, restore
}

func TestFrameAddsEachEntityTypeSeparatelyInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["frame:add-entity-type"] = []byte(`{"correlationId":"c","response":{}}`)

	out := captureStdout(t, func() {
		if code := Frame([]string{"--entity-type", "Person", "--entity-type", "Organization"}); code != 0 {
			t.Fatalf("frame: exit %d", code)
		}
	})
	mustContainAll(t, "stdout", out, "Person", "Organization")

	// TWO commands, in order — one per entity type. A verb that batched them
	// into a single request, or dropped the second, passes any assertion that
	// only looks at the last call.
	if len(fake.Requests) != 2 {
		t.Fatalf("want 2 requests, got %d: %v", len(fake.Requests), fake.Requests)
	}
	for i, want := range []bus.Channel{"frame:add-entity-type", "frame:add-entity-type"} {
		if fake.Requests[i].Channel != want {
			t.Errorf("request %d = %q, want %q", i, fake.Requests[i].Channel, want)
		}
	}
	// One tag per command, in the order given.
	for i, tag := range []string{"Person", "Organization"} {
		if got := bustest.JSON(fake.Requests[i].Payload); !strings.Contains(got, tag) {
			t.Errorf("request %d payload %s missing %q", i, got, tag)
		}
	}
}

func TestFrameStopsAtTheFirstRejectionInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	// A rejection arrives on the operation's failure channel, which the client
	// surfaces as *bus.RequestError — the type busFail unwraps to print the
	// backend's own words. A plain error would take a different branch.
	fake.RequestErr = &bus.RequestError{Channel: "frame:add-entity-type-failed", Message: "vocabulary is frozen"}

	out, errOut := captureOutput(t, func() {
		if code := Frame([]string{"--entity-type", "Person", "--entity-type", "Organization"}); code == 0 {
			t.Fatal("a rejected add must fail the command")
		}
	})
	mustContainAll(t, "rejection", out+errOut, "vocabulary is frozen")

	if len(fake.Requests) != 1 {
		t.Errorf("frame kept going after a rejection: %d requests: %v", len(fake.Requests), fake.Requests)
	}
}

// Argument refusals never reach a transport — they land before verbSession, so
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
			out, errOut := captureOutput(t, func() {
				if code := Frame(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			mustContainAll(t, "refusal", out+errOut, c.want)
			if len(fake.Requests) != 0 || len(fake.Emits) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", fake.Requests, fake.Emits)
			}
		})
	}
}
