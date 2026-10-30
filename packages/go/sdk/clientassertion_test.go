package semiont

// A service account's assertion of itself, held to
// specs/src/session/client-assertion-cases.json: the thumbprint a key is
// named by, and the header and claims an assertion carries. The signature over
// them, and the form a grant posts, are held in keycredential_test.go, where a
// grant's assertion is checked with the key's public half as an issuer checks
// it.

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type assertionJWK struct {
	Kty string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type assertionTable struct {
	Form            []string `json:"form"`
	GrantType       string   `json:"grantType"`
	AssertionType   string   `json:"assertionType"`
	LifetimeSeconds int64    `json:"lifetimeSeconds"`
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
	if len(table.Cases) == 0 || len(table.Thumbprints) == 0 || len(table.Form) == 0 {
		t.Fatal("session/client-assertion-cases.json states no case")
	}
	return table
}

func publicKeyOf(t *testing.T, why string, jwk assertionJWK) *rsa.PublicKey {
	t.Helper()
	if jwk.Kty != "RSA" {
		t.Fatalf("%s: its key is not RSA", why)
	}
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

// asJSON is a value as the table's JSON would decode it, so numbers compare as
// numbers and members by name.
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
		if got := JWKThumbprint(publicKeyOf(t, c.Why, c.JWK)); got != c.Thumbprint {
			t.Errorf("%s: thumbprint %s, want %s", c.Why, got, c.Thumbprint)
		}
	}
}

func TestAnAssertionCarriesTheHeaderAndClaimsTheTableStates(t *testing.T) {
	for _, c := range readAssertionTable(t).Cases {
		if got := asJSON(t, assertionHeaderOf(publicKeyOf(t, c.Why, c.JWK))); !reflect.DeepEqual(got, c.Header) {
			t.Errorf("%s: header %v, want %v", c.Why, got, c.Header)
		}
		if got := asJSON(t, assertionClaimsOf(c.ClientID, c.TokenEndpoint, c.IssuedAt, c.JTI)); !reflect.DeepEqual(got, c.Claims) {
			t.Errorf("%s: claims %v, want %v", c.Why, got, c.Claims)
		}
	}
}

// The form a grant posts is held where a grant is made, in
// keycredential_test.go.
func TestAnAssertionIsOfTheTablesTypeAndLivesAsLongAsItSays(t *testing.T) {
	table := readAssertionTable(t)
	if table.AssertionType != JWTBearer {
		t.Errorf("the table's assertion type is %q, the SDK's %q", table.AssertionType, JWTBearer)
	}
	if table.LifetimeSeconds != AssertionLifetimeSeconds {
		t.Errorf("the table's assertion lives %d seconds, the SDK's %d", table.LifetimeSeconds, AssertionLifetimeSeconds)
	}
}
