package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// How a ${VAR} in a knowledge base's config resolves is one rule in two
// languages: every case in specs/src/config-placeholders/cases.json, run
// through the resolver the launcher writes the gateway's configuration
// document with. The TypeScript loader runs the same table
// (packages/core/src/__tests__/config-placeholders-agreement.test.ts).
func TestPlaceholdersAgreeWithTheSharedTable(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "config-placeholders", "cases.json"))
	if err != nil {
		t.Fatalf("reading the shared table: %v", err)
	}
	var table struct {
		Cases []struct {
			Why      string            `json:"why"`
			Template string            `json:"template"`
			Env      map[string]string `json:"env"`
			Result   *string           `json:"result"`
			Error    *string           `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatalf("parsing the shared table: %v", err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table has no cases: a gate that runs nothing passes on silence")
	}
	for _, c := range table.Cases {
		got, err := resolveRefs("field", c.Template, c.Env)
		switch {
		case c.Error != nil:
			if err == nil || !strings.Contains(err.Error(), *c.Error) {
				t.Errorf("%s: want an error naming %q, got %q (err %v)", c.Why, *c.Error, got, err)
			}
		case err != nil:
			t.Errorf("%s: unexpected error %v", c.Why, err)
		case got != *c.Result:
			t.Errorf("%s: got %q, want %q", c.Why, got, *c.Result)
		}
	}
}
