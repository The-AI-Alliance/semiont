package launcher

// The preflight's assertion, held to specs/src/session/client-assertion-cases.json:
// the thumbprint a key is named by, the header and claims an assertion carries,
// and a signature the key's public half verifies, as an issuer checks it.

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type assertionJWK struct {
	Kty string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type assertionTable struct {
	AssertionType   string `json:"assertionType"`
	LifetimeSeconds int64  `json:"lifetimeSeconds"`
	Thumbprints     []struct {
		Why        string       `json:"why"`
		JWK        assertionJWK `json:"jwk"`
		Thumbprint string       `json:"thumbprint"`
	} `json:"thumbprints"`
	Cases []struct {
		Why           string         `json:"why"`
		JWK           assertionJWK   `json:"jwk"`
		ClientID      string         `json:"clientId"`
		TokenEndpoint string         `json:"tokenEndpoint"`
		IssuedAt      int64          `json:"issuedAt"`
		JTI           string         `json:"jti"`
		Header        map[string]any `json:"header"`
		Claims        map[string]any `json:"claims"`
	} `json:"cases"`
}

func readAssertionTable(t *testing.T) assertionTable {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "session", "client-assertion-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table assertionTable
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 || len(table.Thumbprints) == 0 {
		t.Fatal("session/client-assertion-cases.json states no case")
	}
	return table
}

func publicKeyOf(t *testing.T, jwk assertionJWK) *rsa.PublicKey {
	t.Helper()
	n, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		t.Fatal(err)
	}
	e, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		t.Fatal(err)
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
}

// asJSON: a value as the table's JSON would decode it, so numbers compare as numbers.
func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAKeyIsNamedByItsThumbprint(t *testing.T) {
	for _, c := range readAssertionTable(t).Thumbprints {
		if got := jwkThumbprint(publicKeyOf(t, c.JWK)); got != c.Thumbprint {
			t.Errorf("%s: thumbprint %s, want %s", c.Why, got, c.Thumbprint)
		}
	}
}

func TestAnAssertionCarriesTheHeaderAndClaimsTheTableStates(t *testing.T) {
	table := readAssertionTable(t)
	if table.AssertionType != jwtBearer || table.LifetimeSeconds != assertionLifetimeSeconds {
		t.Fatalf("the table's type and lifetime are %q and %d, the launcher's %q and %d",
			table.AssertionType, table.LifetimeSeconds, jwtBearer, assertionLifetimeSeconds)
	}
	for _, c := range table.Cases {
		if got := asJSON(t, assertionHeader(publicKeyOf(t, c.JWK))); !reflect.DeepEqual(got, c.Header) {
			t.Errorf("%s: header %v, want %v", c.Why, got, c.Header)
		}
		if got := asJSON(t, assertionClaims(c.ClientID, c.TokenEndpoint, c.IssuedAt, c.JTI)); !reflect.DeepEqual(got, c.Claims) {
			t.Errorf("%s: claims %v, want %v", c.Why, got, c.Claims)
		}
	}
}

func TestAnAssertionIsSignedSoTheKeysPublicHalfVerifiesIt(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := clientAssertion(key, "semiont-worker-local", "http://issuer.example/token", 1798761600, "a-jti")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(signed, ".")
	if len(parts) != 3 {
		t.Fatalf("an assertion of %d parts", len(parts))
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature); err != nil {
		t.Fatalf("the key's public half does not verify the assertion: %v", err)
	}
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if rsa.VerifyPKCS1v15(&other.PublicKey, crypto.SHA256, digest[:], signature) == nil {
		t.Fatal("another key's public half verifies the assertion")
	}
}
