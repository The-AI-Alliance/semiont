package registry

// When a registry takes two endpoints for one place, as every SDK takes them
// (protocol/specs/src/session/registry-cases.json).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

func TestOnePlaceIsTheTables(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "specs", "src", "session", "registry-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why       string         `json:"why"`
			One       api.KbEndpoint `json:"one"`
			Other     api.KbEndpoint `json:"other"`
			SamePlace bool           `json:"samePlace"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table states no cases")
	}
	for _, row := range table.Cases {
		if got := samePlace(row.One, row.Other); got != row.SamePlace {
			t.Errorf("%s: one place is %v, want %v", row.Why, got, row.SamePlace)
		}
		if got := samePlace(row.Other, row.One); got != row.SamePlace {
			t.Errorf("%s, the other way round: one place is %v, want %v", row.Why, got, row.SamePlace)
		}
	}
}
