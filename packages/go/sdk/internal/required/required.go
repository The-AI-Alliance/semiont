// Package required holds a JSON value to what its type requires of it, which
// Go's decoding does not: it refuses no member that is missing, and fills it
// with its zero value. Every SDK holds what it reads to the same table
// before it decodes it, and names the first fault it finds the same way.
//
// What a type of package api requires is its schema's, read from the spec
// (schemas_gen.json, which packages/codegen/schemas/generate-required-go.mjs writes by
// the rules of packages/codegen/schemas/required-shapes.mjs), and the type is found
// there by its name, which is its schema's. What any other type requires is
// read from it: a struct is an object, and requires each member it writes
// without omitempty, which may be null where it is a pointer, an interface
// or raw JSON; a slice is an array, a map an object, and each holds what its
// items' type requires; a string, a bool, an integer and a float are each
// that kind of value.
package required

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// shape is what a value must be: packages/codegen/schemas/required-shapes.mjs states
// what each part means.
type shape struct {
	Ref   string   `json:"ref"`
	Kinds []string `json:"kinds"`
	// Recognized is, of an object's member, the texts a reader reads it as:
	// one that holds a text none of them is left out of what it reads.
	Recognized []string          `json:"recognized"`
	Enum       []any             `json:"enum"`
	Pattern    []step            `json:"pattern"`
	MinLength  *int              `json:"minLength"`
	MaxLength  *int              `json:"maxLength"`
	Minimum    *float64          `json:"minimum"`
	Maximum    *float64          `json:"maximum"`
	MinItems   *int              `json:"minItems"`
	MaxItems   *int              `json:"maxItems"`
	Required   []string          `json:"required"`
	Members    map[string]*shape `json:"members"`
	// Closed is nil for an object that may carry any member, and empty for
	// one that may carry none.
	Closed        []string       `json:"closed"`
	Items         *shape         `json:"items"`
	Values        *shape         `json:"values"`
	OneOf         []*shape       `json:"oneOf"`
	Discriminator *discriminator `json:"discriminator"`
	AllOf         []*shape       `json:"allOf"`
}

// step is one step of a pattern: at least Min of a text's next code points,
// and at most Max (nil: any number), each in one of the ranges Of.
type step struct {
	Of  [][2]rune `json:"of"`
	Min int       `json:"min"`
	Max *int      `json:"max"`
}

// holds is whether point is in one of the step's ranges.
func (s step) holds(point rune) bool {
	return slices.ContainsFunc(s.Of, func(r [2]rune) bool { return r[0] <= point && point <= r[1] })
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

// readSchemas refuses a malformed generated table instead of silently using no
// schemas, and a part of a shape this reader does not know instead of reading
// the shape without it.
func readSchemas(source []byte) map[string]*shape {
	var table struct {
		Comment string            `json:"$comment"`
		Schemas map[string]*shape `json:"schemas"`
	}
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&table); err != nil {
		panic("schemas_gen.json is not what packages/codegen/schemas/generate-required-go.mjs writes: " + err.Error())
	}
	return table.Schemas
}

var (
	apiPackage = reflect.TypeFor[api.ResourceId]().PkgPath()
	rawMessage = reflect.TypeFor[json.RawMessage]()
	// byType is the shape of each type read from the type, once.
	byType sync.Map
)

// Fault is the first thing wrong with a value: the way to the member it is
// at (the names of the members it is within, and its own, joined by dots;
// the empty way is the value itself), and why.
type Fault struct {
	Member string
	Reason bus.FrameRefusalReason
}

// Within is f as a fault of the value that holds the faulty value as its
// member name: a fault of that value itself is at name.
func (f Fault) Within(name string) Fault {
	if f.Member == "" {
		return Fault{Member: name, Reason: f.Reason}
	}
	return Fault{Member: name + "." + f.Member, Reason: f.Reason}
}

// String is what every SDK says of the fault.
func (f Fault) String() string {
	switch {
	case f.Reason == bus.FrameRefusalReasonLacks:
		return fmt.Sprintf("it has no `%s`", f.Member)
	case f.Member == "":
		return "it is malformed"
	default:
		return fmt.Sprintf("its `%s` is malformed", f.Member)
	}
}

// Undecoded is the fault of a value Go's decoding refuses that has no fault
// the table states: the value itself is malformed.
var Undecoded = Fault{Reason: bus.FrameRefusalReasonMalformed}

// shapeOf is what a value of generated must be.
func shapeOf(generated reflect.Type) *shape {
	return shapeAmong(generated, map[reflect.Type]*shape{})
}

// shapeAmong is shapeOf, where building is each type whose shape is being
// read: a type that holds itself reads the one being filled.
func shapeAmong(generated reflect.Type, building map[reflect.Type]*shape) *shape {
	if generated.Kind() == reflect.Pointer {
		// Null, or what it points to.
		return &shape{OneOf: []*shape{{Kinds: []string{"null"}}, shapeAmong(generated.Elem(), building)}}
	}
	if _, named := schemas()[generated.Name()]; named && generated.PkgPath() == apiPackage {
		return &shape{Ref: generated.Name()}
	}
	if read, ok := byType.Load(generated); ok {
		return read.(*shape)
	}
	if read, ok := building[generated]; ok {
		return read
	}
	read := &shape{Kinds: kindsOf(generated)}
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
			if !slices.Contains(strings.Split(options, ","), "omitempty") {
				read.Required = append(read.Required, name)
			}
		}
	case reflect.Slice, reflect.Array:
		if generated != rawMessage {
			read.Items = shapeAmong(generated.Elem(), building)
		}
	case reflect.Map:
		read.Values = shapeAmong(generated.Elem(), building)
	}
	stored, _ := byType.LoadOrStore(generated, read)
	return stored.(*shape)
}

// kindsOf is the kinds of value a type that is no type of package api's is
// read from; none for one read from any.
func kindsOf(generated reflect.Type) []string {
	if generated == rawMessage {
		return nil
	}
	switch generated.Kind() {
	case reflect.Struct, reflect.Map:
		return []string{"object"}
	case reflect.Slice, reflect.Array:
		return []string{"array"}
	case reflect.String:
		return []string{"string"}
	case reflect.Bool:
		return []string{"boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return []string{"integer"}
	case reflect.Float32, reflect.Float64:
		return []string{"number"}
	default:
		return nil
	}
}

// Read is payload as a reader of generated reads it, by the rules every SDK
// reads the table by: the JSON it decodes, which is payload without each
// member it leaves out; or, true, payload's first fault. Payload that is not
// JSON is given as it is, with no fault, for whatever decodes it to say so.
func Read(payload []byte, generated reflect.Type) ([]byte, Fault, bool) {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return payload, Fault{}, false
	}
	return readOf(shapeOf(generated), payload, value)
}

// readOf is payload, which decodes to value, as a reader of s reads it.
func readOf(s *shape, payload []byte, value any) ([]byte, Fault, bool) {
	fault, left, faulty := faultOf(s, value, "")
	if faulty {
		return nil, fault, true
	}
	for _, member := range left {
		var refused error
		if payload, refused = without(payload, member); refused != nil {
			return nil, Undecoded, true
		}
	}
	return payload, Fault{}, false
}

// Carries is whether payload is JSON with no fault as a value of generated.
func Carries(payload []byte, generated reflect.Type) bool {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return false
	}
	_, _, faulty := faultOf(shapeOf(generated), value, "")
	return !faulty
}

// Holds is whether value, as Go's decoding of JSON into an any gives it, has
// no fault as a value of the spec's component schema named schema: for a
// schema no type of package api is named for, as one an alias of a string is.
func Holds(schema string, value any) bool {
	if _, named := schemas()[schema]; !named {
		panic("the spec has no component schema " + schema)
	}
	_, _, faulty := faultOf(&shape{Ref: schema}, value, "")
	return !faulty
}

// ReadAs is payload read as T, and whether it is one: JSON with no fault as
// a T, which Go's decoding reads as Read gives it.
func ReadAs[T any](payload []byte) (T, bool) {
	var value T
	read, _, faulty := Read(payload, reflect.TypeFor[T]())
	if faulty || json.Unmarshal(read, &value) != nil {
		return value, false
	}
	return value, true
}

// ReadFramePayload is Read of a frame's payload as its type reads it: what a
// gateway stamps on a payload (a member whose name begins `_`) that a value of
// generated does not name is the bus's, not the payload's, and is left out
// before the payload is held to its shape. What is read keeps it.
func ReadFramePayload(payload []byte, generated reflect.Type) ([]byte, Fault, bool) {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return payload, Fault{}, false
	}
	read := shapeOf(generated)
	return readOf(read, payload, unstamped(read, value))
}

// ReadFramePayloadAs is ReadAs of a frame's payload, read as
// ReadFramePayload reads it.
func ReadFramePayloadAs[T any](payload []byte) (T, bool) {
	var value T
	read, _, faulty := ReadFramePayload(payload, reflect.TypeFor[T]())
	if faulty || json.Unmarshal(read, &value) != nil {
		return value, false
	}
	return value, true
}

// unread is a member a reader leaves out of what it reads: its way from the
// value read, by the name of each member and the index of each item it is
// within, and its own name last.
type unread []any

// under is each of left, as within the member or the item at.
func under(at any, left []unread) []unread {
	moved := make([]unread, len(left))
	for i, member := range left {
		moved[i] = append(unread{at}, member...)
	}
	return moved
}

// without is the JSON value raw without member, which it holds: only the
// objects and arrays member is within are written again, and every other
// value is kept as raw states it.
func without(raw []byte, member unread) ([]byte, error) {
	switch at := member[0].(type) {
	case string:
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			return nil, err
		}
		if len(member) == 1 {
			delete(object, at)
		} else {
			held, err := without(object[at], member[1:])
			if err != nil {
				return nil, err
			}
			object[at] = held
		}
		return json.Marshal(object)
	case int:
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, err
		}
		held, err := without(items[at], member[1:])
		if err != nil {
			return nil, err
		}
		items[at] = held
		return json.Marshal(items)
	default:
		panic(fmt.Sprintf("%v is neither a member's name nor an item's index", at))
	}
}

// unrecognized is whether held is a text a reader of s reads as absent: one
// none of the texts s recognizes, where it recognizes any.
func unrecognized(s *shape, held any) bool {
	recognized := resolved(s).Recognized
	text, isText := held.(string)
	return recognized != nil && isText && !slices.Contains(recognized, text)
}

// unstamped is value without the members whose names begin `_` that s names
// nowhere: not as its own, nor as a variant's or a part's.
func unstamped(s *shape, value any) any {
	object, isObject := value.(map[string]any)
	if !isObject {
		return value
	}
	named := map[string]bool{}
	nameMembers(s, named)
	kept := make(map[string]any, len(object))
	for name, held := range object {
		if !strings.HasPrefix(name, "_") || named[name] {
			kept[name] = held
		}
	}
	return kept
}

// nameMembers adds to named each member s describes, and each its variants
// and parts describe.
func nameMembers(s *shape, named map[string]bool) {
	s = resolved(s)
	for name := range s.Members {
		named[name] = true
	}
	for _, variant := range s.OneOf {
		nameMembers(variant, named)
	}
	for _, part := range s.AllOf {
		nameMembers(part, named)
	}
}

// within is way, then name.
func within(way, name string) string {
	if way == "" {
		return name
	}
	return way + "." + name
}

// resolved is s, or the component it refers to.
func resolved(s *shape) *shape {
	for s.Ref != "" {
		s = schemas()[s.Ref]
	}
	return s
}

// allowsNull is whether a value of s may be null.
func allowsNull(s *shape) bool {
	kinds := resolved(s).Kinds
	return kinds == nil || slices.Contains(kinds, "null")
}

// allows is whether kinds allow value: none allow any, and a number allows
// an integer, which is a number with no fractional part.
func allows(kinds []string, value any) bool {
	if kinds == nil {
		return true
	}
	kind := kindOf(value)
	if slices.Contains(kinds, kind) {
		return true
	}
	number, isNumber := value.(float64)
	return isNumber && slices.Contains(kinds, "integer") && number == math.Trunc(number)
}

// faultOf is the first fault value has as a value of s, from way; or, with
// none, each member a reader leaves out of it.
func faultOf(s *shape, value any, way string) (Fault, []unread, bool) {
	s = resolved(s)
	if !allows(s.Kinds, value) || !isOneOf(s.Enum, value) || !inBounds(s, value) {
		return Fault{Member: way, Reason: bus.FrameRefusalReasonMalformed}, nil, true
	}
	var left []unread
	if object, isObject := value.(map[string]any); isObject {
		for _, name := range s.Required {
			held, has := object[name]
			if !has || (held == nil && !allowsNull(memberShape(s, name))) {
				return Fault{Member: within(way, name), Reason: bus.FrameRefusalReasonLacks}, nil, true
			}
		}
		for _, name := range sortedKeys(s.Members) {
			held := object[name]
			if held == nil {
				continue
			}
			if unrecognized(s.Members[name], held) {
				left = append(left, unread{name})
				continue
			}
			fault, inner, faulty := faultOf(s.Members[name], held, within(way, name))
			if faulty {
				return fault, nil, true
			}
			left = append(left, under(name, inner)...)
		}
		if s.Closed != nil {
			for _, name := range sortedKeys(object) {
				if !slices.Contains(s.Closed, name) {
					return Fault{Member: within(way, name), Reason: bus.FrameRefusalReasonMalformed}, nil, true
				}
			}
		}
		if s.Values != nil {
			for _, key := range sortedKeys(object) {
				fault, inner, faulty := faultOf(s.Values, object[key], way)
				if faulty {
					return fault, nil, true
				}
				left = append(left, under(key, inner)...)
			}
		}
	}
	if items, isArray := value.([]any); isArray && s.Items != nil {
		for at, item := range items {
			fault, inner, faulty := faultOf(s.Items, item, way)
			if faulty {
				return fault, nil, true
			}
			left = append(left, under(at, inner)...)
		}
	}
	if len(s.OneOf) > 0 {
		fault, inner, faulty := faultOfOneOf(s, value, way)
		if faulty {
			return fault, nil, true
		}
		left = append(left, inner...)
	}
	for _, part := range s.AllOf {
		fault, inner, faulty := faultOf(part, value, way)
		if faulty {
			return fault, nil, true
		}
		left = append(left, inner...)
	}
	return Fault{}, left, false
}

// isOneOf is whether value is one of values, where there are any: a number
// is one equal to it in value.
func isOneOf(values []any, value any) bool {
	return values == nil || slices.Contains(values, value)
}

// inBounds is whether a text is of s's pattern and has as many code points as
// s allows, a number is within s's bounds, and an array has as many items as
// s allows.
func inBounds(s *shape, value any) bool {
	switch held := value.(type) {
	case string:
		points := []rune(held)
		return counted(s.MinLength, len(points), s.MaxLength) && (s.Pattern == nil || matches(s.Pattern, points))
	case float64:
		return (s.Minimum == nil || held >= *s.Minimum) && (s.Maximum == nil || held <= *s.Maximum)
	case []any:
		return counted(s.MinItems, len(held), s.MaxItems)
	default:
		return true
	}
}

// counted is whether count is at least least and at most most, where each is
// stated.
func counted(least *int, count int, most *int) bool {
	return (least == nil || count >= *least) && (most == nil || count <= *most)
}

// matches is whether points are of steps: the first step takes as many of
// them as it may, and gives them back one by one until the steps after it
// take the rest.
func matches(steps []step, points []rune) bool {
	if len(steps) == 0 {
		return len(points) == 0
	}
	first := steps[0]
	taken := 0
	for taken < len(points) && (first.Max == nil || taken < *first.Max) && first.holds(points[taken]) {
		taken++
	}
	for ; taken >= first.Min; taken-- {
		if matches(steps[1:], points[taken:]) {
			return true
		}
	}
	return false
}

// memberShape is what s's member name must be: any, where s does not say.
func memberShape(s *shape, name string) *shape {
	if member, described := s.Members[name]; described {
		return member
	}
	return &shape{}
}

// faultOfOneOf is the fault value has as one of the variants of s: the
// variant its discriminator names, or else each variant whose kinds allow
// it. None when one of them has none, with what a reader leaves out of the
// value as that one; the first one's when each has one; and a value no
// variant allows is malformed.
func faultOfOneOf(s *shape, value any, way string) (Fault, []unread, bool) {
	var candidates []*shape
	for _, one := range s.OneOf {
		if allows(resolved(one).Kinds, value) {
			candidates = append(candidates, one)
		}
	}
	if object, isObject := value.(map[string]any); isObject && s.Discriminator != nil {
		if named, isText := object[s.Discriminator.Property].(string); isText {
			if at, mapped := s.Discriminator.Mapping[named]; mapped {
				candidates = []*shape{s.OneOf[at]}
			}
		}
	}
	if len(candidates) == 0 {
		return Fault{Member: way, Reason: bus.FrameRefusalReasonMalformed}, nil, true
	}
	var first Fault
	for i, candidate := range candidates {
		fault, left, faulty := faultOf(candidate, value, way)
		if !faulty {
			return Fault{}, left, false
		}
		if i == 0 {
			first = fault
		}
	}
	return first, nil, true
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
