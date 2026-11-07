package semiont

// What a client keeps of its queries and of its stream, against
// protocol/specs/src/session/cache-cases.json. Each case runs through the
// client's own live queries, which keep their caches for one person over a
// storage in memory, under the keys protocol/specs/src/session/stored.json
// gives: what a load keeps of a document stored there, what a save writes,
// what a save the storage refused leaves owed, and what a load of the places
// keeps.

import (
	"encoding/json"
	"errors"
	"maps"
	"reflect"
	"slices"
	"strconv"
	"sync/atomic"
	"testing"
)

// casesKb is the knowledge base the cases' caches and places are kept for.
const casesKb = "kb"

// casesPerson is the key of the person the cases' caches and places are kept
// for.
var casesPerson = PersonKey("did:web:kb.example.org:users:jo%40example.org")

// storedCase is what a case keeps under its key before the load: stored as
// its JSON text, or storedText as it is.
type storedCase struct {
	Stored     json.RawMessage `json:"stored"`
	StoredText *string         `json:"storedText"`
}

func (c storedCase) text(t *testing.T) string {
	t.Helper()
	switch {
	case c.Stored != nil && c.StoredText == nil:
		return string(c.Stored)
	case c.Stored == nil && c.StoredText != nil:
		return *c.StoredText
	}
	t.Fatal("the case states not one of stored and storedText")
	return ""
}

// cacheWrite is a save of a query's cache: held is what it holds once its
// answers came, and written the document the save writes.
type cacheWrite struct {
	Name    string              `json:"name"`
	Query   CacheQuery          `json:"query"`
	Held    [][]json.RawMessage `json:"held"`
	Written json.RawMessage     `json:"written"`
}

type cacheCases struct {
	Cases []struct {
		storedCase
		Name  string              `json:"name"`
		Query CacheQuery          `json:"query"`
		Kept  [][]json.RawMessage `json:"kept"`
	} `json:"cases"`
	Writes        []cacheWrite `json:"writes"`
	RefusedWrites []cacheWrite `json:"refusedWrites"`
	Places        []struct {
		storedCase
		Name string            `json:"name"`
		Kept map[string]string `json:"kept"`
	} `json:"places"`
}

func readCacheCases(t *testing.T) cacheCases {
	t.Helper()
	table := readSpec[cacheCases](t, "session", "cache-cases.json")
	if len(table.Cases) == 0 || len(table.Writes) == 0 || len(table.RefusedWrites) == 0 || len(table.Places) == 0 {
		t.Fatal("the table states no cases, writes, refused writes or places: it was not read")
	}
	return table
}

// queryCache is one live query's cache, its keys and values as JSON text.
type queryCache interface {
	// hold makes value key's, as an event that carries it does.
	hold(t *testing.T, key, value json.RawMessage)
	// held is every key's value, by the key's JSON text.
	held(t *testing.T) map[string]string
	// keyType is the type of the cache's keys.
	keyType() reflect.Type
}

type queryCacheOf[K comparable, V any] struct{ cache *Cache[K, V] }

// cacheOf is cache, whose values are a V: given the type refresh_gen.go
// generates from the query's `value`, a cache that holds another does not
// compile.
func cacheOf[V any, K comparable](cache *Cache[K, V]) queryCache { return queryCacheOf[K, V]{cache} }

func (c queryCacheOf[K, V]) hold(t *testing.T, key, value json.RawMessage) {
	t.Helper()
	c.cache.Set(readJSON[K](t, string(key)), readJSON[V](t, string(value)))
}

func (c queryCacheOf[K, V]) held(t *testing.T) map[string]string {
	t.Helper()
	held := map[string]string{}
	for _, key := range c.cache.Keys() {
		value, ok := c.cache.Get(key)
		if !ok {
			t.Fatalf("%s is held with no value", textOf(t, key))
		}
		held[textOf(t, key)] = textOf(t, value)
	}
	return held
}

func (queryCacheOf[K, V]) keyType() reflect.Type { return reflect.TypeFor[K]() }

// queryCaches is the cache of each live query, as a client's live queries
// hold it, holding the value refresh_gen.go generates for the query.
// refresh_values_test.go holds it to every query of
// protocol/specs/src/client/refresh.json.
var queryCaches = map[CacheQuery]func(v *live) queryCache{
	CacheQueryResource:         func(v *live) queryCache { return cacheOf[resourceValue](v.resource) },
	CacheQueryAnnotations:      func(v *live) queryCache { return cacheOf[annotationsValue](v.annotations) },
	CacheQueryAnnotation:       func(v *live) queryCache { return cacheOf[annotationValue](v.annotation) },
	CacheQueryEvents:           func(v *live) queryCache { return cacheOf[eventsValue](v.events) },
	CacheQueryReferencedBy:     func(v *live) queryCache { return cacheOf[referencedByValue](v.referencedBy) },
	CacheQueryResources:        func(v *live) queryCache { return cacheOf[resourcesValue](v.resources) },
	CacheQueryMatchedResources: func(v *live) queryCache { return cacheOf[matchedResourcesValue](v.matchedResources) },
	CacheQueryEntityTypes:      func(v *live) queryCache { return cacheOf[entityTypesValue](v.entityTypes) },
	CacheQueryTagSchemas:       func(v *live) queryCache { return cacheOf[tagSchemasValue](v.tagSchemas) },
	CacheQueryEngines:          func(v *live) queryCache { return cacheOf[enginesValue](v.engines) },
}

// keptCacheFor is the cache of query, which the refresh table must persist.
func keptCacheFor(t *testing.T, query CacheQuery) func(v *live) queryCache {
	t.Helper()
	if !slices.Contains(PersistedCacheQueries, query) {
		t.Fatalf("the case names %s, which the refresh table does not persist", query)
	}
	cache, ok := queryCaches[query]
	if !ok {
		t.Fatalf("the case names %s, which is no live query", query)
	}
	return cache
}

// casesLive is a client's live queries, keeping their caches in storage for
// casesPerson on casesKb. Nothing they hold is fetched.
func casesLive(storage SessionStorage) *live {
	v := newLive(&links{timing: DefaultTiming()}, nil)
	v.attach(&CachePersistence{Storage: storage, KbID: casesKb, PersonKey: casesPerson})
	return v
}

// entriesAs is entries, each a key and a value, by the key's JSON text.
func entriesAs(entries [][]json.RawMessage) map[string]string {
	read := map[string]string{}
	for _, entry := range entries {
		read[compact(entry[0])] = string(entry[1])
	}
	return read
}

// sameEntries is whether got and want hold the same keys, each with one
// JSON value.
func sameEntries(t *testing.T, got, want map[string]string) bool {
	t.Helper()
	if !slices.Equal(slices.Sorted(maps.Keys(got)), slices.Sorted(maps.Keys(want))) {
		return false
	}
	for key, value := range want {
		if !sameJSON(t, got[key], value) {
			return false
		}
	}
	return true
}

func TestALoadKeepsWhatTheCaseTableSays(t *testing.T) {
	for _, c := range readCacheCases(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			cacheIn := keptCacheFor(t, c.Query)
			storage := NewMemoryStorage()
			if err := storage.Set(CacheKey(casesKb, casesPerson, c.Query), c.text(t)); err != nil {
				t.Fatal(err)
			}
			v := casesLive(storage)
			defer v.dispose()
			if got, want := cacheIn(v).held(t), entriesAs(c.Kept); !sameEntries(t, got, want) {
				t.Fatalf("kept %v, want %v", got, want)
			}
		})
	}
}

// writtenAsStated fails unless the document under key is the one stated: its
// members and version as stated, its entries compared as a map, and each
// entry's stamp an integer of at least 0.
func writtenAsStated(t *testing.T, storage SessionStorage, key string, stated json.RawMessage) {
	t.Helper()
	text, ok := storage.Get(key)
	if !ok {
		t.Fatal("nothing was written under the query's key")
	}
	written := readJSON[map[string]json.RawMessage](t, text)
	members := readJSON[map[string]json.RawMessage](t, string(stated))
	if got, want := slices.Sorted(maps.Keys(written)), slices.Sorted(maps.Keys(members)); !slices.Equal(got, want) {
		t.Fatalf("the document is written with %v, want %v", got, want)
	}
	if !sameJSON(t, string(written["version"]), string(members["version"])) {
		t.Fatalf("the document is of version %s, want %s", written["version"], members["version"])
	}
	var stamped [][]json.RawMessage
	for _, entry := range readJSON[[][]json.RawMessage](t, string(written["entries"])) {
		if len(entry) != 3 {
			t.Fatalf("an entry is written as %s, not a key, a value and a stamp", entry)
		}
		if at, err := strconv.ParseInt(string(entry[2]), 10, 64); err != nil || at < 0 {
			t.Fatalf("an entry is stamped %s, not a whole number of at least 0", entry[2])
		}
		stamped = append(stamped, entry[:2])
	}
	if got, want := entriesAs(stamped), entriesAs(readJSON[[][]json.RawMessage](t, string(members["entries"]))); !sameEntries(t, got, want) {
		t.Fatalf("written %v, want %v", got, want)
	}
}

func TestASaveWritesWhatTheCaseTableSays(t *testing.T) {
	for _, c := range readCacheCases(t).Writes {
		t.Run(c.Name, func(t *testing.T) {
			cacheIn := keptCacheFor(t, c.Query)
			storage := NewMemoryStorage()
			v := casesLive(storage)
			cache := cacheIn(v)
			for _, entry := range c.Held {
				cache.hold(t, entry[0], entry[1])
			}
			// Disposing saves what is owed.
			v.dispose()
			writtenAsStated(t, storage, CacheKey(casesKb, casesPerson, c.Query), c.Written)
		})
	}
}

// refusingFirst is a storage in memory that refuses the first write under
// key, and takes every write after it.
type refusingFirst struct {
	*MemoryStorage
	key     string
	refused atomic.Bool
}

// refuses is whether a write under key is the one refused.
func (s *refusingFirst) refuses(key string) bool {
	return key == s.key && s.refused.CompareAndSwap(false, true)
}

func (s *refusingFirst) Set(key, value string) error {
	if s.refuses(key) {
		return errors.New("the storage refuses the first write of the query's document")
	}
	return s.MemoryStorage.Set(key, value)
}

func (s *refusingFirst) Update(key string, change func(stored string, has bool) (string, bool)) error {
	if s.refuses(key) {
		return errors.New("the storage refuses the first write of the query's document")
	}
	return s.MemoryStorage.Update(key, change)
}

// A write the storage refuses leaves the save owed (B17): the cache is not
// settled after it, and disposal's flush writes what it holds.
func TestARefusedWriteStaysOwedAsTheCaseTableSays(t *testing.T) {
	for _, c := range readCacheCases(t).RefusedWrites {
		t.Run(c.Name, func(t *testing.T) {
			cacheIn := keptCacheFor(t, c.Query)
			key := CacheKey(casesKb, casesPerson, c.Query)
			storage := &refusingFirst{MemoryStorage: NewMemoryStorage(), key: key}
			v := casesLive(storage)
			cache := cacheIn(v)
			for _, entry := range c.Held {
				cache.hold(t, entry[0], entry[1])
			}
			// The save owed once the values stop changing is made, and refused.
			eventually(t, "the storage refused the save", storage.refused.Load)
			eventually(t, "the cache owes its save after the refusal", func() bool { return !v.persistenceSettled() })
			// Disposing makes the save owed, and the storage takes it.
			v.dispose()
			writtenAsStated(t, storage, key, c.Written)
		})
	}
}

func TestALoadOfThePlacesKeepsWhatTheCaseTableSays(t *testing.T) {
	key := LastEventIDKey(casesKb, casesPerson)
	for _, c := range readCacheCases(t).Places {
		t.Run(c.Name, func(t *testing.T) {
			storage := NewMemoryStorage()
			if err := storage.Set(key, c.text(t)); err != nil {
				t.Fatal(err)
			}
			got := map[string]string{}
			for scope, place := range NewCoupledBookmarks(storage, key).Load() {
				got[scope.String()] = place
			}
			if !maps.Equal(got, c.Kept) {
				t.Fatalf("kept %v, want %v", got, c.Kept)
			}
		})
	}
}
