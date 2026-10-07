package verbs

// What a delegated job is asked with and what it reports, read from the spec:
// the members of the JobResult union, and the parameters a yield job takes.

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

func completedWith(t *testing.T, result string) semiont.JobCompleteCommand {
	t.Helper()
	var done semiont.JobCompleteCommand
	if err := json.Unmarshal([]byte(`{"jobId":"job-1","jobType":"mark","resourceId":"res-1","result":`+result+`}`), &done); err != nil {
		t.Fatalf("not a job:complete: %v", err)
	}
	return done
}

// A result has no discriminant: it is told from the others by the members it
// alone carries. Each is read as its own type and as no other, and an object
// that is none of them is read as none.
func TestJobResultIsReadByItsMembers(t *testing.T) {
	for _, c := range []struct {
		name, result string
		want         any
	}{
		{"a mark job's counts", `{"found":4,"persisted":3}`, semiont.JobDetectionResult{Found: 4, Persisted: 3}},
		{"a resource a yield job made", `{"resourceId":"res-new","resourceName":"Generated","truncated":false}`,
			semiont.JobGenerationResult{ResourceId: "res-new", ResourceName: "Generated"}},
		{"a decline", `{"declined":true,"reason":"encrypted"}`, semiont.JobDeclinedResult{Declined: true, Reason: "encrypted"}},
		{"no member's required members", `{}`, nil},
		{"half of a member's required members", `{"found":4}`, nil},
		{"two members' required members", `{"found":4,"persisted":3,"declined":true,"reason":"empty"}`, nil},
	} {
		if got := jobResult(completedWith(t, c.result)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %s is read as %#v, want %#v", c.name, c.result, got, c.want)
		}
	}
	if got := jobResult(semiont.JobCompleteCommand{}); got != nil {
		t.Errorf("a completion with no result is read as %#v", got)
	}
}

// jobResult reads the members it lists, and the union is the spec's: a member
// the spec gains fails here until the launcher reads it.
func TestJobResultReadsEveryMemberOfTheUnion(t *testing.T) {
	var read, stated []string
	for _, member := range jobResultMembers {
		read = append(read, reflect.TypeOf(member).Name())
	}
	for _, member := range readSpecSchema(t, "JobResult.json").OneOf {
		stated = append(stated, strings.TrimSuffix(filepath.Base(member.Ref), ".json"))
	}
	sort.Strings(read)
	sort.Strings(stated)
	if len(stated) == 0 || !reflect.DeepEqual(read, stated) {
		t.Errorf("jobResult reads %v; the spec's JobResult is one of %v", read, stated)
	}
}

// What the terminal says a completed mark job did, for each motivation.
func TestMarkedTextSaysWhatAMarkJobDid(t *testing.T) {
	one, issue := 1, map[string]int{"rule": 4, "issue": 2}
	for _, c := range []struct {
		motivation string
		result     semiont.JobDetectionResult
		want       string
	}{
		{"highlighting", semiont.JobDetectionResult{Found: 4, Persisted: 3}, "3 highlighting annotations created (4 found)"},
		{"assessing", semiont.JobDetectionResult{Found: 1, Persisted: 1}, "1 assessing annotation created (1 found)"},
		{"linking", semiont.JobDetectionResult{Found: 5, Persisted: 4, Errors: &one}, "4 linking annotations created (5 found, 1 error)"},
		{"tagging", semiont.JobDetectionResult{Found: 6, Persisted: 6, ByCategory: &issue}, "6 tagging annotations created (6 found): issue 2, rule 4"},
	} {
		if got := markedText(c.motivation, c.result); got != c.want {
			t.Errorf("%s: %q, want %q", c.motivation, got, c.want)
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
			if len(fake.Requests) != 0 {
				t.Errorf("%v: refused, and still asked for %v", args, fake.Ops())
			}
			restore()
		}
	}
}
