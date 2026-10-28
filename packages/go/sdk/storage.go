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
	"reflect"
	"sort"
	"strconv"
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
	// Delete removes a key. One that is not there is left not there.
	Delete(key string)
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

func (m *MemoryStorage) Delete(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.stored, key)
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

// CachePersistence is where a client keeps what its queries hold, so the next
// client of the same knowledge base shows it at once. The small queries are
// kept: a resource's description, its annotations, one annotation, the entity
// types, the tag schemas. Each is a document in Storage, under
// semiont.cache.<KeyPrefix>.<query>.
type CachePersistence struct {
	Storage   SessionStorage
	KeyPrefix string
}

// keptVersion is the version of what the kept caches hold. A document of
// another version reads as nothing kept, so this changes when a kept value's
// shape does.
const keptVersion = 1

// keptEntry is a kept entry as it was last written: its value's text, and when.
type keptEntry struct {
	value string
	at    int64
}

// StoragePersister keeps one cache's values in storage, as one document under
// one key: {version, writtenAt, entries}, each entry a key, its value, and
// when that value was last written. A document of another version, or one
// that does not parse, reads as nothing kept. A document larger than maxBytes
// loses the entries that have gone longest without a new value, until it
// fits.
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
	var document struct {
		Version *int              `json:"version"`
		Entries []json.RawMessage `json:"entries"`
	}
	if json.Unmarshal([]byte(raw), &document) != nil || document.Version == nil || *document.Version != keptVersion || document.Entries == nil {
		return nil
	}
	kept := map[K]V{}
	seen := map[string]keptEntry{}
	for _, entry := range document.Entries {
		var parts []json.RawMessage
		if json.Unmarshal(entry, &parts) != nil || len(parts) != 3 {
			continue
		}
		at, err := strconv.ParseInt(string(parts[2]), 10, 64)
		if err != nil {
			continue
		}
		// An entry that is not this cache's shape is one it never kept: an
		// object lacking a member its type requires among them.
		var key K
		var value V
		if json.Unmarshal(parts[0], &key) != nil || json.Unmarshal(parts[1], &value) != nil {
			continue
		}
		if shape := reflect.TypeFor[V](); shape.Kind() == reflect.Struct && !required.Carries(parts[1], shape) {
			continue
		}
		kept[key] = value
		seen[compact(parts[0])] = keptEntry{value: compact(parts[1]), at: at}
	}
	p.mu.Lock()
	p.written = seen
	p.mu.Unlock()
	return kept
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
		fmt.Fprintf(&b, `{"version":%d,"writtenAt":%d,"entries":[`, keptVersion, now)
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
