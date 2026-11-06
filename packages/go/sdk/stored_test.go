package semiont

// What a session and a sign-in by a page redirect keep in a SessionStorage,
// held to protocol/specs/src/session/stored.json: the keys of a stream's places
// and of the kept queries, and what is kept of a sign-in begun. The registry's
// own keys are registry/stored_test.go's.

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"testing"
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
	PendingAuthorization objectShape `json:"pendingAuthorization"`
}

func readSessionTable(t *testing.T) sessionTable {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "specs", "src", "session", "stored.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table sessionTable
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	return table
}

func TestTheKeysOfAStreamsPlacesAndOfTheKeptQueriesAreTheTables(t *testing.T) {
	table := readSessionTable(t)
	if got, want := lastEventIDKey("kb-a"), table.LastEventIDKeyPrefix.Prefix+"kb-a"; got != want {
		t.Errorf("a knowledge base's stream's places are kept under %q; the table's key is %q", got, want)
	}
	if got, want := cacheStorageKey("kb-a", "resource"), table.CacheKeyPrefix.Prefix+"kb-a.resource"; got != want {
		t.Errorf("a kept query is kept under %q; the table's key is %q", got, want)
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
