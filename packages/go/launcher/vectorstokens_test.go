package launcher

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// The tokens the launcher mints are the ones every case of
// protocol/specs/src/vectors/token-cases.json states: a JWT signed by HS256
// with the Qdrant's key, whose claims are the case's and no others.
func TestVectorsTokensAreMintedAsTheTableStates(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "specs", "src", "vectors", "token-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why    string `json:"why"`
			KB     string `json:"kb"`
			Claims struct {
				Smelter   json.RawMessage `json:"smelter"`
				Librarian json.RawMessage `json:"librarian"`
			} `json:"claims"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table states no case")
	}
	const key = "the-qdrants-key"
	for _, c := range table.Cases {
		t.Run(c.Why, func(t *testing.T) {
			smelter, err := vectorsToken(key, "smelter", c.KB)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := decodeStrictly[smelterVectorsClaims](t, signedClaims(t, key, smelter)), decodeStrictly[smelterVectorsClaims](t, c.Claims.Smelter); got != want {
				t.Errorf("the Smelter's token for %s claims %+v, want %+v", c.KB, got, want)
			}
			librarian, err := vectorsToken(key, "librarian", c.KB)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := decodeStrictly[librarianVectorsClaims](t, signedClaims(t, key, librarian)), decodeStrictly[librarianVectorsClaims](t, c.Claims.Librarian); !slices.Equal(got.Access, want.Access) {
				t.Errorf("the Librarian's token for %s claims %+v, want %+v", c.KB, got, want)
			}
		})
	}
}

// signedClaims: the claims of token, which must be a JWT whose header says
// HS256 and whose signature is key's.
func signedClaims(t *testing.T, key, token string) []byte {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("%q is no JWT", token)
	}
	dec := base64.RawURLEncoding.DecodeString
	header, err := dec(parts[0])
	if err != nil || string(header) != `{"alg":"HS256","typ":"JWT"}` {
		t.Fatalf("the token's header is %q (%v)", header, err)
	}
	signature, err := dec(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		t.Fatal("the token is not signed with the key")
	}
	claims, err := dec(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	return claims
}

// decodeStrictly decodes b as a T, failing on a member T does not name.
func decodeStrictly[T any](t *testing.T, b []byte) T {
	t.Helper()
	var v T
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&v); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	return v
}

// No token is minted for a service that presents none, nor a Librarian's for a
// knowledge base with no DID, whose collections it would name; and a start
// that plans no vector index hands nobody a token to one.
func TestVectorsTokensAreRefusedWhatNamesNoCollections(t *testing.T) {
	if _, err := vectorsToken("the-key", "librarian", ""); err == nil {
		t.Error("a Librarian's token was minted for a knowledge base with no DID")
	}
	if _, err := vectorsToken("the-key", "weaver", "did:web:example.github.io:plain-kb"); err == nil {
		t.Error("a token was minted for the weaver, which presents none")
	}
	unplanned := flowCtx{kb: kbRoot{dir: t.TempDir(), ident: &kbIdentity{}}, plan: &launchPlan{Roles: map[string]rolePlan{}}}
	if env, err := vectorsTokenEnv(unplanned, "smelter"); err == nil {
		t.Errorf("a start that plans no vector index handed the Smelter %q", env)
	}
}

// A start hands the Smelter and the Librarian the tokens it mints from the
// key it loaded, each its own, for a Qdrant the launcher runs; for somebody
// else's it mints none, and a start that loaded no key mints nothing.
func TestAStartHandsEachServiceItsOwnToken(t *testing.T) {
	did, err := semiont.KbDid("example.github.io:plain-kb")
	if err != nil {
		t.Fatal(err)
	}
	ident := &kbIdentity{did: did}
	kb := kbRoot{dir: t.TempDir(), ident: ident}
	keyed := []string{"--env", daemonCredentials["vectors"].env + "=the-key"}
	for _, presence := range []presence{presenceShared, presenceLauncher} {
		fc := flowCtx{kb: kb, userEnv: keyed, plan: &launchPlan{Roles: map[string]rolePlan{"vectors": {Role: "vectors", Presence: presence}}}}
		for _, svc := range []string{"smelter", "librarian"} {
			env, err := vectorsTokenEnv(fc, svc)
			if err != nil {
				t.Fatalf("%s, %s: %v", presence, svc, err)
			}
			want, _ := vectorsToken("the-key", svc, ident.didWeb())
			if len(env) != 2 || env[0] != "--env" || env[1] != vectorsTokenVar+"="+want {
				t.Errorf("%s: the %s is handed %q, want its own token in %s", presence, svc, env, vectorsTokenVar)
			}
		}
		fc.userEnv = nil
		if _, err := vectorsTokenEnv(fc, "smelter"); err == nil {
			t.Errorf("%s: a start that loaded no key minted a token", presence)
		}
	}
	external := flowCtx{kb: kb, plan: &launchPlan{Roles: map[string]rolePlan{"vectors": {Role: "vectors", Presence: presenceExternal}}}}
	if env, err := vectorsTokenEnv(external, "smelter"); err != nil || env != nil {
		t.Errorf("somebody else's Qdrant: the Smelter is handed %q (%v), want nothing minted", env, err)
	}
}
