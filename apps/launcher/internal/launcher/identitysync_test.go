package launcher

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// `semiont identity sync` — the repair half of IDENTITY-PREFLIGHT P3.
//
// The preflight can already say "this realm has no semiont-weaver client".
// Nothing could add it, so every realm-shape change shipped with a
// hand-written recovery paragraph instead. These drive a STUB admin API for
// the same reason the preflight tests do: what is asserted is the launcher's
// reconciliation, and a real Keycloak cannot be made to be missing a client
// on demand.

// stubAdmin: Keycloak's admin surface, holding whatever clients `existing`
// names. Records every request path so a test can assert what was NOT touched.
type stubAdmin struct {
	srv      *httptest.Server
	mu       sync.Mutex
	paths    []string
	created  []map[string]any
	badLogin bool
}

func newStubAdmin(t *testing.T, realm string, existing []string) *stubAdmin {
	t.Helper()
	s := &stubAdmin{}
	mux := http.NewServeMux()
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.paths = append(s.paths, r.Method+" "+r.URL.Path)
		s.mu.Unlock()
		w.WriteHeader(http.StatusNotFound)
	})

	mux.HandleFunc("/realms/master/protocol/openid-connect/token",
		func(w http.ResponseWriter, r *http.Request) {
			s.mu.Lock()
			s.paths = append(s.paths, r.Method+" "+r.URL.Path)
			bad := s.badLogin
			s.mu.Unlock()
			if bad {
				w.WriteHeader(http.StatusUnauthorized)
				fmt.Fprint(w, `{"error":"invalid_grant"}`)
				return
			}
			w.Header().Set("content-type", "application/json")
			fmt.Fprint(w, `{"access_token":"admin-token","expires_in":60}`)
		})

	mux.HandleFunc("/admin/realms/"+realm+"/clients",
		func(w http.ResponseWriter, r *http.Request) {
			s.mu.Lock()
			s.paths = append(s.paths, r.Method+" "+r.URL.Path)
			s.mu.Unlock()
			if r.Header.Get("Authorization") != "Bearer admin-token" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			switch r.Method {
			case http.MethodGet:
				out := make([]map[string]any, 0, len(existing))
				for _, id := range existing {
					out = append(out, map[string]any{"id": "uuid-" + id, "clientId": id})
				}
				w.Header().Set("content-type", "application/json")
				_ = json.NewEncoder(w).Encode(out)
			case http.MethodPost:
				body, _ := io.ReadAll(r.Body)
				var c map[string]any
				_ = json.Unmarshal(body, &c)
				s.mu.Lock()
				s.created = append(s.created, c)
				s.mu.Unlock()
				w.WriteHeader(http.StatusCreated)
			}
		})
	return s
}

func (s *stubAdmin) touched(substr string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.paths {
		if strings.Contains(p, substr) {
			return true
		}
	}
	return false
}

func secretForTest(svc string) string { return "secret-" + svc }

func TestIdentitySyncCreatesOnlyTheMissingClients(t *testing.T) {
	// A realm that predates the dispatcher: every client but one.
	present := []string{}
	for _, svc := range serviceClients[:len(serviceClients)-1] {
		present = append(present, serviceClientID(svc))
	}
	missing := serviceClients[len(serviceClients)-1]

	s := newStubAdmin(t, "semiont", present)
	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", secretForTest)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(rep.created) != 1 || rep.created[0] != serviceClientID(missing) {
		t.Fatalf("created = %v, want exactly [%s]", rep.created, serviceClientID(missing))
	}
	if len(rep.present) != len(present) {
		t.Fatalf("present = %v, want %d already-there clients", rep.present, len(present))
	}
	if len(s.created) != 1 {
		t.Fatalf("POSTed %d clients, want 1 — an existing client must not be recreated", len(s.created))
	}
}

func TestIdentitySyncCreatesTheClientTheImportWOULDHave(t *testing.T) {
	// The shape is the thing: a hand-created client is exactly where the flat
	// `roles` claim and the audience mapper get missed, and the gateway
	// rejects both silently-looking-correct forms.
	s := newStubAdmin(t, "semiont", nil)
	if _, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", secretForTest); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(s.created) != len(serviceClients) {
		t.Fatalf("created %d clients, want %d", len(s.created), len(serviceClients))
	}
	got, _ := json.Marshal(s.created[0])
	want, _ := json.Marshal(serviceAccountClient(serviceClients[0], secretForTest(serviceClients[0]), "semiont-gateway"))
	if string(got) != string(want) {
		t.Fatalf("created client differs from what the realm import renders:\n got: %s\nwant: %s", got, want)
	}
}

func TestIdentitySyncTouchesNoAccounts(t *testing.T) {
	// The property that keeps this out of "delete and re-import" territory:
	// configuration only, never users. A sync that could touch accounts is one
	// nobody can safely run against a deployment that has any.
	s := newStubAdmin(t, "semiont", nil)
	if _, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", secretForTest); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if s.touched("/users") {
		t.Fatal("sync reached a users endpoint; it must reconcile configuration only")
	}
	if s.touched("DELETE") {
		t.Fatal("sync issued a DELETE; it adds what is missing and removes nothing")
	}
}

func TestIdentitySyncReportsAnAdminLoginFailure(t *testing.T) {
	s := newStubAdmin(t, "semiont", nil)
	s.badLogin = true
	_, err := syncServiceClients(s.srv.URL, "semiont", "admin", "wrong", "semiont-gateway", secretForTest)
	if err == nil {
		t.Fatal("want an error when the bootstrap admin credential is refused")
	}
	if !strings.Contains(err.Error(), "admin") {
		t.Fatalf("error should name the admin login as the cause, got: %v", err)
	}
	if len(s.created) != 0 {
		t.Fatal("nothing may be created when the admin login failed")
	}
}

func TestIdentitySyncIsIdempotent(t *testing.T) {
	// The second run of a repair must be a no-op, or an operator cannot re-run
	// it to confirm the first one worked.
	all := []string{}
	for _, svc := range serviceClients {
		all = append(all, serviceClientID(svc))
	}
	s := newStubAdmin(t, "semiont", all)
	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", secretForTest)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(rep.created) != 0 {
		t.Fatalf("created = %v, want nothing on an already-correct realm", rep.created)
	}
	if len(s.created) != 0 {
		t.Fatal("POSTed a client to an already-correct realm")
	}
}
