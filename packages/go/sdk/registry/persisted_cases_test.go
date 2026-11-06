package registry_test

// protocol/specs/src/session/persisted-cases.json: what a client keeps of one
// person in a storage, and when it is read, written and deleted. Every part
// of the table is run here, and a difference fails.

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

type person struct {
	Did       string `json:"did"`
	PersonKey string `json:"personKey"`
}

type persistedCases struct {
	Comment string              `json:"$comment"`
	RunBy   map[string][]string `json:"runBy"`
	People  map[string]person   `json:"people"`
	Keys    []struct {
		Why            string `json:"why"`
		KbID           string `json:"kbId"`
		Did            string `json:"did"`
		PersonKey      string `json:"personKey"`
		LastEventIDKey string `json:"lastEventIdKey"`
		// CacheKeys is read in its order, which is the refresh table's.
		CacheKeys json.RawMessage `json:"cacheKeys"`
	} `json:"keys"`
	SignOutStorage map[string]string `json:"signOutStorage"`
	SignOut        []struct {
		Why      string `json:"why"`
		SignedIn string `json:"signedIn"`
		Open     bool   `json:"open"`
		Removes  string `json:"removes"`
	} `json:"signOut"`
	WhoAmI         json.RawMessage   `json:"whoAmI"`
	StartupStorage map[string]string `json:"startupStorage"`
	Startup        []struct {
		Why       string  `json:"why"`
		SignedIn  string  `json:"signedIn"`
		Gateway   string  `json:"gateway"`
		First     string  `json:"first"`
		Then      string  `json:"then"`
		Recorded  *string `json:"recorded"`
		Place     *string `json:"place"`
		Untouched *bool   `json:"untouched"`
	} `json:"startup"`
	CrossTab []struct {
		Why    string `json:"why"`
		Stored *struct {
			PersonKey *string `json:"personKey"`
		} `json:"stored"`
		Saved bool `json:"saved"`
	} `json:"crossTab"`
}

// readPersistedCases is the table, read whole: a member it gains that this
// runner does not read fails here.
func readPersistedCases(t *testing.T) persistedCases {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "specs", "src", "session", "persisted-cases.json"))
	must(t, err)
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	var table persistedCases
	must(t, decoder.Decode(&table))
	if len(table.People) == 0 || len(table.Keys) == 0 || len(table.SignOut) == 0 || len(table.Startup) == 0 || len(table.CrossTab) == 0 {
		t.Fatal("a part of the persisted cases has no rows")
	}
	return table
}

// keyPrefixes is the beginnings of the keys a client keeps a person's
// caches and stream places under, as protocol/specs/src/session/stored.json
// states them.
func keyPrefixes(t *testing.T) []string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "specs", "src", "session", "stored.json"))
	must(t, err)
	var stored struct {
		LastEventID struct {
			Prefix string `json:"prefix"`
		} `json:"lastEventIdKeyPrefix"`
		Cache struct {
			Prefix string `json:"prefix"`
		} `json:"cacheKeyPrefix"`
	}
	must(t, json.Unmarshal(text, &stored))
	return []string{stored.LastEventID.Prefix, stored.Cache.Prefix}
}

// inOrder is a JSON object of text, its names in the order it states them.
func inOrder(t *testing.T, object json.RawMessage) ([]string, map[string]string) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(object))
	if open, err := decoder.Token(); err != nil || open != json.Delim('{') {
		t.Fatalf("%s is not an object", object)
	}
	var names []string
	values := map[string]string{}
	for decoder.More() {
		name, err := decoder.Token()
		must(t, err)
		value, err := decoder.Token()
		must(t, err)
		text, ok := value.(string)
		if !ok {
			t.Fatalf("%v of %s is not text", name, object)
		}
		names = append(names, name.(string))
		values[name.(string)] = text
	}
	return names, values
}

// keysOf is every key the table says is kept on kbID for the person whose
// key is personKey: the stream's places, then each persisted query's.
func keysOf(t *testing.T, table persistedCases, kbID, personKey string) []string {
	t.Helper()
	for _, row := range table.Keys {
		if row.KbID == kbID && row.PersonKey == personKey {
			names, values := inOrder(t, row.CacheKeys)
			keys := []string{row.LastEventIDKey}
			for _, name := range names {
				keys = append(keys, values[name])
			}
			return keys
		}
	}
	t.Fatalf("the table names no keys of %s on %s", personKey, kbID)
	return nil
}

// keyOf is the key of query the table says is kept on kbID for the person
// whose key is personKey.
func keyOf(t *testing.T, table persistedCases, kbID, personKey, query string) string {
	t.Helper()
	for _, row := range table.Keys {
		if row.KbID == kbID && row.PersonKey == personKey {
			_, values := inOrder(t, row.CacheKeys)
			if key, ok := values[query]; ok {
				return key
			}
		}
	}
	t.Fatalf("the table names no %s key of %s on %s", query, personKey, kbID)
	return ""
}

func personOf(t *testing.T, table persistedCases, name string) person {
	t.Helper()
	named, ok := table.People[name]
	if !ok {
		t.Fatalf("the table names no %s", name)
	}
	return named
}

func TestThePersistedCases(t *testing.T) {
	table := readPersistedCases(t)
	t.Run("keys", func(t *testing.T) { runPersistedKeys(t, table) })
	t.Run("signOut", func(t *testing.T) { runPersistedSignOut(t, table) })
	t.Run("startup", func(t *testing.T) { runPersistedStartup(t, table) })
	t.Run("crossTab", func(t *testing.T) { runPersistedCrossTab(t, table) })
}

func runPersistedKeys(t *testing.T, table persistedCases) {
	for name, each := range table.People {
		if got := semiont.PersonKey(each.Did); got != each.PersonKey {
			t.Errorf("%s's key is %q; the table's is %q", name, got, each.PersonKey)
		}
	}
	persisted := []string{}
	for _, query := range semiont.PersistedCacheQueries {
		persisted = append(persisted, string(query))
	}
	for _, row := range table.Keys {
		t.Run(row.Why, func(t *testing.T) {
			if got := semiont.PersonKey(row.Did); got != row.PersonKey {
				t.Errorf("the key of %s is %q; the table's is %q", row.Did, got, row.PersonKey)
			}
			if got := semiont.LastEventIDKey(row.KbID, row.PersonKey); got != row.LastEventIDKey {
				t.Errorf("the stream's places are kept under %q; the table's key is %q", got, row.LastEventIDKey)
			}
			names, values := inOrder(t, row.CacheKeys)
			if !slices.Equal(persisted, names) {
				t.Errorf("Go keeps %v; the table keeps %v", persisted, names)
			}
			for _, name := range names {
				if got := semiont.CacheKey(row.KbID, row.PersonKey, semiont.CacheQuery(name)); got != values[name] {
					t.Errorf("%s is kept under %q; the table's key is %q", name, got, values[name])
				}
			}
		})
	}
}

// closingWrites is scripted sessions whose session of kb-a writes value under
// key as it closes, as a client closing with a save pending could.
type closingWrites struct {
	*semionttest.ScriptedSessions
	key, value string
}

func (c closingWrites) Session(ctx context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	session, end, err := c.ScriptedSessions.Session(ctx, options)
	if err != nil || options.Kb.Id != kbA {
		return session, end, err
	}
	return session, func() {
		end()
		if err := options.Storage.Set(c.key, c.value); err != nil {
			panic(err)
		}
	}, nil
}

func runPersistedSignOut(t *testing.T, table persistedCases) {
	jo := personOf(t, table, "jo").PersonKey
	for _, row := range table.SignOut {
		t.Run(row.Why, func(t *testing.T) {
			bubble(t, func(t *testing.T, w *world) {
				for key, value := range table.SignOutStorage {
					must(t, w.storage.Set(key, value))
				}
				must(t, registry.SaveKnowledgeBases(w.storage, []api.KnowledgeBase{kbOfA(), kbOfB()}))
				must(t, registry.StoreSession(w.storage, kbB, tokens("r-b")))
				switch row.SignedIn {
				case "named":
					must(t, registry.StoreSession(w.storage, kbA, naming(tokens("r-a"), jo)))
				case "unnamed":
					must(t, registry.StoreSession(w.storage, kbA, tokens("r-a")))
				case "none":
				default:
					t.Fatalf("signedIn %q is none this runner knows", row.SignedIn)
				}
				active := kbB
				if row.Open {
					active = kbA
				}
				must(t, w.storage.Set(registry.ActiveKey, active))
				factory := closingWrites{ScriptedSessions: w.factory.sessions, key: keyOf(t, table, kbA, jo, "resource"), value: `{"version":1,"writtenAt":1700000000001,"entries":[]}`}
				browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: factory})
				must(t, err)
				closedAtTheEnd(t, browser)
				if live(t, browser).Kb().Id != active {
					t.Fatalf("the live session is not %s's", active)
				}

				must(t, browser.SignOut(kbA))

				removed := map[string]bool{}
				switch row.Removes {
				case "person":
					for _, key := range keysOf(t, table, kbA, jo) {
						removed[key] = true
					}
				case "nothing":
				default:
					t.Fatalf("removes %q is none this runner knows", row.Removes)
				}
				for key := range removed {
					if _, has := w.storage.Get(key); has {
						t.Errorf("%s holds something after the sign-out", key)
					}
				}
				for key, value := range table.SignOutStorage {
					if removed[key] {
						continue
					}
					if stored, has := w.storage.Get(key); !has || stored != value {
						t.Errorf("%s holds %q after the sign-out; it held %q", key, stored, value)
					}
				}
			})
		})
	}
}

// watchedStorage is a storage that records each key read and written under
// it.
type watchedStorage struct {
	semiont.SessionStorage

	mu            sync.Mutex
	read, written []string
}

func (w *watchedStorage) saw(into *[]string, key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	*into = append(*into, key)
}

func (w *watchedStorage) Get(key string) (string, bool) {
	w.saw(&w.read, key)
	return w.SessionStorage.Get(key)
}

func (w *watchedStorage) Set(key, value string) error {
	w.saw(&w.written, key)
	return w.SessionStorage.Set(key, value)
}

func (w *watchedStorage) Delete(key string) error {
	w.saw(&w.written, key)
	return w.SessionStorage.Delete(key)
}

func (w *watchedStorage) Update(key string, change func(stored string, has bool) (string, bool)) error {
	w.saw(&w.written, key)
	return w.SessionStorage.Update(key, change)
}

// under is the keys of seen that begin with one of prefixes, each once.
func (w *watchedStorage) under(seen *[]string, prefixes []string) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var keys []string
	for _, key := range *seen {
		if slices.ContainsFunc(prefixes, func(prefix string) bool { return strings.HasPrefix(key, prefix) }) && !slices.Contains(keys, key) {
			keys = append(keys, key)
		}
	}
	return keys
}

// Go hands a session back only once the gateway has said who its token is, so
// what the client gives before then is read from the storage: `kept` is a
// client that read the person's resource key before the gateway answered,
// `fresh` one that read no key a person's things are kept under.
func runPersistedStartup(t *testing.T, table persistedCases) {
	jo := personOf(t, table, "jo").PersonKey
	prefixes := keyPrefixes(t)
	resource := keyOf(t, table, kbA, jo, "resource")
	for _, row := range table.Startup {
		t.Run(row.Why, func(t *testing.T) {
			s := newStage(t)
			answer := make(chan struct{})
			s.mu.Lock()
			s.answerWho = answer
			switch row.Gateway {
			case "names":
				s.who = table.WhoAmI
			case "unreachable":
				s.who = nil
			default:
				s.mu.Unlock()
				t.Fatalf("gateway %q is none this runner knows", row.Gateway)
			}
			s.mu.Unlock()

			storage := &watchedStorage{SessionStorage: semiont.NewMemoryStorage()}
			for key, value := range table.StartupStorage {
				must(t, storage.Set(key, value))
			}
			must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{s.registered(t, kbA)}))
			signIn := s.stored(jwt(time.Hour), "r1")
			switch row.SignedIn {
			case "named":
				signIn = naming(signIn, jo)
			case "unnamed":
			default:
				t.Fatalf("signedIn %q is none this runner knows", row.SignedIn)
			}
			must(t, registry.StoreSession(storage, kbA, signIn))
			storage.mu.Lock()
			storage.read, storage.written = nil, nil
			storage.mu.Unlock()

			browser := s.browser(t, storage)
			until(t, "the gateway is asked who the token is", func() bool {
				s.mu.Lock()
				defer s.mu.Unlock()
				return len(s.askedWho) > 0
			})
			readFirst := storage.under(&storage.read, prefixes)
			close(answer)
			session := liveOver(t, browser)

			var first string
			switch {
			case len(readFirst) == 0:
				first = "fresh"
			case slices.Contains(readFirst, resource):
				first = "kept"
			default:
				t.Fatalf("before the gateway answered, the client read %v", readFirst)
			}
			if first != row.First {
				t.Errorf("first: %s; the table's is %s", first, row.First)
			}

			if stored, _ := registry.StoredSessionOf(storage, kbA); !reflect.DeepEqual(stored.PersonKey, row.Recorded) {
				t.Errorf("the sign-in records %v; the table's is %v", stored.PersonKey, row.Recorded)
			}

			// Watched for as long as the row runs, so its scope is held.
			watching, stopWatching := context.WithCancel(context.Background())
			defer stopWatching()
			given := make(chan string, 1)
			go func() {
				told := false
				for state := range session.Client().Browse.Resource(id("res-1")).States(watching) {
					if ready, ok := state.(semiont.Ready[api.ResourceDescriptor]); ok && !told {
						given <- ready.Value.Name
						told = true
					}
				}
			}()
			select {
			case then := <-given:
				if then != row.Then {
					t.Errorf("then: %s; the table's is %s", then, row.Then)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("res-1 was never given")
			}

			until(t, "the stream names res-1's scope", func() bool { _, named := s.resumedFrom("res-1"); return named })
			if from, _ := s.resumedFrom("res-1"); !reflect.DeepEqual(from, row.Place) {
				t.Errorf("the stream resumes res-1's scope from %v; the table's place is %v", from, row.Place)
			}

			if row.Untouched == nil {
				return
			}
			if err := browser.Close(); err != nil {
				t.Errorf("closing the registry: %v", err)
			}
			untouched := true
			for key, value := range table.StartupStorage {
				if stored, has := storage.Get(key); !has || stored != value {
					untouched = false
				}
			}
			for _, key := range storage.under(&storage.written, prefixes) {
				if _, kept := table.StartupStorage[key]; kept {
					continue
				}
				if _, has := storage.Get(key); has {
					untouched = false
				}
			}
			if untouched != *row.Untouched {
				t.Errorf("untouched: %v; the table's is %v", untouched, *row.Untouched)
			}
		})
	}
}

func runPersistedCrossTab(t *testing.T, table persistedCases) {
	jo := personOf(t, table, "jo").PersonKey
	resource := keyOf(t, table, kbA, jo, "resource")
	for _, row := range table.CrossTab {
		t.Run(row.Why, func(t *testing.T) {
			s := newStage(t)
			s.mu.Lock()
			s.who = table.WhoAmI
			s.mu.Unlock()
			shared := semionttest.NewSharedStorage()
			must(t, registry.SaveKnowledgeBases(shared, []api.KnowledgeBase{s.registered(t, kbA)}))
			must(t, registry.StoreSession(shared, kbA, naming(s.stored(jwt(time.Hour), "r1"), jo)))
			issuer := s.issuerOf()
			timing := issuer.Timing
			// Nothing the client holds is written before it closes.
			timing.SaveDebounce = time.Hour
			browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: shared, SessionFactory: registry.HttpSessionFactory{HTTP: issuer.HTTP, Timing: timing}})
			must(t, err)
			closedAtTheEnd(t, browser)
			session := liveOver(t, browser)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			held, err := session.Client().Browse.Resource(id("res-1")).Fresh(ctx)
			must(t, err)
			if _, written := shared.Get(resource); written || session.Client().PersistenceSettled() {
				t.Fatal("the client wrote what it holds, or owes no save, before the other context writes")
			}

			other := shared.Context()
			if row.Stored == nil {
				must(t, other.Delete(registry.SessionKey(kbA)))
			} else {
				signIn := s.stored(jwt(2*time.Hour), "r-other")
				signIn.PersonKey = row.Stored.PersonKey
				must(t, registry.StoreSession(other, kbA, signIn))
			}
			if err := browser.Close(); err != nil {
				t.Errorf("closing the registry: %v", err)
			}

			kept := semiont.NewStoragePersister[api.ResourceId, api.ResourceDescriptor](shared, resource, timing.MaxStoredBytesCount).Load()
			value, has := kept[id("res-1")]
			if saved := has && same(t, value, held); saved != row.Saved {
				t.Errorf("saved: %v; the table's is %v", saved, row.Saved)
			}
		})
	}
}
