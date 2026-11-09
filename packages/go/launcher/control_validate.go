package launcher

// control_validate.go — every control message, held to its schema: a request's
// params before anything is done with them, and each result, error and
// notification before it is sent. The schemas are protocol/specs/src/control's
// own text, generated into control_schemas_gen.go.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// controlSchemas: each schema a message is checked against, compiled once.
type controlSchemas struct {
	mu       sync.Mutex
	compiler *jsonschema.Compiler
	compiled map[string]*jsonschema.Schema
}

func compileControlSchemas() (*controlSchemas, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	for path, text := range controlSchemaFiles {
		document, err := jsonschema.UnmarshalJSON(strings.NewReader(text))
		if err != nil {
			return nil, fmt.Errorf("%s: %v", path, err)
		}
		if err := compiler.AddResource(controlSchemaURL(path), document); err != nil {
			return nil, err
		}
	}
	s := &controlSchemas{compiler: compiler, compiled: map[string]*jsonschema.Schema{}}
	paths := []string{controlErrorDataSchema}
	for _, m := range controlMethods {
		paths = append(paths, m.params, m.result)
	}
	for _, n := range controlNotifications {
		paths = append(paths, n.params)
	}
	for _, path := range paths {
		if _, err := s.schema(path); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func controlSchemaURL(path string) string { return "file:///" + path }

func (s *controlSchemas) schema(path string) (*jsonschema.Schema, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if compiled, ok := s.compiled[path]; ok {
		return compiled, nil
	}
	compiled, err := s.compiler.Compile(controlSchemaURL(path))
	if err != nil {
		return nil, err
	}
	s.compiled[path] = compiled
	return compiled, nil
}

// checkParams: a request's params refused, or nil: not an object, written to a
// version this launcher does not speak, or not what the method's schema
// admits.
func (s *controlSchemas) checkParams(method controlMethod, params json.RawMessage) *controlFailure {
	invalid := func(message string, fields []ControlFieldFault) *controlFailure {
		return &controlFailure{code: controlCodeInvalidParams, message: message, fields: fields, rpcCode: rpcInvalidParams}
	}
	trimmed := bytes.TrimSpace(params)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return invalid(method.name+"'s params are an object", []ControlFieldFault{{Field: "", Message: "is not an object"}})
	}
	var stated struct {
		APIVersion *json.RawMessage `json:"apiVersion"`
	}
	if err := json.Unmarshal(trimmed, &stated); err != nil {
		return invalid(method.name+"'s params are not JSON: "+err.Error(), nil)
	}
	if stated.APIVersion != nil {
		var version string
		if json.Unmarshal(*stated.APIVersion, &version) == nil && version != controlAPIVersion {
			return &controlFailure{code: controlCodeUnsupportedApiVersion, rpcCode: rpcInvalidParams,
				message:   fmt.Sprintf("this launcher speaks %s, not %s", controlAPIVersion, version),
				supported: []string{controlAPIVersion}}
		}
	}
	if fault := s.check(method.params, trimmed); fault != nil {
		return invalid(method.name+"'s params: "+fault.message, fault.fields)
	}
	return nil
}

// check holds text to the schema at path: nil when it holds, else each fault.
func (s *controlSchemas) check(path string, text []byte) *controlFailure {
	schema, err := s.schema(path)
	if err != nil {
		return &controlFailure{message: err.Error()}
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(text))
	if err != nil {
		return &controlFailure{message: "not JSON: " + err.Error()}
	}
	invalid := schema.Validate(instance)
	if invalid == nil {
		return nil
	}
	var refused *jsonschema.ValidationError
	if !errors.As(invalid, &refused) {
		return &controlFailure{message: invalid.Error()}
	}
	fields := schemaFaults(refused)
	said := make([]string, len(fields))
	for i, f := range fields {
		at := f.Field
		if at == "" {
			at = "(the whole)"
		}
		said[i] = at + " " + f.Message
	}
	return &controlFailure{message: strings.Join(said, "; "), fields: fields}
}

var controlEnglish = message.NewPrinter(language.English)

// schemaFaults: each place a validation error tree refuses, as a JSON pointer
// and what is wrong there. Under a `oneOf` it names the choice, not each
// branch's misses.
func schemaFaults(root *jsonschema.ValidationError) []ControlFieldFault {
	var faults []ControlFieldFault
	add := func(location []string, said string) {
		faults = append(faults, ControlFieldFault{Field: jsonPointer(location), Message: said})
	}
	var walk func(*jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		location := e.InstanceLocation
		switch k := e.ErrorKind.(type) {
		case *kind.AdditionalProperties:
			for _, name := range k.Properties {
				add(append(append([]string{}, location...), name), "is not a member this takes")
			}
		case *kind.Required:
			for _, name := range k.Missing {
				add(append(append([]string{}, location...), name), "is required, and is missing")
			}
		case *kind.Type:
			add(location, fmt.Sprintf("wants %s, and is %s", strings.Join(k.Want, " or "), k.Got))
		case *kind.OneOf:
			if k.Subschemas == nil {
				add(location, "is none of the forms it can take")
			} else {
				add(location, "is more than one of the forms it can take, and must be exactly one")
			}
			return
		case *kind.Const, *kind.Enum, *kind.Pattern, *kind.Minimum, *kind.MinLength, *kind.Not:
			add(location, e.ErrorKind.LocalizedString(controlEnglish))
		}
		for _, cause := range e.Causes {
			walk(cause)
		}
	}
	walk(root)
	if len(faults) == 0 {
		faults = []ControlFieldFault{{Field: "", Message: root.Error()}}
	}
	return faults
}

// jsonPointer: RFC 6901's pointer to location.
func jsonPointer(location []string) string {
	var b strings.Builder
	for _, step := range location {
		b.WriteString("/")
		b.WriteString(strings.ReplaceAll(strings.ReplaceAll(step, "~", "~0"), "/", "~1"))
	}
	return b.String()
}
