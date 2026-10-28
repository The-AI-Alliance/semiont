package semiont

// What of following a job an outside test cannot reach: a delegation made
// of a follower that ends early, the stall a generation is allowed, and each
// verb's result union.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

func TestAFollowerThatEndsOnAnythingButACompletionIsNoCompletion(t *testing.T) {
	life, end := context.WithCancel(context.Background())
	defer end()
	early := &Delegation[api.MarkJobCompleteCommand]{following: &Running[JobEvent]{
		links: &links{life: life, end: end},
		work: func(context.Context, func(JobEvent)) (JobEvent, error) {
			return JobProgressed{Data: api.JobProgress{Percentage: 50}}, nil
		},
	}}
	if _, err := early.Wait(context.Background()); err == nil || !strings.Contains(err.Error(), "not on its completion") {
		t.Fatalf("a follower that ended on progress gave %v", err)
	}
}

func TestHowLongAGenerationMayBeSilentGrowsWithWhatWasAskedOfIt(t *testing.T) {
	timing := DefaultTiming()
	tokens := func(n float64) *float64 { return &n }
	for _, c := range []struct {
		name      string
		maxTokens *float64
		wantMs    int64
	}{
		{"nothing stated", nil, timing.GenerationStallFloor.Milliseconds()},
		{"a short length", tokens(100), timing.GenerationStallFloor.Milliseconds()},
		{"a long length", tokens(4000), 300_000},
		{"a length with a fraction", tokens(4000.4), 300_030},
		{"a length below nothing", tokens(-5), timing.GenerationStallFloor.Milliseconds()},
	} {
		if got := generationStallDeadline(timing, c.maxTokens).Milliseconds(); got != c.wantMs {
			t.Errorf("%s: a generation may be silent for %dms, want %dms", c.name, got, c.wantMs)
		}
	}
}

// specSchema is a schema of specs/src/components/schemas.
func specSchema(t *testing.T, name string) map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "components", "schemas", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]json.RawMessage
	if err := json.Unmarshal(b, &schema); err != nil {
		t.Fatal(err)
	}
	return schema
}

// Each verb's members are its result union's in the spec, and every verb has
// them: a member or a verb the spec gains fails here until the follower reads
// it.
func TestEachVerbsResultMembersAreTheSpecsUnion(t *testing.T) {
	var verbs []string
	if err := json.Unmarshal(specSchema(t, "JobType")["enum"], &verbs); err != nil {
		t.Fatal(err)
	}
	var read []string
	for verb := range resultMembers {
		read = append(read, string(verb))
	}
	slices.Sort(verbs)
	slices.Sort(read)
	if !slices.Equal(read, verbs) {
		t.Fatalf("the follower reads the results of %v; a job's verbs are %v", read, verbs)
	}
	for verb, members := range resultMembers {
		union := strings.ToUpper(string(verb[:1])) + string(verb[1:]) + "JobResult"
		var oneOf []struct {
			Ref string `json:"$ref"`
		}
		if err := json.Unmarshal(specSchema(t, union)["oneOf"], &oneOf); err != nil {
			t.Fatal(err)
		}
		var stated, named []string
		for _, member := range oneOf {
			stated = append(stated, strings.TrimSuffix(filepath.Base(member.Ref), ".json"))
		}
		for _, member := range members {
			named = append(named, member.Name())
		}
		slices.Sort(stated)
		slices.Sort(named)
		if len(stated) == 0 || !slices.Equal(named, stated) {
			t.Errorf("the follower reads a %s job's result as one of %v; the spec's %s is one of %v", verb, named, union, stated)
		}
	}
}

// A verb's result has no discriminant: each of its two members is told from
// the other by the members it alone requires, and a result that is not
// exactly one of the verb's is none: the other verb's among them.
func TestAResultIsReadAsExactlyOneOfItsVerbsMembers(t *testing.T) {
	for _, c := range []struct {
		name, result string
		mark, yield  bool
	}{
		{"a mark job's counts", `{"found":4,"persisted":3}`, true, false},
		{"the resource a yield job made", `{"resourceId":"res-new","resourceName":"Generated","truncated":false}`, false, true},
		{"a decline", `{"declined":true,"reason":"encrypted"}`, true, true},
		{"no member's required members", `{}`, false, false},
		{"half of a member's required members", `{"found":4,"resourceId":"res-new"}`, false, false},
		{"both members' required members", `{"found":4,"persisted":3,"resourceId":"res-new","resourceName":"Generated","truncated":false,"declined":true,"reason":"empty"}`, false, false},
		{"not an object", `"done"`, false, false},
	} {
		for verb, want := range map[api.JobType]bool{api.JobTypeMark: c.mark, api.JobTypeYield: c.yield} {
			if got := isVerbsResult(verb, []byte(c.result)); got != want {
				t.Errorf("%s: a %s job's result %s is read as its verb's: %v, want %v", c.name, verb, c.result, got, want)
			}
		}
	}
}

// What a type requires is what the generator writes without omitempty: a
// payload lacking one is not read as that type.
func TestAPayloadIsReadAsATypeOnlyWhenItCarriesWhatTheTypeRequires(t *testing.T) {
	if got := required.Of(reflect.TypeFor[api.JobReportProgressCommand]()); !slices.Equal(slices.Sorted(slices.Values(got)), []string{"jobId", "jobType", "percentage", "resourceId"}) {
		t.Fatalf("a progress report requires %v", got)
	}
	if _, ok := required.ReadAs[api.JobReportProgressCommand]([]byte(`{"jobId":"job-1","jobType":"mark","resourceId":"res-1","percentage":10}`)); !ok {
		t.Fatal("a progress report with what it requires is not read")
	}
	if _, ok := required.ReadAs[api.JobReportProgressCommand]([]byte(`{"jobId":"job-1","jobType":"mark","percentage":10}`)); ok {
		t.Fatal("a progress report with no resource is read")
	}
}
