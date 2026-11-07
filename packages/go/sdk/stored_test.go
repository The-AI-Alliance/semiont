package semiont

// What a session and a sign-in by a page redirect keep in a SessionStorage,
// held to protocol/specs/src/session/stored.json: the keys of a stream's places
// and of the kept queries, the form of a kept document and of the places, and
// what is kept of a sign-in begun. Which queries are kept is live_test.go's,
// and what each document holds cache_cases_test.go's. The registry's own keys
// are registry/stored_test.go's.

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// objectShape is an object schema of the table: the members it names, and
// those it requires.
type objectShape struct {
	Properties map[string]json.RawMessage `json:"properties"`
	Required   []string                   `json:"required"`
}

type sessionTable struct {
	LastEventIDKeyPrefix struct {
		Prefix string `json:"prefix"`
	} `json:"lastEventIdKeyPrefix"`
	CacheKeyPrefix struct {
		Prefix string `json:"prefix"`
	} `json:"cacheKeyPrefix"`
	WholeKey struct {
		Key string `json:"key"`
	} `json:"wholeKey"`
	CacheDocument struct {
		Properties map[string]struct {
			Const json.RawMessage `json:"const"`
		} `json:"properties"`
	} `json:"cacheDocument"`
	LastEventIds struct {
		PropertyNames        schemaRef `json:"propertyNames"`
		AdditionalProperties schemaRef `json:"additionalProperties"`
	} `json:"lastEventIds"`
	PendingAuthorization objectShape `json:"pendingAuthorization"`
}

// schemaRef is a schema that is a component schema of the spec's.
type schemaRef struct {
	Ref string `json:"$ref"`
}

// component is the name of the component schema ref names.
func (ref schemaRef) component() string {
	return strings.TrimSuffix(filepath.Base(ref.Ref), ".json")
}

// readSpec is what the spec's file at way, under protocol/specs/src, holds.
func readSpec[T any](t *testing.T, way ...string) T {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(append([]string{"..", "..", "..", "protocol", "specs", "src"}, way...)...))
	if err != nil {
		t.Fatal(err)
	}
	var read T
	if err := json.Unmarshal(text, &read); err != nil {
		t.Fatal(err)
	}
	return read
}

func readSessionTable(t *testing.T) sessionTable {
	t.Helper()
	return readSpec[sessionTable](t, "session", "stored.json")
}

func TestTheKeysOfAStreamsPlacesAndOfTheKeptQueriesAreTheTables(t *testing.T) {
	table := readSessionTable(t)
	if got, want := lastEventIDKey("kb-a"), table.LastEventIDKeyPrefix.Prefix+"kb-a"; got != want {
		t.Errorf("a knowledge base's stream's places are kept under %q; the table's key is %q", got, want)
	}
	if got, want := cacheStorageKey("kb-a", CacheQueryResource), table.CacheKeyPrefix.Prefix+"kb-a.resource"; got != want {
		t.Errorf("a kept query is kept under %q; the table's key is %q", got, want)
	}
}

func TestAKeptDocumentAndThePlacesAreOfTheTablesForm(t *testing.T) {
	table := readSessionTable(t)
	if got, want := textOf(t, whole{}), textOf(t, table.WholeKey.Key); got != want {
		t.Errorf("the key of a query of one value is written %s; the table's is %s", got, want)
	}

	if version := string(table.CacheDocument.Properties["version"].Const); !sameJSON(t, textOf(t, keptVersion), version) {
		t.Errorf("a kept document is of version %d; the table's is %s", keptVersion, version)
	}
	storage := NewMemoryStorage()
	keptBy[whole, []string](&CachePersistence{Storage: storage, KeyPrefix: "kb-a"}, CacheQueryEntityTypes, DefaultTiming().MaxStoredBytesCount).
		Save(map[whole][]string{{}: {"Person"}})
	written, _ := storage.Get(cacheStorageKey("kb-a", CacheQueryEntityTypes))
	if got, want := membersOf(t, []byte(written)), slices.Sorted(maps.Keys(table.CacheDocument.Properties)); !slices.Equal(got, want) {
		t.Errorf("a kept document is written with %v; the table's members are %v", got, want)
	}

	if got, want := reflect.TypeFor[api.ResourceId]().Name(), table.LastEventIds.PropertyNames.component(); got != want {
		t.Errorf("a place's scope is read as a %s; the table's is a %s", got, want)
	}
	if got, want := placeSchema, table.LastEventIds.AdditionalProperties.component(); got != want {
		t.Errorf("a place is held to %s; the table's is a %s", got, want)
	}
}

// membersOf is the members of the object text holds.
func membersOf(t *testing.T, text []byte) []string {
	t.Helper()
	var written map[string]json.RawMessage
	if err := json.Unmarshal(text, &written); err != nil {
		t.Fatal(err)
	}
	return slices.Sorted(maps.Keys(written))
}

func TestASignInBegunIsKeptAsTheTableStatesIt(t *testing.T) {
	table := readSessionTable(t)
	var issuer objectShape
	if err := json.Unmarshal(table.PendingAuthorization.Properties["issuer"], &issuer); err != nil {
		t.Fatal(err)
	}
	s := newStack(t)

	believed := NewMemoryStorage()
	if _, err := BeginAuthorization(context.Background(), issuerOf(), BeginAuthorizationOptions{
		Target: gatewayEndpoint(t, s), RedirectURI: redirectURI, KbID: "kb-a", ExpectedDid: "did:web:example.org:kb-a", ExpectedName: "KB A",
	}, believed); err != nil {
		t.Fatal(err)
	}
	stored, _ := believed.Get(PendingAuthorizationKey)
	if got, want := membersOf(t, []byte(stored)), slices.Sorted(maps.Keys(table.PendingAuthorization.Properties)); !slices.Equal(got, want) {
		t.Errorf("a sign-in begun is kept with %v; the table's members are %v", got, want)
	}
	var record struct {
		Issuer json.RawMessage `json:"issuer"`
	}
	if err := json.Unmarshal([]byte(stored), &record); err != nil {
		t.Fatal(err)
	}
	if got, want := membersOf(t, record.Issuer), slices.Sorted(maps.Keys(issuer.Properties)); !slices.Equal(got, want) {
		t.Errorf("its issuer is kept with %v; the table's members are %v", got, want)
	}

	// What the person named nothing of is not written.
	bare := NewMemoryStorage()
	if _, err := BeginAuthorization(context.Background(), issuerOf(), BeginAuthorizationOptions{Target: gatewayEndpoint(t, s), RedirectURI: redirectURI}, bare); err != nil {
		t.Fatal(err)
	}
	stored, _ = bare.Get(PendingAuthorizationKey)
	if got, want := membersOf(t, []byte(stored)), slices.Sorted(slices.Values(table.PendingAuthorization.Required)); !slices.Equal(got, want) {
		t.Errorf("a sign-in begun with nothing believed is kept with %v; the table requires %v", got, want)
	}
}

// without is text, an object, without the member way names: one of its own,
// or one of a member's.
func without(t *testing.T, text string, way []string) string {
	t.Helper()
	var record map[string]any
	if err := json.Unmarshal([]byte(text), &record); err != nil {
		t.Fatal(err)
	}
	within := record
	for _, name := range way[:len(way)-1] {
		inner, ok := within[name].(map[string]any)
		if !ok {
			t.Fatalf("the kept sign-in has no object %q", name)
		}
		within = inner
	}
	if _, ok := within[way[len(way)-1]]; !ok {
		t.Fatalf("the kept sign-in has no %s", strings.Join(way, "."))
	}
	delete(within, way[len(way)-1])
	written, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	return string(written)
}

// A sign-in pending that lacks a member the table requires, of its own, of
// its issuer's or of its target's (an HttpEndpoint), is no sign-in: it is
// taken, and completing it is refused as no-pending, as every SDK refuses it.
// One that lacks a member the table does not require completes.
func TestAPendingSignInIsReadAsTheTableRequiresIt(t *testing.T) {
	pending := readSessionTable(t).PendingAuthorization
	var issuer objectShape
	if err := json.Unmarshal(pending.Properties["issuer"], &issuer); err != nil {
		t.Fatal(err)
	}
	target := readSpec[objectShape](t, "components", "schemas", "HttpEndpoint.json")
	s := newStack(t)
	granting(s, "an-access-token", "a-refresh-token")
	begun := NewMemoryStorage()
	if _, err := BeginAuthorization(context.Background(), issuerOf(), BeginAuthorizationOptions{
		Target: gatewayEndpoint(t, s), RedirectURI: redirectURI, KbID: "kb-a", ExpectedDid: "did:web:example.org:kb-a", ExpectedName: "KB A",
	}, begun); err != nil {
		t.Fatal(err)
	}
	whole, _ := begun.Get(PendingAuthorizationKey)
	var record struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal([]byte(whole), &record); err != nil {
		t.Fatal(err)
	}
	callback := redirectURI + "?state=" + record.State + "&code=the-code"

	for _, within := range []struct {
		way   []string
		shape objectShape
	}{{nil, pending}, {[]string{"issuer"}, issuer}, {[]string{"target"}, target}} {
		for name := range within.shape.Properties {
			way := append(slices.Clone(within.way), name)
			required := slices.Contains(within.shape.Required, name)
			t.Run(strings.Join(way, "."), func(t *testing.T) {
				storage := NewMemoryStorage()
				if err := storage.Set(PendingAuthorizationKey, without(t, whole, way)); err != nil {
					t.Fatal(err)
				}
				_, _, err := CompleteAuthorization(context.Background(), issuerOf(), callback, storage)
				if _, still := storage.Get(PendingAuthorizationKey); still {
					t.Error("the sign-in is still pending")
				}
				var refused *SignInError
				if required && (!errors.As(err, &refused) || refused.Code != SignInErrorCodeNoPending) {
					t.Errorf("a sign-in pending without the %s the table requires: %v; want no-pending", strings.Join(way, "."), err)
				}
				if !required && err != nil {
					t.Errorf("a sign-in pending without the %s the table does not require: %v", strings.Join(way, "."), err)
				}
			})
		}
	}
}
