package semiont

// What a client keeps of its queries and of its stream, against
// protocol/specs/src/session/cache-cases.json. Each case runs through the
// client's own live queries, which keep their caches for one person over a
// storage in memory, under the keys protocol/specs/src/session/stored.json
// gives: what a load keeps of a document stored there, what a save writes,
// and what a load of the places keeps.

import (
	"encoding/json"
	"maps"
	"slices"
	"strconv"
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

type cacheCases struct {
	Cases []struct {
		storedCase
		Name  string              `json:"name"`
		Query CacheQuery          `json:"query"`
		Kept  [][]json.RawMessage `json:"kept"`
	} `json:"cases"`
	Writes []struct {
		Name    string              `json:"name"`
		Query   CacheQuery          `json:"query"`
		Held    [][]json.RawMessage `json:"held"`
		Written json.RawMessage     `json:"written"`
	} `json:"writes"`
	Places []struct {
		storedCase
		Name string            `json:"name"`
		Kept map[string]string `json:"kept"`
	} `json:"places"`
}

func readCacheCases(t *testing.T) cacheCases {
	t.Helper()
	table := readSpec[cacheCases](t, "session", "cache-cases.json")
	if len(table.Cases) == 0 || len(table.Writes) == 0 || len(table.Places) == 0 {
		t.Fatal("the table states no cases, writes or places: it was not read")
	}
	return table
}

// keptCache is one kept query's cache, its keys and values as JSON text.
type keptCache interface {
	// hold makes value key's, as an event that carries it does.
	hold(t *testing.T, key, value json.RawMessage)
	// held is every key's value, by the key's JSON text.
	held(t *testing.T) map[string]string
}

type keptCacheOf[K comparable, V any] struct{ cache *Cache[K, V] }

func keptIn[K comparable, V any](cache *Cache[K, V]) keptCache { return keptCacheOf[K, V]{cache} }

func (c keptCacheOf[K, V]) hold(t *testing.T, key, value json.RawMessage) {
	t.Helper()
	c.cache.Set(readJSON[K](t, string(key)), readJSON[V](t, string(value)))
}

func (c keptCacheOf[K, V]) held(t *testing.T) map[string]string {
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

// keptCaches is the cache of each kept query, as a client's live queries
// hold it.
var keptCaches = map[CacheQuery]func(v *live) keptCache{
	CacheQueryResource:    func(v *live) keptCache { return keptIn(v.resource) },
	CacheQueryAnnotations: func(v *live) keptCache { return keptIn(v.annotations) },
	CacheQueryAnnotation:  func(v *live) keptCache { return keptIn(v.annotation) },
	CacheQueryEntityTypes: func(v *live) keptCache { return keptIn(v.entityTypes) },
	CacheQueryTagSchemas:  func(v *live) keptCache { return keptIn(v.tagSchemas) },
}

func keptCacheFor(t *testing.T, query CacheQuery) func(v *live) keptCache {
	t.Helper()
	cache, ok := keptCaches[query]
	if !ok {
		t.Fatalf("the case names %s, which a client does not keep", query)
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
			cacheOf := keptCacheFor(t, c.Query)
			storage := NewMemoryStorage()
			if err := storage.Set(CacheKey(casesKb, casesPerson, c.Query), c.text(t)); err != nil {
				t.Fatal(err)
			}
			v := casesLive(storage)
			defer v.dispose()
			if got, want := cacheOf(v).held(t), entriesAs(c.Kept); !sameEntries(t, got, want) {
				t.Fatalf("kept %v, want %v", got, want)
			}
		})
	}
}

func TestASaveWritesWhatTheCaseTableSays(t *testing.T) {
	for _, c := range readCacheCases(t).Writes {
		t.Run(c.Name, func(t *testing.T) {
			cacheOf := keptCacheFor(t, c.Query)
			storage := NewMemoryStorage()
			v := casesLive(storage)
			cache := cacheOf(v)
			for _, entry := range c.Held {
				cache.hold(t, entry[0], entry[1])
			}
			// Disposing saves what is owed.
			v.dispose()
			text, ok := storage.Get(CacheKey(casesKb, casesPerson, c.Query))
			if !ok {
				t.Fatal("nothing was written under the query's key")
			}
			written := readJSON[map[string]json.RawMessage](t, text)
			stated := readJSON[map[string]json.RawMessage](t, string(c.Written))
			if got, want := slices.Sorted(maps.Keys(written)), slices.Sorted(maps.Keys(stated)); !slices.Equal(got, want) {
				t.Fatalf("the document is written with %v, want %v", got, want)
			}
			if !sameJSON(t, string(written["version"]), string(stated["version"])) {
				t.Fatalf("the document is of version %s, want %s", written["version"], stated["version"])
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
			if got, want := entriesAs(stamped), entriesAs(readJSON[[][]json.RawMessage](t, string(stated["entries"]))); !sameEntries(t, got, want) {
				t.Fatalf("written %v, want %v", got, want)
			}
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
