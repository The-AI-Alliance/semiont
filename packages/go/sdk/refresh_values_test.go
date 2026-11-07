package semiont

// What each live query's cache holds, against
// protocol/specs/src/client/refresh.json: every query of the table is a live
// query of the client's, whose cache holds the type refresh_gen.go generates
// from the query's `value` (queryCaches does not compile otherwise), and a
// persisted query's cache is keyed as its `per` says.

import (
	"maps"
	"reflect"
	"slices"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// keptKeys is the type of a persisted query's keys, by what the refresh
// table says it is kept per; absent, the knowledge base has one.
var keptKeys = map[string]reflect.Type{
	"resource":   reflect.TypeFor[api.ResourceId](),
	"annotation": reflect.TypeFor[api.AnnotationId](),
	"":           reflect.TypeFor[whole](),
}

func TestEachLiveQuerysCacheHoldsTheValueTheRefreshTableNames(t *testing.T) {
	refresh := readSpec[struct {
		Queries []struct {
			Name      CacheQuery `json:"name"`
			Per       string     `json:"per"`
			Persisted bool       `json:"persisted"`
		} `json:"queries"`
	}](t, "client", "refresh.json")
	var named []CacheQuery
	for _, query := range refresh.Queries {
		named = append(named, query.Name)
	}
	if got, want := slices.Sorted(maps.Keys(queryCaches)), slices.Sorted(slices.Values(named)); len(want) == 0 || !slices.Equal(got, want) {
		t.Fatalf("Go's live queries are %v; the refresh table's are %v", got, want)
	}
	// Of a client that holds nothing: only the types of its caches are read.
	unheld := new(live)
	for _, query := range refresh.Queries {
		if !query.Persisted {
			continue
		}
		key, ok := keptKeys[query.Per]
		if !ok {
			t.Errorf("%s is persisted, kept per %q, which no kept document's key is", query.Name, query.Per)
			continue
		}
		if got := queryCaches[query.Name](unheld).keyType(); got != key {
			t.Errorf("%s's cache is keyed by %s; the table keeps it per %q, a %s", query.Name, got, query.Per, key)
		}
	}
}
