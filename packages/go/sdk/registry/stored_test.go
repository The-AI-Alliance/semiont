package registry_test

import (
	"context"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/registry"
)

func TestAStoredValueThatLacksAMemberOfASessionIsNone(t *testing.T) {
	storage := semiont.NewMemoryStorage()
	must(t, storage.Set(registry.SessionKey("kb-a"), `{"access":"a","refresh":"r","tokenEndpoint":"https://issuer.test/token"}`))
	if _, ok := registry.StoredSessionOf(storage, "kb-a"); ok {
		t.Error("a session with no client is read")
	}
	must(t, storage.Set(registry.SessionKey("kb-a"), `{"access":"a","refresh":"r","clientId":"semiont-browser","tokenEndpoint":"https://issuer.test/token"}`))
	if stored, ok := registry.StoredSessionOf(storage, "kb-a"); !ok || stored.RevocationEndpoint != "" {
		t.Errorf("a session with no revocation endpoint reads as %+v, %v", stored, ok)
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
