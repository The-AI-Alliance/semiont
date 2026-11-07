package registry

// When a registry takes two endpoints for one place, and the order it shows
// the resources open in a knowledge base in, as every SDK takes them
// (protocol/specs/src/session/registry-cases.json).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

type registryCases struct {
	Cases []struct {
		Why       string         `json:"why"`
		One       api.KbEndpoint `json:"one"`
		Other     api.KbEndpoint `json:"other"`
		SamePlace bool           `json:"samePlace"`
	} `json:"cases"`
	OpenResourceOrder []struct {
		Why   string          `json:"why"`
		Open  json.RawMessage `json:"open"`
		Shown []string        `json:"shown"`
	} `json:"openResourceOrder"`
}

func readRegistryCases(t *testing.T) registryCases {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "specs", "src", "session", "registry-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table registryCases
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	return table
}

func TestOnePlaceIsTheTables(t *testing.T) {
	table := readRegistryCases(t)
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

func TestTheOrderOpenResourcesAreShownInIsTheTables(t *testing.T) {
	table := readRegistryCases(t)
	if len(table.OpenResourceOrder) == 0 {
		t.Fatal("the table states no order of open resources")
	}
	for _, row := range table.OpenResourceOrder {
		open, ok := required.ReadAs[[]OpenResource](row.Open)
		if !ok {
			t.Fatalf("%s: the open resources do not read as a registry keeps them", row.Why)
		}
		var shown []string
		for _, resource := range SortOpenResources(open) {
			shown = append(shown, resource.ID.String())
		}
		if !slices.Equal(shown, row.Shown) {
			t.Errorf("%s: shown %v, want %v", row.Why, shown, row.Shown)
		}
	}
}
