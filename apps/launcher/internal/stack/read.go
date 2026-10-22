// Package stack reads a knowledge base's documents: the kinds of its stack,
// committed in .semiont/stack/, and its project file, .semiont/config.yaml.
//
// A document is held to its schema in specs/src/stack/ or
// specs/src/kb-identity/ (schemas_gen.go carries their text), the schema
// lint:spec-stack holds the shared cases to, so the schema alone decides a
// document's shape. Only a document that holds to it is decoded into its type
// (types_gen.go).
package stack

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"go.yaml.in/yaml/v3"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// Refusal: one place a document does not hold to its schema.
type Refusal struct {
	// At: the JSON pointer of the value refused, or of the field missing.
	At string
	// Reason: unknown-field, missing-required, wrong-type, not-allowed, or
	// exactly-one — as specs/src/stack/cases.json names them.
	Reason string
	// Line: the line the value is on; for a field missing, its object's.
	Line int
	// Detail: what the schema says of it.
	Detail string
}

// Refused: a document that does not hold to its schema, and each place why.
type Refused struct {
	File     string
	Kind     string
	Refusals []Refusal
}

func (r *Refused) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s is not a %s:", r.File, r.Kind)
	for _, refusal := range r.Refusals {
		fmt.Fprintf(&b, "\n  line %d, %s: %s", refusal.Line, refusal.At, refusal.Detail)
	}
	return b.String()
}

// Read reads the document at path as a document of the kind named, into its
// type: KnowledgeBase, KnowledgeIndex, Issuer, WorkerPool, Inference, or
// ProjectConfig. A document that does not hold to its schema is refused with
// every place it does not.
func Read[T any](path, kindName string) (T, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		var none T
		return none, err
	}
	return Parse[T](path, kindName, text)
}

// Parse is Read of a document already in hand; where names it in a refusal.
func Parse[T any](where, kindName string, text []byte) (T, error) {
	var out T
	refusals, instance, err := check(kindName, text)
	if err != nil {
		return out, fmt.Errorf("%s: %v", where, err)
	}
	if len(refusals) > 0 {
		return out, &Refused{File: where, Kind: kindName, Refusals: refusals}
	}
	decoder := json.NewDecoder(bytes.NewReader(instance))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&out); err != nil {
		return out, fmt.Errorf("%s: %v", where, err)
	}
	return out, nil
}

// Check holds text, as a document of the kind named, to its schema, and
// returns every place it does not: none when it holds.
func Check(kindName string, text []byte) ([]Refusal, error) {
	refusals, _, err := check(kindName, text)
	return refusals, err
}

func check(kindName string, text []byte) ([]Refusal, []byte, error) {
	schema, err := schemaFor(kindName)
	if err != nil {
		return nil, nil, err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(text, &document); err != nil {
		return nil, nil, fmt.Errorf("not YAML: %v", err)
	}
	var value any
	if err := document.Decode(&value); err != nil {
		return nil, nil, fmt.Errorf("not YAML: %v", err)
	}
	instance, err := json.Marshal(value)
	if err != nil {
		return nil, nil, fmt.Errorf("not a document of fields and values: %v", err)
	}
	parsed, err := jsonschema.UnmarshalJSON(bytes.NewReader(instance))
	if err != nil {
		return nil, nil, err
	}
	invalid := schema.Validate(parsed)
	if invalid == nil {
		return nil, instance, nil
	}
	var refused *jsonschema.ValidationError
	if !errors.As(invalid, &refused) {
		return nil, nil, invalid
	}
	return refusalsOf(refused, &document), instance, nil
}

// compiled: each kind's schema, compiled once from the text schemas_gen.go
// carries, under the path its relative references resolve against.
var compiled = sync.OnceValues(func() (map[string]*jsonschema.Schema, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	for path, text := range schemaFiles {
		document, err := jsonschema.UnmarshalJSON(strings.NewReader(text))
		if err != nil {
			return nil, fmt.Errorf("%s: %v", path, err)
		}
		if err := compiler.AddResource(schemaURL(path), document); err != nil {
			return nil, err
		}
	}
	schemas := map[string]*jsonschema.Schema{}
	for name, path := range schemaOf {
		schema, err := compiler.Compile(schemaURL(path))
		if err != nil {
			return nil, err
		}
		schemas[name] = schema
	}
	return schemas, nil
})

func schemaURL(path string) string { return "file:///" + path }

func schemaFor(kindName string) (*jsonschema.Schema, error) {
	schemas, err := compiled()
	if err != nil {
		return nil, err
	}
	schema, known := schemas[kindName]
	if !known {
		return nil, fmt.Errorf("no kind of document is named %q", kindName)
	}
	return schema, nil
}

var english = message.NewPrinter(language.English)

// refusalsOf: each place a validation error tree refuses, named as the cases
// name them. Under a `oneOf` it names the choice, not each branch's misses.
func refusalsOf(root *jsonschema.ValidationError, document *yaml.Node) []Refusal {
	var refusals []Refusal
	add := func(location []string, reason, detail string) {
		refusals = append(refusals, Refusal{At: pointer(location), Reason: reason, Line: lineOf(document, location), Detail: detail})
	}
	var walk func(*jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		location := e.InstanceLocation
		switch k := e.ErrorKind.(type) {
		case *kind.AdditionalProperties:
			for _, field := range k.Properties {
				add(append(append([]string{}, location...), field), "unknown-field", fmt.Sprintf("%q is no field of this document", field))
			}
		case *kind.Required:
			for _, field := range k.Missing {
				add(append(append([]string{}, location...), field), "missing-required", fmt.Sprintf("%q is missing", field))
			}
		case *kind.PropertyNames:
			add(append(append([]string{}, location...), k.Property), "not-allowed", fmt.Sprintf("%q is not a name this map takes", k.Property))
			return
		case *kind.Type:
			add(location, "wrong-type", fmt.Sprintf("wants %s, and is %s", strings.Join(k.Want, " or "), k.Got))
		case *kind.OneOf:
			if k.Subschemas == nil {
				add(location, "exactly-one", "gives neither of the two ways it can be given")
			} else {
				add(location, "exactly-one", "gives both of the ways it can be given, and takes one")
			}
			return
		case *kind.Const, *kind.Enum, *kind.Pattern, *kind.Minimum, *kind.Maximum, *kind.ExclusiveMinimum,
			*kind.ExclusiveMaximum, *kind.MinLength, *kind.MaxLength, *kind.MinProperties, *kind.MaxProperties,
			*kind.Not, *kind.Format, *kind.MultipleOf:
			add(location, "not-allowed", e.ErrorKind.LocalizedString(english))
		}
		for _, cause := range e.Causes {
			walk(cause)
		}
	}
	walk(root)
	return refusals
}

// pointer: a JSON pointer of the tokens of a location.
func pointer(location []string) string {
	var b strings.Builder
	for _, token := range location {
		b.WriteString("/")
		b.WriteString(strings.ReplaceAll(strings.ReplaceAll(token, "~", "~0"), "/", "~1"))
	}
	return b.String()
}

// lineOf: the line of the value at location in the document; when a token of
// it is not there, the line of the last that is.
func lineOf(document *yaml.Node, location []string) int {
	node := document
	if node.Kind == yaml.DocumentNode && len(node.Content) > 0 {
		node = node.Content[0]
	}
	line := node.Line
	for _, token := range location {
		for node.Kind == yaml.AliasNode && node.Alias != nil {
			node = node.Alias
		}
		switch node.Kind {
		case yaml.MappingNode:
			found := false
			for i := 0; i+1 < len(node.Content); i += 2 {
				if node.Content[i].Value == token {
					line, node, found = node.Content[i].Line, node.Content[i+1], true
					break
				}
			}
			if !found {
				return line
			}
		case yaml.SequenceNode:
			index, err := strconv.Atoi(token)
			if err != nil || index < 0 || index >= len(node.Content) {
				return line
			}
			node = node.Content[index]
			line = node.Line
		default:
			return line
		}
	}
	return line
}
