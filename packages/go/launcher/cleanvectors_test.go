package launcher

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// A clean deletes a knowledge base's collections at the shared Qdrant by
// their names, which the Smelter made them under, so the launcher names them
// as every case of protocol/specs/src/vectors/payload-cases.json that states
// `collectionsNamed` does, and its words are the table's `collections`:
// a table that grows a collection fails here until the clean deletes it too.
func TestIndexCollectionsAreNamedAsTheTableNamesThem(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "specs", "src", "vectors", "payload-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Collections map[string]json.RawMessage `json:"collections"`
		Cases       []struct {
			Why              string `json:"why"`
			CollectionsNamed *struct {
				KB    string            `json:"kb"`
				Names map[string]string `json:"names"`
			} `json:"collectionsNamed"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if got, want := slices.Sorted(slices.Values(indexCollectionWords)), slices.Sorted(maps.Keys(table.Collections)); !slices.Equal(got, want) {
		t.Errorf("the clean deletes the collections %q, and the table states %q", got, want)
	}
	named := 0
	for _, c := range table.Cases {
		if c.CollectionsNamed == nil {
			continue
		}
		named++
		t.Run(c.Why, func(t *testing.T) {
			if got := indexCollections(c.CollectionsNamed.KB); !maps.Equal(got, c.CollectionsNamed.Names) {
				t.Errorf("%s's collections are named\n  %v\nwant\n  %v", c.CollectionsNamed.KB, got, c.CollectionsNamed.Names)
			}
		})
	}
	if named == 0 {
		t.Fatal("the table states no collectionsNamed case")
	}
}
