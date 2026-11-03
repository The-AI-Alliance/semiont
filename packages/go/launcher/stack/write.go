package stack

import (
	"bytes"
	"encoding/json"
	"fmt"

	"go.yaml.in/yaml/v3"
)

// APIVersion: the apiVersion every kind's document states — ApiVersion.json's
// const, read from the schema rather than restated.
var APIVersion = func() string {
	var schema struct {
		Const string `json:"const"`
	}
	if err := json.Unmarshal([]byte(schemaFiles["protocol/specs/src/stack/ApiVersion.json"]), &schema); err != nil || schema.Const == "" {
		panic(fmt.Sprintf("protocol/specs/src/stack/ApiVersion.json states no const: %v", err))
	}
	return schema.Const
}()

// Marshal writes a document as YAML, its fields in the order its type gives
// them, as a person would: block style, each value plain where YAML reads it
// back as the same value.
func Marshal(document any) ([]byte, error) {
	text, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	var node yaml.Node
	if err := yaml.Unmarshal(text, &node); err != nil {
		return nil, err
	}
	var plain func(*yaml.Node)
	plain = func(n *yaml.Node) {
		n.Style = 0
		for _, inner := range n.Content {
			plain(inner)
		}
	}
	plain(&node)
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&node); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// SetScalar: text with the value at location — a path of field names to a
// scalar the document has — replaced by value, written as Marshal writes it,
// and every comment kept where it was. It is how a setting changes one field
// of a document a person edits.
func SetScalar(text []byte, location []string, value string) ([]byte, error) {
	var document yaml.Node
	if err := yaml.Unmarshal(text, &document); err != nil {
		return nil, fmt.Errorf("not YAML: %v", err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) == 0 {
		return nil, fmt.Errorf("not a document")
	}
	node := document.Content[0]
	for _, field := range location {
		var next *yaml.Node
		if node.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(node.Content); i += 2 {
				if node.Content[i].Value == field {
					next = node.Content[i+1]
				}
			}
		}
		if next == nil {
			return nil, fmt.Errorf("the document has no %s", pointer(location))
		}
		node = next
	}
	if node.Kind != yaml.ScalarNode {
		return nil, fmt.Errorf("%s is not a single value", pointer(location))
	}
	node.Value, node.Tag, node.Style = value, "", 0
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
