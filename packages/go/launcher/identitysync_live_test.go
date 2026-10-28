package launcher

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
)

// Live reconciliation against a REAL Keycloak, in a throwaway realm.
//
// The stub tests pin the launcher's reading; this one pins Keycloak's. What a
// stub cannot tell us is whether the client `serviceAccountClient` renders is
// one Keycloak actually accepts, and whether the token it then mints carries
// the FLAT `roles` array and the audience the gateway requires — which is the
// whole reason the client shape matters. A hand-created client that Keycloak
// accepts but whose token carries `realm_access.roles` fails every
// service-to-service call while the realm looks correct in the console.
//
// Skipped unless SEMIONT_LIVE_KEYCLOAK names a base URL, because CI has no
// broker. Run it with the admin password this root persisted:
//
//	SEMIONT_LIVE_KEYCLOAK=http://localhost:8080 \
//	KC_BOOTSTRAP_ADMIN_PASSWORD=$(cat "$HOME/Library/Application Support/semiont/roots/<root>/keycloak-admin-password") \
//	go test ./internal/launcher/ -run TestIdentitySyncLive -v
//
// It creates its own realm and deletes it, so the KB's realm is never touched.
func TestIdentitySyncLive(t *testing.T) {
	base := os.Getenv("SEMIONT_LIVE_KEYCLOAK")
	pw := os.Getenv("KC_BOOTSTRAP_ADMIN_PASSWORD")
	if base == "" || pw == "" {
		t.Skip("set SEMIONT_LIVE_KEYCLOAK and KC_BOOTSTRAP_ADMIN_PASSWORD to run")
	}
	base = strings.TrimSuffix(base, "/")
	const realm = "semiont-synctest"
	const audience = "did:web:example.test:synctest"

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

	// 1. An empty realm gets every client.
	rep, err := syncServiceClients(base, realm, "admin", pw, audience, secretForTest)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(rep.created) != len(serviceClients) {
		t.Fatalf("created %d clients, want %d: %v", len(rep.created), len(serviceClients), rep.created)
	}

	// 2. Keycloak MINTS for what sync created, and the token is the shape the
	//    gateway demands. This is the assertion a stub cannot make.
	svc := serviceClients[0]
	claims := liveClientCredentials(t, base, realm, serviceClientID(svc), secretForTest(svc))

	if !flatRolesContain(claims["roles"], serviceRole) {
		t.Fatalf("token's `roles` is not a flat array containing %q — got %#v (nested realm_access would be the classic wrong shape)", serviceRole, claims["roles"])
	}
	if !audienceContains(claims["aud"], audience) {
		t.Fatalf("token's `aud` does not carry %q — got %#v", audience, claims["aud"])
	}

	// 3. Idempotent against a real realm, not just a stub.
	rep2, err := syncServiceClients(base, realm, "admin", pw, audience, secretForTest)
	if err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if len(rep2.created) != 0 {
		t.Fatalf("second run created %v, want nothing", rep2.created)
	}
	if len(rep2.present) != len(serviceClients) {
		t.Fatalf("second run saw %d present, want %d", len(rep2.present), len(serviceClients))
	}
}

func liveAdmin(t *testing.T, token, method, url string, body map[string]any) int {
	t.Helper()
	var r *http.Request
	if body == nil {
		r, _ = http.NewRequest(method, url, nil)
	} else {
		b, _ := json.Marshal(body)
		r, _ = http.NewRequest(method, url, bytes.NewReader(b))
		r.Header.Set("content-type", "application/json")
	}
	r.Header.Set("Authorization", "Bearer "+token)
	resp, err := adminHTTP.Do(r)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func liveClientCredentials(t *testing.T, base, realm, clientID, secret string) map[string]any {
	t.Helper()
	resp, err := adminHTTP.PostForm(base+"/realms/"+realm+"/protocol/openid-connect/token",
		url.Values{
			"grant_type":    {"client_credentials"},
			"client_id":     {clientID},
			"client_secret": {secret},
		})
	if err != nil {
		t.Fatalf("client-credentials grant: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("client-credentials grant for %s: HTTP %d — the client sync created is not one Keycloak will mint for", clientID, resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decoding the grant response: %v", err)
	}
	parts := strings.Split(body.AccessToken, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", body.AccessToken)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decoding claims: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatalf("parsing claims: %v", err)
	}
	fmt.Printf("    live token claims: roles=%v aud=%v\n", claims["roles"], claims["aud"])
	return claims
}
