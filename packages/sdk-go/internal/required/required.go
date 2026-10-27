// Package required holds a JSON object to what its schema requires, which
// Go's decoding does not: it refuses no member that is missing, and fills it
// with nothing. What a generated type requires is read from its JSON tags.
// The generator writes every member a schema leaves optional with omitempty,
// and no other, and a member the schema lets be null as a pointer.
package required

import (
	"encoding/json"
	"reflect"
	"strings"
)

// member is one member a type requires, and whether it may be null.
type member struct {
	name     string
	nullable bool
}

var rawMessage = reflect.TypeFor[json.RawMessage]()

// membersOf is the members generated requires.
func membersOf(generated reflect.Type) []member {
	var members []member
	for i := range generated.NumField() {
		field := generated.Field(i)
		name, options, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" || name == "-" || strings.Contains(options, "omitempty") {
			continue
		}
		kind := field.Type.Kind()
		members = append(members, member{name: name, nullable: kind == reflect.Pointer || kind == reflect.Interface || field.Type == rawMessage})
	}
	return members
}

// Of is the names of the members generated requires.
func Of(generated reflect.Type) []string {
	var names []string
	for _, required := range membersOf(generated) {
		names = append(names, required.name)
	}
	return names
}

// Lacking is the first member generated requires that object lacks, or holds
// null where it may not; false when it lacks none.
func Lacking(object map[string]json.RawMessage, generated reflect.Type) (string, bool) {
	for _, required := range membersOf(generated) {
		raw, has := object[required.name]
		if !has || (!required.nullable && string(raw) == "null") {
			return required.name, true
		}
	}
	return "", false
}

// Carries is whether payload is an object carrying every member generated
// requires.
func Carries(payload []byte, generated reflect.Type) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(payload, &object) != nil || object == nil {
		return false
	}
	_, lacks := Lacking(object, generated)
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
