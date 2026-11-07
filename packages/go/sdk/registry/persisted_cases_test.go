package registry_test

// protocol/specs/src/session/persisted-cases.json: what a client keeps of one
// person in a storage, and when it is read, written and deleted. Every part
// of the table is run here, and a difference fails.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/semionttest"
)

type person struct {
	Did       string `json:"did"`
	PersonKey string `json:"personKey"`
}

type forgetRow struct {
	Why string `json:"why"`
	By  string `json:"by"`
	// Stored is the token kb-a's session found, for a row whose session
	// forgets the sign-in; "" for the registry's.
	Stored   string `json:"stored"`
	SignedIn string `json:"signedIn"`
	Open     bool   `json:"open"`
	Removes  string `json:"removes"`
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
	ForgetStorage  map[string]string `json:"forgetStorage"`
	Forget         []forgetRow       `json:"forget"`
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
	CrossTab []changedSignInRow `json:"crossTab"`
	Holder   []changedSignInRow `json:"holder"`
}

// changedSignInRow is a row of crossTab or holder: what kb-a's stored sign-in
// becomes while its client holds a value it has not written, and whether the
// value is written.
type changedSignInRow struct {
	Why    string `json:"why"`
	Stored *struct {
		PersonKey *string `json:"personKey"`
	} `json:"stored"`
	Saved bool `json:"saved"`
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
	if len(table.People) == 0 || len(table.Keys) == 0 || len(table.Forget) == 0 || len(table.Startup) == 0 || len(table.CrossTab) == 0 || len(table.Holder) == 0 {
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
	t.Run("forget", func(t *testing.T) { runPersistedForget(t, table) })
	t.Run("startup", func(t *testing.T) { runPersistedStartup(t, table) })
	t.Run("crossTab", func(t *testing.T) { runPersistedCrossTab(t, table) })
	t.Run("holder", func(t *testing.T) { runPersistedHolder(t, table) })
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

// closingWrites is scripted sessions whose session of kb-a, built while kb-a's
// stored sign-in names the person whose key is personKey, writes value under
// key as it closes, as a client kept for them closing with a save pending
// could. One built over another sign-in keeps nothing of them.
type closingWrites struct {
	*semionttest.ScriptedSessions
	personKey, key, value string
}

func (c closingWrites) Session(ctx context.Context, options registry.SessionFactoryOptions) (*semiont.Session, func(), error) {
	session, end, err := c.ScriptedSessions.Session(ctx, options)
	if err != nil || options.Kb.Id != kbA {
		return session, end, err
	}
	if stored, _ := registry.StoredSessionOf(options.Storage, kbA); stored.PersonKey == nil || *stored.PersonKey != c.personKey {
		return session, end, nil
	}
	return session, func() {
		end()
		if err := options.Storage.Set(c.key, c.value); err != nil {
			panic(err)
		}
	}, nil
}

func runPersistedForget(t *testing.T, table persistedCases) {
	jo := personOf(t, table, "jo").PersonKey
	for _, row := range table.Forget {
		t.Run(row.Why, func(t *testing.T) {
			switch row.By {
			case "signOut", "removal", "signIn":
				forgottenByTheRegistry(t, table, row, jo)
			case "expiry", "refusal":
				forgottenByTheSession(t, table, row, jo)
			default:
				t.Fatalf("by %q is none this runner knows", row.By)
			}
		})
	}
}

// forgottenByTheRegistry signs out of kb-a, removes it, or signs in to it
// again with a new sign-in, with both registered and kb-b active unless kb-a
// is open, over scripted sessions whose kb-a session kept for jo writes under
// jo's resource key as it closes. After a sign-in, kb-a's stored sign-in is
// the new one.
func forgottenByTheRegistry(t *testing.T, table persistedCases, row forgetRow, jo string) {
	bubble(t, func(t *testing.T, w *world) {
		for key, value := range table.ForgetStorage {
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
		factory := closingWrites{ScriptedSessions: w.factory.sessions, personKey: jo, key: keyOf(t, table, kbA, jo, "resource"), value: `{"version":1,"writtenAt":1700000000001,"entries":[]}`}
		browser, err := registry.NewSemiontBrowser(registry.SemiontBrowserConfig{Storage: w.storage, SessionFactory: factory})
		must(t, err)
		closedAtTheEnd(t, browser)
		if live(t, browser).Kb().Id != active {
			t.Fatalf("the live session is not %s's", active)
		}

		switch row.By {
		case "signOut":
			must(t, browser.SignOut(kbA))
		case "removal":
			must(t, browser.RemoveKb(kbA))
		case "signIn":
			signIn := tokens("r-new")
			must(t, browser.SignIn(kbA, signIn))
			if stored, saved := registry.StoredSessionOf(w.storage, kbA); !saved || !reflect.DeepEqual(stored, signIn) {
				t.Errorf("kb-a's stored sign-in is %+v (%v); the new one is %+v", stored, saved, signIn)
			}
		}
		leftAsTheRowSays(t, table, row, w.storage, jo)
	})
}

// forgottenByTheSession has kb-a's session, the registry's own over the stage,
// find its token refused, as the row's `by` and `stored` say: the issuer
// grants nothing, so a renewal is refused, except that a refusal's renewal is
// granted and the gateway refuses the renewed token too.
func forgottenByTheSession(t *testing.T, table persistedCases, row forgetRow, jo string) {
	if !row.Open {
		t.Fatalf("a session that is not open ends by no %s", row.By)
	}
	s := newStage(t)
	storage := semiont.NewMemoryStorage()
	for key, value := range table.ForgetStorage {
		must(t, storage.Set(key, value))
	}
	must(t, registry.SaveKnowledgeBases(storage, []api.KnowledgeBase{s.registered(t, kbA)}))
	var access string
	switch row.Stored {
	case "expired":
		access = jwt(-time.Minute)
	case "unexpired":
		access = jwt(time.Hour)
	default:
		t.Fatalf("stored %q is none this runner knows", row.Stored)
	}
	signIn := s.stored(access, "r1")
	switch row.SignedIn {
	case "named":
		signIn = naming(signIn, jo)
	case "unnamed":
	default:
		t.Fatalf("signedIn %q is none this runner knows", row.SignedIn)
	}
	must(t, registry.StoreSession(storage, kbA, signIn))
	s.mu.Lock()
	s.who = table.WhoAmI
	if row.Stored == "unexpired" {
		s.refusesWho[access] = true
	}
	if row.By == "refusal" {
		renewed := jwt(2 * time.Hour)
		s.grants = append(s.grants, [2]string{renewed, "r2"})
		s.refusesWho[renewed] = true
	}
	s.mu.Unlock()

	browser := s.browser(t, storage)
	// A session is handed to the registry once its start is done, and the
	// start is what forgets the sign-in.
	liveOver(t, browser)
	if _, saved := registry.StoredSessionOf(storage, kbA); saved {
		t.Fatal("kb-a's sign-in is still saved")
	}
	if err := browser.Close(); err != nil {
		t.Errorf("closing the registry: %v", err)
	}
	leftAsTheRowSays(t, table, row, storage, jo)
}

// leftAsTheRowSays holds storage, once kb-a's client has closed, to the row's
// `removes`: jo's keys on kb-a gone, or none, and every other key of
// `forgetStorage` holding what it held.
func leftAsTheRowSays(t *testing.T, table persistedCases, row forgetRow, storage semiont.SessionStorage, jo string) {
	t.Helper()
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
		if _, has := storage.Get(key); has {
			t.Errorf("%s holds something once the sign-in is forgotten", key)
		}
	}
	for key, value := range table.ForgetStorage {
		if removed[key] {
			continue
		}
		if stored, has := storage.Get(key); !has || stored != value {
			t.Errorf("%s holds %q once the sign-in is forgotten; it held %q", key, stored, value)
		}
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
			switch {
			case row.Stored == nil:
				must(t, other.Delete(registry.SessionKey(kbA)))
			case row.Stored.PersonKey != nil && *row.Stored.PersonKey == jo:
				renewing := registry.KeptIn(other, kbA)
				read, _, err := renewing.Held(ctx)
				must(t, err)
				if _, renewed, err := renewing.Renewed(ctx, read, jwt(2*time.Hour), "r-other"); err != nil || !renewed {
					t.Fatalf("the other context's renewal was not kept: %v, %v", renewed, err)
				}
			default:
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

// runPersistedHolder has a script's session, made by SessionFromKept over a
// memory sign-in that names jo, keep its caches in a storage of their own, the
// gateway naming jo; the sign-in is changed through the memory sign-in:
// forgotten, a new one kept in its place, or renewed with other tokens.
func runPersistedHolder(t *testing.T, table persistedCases) {
	jo := personOf(t, table, "jo").PersonKey
	resource := keyOf(t, table, kbA, jo, "resource")
	for _, row := range table.Holder {
		t.Run(row.Why, func(t *testing.T) {
			s := newStage(t)
			s.mu.Lock()
			s.who = table.WhoAmI
			s.mu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			memory := &semiont.MemorySignIn{}
			must(t, memory.Keep(ctx, s.heldSignIn(jwt(time.Hour), "r1", &jo)))
			caches := semiont.NewMemoryStorage()
			issuer := s.issuerOf()
			timing := issuer.Timing
			// Nothing the client holds is written before it closes.
			timing.SaveDebounce = time.Hour
			session, end, err := semiont.SessionFromKept(ctx, semiont.SessionFromKeptConfig{
				Kb:            api.KbTarget{Endpoint: s.registered(t, kbA).Endpoint, Id: kbA, Label: "KB A"},
				Kept:          memory,
				HTTP:          issuer.HTTP,
				Timing:        timing,
				AskWhoTokenIs: true,
				Channels:      bus.BridgedChannels,
				Storage:       caches,
			})
			must(t, err)
			ended := sync.OnceFunc(end)
			defer ended()
			held, err := session.Client().Browse.Resource(id("res-1")).Fresh(ctx)
			must(t, err)
			if _, written := caches.Get(resource); written || session.Client().PersistenceSettled() {
				t.Fatal("the client wrote what it holds, or owes no save, before its sign-in changes")
			}

			switch {
			case row.Stored == nil:
				must(t, memory.Forget(ctx))
			case row.Stored.PersonKey != nil && *row.Stored.PersonKey == jo:
				read, has, err := memory.Held(ctx)
				must(t, err)
				if !has {
					t.Fatal("the memory sign-in holds nothing to renew")
				}
				if _, renewed, err := memory.Renewed(ctx, read, jwt(2*time.Hour), "r-renewed"); err != nil || !renewed {
					t.Fatalf("the renewal was not kept: %v, %v", renewed, err)
				}
			default:
				must(t, memory.Keep(ctx, s.heldSignIn(jwt(2*time.Hour), "r-other", row.Stored.PersonKey)))
			}
			ended()

			kept := semiont.NewStoragePersister[api.ResourceId, api.ResourceDescriptor](caches, resource, timing.MaxStoredBytesCount).Load()
			value, has := kept[id("res-1")]
			if saved := has && same(t, value, held); saved != row.Saved {
				t.Errorf("saved: %v; the table's is %v", saved, row.Saved)
			}
		})
	}
}

// heldSignIn is a sign-in of the stage's issuer as a script keeps it, naming
// the person whose key is personKey, or nobody for nil.
func (s *stage) heldSignIn(access, refresh string, personKey *string) semiont.HeldSignIn {
	return semiont.HeldSignIn{Access: access, Refresh: refresh, ClientID: semiont.ScriptClientID, TokenEndpoint: s.issuer.URL + "/token", RevocationEndpoint: s.issuer.URL + "/revoke", PersonKey: personKey}
}

// stalledWrite is a storage whose first write of key, once it has begun,
// waits until release is closed: entered is closed when it begins, and landed
// when it is done. deleted is closed when key is deleted.
type stalledWrite struct {
	semiont.SessionStorage
	key                               string
	entered, release, landed, deleted chan struct{}
	stallOnce, deleteOnce             sync.Once
}

func newStalledWrite(key string) *stalledWrite {
	return &stalledWrite{SessionStorage: semiont.NewMemoryStorage(), key: key, entered: make(chan struct{}), release: make(chan struct{}), landed: make(chan struct{}), deleted: make(chan struct{})}
}

func (s *stalledWrite) Set(key, value string) error {
	stalls := false
	if key == s.key {
		s.stallOnce.Do(func() { stalls = true })
	}
	if !stalls {
		return s.SessionStorage.Set(key, value)
	}
	close(s.entered)
	<-s.release
	defer close(s.landed)
	return s.SessionStorage.Set(key, value)
}

func (s *stalledWrite) Delete(key string) error {
	err := s.SessionStorage.Delete(key)
	if key == s.key {
		s.deleteOnce.Do(func() { close(s.deleted) })
	}
	return err
}

// A save that passed its check, and is still being written when the session's
// own forget of its sign-in runs (its renewal refused by the issuer, which
// forgets the sign-in and what was kept of its person), does not land after
// the forget's delete: once both are done, nothing kept of the person is
// left. The session is the registry's, its sign-in and its caches in one
// storage, over the stage; so the wait below is on the clock, not a bubble's.
func TestASaveBeingWrittenDoesNotLandAfterTheSessionForgetsItsSignIn(t *testing.T) {
	table := readPersistedCases(t)
	jo := personOf(t, table, "jo").PersonKey
	s := newStage(t)
	s.mu.Lock()
	s.who = table.WhoAmI
	s.mu.Unlock()
	storage := newStalledWrite(keyOf(t, table, kbA, jo, "resource"))
	must(t, registry.StoreSession(storage, kbA, naming(s.stored(jwt(time.Hour), "r1"), jo)))
	issuer := s.issuerOf()
	timing := issuer.Timing
	timing.SaveDebounce = time.Millisecond
	signals := semiont.NewSessionSignals()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, end, err := registry.HttpSessionFactory{HTTP: issuer.HTTP, Timing: timing}.Session(ctx, registry.SessionFactoryOptions{Kb: s.registered(t, kbA), Storage: storage, Signals: signals})
	must(t, err)
	ended := sync.OnceFunc(end)
	defer ended()
	// Run first: a client closing waits for the write it is making.
	released := sync.OnceFunc(func() { close(storage.release) })
	defer released()
	if session.User().Value() == nil {
		t.Fatal("the gateway has not said who the session's token is")
	}

	_, err = session.Client().Browse.Resource(id("res-1")).Fresh(ctx)
	must(t, err)
	select {
	case <-storage.entered:
	case <-ctx.Done():
		t.Fatal("the client never began writing what it holds")
	}

	// The session's own forget: its token refused, and the issuer, granting
	// nothing, refusing to renew it.
	forgotten := make(chan struct{})
	go func() {
		defer close(forgotten)
		session.Refresh(ctx, session.Token().Value())
	}()
	// The session says nobody is signed in, then forgets the sign-in.
	until(t, "the session's renewal is refused", func() bool { return session.User().Value() == nil })
	// The one step on the clock: a forget that does not wait for the write
	// deletes at once; one that waits is given a moment to show it does not.
	select {
	case <-storage.deleted:
	case <-time.After(500 * time.Millisecond):
	}
	released()
	select {
	case <-forgotten:
	case <-ctx.Done():
		t.Fatal("the session's forget never finished")
	}
	select {
	case <-storage.landed:
	case <-ctx.Done():
		t.Fatal("the write never finished")
	}
	if told := signals.SessionEnded().Value(); told == nil || told.Reason != semiont.SessionEndExpired {
		t.Fatalf("the session ended as %+v; its sign-in was not forgotten by an expiry", told)
	}
	ended()

	for _, key := range keysOf(t, table, kbA, jo) {
		if _, has := storage.Get(key); has {
			t.Errorf("%s holds something once the forget and the write are both done", key)
		}
	}
}

// unreadableSignIn is a memory sign-in whose Held fails while unreadable
// holds.
type unreadableSignIn struct {
	*semiont.MemorySignIn
	unreadable atomic.Bool
}

func (u *unreadableSignIn) Held(ctx context.Context) (semiont.HeldSignIn, bool, error) {
	if u.unreadable.Load() {
		return semiont.HeldSignIn{}, false, errors.New("the sign-in cannot be read")
	}
	return u.MemorySignIn.Held(ctx)
}

// A sign-in that cannot be read when the client saves is not known to name
// the person the client keeps for: nothing is written, nor anything after for
// the client's life, even once it can be read again and names them still, and
// the session says so once, as session.keep-failed.
func TestASignInUnreadableAtASaveStopsTheClientKeepingAndIsSaidOnce(t *testing.T) {
	table := readPersistedCases(t)
	jo := personOf(t, table, "jo").PersonKey
	s := newStage(t)
	s.mu.Lock()
	s.who = table.WhoAmI
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	kept := &unreadableSignIn{MemorySignIn: &semiont.MemorySignIn{}}
	must(t, kept.Keep(ctx, s.heldSignIn(jwt(time.Hour), "r1", &jo)))
	caches := &watchedStorage{SessionStorage: semiont.NewMemoryStorage()}
	issuer := s.issuerOf()
	timing := issuer.Timing
	timing.SaveDebounce = time.Millisecond
	var mu sync.Mutex
	var told []*semiont.SessionError
	first := make(chan struct{})
	session, end, err := semiont.SessionFromKept(ctx, semiont.SessionFromKeptConfig{
		Kb:            api.KbTarget{Endpoint: s.registered(t, kbA).Endpoint, Id: kbA, Label: "KB A"},
		Kept:          kept,
		HTTP:          issuer.HTTP,
		Timing:        timing,
		AskWhoTokenIs: true,
		Channels:      bus.BridgedChannels,
		Storage:       caches,
		OnError: func(err *semiont.SessionError) {
			mu.Lock()
			defer mu.Unlock()
			told = append(told, err)
			if len(told) == 1 {
				close(first)
			}
		},
	})
	must(t, err)
	ended := sync.OnceFunc(end)
	defer ended()

	kept.unreadable.Store(true)
	_, err = session.Client().Browse.Resource(id("res-1")).Fresh(ctx)
	must(t, err)
	select {
	case <-first:
	case <-ctx.Done():
		t.Fatal("the session never said its client stopped keeping")
	}
	kept.unreadable.Store(false)
	_, err = session.Client().Browse.Resource(id("res-2")).Fresh(ctx)
	must(t, err)
	ended()

	if written := caches.under(&caches.written, keyPrefixes(t)); len(written) > 0 {
		t.Errorf("the client wrote %v", written)
	}
	mu.Lock()
	defer mu.Unlock()
	codes := []semiont.SessionErrorCode{}
	for _, each := range told {
		codes = append(codes, each.Code)
	}
	if !slices.Equal(codes, []semiont.SessionErrorCode{semiont.SessionErrorCodeKeepFailed}) || told[0].KbID != kbA {
		t.Errorf("the session said %v; it says session.keep-failed of kb-a, once", codes)
	}
}
