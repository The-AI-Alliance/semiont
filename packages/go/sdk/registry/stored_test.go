package registry_test

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
)

// storedTable is protocol/specs/src/session/stored.json: what a registry keeps in its
// storage, which Go states by hand and this test holds to the table.
type storedTable struct {
	Keys []struct {
		Member string `json:"member"`
		Key    string `json:"key"`
	} `json:"keys"`
	SessionKeyPrefix struct {
		Prefix string `json:"prefix"`
	} `json:"sessionKeyPrefix"`
	StoredSession struct {
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
	} `json:"storedSession"`
}

// A key or a member the table gains fails here until Go has it.
func TestWhatARegistryKeepsIsTheTables(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "specs", "src", "session", "stored.json"))
	must(t, err)
	var table storedTable
	must(t, json.Unmarshal(text, &table))

	keys := map[string]string{}
	for _, entry := range table.Keys {
		keys[entry.Member] = entry.Key
	}
	stated := map[string]string{
		"knowledgeBasesKey":         registry.KnowledgeBasesKey,
		"activeKey":                 registry.ActiveKey,
		"openResourcesByKbKey":      registry.OpenResourcesByKbKey,
		"lastViewedResourceByKbKey": registry.LastViewedResourceByKbKey,
		"pendingAuthorizationKey":   semiont.PendingAuthorizationKey,
	}
	if !maps.Equal(keys, stated) {
		t.Errorf("the table's keys are %v; Go states %v", keys, stated)
	}
	if got, want := registry.SessionKey("kb-a"), table.SessionKeyPrefix.Prefix+"kb-a"; got != want {
		t.Errorf("a knowledge base's session key is %q; the table's is %q", got, want)
	}

	members := slices.Sorted(maps.Keys(table.StoredSession.Properties))
	storage := semiont.NewMemoryStorage()
	person := semiont.PersonKey("did:web:example.org:users:alice")
	must(t, registry.StoreSession(storage, "kb-a", registry.StoredSession{
		Access:             "a",
		Refresh:            "r",
		ClientID:           "semiont-browser",
		TokenEndpoint:      "https://issuer.test/token",
		RevocationEndpoint: "https://issuer.test/revoke",
		PersonKey:          &person,
	}))
	stored, _ := storage.Get(registry.SessionKey("kb-a"))
	var written map[string]json.RawMessage
	must(t, json.Unmarshal([]byte(stored), &written))
	if got := slices.Sorted(maps.Keys(written)); !slices.Equal(got, members) {
		t.Errorf("a stored session is written with %v; the table's members are %v", got, members)
	}

	for _, left := range members {
		without := map[string]string{}
		for _, member := range members {
			if member != left {
				without[member] = "the " + member
			}
		}
		value, err := json.Marshal(without)
		must(t, err)
		must(t, storage.Set(registry.SessionKey("kb-a"), string(value)))
		_, read := registry.StoredSessionOf(storage, "kb-a")
		if required := slices.Contains(table.StoredSession.Required, left); read == required {
			t.Errorf("a stored value without %s reads as a session: %v; the table requires it: %v", left, read, required)
		}
	}
}

func TestAStoredValueThatLacksAMemberOfASessionIsNone(t *testing.T) {
	storage := semiont.NewMemoryStorage()
	must(t, storage.Set(registry.SessionKey("kb-a"), `{"access":"a","refresh":"r","tokenEndpoint":"https://issuer.test/token"}`))
	if _, ok := registry.StoredSessionOf(storage, "kb-a"); ok {
		t.Error("a session with no client is read")
	}
	must(t, storage.Set(registry.SessionKey("kb-a"), `{"access":"a","refresh":"r","clientId":"semiont-browser","tokenEndpoint":"https://issuer.test/token"}`))
	if stored, ok := registry.StoredSessionOf(storage, "kb-a"); !ok || stored.RevocationEndpoint != "" || stored.PersonKey != nil {
		t.Errorf("a session with no revocation endpoint and no person reads as %+v, %v", stored, ok)
	}
	// Written without them, as read.
	stored, _ := registry.StoredSessionOf(storage, "kb-a")
	must(t, registry.StoreSession(storage, "kb-a", stored))
	if written, _ := storage.Get(registry.SessionKey("kb-a")); written != `{"access":"a","refresh":"r","clientId":"semiont-browser","tokenEndpoint":"https://issuer.test/token"}` {
		t.Errorf("a session with no revocation endpoint and no person is written as %s", written)
	}
}

// The person the gateway named is recorded on the stored sign-in as one step,
// only while it holds the token that was asked about and names nobody; a
// renewal keeps it.
func TestThePersonIsRecordedOnTheStoredSignInOfTheTokenAskedAbout(t *testing.T) {
	ctx := context.Background()
	storage := semiont.NewMemoryStorage()
	kept := registry.KeptIn(storage, "kb-a")
	jo, ann := semiont.PersonKey("did:web:example.org:users:jo"), semiont.PersonKey("did:web:example.org:users:ann")
	read := semiont.HeldSignIn{Access: "a1", Refresh: "r1", ClientID: "semiont-browser", TokenEndpoint: "https://issuer.test/token"}

	if recorded, err := kept.RecordPersonKey(ctx, "a1", jo); err != nil || recorded {
		t.Fatalf("a person recorded on nothing stored: %v, %v", recorded, err)
	}
	if _, ok := registry.StoredSessionOf(storage, "kb-a"); ok {
		t.Fatal("recording a person on nothing stored wrote a sign-in")
	}

	must(t, kept.Keep(ctx, read))
	if recorded, err := kept.RecordPersonKey(ctx, "another token", jo); err != nil || recorded {
		t.Fatalf("a person recorded on a sign-in of another token: %v, %v", recorded, err)
	}
	if held, _, _ := kept.Held(ctx); held.PersonKey != nil {
		t.Fatalf("a sign-in of another token names %s", *held.PersonKey)
	}
	if recorded, err := kept.RecordPersonKey(ctx, "a1", jo); err != nil || !recorded {
		t.Fatalf("the person was not recorded: %v, %v", recorded, err)
	}
	// Recorded already: the same person still is, another is not.
	if recorded, err := kept.RecordPersonKey(ctx, "a1", jo); err != nil || !recorded {
		t.Fatalf("the person recorded already: %v, %v", recorded, err)
	}
	if recorded, err := kept.RecordPersonKey(ctx, "a1", ann); err != nil || recorded {
		t.Fatalf("another person recorded over the first: %v, %v", recorded, err)
	}
	if held, _, _ := kept.Held(ctx); held.PersonKey == nil || *held.PersonKey != jo {
		t.Fatalf("the sign-in names %+v", held.PersonKey)
	}

	// A renewal keeps the person; a new sign-in names nobody.
	named, _, _ := kept.Held(ctx)
	if _, ok, err := kept.Renewed(ctx, named, "a2", "r2"); err != nil || !ok {
		t.Fatalf("the renewal: %v, %v", ok, err)
	}
	if stored, _ := registry.StoredSessionOf(storage, "kb-a"); stored.Access != "a2" || stored.PersonKey == nil || *stored.PersonKey != jo {
		t.Fatalf("stored after a renewal: %+v", stored)
	}
	must(t, kept.Keep(ctx, semiont.HeldSignIn{Access: "a3", Refresh: "r3", ClientID: "semiont-browser", TokenEndpoint: "https://issuer.test/token"}))
	if stored, _ := registry.StoredSessionOf(storage, "kb-a"); stored.PersonKey != nil {
		t.Fatalf("a new sign-in names %s", *stored.PersonKey)
	}
}

func TestASessionKeyNamesItsKnowledgeBase(t *testing.T) {
	if kbID, ok := registry.KbOfSessionKey(registry.SessionKey("kb-a")); !ok || kbID != "kb-a" {
		t.Errorf("the session key of kb-a names %q, %v", kbID, ok)
	}
	if _, ok := registry.KbOfSessionKey(registry.ActiveKey); ok {
		t.Error("the active key is read as a session's")
	}
}

// A renewal is written against what is stored then: one made meanwhile stands,
// and one of a sign-in that is gone is not written back.
func TestARenewalIsKeptAgainstWhatIsStoredThen(t *testing.T) {
	ctx := context.Background()
	storage := semiont.NewMemoryStorage()
	kept := registry.KeptIn(storage, "kb-a")
	read := semiont.HeldSignIn{Access: "a1", Refresh: "r1", ClientID: "semiont-browser", TokenEndpoint: "https://issuer.test/token"}

	if _, ok, err := kept.Renewed(ctx, read, "a2", "r2"); err != nil || ok {
		t.Fatalf("a renewal of nothing stored is kept: %v, %v", ok, err)
	}
	if _, ok := registry.StoredSessionOf(storage, "kb-a"); ok {
		t.Fatal("a renewal of nothing stored wrote one")
	}

	must(t, kept.Keep(ctx, read))
	if current, ok, err := kept.Renewed(ctx, read, "a2", "r2"); err != nil || !ok || current != "a2" {
		t.Fatalf("a renewal gives %q, %v, %v", current, ok, err)
	}
	if held, ok, _ := kept.Held(ctx); !ok || held.Access != "a2" || held.Refresh != "r2" {
		t.Fatalf("held after a renewal: %+v", held)
	}

	// Renewed from what was read before: the renewal stored meanwhile stands.
	if current, ok, err := kept.Renewed(ctx, read, "a3", "r3"); err != nil || !ok || current != "a2" {
		t.Fatalf("a renewal of what is no longer stored gives %q, %v, %v", current, ok, err)
	}
	if held, _, _ := kept.Held(ctx); held.Access != "a2" {
		t.Fatalf("held: %+v", held)
	}

	must(t, kept.Forget(ctx))
	if _, ok, _ := kept.Held(ctx); ok {
		t.Fatal("a forgotten sign-in is held")
	}
}
