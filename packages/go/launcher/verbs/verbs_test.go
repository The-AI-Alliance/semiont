package verbs

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
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

// ── browse ──────────────────────────────────────────────────────────────

func TestBrowseJSONPrintsTheResponseInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("browse:resources-requested", json.RawMessage(`{"total":0,"resources":[],"offset":0,"limit":20}`))

	out := harness.CaptureStdout(t, func() {
		if code := Browse([]string{"--json"}); code != 0 {
			t.Fatalf("browse --json: exit %d", code)
		}
	})
	// The reply's response, as the SDK read it: its members in the schema's order.
	harness.MustContainAll(t, "response", out, `{"limit":20,"offset":0,"resources":[],"total":0}`)
}

func TestBrowseSendsItsFilters(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("browse:resources-requested", json.RawMessage(`{"resources":[],"total":0,"offset":0,"limit":5}`))

	harness.CaptureStdout(t, func() { Browse([]string{"--limit", "5", "--entity-type", "Contract"}) })
	if len(fake.RequestLog()) != 1 {
		t.Fatalf("want 1 request, got %v", ops(fake))
	}
	got := string(fake.RequestLog()[0].Payload)
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
	if len(fake.RequestLog()) != 0 {
		t.Errorf("a refused argument still reached the wire: %v", ops(fake))
	}
}

// ── match ───────────────────────────────────────────────────────────────

func TestMatchSearchAsksTheResourceSearch(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("match:resources-requested", json.RawMessage(`{"resources":[`+
		`{"@context":"https://schema.org","@id":"res-7","name":"Acme MSA","entityTypes":["Contract"],"representations":[]}],`+
		`"total":3,"offset":0,"limit":5,"matchKind":"lexical"}`))

	out := harness.CaptureStdout(t, func() {
		if code := Match([]string{"--search", "indemnity clause", "--limit", "5", "--entity-type", "Contract"}); code != 0 {
			t.Fatalf("match --search: exit %d", code)
		}
	})
	if ops := ops(fake); len(ops) != 1 || ops[0] != "match:resources-requested" {
		t.Fatalf("want exactly match:resources-requested, got %v", ops)
	}
	got := string(fake.RequestLog()[0].Payload)
	harness.MustContainAll(t, "request payload", got,
		`"search":"indemnity clause"`, `"limit":5`, `"entityType":"Contract"`)
	harness.MustContainAll(t, "table", out, "res-7", "Acme MSA", "Contract", "1 shown, 3 total")
}

func TestMatchSearchLimitDefaultsToTwenty(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("match:resources-requested", json.RawMessage(`{"resources":[],"total":0,"offset":0,"limit":20,"matchKind":"lexical"}`))

	out := harness.CaptureStdout(t, func() { Match([]string{"--search", "clause"}) })
	if len(fake.RequestLog()) != 1 {
		t.Fatalf("want 1 request, got %v", ops(fake))
	}
	harness.MustContainAll(t, "request payload", string(fake.RequestLog()[0].Payload), `"limit":20`)
	harness.MustContainAll(t, "empty page", out, "No resources match.")
}

func TestMatchSearchJSONCarriesTheMatchKind(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("match:resources-requested", json.RawMessage(`{"resources":[],"total":0,"offset":0,"limit":20,"matchKind":"semantic"}`))

	out := harness.CaptureStdout(t, func() {
		if code := Match([]string{"--search", "clause", "--json"}); code != 0 {
			t.Fatalf("match --search --json: exit %d", code)
		}
	})
	harness.MustContainAll(t, "raw response", out, `"matchKind":"semantic"`)
}

func TestMatchRefusalsInProcess(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want []string
	}{
		{"neither form", nil, []string{"--search <text>", "<resourceId> <annotationId>"}},
		{"half an annotation", []string{"res-1"}, []string{"--search <text>", "<resourceId> <annotationId>", "--annotation"}},
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
			if len(fake.RequestLog()) != 0 {
				t.Errorf("a refused argument still reached the wire: %v", ops(fake))
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
	if len(signals(fake)) != 1 || signals(fake)[0].Channel != bus.BrowseResourceOpen.Channel() {
		t.Fatalf("want one browse:resource-open emit, got %v", signals(fake))
	}
	harness.MustContainAll(t, "emit payload", string(signals(fake)[0].Payload), `"resourceId":"res-42"`)
	// A SIGNAL, not a read. A --browser that also fetched would double the work
	// and print a table nobody asked for.
	if len(fake.RequestLog()) != 0 {
		t.Errorf("--browser also performed a read: %v", ops(fake))
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
			if len(signals(fake)) != 0 || len(fake.RequestLog()) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", signals(fake), ops(fake))
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
	if len(signals(fake)) != 1 || signals(fake)[0].Channel != bus.BrowseClick.Channel() {
		t.Fatalf("want one browse:click emit, got %v", signals(fake))
	}
	payload := string(signals(fake)[0].Payload)
	harness.MustContainAll(t, "emit payload", payload, `"annotationId":"ann-9"`)
	// The id determines the resource, so neither field rides along. A motivation
	// here would be a denormalization the schema does not carry.
	for _, gone := range []string{"resourceId", "motivation"} {
		if strings.Contains(payload, gone) {
			t.Errorf("payload carries %q, which the wire dropped: %s", gone, payload)
		}
	}
	if len(fake.RequestLog()) != 0 {
		t.Errorf("--annotation --browser also performed a read: %v", ops(fake))
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
	if len(signals(fake)) != 1 {
		t.Errorf("the emit should still have gone out, got %v", signals(fake))
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
			if len(signals(fake)) != 0 || len(fake.RequestLog()) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", signals(fake), ops(fake))
			}
		})
	}
}

func TestBrowseReportsARejection(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.RefuseWhen(refusing("browse:resource-requested", `{"message":"resource vanished"}`))

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
	if len(signals(fake)) != 1 {
		t.Fatalf("want exactly one emit, got %v", signals(fake))
	}
	if signals(fake)[0].Channel != bus.BeckonSparkle.Channel() {
		t.Errorf("channel = %q, want %q", signals(fake)[0].Channel, bus.BeckonSparkle.Channel())
	}
	// Emitting BOTH would scroll-fight, which is the thing this flag exists
	// to avoid.
	for _, e := range signals(fake) {
		if e.Channel == bus.BeckonFocus.Channel() {
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
	if len(signals(fake)) != 1 || signals(fake)[0].Channel != bus.BeckonFocus.Channel() {
		t.Fatalf("want one beckon:focus emit, got %v", signals(fake))
	}
}

func TestBeckonAtAResourceAloneFocusesItInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	harness.CaptureStdout(t, func() {
		if code := Beckon([]string{"res-42"}); code != 0 {
			t.Fatalf("beckon: exit %d", code)
		}
	})
	sent := signals(fake)
	if len(sent) != 1 || sent[0].Channel != bus.BeckonFocus.Channel() {
		t.Fatalf("want one beckon:focus emit, got %v", sent)
	}
	var focus map[string]any
	if err := json.Unmarshal(sent[0].Payload, &focus); err != nil {
		t.Fatal(err)
	}
	if len(focus) != 1 || focus["resourceId"] != "res-42" {
		t.Errorf("the focus names the resource and nothing else, got %v", focus)
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
		{"a bare word too many", []string{"res-1", "ann-1", "x"}, []string{"Unexpected argument: x"}},
		{"the resource given twice", []string{"--resource", "res-1", "--resource", "res-2"}, []string{"The resource is given twice"}},
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
			if len(signals(fake)) != 0 {
				t.Errorf("a refused argument still reached the wire: %v", signals(fake))
			}
		})
	}
}

// ── mark ────────────────────────────────────────────────────────────────

func TestMarkLinkInfersLinkingMotivationInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("mark:create-request", json.RawMessage(`{"annotationId":"ann-9"}`))

	harness.CaptureStdout(t, func() {
		if code := Mark([]string{"res-1", "--link", "res-2"}); code != 0 {
			t.Fatalf("mark --link: exit %d", code)
		}
	})
	if len(fake.RequestLog()) != 1 {
		t.Fatalf("want 1 request, got %v", ops(fake))
	}
	harness.MustContainAll(t, "request payload", string(fake.RequestLog()[0].Payload),
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
			if len(fake.RequestLog()) != 0 {
				t.Errorf("a refused argument still reached the wire: %v", ops(fake))
			}
		})
	}
}

// ── gather ──────────────────────────────────────────────────────────────

func TestGatherAnnotationUsesTheStreamingOperationInProcess(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.QueueReply("gather:requested", json.RawMessage(`{"focus":{"kind":"annotation",`+
		`"annotation":{"@context":"http://www.w3.org/ns/anno.jsonld","type":"Annotation","id":"ann-7","motivation":"highlighting","target":"res-1","created":"2026-10-06T00:00:00.000Z"},`+
		`"sourceResource":{"@context":"https://schema.org","@id":"res-1","name":"A resource","representations":[]},"selected":{"text":"ctx"}},`+
		`"graph":{"nodes":[],"edges":[]},"metadata":{}}`))

	harness.CaptureStdout(t, func() {
		if code := Gather([]string{"res-1", "ann-7"}); code != 0 {
			t.Fatalf("gather annotation: exit %d", code)
		}
	})
	if ops := ops(fake); len(ops) != 1 || ops[0] != "gather:requested" {
		t.Fatalf("want gather:requested, got %v", ops)
	}
	harness.MustContainAll(t, "request payload", string(fake.RequestLog()[0].Payload),
		`"annotationId":"ann-7"`, `"resourceId":"res-1"`)
}

// ── ids that begin with "-" ─────────────────────────────────────────────

// An id may begin with "-", and after "--" every word is an id, a flag's name
// included.
// Each verb that takes ids sends one given after "--" as it was given.
func TestAnIdAfterDoubleDashIsSentAsGiven(t *testing.T) {
	var generation []string
	for _, param := range readSpecSchema(t, "GenerationJobRequest.json").Required {
		generation = append(generation, yieldJobFlags.flagOf(param), "given")
	}
	for _, id := range []string{"-BA3nvXTk3ybl1Qmp_3zZ", "--U7e91g4-lXp-zRMg9qr", "--json"} {
		annotation, resource := `"annotationId":"`+id+`"`, `"resourceId":"`+id+`"`
		for _, c := range []struct {
			name string
			run  func([]string) int
			args []string
			sent string
		}{
			{"bind", Bind, []string{"--", "res-1", id, "res-2"}, annotation},
			{"bind --unbind", Bind, []string{"--unbind", "res-2", "--", "res-1", id}, annotation},
			{"gather", Gather, []string{"--", "res-1", id}, annotation},
			{"match", Match, []string{"--", "res-1", id}, annotation},
			{"yield --delegate", Yield, append(append([]string{"--delegate"}, generation...), "--", "res-1", id), annotation},
			{"browse", Browse, []string{"--", id}, resource},
			{"mark", Mark, []string{"--body-text", "a note", "--", id}, resource},
			{"beckon", Beckon, []string{"--annotation", "ann-1", "--", id}, resource},
		} {
			t.Run(c.name+" "+id, func(t *testing.T) {
				fake, restore := withFake(t)
				defer restore()
				// Only the first thing sent is this test's: no reply is
				// scripted, and what a verb makes of one is its own tests'.
				harness.CaptureOutput(t, func() { c.run(c.args) })
				var sent string
				switch {
				case len(fake.RequestLog()) > 0:
					sent = string(fake.RequestLog()[0].Payload)
				case len(signals(fake)) > 0:
					sent = string(signals(fake)[0].Payload)
				default:
					t.Fatalf("%v sent nothing", c.args)
				}
				harness.MustContainAll(t, "what was sent", sent, c.sent)
			})
		}
	}
}

// Before "--", a word that begins with "-" and is none of a verb's options is
// refused, a mistyped flag and a bare id alike, and the refusal shows the
// verb's form for an id that begins with "-".
func TestAWordThatIsNoOptionIsRefusedShowingDoubleDash(t *testing.T) {
	for _, word := range []string{"--jsno", "-BA3nvXTk3ybl1Qmp_3zZ"} {
		for _, c := range []struct {
			name string
			run  func([]string) int
			args []string
			form string
		}{
			{"bind", Bind, []string{"res-1", word, "res-2"}, "semiont bind [options] -- <resourceId> <annotationId> <targetResourceId>"},
			{"gather", Gather, []string{"res-1", word}, "semiont gather [options] -- <resourceId> [<annotationId>]"},
			{"match", Match, []string{"res-1", word}, "semiont match [options] -- <resourceId> <annotationId>"},
			{"yield --delegate", Yield, []string{"--delegate", "res-1", word}, "semiont yield --delegate [options] -- <resourceId> [<annotationId>]"},
			{"browse", Browse, []string{word}, "semiont browse [options] -- <resourceId>"},
			{"mark", Mark, []string{word}, "semiont mark [options] -- <resourceId>"},
			{"beckon", Beckon, []string{word}, "semiont beckon [options] -- <resourceId> [<annotationId>]"},
		} {
			t.Run(c.name+" "+word, func(t *testing.T) {
				fake, restore := withFake(t)
				defer restore()
				out, errOut := harness.CaptureOutput(t, func() {
					if code := c.run(c.args); code == 0 {
						t.Fatal("must refuse")
					}
				})
				harness.MustContainAll(t, "refusal", out+errOut,
					"Unknown argument: "+word, "Every word after -- is an id", c.form)
				if len(fake.RequestLog())+len(signals(fake)) != 0 {
					t.Errorf("a refused argument still reached the wire: %v %v", ops(fake), signals(fake))
				}
			})
		}
	}
}

// Each verb that takes ids shows, in its help, that an id is given by its
// option or bare, and the form an id that begins with "-" is given in.
func TestEachVerbsHelpShowsHowIdsAreGiven(t *testing.T) {
	for _, c := range []struct {
		name string
		run  func([]string) int
		args []string
	}{
		{"bind", Bind, []string{"--help"}},
		{"gather", Gather, []string{"--help"}},
		{"match", Match, []string{"--help"}},
		{"yield --delegate", Yield, []string{"--delegate", "--help"}},
		{"browse", Browse, []string{"--help"}},
		{"mark", Mark, []string{"--help"}},
		{"mark --delegate", Mark, []string{"--delegate", "--help"}},
		{"beckon", Beckon, []string{"--help"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			out := harness.CaptureStdout(t, func() { c.run(c.args) })
			harness.MustContainAll(t, "help", out,
				"--resource <id>", "Bare ids fill, in order", "Every word after -- is an id", " -- <resourceId>")
		})
	}
}

// Each id a verb takes may be given by its option or bare, the same way in
// every verb that takes it, and the bare ids fill, in order, the places no
// option filled.
func TestAnIdIsGivenByItsOptionOrBare(t *testing.T) {
	var generation []string
	for _, param := range readSpecSchema(t, "GenerationJobRequest.json").Required {
		generation = append(generation, yieldJobFlags.flagOf(param), "given")
	}
	ann := "-BA3nvXTk3ybl1Qmp_3zZ"
	resource, annotation := `"resourceId":"res-1"`, `"annotationId":"`+ann+`"`
	for _, c := range []struct {
		name string
		run  func([]string) int
		args []string
		sent []string
	}{
		{"bind by option", Bind, []string{"--resource", "res-1", "--annotation", ann, "--target", "res-2"}, []string{resource, annotation, `"source":"res-2"`, `"op":"add"`}},
		{"bind, options and bare", Bind, []string{"--annotation", ann, "res-1", "res-2"}, []string{resource, annotation, `"source":"res-2"`}},
		{"bind --unbind, options and bare", Bind, []string{"--unbind", "res-2", "--annotation", ann, "res-1"}, []string{resource, annotation, `"source":"res-2"`, `"op":"remove"`}},
		{"gather by option", Gather, []string{"--resource", "res-1", "--annotation", ann}, []string{resource, annotation}},
		{"gather, options and bare", Gather, []string{"--annotation", ann, "res-1"}, []string{resource, annotation}},
		{"match by option", Match, []string{"--resource", "res-1", "--annotation", ann}, []string{resource, annotation}},
		{"match, options and bare", Match, []string{"--annotation", ann, "res-1"}, []string{resource, annotation}},
		{"yield --delegate by option", Yield, append(append([]string{"--delegate"}, generation...), "--resource", "res-1", "--annotation", ann), []string{resource, annotation}},
		{"browse by option", Browse, []string{"--resource", "res-1"}, []string{resource}},
		{"mark by option", Mark, []string{"--resource", "res-1", "--body-text", "a note"}, []string{resource}},
		{"mark --delete, the resource bare", Mark, []string{"--delete", ann, "res-1"}, []string{resource, annotation}},
		{"beckon, the annotation bare", Beckon, []string{"res-1", "--", ann}, []string{resource, annotation}},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			// Only the first thing sent is this test's: no reply is
			// scripted, and what a verb makes of one is its own tests'.
			harness.CaptureOutput(t, func() { c.run(c.args) })
			var sent string
			switch {
			case len(fake.RequestLog()) > 0:
				sent = string(fake.RequestLog()[0].Payload)
			case len(signals(fake)) > 0:
				sent = string(signals(fake)[0].Payload)
			default:
				t.Fatalf("%v sent nothing", c.args)
			}
			harness.MustContainAll(t, "what was sent", sent, c.sent...)
		})
	}
}

// An id given twice, by any two of its options, is refused, and so
// is a bare word with no place left; neither reaches the wire.
func TestAnIdGivenTwiceOrABareWordTooManyIsRefused(t *testing.T) {
	for _, c := range []struct {
		name string
		run  func([]string) int
		args []string
		want string
	}{
		{"bind, the resource twice", Bind, []string{"--resource", "res-1", "--resource", "res-2", "ann-1", "res-3"}, "The resource is given twice"},
		{"bind, --target and --unbind", Bind, []string{"--target", "res-2", "--unbind", "res-3", "res-1", "ann-1"}, "The target is given twice"},
		{"bind, a bare word too many", Bind, []string{"res-1", "ann-1", "res-2", "x"}, "semiont bind [options] -- <resourceId> <annotationId> <targetResourceId>"},
		{"gather, a bare word too many", Gather, []string{"--annotation", "ann-1", "res-1", "x"}, "Unexpected argument: x"},
		{"match, the annotation twice", Match, []string{"--annotation", "ann-1", "--annotation", "ann-2", "res-1"}, "The annotation is given twice"},
		{"yield --delegate, a bare word too many", Yield, []string{"--delegate", "res-1", "ann-1", "x"}, "Unexpected argument: x"},
		{"browse, a bare word too many", Browse, []string{"--resource", "res-1", "x"}, "Unexpected argument: x"},
		{"mark, the resource twice", Mark, []string{"--resource", "res-1", "--resource", "res-2"}, "The resource is given twice"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake, restore := withFake(t)
			defer restore()
			out, errOut := harness.CaptureOutput(t, func() {
				if code := c.run(c.args); code == 0 {
					t.Fatal("must refuse")
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, c.want)
			if len(fake.RequestLog())+len(signals(fake)) != 0 {
				t.Errorf("a refused argument still reached the wire: %v %v", ops(fake), signals(fake))
			}
		})
	}
}
