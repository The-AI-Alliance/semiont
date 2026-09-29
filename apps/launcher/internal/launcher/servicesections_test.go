package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Which config sections each Node service reads is one list in two languages:
// specs/src/service-config/sections.json, which the TypeScript loader
// generates from and enforces. The launcher forwards by its copy, so the copy
// must be the spec.
func TestServiceSectionsAgreeWithTheSpec(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "service-config", "sections.json"))
	if err != nil {
		t.Fatalf("reading the spec: %v", err)
	}
	var spec struct {
		Services map[string][]string `json:"services"`
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatalf("parsing the spec: %v", err)
	}
	if len(spec.Services) == 0 {
		t.Fatal("the spec lists no services: a gate that compares nothing passes on silence")
	}
	if !reflect.DeepEqual(serviceConfigSections, spec.Services) {
		t.Errorf("serviceConfigSections disagrees with specs/src/service-config/sections.json:\n launcher %v\n spec     %v", serviceConfigSections, spec.Services)
	}
}
