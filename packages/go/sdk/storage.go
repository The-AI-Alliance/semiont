package semiont

// Where a client keeps what must outlive it: text under a key.
//
// More than one context can write a store: two windows, two processes. What
// is written from what was read goes through Update, which a store makes one
// step, so one writer's change is never lost under another's.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

// SessionStorage is a store of text by key: the seam an application fills in
// (a file, a platform's store), so nothing above it knows where it runs.
type SessionStorage interface {
	// Get is what is stored under key; false when nothing is.
	Get(key string) (string, bool)
	// Set stores value under key, in place of what was there; the error when
	// it could not.
	Set(key, value string) error
	// Delete removes a key. One that is not there is left not there. The
	// error when it could not be removed.
	Delete(key string) error
	// Update changes key's value as one step: change is given what is
	// stored, false when nothing is, and says what is stored next, false for
	// nothing. No other writer's change falls between the read and the
	// write. The error when what change says could not be stored.
	Update(key string, change func(stored string, has bool) (next string, keep bool)) error
	// Subscribe hears what another context writes: another process, another
	// window. onChange is given the key, and the value written, or false when
	// the key was removed; stop ends the subscription. False where the
	// environment has no other context: a client then works correctly within
	// its own.
	Subscribe(onChange func(key, value string, has bool)) (stop func(), ok bool)
}

// MemoryStorage is a SessionStorage kept for as long as the process lives: a
// client that closes and one that opens after it, over the same storage, are
// a reload.
type MemoryStorage struct {
	mu     sync.Mutex
	stored map[string]string
}

var _ SessionStorage = (*MemoryStorage)(nil)

// NewMemoryStorage is a MemoryStorage holding nothing.
func NewMemoryStorage() *MemoryStorage {
	return &MemoryStorage{stored: map[string]string{}}
}

func (m *MemoryStorage) Get(key string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.stored[key]
	return value, ok
}

func (m *MemoryStorage) Set(key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stored[key] = value
	return nil
}

func (m *MemoryStorage) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.stored, key)
	return nil
}

func (m *MemoryStorage) Update(key string, change func(stored string, has bool) (string, bool)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	stored, has := m.stored[key]
	if next, keep := change(stored, has); keep {
		m.stored[key] = next
	} else {
		delete(m.stored, key)
	}
	return nil
}

// Subscribe hears nothing: no other context writes a MemoryStorage.
func (m *MemoryStorage) Subscribe(func(key, value string, has bool)) (func(), bool) {
	return nil, false
}

// CachePersistence is where a client keeps what its queries hold for one
// person, so the next client of the same knowledge base, for the same person,
// shows it at once. The queries PersistedCacheQueries names are kept, each a
// document in Storage under CacheKey(KbID, PersonKey, query), which a client
// of any SDK reads and writes alike.
type CachePersistence struct {
	Storage SessionStorage
	KbID    string
	// PersonKey is the person's key (PersonKey).
	PersonKey string
	// refused is told each write the storage refuses: the session's errors,
	// for a client a session keeps for; a log line, for a client given its
	// persistence directly (ClientConfig).
	refused func(error)
}

// PersonKey is the key what a client keeps of a person is kept under, made of
// the did the gateway answers for the person's token: never the did itself.
// The keys are protocol/specs/src/session/stored.json's.
func PersonKey(did string) string { return sha256URLSafe(did) }

// CacheKey is the key what a client keeps of query, for the person whose key
// is personKey, is kept under in a knowledge base's storage.
func CacheKey(kbID, personKey string, query CacheQuery) string {
	return "semiont.cache." + kbID + "." + personKey + "." + string(query)
}

// LastEventIDKey is the key where a knowledge base's stream was, for the
// person whose key is personKey, is kept under.
func LastEventIDKey(kbID, personKey string) string {
	return "semiont.lastEventId." + kbID + "." + personKey
}

// keptVersion is the version of a kept document, as
// protocol/specs/src/session/stored.json's `cacheDocument` states it. A
// document of another version reads as nothing kept.
const keptVersion = 1

// wholeKey is the key a kept query of one value keeps its entry under, as
// protocol/specs/src/session/stored.json states it.
const wholeKey = "_"

// keptEntry is a kept entry as it was last written: its value's text, and when.
type keptEntry struct {
	value string
	at    int64
}

// StoragePersister keeps one cache's values in storage, as one document under
// one key: {version, entries}, each entry a key, its value, and when that
// value was received. A document whose structure is not
// protocol/specs/src/session/stored.json's `cacheDocument` reads as nothing
// kept; an entry whose key is no K, or whose value is no V, is skipped. A
// document larger than maxBytes loses the entries that have gone longest
// without a new value, until it fits.
type StoragePersister[K comparable, V any] struct {
	storage  SessionStorage
	key      string
	maxBytes int

	mu sync.Mutex
	// written is each key's value as last written, and when: an entry whose
	// value has not changed keeps its time.
	written map[string]keptEntry
}

var _ CachePersister[string, string] = (*StoragePersister[string, string])(nil)

// NewStoragePersister keeps a cache's values in storage under key, in a
// document of at most maxBytes.
func NewStoragePersister[K comparable, V any](storage SessionStorage, key string, maxBytes int) *StoragePersister[K, V] {
	return &StoragePersister[K, V]{storage: storage, key: key, maxBytes: maxBytes}
}

func (p *StoragePersister[K, V]) Load() map[K]V {
	raw, ok := p.storage.Get(p.key)
	if !ok {
		return nil
	}
	entries, ok := documentEntries(raw)
	if !ok {
		return nil
	}
	kept := map[K]V{}
	seen := map[string]keptEntry{}
	for _, entry := range entries {
		key, keyRead := keyAs[K](entry.key)
		value, valueRead := required.ReadAs[V](entry.value)
		if !keyRead || !valueRead {
			continue
		}
		kept[key] = value
		seen[compact(entry.key)] = keptEntry{value: compact(entry.value), at: entry.at}
	}
	p.mu.Lock()
	p.written = seen
	p.mu.Unlock()
	return kept
}

// storedEntry is an entry of a kept document as it is stored: its key's text,
// its value's, and when the value was received.
type storedEntry struct {
	key, value json.RawMessage
	at         int64
}

// documentEntries is the entries of the kept document raw; false when its
// structure is not `cacheDocument`'s: it is no JSON object, its version is
// not the number keptVersion, its entries are no list, or an entry is not a
// key, a value and a stamp that is a whole number of at least 0. A number is
// its value, however it is written: 1.0 is the version and 1e3 a stamp.
func documentEntries(raw string) ([]storedEntry, bool) {
	var document struct {
		Version *float64          `json:"version"`
		Entries []json.RawMessage `json:"entries"`
	}
	if json.Unmarshal([]byte(raw), &document) != nil || document.Version == nil || *document.Version != keptVersion || document.Entries == nil {
		return nil, false
	}
	entries := make([]storedEntry, 0, len(document.Entries))
	for _, entry := range document.Entries {
		var parts []json.RawMessage
		if json.Unmarshal(entry, &parts) != nil || len(parts) != 3 {
			return nil, false
		}
		at, ok := stampOf(parts[2])
		if !ok {
			return nil, false
		}
		entries = append(entries, storedEntry{key: parts[0], value: parts[1], at: at})
	}
	return entries, true
}

// stampOf is text read as a stamp, and whether it is one: a number with no
// fractional part, at least 0, that an int64 holds.
func stampOf(text json.RawMessage) (int64, bool) {
	var at *float64
	if json.Unmarshal(text, &at) != nil || at == nil || *at < 0 || *at != math.Trunc(*at) || *at >= math.MaxInt64 {
		return 0, false
	}
	return int64(*at), true
}

// keyAs is text read as a key of K, and whether it is one. Null is none: Go's
// decoding leaves an id it is given null as its zero value, which is no id.
func keyAs[K any](text json.RawMessage) (K, bool) {
	var key K
	if string(text) == "null" || json.Unmarshal(text, &key) != nil {
		return key, false
	}
	return key, true
}

func (p *StoragePersister[K, V]) Save(entries map[K]V) error {
	now := time.Now().UnixMilli()
	type stored struct {
		key, value string
		at         int64
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var kept []stored
	for key, value := range entries {
		keyText, keyErr := json.Marshal(key)
		valueText, valueErr := json.Marshal(value)
		if keyErr != nil || valueErr != nil {
			continue
		}
		at := now
		if before, ok := p.written[string(keyText)]; ok && before.value == string(valueText) {
			at = before.at
		}
		kept = append(kept, stored{key: string(keyText), value: string(valueText), at: at})
	}
	document := func() string {
		var b bytes.Buffer
		fmt.Fprintf(&b, `{"version":%d,"entries":[`, keptVersion)
		for i, entry := range kept {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, "[%s,%s,%d]", entry.key, entry.value, entry.at)
		}
		b.WriteString("]}")
		return b.String()
	}
	text := document()
	if len(text) > p.maxBytes {
		// The entries that have gone longest without a new value are the first to go.
		sort.Slice(kept, func(i, j int) bool { return kept[i].at < kept[j].at })
		for len(kept) > 0 && len(text) > p.maxBytes {
			kept = kept[1:]
			text = document()
		}
	}
	p.written = map[string]keptEntry{}
	for _, entry := range kept {
		p.written[entry.key] = keptEntry{value: entry.value, at: entry.at}
	}
	return p.storage.Set(p.key, text)
}

// compact is JSON text written without spaces, as Save writes it.
func compact(raw json.RawMessage) string {
	var b bytes.Buffer
	if json.Compact(&b, raw) != nil {
		return string(raw)
	}
	return b.String()
}
