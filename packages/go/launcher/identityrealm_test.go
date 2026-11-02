package launcher

import (
	"bytes"
	"strings"
	"testing"
)

// The start's realm, against the stub admin: what is asserted is the
// launcher's reading of Keycloak's answers, and TestStartCreatesTheRealmLive
// asserts Keycloak's.

func TestARealmKeycloakDoesNotHoldIsCreatedFromItsDocument(t *testing.T) {
	s := newStubAdmin(t, "example.test-kb", nil)
	s.absent = true
	doc := keycloakRealmJSON("example.test-kb", "did:web:example.test:kb", 3000, keycloakAccessTokenLifespan, testAccounts())
	created, err := ensureRealm(s.srv.URL, "example.test-kb", "right", doc)
	if err != nil {
		t.Fatalf("creating an absent realm: %v", err)
	}
	if !created {
		t.Fatal("an absent realm was not created")
	}
	if len(s.realmDocs) != 1 || !bytes.Equal(s.realmDocs[0], doc) {
		t.Fatalf("POSTed %d realm documents, want the one rendered", len(s.realmDocs))
	}
}

// A held realm needs no admin: the login is never asked for, so a stack whose
// admin password no longer matches its database still starts.
func TestARealmKeycloakHoldsIsLeftAsItIs(t *testing.T) {
	s := newStubAdmin(t, "example.test-kb", nil)
	s.badLogin = true
	created, err := ensureRealm(s.srv.URL, "example.test-kb", "wrong", []byte("{}"))
	if err != nil {
		t.Fatalf("asking for a held realm: %v", err)
	}
	if created {
		t.Fatal("a held realm was created again")
	}
	if s.touched("/realms/master/") || s.touched("POST /admin/realms") {
		t.Fatalf("a held realm reached the admin: %v", s.paths)
	}
}

func TestARealmThatCannotBeCreatedSaysWhy(t *testing.T) {
	s := newStubAdmin(t, "example.test-kb", nil)
	s.absent, s.badLogin = true, true
	if _, err := ensureRealm(s.srv.URL, "example.test-kb", "wrong", []byte("{}")); err == nil || !strings.Contains(err.Error(), "KC_BOOTSTRAP_ADMIN_PASSWORD") {
		t.Fatalf("a refused login should name the admin password, got: %v", err)
	}

	s.badLogin, s.refuseWrites = false, true
	if _, err := ensureRealm(s.srv.URL, "example.test-kb", "right", []byte("{}")); err == nil || !strings.Contains(err.Error(), "refused to create the realm: HTTP 403") {
		t.Fatalf("a refused create should say Keycloak refused it, got: %v", err)
	}
	if len(s.realmDocs) != 0 {
		t.Fatal("a refused create recorded a realm")
	}
}
