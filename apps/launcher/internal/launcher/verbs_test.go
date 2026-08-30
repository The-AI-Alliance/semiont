package launcher

import (
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bustest"
)

// The knowledge verbs, in process (SDK-GO-TRANSPORT P2).
//
// Each of these was a black-box test: build the binary, `start` a fake stack,
// `login`, run the verb against fakert's HTTP server — ~3 s to observe one
// request. What they actually assert is what the verb SENDS and what it PRINTS,
// both of which the transport seam exposes directly.
//
// One test per verb family stays end-to-end in launcher_test.go, marked WIRE
// SMOKE TEST. Those prove the built binary speaks HTTP a real server
// understands; a family tested only against a double can agree with a bug in
// our own client.

// reply wraps a scripted response the way the gateway does — the verbs decode
// `{correlationId, response}`, so a bare body would fail to parse and the test
// would be measuring the wrong thing.
func reply(body string) []byte {
	return []byte(`{"correlationId":"c","response":` + body + `}`)
}

// ── browse ──────────────────────────────────────────────────────────────

func TestBrowseJSONPassesThroughInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["browse:resources-requested"] = reply(`{"resources":[],"total":0}`)

	out := captureStdout(t, func() {
		if code := Browse([]string{"--json"}); code != 0 {
			t.Fatalf("browse --json: exit %d", code)
		}
	})
	if !strings.Contains(out, `"response"`) {
		t.Errorf("--json must print the RAW reply, got:\n%s", out)
	}
}

func TestBrowseSendsItsFilters(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["browse:resources-requested"] = reply(`{"resources":[],"total":0}`)

	captureStdout(t, func() { Browse([]string{"--limit", "5", "--search", "clause"}) })
	if len(fake.Requests) != 1 {
		t.Fatalf("want 1 request, got %v", fake.Ops())
	}
	got := bustest.JSON(fake.Requests[0].Payload)
	mustContainAll(t, "request payload", got, `"limit":5`, `"search":"clause"`)
}

func TestBrowseBrowserSignalsWithoutReadingInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	// Stated, not defaulted: the fake's -1 means "count unknown", which prints
	// a different line. One subscriber is a room with someone in it — the
	// EMPTY room is now a refusal with its own probe, and belongs to the
	// BROWSER-HANDOFF tests rather than here.
	fake.Subscribers = 1

	out := captureStdout(t, func() {
		if code := Browse([]string{"res-42", "--browser"}); code != 0 {
			t.Fatalf("browse --browser: exit %d", code)
		}
	})
	if len(fake.Emits) != 1 || fake.Emits[0].Channel != bus.BrowseResourceOpen {
		t.Fatalf("want one browse:resource-open emit, got %v", fake.Emits)
	}
	mustContainAll(t, "emit payload", bustest.JSON(fake.Emits[0].Payload), `"resourceId":"res-42"`)
	// A SIGNAL, not a read. A --browser that also fetched would double the work
	// and print a table nobody asked for.
	if len(fake.Requests) != 0 {
		t.Errorf("--browser also performed a read: %v", fake.Ops())
	}
	mustContainAll(t, "audience", out, "1 subscriber")
}

func TestBrowseBrowserRefusalsInProcess(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want []string
	}{
		{"no resourceId", []string{"--browser"}, []string{"--browser", "resourceId"}},
		{"with --json", []string{"res-42", "--browser", "--json"}, []string{"--browser", "--json"}},
		{"with --annotations", []string{"res-42", "--browser", "--annotations"}, []string{"--browser", "--annotations"}},
		{"with --entity-types", []string{"res-42", "--browser", "--entity-types"}, []string{"--browser", "--entity-types"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			out, errOut := captureOutput(t, func() {
				if code := Browse(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			mustContainAll(t, "refusal", out+errOut, c.want...)
			if len(fake.Emits) != 0 || len(fake.Requests) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", fake.Emits, fake.Ops())
			}
		})
	}
}

// ── browse --annotation --browser: the fourth tour move (TOUR-CLICK P4) ──

// The click drive: an annotation id is the WHOLE address, so the emit carries
// it and nothing else, and the verb signals without also reading.
func TestBrowseAnnotationDrivesAClick(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Subscribers = 1

	out := captureStdout(t, func() {
		if code := Browse([]string{"--annotation", "ann-9", "--browser"}); code != 0 {
			t.Fatalf("browse --annotation --browser: exit %d", code)
		}
	})
	if len(fake.Emits) != 1 || fake.Emits[0].Channel != bus.BrowseClick {
		t.Fatalf("want one browse:click emit, got %v", fake.Emits)
	}
	payload := bustest.JSON(fake.Emits[0].Payload)
	mustContainAll(t, "emit payload", payload, `"annotationId":"ann-9"`)
	// D2/D3: the id determines the resource, so neither field rides along. A
	// motivation here would be the denormalization the schema was trimmed of.
	for _, gone := range []string{"resourceId", "motivation"} {
		if strings.Contains(payload, gone) {
			t.Errorf("payload carries %q, which the wire dropped: %s", gone, payload)
		}
	}
	if len(fake.Requests) != 0 {
		t.Errorf("--annotation --browser also performed a read: %v", fake.Ops())
	}
	mustContainAll(t, "report", out, "ann-9", "1 subscriber")
}

// An empty room fails the click for the same reason it fails the resource
// move: the caller asked for a specific outcome and did not get it. The retry
// line has to name the CLICK form, or it sends a tour author to the wrong one.
func TestBrowseAnnotationRefusesWhenNoOneIsWatching(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	noRuntimes(t)
	fake.Subscribers = 0

	out, errOut := captureOutput(t, func() {
		if code := Browse([]string{"--annotation", "ann-9", "--browser", "--browser-url", deadOrigin(t)}); code != 1 {
			t.Errorf("exit %d, want 1", code)
		}
	})
	mustContainAll(t, "refusal", out+errOut,
		"Nobody saw annotation ann-9", "browse:click",
		"semiont browse --annotation ann-9 --browser --launch")
	if len(fake.Emits) != 1 {
		t.Errorf("the emit should still have gone out, got %v", fake.Emits)
	}
}

func TestBrowseAnnotationRefusals(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want []string
	}{
		// The singular/plural trap is one keystroke, so the message names it
		// rather than reporting a generic conflict.
		{"with --annotations", []string{"res-42", "--annotation", "ann-9", "--browser", "--annotations"},
			[]string{"--annotation", "--annotations", "plural"}},
		// Option (c): the click form takes no resourceId, and silently
		// ignoring one would leave the driver keeping two ids consistent.
		{"with a resourceId", []string{"res-42", "--annotation", "ann-9", "--browser"},
			[]string{"--annotation", "drop the resourceId"}},
		// It names a remote act; there is no local rendering it could mean.
		{"without --browser", []string{"--annotation", "ann-9"},
			[]string{"--annotation", "only applies with --browser"}},
		{"with --json", []string{"--annotation", "ann-9", "--browser", "--json"},
			[]string{"--browser", "--json"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			out, errOut := captureOutput(t, func() {
				if code := Browse(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			mustContainAll(t, "refusal", out+errOut, c.want...)
			if len(fake.Emits) != 0 || len(fake.Requests) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", fake.Emits, fake.Ops())
			}
		})
	}
}

func TestBrowseReportsARejection(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.RequestErr = &bus.RequestError{Channel: "browse:resource-failed", Message: "resource vanished"}

	out, errOut := captureOutput(t, func() {
		if code := Browse([]string{"res-9"}); code == 0 {
			t.Fatal("a failure reply must fail the command")
		}
	})
	mustContainAll(t, "rejection", out+errOut, "rejected", "resource vanished")
}

// ── beckon ──────────────────────────────────────────────────────────────

func TestBeckonSparkleEmitsSparkleNotFocusInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Subscribers = 0 // an empty room, stated — see the browse test above

	out := captureStdout(t, func() {
		if code := Beckon([]string{"--resource", "res-42", "--annotation", "ref-a", "--sparkle"}); code != 0 {
			t.Fatalf("beckon --sparkle: exit %d", code)
		}
	})
	if len(fake.Emits) != 1 {
		t.Fatalf("want exactly one emit, got %v", fake.Emits)
	}
	if fake.Emits[0].Channel != bus.BeckonSparkle {
		t.Errorf("channel = %q, want %q", fake.Emits[0].Channel, bus.BeckonSparkle)
	}
	// Emitting BOTH would scroll-fight exactly as before, which is the thing
	// this flag exists to avoid.
	for _, e := range fake.Emits {
		if e.Channel == bus.BeckonFocus {
			t.Errorf("--sparkle also emitted focus, the scroll-fight it exists to avoid")
		}
	}
	mustContainAll(t, "audience", out, "nothing is subscribed to beckon:sparkle")
}

func TestBeckonWithoutSparkleFocusesInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	captureStdout(t, func() {
		if code := Beckon([]string{"--resource", "res-42", "--annotation", "ref-a"}); code != 0 {
			t.Fatalf("beckon: exit %d", code)
		}
	})
	if len(fake.Emits) != 1 || fake.Emits[0].Channel != bus.BeckonFocus {
		t.Fatalf("want one beckon:focus emit, got %v", fake.Emits)
	}
}

func TestBeckonRefusalsInProcess(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want []string
	}{
		{"no resource", nil, []string{"Usage: semiont beckon"}},
		{"sparkle without annotation", []string{"--resource", "res-42", "--sparkle"}, []string{"--sparkle", "--annotation"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			out, errOut := captureOutput(t, func() {
				if code := Beckon(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			mustContainAll(t, "refusal", out+errOut, c.want...)
			if len(fake.Emits) != 0 {
				t.Errorf("a refused argument still reached the wire: %v", fake.Emits)
			}
		})
	}
}

// ── mark ────────────────────────────────────────────────────────────────

func TestMarkLinkInfersLinkingMotivationInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["mark:create-request"] = reply(`{"annotationId":"ann-9"}`)

	captureStdout(t, func() {
		if code := Mark([]string{"res-1", "--link", "res-2"}); code != 0 {
			t.Fatalf("mark --link: exit %d", code)
		}
	})
	if len(fake.Requests) != 1 {
		t.Fatalf("want 1 request, got %v", fake.Ops())
	}
	mustContainAll(t, "request payload", bustest.JSON(fake.Requests[0].Payload),
		`"motivation":"linking"`, `"SpecificResource"`, `"source":"res-2"`)
}

func TestMarkRefusalsInProcess(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want string
	}{
		{"selector flags are exclusive", []string{"res-1", "--quote", "x", "--start", "1", "--end", "2"}, "pick one"},
		{"half a position range", []string{"res-1", "--start", "1"}, "go together"},
		{"delete needs a resource", []string{"--delete", "ann-1"}, "--resource"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			out, errOut := captureOutput(t, func() {
				if code := Mark(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			mustContainAll(t, "refusal", out+errOut, c.want)
			if len(fake.Requests) != 0 {
				t.Errorf("a refused argument still reached the wire: %v", fake.Ops())
			}
		})
	}
}

// ── gather ──────────────────────────────────────────────────────────────

func TestGatherAnnotationUsesTheStreamingOperationInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["gather:requested"] = reply(`{"content":"ctx","resources":[]}`)

	captureStdout(t, func() {
		if code := Gather([]string{"res-1", "ann-7"}); code != 0 {
			t.Fatalf("gather annotation: exit %d", code)
		}
	})
	if ops := fake.Ops(); len(ops) != 1 || ops[0] != "gather:requested" {
		t.Fatalf("want gather:requested, got %v", ops)
	}
	mustContainAll(t, "request payload", bustest.JSON(fake.Requests[0].Payload),
		`"annotationId":"ann-7"`, `"resourceId":"res-1"`)
}
