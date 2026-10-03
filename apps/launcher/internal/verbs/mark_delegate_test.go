package verbs

// The delegated form of mark: the stack's worker reads a resource and
// annotates it. What a client sends for each motivation is the spec's to say
// (the `mark.assist` row of specs/src/client/surface.json, which the
// TypeScript and Rust SDKs run too), so these tests read it from there.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

func specFile(t *testing.T, path ...string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(append([]string{"..", "..", "..", "..", "specs", "src"}, path...)...))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type surfaceCase struct {
	Why   string          `json:"why"`
	Args  json.RawMessage `json:"args"`
	Sends json.RawMessage `json:"sends"`
}

// surfaceCases: the cases the client surface states for one method.
func surfaceCases(t *testing.T, namespace, method string) []surfaceCase {
	t.Helper()
	var surface struct {
		Namespaces []struct {
			Namespace string `json:"namespace"`
			Methods   []struct {
				Method string        `json:"method"`
				Cases  []surfaceCase `json:"cases"`
			} `json:"methods"`
		} `json:"namespaces"`
	}
	if err := json.Unmarshal(specFile(t, "client", "surface.json"), &surface); err != nil {
		t.Fatal(err)
	}
	for _, n := range surface.Namespaces {
		if n.Namespace != namespace {
			continue
		}
		for _, m := range n.Methods {
			if m.Method == method {
				return m.Cases
			}
		}
	}
	t.Fatalf("the client surface has no %s.%s", namespace, method)
	return nil
}

func TestMarkDelegateSendsWhatTheClientSurfaceSays(t *testing.T) {
	cases := surfaceCases(t, "mark", "assist")
	if len(cases) == 0 {
		t.Fatal("the client surface states no cases for mark.assist: this test would pass for the wrong reason")
	}
	asked := map[semiont.Motivation]bool{}
	for _, c := range cases {
		var args struct {
			ResourceId string             `json:"resourceId"`
			Motivation semiont.Motivation `json:"motivation"`
			Options    assistOptions      `json:"options"`
		}
		// Strict: an option the surface states and assistOptions lacks is a
		// failure here, not a field quietly dropped.
		dec := json.NewDecoder(bytes.NewReader(c.Args))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&args); err != nil {
			t.Errorf("%s: the case's arguments do not fit what a delegated mark takes: %v", c.Args, err)
			continue
		}
		asked[args.Motivation] = true
		command, err := assistJob(args.ResourceId, args.Motivation, args.Options)
		if err != nil {
			t.Errorf("%s: refused: %v", c.Args, err)
			continue
		}
		sent, err := json.Marshal(command)
		if err != nil {
			t.Fatal(err)
		}
		var got, want any
		if json.Unmarshal(sent, &got) != nil || json.Unmarshal(c.Sends, &want) != nil {
			t.Fatalf("not JSON: %s or %s", sent, c.Sends)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s\n sends %s\n want  %s", c.Args, sent, c.Sends)
		}
	}
	// Every motivation the spec names can be delegated, and the surface says
	// what each sends.
	var motivations struct {
		Enum []semiont.Motivation `json:"enum"`
	}
	if err := json.Unmarshal(specFile(t, "components", "schemas", "Motivation.json"), &motivations); err != nil || len(motivations.Enum) == 0 {
		t.Fatalf("the spec's motivations could not be read: %v", err)
	}
	for _, m := range motivations.Enum {
		if !asked[m] {
			t.Errorf("the client surface has no mark.assist case for the motivation %q", m)
		}
		if _, err := assistJob("res-1", m, assistOptions{EntityTypes: []string{"Person"}, SchemaId: "s1", Categories: []string{"claim"}}); err != nil {
			t.Errorf("the motivation %q cannot be delegated: %v", m, err)
		}
	}
}

// What the SDKs refuse before asking, a delegated mark refuses too: a job the
// dispatcher would turn away, or one that would find nothing to do.
func TestMarkDelegateRefusalsInProcess(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want string
	}{
		{"no motivation", []string{"--delegate", "res-1"}, "--motivation"},
		{"an unknown motivation", []string{"--delegate", "res-1", "--motivation", "bookmarking"}, "highlighting"},
		{"no resource", []string{"--delegate", "--motivation", "highlighting"}, "resource"},
		{"two resources", []string{"--delegate", "res-1", "res-2", "--motivation", "highlighting"}, "one resource"},
		{"linking names no entity type", []string{"--delegate", "res-1", "--motivation", "linking"}, "--entity-type"},
		{"tagging names no schema", []string{"--delegate", "res-1", "--motivation", "tagging", "--category", "claim"}, "--schema"},
		{"tagging names no category", []string{"--delegate", "res-1", "--motivation", "tagging", "--schema", "s1"}, "--category"},
		{"a density that is not a number", []string{"--delegate", "res-1", "--motivation", "highlighting", "--density", "lots"}, "--density"},
		{"a density of nothing", []string{"--delegate", "res-1", "--motivation", "highlighting", "--density", "0"}, "--density"},
		{"an unknown tone", []string{"--delegate", "res-1", "--motivation", "commenting", "--tone", "sarcastic"}, "--delegate --help"},
		{"a selector is the hand form's", []string{"--delegate", "res-1", "--motivation", "highlighting", "--quote", "x"}, "--quote"},
		{"a body is the hand form's", []string{"--delegate", "res-1", "--motivation", "commenting", "--body-text", "x"}, "--body-text"},
		{"a tone is the delegated form's", []string{"res-1", "--tone", "scholarly"}, "--delegate"},
		{"a schema is the delegated form's", []string{"res-1", "--schema", "s1"}, "--delegate"},
		{"delegating a delete", []string{"--delegate", "--delete", "ann-1", "--resource", "res-1", "--motivation", "highlighting"}, "--delete"},
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

// The help names every motivation and every tone the spec does, so a value
// the spec gains is one the help is made to offer.
func TestMarkDelegateHelpNamesTheSpecsVocabulary(t *testing.T) {
	var motivations struct {
		Enum []string `json:"enum"`
	}
	if err := json.Unmarshal(specFile(t, "components", "schemas", "Motivation.json"), &motivations); err != nil {
		t.Fatal(err)
	}
	var assist struct {
		Properties struct {
			Options struct {
				Properties struct {
					Tone struct {
						Enum []string `json:"enum"`
					} `json:"tone"`
				} `json:"properties"`
			} `json:"options"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(specFile(t, "components", "schemas", "MarkAssistRequestEvent.json"), &assist); err != nil {
		t.Fatal(err)
	}
	tones := assist.Properties.Options.Properties.Tone.Enum
	if len(motivations.Enum) == 0 || len(tones) == 0 {
		t.Fatalf("the spec's vocabulary could not be read: %d motivations, %d tones", len(motivations.Enum), len(tones))
	}
	harness.MustContainAll(t, "mark --delegate --help", markDelegateUsage, motivations.Enum...)
	harness.MustContainAll(t, "mark --delegate --help", markDelegateUsage, tones...)
	out := harness.CaptureStdout(t, func() {
		if code := Mark([]string{"--delegate", "--help"}); code != 0 {
			t.Fatalf("mark --delegate --help: exit %d", code)
		}
	})
	if out != markDelegateUsage {
		t.Errorf("mark --delegate --help printed something other than its usage:\n%s", out)
	}
}

// A delegated tagging pass needs a schema's id and its categories, so the
// launcher can list them.
func TestBrowseTagSchemasListsEachSchemaAndItsCategories(t *testing.T) {
	fake, restore := withFake(t)
	defer restore()
	fake.Replies["browse:tag-schemas-requested"] = reply(`{"tagSchemas":[` +
		`{"id":"legal-irac","name":"IRAC","description":"Legal analysis","domain":"legal","tags":[` +
		`{"name":"issue","description":"The question","examples":[]},{"name":"rule","description":"The law","examples":[]}]}]}`)

	out := harness.CaptureStdout(t, func() {
		if code := Browse([]string{"--tag-schemas"}); code != 0 {
			t.Fatalf("browse --tag-schemas: exit %d", code)
		}
	})
	harness.MustContainAll(t, "listing", out, "legal-irac", "IRAC", "issue", "rule")
	if ops := fake.Ops(); len(ops) != 1 || ops[0] != "browse:tag-schemas-requested" {
		t.Errorf("want one browse:tag-schemas-requested, got %v", ops)
	}
}
