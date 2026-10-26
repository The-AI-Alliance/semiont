package semiont

// The sign-in store (specs/src/sign-in-store): tokens.json is written by the
// launcher and by applications on every SDK, so every change is a read, a
// change and a write under tokens.lock, and nothing a writer did not touch is
// lost.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"testing"
	"time"
)

func storeIn(t *testing.T) *SignInStore {
	t.Helper()
	return NewSignInStore(filepath.Join(t.TempDir(), "semiont", SignInFile))
}

// signedToken is an access token naming who signed in and where, told apart
// by n.
func signedToken(n int) string {
	claims, _ := json.Marshal(map[string]any{
		"email": "a@example.com", "iss": "http://issuer.example/realms/semiont",
		"exp": time.Now().Add(time.Hour).Unix(), "n": n,
	})
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".c2lnbmF0dXJl"
}

func heldFor(n int) HeldSignIn {
	return HeldSignIn{Access: signedToken(n), Refresh: fmt.Sprintf("refresh-%d", n), ClientID: ScriptClientID, TokenEndpoint: "http://issuer.example/token"}
}

// Two writers, each renewing its own stack a hundred times, both end holding
// their last tokens. Without the lock each would write the document it had
// read, and one stack's tokens would be lost under the other's.
func TestTwoWritersOfTheSignInStoreLoseNothingOfEachOthers(t *testing.T) {
	const writes = 100
	path := filepath.Join(t.TempDir(), "semiont", SignInFile)
	keys := []string{"local", "codespace:owner/name"}
	var wg sync.WaitGroup
	for _, key := range keys {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// A store each: two programs, as far as the lock can tell.
			entry := NewSignInStore(path).Entry(key)
			for n := 1; n <= writes; n++ {
				if err := entry.Keep(context.Background(), heldFor(n)); err != nil {
					t.Errorf("%s, write %d: %v", key, n, err)
					return
				}
			}
		}()
	}
	wg.Wait()
	kept, err := NewSignInStore(path).SignIns()
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range keys {
		if got, want := kept[key].RefreshToken, heldFor(writes).Refresh; got != want {
			t.Errorf("%s holds refresh token %q, want its last, %q", key, got, want)
		}
	}
}

// A member that is not a sign-in, written by a later release, is written back
// as it was: its keys in their order and its numbers as they were spelled,
// which a writer that decoded and re-encoded it would not keep.
func TestKeepingASignInKeepsAMemberThatIsNotOne(t *testing.T) {
	store := storeIn(t)
	const later = `{"z":1.0,"of":"something <else> & more","a":[1e3,null]}`
	if err := os.MkdirAll(filepath.Dir(store.Path()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.Path(), []byte(`{"a-later-release": `+later+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Entry("local").Keep(context.Background(), heldFor(1)); err != nil {
		t.Fatal(err)
	}
	laterIsKept := func() {
		t.Helper()
		b, err := os.ReadFile(store.Path())
		if err != nil {
			t.Fatal(err)
		}
		var document map[string]json.RawMessage
		if err := json.Unmarshal(b, &document); err != nil {
			t.Fatalf("the document no longer parses: %v\n%s", err, b)
		}
		var kept bytes.Buffer
		if err := json.Compact(&kept, document["a-later-release"]); err != nil {
			t.Fatalf("the later release's member is gone or broken: %v\n%s", err, b)
		}
		if kept.String() != later {
			t.Errorf("the later release's member was rewritten:\n got %s\nwant %s", kept.String(), later)
		}
	}
	laterIsKept()
	signIns, err := store.SignIns()
	if err != nil {
		t.Fatal(err)
	}
	if signIns["local"].RefreshToken != "refresh-1" {
		t.Error("the sign-in was not written beside it")
	}
	if _, listed := signIns["a-later-release"]; listed {
		t.Error("a member that is not a sign-in was reported as one")
	}
	// Signing out of one stack keeps it too.
	if err := store.Entry("local").Forget(context.Background()); err != nil {
		t.Fatal(err)
	}
	laterIsKept()
	if _, kept, _ := store.SignIn("local"); kept {
		t.Error("the stack is still signed in")
	}
}

// A file that cannot be read as the document is never written over: the
// sign-ins it may hold are not this writer's to discard.
func TestKeepingASignInRefusesAFileItCannotRead(t *testing.T) {
	for name, content := range map[string]string{
		"not JSON":      `{"local": {"token": "half a docu`,
		"not an object": `["local"]`,
		"null":          `null`,
		"empty":         ``,
	} {
		t.Run(name, func(t *testing.T) {
			store := storeIn(t)
			if err := os.MkdirAll(filepath.Dir(store.Path()), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(store.Path(), []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			entry := store.Entry("local")
			if err := entry.Keep(context.Background(), heldFor(1)); err == nil {
				t.Error("Keep wrote over a file it could not read")
			}
			if err := entry.Forget(context.Background()); err == nil {
				t.Error("Forget wrote over a file it could not read")
			}
			if b, _ := os.ReadFile(store.Path()); string(b) != content {
				t.Errorf("the file was changed:\n got %q\nwant %q", b, content)
			}
			if _, err := os.Stat(store.Path() + ".tmp"); !errors.Is(err, fs.ErrNotExist) {
				t.Error("a temporary file was left beside it")
			}
		})
	}
}

// The file holds bearer credentials: its owner's alone, and no stray
// temporary file beside it.
func TestTheSignInStoreIsWrittenPrivately(t *testing.T) {
	store := storeIn(t)
	if err := store.Entry("local").Keep(context.Background(), heldFor(1)); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(store.Path())
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode&0o077 != 0 {
			t.Errorf("tokens.json is open to others: %v", mode)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(store.Path()))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != SignInFile && e.Name() != signInLock {
			t.Errorf("an unexpected file beside the store: %s", e.Name())
		}
	}
}

// What a sign-in is kept as: who signed in and where, from the token, and
// when it expires.
func TestASignInIsKeptAsItsTokenNamesIt(t *testing.T) {
	store := storeIn(t)
	held := heldFor(1)
	held.RevocationEndpoint = "http://issuer.example/revoke"
	if err := store.Entry("local").Keep(context.Background(), held); err != nil {
		t.Fatal(err)
	}
	signIn, ok, err := store.SignIn("local")
	if err != nil || !ok {
		t.Fatalf("nothing was kept (%v)", err)
	}
	if signIn.Email != "a@example.com" || signIn.Issuer != "http://issuer.example/realms/semiont" || signIn.RevocationEndpoint != held.RevocationEndpoint {
		t.Errorf("kept %+v", signIn)
	}
	expiry, _ := tokenExpiry(held.Access)
	if !signIn.ExpiresAt.Equal(expiry.UTC().Truncate(time.Second)) || signIn.ObtainedAt.IsZero() {
		t.Errorf("kept as obtained at %s and expiring at %s, want its token's expiry %s", signIn.ObtainedAt, signIn.ExpiresAt, expiry)
	}
	back, ok, err := store.Entry("local").Held(context.Background())
	if err != nil || !ok || back.Access != held.Access || back.Refresh != held.Refresh || back.ClientID != ScriptClientID {
		t.Errorf("held back as %+v (%v, %v)", back, ok, err)
	}
}

// A token that names nobody, or no issuer, is no sign-in: a gateway would
// admit neither.
func TestATokenThatNamesNobodyIsNotKept(t *testing.T) {
	for name, claims := range map[string]map[string]any{
		"no email":  {"iss": "http://issuer.example"},
		"no issuer": {"email": "a@example.com"},
	} {
		t.Run(name, func(t *testing.T) {
			store := storeIn(t)
			payload, _ := json.Marshal(claims)
			held := heldFor(1)
			held.Access = "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".c2ln"
			var refused *SignInError
			if err := store.Entry("local").Keep(context.Background(), held); !errors.As(err, &refused) || refused.Code != SignInErrorCodeExchange {
				t.Errorf("kept, or refused otherwise: %v", err)
			}
			if _, kept, _ := store.SignIn("local"); kept {
				t.Error("it was kept")
			}
		})
	}
}

// A renewal keeps who signed in and at which issuer as the sign-in learned
// them, whatever the renewed token names.
func TestARenewalKeepsWhoSignedInAndWhere(t *testing.T) {
	store := storeIn(t)
	entry := store.Entry("local")
	held := heldFor(1)
	if err := entry.Keep(context.Background(), held); err != nil {
		t.Fatal(err)
	}
	claims, _ := json.Marshal(map[string]any{"email": "b@elsewhere.example", "iss": "http://elsewhere.example", "exp": time.Now().Add(time.Hour).Unix()})
	renewed := "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".c2ln"
	given, kept, err := entry.Renewed(context.Background(), held, renewed, "refresh-2")
	if err != nil || !kept || given != renewed {
		t.Fatalf("renewed: %v, %v", kept, err)
	}
	signIn, _, _ := store.SignIn("local")
	if signIn.Token != renewed || signIn.RefreshToken != "refresh-2" {
		t.Errorf("the renewal kept tokens %q and %q", signIn.Token, signIn.RefreshToken)
	}
	if signIn.Email != "a@example.com" || signIn.Issuer != "http://issuer.example/realms/semiont" {
		t.Errorf("the renewal kept %s at %s, want who signed in and where", signIn.Email, signIn.Issuer)
	}
}

// tableSignIn is a sign-in as the renewals table states one: its tokens.
type tableSignIn struct {
	Token        string  `json:"token"`
	RefreshToken *string `json:"refreshToken"`
}

// renewalCase is a row of the renewals table.
type renewalCase struct {
	Why       string      `json:"why"`
	Kept      tableSignIn `json:"kept"`
	Holding   *string     `json:"holding"`
	Meanwhile *struct {
		When   string       `json:"when"`
		Does   string       `json:"does"`
		Theirs *tableSignIn `json:"theirs"`
	} `json:"meanwhile"`
	Expired []string     `json:"expired"`
	Issues  tableSignIn  `json:"issues"`
	Spends  *string      `json:"spends"`
	Leaves  *tableSignIn `json:"leaves"`
	Gives   *string      `json:"gives"`
}

// renewalCases is the renewals table of specs/src/sign-in-store/cases.json,
// every row stating every member.
func renewalCases(t *testing.T) []renewalCase {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "specs", "src", "sign-in-store", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Renewals json.RawMessage `json:"renewals"`
	}
	if err := json.Unmarshal(b, &document); err != nil {
		t.Fatal(err)
	}
	var stated []map[string]json.RawMessage
	if err := json.Unmarshal(document.Renewals, &stated); err != nil || len(stated) == 0 {
		t.Fatalf("the table has no renewals (%v)", err)
	}
	for i, row := range stated {
		for _, member := range []string{"why", "kept", "holding", "meanwhile", "expired", "issues", "spends", "leaves", "gives"} {
			if _, ok := row[member]; !ok {
				t.Fatalf("renewal %d states no %s", i, member)
			}
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(document.Renewals))
	decoder.DisallowUnknownFields()
	var cases []renewalCase
	if err := decoder.Decode(&cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// renewalStores are the stores this SDK has, as a renewal case runs over
// each: the renewer's handle on the stack's sign-in, another program's, and
// the tokens the store holds for the stack.
var renewalStores = map[string]func(t *testing.T) (renewer, another SignInKept, holds func() (access, refresh string, ok bool)){
	"SignInStore": func(t *testing.T) (SignInKept, SignInKept, func() (string, string, bool)) {
		path := filepath.Join(t.TempDir(), "semiont", SignInFile)
		return NewSignInStore(path).Entry("local"), NewSignInStore(path).Entry("local"), func() (string, string, bool) {
			signIn, ok, err := NewSignInStore(path).SignIn("local")
			if err != nil {
				t.Fatal(err)
			}
			return signIn.Token, signIn.RefreshToken, ok
		}
	},
	"MemorySignIn": func(t *testing.T) (SignInKept, SignInKept, func() (string, string, bool)) {
		kept := &MemorySignIn{}
		return kept, kept, func() (string, string, bool) {
			held, ok, _ := kept.Held(context.Background())
			return held.Access, held.Refresh, ok
		}
	},
}

// What a renewal writes and gives while other programs renew the same stack
// and sign it out: every row of the table, through Issuer.RenewKept, over each
// store.
func TestEveryRenewalIsTheTables(t *testing.T) {
	cases := renewalCases(t)
	for store, open := range renewalStores {
		for _, c := range cases {
			t.Run(store+"/"+c.Why, func(t *testing.T) {
				ctx := context.Background()
				renewer, another, holds := open(t)
				s := newStack(t)
				// Each access token the row names is a JWT of its own, the same
				// each time it is named.
				now := time.Now()
				token := func(name string) string {
					expiry := now.Add(time.Hour)
					if slices.Contains(c.Expired, name) {
						expiry = now.Add(-time.Hour)
					}
					claims, _ := json.Marshal(map[string]any{"email": "a@example.com", "iss": "http://issuer.example/realms/semiont", "exp": expiry.Unix(), "jti": name})
					return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".c2ln"
				}
				signIn := func(row tableSignIn) HeldSignIn {
					return HeldSignIn{Access: token(row.Token), Refresh: *row.RefreshToken, ClientID: ScriptClientID, TokenEndpoint: s.issuer.URL + "/token"}
				}
				if err := another.Keep(ctx, signIn(c.Kept)); err != nil {
					t.Fatal(err)
				}
				meanwhile := func() {
					var err error
					switch c.Meanwhile.Does {
					case "renews":
						err = another.Keep(ctx, signIn(*c.Meanwhile.Theirs))
					case "signs-out":
						err = another.Forget(ctx)
					default:
						err = fmt.Errorf("another program %q", c.Meanwhile.Does)
					}
					if err != nil {
						t.Error(err)
					}
				}
				var mu sync.Mutex
				var spent []string
				issued := map[string]any{"access_token": token(c.Issues.Token), "token_type": "Bearer", "expires_in": 3600}
				if c.Issues.RefreshToken != nil {
					issued["refresh_token"] = *c.Issues.RefreshToken
				}
				s.set(func() {
					s.token = func(w http.ResponseWriter, r *http.Request) {
						if err := r.ParseForm(); err != nil {
							t.Error(err)
						}
						mu.Lock()
						spent = append(spent, r.PostForm.Get("refresh_token"))
						mu.Unlock()
						if c.Meanwhile != nil && c.Meanwhile.When == "during" {
							meanwhile()
						}
						writeJSON(w, http.StatusOK, issued)
					}
				})
				if c.Meanwhile != nil {
					switch c.Meanwhile.When {
					case "before":
						meanwhile()
					case "during":
					default:
						t.Fatalf("another program acts %q", c.Meanwhile.When)
					}
				}
				holding := ""
				if c.Holding != nil {
					holding = token(*c.Holding)
				}

				given, err := issuerOf().RenewKept(ctx, renewer, holding)
				if err != nil {
					t.Fatal(err)
				}

				mu.Lock()
				defer mu.Unlock()
				switch {
				case c.Spends == nil && len(spent) > 0:
					t.Errorf("grants were made with %q, want none", spent)
				case c.Spends != nil && !slices.Equal(spent, []string{*c.Spends}):
					t.Errorf("grants were made with %q, want one with %s", spent, *c.Spends)
				}
				// A minted token's name is its jti; "" is none.
				named := func(minted string) string {
					if name, ok := textClaim(minted, "jti"); ok {
						return name
					}
					return minted
				}
				gives := ""
				if c.Gives != nil {
					gives = *c.Gives
				}
				if named(given) != gives {
					t.Errorf("gave %q, want %q", named(given), gives)
				}
				access, refresh, kept := holds()
				switch {
				case c.Leaves == nil && kept:
					t.Errorf("the store holds %s and %s, want nothing", named(access), refresh)
				case c.Leaves != nil && !kept:
					t.Errorf("the store holds nothing, want %s and %s", c.Leaves.Token, *c.Leaves.RefreshToken)
				case c.Leaves != nil && (named(access) != c.Leaves.Token || refresh != *c.Leaves.RefreshToken):
					t.Errorf("the store holds %s and %s, want %s and %s", named(access), refresh, c.Leaves.Token, *c.Leaves.RefreshToken)
				}
			})
		}
	}
}

// A waiting taker of the store's lock gets it when the holder lets go, and
// not before.
func TestAWaitingTakerGetsTheLockWhenTheHolderLetsGo(t *testing.T) {
	path := filepath.Join(t.TempDir(), signInLock)
	open := func() *os.File {
		f, err := os.OpenFile(path, os.O_RDONLY|os.O_CREATE, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	holder, waiter := open(), open()
	defer waiter.Close()
	if err := lockFile(holder); err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() { got <- lockFile(waiter) }()
	select {
	case err := <-got:
		t.Fatalf("the waiter took a held lock (%v)", err)
	case <-time.After(150 * time.Millisecond):
	}
	holder.Close()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("the waiter's take: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiter never got the lock the holder let go")
	}
}
