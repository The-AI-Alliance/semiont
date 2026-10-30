package semiont

// A service account that proves itself with a key: each grant carries an
// assertion signed for it alone, and no secret. What an issuer does with the
// assertion is done here by hand: its signature is checked with the key's
// public half, and its claims read. The shape the table states is
// clientassertion_test.go's.

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const keyClient = "semiont-worker-alice-laptop"

// keyIssuer is an issuer that answers each grant with status, and keeps the
// form each grant posted. A refusal echoes the assertion it was sent, as an
// error body can.
type keyIssuer struct {
	*httptest.Server
	status int

	mu    sync.Mutex
	forms []url.Values
}

func newKeyIssuer(t *testing.T, status int) *keyIssuer {
	t.Helper()
	i := &keyIssuer{status: status}
	i.Server = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			writeJSON(rw, http.StatusOK, map[string]any{"token_endpoint": i.URL + "/token"})
		case "/token":
			if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" || r.ParseForm() != nil {
				writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
				return
			}
			i.mu.Lock()
			i.forms = append(i.forms, r.PostForm)
			n := len(i.forms)
			i.mu.Unlock()
			if i.status != http.StatusOK {
				writeJSON(rw, i.status, map[string]any{"error": "invalid_client", "error_description": r.PostForm.Get("client_assertion")})
				return
			}
			writeJSON(rw, http.StatusOK, map[string]any{"access_token": signedToken(n), "expires_in": 300})
		default:
			http.NotFound(rw, r)
		}
	}))
	t.Cleanup(i.Close)
	return i
}

func (i *keyIssuer) posted() []url.Values {
	i.mu.Lock()
	defer i.mu.Unlock()
	return slices.Clone(i.forms)
}

var testKey = sync.OnceValue(func() *rsa.PrivateKey {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return key
})

var anotherTestKey = sync.OnceValue(func() *rsa.PrivateKey {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return key
})

// checked is the assertion's header and claims, once its signature is checked
// with key, as an issuer checks it.
func checked(assertion string, key *rsa.PublicKey) (map[string]any, map[string]any, error) {
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		return nil, nil, fmt.Errorf("an assertion of %d parts", len(parts))
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, nil, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature); err != nil {
		return nil, nil, err
	}
	var header, claims map[string]any
	for i, into := range []*map[string]any{&header, &claims} {
		b, err := base64.RawURLEncoding.DecodeString(parts[i])
		if err != nil {
			return nil, nil, err
		}
		if err := json.Unmarshal(b, into); err != nil {
			return nil, nil, err
		}
	}
	return header, claims, nil
}

func pkcs8PEM(t *testing.T, key any) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func TestEachGrantCarriesAnAssertionSignedForItAloneAndNoSecret(t *testing.T) {
	table := readAssertionTable(t)
	issuer := newKeyIssuer(t, http.StatusOK)
	service := NewServiceToken(KeyCredential{Issuer: issuer.URL, ClientID: keyClient, PrivateKey: testKey()}, issuerOf())

	if got, err := service.Authorization(context.Background()); err != nil || got != "Bearer "+signedToken(1) {
		t.Fatalf("the first grant gave %q, %v", got, err)
	}
	if got, err := service.token(context.Background(), true); err != nil || got != signedToken(2) {
		t.Fatalf("the second grant gave %q, %v", got, err)
	}

	forms := issuer.posted()
	if len(forms) != 2 {
		t.Fatalf("%d grants, want 2", len(forms))
	}
	var jtis []any
	for _, form := range forms {
		for name, values := range form {
			if len(values) != 1 {
				t.Errorf("the grant posted %s %d times", name, len(values))
			}
		}
		if fields := slices.Sorted(maps.Keys(form)); !slices.Equal(fields, slices.Sorted(slices.Values(table.Form))) {
			t.Errorf("the grant posted %v, the table's form is %v", fields, table.Form)
		}
		if form.Get("grant_type") != table.GrantType || form.Get("client_assertion_type") != JWTBearer {
			t.Errorf("the grant is %q with an assertion of type %q", form.Get("grant_type"), form.Get("client_assertion_type"))
		}
		header, claims, err := checked(form.Get("client_assertion"), &testKey().PublicKey)
		if err != nil {
			t.Fatalf("the key's public half does not verify the assertion: %v", err)
		}
		if want := map[string]any{"alg": "RS256", "kid": JWKThumbprint(&testKey().PublicKey)}; !maps.Equal(header, want) {
			t.Errorf("header %v, want %v", header, want)
		}
		if claims["iss"] != keyClient || claims["sub"] != keyClient || claims["aud"] != issuer.URL+"/token" {
			t.Errorf("claims %v: the client is not its issuer and subject, or the token endpoint its audience", claims)
		}
		issued, iatOK := claims["iat"].(float64)
		expires, expOK := claims["exp"].(float64)
		if !iatOK || !expOK || issued != float64(int64(issued)) || expires-issued != AssertionLifetimeSeconds {
			t.Errorf("claims %v: iat and exp are not whole seconds %d apart", claims, AssertionLifetimeSeconds)
		}
		if now := float64(time.Now().Unix()); issued < now-60 || issued > now+60 {
			t.Errorf("an assertion issued at %v, a minute or more from now", issued)
		}
		if jti, ok := claims["jti"].(string); !ok || jti == "" {
			t.Errorf("claims %v name no jti", claims)
		}
		jtis = append(jtis, claims["jti"])
	}
	if jtis[0] == jtis[1] {
		t.Error("a grant's assertion was sent twice")
	}
}

func TestAnAssertionAnotherKeySignedIsNotThisAccounts(t *testing.T) {
	issuer := newKeyIssuer(t, http.StatusOK)
	service := NewServiceToken(KeyCredential{Issuer: issuer.URL, ClientID: keyClient, PrivateKey: testKey()}, issuerOf())
	if _, err := service.Authorization(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := checked(issuer.posted()[0].Get("client_assertion"), &anotherTestKey().PublicKey); err == nil {
		t.Error("another key's public half verifies the assertion")
	}
}

func TestAKeyCredentialNeverShowsItsKeyAndARefusedGrantNeverShowsItsAssertion(t *testing.T) {
	issuer := newKeyIssuer(t, http.StatusUnauthorized)
	credential := KeyCredential{Issuer: issuer.URL, ClientID: keyClient, PrivateKey: testKey()}
	private := pkcs8PEM(t, testKey())
	for _, shown := range []string{credential.String(), fmt.Sprint(credential), fmt.Sprintf("%+v", credential), fmt.Sprintf("%#v", credential), fmt.Sprint(&credential)} {
		if strings.Contains(shown, "PrivateKey") || strings.Contains(shown, private) || strings.Contains(shown, testKey().D.String()) {
			t.Errorf("a key credential shows its key: %s", shown)
		}
	}

	_, err := NewServiceToken(credential, issuerOf()).Authorization(context.Background())
	var failed *SignInError
	if !errors.As(err, &failed) || failed.Code != SignInErrorCodeExchange {
		t.Fatalf("a refused grant failed as %v", err)
	}
	if status, ok := failed.Status(); !ok || status != http.StatusUnauthorized {
		t.Errorf("a refused grant's failure carries the status %d, %v", status, ok)
	}
	if want := fmt.Sprintf("Client-credentials grant for %s at %s failed (HTTP 401)", keyClient, issuer.URL); failed.Message != want {
		t.Errorf("a refused grant says %q, want %q", failed.Message, want)
	}
	assertion := issuer.posted()[0].Get("client_assertion")
	if assertion == "" {
		t.Fatal("the grant carried no assertion")
	}
	for _, said := range []string{err.Error(), fmt.Sprintf("%+v", err), fmt.Sprintf("%#v", err)} {
		if strings.Contains(said, assertion) {
			t.Errorf("a refused grant's failure says its assertion: %s", said)
		}
	}
}

func TestAKeyCredentialWithNoKeyMakesNoGrant(t *testing.T) {
	if _, err := (KeyCredential{Issuer: "https://issuer.example", ClientID: keyClient}).GrantForm("https://issuer.example/token"); err == nil {
		t.Error("a key credential with no key made a grant's form")
	}
}

func TestAPKCS8PEMIsReadAsTheRSAKeyItHolds(t *testing.T) {
	key, err := ParsePrivateKeyPEM(pkcs8PEM(t, testKey()))
	if err != nil {
		t.Fatal(err)
	}
	if !key.Equal(testKey()) {
		t.Error("the PEM was read as another key than the one it holds")
	}
}

func TestAPEMThatIsNotAnRSAPKCS8KeyIsRefused(t *testing.T) {
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := x509.MarshalPKIXPublicKey(&testKey().PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ why, text, says string }{
		{"nothing", "", "not a PKCS#8 PEM private key"},
		{"no PEM", "a key", "not a PKCS#8 PEM private key"},
		{"a PKCS#1 key", string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(testKey())})), "not a PKCS#8 PEM private key"},
		{"a public key", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: public})), "not a PKCS#8 PEM private key"},
		{"a PKCS#8 PEM that holds no key", string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("not DER")})), "holds no private key"},
		{"an EC key", pkcs8PEM(t, ec), "not an RSA key"},
	} {
		if _, err := ParsePrivateKeyPEM(c.text); err == nil || !strings.Contains(err.Error(), c.says) {
			t.Errorf("%s: read as a key, or refused as %v, not %q", c.why, err, c.says)
		}
	}
}
