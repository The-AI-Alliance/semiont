package launcher

// The sign-in store (specs/src/sign-in-store): tokens.json is written by this
// launcher and by an application on the Rust SDK, so every change is a read, a
// change and a write under tokens.lock, and nothing a writer did not touch is
// lost.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// signInFor: a whole sign-in whose tokens name which write it was.
func signInFor(n int) SignIn {
	return SignIn{
		Token: fmt.Sprintf("access-%d", n), RefreshToken: fmt.Sprintf("refresh-%d", n),
		Email: "a@example.com", Issuer: "http://issuer.example/realms/semiont",
		TokenEndpoint: "http://issuer.example/token",
	}
}

// Two writers, each renewing its own stack a hundred times, both end holding
// their last tokens. Without the lock each would write the document it had
// read, and one stack's tokens would be lost under the other's.
func TestTwoWritersOfTheSignInStoreLoseNothingOfEachOthers(t *testing.T) {
	harness.Home(t)
	const writes = 100
	keys := []string{"local", "codespace:owner/name"}
	var wg sync.WaitGroup
	for _, key := range keys {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 1; n <= writes; n++ {
				if err := SaveToken(key, signInFor(n)); err != nil {
					t.Errorf("%s, write %d: %v", key, n, err)
					return
				}
			}
		}()
	}
	wg.Wait()
	kept := LoadTokens()
	for _, key := range keys {
		if got, want := kept[key].RefreshToken, signInFor(writes).RefreshToken; got != want {
			t.Errorf("%s holds refresh token %q, want its last, %q", key, got, want)
		}
	}
}

// A member that is not a sign-in, written by a later release, is written back
// as it was: its keys in their order and its numbers as they were spelled,
// which a writer that decoded and re-encoded it would not keep.
func TestSavingASignInKeepsAMemberThatIsNotOne(t *testing.T) {
	harness.Home(t)
	const later = `{"z":1.0,"of":"something <else> & more","a":[1e3,null]}`
	if err := os.MkdirAll(StateDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokensPath(), []byte(`{"a-later-release": `+later+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveToken("local", signInFor(1)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(tokensPath())
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("the document no longer parses: %v\n%s", err, b)
	}
	var kept bytes.Buffer
	if err := json.Compact(&kept, doc["a-later-release"]); err != nil {
		t.Fatalf("the later release's member is gone or broken: %v\n%s", err, b)
	}
	if kept.String() != later {
		t.Errorf("the later release's member was rewritten:\n got %s\nwant %s", kept.String(), later)
	}
	if LoadTokens()["local"].Token != "access-1" {
		t.Errorf("the sign-in was not written beside it:\n%s", b)
	}
	if _, listed := LoadTokens()["a-later-release"]; listed {
		t.Error("a member that is not a sign-in was reported as one")
	}

	// Signing out of one stack keeps it too.
	if err := deleteToken("local"); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(tokensPath())
	doc = nil
	if err := json.Unmarshal(b, &doc); err != nil || doc["a-later-release"] == nil || doc["local"] != nil {
		t.Errorf("after the sign-out the document is (%v):\n%s", err, b)
	}
}

// A file that cannot be read as the document is never written over: the
// sign-ins it may hold are not this writer's to discard.
func TestSavingASignInRefusesAFileItCannotRead(t *testing.T) {
	for name, content := range map[string]string{
		"not JSON":      `{"local": {"token": "half a docu`,
		"not an object": `["local"]`,
		"null":          `null`,
		"empty":         ``,
	} {
		t.Run(name, func(t *testing.T) {
			harness.Home(t)
			if err := os.MkdirAll(StateDir(), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(tokensPath(), []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := SaveToken("local", signInFor(1)); err == nil {
				t.Error("SaveToken wrote over a file it could not read")
			}
			if err := deleteToken("local"); err == nil {
				t.Error("deleteToken wrote over a file it could not read")
			}
			if b, _ := os.ReadFile(tokensPath()); string(b) != content {
				t.Errorf("the file was changed:\n got %q\nwant %q", b, content)
			}
			if _, err := os.Stat(tokensPath() + ".tmp"); err == nil {
				t.Error("a temporary file was left beside it")
			}
		})
	}
}

// The file holds bearer credentials: kept to its owner, and no stray
// temporary file.
func TestTheSignInStoreIsWrittenPrivately(t *testing.T) {
	harness.Home(t)
	if err := SaveToken("local", signInFor(1)); err != nil {
		t.Fatal(err)
	}
	if open := harness.OpenToOthers(t, tokensPath()); open != "" {
		t.Errorf("tokens.json %s", open)
	}
	entries, _ := os.ReadDir(filepath.Dir(tokensPath()))
	for _, e := range entries {
		if e.Name() != "tokens.json" && e.Name() != "tokens.lock" {
			t.Errorf("an unexpected file beside the store: %s", e.Name())
		}
	}
}

// renewingIssuer: a token endpoint that answers a refresh grant with a rotated
// pair (access-2, refresh-2), after `meanwhile` has run: what another program
// did to the store while the grant was in flight. It counts the grants.
func renewingIssuer(t *testing.T, meanwhile func()) (endpoint string, grants *int) {
	t.Helper()
	grants = new(int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*grants++
		if meanwhile != nil {
			meanwhile()
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"access_token":"access-2","refresh_token":"refresh-2","token_type":"Bearer","expires_in":300}`)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, grants
}

// sessionAt: the store holding sign-in 1 for the local stack, renewable at the
// endpoint, and the session a verb loaded from it.
func sessionAt(t *testing.T, endpoint string) *Session {
	t.Helper()
	e := signInFor(1)
	e.TokenEndpoint = endpoint
	if err := SaveToken("local", e); err != nil {
		t.Fatal(err)
	}
	s, ok := LoadSession(NewUI(true), "local")
	if !ok {
		t.Fatal("no session was loaded")
	}
	return s
}

// A renewal reads the store again under the lock before it writes. Another
// program that renewed the stack while this one's grant was in flight keeps
// its tokens, and this command goes on with them.
func TestARenewalLeavesWhatAnotherProgramRenewedMeanwhile(t *testing.T) {
	harness.Home(t)
	endpoint, _ := renewingIssuer(t, func() {
		if err := SaveToken("local", signInFor(9)); err != nil {
			t.Error(err)
		}
	})
	s := sessionAt(t, endpoint)
	if err := s.refresh(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if got := LoadTokens()["local"].RefreshToken; got != "refresh-9" {
		t.Errorf("the store holds %q, want the other program's refresh-9", got)
	}
	if s.entry.Token != "access-9" {
		t.Errorf("the command goes on with %q, want the other program's access-9", s.entry.Token)
	}
}

// A stack signed out while its session was being renewed stays signed out:
// the renewed tokens are not written back, and the renewal says so.
func TestARenewalDoesNotSignBackInAStackThatWasSignedOut(t *testing.T) {
	harness.Home(t)
	endpoint, _ := renewingIssuer(t, func() {
		if err := deleteToken("local"); err != nil {
			t.Error(err)
		}
	})
	s := sessionAt(t, endpoint)
	if err := s.refresh(); err == nil {
		t.Error("the renewal of a signed-out stack reported success")
	}
	if e, kept := LoadTokens()["local"]; kept {
		t.Errorf("the signed-out stack was signed back in with %q", e.Token)
	}
}

// What another program already renewed is used as it is: the refresh token
// this command read is not the current one, and spending it at an issuer that
// rotates would be refused.
func TestARenewalSpendsNoRefreshTokenAnotherProgramReplaced(t *testing.T) {
	harness.Home(t)
	endpoint, grants := renewingIssuer(t, nil)
	s := sessionAt(t, endpoint)
	theirs := signInFor(9)
	theirs.TokenEndpoint = endpoint
	if err := SaveToken("local", theirs); err != nil {
		t.Fatal(err)
	}
	if err := s.refresh(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if *grants != 0 {
		t.Errorf("%d refresh grants were made with a refresh token already replaced", *grants)
	}
	if s.entry.Token != "access-9" {
		t.Errorf("the command goes on with %q, want the other program's access-9", s.entry.Token)
	}
}

// With nothing else writing, a renewal keeps what the issuer rotated.
func TestARenewalKeepsWhatTheIssuerRotated(t *testing.T) {
	harness.Home(t)
	endpoint, grants := renewingIssuer(t, nil)
	s := sessionAt(t, endpoint)
	if err := s.refresh(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	e := LoadTokens()["local"]
	if *grants != 1 || e.Token != "access-2" || e.RefreshToken != "refresh-2" {
		t.Errorf("after %d grants the store holds %q and %q, want access-2 and refresh-2", *grants, e.Token, e.RefreshToken)
	}
	if e.Email != "a@example.com" || e.Issuer == "" {
		t.Errorf("the renewal lost who signed in or where: %q at %q", e.Email, e.Issuer)
	}
}

// The state home is where the contract says it is on every system: each row of
// specs/src/sign-in-store/cases.json, which the Rust SDK runs too, so the two
// programs look for tokens.json in one place.
func TestTheStateHomeIsWhereTheContractSays(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "sign-in-store", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why          string  `json:"why"`
			OS           string  `json:"os"`
			Home         *string `json:"home"`
			XDGStateHome *string `json:"xdgStateHome"`
			LocalAppData *string `json:"localAppData"`
			Dir          *string `json:"dir"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the contract states no cases: this test would pass for the wrong reason")
	}
	// null in the table: not set, which is what "" is to the launcher.
	set := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	for _, c := range table.Cases {
		if got, want := stateDirFor(c.OS, set(c.Home), set(c.XDGStateHome), set(c.LocalAppData)), set(c.Dir); got != want {
			t.Errorf("%s: the state home is %q, want %q", c.Why, got, want)
		}
	}
}
