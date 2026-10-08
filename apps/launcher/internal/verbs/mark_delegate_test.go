package verbs

// The delegated form of mark: the stack's worker reads a resource and
// annotates it. What a client sends for each motivation is the spec's to say
// (the `mark.delegate` row of specs/src/client/surface.json, which the
// TypeScript, Rust and Python SDKs run too), so these tests read it from
// there.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

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

// specSchema: one schema of the spec, as far as these tests read it.
type specSchema struct {
	OneOf []struct {
		Ref string `json:"$ref"`
	} `json:"oneOf"`
	Enum       []string `json:"enum"`
	Required   []string `json:"required"`
	Properties map[string]struct {
		Type string   `json:"type"`
		Enum []string `json:"enum"`
	} `json:"properties"`
}

func readSpecSchema(t *testing.T, file string) specSchema {
	t.Helper()
	var schema specSchema
	if err := json.Unmarshal(specFile(t, "components", "schemas", file), &schema); err != nil {
		t.Fatalf("%s could not be read: %v", file, err)
	}
	return schema
}

// markJobSchemas: the schema of each motivation's mark job, by motivation, as
// the MarkJobParams union names them.
func markJobSchemas(t *testing.T) map[semiont.Motivation]specSchema {
	t.Helper()
	schemas := map[semiont.Motivation]specSchema{}
	for _, member := range readSpecSchema(t, "MarkJobParams.json").OneOf {
		schema := readSpecSchema(t, filepath.Base(member.Ref))
		motivation := schema.Properties["motivation"].Enum
		if len(motivation) != 1 {
			t.Fatalf("%s states %d motivations, want the one it is for", member.Ref, len(motivation))
		}
		schemas[semiont.Motivation(motivation[0])] = schema
	}
	if len(schemas) == 0 {
		t.Fatal("the spec's MarkJobParams names no member: these tests would pass for the wrong reason")
	}
	return schemas
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

// flagsFor: the arguments a caller types to give a job these parameters. A
// parameter no flag gives, or a value its flag cannot say, fails the test.
func flagsFor(t *testing.T, flags jobFlags, params map[string]any) []string {
	t.Helper()
	var argv []string
	for _, param := range sortedNames(params) {
		flag := flags.flagOf(param)
		if flag == "" {
			t.Fatalf("no flag gives the parameter %q", param)
		}
		switch value := params[param].(type) {
		case string:
			argv = append(argv, flag, value)
		case float64:
			argv = append(argv, flag, strconv.FormatFloat(value, 'g', -1, 64))
		case bool:
			if !value {
				t.Fatalf("%s cannot say %q is false", flag, param)
			}
			argv = append(argv, flag)
		case []any:
			for _, item := range value {
				argv = append(argv, flag, item.(string))
			}
		default:
			t.Fatalf("%s cannot say %q is %v", flag, param, value)
		}
	}
	return argv
}

// givenBy: what a verb's job flags read from the arguments.
func givenBy(t *testing.T, flags jobFlags, argv []string) map[string]any {
	t.Helper()
	u := launcher.NewUI(false)
	given := map[string]any{}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		val := func() (string, bool) {
			if i+1 >= len(argv) {
				return "", false
			}
			i++
			return argv[i], true
		}
		if taken, ok := flags.take(u, a, val, given); !taken || !ok {
			t.Fatalf("%s was not read as a job flag (taken %v, ok %v) in %v", a, taken, ok, argv)
		}
	}
	return given
}

func TestMarkDelegateSendsWhatTheClientSurfaceSays(t *testing.T) {
	cases := surfaceCases(t, "mark", "delegate")
	if len(cases) == 0 {
		t.Fatal("the client surface states no cases for mark.delegate: this test would pass for the wrong reason")
	}
	asked := map[semiont.Motivation]bool{}
	for _, c := range cases {
		var args struct {
			ResourceId string         `json:"resourceId"`
			Params     map[string]any `json:"params"`
		}
		if err := json.Unmarshal(c.Args, &args); err != nil {
			t.Fatalf("%s: the case's arguments could not be read: %v", c.Args, err)
		}
		motivation, _ := args.Params["motivation"].(string)
		delete(args.Params, "motivation")
		asked[semiont.Motivation(motivation)] = true
		// Through the flags: what a caller types is what is sent.
		given := givenBy(t, markJobFlags, flagsFor(t, markJobFlags, args.Params))
		command, err := markJob(args.ResourceId, semiont.Motivation(motivation), given)
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
	motivations := readSpecSchema(t, "Motivation.json").Enum
	if len(motivations) == 0 {
		t.Fatal("the spec's motivations could not be read")
	}
	schemas := markJobSchemas(t)
	for _, name := range motivations {
		motivation := semiont.Motivation(name)
		if !asked[motivation] {
			t.Errorf("the client surface has no mark.delegate case for the motivation %q", motivation)
		}
		schema, isJob := schemas[motivation]
		if !isJob {
			t.Errorf("the spec's MarkJobParams has no member for the motivation %q", motivation)
			continue
		}
		// Given what its schema requires, and nothing else.
		given := map[string]any{}
		for _, param := range schema.Required {
			switch schema.Properties[param].Type {
			case "array":
				given[param] = []string{"one"}
			default:
				given[param] = "one"
			}
		}
		delete(given, "motivation")
		if _, err := markJob("res-1", motivation, given); err != nil {
			t.Errorf("the motivation %q cannot be delegated: %v", motivation, err)
		}
	}
}

// The flag table is the launcher's; the parameters are the spec's. Every
// parameter of every motivation's job has a flag that reads a value of its
// type, and no flag gives a parameter no job takes: a parameter the spec gains
// fails here until it has one.
func TestEveryMarkJobParameterHasItsFlag(t *testing.T) {
	kindOf := map[string]flagKind{"string": flagText, "array": flagList, "boolean": flagSet, "number": flagPositive}
	taken := map[string]bool{}
	for motivation, schema := range markJobSchemas(t) {
		for param, property := range schema.Properties {
			if param == "motivation" {
				continue
			}
			taken[param] = true
			flag, has := markJobFlags[markJobFlags.flagOf(param)]
			if !has {
				t.Errorf("a %s job takes %q, and no flag gives it", motivation, param)
				continue
			}
			if kind, known := kindOf[property.Type]; !known || kind != flag.kind {
				t.Errorf("a %s job's %q is a %s, which its flag %s does not read", motivation, param, property.Type, markJobFlags.flagOf(param))
			}
		}
	}
	for name, flag := range markJobFlags {
		if !taken[flag.param] {
			t.Errorf("%s gives %q, which no motivation's job takes", name, flag.param)
		}
	}
}

// What the SDKs refuse before asking, a delegated mark refuses too: a job the
// gateway would turn away, or one that would find nothing to do.
func TestMarkDelegateRefusalsInProcess(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
		want string
	}{
		{"no motivation", []string{"--delegate", "res-1"}, "--motivation"},
		{"an unknown motivation", []string{"--delegate", "res-1", "--motivation", "bookmarking"}, "--delegate --help"},
		{"no resource", []string{"--delegate", "--motivation", "highlighting"}, "resource"},
		{"two resources", []string{"--delegate", "res-1", "res-2", "--motivation", "highlighting"}, "one resource"},
		{"linking names no entity type", []string{"--delegate", "res-1", "--motivation", "linking"}, "linking needs --entity-type"},
		{"tagging names no schema", []string{"--delegate", "res-1", "--motivation", "tagging", "--category", "claim"}, "tagging needs --schema"},
		{"tagging names an empty schema", []string{"--delegate", "res-1", "--motivation", "tagging", "--schema", "", "--category", "claim"}, "tagging needs --schema"},
		{"tagging names no category", []string{"--delegate", "res-1", "--motivation", "tagging", "--schema", "s1"}, "tagging needs --category"},
		{"a density that is not a number", []string{"--delegate", "res-1", "--motivation", "highlighting", "--density", "lots"}, "--density"},
		{"a density of nothing", []string{"--delegate", "res-1", "--motivation", "highlighting", "--density", "0"}, "--density"},
		{"an unknown tone", []string{"--delegate", "res-1", "--motivation", "commenting", "--tone", "sarcastic"}, "commenting takes no --tone \"sarcastic\""},
		{"an assessment's tone on a comment", []string{"--delegate", "res-1", "--motivation", "commenting", "--tone", "critical"}, "commenting takes no --tone \"critical\""},
		{"a comment's tone on an assessment", []string{"--delegate", "res-1", "--motivation", "assessing", "--tone", "scholarly"}, "assessing takes no --tone \"scholarly\""},
		{"a highlight has no tone", []string{"--delegate", "res-1", "--motivation", "highlighting", "--tone", "scholarly"}, "highlighting takes no --tone; it takes --density, --instructions, --source-language"},
		{"a highlight has no language of its own", []string{"--delegate", "res-1", "--motivation", "highlighting", "--language", "de"}, "highlighting takes no --language"},
		{"linking takes no instructions", []string{"--delegate", "res-1", "--motivation", "linking", "--entity-type", "Person", "--instructions", "x"}, "linking takes no --instructions"},
		{"tagging takes no entity type", []string{"--delegate", "res-1", "--motivation", "tagging", "--schema", "s1", "--category", "claim", "--entity-type", "Person"}, "tagging takes no --entity-type"},
		{"commenting takes no schema", []string{"--delegate", "res-1", "--motivation", "commenting", "--schema", "s1"}, "commenting takes no --schema"},
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

// The help names every motivation the spec does and every value of every
// enumerated parameter of their jobs (a comment's tones, an assessment's), so
// a value the spec gains is one the help is made to offer.
func TestMarkDelegateHelpNamesTheSpecsVocabulary(t *testing.T) {
	motivations := readSpecSchema(t, "Motivation.json").Enum
	var values []string
	for _, schema := range markJobSchemas(t) {
		for param, property := range schema.Properties {
			if param != "motivation" {
				values = append(values, property.Enum...)
			}
		}
	}
	if len(motivations) == 0 || len(values) == 0 {
		t.Fatalf("the spec's vocabulary could not be read: %d motivations, %d enumerated values", len(motivations), len(values))
	}
	harness.MustContainAll(t, "mark --delegate --help", markDelegateUsage, motivations...)
	harness.MustContainAll(t, "mark --delegate --help", markDelegateUsage, values...)
	for name := range markJobFlags {
		if !strings.Contains(markDelegateUsage, "  "+name+" ") {
			t.Errorf("mark --delegate --help does not list %s", name)
		}
	}
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
