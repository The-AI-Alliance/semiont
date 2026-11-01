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

// lacks and malformed are the faults of each reason at member.
func lacks(member string) Fault     { return Fault{Member: member, Reason: Lacks} }
func malformed(member string) Fault { return Fault{Member: member, Reason: Malformed} }

// none is no fault.
var none = Fault{}

func faults(t *testing.T, generated reflect.Type, text string, want Fault) {
	t.Helper()
	fault, faulty := FaultOf([]byte(text), generated)
	if faulty != (want != none) || fault != want {
		t.Errorf("%s has the fault %+v (%v), not %+v", text, fault, faulty, want)
	}
}

func TestWhatATypeOfNoSchemaRequiresIsReadFromTheType(t *testing.T) {
	generated := reflect.TypeFor[written]()
	for text, want := range map[string]Fault{
		`{"nickname":null}`:                                   lacks("name"),
		`{"name":null,"nickname":"n"}`:                        lacks("name"),
		`{"name":"a"}`:                                        lacks("nickname"),
		`{"name":"a","nickname":null}`:                        none,
		`{"name":"a","nickname":"n","tags":null}`:             none,
		`{"name":"a","nickname":null,"within":{}}`:            lacks("within.depth"),
		`{"name":7,"nickname":null}`:                          malformed("name"),
		`{"name":"a","nickname":7}`:                           malformed("nickname"),
		`{"name":"a","nickname":null,"tags":[1]}`:             malformed("tags"),
		`{"name":"a","nickname":null,"tags":[null]}`:          malformed("tags"),
		`{"name":"a","nickname":null,"within":{"depth":1.5}}`: malformed("within.depth"),
		`{"name":"a","nickname":null,"within":{"depth":2.0}}`: none,
		`"a"`: malformed(""),
		`{"name":"a","nickname":null,"items":[{"resource":{"@context":"c","@id":"r","name":"n"}}]}`:     lacks("items.resource.representations"),
		`{"name":"a","nickname":null,"byKey":{"k":{"resource":{"@context":"c","@id":"r","name":"n"}}}}`: lacks("byKey.resource.representations"),
		`{"name":"a","nickname":null,"byKey":{"k":null}}`:                                               malformed("byKey"),
	} {
		faults(t, generated, text, want)
	}
}

func TestWhatATypeOfASchemaRequiresIsItsSchemas(t *testing.T) {
	resource := reflect.TypeFor[api.ResourceDescriptor]()
	for text, want := range map[string]Fault{
		`{"@id":"r","name":"n","representations":[]}`:                                                                                lacks("@context"),
		`{"@context":"c","@id":"r","name":"n","representations":[]}`:                                                                 none,
		`{"@context":"c","@id":"r","name":null,"representations":[]}`:                                                                lacks("name"),
		`{"@context":"c","@id":"r","name":7,"representations":[]}`:                                                                   malformed("name"),
		`{"@context":"c","@id":"r","name":"n","representations":"text"}`:                                                             malformed("representations"),
		`{"@context":"c","@id":"r","name":"n","representations":[null]}`:                                                             malformed("representations"),
		`{"@context":"c","@id":"r","name":"n","representations":{}}`:                                                                 lacks("representations.mediaType"),
		`{"@context":"c","@id":"r","name":"n","representations":[{}]}`:                                                               lacks("representations.mediaType"),
		`{"@context":"c","@id":"r","name":"n","representations":[{"mediaType":"text/plain","byteSize":1.5}]}`:                        malformed("representations.byteSize"),
		`{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Organization"}}`:                      lacks("wasAttributedTo.name"),
		`{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":[{"@type":"Person"},{"@type":"Organization"}]}`: lacks("wasAttributedTo.name"),
		`{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":{"@type":"Person"}}`:                            none,
		`{"@context":"c","@id":"r","name":"n","representations":[],"wasAttributedTo":"a person"}`:                                    malformed("wasAttributedTo"),
		`{"@context":1998,"@id":"r","representations":[]}`:                                                                           lacks("name"),
		`"a resource"`: malformed(""),
	} {
		faults(t, resource, text, want)
	}
	// A member that may be null may hold null, and must still be stated.
	user := reflect.TypeFor[api.UserResponse]()
	faults(t, user, `{"did":"did:web:example.org:users:a","domain":"example.org","email":null,"name":null,"image":null}`, none)
	faults(t, user, `{"did":"did:web:example.org:users:a","domain":"example.org","email":null,"name":null}`, lacks("image"))
	faults(t, user, `{"did":"did:web:example.org:users:a","domain":"example.org","email":null,"name":null,"image":5}`, malformed("image"))
	// Each part of a composite requires what it requires.
	failed := reflect.TypeFor[api.GatherFailed]()
	faults(t, failed, `{"message":"no context"}`, lacks("annotationId"))
	// A map's values each carry what theirs requires.
	profiles := reflect.TypeFor[api.BrowseProfilesResult]()
	faults(t, profiles, `{"response":{"profiles":{"did:web:example.org:users:a":{}}}}`, lacks("response.profiles.name"))
}

func TestATypeWrappingOneOfASchemaHoldsItToTheSchema(t *testing.T) {
	type response[T any] struct {
		Response T `json:"response"`
	}
	faults(t, reflect.TypeFor[response[api.JobCancelResult]](), `{}`, lacks("response"))
	faults(t, reflect.TypeFor[response[api.JobCancelResult]](), `{"response":{}}`, lacks("response.cancelled"))
	faults(t, reflect.TypeFor[response[api.JobCancelResult]](), `{"response":{"cancelled":"yes"}}`, malformed("response.cancelled"))
	faults(t, reflect.TypeFor[response[api.JobCancelResult]](), `{"response":{"cancelled":true}}`, none)
}

func TestEveryFaultIsSaidAsEverySDKSaysIt(t *testing.T) {
	for fault, said := range map[Fault]string{
		lacks("representations.mediaType"): "it has no `representations.mediaType`",
		malformed("representations"):       "its `representations` is malformed",
		Undecoded:                          "it is malformed",
	} {
		if fault.String() != said {
			t.Errorf("%+v is said %q, not %q", fault, fault.String(), said)
		}
	}
}

func TestAPayloadIsReadAsATypeOnlyWhenItHasNoFault(t *testing.T) {
	if read, ok := ReadAs[written]([]byte(`{"name":"a","nickname":null}`)); !ok || read.Name != "a" {
		t.Errorf("a payload with what written requires reads as %+v, %v", read, ok)
	}
	for _, text := range []string{`{"name":"a"}`, `"a"`, `null`, `[]`, `{"name":null,"nickname":null}`, `{"name":7,"nickname":null}`} {
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
			held(name, one)
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
