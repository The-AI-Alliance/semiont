package launcher

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// A worker granted by its key, against a REAL Keycloak, in a throwaway realm.
//
// The stub tests pin the launcher's half; this pins Keycloak's. What a stub
// cannot tell us is whether Keycloak takes the client a grant renders, admits
// an assertion the worker signs with the key registered on it, and stamps the
// token it mints with the flat `roles` and the audience the gateway requires;
// whether a new key under the same label leaves the account — its subject,
// which the gateway names the worker by — the same; and whether a revoke
// refuses the next sign-in.
//
// Run as TestIdentitySyncLive is: by CI's "Launcher Tests (Go, Keycloak)" job
// against the Keycloak the launcher starts (scripts/ci/keycloak-image.sh), and
// skipped elsewhere unless SEMIONT_LIVE_KEYCLOAK names one.
//
// It creates its own realm and deletes it, so no knowledge base's realm is
// touched.
func TestWorkerGrantLive(t *testing.T) {
	base := os.Getenv("SEMIONT_LIVE_KEYCLOAK")
	pw := os.Getenv("KC_BOOTSTRAP_ADMIN_PASSWORD")
	if base == "" || pw == "" {
		t.Skip("set SEMIONT_LIVE_KEYCLOAK and KC_BOOTSTRAP_ADMIN_PASSWORD to run")
	}
	base = strings.TrimSuffix(base, "/")
	const realm = "semiont-granttest"
	const audience = "did:web:example.test:granttest"
	const label = "granttest"

	tok, err := adminToken(base, "admin", pw)
	if err != nil {
		t.Fatalf("admin token: %v", err)
	}
	liveAdmin(t, tok, http.MethodDelete, base+"/admin/realms/"+realm, nil) // leftovers from a failed run
	if code := liveAdmin(t, tok, http.MethodPost, base+"/admin/realms",
		map[string]any{"realm": realm, "enabled": true}); code != http.StatusCreated {
		t.Fatalf("creating the scratch realm: HTTP %d", code)
	}
	t.Cleanup(func() { liveAdmin(t, tok, http.MethodDelete, base+"/admin/realms/"+realm, nil) })
	issuer, tokenEndpoint := liveTokenEndpoint(t, base, realm)

	key := func() workerKey {
		t.Helper()
		private, err := rsa.GenerateKey(rand.Reader, workerKeyBits)
		if err != nil {
			t.Fatal(err)
		}
		k, err := workerKeyOf(private)
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	signIn := func(k workerKey) (map[string]any, error) {
		return clientCredentialsClaims(tokenEndpoint, semiont.KeyCredential{Issuer: issuer, ClientID: workerClientID(label), PrivateKey: k.signer})
	}

	// 1. A grant makes a client Keycloak admits the worker's assertion at, and
	//    the token it mints is the shape the gateway and the dispatcher demand.
	first := key()
	rep, err := grantWorker(base, realm, "admin", pw, audience, label, first.registeredKey)
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if !slices.Equal(rep.created, []string{workerClientID(label)}) {
		t.Fatalf("created %v, want %s", rep.created, workerClientID(label))
	}
	claims, err := signIn(first)
	if err != nil {
		t.Fatalf("the granted worker's sign-in: %v", err)
	}
	if f, bad := checkServiceAccountClaims("worker", claims, audience); bad {
		t.Fatalf("the granted worker's token: %s", f)
	}
	subject, _ := claims["sub"].(string)
	if subject == "" {
		t.Fatalf("the granted worker's token names no subject: %v", claims)
	}

	// 2. The same key again changes nothing, Keycloak's listing of the key
	//    included.
	rep, err = grantWorker(base, realm, "admin", pw, audience, label, first.registeredKey)
	if err != nil {
		t.Fatalf("second grant: %v", err)
	}
	if !slices.Equal(rep.present, []string{workerClientID(label)}) {
		t.Fatalf("a second grant of the same key reported %+v, want it present and unchanged", rep)
	}

	// 3. Another key under the label replaces the old on the same client: the
	//    old key is refused, the new one admitted, and the account is the one
	//    it was.
	second := key()
	rep, err = grantWorker(base, realm, "admin", pw, audience, label, second.registeredKey)
	if err != nil {
		t.Fatalf("grant of a new key: %v", err)
	}
	if len(rep.updated) != 1 {
		t.Fatalf("a new key reported %+v, want the client updated", rep)
	}
	if _, err := signIn(first); err == nil {
		t.Fatal("the replaced key still signs in")
	}
	claims, err = signIn(second)
	if err != nil {
		t.Fatalf("the new key's sign-in: %v", err)
	}
	if claims["sub"] != subject {
		t.Fatalf("a new key changed the account's subject (%v → %v): the worker would be named anew", subject, claims["sub"])
	}

	// 4. A revoke refuses the next sign-in.
	revoked, _, err := revokeWorker(base, realm, "admin", pw, label)
	if err != nil || !revoked {
		t.Fatalf("revoke: revoked=%v, %v", revoked, err)
	}
	if _, err := signIn(second); err == nil {
		t.Fatal("a revoked worker still signs in")
	}
}
