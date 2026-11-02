// Package required holds a JSON value to what its type requires of it, which
// Go's decoding does not: it refuses no member that is missing, and fills it
// with its zero value. Rust, Python and Kotlin refuse such a value as they
// decode it, wherever the member is missing; the SDK holds what it decodes
// here first, and so refuses it too.
//
// What a type of package api requires is its schema's, read from the spec
// (schemas_gen.json, which packages/codegen/schemas/generate-required-go.mjs writes by
// the rules of packages/codegen/schemas/required-members.mjs), and the type is found
// there by its name, which is its schema's. What any other struct requires
// is read from its JSON tags: each member it writes without omitempty, which
// may be null where it is a pointer, an interface or raw JSON; and what its
// members' types require.
package required

import (
	_ "embed"
	"encoding/json"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// shape is what a value must carry, as far as its members go:
// packages/codegen/schemas/required-members.mjs states what each part means.
type shape struct {
	Ref           string            `json:"ref"`
	Required      []string          `json:"required"`
	Nullable      []string          `json:"nullable"`
	Members       map[string]*shape `json:"members"`
	Items         *shape            `json:"items"`
	Values        *shape            `json:"values"`
	OneOf         []variant         `json:"oneOf"`
	Discriminator *discriminator    `json:"discriminator"`
	AllOf         []*shape          `json:"allOf"`
}

// variant is one of the shapes a union may be, and the kinds of value it is.
type variant struct {
	Kinds []string `json:"kinds"`
	Shape *shape   `json:"shape"`
}

// discriminator is the member whose value names the variant a union is.
type discriminator struct {
	Property string         `json:"property"`
	Mapping  map[string]int `json:"mapping"`
}

//go:embed schemas_gen.json
var generatedTable []byte

// schemas is what each component schema of the spec requires, by its name.
var schemas = sync.OnceValue(func() map[string]*shape {
	return readSchemas(generatedTable)
})

// readSchemas refuses a malformed generated table instead of silently using no schemas.
func readSchemas(source []byte) map[string]*shape {
	var table struct {
		Schemas map[string]*shape `json:"schemas"`
	}
	if err := json.Unmarshal(source, &table); err != nil {
		panic("schemas_gen.json is not what packages/codegen/schemas/generate-required-go.mjs writes: " + err.Error())
	}
	return table.Schemas
}

var (
	apiPackage = reflect.TypeFor[api.ResourceId]().PkgPath()
	rawMessage = reflect.TypeFor[json.RawMessage]()
	// byTag is the shape of each type read from its tags, once.
	byTag sync.Map
)

// shapeOf is what a value of generated must carry.
func shapeOf(generated reflect.Type) *shape {
	return shapeAmong(generated, map[reflect.Type]*shape{})
}

// shapeAmong is shapeOf, where building is each type whose shape is being
// read: a type that holds itself reads the one being filled.
func shapeAmong(generated reflect.Type, building map[reflect.Type]*shape) *shape {
	for generated.Kind() == reflect.Pointer {
		generated = generated.Elem()
	}
	if _, named := schemas()[generated.Name()]; named && generated.PkgPath() == apiPackage {
		return &shape{Ref: generated.Name()}
	}
	if read, ok := byTag.Load(generated); ok {
		return read.(*shape)
	}
	if read, ok := building[generated]; ok {
		return read
	}
	read := &shape{}
	building[generated] = read
	switch generated.Kind() {
	case reflect.Struct:
		read.Members = map[string]*shape{}
		for i := range generated.NumField() {
			field := generated.Field(i)
			name, options, _ := strings.Cut(field.Tag.Get("json"), ",")
			if name == "" || name == "-" {
				continue
			}
			read.Members[name] = shapeAmong(field.Type, building)
			if slices.Contains(strings.Split(options, ","), "omitempty") {
				continue
			}
			read.Required = append(read.Required, name)
			if kind := field.Type.Kind(); kind == reflect.Pointer || kind == reflect.Interface || field.Type == rawMessage {
				read.Nullable = append(read.Nullable, name)
			}
		}
	case reflect.Slice, reflect.Array:
		if generated != rawMessage {
			read.Items = shapeAmong(generated.Elem(), building)
		}
	case reflect.Map:
		read.Values = shapeAmong(generated.Elem(), building)
	}
	stored, _ := byTag.LoadOrStore(generated, read)
	return stored.(*shape)
}

// Lacking is the way to the first member payload lacks to be of generated:
// the names of the members it is within, and its own, joined by dots. An
// array's positions and a map's keys are not said. A member lacks when it is
// missing, or holds null where it may not. False when payload lacks none,
// and when it is not JSON, which whatever decodes it says.
func Lacking(payload []byte, generated reflect.Type) (string, bool) {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return "", false
	}
	return lacking(shapeOf(generated), value, "")
}

// Carries is whether payload is an object carrying every member generated
// requires.
func Carries(payload []byte, generated reflect.Type) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(payload, &object) != nil || object == nil {
		return false
	}
	_, lacks := Lacking(payload, generated)
	return !lacks
}

// ReadAs is payload read as T, and whether it is one: an object carrying
// every member T requires.
func ReadAs[T any](payload []byte) (T, bool) {
	var value T
	if !Carries(payload, reflect.TypeFor[T]()) || json.Unmarshal(payload, &value) != nil {
		return value, false
	}
	return value, true
}

// within is way, then name.
func within(way, name string) string {
	if way == "" {
		return name
	}
	return way + "." + name
}

// lacking is the way to the first member value lacks to be of s, from way.
func lacking(s *shape, value any, way string) (string, bool) {
	if s.Ref != "" {
		return lacking(schemas()[s.Ref], value, way)
	}
	if object, isObject := value.(map[string]any); isObject {
		for _, name := range s.Required {
			held, has := object[name]
			if !has || (held == nil && !slices.Contains(s.Nullable, name)) {
				return within(way, name), true
			}
		}
		for _, name := range sortedKeys(s.Members) {
			if held := object[name]; held != nil {
				if lacks, ok := lacking(s.Members[name], held, within(way, name)); ok {
					return lacks, true
				}
			}
		}
		if s.Values != nil {
			for _, key := range sortedKeys(object) {
				if lacks, ok := lacking(s.Values, object[key], way); ok {
					return lacks, true
				}
			}
		}
	}
	if items, isArray := value.([]any); isArray && s.Items != nil {
		for _, item := range items {
			if lacks, ok := lacking(s.Items, item, way); ok {
				return lacks, true
			}
		}
	}
	if len(s.OneOf) > 0 {
		if lacks, ok := lackingOneOf(s, value, way); ok {
			return lacks, true
		}
	}
	for _, part := range s.AllOf {
		if lacks, ok := lacking(part, value, way); ok {
			return lacks, true
		}
	}
	return "", false
}

// lackingOneOf is what value lacks to be one of the variants of s: what the
// variant its discriminator names lacks, or, naming none, what the first of
// the variants of its kind lacks when each of them lacks something. A value
// of no variant's kind lacks nothing here.
func lackingOneOf(s *shape, value any, way string) (string, bool) {
	var candidates []*shape
	for _, one := range s.OneOf {
		if slices.Contains(one.Kinds, kindOf(value)) {
			candidates = append(candidates, one.Shape)
		}
	}
	if object, isObject := value.(map[string]any); isObject && s.Discriminator != nil {
		if named, isText := object[s.Discriminator.Property].(string); isText {
			if at, mapped := s.Discriminator.Mapping[named]; mapped {
				candidates = []*shape{s.OneOf[at].Shape}
			}
		}
	}
	first := ""
	for i, candidate := range candidates {
		lacks, ok := lacking(candidate, value, way)
		if !ok {
			return "", false
		}
		if i == 0 {
			first = lacks
		}
	}
	return first, len(candidates) > 0
}

// kindOf is the kind of a decoded JSON value, as a schema names it.
func kindOf(value any) string {
	switch value.(type) {
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	default:
		return "null"
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
