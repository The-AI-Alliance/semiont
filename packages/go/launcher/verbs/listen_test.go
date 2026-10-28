package verbs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

// `semiont listen`, in process against the faulty transport. It runs until
// it is stopped, so each test drives it from another goroutine: it asks for
// the resources' names once its stream's listener is held, so what is
// delivered from that request on is heard; and it ends, saying so, when the
// stream drops.

// within waits, a few seconds at most, for done. It does not fail the test
// itself: a test inside a capture of the output says what was missing after
// the capture ends.
func within(done func() bool) bool {
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if done() {
			return true
		}
	}
	return false
}

// printing is how long a verb is given to print what it was just handed,
// before the stream's drop races it.
const printing = 200 * time.Millisecond

const namesAsked bus.Channel = "browse:resources-requested"

// noNames is a knowledge base's answer when it holds no resource.
var noNames = json.RawMessage(`{"resources":[],"total":0,"offset":0,"limit":200}`)

// listening is one run of listen: its exit code, everything it printed, and
// whether it reached its request for names and ended.
type listening struct {
	code           int
	output         string
	reached, ended bool
}

// listened runs listen with args against fake: the names it asks for are
// answered with names; once it has asked, asked is called, frames are
// delivered, and then the stream drops.
func listened(t *testing.T, fake *semionttest.FaultyTransport, args []string, names json.RawMessage, asked func(), frames ...semiont.Frame) listening {
	t.Helper()
	fake.QueueReply(namesAsked, names)
	var run listening
	out, errOut := harness.CaptureOutput(t, func() {
		done := make(chan int, 1)
		go func() { done <- Listen(args) }()
		if run.reached = within(func() bool { return len(ops(fake)) > 0 }); !run.reached {
			return
		}
		asked()
		for _, frame := range frames {
			fake.Deliver(frame)
		}
		time.Sleep(printing)
		fake.SetState(semiont.ConnectionStateReconnecting)
		select {
		case run.code = <-done:
			run.ended = true
		case <-time.After(5 * time.Second):
		}
	})
	run.output = out + errOut
	if !run.reached || !run.ended {
		t.Fatalf("listen reached its request for names: %v; ended when its stream dropped: %v\n%s", run.reached, run.ended, run.output)
	}
	return run
}

func TestListenRendersWhatArrivesByNameAndSaysWhenTheStreamDropsInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	names := json.RawMessage(`{"resources":[{"@context":"https://schema.org/","@id":"res-42","name":"The Iliad","representations":[]}],"total":1,"offset":0,"limit":200}`)
	viewed := semiont.Frame{Channel: bus.BrowseResourceViewed.Channel(), Payload: json.RawMessage(`{"resourceId":"res-42"}`)}

	run := listened(t, fake, nil, names, func() {}, viewed)
	// A stream that ends on its own is not a stop the user asked for.
	if run.code != 1 {
		t.Errorf("exit %d when the stream dropped, want 1", run.code)
	}
	harness.MustContainAll(t, "output", run.output, "Listening to this KB", `"The Iliad"`, "The event stream closed.")
	// Names are asked for once, up front, never per event.
	if got := ops(fake); !slices.Equal(got, []bus.Channel{namesAsked}) {
		t.Errorf("asked %v, want the names once", got)
	}
	var filters struct {
		Limit int `json:"limit"`
	}
	if err := json.Unmarshal(fake.RequestLog()[0].Payload, &filters); err != nil || filters.Limit != prefetchLimit {
		t.Errorf("the names were asked for with %s, want a page of %d", fake.RequestLog()[0].Payload, prefetchLimit)
	}
}

// A resource's scope: listen holds it while it listens and lets it go after,
// hears what that resource's scope carries, and prints it raw under --json.
func TestListenToAScopeHoldsItAndPrintsWhatItCarriesRawInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	resource, err := api.ParseResourceId("res-7")
	if err != nil {
		t.Fatal(err)
	}
	carried := bus.ResourceScopedChannels[0]
	frame := semiont.Frame{Channel: carried, Envelope: semiont.Envelope{Scope: resource}, Payload: json.RawMessage(`{"resourceId":"res-7"}`)}
	held := 0

	run := listened(t, fake, []string{"--scope", "res-7", "--json"}, noNames, func() { held = fake.Holds(resource) }, frame)
	if run.code != 1 {
		t.Errorf("exit %d when the stream dropped, want 1", run.code)
	}
	if held != 1 {
		t.Errorf("listen --scope held the resource's scope %d times while it listened, want once", held)
	}
	if holds := fake.Holds(resource); holds != 0 {
		t.Errorf("the scope is held %d times after listen ended", holds)
	}
	// Raw, as scripts parse it: the channel, the payload as it came, and the scope.
	harness.MustContainAll(t, "raw line", run.output, `"channel":"`+string(carried)+`"`, `"payload":{"resourceId":"res-7"}`, `"scope":"res-7"`)
	// The human rendering's note never reaches the machine one.
	if strings.Contains(run.output, "Shows events RECEIVED") {
		t.Errorf("--json printed the human rendering's note:\n%s", run.output)
	}
}

// A channel the transport does not bridge delivers nothing, and listen says
// so before it subscribes rather than leave its reader watching a stream
// that can never produce an event.
func TestListenWarnsOfAChannelNothingBridgesInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	unbridged := bus.ResourceScopedChannels[0]
	run := listened(t, fake, []string{"--channel", string(unbridged)}, noNames, func() {})
	harness.MustContainAll(t, "warning", run.output, string(unbridged)+" is not a bridged channel")
}
