package required

import (
	"reflect"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// written is a struct of no schema, as the generator writes an object: an
// optional member with omitempty, a member that may be null as a pointer.
type written struct {
	Name     string          `json:"name"`
	Nickname *string         `json:"nickname"`
	Tags     []string        `json:"tags,omitempty"`
	Within   *nested         `json:"within,omitempty"`
	Skipped  string          `json:"-"`
	Items    []item          `json:"items,omitempty"`
	ByKey    map[string]item `json:"byKey,omitempty"`
}

type nested struct {
	Depth int `json:"depth"`
}

type item struct {
	Resource api.ResourceDescriptor `json:"resource"`
}

func lacks(t *testing.T, generated reflect.Type, text, want string) {
	t.Helper()
	way, lacking := Lacking([]byte(text), generated)
	if lacking != (want != "") || way != want {
		t.Errorf("%s lacks %q (%v), not %q", text, way, lacking, want)
	}
}

func TestWhatAStructOfNoSchemaRequiresIsWhatItsTagsWriteWithoutOmitempty(t *testing.T) {
	generated := reflect.TypeFor[written]()
	for text, want := range map[string]string{
		`{"nickname":null}`:                        "name",
		`{"name":null,"nickname":"n"}`:             "name",
		`{"name":"a"}`:                             "nickname",
		`{"name":"a","nickname":null}`:             "",
		`{"name":"a","nickname":"n","tags":null}`:  "",
		`{"name":"a","nickname":null,"within":{}}`: "within.depth",
		`{"name":"a","nickname":null,"items":[{"resource":{"@context":"c","@id":"r","name":"n"}}]}`:     "items.resource.representations",
		`{"name":"a","nickname":null,"byKey":{"k":{"resource":{"@context":"c","@id":"r","name":"n"}}}}`: "byKey.resource.representations",
	} {
		lacks(t, generated, text, want)
	}
}

func TestWhatATypeOfASchemaRequiresIsItsSchemas(t *testing.T) {
	resource := reflect.TypeFor[api.ResourceDescriptor]()
	for text, want := range map[string]string{
		`{"@id":"r","name":"n","representations":[]}`:                                                                                "@context",
		`{"@context":"c","@id":"r","name":"n","representations":[]}`:                                                                 "",
		`{"@context":"c","@id":"r","name":null,"representations":[]}`:                                                                "name",
		`{"@context":"c","@id":"r","name":"n","representations":"text"}`:                                                             "",
		`{"@context":"c","@id":"r","name":"n","representations":{}}`:                                                                 "representations.mediaType",
		`{"@context":"c","@id":"r","name":"n","representations":[{}]}`:                                                               "representations.mediaType",
		`{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Organization"}}`:                      "wasAttributedTo.name",
		`{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":[{"@type":"Person"},{"@type":"Organization"}]}`: "wasAttributedTo.name",
		`{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Person"}}`:                            "",
		`"a resource"`: "",
	} {
		lacks(t, resource, text, want)
	}
	// A member that may be null may hold null, and must still be stated.
	user := reflect.TypeFor[api.UserResponse]()
	lacks(t, user, `{"did":"did:web:example.org:users:a","domain":"example.org","email":null,"name":null,"image":null}`, "")
	lacks(t, user, `{"did":"did:web:example.org:users:a","domain":"example.org","email":null,"name":null}`, "image")
	// Each part of a composite requires what it requires.
	failed := reflect.TypeFor[api.GatherFailed]()
	lacks(t, failed, `{"message":"no context"}`, "annotationId")
	// A map's values each carry what theirs requires.
	profiles := reflect.TypeFor[api.BrowseProfilesResult]()
	lacks(t, profiles, `{"response":{"profiles":{"did:web:example.org:users:a":{}}}}`, "response.profiles.name")
}

func TestATypeWrappingOneOfASchemaHoldsItToTheSchema(t *testing.T) {
	type response[T any] struct {
		Response T `json:"response"`
	}
	lacks(t, reflect.TypeFor[response[api.JobCancelResult]](), `{}`, "response")
	lacks(t, reflect.TypeFor[response[api.JobCancelResult]](), `{"response":{}}`, "response.cancelled")
	lacks(t, reflect.TypeFor[response[api.JobCancelResult]](), `{"response":{"cancelled":true}}`, "")
}

func TestAPayloadIsReadAsATypeOnlyWhenItCarriesWhatTheTypeRequires(t *testing.T) {
	if read, ok := ReadAs[written]([]byte(`{"name":"a","nickname":null}`)); !ok || read.Name != "a" {
		t.Errorf("a payload with what written requires reads as %+v, %v", read, ok)
	}
	for _, text := range []string{`{"name":"a"}`, `"a"`, `null`, `[]`, `{"name":null,"nickname":null}`} {
		if _, ok := ReadAs[written]([]byte(text)); ok {
			t.Errorf("%s is read as a written", text)
		}
	}
}

// Every component a shape refers to is in the table, and every variant a
// discriminator names is among its union's.
func TestTheTableNamesNothingItLacks(t *testing.T) {
	var held func(name string, s *shape)
	held = func(name string, s *shape) {
		if s == nil {
			return
		}
		if s.Ref != "" && schemas()[s.Ref] == nil {
			t.Errorf("%s refers to %s, which the table lacks", name, s.Ref)
		}
		for _, member := range s.Members {
			held(name, member)
		}
		held(name, s.Items)
		held(name, s.Values)
		for _, one := range s.OneOf {
			held(name, one.Shape)
		}
		if s.Discriminator != nil {
			for value, at := range s.Discriminator.Mapping {
				if at < 0 || at >= len(s.OneOf) {
					t.Errorf("%s: its discriminator names %q a variant it does not have", name, value)
				}
			}
		}
		for _, part := range s.AllOf {
			held(name, part)
		}
	}
	if len(schemas()) == 0 {
		t.Fatal("the table holds no schema")
	}
	for name, s := range schemas() {
		held(name, s)
	}
}

func TestMalformedGeneratedSchemasFailLoudly(t *testing.T) {
	defer func() {
		failure := recover()
		message, ok := failure.(string)
		if !ok || !strings.Contains(message, "schemas_gen.json is not what packages/codegen/schemas/generate-required-go.mjs writes:") {
			t.Fatalf("malformed generated table must identify its source, got %v", failure)
		}
	}()
	readSchemas([]byte(`{"schemas":`))
}

func TestReadingGeneratedSchemasPreservesRequiredMembers(t *testing.T) {
	table := readSchemas([]byte(`{"schemas":{"Example":{"required":["name"]}}}`))
	if len(table) != 1 || table["Example"] == nil || !reflect.DeepEqual(table["Example"].Required, []string{"name"}) {
		t.Fatalf("generated required members were not read: %#v", table)
	}
}
