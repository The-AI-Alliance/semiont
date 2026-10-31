package launcher

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// `semiont identity sync` — the repair the identity preflight's refusals name.
//
// The preflight says "this realm has no semiont-weaver client"; sync is what
// adds it. These drive a STUB admin API for the same reason the preflight
// tests do: what is asserted is the launcher's reconciliation, and a real
// Keycloak cannot be made to be missing a client on demand.

// stubAdmin: Keycloak's admin surface, holding whatever clients `existing`
// names. Records every request path so a test can assert what was NOT touched.
type stubAdmin struct {
	srv       *httptest.Server
	mu        sync.Mutex
	paths     []string
	created   []map[string]any
	updated   map[string]map[string]any // clientId -> the patch PUT to it
	mappers   map[string]map[string]any // clientId -> the mapper PUT to /clients/<uuid>/protocol-mappers/models/<id>
	deleted   []string                  // clientIds DELETEd
	added     map[string]map[string]any // clientId -> the mapper POSTed to /clients/<uuid>/protocol-mappers/models
	realmCfg  map[string]any            // realm-level settings this realm reports
	badLogin  bool
	httpsOnly bool // the master realm's sslRequired refusing this caller's address
	// refuseWrites: the admin API refusing every change to a client, as it
	// refuses an admin without the rights to make one.
	refuseWrites bool
}

// refusing: whether the stub refuses this request, and if so answers it so.
func (s *stubAdmin) refusing(w http.ResponseWriter, r *http.Request) bool {
	s.mu.Lock()
	refuse := s.refuseWrites && r.Method != http.MethodGet
	s.mu.Unlock()
	if refuse {
		w.WriteHeader(http.StatusForbidden)
	}
	return refuse
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
	s := &stubAdmin{updated: map[string]map[string]any{}, mappers: map[string]map[string]any{}, added: map[string]map[string]any{}, realmCfg: map[string]any{}}
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
			bad, httpsOnly := s.badLogin, s.httpsOnly
			s.mu.Unlock()
			// As Keycloak 26.7.4 answers: a wrong password is 400
			// invalid_grant, and plain HTTP from an address the master realm
			// does not count as private is 403 invalid_request.
			if httpsOnly {
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `{"error":"invalid_request","error_description":"HTTPS required"}`)
				return
			}
			if bad {
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprint(w, `{"error":"invalid_grant","error_description":"Invalid user credentials"}`)
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
				if s.refusing(w, r) {
					return
				}
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
		if strings.Contains(r.URL.Path, "/clients/") && s.refusing(w, r) {
			return
		}
		// A mapper added: /admin/realms/<realm>/clients/<uuid>/protocol-mappers/models.
		if strings.HasSuffix(r.URL.Path, "/protocol-mappers/models") && r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			var mapper map[string]any
			_ = json.Unmarshal(body, &mapper)
			rest := r.URL.Path[strings.LastIndex(r.URL.Path, "/clients/")+len("/clients/"):]
			id := strings.TrimPrefix(rest[:strings.Index(rest, "/")], "uuid-")
			s.mu.Lock()
			s.added[id] = mapper
			s.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			return
		}
		// One mapper: /admin/realms/<realm>/clients/<uuid>/protocol-mappers/models/<id>.
		// A sub-resource with its own endpoint — a client-level PUT does not
		// reach it — so it is recorded apart from the client patches.
		if strings.Contains(r.URL.Path, "/protocol-mappers/models/") && r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			var mapper map[string]any
			_ = json.Unmarshal(body, &mapper)
			rest := r.URL.Path[strings.LastIndex(r.URL.Path, "/clients/")+len("/clients/"):]
			id := strings.TrimPrefix(rest[:strings.Index(rest, "/")], "uuid-")
			s.mu.Lock()
			s.mappers[id] = mapper
			s.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// One client deleted: /admin/realms/<realm>/clients/<uuid>
		if strings.Contains(r.URL.Path, "/clients/") && r.Method == http.MethodDelete {
			id := strings.TrimPrefix(r.URL.Path[strings.LastIndex(r.URL.Path, "/clients/")+len("/clients/"):], "uuid-")
			s.mu.Lock()
			s.deleted = append(s.deleted, id)
			s.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
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

// accountServices: every service with an account in the realm, in the order
// sync visits them — the secret clients, then the worker.
func accountServices() []string {
	return append(append([]string(nil), secretClients...), "worker")
}

func TestIdentitySyncCreatesOnlyTheMissingClients(t *testing.T) {
	// A realm holding every client but one.
	all := accountServices()
	present := []map[string]any{}
	for _, svc := range all[:len(all)-1] {
		present = append(present, serviceClientRep(svc, serviceRolesClaim(svc)))
	}
	missing := all[len(all)-1]

	s := newStubAdmin(t, "semiont", present)
	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts())
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
	if _, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(s.created) != len(stackServices) {
		t.Fatalf("created %d clients, want %d", len(s.created), len(stackServices))
	}
	for i, want := range map[int]map[string]any{
		0:                  serviceAccountClient(secretClients[0], secretForTest(secretClients[0]), "semiont-gateway"),
		len(s.created) - 1: workerClient(localWorkerLabel, testWorkerKey().registeredKey, "semiont-gateway"),
	} {
		got, _ := json.Marshal(s.created[i])
		want, _ := json.Marshal(want)
		if string(got) != string(want) {
			t.Fatalf("created client differs from what the realm import renders:\n got: %s\nwant: %s", got, want)
		}
	}
}

func TestIdentitySyncTouchesNoAccounts(t *testing.T) {
	// The property that keeps this out of "delete and re-import" territory:
	// configuration only, never users. A sync that could touch accounts is one
	// nobody can safely run against a deployment that has any.
	s := newStubAdmin(t, "semiont", nil)
	if _, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts()); err != nil {
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
	_, err := syncServiceClients(s.srv.URL, "semiont", "admin", "wrong", "semiont-gateway", testAccounts())
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

// The two refusals read differently: only Keycloak's `invalid_grant` is the
// password, and "HTTPS required" — the master realm refusing plain HTTP from an
// address it does not count as private, as Docker Desktop delivers this
// machine's connections — must not send the operator hunting for a password.
func TestAdminLoginRefusalsSayWhichRefusal(t *testing.T) {
	s := newStubAdmin(t, "semiont", nil)
	s.httpsOnly = true
	_, err := adminToken(s.srv.URL, "admin", "right")
	if err == nil {
		t.Fatal("want an error when the master realm demands HTTPS")
	}
	for _, want := range []string{"HTTPS required", "semiont start"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("an HTTPS refusal should say %q, got: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "KC_BOOTSTRAP_ADMIN_PASSWORD") {
		t.Errorf("an HTTPS refusal is not a password problem, but the error says it is: %v", err)
	}

	s.httpsOnly, s.badLogin = false, true
	_, err = adminToken(s.srv.URL, "admin", "wrong")
	if err == nil {
		t.Fatal("want an error when the password is refused")
	}
	for _, want := range []string{"Invalid user credentials", "KC_BOOTSTRAP_ADMIN_PASSWORD"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("a credential refusal should say %q, got: %v", want, err)
		}
	}
}

func TestIdentitySyncIsIdempotent(t *testing.T) {
	// The second run of a repair must be a no-op, or an operator cannot re-run
	// it to confirm the first one worked.
	all := []map[string]any{}
	for _, svc := range accountServices() {
		all = append(all, serviceClientRep(svc, serviceRolesClaim(svc)))
	}
	s := newStubAdmin(t, "semiont", all)
	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts())
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

// ── Beyond missing clients: the realm drifts in ways the preflight detects,
// and every one of those detections needs a remedy here. Otherwise "a new
// realm field costs a line in one function" is true of clients only, and
// every other change needs a hand-written recovery paragraph.

func allServiceClientReps() []map[string]any {
	out := []map[string]any{}
	for _, svc := range accountServices() {
		out = append(out, serviceClientRep(svc, serviceRolesClaim(svc)))
	}
	return out
}

// serviceClientRep: a service client as Keycloak LISTS it — protocol mappers
// included, each with the id the admin API addresses it by, and the worker's
// key. DERIVED from the client the realm document renders, so a stub can never
// carry a mapper shape the import would not; only `rolesValue`, what the roles
// mapper stamps, is the stub's to choose — a realm imported before the worker
// role existed stamps just the service role on the worker too.
func serviceClientRep(svc, rolesValue string) map[string]any {
	rendered := serviceAccountClient(svc, "unused", "unused")
	if svc == "worker" {
		rendered = workerClient(localWorkerLabel, testWorkerKey().registeredKey, "unused")
	}
	mappers := []map[string]any{}
	for _, m := range rendered["protocolMappers"].([]map[string]any) {
		rep := map[string]any{"id": "mapper-" + svc + "-" + strings.ReplaceAll(m["name"].(string), " ", "-")}
		for k, v := range m {
			rep[k] = v
		}
		if m["name"] == "semiont service role" {
			cfg := map[string]string{}
			for k, v := range m["config"].(map[string]string) {
				cfg[k] = v
			}
			cfg["claim.value"] = rolesValue
			rep["config"] = cfg
		}
		mappers = append(mappers, rep)
	}
	listed := map[string]any{"clientId": serviceClientID(svc), "protocolMappers": mappers}
	for _, field := range []string{"clientAuthenticatorType", "attributes"} {
		if v, ok := rendered[field]; ok {
			listed[field] = v
		}
	}
	return listed
}

// The worker carries a second role in its hardcoded roles mapper: the worker
// role, the one a job:claim is authorized by. A realm imported before that
// role existed holds the mapper with the OLD value; the preflight refuses such
// a realm (TestPreflightRefusesAWorkerThatCannotClaim), and this is the remedy
// that refusal names. The mapper is a sub-resource with its own endpoint — a
// client-level PUT does not reach it.
func TestIdentitySyncReconcilesTheWorkersRolesMapper(t *testing.T) {
	stale, _ := json.Marshal([]string{serviceRole}) // what every client stamped before the worker role
	reps := []map[string]any{}
	for _, svc := range accountServices() {
		value := serviceRolesClaim(svc)
		if svc == "worker" {
			value = string(stale)
		}
		reps = append(reps, serviceClientRep(svc, value))
	}
	s := newStubAdmin(t, "semiont", reps)

	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	mapper, ok := s.mappers[serviceClientID("worker")]
	if !ok {
		t.Fatalf("the worker's stale roles mapper was left alone; mapper PUTs: %v", s.mappers)
	}
	cfg, _ := mapper["config"].(map[string]any)
	if cfg["claim.value"] != serviceRolesClaim("worker") {
		t.Errorf("claim.value = %v, want %s", cfg["claim.value"], serviceRolesClaim("worker"))
	}
	// PUT back as the mapper it already is — same id, same name: an update,
	// not a second mapper stamping a second `roles` claim beside the first.
	if mapper["id"] != "mapper-worker-semiont-service-role" || mapper["name"] != "semiont service role" {
		t.Errorf("mapper identity changed: id=%v name=%v", mapper["id"], mapper["name"])
	}
	if len(s.mappers) != 1 {
		t.Errorf("mapper PUTs = %v, want the worker's only — every other mapper was already correct", s.mappers)
	}
	if _, clientPut := s.updated[serviceClientID("worker")]; clientPut {
		t.Error("the client itself was PUT; the mapper is a sub-resource the client-level PUT does not reach")
	}
	if len(rep.updated) != 1 || !strings.Contains(rep.updated[0], serviceClientID("worker")) {
		t.Errorf("updated = %v, want one entry naming the worker", rep.updated)
	}
	if len(rep.created) != 0 {
		t.Errorf("created = %v, want nothing — every client exists", rep.created)
	}
}

// withoutMapper: a client as Keycloak lists it, less the mapper named name — a
// client of a realm imported before that mapper existed.
func withoutMapper(rep map[string]any, name string) map[string]any {
	out := map[string]any{}
	for k, v := range rep {
		out[k] = v
	}
	var kept []map[string]any
	for _, m := range rep["protocolMappers"].([]map[string]any) {
		if m["name"] != name {
			kept = append(kept, m)
		}
	}
	out["protocolMappers"] = kept
	return out
}

// A realm imported before the kind claim holds every account's client without
// the mapper that stamps it. Sync adds it to each — the mapper the realm
// document renders, POSTed as a sub-resource of the client — and nothing else.
func TestIdentitySyncAddsTheKindMapperToAnOlderRealm(t *testing.T) {
	reps := []map[string]any{}
	for _, svc := range accountServices() {
		reps = append(reps, withoutMapper(serviceClientRep(svc, serviceRolesClaim(svc)), agentKindMapperName))
	}
	s := newStubAdmin(t, "semiont", reps)

	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(s.added) != len(stackServices) {
		t.Fatalf("kind mapper added to %d clients, want every account's (%d): %v", len(s.added), len(stackServices), s.added)
	}
	want, _ := renderedMapper(serviceAccountClient("gateway", "unused", "semiont-gateway"), agentKindMapperName)
	got, _ := json.Marshal(s.added[serviceClientID("gateway")])
	wantJSON, _ := json.Marshal(want)
	if string(got) != string(wantJSON) {
		t.Errorf("the added mapper is not the one the realm renders:\n got: %s\nwant: %s", got, wantJSON)
	}
	if len(s.created)+len(s.updated)+len(s.mappers)+len(s.deleted) != 0 {
		t.Errorf("sync changed more than the kind mapper: POST %v, PUT %v, mapper PUT %v, DELETE %v", s.created, s.updated, s.mappers, s.deleted)
	}
	if len(rep.updated) != len(stackServices) || !strings.Contains(rep.updated[0], "kind mapper added") {
		t.Errorf("updated = %v, want each client named with the mapper added", rep.updated)
	}
}

// A kind mapper that stamps something else is brought back to the claim, in
// place, by its id: one `kind` claim on the token, not two.
func TestIdentitySyncReconcilesAKindMapperThatSaysOtherwise(t *testing.T) {
	reps := []map[string]any{}
	for _, svc := range accountServices() {
		r := serviceClientRep(svc, serviceRolesClaim(svc))
		if svc == "weaver" {
			for _, m := range r["protocolMappers"].([]map[string]any) {
				if m["name"] == agentKindMapperName {
					m["config"] = map[string]string{"claim.name": kindClaim, "claim.value": "person"}
				}
			}
		}
		reps = append(reps, r)
	}
	s := newStubAdmin(t, "semiont", reps)

	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	mapper, ok := s.mappers[serviceClientID("weaver")]
	if !ok || len(s.mappers) != 1 || len(s.added) != 0 {
		t.Fatalf("mapper PUTs %v, POSTs %v; want the weaver's kind mapper updated alone", s.mappers, s.added)
	}
	cfg, _ := mapper["config"].(map[string]any)
	if mapper["id"] != "mapper-weaver-semiont-agent-kind" || cfg["claim.value"] != agentKind {
		t.Errorf("the mapper was not brought back in place: %v", mapper)
	}
	if len(rep.updated) != 1 || !strings.Contains(rep.updated[0], serviceClientID("weaver")) {
		t.Errorf("updated = %v, want the weaver alone", rep.updated)
	}
}

// The worker's client holds the key it checks the worker's assertions with,
// and sync knows what that key should be: this machine's, whose public half is
// no secret. A realm holding another — imported on another machine, or before
// this machine's key was made again — refuses every sign-in of this machine's
// worker, and sync puts this machine's key on the client, naming both, so a
// second machine syncing the same realm visibly takes the client over.
func TestIdentitySyncBringsTheWorkersClientToThisMachinesKey(t *testing.T) {
	another, err := rsa.GenerateKey(rand.Reader, workerKeyBits)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := workerKeyOf(another)
	if err != nil {
		t.Fatal(err)
	}
	reps := []map[string]any{}
	for _, svc := range accountServices() {
		r := serviceClientRep(svc, serviceRolesClaim(svc))
		if svc == "worker" {
			r["attributes"] = workerKeyAttributes(theirs.registeredKey)
		}
		reps = append(reps, r)
	}
	s := newStubAdmin(t, "semiont", reps)

	rep, err := syncServiceClients(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	patch, ok := s.updated[serviceClientID("worker")]
	if !ok {
		t.Fatalf("the worker's client kept another machine's key; client PUTs: %v", s.updated)
	}
	if patch["clientAuthenticatorType"] != clientJWT {
		t.Errorf("clientAuthenticatorType = %v, want %s", patch["clientAuthenticatorType"], clientJWT)
	}
	attributes, _ := patch["attributes"].(map[string]any)
	for name, want := range workerKeyAttributes(testWorkerKey().registeredKey) {
		if attributes[name] != want {
			t.Errorf("attribute %s = %v, want %s", name, attributes[name], want)
		}
	}
	if len(s.updated) != 1 || len(s.mappers) != 0 || len(s.created) != 0 {
		t.Errorf("want the worker's key alone changed: client PUTs %v, mapper PUTs %v, created %v", s.updated, s.mappers, s.created)
	}
	if len(rep.updated) != 1 || !strings.Contains(rep.updated[0], testWorkerKey().thumbprint) || !strings.Contains(rep.updated[0], theirs.thumbprint) {
		t.Errorf("updated = %v, want one entry naming both keys", rep.updated)
	}
}

// A realm imported before the portless loopback rule pins :3000, and a
// Browser document naming another port then produces a stack nobody can sign
// in to.
func TestIdentitySyncAddsMissingLoopbackRedirects(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": semiont.BrowserClientID, "redirectUris": []any{"http://localhost:3000/*"}},
		map[string]any{"clientId": semiont.ScriptClientID})
	s := newStubAdmin(t, "semiont", reps)

	rep, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, catalogBrowser().Spec.Port, testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	patch, ok := s.updated[semiont.BrowserClientID]
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

// The implicit flow hands the token back in a redirect fragment. The preflight
// refuses the start over it; this is the fix that refusal should be able to
// name.
func TestIdentitySyncDisablesTheImplicitFlow(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": semiont.BrowserClientID, "implicitFlowEnabled": true,
			"redirectUris": []any{"http://localhost/*", "http://127.0.0.1/*"}},
		map[string]any{"clientId": semiont.ScriptClientID})
	s := newStubAdmin(t, "semiont", reps)

	if _, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, catalogBrowser().Spec.Port, testAccounts()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	patch, ok := s.updated[semiont.BrowserClientID]
	if !ok {
		t.Fatal("a client with the implicit flow enabled was left alone")
	}
	if patch["implicitFlowEnabled"] != false {
		t.Errorf("patch does not disable the implicit flow: %#v", patch["implicitFlowEnabled"])
	}
}

// The lifespan the config asks for is the revocation window. The preflight
// warns when the realm disagrees; sync is what changes it.
func TestIdentitySyncCorrectsTheAccessTokenLifespan(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": semiont.BrowserClientID, "redirectUris": []any{"http://localhost/*", "http://127.0.0.1/*"}},
		map[string]any{"clientId": semiont.ScriptClientID})
	s := newStubAdmin(t, "semiont", reps)
	s.realmCfg = map[string]any{"accessTokenLifespan": float64(1800)}

	if _, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, catalogBrowser().Spec.Port, testAccounts()); err != nil {
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

// correctRealm: the clients of a realm sync has nothing to change in, for a
// Browser on the default port and 300-second tokens.
func correctRealm() []map[string]any {
	// The service clients carry their mappers, each stamping exactly what the
	// realm document renders — so the roles-mapper reconcile is proven
	// idempotent too, not only the client-level fields.
	reps := []map[string]any{}
	for _, svc := range accountServices() {
		reps = append(reps, serviceClientRep(svc, serviceRolesClaim(svc)))
	}
	return append(reps,
		// A correct realm carries the port-ful web origins too: CORS origins
		// are matched exactly, so the portless redirect URIs beside them
		// cannot stand in for the Browser's real origin.
		map[string]any{"clientId": semiont.BrowserClientID, "implicitFlowEnabled": false,
			"redirectUris": []any{"http://localhost/*", "http://127.0.0.1/*", "http://10.0.0.5:3000/*"},
			"webOrigins":   []any{"http://localhost:3000", "http://127.0.0.1:3000", "http://10.0.0.5:3000"}},
		map[string]any{"clientId": semiont.ScriptClientID, "implicitFlowEnabled": false})
}

// The control: a correct realm is not written to at all. Without this, every
// assertion above passes against a sync that PUTs unconditionally.
func TestIdentitySyncLeavesACorrectRealmAlone(t *testing.T) {
	s := newStubAdmin(t, "semiont", correctRealm())
	s.realmCfg = map[string]any{"accessTokenLifespan": float64(300)}

	rep, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, catalogBrowser().Spec.Port, testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(s.updated) != 0 {
		t.Fatalf("a correct realm was written to: %v", s.updated)
	}
	if len(s.mappers) != 0 {
		t.Fatalf("a correct realm's mappers were written to: %v", s.mappers)
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

// Sync adds the browser client's missing loopback web origins. A realm
// imported before those origins were explicit carries `webOrigins: ["+"]`, so
// Keycloak derives its CORS origins from the PORTLESS loopback redirects and
// the Browser's real origin is in no set at all. The realm imports once, so
// sync is the only way an existing knowledge base gets the repair — and the
// preflight's finding names this command by name.
func TestIdentitySyncAddsMissingBrowserWebOrigins(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": semiont.BrowserClientID, "webOrigins": []any{"+"}},
		map[string]any{"clientId": semiont.ScriptClientID})
	s := newStubAdmin(t, "semiont", reps)

	rep, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, catalogBrowser().Spec.Port, testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	patch, ok := s.updated[semiont.BrowserClientID]
	if !ok {
		t.Fatal("a realm deriving its origins was left deriving them")
	}
	origins, _ := json.Marshal(patch["webOrigins"])
	for _, want := range loopbackWebOrigins(catalogBrowser().Spec.Port) {
		if !strings.Contains(string(origins), want) {
			t.Errorf("patch does not add %s: %s", want, origins)
		}
	}
	// Removing nothing is what makes sync safe against a customised realm —
	// including the LAN origin this command cannot re-derive.
	if !strings.Contains(string(origins), `"+"`) {
		t.Errorf("the existing entry was dropped: %s", origins)
	}
	if len(rep.updated) == 0 {
		t.Error("the repair was not reported")
	}
}

// The Browser's document moves the Browser, so sync writes the origin for the
// port it is told about — that is what makes "move the Browser, then sync"
// actually work.
func TestIdentitySyncWritesTheBrowsersActualPort(t *testing.T) {
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": semiont.BrowserClientID, "webOrigins": []any{"+"}},
		map[string]any{"clientId": semiont.ScriptClientID})
	s := newStubAdmin(t, "semiont", reps)

	if _, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, 3001, testAccounts()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	origins, _ := json.Marshal(s.updated[semiont.BrowserClientID]["webOrigins"])
	if !strings.Contains(string(origins), "http://localhost:3001") {
		t.Errorf("sync did not write the moved port: %s", origins)
	}
}

// Idempotent: a realm already carrying the origins is not patched again.
func TestIdentitySyncLeavesCorrectWebOriginsAlone(t *testing.T) {
	origins := []any{}
	for _, o := range loopbackWebOrigins(catalogBrowser().Spec.Port) {
		origins = append(origins, o)
	}
	reps := append(allServiceClientReps(),
		map[string]any{"clientId": semiont.BrowserClientID, "webOrigins": origins,
			"redirectUris": []any{"http://localhost/*", "http://127.0.0.1/*"}},
		map[string]any{"clientId": semiont.ScriptClientID})
	s := newStubAdmin(t, "semiont", reps)

	if _, err := syncRealm(s.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300, catalogBrowser().Spec.Port, testAccounts()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if patch, ok := s.updated[semiont.BrowserClientID]; ok {
		if _, touched := patch["webOrigins"]; touched {
			t.Errorf("a realm already carrying the origins was patched: %v", patch["webOrigins"])
		}
	}
}
