package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// Live reconciliation against a REAL Keycloak, in a throwaway realm.
//
// The stub tests pin the launcher's reading; this one pins Keycloak's. What a
// stub cannot tell us is whether the clients `serviceAccountClient` and
// `workerClient` render are ones Keycloak actually accepts — the worker's
// taking an assertion signed with the machine's key — and whether the token
// it then mints carries the FLAT `roles` array and the audience the gateway
// requires — which is the whole reason the client shape matters. A
// hand-created client that Keycloak accepts but whose token carries
// `realm_access.roles` fails every service-to-service call while the realm
// looks correct in the console.
//
// CI's "Launcher Tests (Go, Keycloak)" job runs it, with TestWorkerGrantLive,
// against the Keycloak the launcher starts (scripts/ci/keycloak-image.sh), and
// fails if either skips. Elsewhere it is skipped unless SEMIONT_LIVE_KEYCLOAK
// names a base URL. Run it with the admin password this root persisted:
//
//	SEMIONT_LIVE_KEYCLOAK=http://localhost:8080 \
//	KC_BOOTSTRAP_ADMIN_PASSWORD=$(cat "$HOME/Library/Application Support/semiont/roots/<root>/keycloak-admin-password") \
//	go -C packages/go/launcher test . -run 'Live$' -v
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
	rep, err := syncServiceClients(base, realm, "admin", pw, audience, testAccounts())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(rep.created) != len(accountServices()) {
		t.Fatalf("created %d clients, want %d: %v", len(rep.created), len(accountServices()), rep.created)
	}

	// 2. Keycloak MINTS for what sync created, and the token is the shape the
	//    gateway demands. This is the assertion a stub cannot make.
	svc := secretClients[0]
	claims := liveClientCredentials(t, base, realm, serviceClientID(svc), secretForTest(svc))

	if !flatRolesContain(claims["roles"], serviceRole) {
		t.Fatalf("token's `roles` is not a flat array containing %q — got %#v (nested realm_access would be the classic wrong shape)", serviceRole, claims["roles"])
	}
	if !audienceContains(claims["aud"], audience) {
		t.Fatalf("token's `aud` does not carry %q — got %#v", audience, claims["aud"])
	}
	if claims[kindClaim] != agentKind {
		t.Fatalf("token's `%s` is %#v, not %q: the account would read as a person's", kindClaim, claims[kindClaim], agentKind)
	}

	//    And for the worker, by the assertion the preflight signs: Keycloak
	//    checks it with the key sync registered, and stamps the worker role.
	worker, err := clientCredentialsClaims(base+"/realms/"+realm+"/protocol/openid-connect/token",
		semiont.KeyCredential{Issuer: base + "/realms/" + realm, ClientID: serviceClientID("worker"), PrivateKey: testWorkerKey().signer})
	if err != nil {
		t.Fatalf("the worker's grant: %v — the client sync created does not take the machine's key", err)
	}
	if f, bad := checkServiceAccountClaims("worker", worker, audience); bad {
		t.Fatalf("the worker's token: %s", f)
	}

	// 3. Idempotent against a real realm, not just a stub — the worker's key
	//    as Keycloak lists it back included.
	rep2, err := syncServiceClients(base, realm, "admin", pw, audience, testAccounts())
	if err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if len(rep2.created) != 0 {
		t.Fatalf("second run created %v, want nothing", rep2.created)
	}
	if len(rep2.present) != len(accountServices()) {
		t.Fatalf("second run saw %d present, want %d: updated %v", len(rep2.present), len(accountServices()), rep2.updated)
	}

	// 4. A client of a realm imported before the kind claim — its mapper
	//    removed here — gets it back from sync, as Keycloak takes a mapper
	//    POSTed onto a client, and its next token says it is an agent's.
	have, err := existingClients(base, realm, tok)
	if err != nil {
		t.Fatal(err)
	}
	c := have[serviceClientID(svc)]
	mappers, _ := c.rep["protocolMappers"].([]any)
	removed := false
	for _, m := range mappers {
		mapper, _ := m.(map[string]any)
		if mapper["name"] == agentKindMapperName {
			id, _ := mapper["id"].(string)
			if code := liveAdmin(t, tok, http.MethodDelete, base+"/admin/realms/"+realm+"/clients/"+c.uuid+"/protocol-mappers/models/"+id, nil); code != http.StatusNoContent {
				t.Fatalf("removing the kind mapper: HTTP %d", code)
			}
			removed = true
		}
	}
	if !removed {
		t.Fatalf("Keycloak lists %s with no %q mapper to remove", serviceClientID(svc), agentKindMapperName)
	}
	if claims := liveClientCredentials(t, base, realm, serviceClientID(svc), secretForTest(svc)); claims[kindClaim] != nil {
		t.Fatalf("a token minted without the mapper still carries `%s`", kindClaim)
	}
	rep3, err := syncServiceClients(base, realm, "admin", pw, audience, testAccounts())
	if err != nil {
		t.Fatalf("third sync: %v", err)
	}
	if len(rep3.updated) != 1 || !strings.Contains(rep3.updated[0], "kind mapper added") {
		t.Fatalf("third run updated %v, want the kind mapper added to %s alone", rep3.updated, serviceClientID(svc))
	}
	if claims := liveClientCredentials(t, base, realm, serviceClientID(svc), secretForTest(svc)); claims[kindClaim] != agentKind {
		t.Fatalf("after sync, the token's `%s` is %#v, not %q", kindClaim, claims[kindClaim], agentKind)
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
	claims, err := clientCredentialsClaims(base+"/realms/"+realm+"/protocol/openid-connect/token",
		semiont.SecretCredential{Issuer: base + "/realms/" + realm, ClientID: clientID, ClientSecret: secret})
	if err != nil {
		t.Fatalf("client-credentials grant for %s: %v — the client sync created is not one Keycloak will mint for", clientID, err)
	}
	fmt.Printf("    live token claims: roles=%v aud=%v\n", claims["roles"], claims["aud"])
	return claims
}
