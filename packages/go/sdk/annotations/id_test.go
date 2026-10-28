package annotations

// The id an annotation builder derives, held to
// specs/src/annotations/id-cases.json: the derivation every SDK's builders
// use.

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

func TestTheIdOfAnAnnotationIsTheTablesForWhatItIs(t *testing.T) {
	text, err := os.ReadFile("../../../../specs/src/annotations/id-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why        string          `json:"why"`
			ResourceID string          `json:"resourceId"`
			Motivation api.Motivation  `json:"motivation"`
			Anchor     string          `json:"anchor"`
			Body       json.RawMessage `json:"body"`
			ID         string          `json:"id"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table has no case")
	}
	for _, stated := range table.Cases {
		resource, err := api.ParseResourceId(stated.ResourceID)
		if err != nil {
			t.Fatalf("%s: %v", stated.Why, err)
		}
		id, err := annotationID(resource, stated.Motivation, stated.Anchor, stated.Body)
		if err != nil {
			t.Errorf("%s: %v", stated.Why, err)
			continue
		}
		if id.String() != stated.ID {
			t.Errorf("%s: the id is %s, and the table says %s", stated.Why, id, stated.ID)
		}
	}
}
