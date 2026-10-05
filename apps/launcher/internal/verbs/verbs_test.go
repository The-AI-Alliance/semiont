package verbs

import (
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bustest"
)

// The knowledge verbs, in process against the fake transport.
//
// What these assert is what the verb SENDS and what it PRINTS, both of which
// the transport seam exposes directly. The black-box route — build the binary,
// `start` a fake stack, `login`, run the verb against fakert's HTTP server —
// takes ~3 s to observe one request.
//
// One test per verb family is end-to-end in launcher_test.go, marked WIRE
// SMOKE TEST. Those prove the built binary speaks HTTP a real server
// understands; a family tested only against a double can agree with a bug in
// our own client.

// reply wraps a scripted response the way the gateway does — the verbs are
// handed a reply PAYLOAD and decode `{response}`, so a bare body would fail to
// parse and the test would be measuring the wrong thing. No correlationId: it
// rides the envelope and the bus client has already consumed it.
func reply(body string) []byte {
	return []byte(`{"response":` + body + `}`)
}

// ── browse ──────────────────────────────────────────────────────────────

func TestBrowseJSONPassesThroughInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["browse:resources-requested"] = reply(`{"resources":[],"total":0}`)

	out := harness.CaptureStdout(t, func() {
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

	harness.CaptureStdout(t, func() { Browse([]string{"--limit", "5", "--entity-type", "Contract"}) })
	if len(fake.Requests) != 1 {
		t.Fatalf("want 1 request, got %v", fake.Ops())
	}
	got := bustest.JSON(fake.Requests[0].Payload)
	harness.MustContainAll(t, "request payload", got, `"limit":5`, `"entityType":"Contract"`)
}

// Text search is `match --search`; the listing takes no text.
func TestBrowseHasNoSearchFlag(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()

	out, errOut := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"--search", "clause"}); code == 0 {
			t.Fatal("must refuse")
		}
	})
	harness.MustContainAll(t, "refusal", out+errOut, "Unknown argument: --search")
	if len(fake.Requests) != 0 {
		t.Errorf("a refused argument still reached the wire: %v", fake.Ops())
	}
}

// ── match ───────────────────────────────────────────────────────────────

func TestMatchSearchAsksTheResourceSearch(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["match:resources-requested"] = reply(`{"resources":[` +
		`{"@id":"res-7","name":"Acme MSA","entityTypes":["Contract"]}],` +
		`"total":3,"offset":0,"limit":5,"matchKind":"lexical"}`)

	out := harness.CaptureStdout(t, func() {
		if code := Match([]string{"--search", "indemnity clause", "--limit", "5", "--entity-type", "Contract"}); code != 0 {
			t.Fatalf("match --search: exit %d", code)
		}
	})
	if ops := fake.Ops(); len(ops) != 1 || ops[0] != "match:resources-requested" {
		t.Fatalf("want exactly match:resources-requested, got %v", ops)
	}
	got := bustest.JSON(fake.Requests[0].Payload)
	harness.MustContainAll(t, "request payload", got,
		`"search":"indemnity clause"`, `"limit":5`, `"entityType":"Contract"`)
	harness.MustContainAll(t, "table", out, "res-7", "Acme MSA", "Contract", "1 shown, 3 total")
}

func TestMatchSearchLimitDefaultsToTwenty(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["match:resources-requested"] = reply(`{"resources":[],"total":0,"offset":0,"limit":20,"matchKind":"lexical"}`)

	out := harness.CaptureStdout(t, func() { Match([]string{"--search", "clause"}) })
	if len(fake.Requests) != 1 {
		t.Fatalf("want 1 request, got %v", fake.Ops())
	}
	harness.MustContainAll(t, "request payload", bustest.JSON(fake.Requests[0].Payload), `"limit":20`)
	harness.MustContainAll(t, "empty page", out, "No resources match.")
}

func TestMatchSearchJSONCarriesTheMatchKind(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["match:resources-requested"] = reply(`{"resources":[],"total":0,"offset":0,"limit":20,"matchKind":"semantic"}`)

	out := harness.CaptureStdout(t, func() {
		if code := Match([]string{"--search", "clause", "--json"}); code != 0 {
			t.Fatalf("match --search --json: exit %d", code)
		}
	})
	harness.MustContainAll(t, "raw reply", out, `"response"`, `"matchKind":"semantic"`)
}

func TestMatchRefusalsInProcess(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want []string
	}{
		{"neither form", nil, []string{"--search <text>", "<resourceId> <annotationId>"}},
		{"half an annotation", []string{"res-1"}, []string{"--search <text>", "<resourceId> <annotationId>", "got 1"}},
		{"both forms", []string{"res-1", "ann-1", "--search", "clause"}, []string{"--search <text>", "<resourceId> <annotationId>", "Pick one"}},
		{"search with one positional", []string{"--search", "clause", "res-1"}, []string{"Pick one"}},
		{"empty text", []string{"--search", ""}, []string{"--search wants the text"}},
		{"--no-semantic with --search", []string{"--search", "clause", "--no-semantic"}, []string{"--no-semantic only applies"}},
		{"--entity-type with an annotation", []string{"res-1", "ann-1", "--entity-type", "Contract"}, []string{"--entity-type only applies with --search"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			out, errOut := harness.CaptureOutput(t, func() {
				if code := Match(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, c.want...)
			if len(fake.Requests) != 0 {
				t.Errorf("a refused argument still reached the wire: %v", fake.Ops())
			}
		})
	}
}

func TestBrowseBrowserSignalsWithoutReadingInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	// Stated, not defaulted: a fresh fake's emit is uncounted, which prints a
	// different line. One subscriber is a room with someone in it — the
	// EMPTY room is a refusal with its own probe, and belongs to
	// browse_browser_test.go.
	fake.Counted(1)

	out := harness.CaptureStdout(t, func() {
		if code := Browse([]string{"res-42", "--browser"}); code != 0 {
			t.Fatalf("browse --browser: exit %d", code)
		}
	})
	if len(fake.Emits) != 1 || fake.Emits[0].Channel != bus.BrowseResourceOpen {
		t.Fatalf("want one browse:resource-open emit, got %v", fake.Emits)
	}
	harness.MustContainAll(t, "emit payload", bustest.JSON(fake.Emits[0].Payload), `"resourceId":"res-42"`)
	// A SIGNAL, not a read. A --browser that also fetched would double the work
	// and print a table nobody asked for.
	if len(fake.Requests) != 0 {
		t.Errorf("--browser also performed a read: %v", fake.Ops())
	}
	harness.MustContainAll(t, "audience", out, "1 subscriber")
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
			out, errOut := harness.CaptureOutput(t, func() {
				if code := Browse(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, c.want...)
			if len(fake.Emits) != 0 || len(fake.Requests) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", fake.Emits, fake.Ops())
			}
		})
	}
}

// ── browse --annotation --browser: the fourth tour move ──────────────────

// The click drive: an annotation id is the WHOLE address, so the emit carries
// it and nothing else, and the verb signals without also reading.
func TestBrowseAnnotationDrivesAClick(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Counted(1)

	out := harness.CaptureStdout(t, func() {
		if code := Browse([]string{"--annotation", "ann-9", "--browser"}); code != 0 {
			t.Fatalf("browse --annotation --browser: exit %d", code)
		}
	})
	if len(fake.Emits) != 1 || fake.Emits[0].Channel != bus.BrowseClick {
		t.Fatalf("want one browse:click emit, got %v", fake.Emits)
	}
	payload := bustest.JSON(fake.Emits[0].Payload)
	harness.MustContainAll(t, "emit payload", payload, `"annotationId":"ann-9"`)
	// The id determines the resource, so neither field rides along. A motivation
	// here would be a denormalization the schema does not carry.
	for _, gone := range []string{"resourceId", "motivation"} {
		if strings.Contains(payload, gone) {
			t.Errorf("payload carries %q, which the wire dropped: %s", gone, payload)
		}
	}
	if len(fake.Requests) != 0 {
		t.Errorf("--annotation --browser also performed a read: %v", fake.Ops())
	}
	harness.MustContainAll(t, "report", out, "ann-9", "1 subscriber")
}

// An empty room fails the click for the same reason it fails the resource
// move: the caller asked for a specific outcome and did not get it. The retry
// line has to name the CLICK form, or it sends a tour author to the wrong one.
func TestBrowseAnnotationRefusesWhenNoOneIsWatching(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	harness.NoRuntimes(t)
	fake.Counted(0)

	out, errOut := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"--annotation", "ann-9", "--browser", "--browser-url", harness.DeadOrigin(t)}); code != 1 {
			t.Errorf("exit %d, want 1", code)
		}
	})
	harness.MustContainAll(t, "refusal", out+errOut,
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
		// The click form takes no resourceId, and silently ignoring one
		// would leave the driver keeping two ids consistent.
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
			out, errOut := harness.CaptureOutput(t, func() {
				if code := Browse(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, c.want...)
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

	out, errOut := harness.CaptureOutput(t, func() {
		if code := Browse([]string{"res-9"}); code == 0 {
			t.Fatal("a failure reply must fail the command")
		}
	})
	harness.MustContainAll(t, "rejection", out+errOut, "rejected", "resource vanished")
}

// ── beckon ──────────────────────────────────────────────────────────────

func TestBeckonSparkleEmitsSparkleNotFocusInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Counted(0) // an empty room, stated — see the browse test above

	out := harness.CaptureStdout(t, func() {
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
	// Emitting BOTH would scroll-fight, which is the thing this flag exists
	// to avoid.
	for _, e := range fake.Emits {
		if e.Channel == bus.BeckonFocus {
			t.Errorf("--sparkle also emitted focus, the scroll-fight it exists to avoid")
		}
	}
	harness.MustContainAll(t, "audience", out, "nothing is subscribed to beckon:sparkle")
}

func TestBeckonWithoutSparkleFocusesInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	harness.CaptureStdout(t, func() {
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
			out, errOut := harness.CaptureOutput(t, func() {
				if code := Beckon(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, c.want...)
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

	harness.CaptureStdout(t, func() {
		if code := Mark([]string{"res-1", "--link", "res-2"}); code != 0 {
			t.Fatalf("mark --link: exit %d", code)
		}
	})
	if len(fake.Requests) != 1 {
		t.Fatalf("want 1 request, got %v", fake.Ops())
	}
	harness.MustContainAll(t, "request payload", bustest.JSON(fake.Requests[0].Payload),
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
			out, errOut := harness.CaptureOutput(t, func() {
				if code := Mark(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, c.want)
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

	harness.CaptureStdout(t, func() {
		if code := Gather([]string{"res-1", "ann-7"}); code != 0 {
			t.Fatalf("gather annotation: exit %d", code)
		}
	})
	if ops := fake.Ops(); len(ops) != 1 || ops[0] != "gather:requested" {
		t.Fatalf("want gather:requested, got %v", ops)
	}
	harness.MustContainAll(t, "request payload", bustest.JSON(fake.Requests[0].Payload),
		`"annotationId":"ann-7"`, `"resourceId":"res-1"`)
}
