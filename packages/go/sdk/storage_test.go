package semiont

// Where a client keeps what must outlive it: text under a key, and one
// cache's values as one document there.

import (
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

const keptKey = "semiont.cache.kb.resource"

// keeping is what keeps a client's resource descriptions in storage, in a
// document of maxBytes at most.
func keeping(storage SessionStorage, maxBytes int) CachePersister[api.ResourceId, api.ResourceDescriptor] {
	return keptBy[api.ResourceId, api.ResourceDescriptor](&CachePersistence{Storage: storage, KeyPrefix: "kb"}, CacheQueryResource, maxBytes)
}

func descriptorText(id, name string) string {
	return `{"@context":"https://schema.org","@id":"` + id + `","name":"` + name + `","representations":[]}`
}

// keptRow is an entry of a kept document: its value, and when it was written.
type keptRow struct {
	value string
	at    int64
}

// keptDocument is a kept document as it was stored: its version, and its
// entries by key.
type keptDocument struct {
	version int
	rows    map[string]keptRow
}

func documentIn(t *testing.T, storage SessionStorage) keptDocument {
	t.Helper()
	text, ok := storage.Get(keptKey)
	if !ok {
		t.Fatal("nothing is stored under the key")
	}
	members := readJSON[map[string]json.RawMessage](t, text)
	names := slices.Sorted(maps.Keys(members))
	if !slices.Equal(names, []string{"entries", "version"}) {
		t.Fatalf("the document's members are %v", names)
	}
	document := keptDocument{
		version: readJSON[int](t, string(members["version"])),
		rows:    map[string]keptRow{},
	}
	for _, entry := range readJSON[[]json.RawMessage](t, string(members["entries"])) {
		parts := readJSON[[]json.RawMessage](t, string(entry))
		if len(parts) != 3 {
			t.Fatalf("an entry is %s, not a key, its value, and when", entry)
		}
		key := readJSON[string](t, string(parts[0]))
		document.rows[key] = keptRow{value: string(parts[1]), at: readJSON[int64](t, string(parts[2]))}
	}
	return document
}

// saved is persister's save of entries, and the clock's milliseconds before
// and after it.
func saved[K comparable, V any](persister CachePersister[K, V], entries map[K]V) (before, after int64) {
	before = time.Now().UnixMilli()
	persister.Save(entries)
	return before, time.Now().UnixMilli()
}

// pastMillisecond waits until the clock has passed the millisecond at.
func pastMillisecond(at int64) {
	for time.Now().UnixMilli() <= at {
		time.Sleep(time.Millisecond)
	}
}

func textOf(t *testing.T, value any) string {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func TestStorageInMemoryHoldsTextByKey(t *testing.T) {
	storage := NewMemoryStorage()
	if _, ok := storage.Get("a"); ok {
		t.Fatal("an empty storage holds a")
	}
	storage.Set("a", "one")
	storage.Set("b", "two")
	storage.Set("a", "three")
	if a, _ := storage.Get("a"); a != "three" {
		t.Fatalf("a is %q, want three", a)
	}
	if b, _ := storage.Get("b"); b != "two" {
		t.Fatalf("b is %q, want two", b)
	}
	for _, key := range []string{"a", "never there"} {
		if err := storage.Delete(key); err != nil {
			t.Fatalf("deleting %s: %v", key, err)
		}
	}
	if _, ok := storage.Get("a"); ok {
		t.Fatal("a deleted key is still held")
	}
	if b, _ := storage.Get("b"); b != "two" {
		t.Fatalf("b is %q, want two", b)
	}
}

// An update is given what is stored, and stores what it says, or nothing.
func TestAnUpdateIsGivenWhatIsStoredAndStoresWhatItSays(t *testing.T) {
	storage := NewMemoryStorage()
	var given []string
	change := func(next string, keep bool) func(string, bool) (string, bool) {
		return func(stored string, has bool) (string, bool) {
			given = append(given, strconv.FormatBool(has)+":"+stored)
			return next, keep
		}
	}
	if err := storage.Update("a", change("one", true)); err != nil {
		t.Fatal(err)
	}
	if err := storage.Update("a", change("two", true)); err != nil {
		t.Fatal(err)
	}
	if a, _ := storage.Get("a"); a != "two" {
		t.Fatalf("a is %q, want two", a)
	}
	if err := storage.Update("a", change("", false)); err != nil {
		t.Fatal(err)
	}
	if _, ok := storage.Get("a"); ok {
		t.Fatal("an update that stores nothing left a")
	}
	if !slices.Equal(given, []string{"false:", "true:one", "true:two"}) {
		t.Fatalf("the updates were given %q", given)
	}
	// No other context writes a storage in memory: there is nothing to hear.
	if stop, ok := storage.Subscribe(func(string, string, bool) {}); ok || stop != nil {
		t.Fatal("a storage in memory says another context writes it")
	}
}

func TestACachesValuesAreKeptAsOneDocumentAsTheWireHadThemAndComeBackAsTheyWere(t *testing.T) {
	storage := NewMemoryStorage()
	most := DefaultTiming().MaxStoredBytesCount
	if kept := keeping(storage, most).Load(); kept != nil {
		t.Fatalf("an empty storage kept %v", kept)
	}

	// A description as the knowledge base gave it: with a member the schema does not name, and without those it left out.
	said := `{"@context":"https://schema.org","@id":"res-1","name":"A resource","representations":[],"addedByALaterRelease":{"kept":true}}`
	resource := readJSON[api.ResourceDescriptor](t, said)
	id := mustResource(t, "res-1")
	before, after := saved(keeping(storage, most), map[api.ResourceId]api.ResourceDescriptor{id: resource})

	document := documentIn(t, storage)
	row, ok := document.rows["res-1"]
	if document.version != 1 || len(document.rows) != 1 || !ok || row.at < before || row.at > after || !sameJSON(t, row.value, said) {
		t.Fatalf("the document is version %d, its entries %v, want version 1 and the one entry written between %d and %d", document.version, document.rows, before, after)
	}

	kept := keeping(storage, most).Load()
	value, ok := kept[id]
	if len(kept) != 1 || !ok {
		t.Fatalf("kept %v", kept)
	}
	// What it left out is still left out, so it is written back as it came.
	if got := textOf(t, value); !sameJSON(t, got, said) {
		t.Fatalf("the kept description is written back as %s, want %s", got, said)
	}
}

func TestAnEntryKeepsTheTimeItsValueWasLastWritten(t *testing.T) {
	storage := NewMemoryStorage()
	most := DefaultTiming().MaxStoredBytesCount
	persister := keeping(storage, most)
	resource, other := mustResource(t, "res-1"), mustResource(t, "res-2")
	one := readJSON[api.ResourceDescriptor](t, descriptorText("res-1", "A resource"))
	two := readJSON[api.ResourceDescriptor](t, descriptorText("res-2", "A resource"))
	between := func(row keptRow, before, after int64) bool { return row.at >= before && row.at <= after }

	_, first := saved(persister, map[api.ResourceId]api.ResourceDescriptor{resource: one})
	firstAt := documentIn(t, storage).rows["res-1"].at
	pastMillisecond(first)
	before, second := saved(persister, map[api.ResourceId]api.ResourceDescriptor{resource: one, other: two})
	rows := documentIn(t, storage).rows
	if len(rows) != 2 || rows["res-1"].at != firstAt || !between(rows["res-2"], before, second) {
		t.Fatalf("written first at %d, then between %d and %d, the entries are %v", firstAt, before, second, rows)
	}

	// A value that changed is written now; one that is gone is gone.
	pastMillisecond(second)
	renamed := readJSON[api.ResourceDescriptor](t, descriptorText("res-2", "Renamed"))
	before, third := saved(persister, map[api.ResourceId]api.ResourceDescriptor{other: renamed})
	rows = documentIn(t, storage).rows
	if len(rows) != 1 || !between(rows["res-2"], before, third) || !sameJSON(t, rows["res-2"].value, descriptorText("res-2", "Renamed")) {
		t.Fatalf("written between %d and %d, the entries are %v", before, third, rows)
	}
	renamedAt := rows["res-2"].at

	// The next life's persister knows when each was written from the document, not from having written it.
	pastMillisecond(third)
	later := keeping(storage, most)
	kept := later.Load()
	if len(kept) != 1 || textOf(t, kept[other]) != textOf(t, renamed) {
		t.Fatalf("the next life kept %v", kept)
	}
	before, fourth := saved(later, map[api.ResourceId]api.ResourceDescriptor{other: renamed, resource: one})
	rows = documentIn(t, storage).rows
	if len(rows) != 2 || rows["res-2"].at != renamedAt || !between(rows["res-1"], before, fourth) {
		t.Fatalf("written between %d and %d, the entries are %v", before, fourth, rows)
	}
}

func TestADocumentWhoseStructureIsNotTheTablesReadsAsNothingKept(t *testing.T) {
	most := DefaultTiming().MaxStoredBytesCount
	good := `["res-1", ` + descriptorText("res-1", "A resource") + `, 5]`
	for _, stored := range []string{
		"not json",
		"[1, 2]",
		"null",
		`{"version": 2, "entries": []}`,
		`{"version": "1", "entries": []}`,
		`{"entries": []}`,
		`{"version": 1}`,
		`{"version": 1, "entries": {"res-1": {}}}`,
		// One entry that is not a key, a value and a stamp of at least 0 is a document of another structure.
		`{"version": 1, "entries": [` + good + `, ["res-4", {"@context": "https://schema.org", "@id": "res-4", "name": "n", "representations": []}]]}`,
		`{"version": 1, "entries": [` + good + `, ["res-5", {"@context": "https://schema.org", "@id": "res-5", "name": "n", "representations": []}, "when"]]}`,
		`{"version": 1, "entries": [` + good + `, ["res-6", {"@context": "https://schema.org", "@id": "res-6", "name": "n", "representations": []}, true]]}`,
		`{"version": 1, "entries": [` + good + `, ["res-7", {"@context": "https://schema.org", "@id": "res-7", "name": "n", "representations": []}, -1]]}`,
		`{"version": 1, "entries": [` + good + `, "res-8"]}`,
	} {
		t.Run(stored, func(t *testing.T) {
			storage := NewMemoryStorage()
			storage.Set(keptKey, stored)
			if kept := keeping(storage, most).Load(); kept != nil {
				t.Fatalf("kept %v", kept)
			}
		})
	}
	// And one of this version with no entries kept nothing, which is not nothing kept.
	storage := NewMemoryStorage()
	storage.Set(keptKey, `{"version": 1, "entries": []}`)
	if kept := keeping(storage, most).Load(); kept == nil || len(kept) != 0 {
		t.Fatalf("kept %v, want no entries", kept)
	}
}

func TestAnEntryThatIsNotThisCachesShapeIsOneItNeverKept(t *testing.T) {
	storage := NewMemoryStorage()
	good := `["res-1", ` + descriptorText("res-1", "A resource") + `, 5]`
	entries := []string{
		`["not an id", {"@context": "https://schema.org", "@id": "res-9", "name": "n", "representations": []}, 5]`,
		`[null, {"@context": "https://schema.org", "@id": "res-9", "name": "n", "representations": []}, 5]`,
		`["res-3", {"name": "a description with no id"}, 5]`,
		`["res-4", null, 5]`,
		good,
	}
	document := `{"version": 1, "entries": [`
	for i, entry := range entries {
		if i > 0 {
			document += ", "
		}
		document += entry
	}
	storage.Set(keptKey, document+"]}")
	kept := keeping(storage, DefaultTiming().MaxStoredBytesCount).Load()
	value, ok := kept[mustResource(t, "res-1")]
	if len(kept) != 1 || !ok || !sameJSON(t, textOf(t, value), descriptorText("res-1", "A resource")) {
		t.Fatalf("kept %v", kept)
	}
}

func TestADocumentTooLargeLosesTheEntriesThatHaveGoneLongestWithoutANewValueUntilItFits(t *testing.T) {
	ids := make([]api.ResourceId, 4)
	values := map[api.ResourceId]api.ResourceDescriptor{}
	for n := range ids {
		text := "res-" + strconv.Itoa(n+1)
		ids[n] = mustResource(t, text)
		values[ids[n]] = readJSON[api.ResourceDescriptor](t, descriptorText(text, "A resource"))
	}
	of := func(some ...api.ResourceId) map[api.ResourceId]api.ResourceDescriptor {
		chosen := map[api.ResourceId]api.ResourceDescriptor{}
		for _, id := range some {
			chosen[id] = values[id]
		}
		return chosen
	}
	keysOf := func(document keptDocument) []string { return slices.Sorted(maps.Keys(document.rows)) }

	// How large a document of three of them is, and so the most that keeps three and not four.
	measuring := NewMemoryStorage()
	keeping(measuring, DefaultTiming().MaxStoredBytesCount).Save(of(ids[:3]...))
	measured, _ := measuring.Get(keptKey)
	three := len(measured)

	storage := NewMemoryStorage()
	persister := keeping(storage, three)
	_, written := saved(persister, of(ids[0]))
	pastMillisecond(written)
	_, written = saved(persister, of(ids[1], ids[0]))
	pastMillisecond(written)
	_, written = saved(persister, of(ids[2], ids[1], ids[0]))
	stored, _ := storage.Get(keptKey)
	if keys := keysOf(documentIn(t, storage)); !slices.Equal(keys, []string{"res-1", "res-2", "res-3"}) || len(stored) != three {
		t.Fatalf("kept %v in %d bytes, want the three in %d", keys, len(stored), three)
	}

	// A fourth does not fit: the one written longest ago goes, wherever the mapping has it.
	pastMillisecond(written)
	before, written := saved(persister, of(ids[3], ids[2], ids[1], ids[0]))
	fourth := documentIn(t, storage)
	if keys := keysOf(fourth); !slices.Equal(keys, []string{"res-2", "res-3", "res-4"}) || fourth.rows["res-4"].at < before || fourth.rows["res-4"].at > written {
		t.Fatalf("kept %v, want the three written last", fourth.rows)
	}
	// What went is forgotten: kept again, it is as new as when it came back.
	pastMillisecond(written)
	before, written = saved(persister, of(ids[0], ids[3]))
	fifth := documentIn(t, storage)
	if keys := keysOf(fifth); !slices.Equal(keys, []string{"res-1", "res-4"}) || fifth.rows["res-1"].at < before || fifth.rows["res-1"].at > written || fifth.rows["res-4"].at != fourth.rows["res-4"].at {
		t.Fatalf("written between %d and %d, the entries are %v", before, written, fifth.rows)
	}

	// A document no entry fits in keeps none, and is still a document.
	tiny := NewMemoryStorage()
	keeping(tiny, 10).Save(values)
	if keys := keysOf(documentIn(t, tiny)); len(keys) != 0 {
		t.Fatalf("a document of ten bytes kept %v", keys)
	}
	if kept := keeping(tiny, DefaultTiming().MaxStoredBytesCount).Load(); kept == nil || len(kept) != 0 {
		t.Fatalf("kept %v, want no entries", kept)
	}
}
