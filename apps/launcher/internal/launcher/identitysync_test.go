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
	updated  map[string]map[string]any // clientId -> the patch PUT to it
	realmCfg map[string]any            // realm-level settings this realm reports
	badLogin bool
}

// clientReps: the minimal representation Keycloak returns for clients that
// exist and need nothing.
func clientReps(ids ...string) []map[string]any {
	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		out = append(out, map[string]any{"clientId": id})
	}
	return out
}

func newStubAdmin(t *testing.T, realm string, existing []map[string]any) *stubAdmin {
	t.Helper()
	s := &stubAdmin{updated: map[string]map[string]any{}, realmCfg: map[string]any{}}
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
				for _, c := range existing {
					rep := map[string]any{"id": "uuid-" + c["clientId"].(string)}
					for k, v := range c {
						rep[k] = v
					}
					out = append(out, rep)
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
	mux.HandleFunc("/admin/realms/"+realm+"/", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.paths = append(s.paths, r.Method+" "+r.URL.Path)
		s.mu.Unlock()
		// One client: /admin/realms/<realm>/clients/<uuid>
		if strings.Contains(r.URL.Path, "/clients/") && r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			var patch map[string]any
			_ = json.Unmarshal(body, &patch)
			id := strings.TrimPrefix(r.URL.Path[strings.LastIndex(r.URL.Path, "/clients/")+len("/clients/"):], "uuid-")
			s.mu.Lock()
			s.updated[id] = patch
			s.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	mux.HandleFunc("/admin/realms/"+realm, func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.paths = append(s.paths, r.Method+" "+r.URL.Path)
		s.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("content-type", "application/json")
			s.mu.Lock()
			cfg := s.realmCfg
			s.mu.Unlock()
			_ = json.NewEncoder(w).Encode(cfg)
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			var patch map[string]any
			_ = json.Unmarshal(body, &patch)
			s.mu.Lock()
			s.updated["<realm>"] = patch
			s.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
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
	present := []map[string]any{}
	for _, svc := range serviceClients[:len(serviceClients)-1] {
		present = append(present, map[string]any{"clientId": serviceClientID(svc)})
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
	all := []map[string]any{}
	for _, svc := range serviceClients {
		all = append(all, map[string]any{"clientId": serviceClientID(svc)})
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

// ── Beyond missing clients: the realm drifts in ways the preflight already
// detects, and every one of those detections needs a remedy here. Otherwise
// "a new realm field costs a line in one function" is true of clients only,
// and every other change goes back to a hand-written paragraph.

func allServiceClientReps() []map[string]any {
	out := []map[string]any{}
	for _, svc := range serviceClients {
		out = append(out, map[string]any{"clientId": serviceClientID(svc)})
	}
	return out
}

// A realm imported before the portless loopback rule pins :3000, and
// `--service browser --port N` then produces a stack nobody can sign in to.
func TestIdentitySyncAddsMissingLoopbackRedirects(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": browserClientID, "redirectUris": []any{"http://localhost:3000/*"}},
		map[string]any{"clientId": cliClientID})
	s := newStubAdmin(t, "semiont", reps)

	rep, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, secretForTest)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	patch, ok := s.updated[browserClientID]
	if !ok {
		t.Fatal("a realm pinned to :3000 was left pinned")
	}
	uris, _ := json.Marshal(patch["redirectUris"])
	for _, want := range loopbackRedirectUris() {
		if !strings.Contains(string(uris), want) {
			t.Errorf("patch does not add %s: %s", want, uris)
		}
	}
	// Removing nothing is what makes sync safe against a customised realm.
	if !strings.Contains(string(uris), "http://localhost:3000/*") {
		t.Errorf("the existing entry was dropped: %s", uris)
	}
	if len(rep.updated) == 0 {
		t.Error("the repair was not reported")
	}
}

// The implicit flow hands the token back in a redirect fragment. P4 refuses the
// start over it; this is the fix that refusal should be able to name.
func TestIdentitySyncDisablesTheImplicitFlow(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": browserClientID, "implicitFlowEnabled": true,
			"redirectUris": []any{"http://localhost/*", "http://127.0.0.1/*"}},
		map[string]any{"clientId": cliClientID})
	s := newStubAdmin(t, "semiont", reps)

	if _, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, secretForTest); err != nil {
		t.Fatalf("sync: %v", err)
	}
	patch, ok := s.updated[browserClientID]
	if !ok {
		t.Fatal("a client with the implicit flow enabled was left alone")
	}
	if patch["implicitFlowEnabled"] != false {
		t.Errorf("patch does not disable the implicit flow: %#v", patch["implicitFlowEnabled"])
	}
}

// The lifespan the config asks for is the revocation window. The preflight
// warns when the realm disagrees; nothing could change it.
func TestIdentitySyncCorrectsTheAccessTokenLifespan(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": browserClientID, "redirectUris": []any{"http://localhost/*", "http://127.0.0.1/*"}},
		map[string]any{"clientId": cliClientID})
	s := newStubAdmin(t, "semiont", reps)
	s.realmCfg = map[string]any{"accessTokenLifespan": float64(1800)}

	if _, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, secretForTest); err != nil {
		t.Fatalf("sync: %v", err)
	}
	patch, ok := s.updated["<realm>"]
	if !ok {
		t.Fatal("a realm minting 1800s tokens against a 300s config was left alone")
	}
	if fmt.Sprint(patch["accessTokenLifespan"]) != "300" {
		t.Errorf("patch sets %v, want 300", patch["accessTokenLifespan"])
	}
}

// The control: a correct realm is not written to at all. Without this, every
// assertion above passes against a sync that PUTs unconditionally.
func TestIdentitySyncLeavesACorrectRealmAlone(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": browserClientID, "implicitFlowEnabled": false,
			"redirectUris": []any{"http://localhost/*", "http://127.0.0.1/*", "http://10.0.0.5:3000/*"}},
		map[string]any{"clientId": cliClientID, "implicitFlowEnabled": false})
	s := newStubAdmin(t, "semiont", reps)
	s.realmCfg = map[string]any{"accessTokenLifespan": float64(300)}

	rep, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, secretForTest)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(s.updated) != 0 {
		t.Fatalf("a correct realm was written to: %v", s.updated)
	}
	if len(rep.created) != 0 || len(rep.updated) != 0 {
		t.Fatalf("a correct realm reported changes: created=%v updated=%v", rep.created, rep.updated)
	}
}

// ── The verb's argument handling. The reconciler above is covered from both
// directions; this is the wrapper, and these are the paths that run before any
// root or config is resolved — so they need no stack and no fixture KB.

func TestIdentityVerbRejectsAnUnknownSubcommand(t *testing.T) {
	if code := Identity([]string{"resync"}); code != 1 {
		t.Fatalf("exit %d for an unknown subcommand, want 1", code)
	}
}

func TestIdentityVerbWithNoArgumentsIsAnError(t *testing.T) {
	// Printing usage and exiting 0 would make `semiont identity` in a script
	// look like a successful reconciliation.
	if code := Identity(nil); code != 1 {
		t.Fatalf("exit %d for no subcommand, want 1", code)
	}
}

func TestIdentityVerbHelpSucceeds(t *testing.T) {
	for _, flag := range []string{"--help", "-h"} {
		if code := Identity([]string{flag}); code != 0 {
			t.Errorf("exit %d for %s, want 0", code, flag)
		}
	}
}

func TestIdentityVerbRejectsAFlagWithNoValue(t *testing.T) {
	for _, args := range [][]string{{"sync", "--root"}, {"sync", "--config"}} {
		if code := Identity(args); code != 1 {
			t.Errorf("exit %d for %v, want 1", code, args)
		}
	}
}

func TestIdentityVerbRejectsAnUnknownFlag(t *testing.T) {
	if code := Identity([]string{"sync", "--realm", "semiont"}); code != 1 {
		t.Fatalf("exit %d for an unknown flag, want 1 — a typo must not be read as a default run", code)
	}
}
