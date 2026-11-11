package required

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
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
func lacks(member string) Fault { return Fault{Member: member, Reason: bus.FrameRefusalReasonLacks} }
func malformed(member string) Fault {
	return Fault{Member: member, Reason: bus.FrameRefusalReasonMalformed}
}

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

// faultsAs holds the JSON text to the shape written as the table writes one.
func faultsAs(t *testing.T, written string, text string, want Fault) {
	t.Helper()
	var s shape
	var value any
	if err := json.Unmarshal([]byte(written), &s); err != nil {
		t.Fatalf("%s is no shape: %v", written, err)
	}
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("%s is no JSON: %v", text, err)
	}
	fault, faulty := faultOf(&s, value, "")
	if faulty != (want != none) || fault != want {
		t.Errorf("%s as %s has the fault %+v (%v), not %+v", text, written, fault, faulty, want)
	}
}

func TestAValueIsOneOfItsValuesOfItsFormAndOfItsSize(t *testing.T) {
	values := `{"kinds":["string","integer"],"enum":["mark",2]}`
	faultsAs(t, values, `"mark"`, none)
	faultsAs(t, values, `2.0`, none)
	faultsAs(t, values, `"yield"`, malformed(""))
	faultsAs(t, values, `3`, malformed(""))

	anyThenDigits := `{"kinds":["string","null"],"pattern":[{"of":[[0,9],[11,12],[14,8231],[8234,1114111]],"min":1},{"of":[[45,45]],"min":1,"max":1},{"of":[[48,57]],"min":1}]}`
	faultsAs(t, anyThenDigits, `"p-a-1-2"`, none)
	faultsAs(t, anyThenDigits, `"\ud83d\ude00-1"`, none)
	faultsAs(t, anyThenDigits, `null`, none)
	faultsAs(t, anyThenDigits, `"p-"`, malformed(""))
	faultsAs(t, anyThenDigits, `"\n-1"`, malformed(""))

	twoOrThree := `{"kinds":["string"],"minLength":2,"maxLength":3}`
	faultsAs(t, twoOrThree, `"\ud83d\ude00\ud83d\ude00"`, none)
	faultsAs(t, twoOrThree, `"\ud83d\ude00"`, malformed(""))
	faultsAs(t, twoOrThree, `"abcd"`, malformed(""))

	unit := `{"kinds":["number"],"minimum":0,"maximum":1}`
	faultsAs(t, unit, `0`, none)
	faultsAs(t, unit, `1`, none)
	faultsAs(t, unit, `-0.5`, malformed(""))
	faultsAs(t, unit, `1.5`, malformed(""))

	oneOrTwo := `{"kinds":["array"],"minItems":1,"maxItems":2}`
	faultsAs(t, oneOrTwo, `[1]`, none)
	faultsAs(t, oneOrTwo, `[]`, malformed(""))
	faultsAs(t, oneOrTwo, `[1,2,3]`, malformed(""))
}

func TestAClosedObjectCarriesNoMemberItDoesNotName(t *testing.T) {
	closed := `{"kinds":["object"],"required":["a"],"members":{"a":{"kinds":["string"]}},"closed":["a"]}`
	faultsAs(t, closed, `{"a":"x"}`, none)
	faultsAs(t, closed, `{"b":1}`, lacks("a"))
	faultsAs(t, closed, `{"a":1,"b":1}`, malformed("a"))
	faultsAs(t, closed, `{"a":"x","z":1,"b":1}`, malformed("b"))
	faultsAs(t, closed, `{"a":"x","\ud83d\ude00":1,"\uff61":1}`, malformed("\uff61"))
	faultsAs(t, `{"kinds":["object"],"closed":[]}`, `{}`, none)
	faultsAs(t, `{"kinds":["object"],"closed":[]}`, `{"x":1}`, malformed("x"))
}

func TestAFramePayloadIsHeldToItsShapeWithoutTheStampsItsTypeDoesNotName(t *testing.T) {
	request := reflect.TypeFor[api.BrowseProfilesRequest]()
	stamped := []byte(`{"dids":["did:web:example.org:users:a"],"_userId":"did:web:example.org:users:b","_roles":["admin"]}`)
	if fault, faulty := FaultOfFramePayload(stamped, request); faulty {
		t.Errorf("a payload with the gateway's stamps has the fault %+v", fault)
	}
	if fault, _ := FaultOf(stamped, request); fault != malformed("_roles") {
		t.Errorf("a reply that carries what a closed object does not name has the fault %+v", fault)
	}
	more := []byte(`{"dids":["did:web:example.org:users:a"],"more":1}`)
	if fault, _ := FaultOfFramePayload(more, request); fault != malformed("more") {
		t.Errorf("a payload that carries what a closed object does not name has the fault %+v", fault)
	}
	if read, ok := ReadFramePayloadAs[api.BrowseProfilesRequest](stamped); !ok || len(read.Dids) != 1 {
		t.Errorf("a payload with the gateway's stamps reads as %+v, %v", read, ok)
	}
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

// A value is held to a component schema by its name, as a value of no type of
// package api's is.
func TestAValueIsHeldToTheSchemaItsNameNames(t *testing.T) {
	for value, want := range map[string]bool{"p-res-1-47": true, "p-a-b-1": true, "e-res-1-47": false, "p-7": false, "p-res-1-": false, "p-a\n-1": false} {
		if got := Holds("PersistedEventId", value); got != want {
			t.Errorf("%q is held to PersistedEventId: %v, want %v", value, got, want)
		}
	}
	if Holds("PersistedEventId", 47.0) {
		t.Error("a number is held to PersistedEventId")
	}
}
