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
	if err := json.Unmarshal([]byte(schemaFiles["specs/src/stack/ApiVersion.json"]), &schema); err != nil || schema.Const == "" {
		panic(fmt.Sprintf("specs/src/stack/ApiVersion.json states no const: %v", err))
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
