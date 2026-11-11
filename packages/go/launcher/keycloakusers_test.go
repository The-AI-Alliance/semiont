package launcher

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// The realm's ACCOUNT surface. `identitysync.go` reconciles clients,
// mappers and realm settings; these four calls are the rest of what `semiont
// useradd` needs, so the launcher administers the realm through one client
// instead of exec-ing a second one written in TypeScript.
//
// A stub, for the reason the sync tests give: what is asserted is the request
// this code makes, and a real Keycloak cannot be made to hold a particular
// account on demand.

type stubUsers struct {
	srv      *httptest.Server
	mu       sync.Mutex
	requests []string         // METHOD path?query
	posted   map[string]any   // the body of the create
	puts     map[string]any   // last body PUT, by path
	existing []map[string]any // what a search finds
	status   map[string]int   // path -> status to force
}

func newStubUsers(t *testing.T, realm string, existing []map[string]any) *stubUsers {
	t.Helper()
	s := &stubUsers{puts: map[string]any{}, existing: existing, status: map[string]int{}}
	mux := http.NewServeMux()
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)

	users := "/admin/realms/" + realm + "/users"
	record := func(r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		q := r.URL.Path
		if r.URL.RawQuery != "" {
			q += "?" + r.URL.RawQuery
		}
		s.requests = append(s.requests, r.Method+" "+q)
	}

	mux.HandleFunc(users, func(w http.ResponseWriter, r *http.Request) {
		record(r)
		if code, forced := s.status[users]; forced {
			w.WriteHeader(code)
			return
		}
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(s.existing)
		case http.MethodPost:
			body, _ := io.ReadAll(r.Body)
			var c map[string]any
			_ = json.Unmarshal(body, &c)
			s.mu.Lock()
			s.posted = c
			s.mu.Unlock()
			w.Header().Set("Location", s.srv.URL+users+"/new-user-uuid")
			w.WriteHeader(http.StatusCreated)
		}
	})

	mux.HandleFunc(users+"/", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		if code, forced := s.status[r.URL.Path]; forced {
			w.WriteHeader(code)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var c map[string]any
		_ = json.Unmarshal(body, &c)
		s.mu.Lock()
		s.puts[r.URL.Path] = c
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	return s
}

func (s *stubUsers) saw(want string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.requests {
		if strings.Contains(r, want) {
			return true
		}
	}
	return false
}

func TestFindUserByEmailAsksForAnExactMatch(t *testing.T) {
	// `exact=true` or the realm answers substring matches: searching for
	// "sam@x.co" would find "samantha@x.co" and useradd would update the
	// wrong account.
	s := newStubUsers(t, "semiont", []map[string]any{
		{"id": "abc-123", "email": "sam@x.co", "enabled": true},
	})
	u, err := findUserByEmail(s.srv.URL, "semiont", "admin-token", "sam@x.co")
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if u == nil || u.id != "abc-123" || u.email != "sam@x.co" || !u.enabled {
		t.Fatalf("find returned %+v, want the realm's account", u)
	}
	if !s.saw("exact=true") {
		t.Errorf("search was not exact: %v", s.requests)
	}
	if !s.saw("email=sam%40x.co") {
		t.Errorf("search did not carry the escaped email: %v", s.requests)
	}
}

func TestFindUserByEmailReportsAbsenceAsNilNotError(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{})
	u, err := findUserByEmail(s.srv.URL, "semiont", "admin-token", "nobody@x.co")
	if err != nil {
		t.Fatalf("an empty realm is not an error: %v", err)
	}
	if u != nil {
		t.Fatalf("find returned %+v for an account that does not exist", u)
	}
}

func TestFindUserByEmailReportsARefusal(t *testing.T) {
	s := newStubUsers(t, "semiont", nil)
	s.status["/admin/realms/semiont/users"] = http.StatusForbidden
	if _, err := findUserByEmail(s.srv.URL, "semiont", "admin-token", "sam@x.co"); err == nil {
		t.Fatal("a 403 search was reported as success")
	}
}

func TestListRealmUsersPagesAndSortsAccounts(t *testing.T) {
	var pages []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/admin/realms/semiont/users" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		pages = append(pages, r.URL.Query().Get("first"))
		if r.URL.Query().Get("max") != "100" {
			t.Errorf("max = %q, want 100", r.URL.Query().Get("max"))
		}
		if r.URL.Query().Get("first") == "0" {
			accounts := make([]map[string]any, 100)
			for i := range accounts {
				accounts[i] = map[string]any{"id": fmt.Sprintf("id-%03d", i), "email": fmt.Sprintf("User%03d@example.org", 99-i), "enabled": i%2 == 0}
			}
			_ = json.NewEncoder(w).Encode(accounts)
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": "last", "username": "last@example.org", "enabled": true},
			{"id": ""},
		})
	}))
	defer srv.Close()

	users, err := listRealmUsers(srv.URL, "semiont", "admin-token")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !reflect.DeepEqual(pages, []string{"0", "100"}) {
		t.Fatalf("page offsets = %v, want [0 100]", pages)
	}
	if len(users) != 101 {
		t.Fatalf("got %d users, want 101 valid accounts", len(users))
	}
	if users[0].email != "last@example.org" || users[len(users)-1].email != "User099@example.org" {
		t.Fatalf("users not sorted case-insensitively: first=%q last=%q", users[0].email, users[len(users)-1].email)
	}
	if users[0].id != "last" || !users[0].enabled {
		t.Fatalf("username fallback account = %+v", users[0])
	}
}

func TestListRealmUsersReportsFailures(t *testing.T) {
	t.Run("invalid URL", func(t *testing.T) {
		if _, err := listRealmUsers("http://[::1", "semiont", "token"); err == nil {
			t.Fatal("invalid request URL succeeded")
		}
	})
	t.Run("unreachable issuer", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		url := srv.URL
		srv.Close()
		if _, err := listRealmUsers(url, "semiont", "token"); err == nil || !strings.Contains(err.Error(), "listing accounts") {
			t.Fatalf("error = %v, want transport error", err)
		}
	})
	t.Run("HTTP refusal", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) }))
		defer srv.Close()
		if _, err := listRealmUsers(srv.URL, "semiont", "token"); err == nil || !strings.Contains(err.Error(), "HTTP 403") {
			t.Fatalf("error = %v, want HTTP 403", err)
		}
	})
	t.Run("invalid response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "not-json") }))
		defer srv.Close()
		if _, err := listRealmUsers(srv.URL, "semiont", "token"); err == nil || !strings.Contains(err.Error(), "returned no list") {
			t.Fatalf("error = %v, want decode error", err)
		}
	})
}

func TestCreateUserSetsTheClaimsSignInRequires(t *testing.T) {
	// emailVerified: a token whose email_verified is false is refused at
	// sign-in, so an unverified account could never reach the KB an
	// administrator just granted. temporary:false: the password the
	// administrator set is the one that works, with no reset step on top of
	// the profile form the realm already asks for.
	s := newStubUsers(t, "semiont", nil)
	id, err := createUser(s.srv.URL, "semiont", "admin-token", "sam@x.co", "hunter2hunter2", true)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if id != "new-user-uuid" {
		t.Fatalf("id = %q, want the last segment of the Location header", id)
	}
	if s.posted["username"] != "sam@x.co" || s.posted["email"] != "sam@x.co" {
		t.Errorf("username/email = %v/%v", s.posted["username"], s.posted["email"])
	}
	if s.posted["emailVerified"] != true {
		t.Error("emailVerified was not set; the account could never sign in")
	}
	if s.posted["enabled"] != true {
		t.Error("enabled was not set")
	}
	creds, _ := s.posted["credentials"].([]any)
	if len(creds) != 1 {
		t.Fatalf("credentials = %v, want exactly one password", s.posted["credentials"])
	}
	cred, _ := creds[0].(map[string]any)
	if cred["type"] != "password" || cred["value"] != "hunter2hunter2" || cred["temporary"] != false {
		t.Errorf("credential = %v", cred)
	}
	if _, set := s.posted["firstName"]; set {
		t.Error("a name was guessed; the realm asks the person at first sign-in")
	}
}

func TestCreateUserNamesTheConflict(t *testing.T) {
	s := newStubUsers(t, "semiont", nil)
	s.status["/admin/realms/semiont/users"] = http.StatusConflict
	err := func() error {
		_, e := createUser(s.srv.URL, "semiont", "admin-token", "sam@x.co", "pw", true)
		return e
	}()
	if err == nil {
		t.Fatal("a 409 create was reported as success")
	}
	if !strings.Contains(err.Error(), "sam@x.co") {
		t.Errorf("the conflict does not name the account: %v", err)
	}
}

func TestSetUserPasswordIsNotTemporary(t *testing.T) {
	s := newStubUsers(t, "semiont", nil)
	if err := setUserPassword(s.srv.URL, "semiont", "admin-token", "abc-123", "newpassword1"); err != nil {
		t.Fatalf("setPassword: %v", err)
	}
	body, _ := s.puts["/admin/realms/semiont/users/abc-123/reset-password"].(map[string]any)
	if body == nil {
		t.Fatalf("no reset-password PUT; saw %v", s.requests)
	}
	if body["type"] != "password" || body["value"] != "newpassword1" || body["temporary"] != false {
		t.Errorf("reset body = %v", body)
	}
}

func TestSetUserEnabledGoesBothWays(t *testing.T) {
	// A control with no way back is one administrators avoid using: whatever
	// can disable an account must be able to restore it.
	for _, want := range []bool{false, true} {
		s := newStubUsers(t, "semiont", nil)
		if err := setUserEnabled(s.srv.URL, "semiont", "admin-token", "abc-123", want); err != nil {
			t.Fatalf("setEnabled(%v): %v", want, err)
		}
		body, _ := s.puts["/admin/realms/semiont/users/abc-123"].(map[string]any)
		if body == nil {
			t.Fatalf("no PUT for enabled=%v; saw %v", want, s.requests)
		}
		if body["enabled"] != want {
			t.Errorf("enabled = %v, want %v", body["enabled"], want)
		}
	}
}

func TestUserCallsReportARefusedPut(t *testing.T) {
	s := newStubUsers(t, "semiont", nil)
	s.status["/admin/realms/semiont/users/abc-123"] = http.StatusUnauthorized
	if err := setUserEnabled(s.srv.URL, "semiont", "admin-token", "abc-123", false); err == nil {
		t.Fatal("a 401 PUT was reported as success")
	}
	_ = fmt.Sprint(s.requests)
}

// The flag decision tree `semiont useradd` applies through the admin client,
// against a stub realm. What an operator gets wrong is which flag they needed,
// so each refusal is pinned by the message it gives rather than by its exit
// code alone.

func applyAgainst(t *testing.T, s *stubUsers, o useraddOpts, password string) int {
	t.Helper()
	_, code := applyUseradd(NewUI(false), realmAdmin{base: s.srv.URL, realm: "semiont", token: "admin-token", domain: "kb.example", subjectClaim: "sub"}, o, password)
	return code
}

// The account block names the identity the person will act under — the DID the
// gateway builds from the claim identity.subjectClaim names — rather than the
// realm's bare account id, which nothing else in Semiont shows.
func TestUseraddNamesTheIdentityItCreated(t *testing.T) {
	for _, c := range []struct{ claim, want string }{
		{"sub", "did:web:kb.example:users:new-user-uuid"},
		{"email", "did:web:kb.example:users:sam%40x.co"},
		{"preferred_username", "did:web:kb.example:users:sam%40x.co"},
	} {
		s := newStubUsers(t, "semiont", []map[string]any{})
		result, code := applyUseradd(NewUI(false), realmAdmin{base: s.srv.URL, realm: "semiont", token: "admin-token", domain: "kb.example", subjectClaim: c.claim}, useraddOpts{email: "sam@x.co"}, "hunter2hunter2")
		if code != 0 || !result.created {
			t.Fatalf("%s: create: exit %d, created %v", c.claim, code, result.created)
		}
		if result.identity != c.want {
			t.Errorf("%s: identity is %q, want %q", c.claim, result.identity, c.want)
		}
	}
}

// What the person does next: sign in, at the Browser this machine serves
// where its record says it is, or from a terminal against the same stack. The
// terminal command names the stack the way the person selected it.
func TestUseraddNextStepsNameTheSelectedStack(t *testing.T) {
	browser := &ServiceState{Endpoint: "http://localhost:3001"}
	local := strings.Join(useraddNextSteps(nil, &StackState{Runtime: "docker"}, browser), "\n")
	for _, want := range []string{"Next: sign in at http://localhost:3001 with this email and password.", "first and last name", "semiont login --runtime docker"} {
		if !strings.Contains(local, want) {
			t.Errorf("local next steps missing %q:\n%s", want, local)
		}
	}
	if none := strings.Join(useraddNextSteps(nil, &StackState{Runtime: "docker"}, nil), "\n"); !strings.Contains(none, "semiont start --service browser") || strings.Contains(none, "localhost") {
		t.Errorf("with no Browser recorded, the next steps must start one rather than name an address:\n%s", none)
	}
	cs := &StackState{Codespace: &codespacePlacement{Repo: "owner/kb"}}
	remote := strings.Join(useraddNextSteps(cs, nil, browser), "\n")
	if !strings.Contains(remote, "semiont login --repo owner/kb") || strings.Contains(remote, "--runtime") {
		t.Errorf("codespace next steps must name --repo owner/kb:\n%s", remote)
	}
}

func TestUseraddCreatesWhenTheRealmHoldsNothing(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co"}, "hunter2hunter2"); code != 0 {
		t.Fatalf("create: exit %d", code)
	}
	if s.posted == nil {
		t.Fatal("no account was created")
	}
	if s.posted["enabled"] != true {
		t.Error("a create with neither --active nor --inactive must be enabled")
	}
}

func TestUseraddInactiveCreatesDisabled(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co", inactive: true}, "hunter2hunter2"); code != 0 {
		t.Fatalf("create --inactive: exit %d", code)
	}
	if s.posted["enabled"] != false {
		t.Error("--inactive did not reach the create")
	}
}

// --generate-password: the launcher that administers the realm makes the
// password, sets it, and shows it once. A flag parsed and never read would
// refuse every such call with "Password required".
func TestUseraddGeneratesAPasswordForACreate(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{})
	result, code := applyUseradd(NewUI(false), realmAdmin{base: s.srv.URL, realm: "semiont", token: "admin-token", domain: "kb.example", subjectClaim: "sub"}, useraddOpts{email: "sam@x.co", generate: true}, "")
	out := harness.CaptureStdout(t, func() { printUseraddResult(NewUI(false), result, useraddOpts{email: "sam@x.co", generate: true}) })
	if code != 0 {
		t.Fatalf("create --generate-password: exit %d\n%s", code, out)
	}
	creds, _ := s.posted["credentials"].([]any)
	if len(creds) != 1 {
		t.Fatalf("credentials = %v, want the generated password", s.posted["credentials"])
	}
	pw, _ := creds[0].(map[string]any)["value"].(string)
	if len(pw) != 16 {
		t.Fatalf("generated password %q: want 16 characters", pw)
	}
	if n := strings.Count(out, pw); n != 1 {
		t.Errorf("the generated password is shown %d times, want exactly once:\n%s", n, out)
	}
}

func TestUseraddGeneratesAPasswordForAnUpdate(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{{"id": "abc-123", "email": "sam@x.co"}})
	o := useraddOpts{email: "sam@x.co", update: true, generate: true}
	result, code := applyUseradd(NewUI(false), realmAdmin{base: s.srv.URL, realm: "semiont", token: "admin-token", domain: "kb.example", subjectClaim: "sub"}, o, "")
	out := harness.CaptureStdout(t, func() { printUseraddResult(NewUI(false), result, o) })
	if code != 0 {
		t.Fatalf("update --generate-password: exit %d\n%s", code, out)
	}
	body, _ := s.puts["/admin/realms/semiont/users/abc-123/reset-password"].(map[string]any)
	pw, _ := body["value"].(string)
	if len(pw) != 16 {
		t.Fatalf("reset-password body %v: want a generated 16-character value", body)
	}
	if n := strings.Count(out, pw); n != 1 {
		t.Errorf("the generated password is shown %d times, want exactly once:\n%s", n, out)
	}
}

func TestUseraddRefusesToCreateWithoutAPassword(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co"}, ""); code != 1 {
		t.Fatalf("a create with no password should refuse, got %d", code)
	}
	if s.posted != nil {
		t.Error("an account was created with no password")
	}
}

func TestUseraddUpsertIsSilentWhenTheAccountExists(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{{"id": "abc-123", "email": "sam@x.co"}})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co", upsert: true}, ""); code != 0 {
		t.Fatalf("upsert over an existing account should succeed, got %d", code)
	}
	if len(s.puts) != 0 || s.posted != nil {
		t.Error("upsert modified an account it was told to leave alone")
	}
}

func TestUseraddRefusesAnUnflaggedCollision(t *testing.T) {
	// Without --update or --upsert, an existing account is an error: the
	// alternative is silently rewriting someone's password.
	s := newStubUsers(t, "semiont", []map[string]any{{"id": "abc-123", "email": "sam@x.co"}})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co"}, "newpassword1"); code != 1 {
		t.Fatalf("a collision should refuse, got %d", code)
	}
	if len(s.puts) != 0 {
		t.Error("a refused collision still wrote to the account")
	}
}

func TestUseraddUpdateRefusesAnAbsentAccount(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co", update: true}, "newpassword1"); code != 1 {
		t.Fatalf("--update on an absent account should refuse, got %d", code)
	}
	if s.posted != nil {
		t.Error("--update created an account instead of refusing")
	}
}

func TestUseraddUpdateTouchesOnlyWhatTheFlagsName(t *testing.T) {
	// No --active/--inactive means the account's sign-in state is not this
	// command's business: an operator changing a password must not silently
	// re-enable someone who was disabled.
	s := newStubUsers(t, "semiont", []map[string]any{{"id": "abc-123", "email": "sam@x.co", "enabled": false}})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co", update: true}, "newpassword1"); code != 0 {
		t.Fatalf("update: exit %d", code)
	}
	if _, wrote := s.puts["/admin/realms/semiont/users/abc-123/reset-password"]; !wrote {
		t.Error("the password was not set")
	}
	if _, wrote := s.puts["/admin/realms/semiont/users/abc-123"]; wrote {
		t.Error("an update with no --active/--inactive changed the account's enabled state")
	}
}

func TestUseraddActiveRestoresADisabledAccount(t *testing.T) {
	s := newStubUsers(t, "semiont", []map[string]any{{"id": "abc-123", "email": "sam@x.co", "enabled": false}})
	if code := applyAgainst(t, s, useraddOpts{email: "sam@x.co", update: true, active: true}, ""); code != 0 {
		t.Fatalf("update --active: exit %d", code)
	}
	body, _ := s.puts["/admin/realms/semiont/users/abc-123"].(map[string]any)
	if body == nil || body["enabled"] != true {
		t.Errorf("--active did not enable the account: %v", body)
	}
	if _, wrote := s.puts["/admin/realms/semiont/users/abc-123/reset-password"]; wrote {
		t.Error("an update with no password reset one anyway")
	}
}

func TestPrintUseraddResultStatesChangesAndUpsert(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result useraddResult
		opts   useraddOpts
		want   []string
		omit   []string
	}{
		{
			name:   "updated and enabled",
			result: useraddResult{email: "person@example.org", created: false, identity: "did:web:example.org:users:1"},
			opts:   useraddOpts{email: "person@example.org", active: true},
			want:   []string{"User updated: person@example.org", "Identity: did:web:example.org:users:1", "Enabled at the identity provider"},
			omit:   []string{"Password:"},
		},
		{
			name:   "created disabled without identity",
			result: useraddResult{email: "person@example.org", created: true},
			opts:   useraddOpts{email: "person@example.org", inactive: true},
			want:   []string{"User created: person@example.org", "Disabled at the identity provider"},
			omit:   []string{"Identity:", "Password:"},
		},
		{
			name:   "upsert reports existing account only",
			result: useraddResult{email: "person@example.org", created: false, identity: "ignored"},
			opts:   useraddOpts{email: "person@example.org", upsert: true},
			want:   []string{"User already exists: person@example.org"},
			omit:   []string{"Identity:", "User updated"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := harness.CaptureStdout(t, func() { printUseraddResult(NewUI(false), tc.result, tc.opts) })
			for _, text := range tc.want {
				if !strings.Contains(out, text) {
					t.Errorf("output missing %q:\n%s", text, out)
				}
			}
			for _, text := range tc.omit {
				if strings.Contains(out, text) {
					t.Errorf("output contains %q:\n%s", text, out)
				}
			}
		})
	}
}
