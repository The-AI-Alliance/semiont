package launcher

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
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

// Keycloak's other answers. A realm created between the ask and the create is
// held. An ask answered otherwise, an unreachable Keycloak, and a create
// refused with a reason are errors, the last carrying Keycloak's reason.
func TestARealmsOtherAnswersReadAsKeycloakMeantThem(t *testing.T) {
	keycloak := func(root, create int, refusal string) string {
		mux := http.NewServeMux()
		mux.HandleFunc("/realms/example.test-kb", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(root) })
		mux.HandleFunc("/realms/master/protocol/openid-connect/token", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "application/json")
			fmt.Fprint(w, `{"access_token":"admin-token"}`)
		})
		mux.HandleFunc("/admin/realms", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(create)
			fmt.Fprint(w, refusal)
		})
		srv := httptest.NewServer(mux)
		t.Cleanup(srv.Close)
		return srv.URL
	}

	created, err := ensureRealm(keycloak(http.StatusNotFound, http.StatusConflict, ""), "example.test-kb", "right", []byte("{}"))
	if err != nil || created {
		t.Errorf("a realm created between the ask and the create: created %v, error %v; want it held", created, err)
	}
	if _, err := ensureRealm(keycloak(http.StatusServiceUnavailable, 0, ""), "example.test-kb", "right", []byte("{}")); err == nil || !strings.Contains(err.Error(), "asking Keycloak for the realm: HTTP 503") {
		t.Errorf("an ask answered 503 should say so, got: %v", err)
	}
	if _, err := ensureRealm(keycloak(http.StatusNotFound, http.StatusBadRequest, `{"errorMessage":"Realm name is invalid"}`), "example.test-kb", "right", []byte("{}")); err == nil || !strings.Contains(err.Error(), "refused to create the realm: HTTP 400 Realm name is invalid") {
		t.Errorf("a refused create should carry Keycloak's reason, got: %v", err)
	}
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	if _, err := ensureRealm(gone.URL, "example.test-kb", "right", []byte("{}")); err == nil || !strings.Contains(err.Error(), "asking Keycloak for the realm:") {
		t.Errorf("an unreachable Keycloak should say the ask failed, got: %v", err)
	}
}

// A clean's realm, against a stand-in for Keycloak's admin API: deleted with
// the admin's token, as deleted when it is already gone, and a refusal
// carrying Keycloak's reason.
func TestARealmIsDeletedWithTheAdminsToken(t *testing.T) {
	keycloak := func(answer int, refusal string) (string, *[]string) {
		var asked []string
		mux := http.NewServeMux()
		mux.HandleFunc("/realms/master/protocol/openid-connect/token", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "application/json")
			fmt.Fprint(w, `{"access_token":"admin-token"}`)
		})
		mux.HandleFunc("/admin/realms/example.test-kb", func(w http.ResponseWriter, r *http.Request) {
			asked = append(asked, r.Method+" "+r.Header.Get("Authorization"))
			w.WriteHeader(answer)
			fmt.Fprint(w, refusal)
		})
		srv := httptest.NewServer(mux)
		t.Cleanup(srv.Close)
		return srv.URL, &asked
	}

	base, asked := keycloak(http.StatusNoContent, "")
	if err := deleteRealm(base, "example.test-kb", "right"); err != nil {
		t.Fatalf("deleting a held realm: %v", err)
	}
	if want := []string{"DELETE Bearer admin-token"}; !slices.Equal(*asked, want) {
		t.Errorf("the delete asked %v, want %v", *asked, want)
	}
	base, _ = keycloak(http.StatusNotFound, "")
	if err := deleteRealm(base, "example.test-kb", "right"); err != nil {
		t.Errorf("a realm gone before the delete should read as deleted, got: %v", err)
	}
	base, _ = keycloak(http.StatusForbidden, `{"errorMessage":"Forbidden"}`)
	if err := deleteRealm(base, "example.test-kb", "right"); err == nil || !strings.Contains(err.Error(), "refused to delete the realm: HTTP 403 Forbidden") {
		t.Errorf("a refused delete should carry Keycloak's reason, got: %v", err)
	}
}

// Whether a realm is held is asked at its public root, which needs no login.
func TestWhetherARealmIsHeldIsAskedAtItsPublicRoot(t *testing.T) {
	for answer, want := range map[int]bool{http.StatusOK: true, http.StatusNotFound: false} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/realms/example.test-kb" || r.Header.Get("Authorization") != "" {
				t.Errorf("asked %s with authorization %q, want the realm's public root", r.URL.Path, r.Header.Get("Authorization"))
			}
			w.WriteHeader(answer)
		}))
		held, err := realmHeld(srv.URL, "example.test-kb")
		srv.Close()
		if err != nil || held != want {
			t.Errorf("a root answered %d reads as held %v (error %v), want %v", answer, held, err, want)
		}
	}
}
