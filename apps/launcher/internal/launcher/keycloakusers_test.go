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

// The realm's ACCOUNT surface (WHO-RUNS-USERADD P2). `identitysync.go` already
// reconciles clients, mappers and realm settings; these four calls are the rest
// of what `semiont useradd` needs, so the launcher administers the realm
// through one client instead of exec-ing a second one written in TypeScript.
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

// The flag decision tree (WHO-RUNS-USERADD P3), against a stub realm. What an
// operator gets wrong is which flag they needed, so each refusal is pinned by
// the message it gives rather than by its exit code alone.

func applyAgainst(t *testing.T, s *stubUsers, o useraddOpts, password string) int {
	t.Helper()
	return applyUseradd(newUI(false), realmAdmin{base: s.srv.URL, realm: "semiont", token: "admin-token"}, o, password)
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
