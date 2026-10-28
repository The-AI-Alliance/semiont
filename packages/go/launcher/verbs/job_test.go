package verbs

// What a delegated job is asked with and what it reports, read from the spec:
// the members of each verb's result union, and the parameters a yield job
// takes.

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// A verb's result has no discriminant: each of its two members is told from
// the other by the members it alone carries. Each is read as its own type, and
// a result that is not exactly one of the verb's is an error: the other verb's
// result among them.
// resourceIdOf and jobIdOf are a test's ids, made as every id is: through
// the kind's rule.
func resourceIdOf(t *testing.T, text string) api.ResourceId {
	t.Helper()
	id, err := api.ParseResourceId(text)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func jobIdOf(t *testing.T, text string) api.JobId {
	t.Helper()
	id, err := api.ParseJobId(text)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestJobResultIsReadAsItsVerbs(t *testing.T) {
	const counts, resource, decline = `{"found":4,"persisted":3}`, `{"resourceId":"res-new","resourceName":"Generated","truncated":false}`, `{"declined":true,"reason":"encrypted"}`
	declined := api.JobDeclined{Declined: true, Reason: "encrypted"}
	for _, c := range []struct {
		name, result string
		mark, yield  any // nil: an error
	}{
		{"a mark job's counts", counts, api.MarkJobDone{Found: 4, Persisted: 3}, nil},
		{"the resource a yield job made", resource, nil, api.YieldJobDone{ResourceId: resourceIdOf(t, "res-new"), ResourceName: "Generated"}},
		{"a decline", decline, declined, declined},
		{"no member's required members", `{}`, nil, nil},
		{"half of a member's required members", `{"found":4,"resourceId":"res-new"}`, nil, nil},
		{"both members' required members", `{"found":4,"persisted":3,"resourceId":"res-new","resourceName":"Generated","truncated":false,"declined":true,"reason":"empty"}`, nil, nil},
	} {
		var asMark api.MarkJobResult
		var asYield api.YieldJobResult
		if asMark.UnmarshalJSON([]byte(c.result)) != nil || asYield.UnmarshalJSON([]byte(c.result)) != nil {
			t.Fatalf("%s: not JSON: %s", c.name, c.result)
		}
		gotMark, errMark := jobResult(&asMark, markJobResults)
		gotYield, errYield := jobResult(&asYield, yieldJobResults)
		for _, read := range []struct {
			verb  string
			got   any
			err   error
			want  any
			words string // what a refusal says the result is not
		}{
			{"mark", gotMark, errMark, c.mark, "a result that is neither a mark job's counts nor a decline"},
			{"yield", gotYield, errYield, c.yield, "a result that is neither the resource a yield job made nor a decline"},
		} {
			switch {
			case read.want == nil && read.err == nil:
				t.Errorf("%s: a %s job's result %s is read as %#v, want an error", c.name, read.verb, c.result, read.got)
			case read.want != nil && (read.err != nil || !reflect.DeepEqual(read.got, read.want)):
				t.Errorf("%s: a %s job's result %s is read as %#v (%v), want %#v", c.name, read.verb, c.result, read.got, read.err, read.want)
			case read.err != nil && !strings.Contains(read.err.Error(), read.words+": "+c.result):
				t.Errorf("%s: a %s job's result %s is refused with %q, want it to say %q and the result", c.name, read.verb, c.result, read.err, read.words)
			}
		}
	}
	// A completion may report nothing: its schema does not require a result.
	if got, err := jobResult[api.MarkJobResult](nil, markJobResults); got != nil || err != nil {
		t.Errorf("a completion with no result is read as %#v (%v)", got, err)
	}
}

// heldToItsUnion: a verb's list of result members is the spec's union of that
// name, R's own.
func heldToItsUnion[R json.Marshaler](t *testing.T, members resultMembers[R]) {
	t.Helper()
	union := reflect.TypeFor[R]().Name()
	var read, stated []string
	for _, member := range members {
		read = append(read, reflect.TypeOf(member.generated).Name())
		// What the terminal calls a member is plain words, and no type's name.
		if member.called == "" || strings.Contains(member.called, "Job") {
			t.Errorf("%s is called %q in the terminal", read[len(read)-1], member.called)
		}
	}
	for _, member := range readSpecSchema(t, union+".json").OneOf {
		stated = append(stated, strings.TrimSuffix(filepath.Base(member.Ref), ".json"))
	}
	sort.Strings(read)
	sort.Strings(stated)
	if len(stated) == 0 || !reflect.DeepEqual(read, stated) {
		t.Errorf("the launcher reads %v; the spec's %s is one of %v", read, union, stated)
	}
}

// Each verb reads the members it lists, and the unions are the spec's: a
// member the spec gains fails here until the launcher reads it.
func TestJobResultReadsEveryMemberOfItsVerbsUnion(t *testing.T) {
	heldToItsUnion(t, markJobResults)
	heldToItsUnion(t, yieldJobResults)
}

// The nouns are the launcher's; the motivations are the spec's. Every
// motivation has a noun and no noun is for a motivation that is none.
func TestEveryMotivationHasItsNoun(t *testing.T) {
	motivations := readSpecSchema(t, "Motivation.json").Enum
	if len(motivations) == 0 {
		t.Fatal("the spec's motivations could not be read")
	}
	stated := map[api.Motivation]bool{}
	for _, motivation := range motivations {
		stated[api.Motivation(motivation)] = true
		if markNouns[api.Motivation(motivation)] == "" {
			t.Errorf("the motivation %q has no noun", motivation)
		}
	}
	for motivation, noun := range markNouns {
		if !stated[motivation] {
			t.Errorf("the noun %q is for %q, which is no motivation", noun, motivation)
		}
	}
}

// What the terminal says a completed mark job did, for each motivation: the
// words its last progress line says, each with its singular.
func TestMarkedTextSaysWhatAMarkJobDid(t *testing.T) {
	one, issue := 1, map[string]int{"rule": 4, "issue": 2}
	for _, c := range []struct {
		motivation api.Motivation
		result     api.MarkJobDone
		want       string
	}{
		{"highlighting", api.MarkJobDone{Found: 4, Persisted: 3}, "created 3 highlights (4 found)"},
		{"commenting", api.MarkJobDone{Found: 2, Persisted: 2}, "created 2 comments (2 found)"},
		{"assessing", api.MarkJobDone{Found: 1, Persisted: 1}, "created 1 assessment (1 found)"},
		{"linking", api.MarkJobDone{Found: 5, Persisted: 4, Errors: &one}, "created 4 references (5 found, 1 error)"},
		{"tagging", api.MarkJobDone{Found: 6, Persisted: 6, ByCategory: &issue}, "created 6 tags (6 found): issue 2, rule 4"},
	} {
		if got := markedText(c.motivation, c.result); got != c.want {
			t.Errorf("%s: %q, want %q", c.motivation, got, c.want)
		}
		// The last line counts what the job's last progress message counted,
		// in the words that message is given.
		var created api.JobProgressMessage
		if err := created.FromJobProgressCompleteCreated(api.JobProgressCompleteCreated{Count: c.result.Persisted, Motivation: c.motivation}); err != nil {
			t.Fatalf("%s: not a progress message: %v", c.motivation, err)
		}
		progress := progressText(&created)
		if lower := strings.ToLower(progress[:1]) + progress[1:]; !strings.HasPrefix(c.want, lower+" (") {
			t.Errorf("%s: the progress line says %q and the last line %q", c.motivation, progress, c.want)
		}
	}
}

// The flag table is the launcher's; the parameters are the spec's. Every flag
// gives a parameter a yield job is asked with, of a type the flag reads, and
// every parameter the job requires of its caller has a flag: one the spec
// comes to require fails here until it has one.
func TestEveryYieldJobFlagGivesAParameter(t *testing.T) {
	request := readSpecSchema(t, "GenerationJobRequest.json")
	if len(request.Properties) == 0 || len(request.Required) == 0 {
		t.Fatal("the spec's GenerationJobRequest could not be read: this test would pass for the wrong reason")
	}
	for name, flag := range yieldJobFlags {
		property, named := request.Properties[flag.param]
		if !named {
			t.Errorf("%s gives %q, which a yield job is not asked with", name, flag.param)
			continue
		}
		if property.Type != "string" || flag.kind != flagText {
			t.Errorf("%s reads a text for %q, which is a %s", name, flag.param, property.Type)
		}
	}
	for _, param := range request.Required {
		if yieldJobFlags.flagOf(param) == "" {
			t.Errorf("a yield job requires %q, and no flag gives it", param)
		}
	}
}

// What a yield job requires of its caller is refused before anything is
// gathered, naming the flag: the caller has not yet paid for a gather.
func TestYieldDelegateRefusesAMissingParameterBeforeGathering(t *testing.T) {
	request := readSpecSchema(t, "GenerationJobRequest.json")
	for _, missing := range request.Required {
		args := []string{"--delegate", "res-1"}
		for _, param := range request.Required {
			if param != missing {
				args = append(args, yieldJobFlags.flagOf(param), "given")
			}
		}
		// An empty value gives nothing.
		for _, args := range [][]string{args, append(append([]string{}, args...), yieldJobFlags.flagOf(missing), "")} {
			fake, restore := withFake(t)
			out, errOut := harness.CaptureOutput(t, func() {
				if code := Yield(args); code == 0 {
					t.Errorf("%v: must refuse", args)
				}
			})
			harness.MustContainAll(t, "refusal", out+errOut, "--delegate needs "+yieldJobFlags.flagOf(missing))
			if len(fake.RequestLog()) != 0 {
				t.Errorf("%v: refused, and still asked for %v", args, ops(fake))
			}
			restore()
		}
	}
}
