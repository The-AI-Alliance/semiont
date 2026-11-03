package launcher

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The realm a start creates, against a REAL Keycloak, in a throwaway realm.
//
// The stub tests pin the launcher's reading; this one pins Keycloak's. What a
// stub cannot tell us is whether Keycloak takes keycloakRealmJSON whole through
// POST /admin/realms — the clients and their mappers, the realm roles, the
// worker's key and the declarative user profile — and whether the realm it
// makes is one the start's own preflight admits, and whether the clean's
// delete removes it.
//
// CI's "Launcher Tests (Go, Keycloak)" job runs it beside TestIdentitySyncLive,
// and fails if it skips. Run it as that test's comment says.
func TestStartCreatesTheRealmLive(t *testing.T) {
	base := os.Getenv("SEMIONT_LIVE_KEYCLOAK")
	pw := os.Getenv("KC_BOOTSTRAP_ADMIN_PASSWORD")
	if base == "" || pw == "" {
		t.Skip("set SEMIONT_LIVE_KEYCLOAK and KC_BOOTSTRAP_ADMIN_PASSWORD to run")
	}
	base = strings.TrimSuffix(base, "/")
	const realm = "example.test-realmtest"
	const audience = "did:web:example.test:realmtest"
	const browserPort = 3000

	tok, err := adminToken(base, keycloakAdminUser, pw)
	if err != nil {
		t.Fatalf("admin token: %v", err)
	}
	liveAdmin(t, tok, http.MethodDelete, base+"/admin/realms/"+realm, nil) // leftovers from a failed run
	t.Cleanup(func() { liveAdmin(t, tok, http.MethodDelete, base+"/admin/realms/"+realm, nil) })
	doc := keycloakRealmJSON(realm, audience, browserPort, keycloakAccessTokenLifespan, testAccounts())

	// 1. An absent realm is created, whole.
	created, err := ensureRealm(base, realm, pw, doc)
	if err != nil {
		t.Fatalf("creating the realm: %v", err)
	}
	if !created {
		t.Fatal("an absent realm was not created")
	}

	// 2. The realm admits every service and the people's clients, as the
	//    start's preflight asks it to, and mints for the lifespan it was given.
	issuer, _ := liveTokenEndpoint(t, base, realm)
	findings, lifespan := verifyServiceAccounts(issuer, audience, testAccounts())
	if len(findings) > 0 {
		t.Fatalf("the created realm does not admit the services: %v", findings)
	}
	if lifespan != keycloakAccessTokenLifespan {
		t.Fatalf("the created realm mints tokens that live %ds, want %ds", lifespan, keycloakAccessTokenLifespan)
	}
	if public := verifyPublicClients(issuer, browserPort); len(public) > 0 {
		t.Fatalf("the created realm would let nobody sign in: %v", public)
	}

	// 3. The user profile came through the admin API as the realm states it.
	//    Keycloak's default requires the same names, so the profile it
	//    reports proves nothing; the component it stored does.
	req, _ := http.NewRequest(http.MethodGet, base+"/admin/realms/"+realm+"/components?type=org.keycloak.userprofile.UserProfileProvider", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := adminHTTP.Do(req)
	if err != nil {
		t.Fatalf("reading the realm's user profile: %v", err)
	}
	defer resp.Body.Close()
	var components []struct {
		ProviderID string              `json:"providerId"`
		Config     map[string][]string `json:"config"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&components); err != nil {
		t.Fatalf("reading the realm's user profile (HTTP %d): %v", resp.StatusCode, err)
	}
	if len(components) != 1 || components[0].ProviderID != "declarative-user-profile" {
		t.Fatalf("the created realm holds no declarative user profile of its own: %+v", components)
	}
	var stored, want any
	if got := components[0].Config["kc.user.profile.config"]; len(got) != 1 || json.Unmarshal([]byte(got[0]), &stored) != nil {
		t.Fatalf("the created realm's user profile holds no readable config: %+v", components[0].Config)
	}
	if err := json.Unmarshal([]byte(keycloakUserProfile()), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored, want) {
		t.Fatalf("the created realm's user profile is not the one the realm states:\n got %v\nwant %v", stored, want)
	}

	// 4. A realm Keycloak holds is left as it is, and asking needs no admin:
	//    a wrong password changes nothing.
	created, err = ensureRealm(base, realm, "not-the-admin-password", doc)
	if err != nil {
		t.Fatalf("asking for a held realm: %v", err)
	}
	if created {
		t.Fatal("a held realm was created again")
	}

	// 5. A clean deletes it as the admin, and deleting one Keycloak holds no
	//    longer is no failure.
	if err := deleteRealm(base, realm, pw); err != nil {
		t.Fatalf("deleting the realm: %v", err)
	}
	if held, err := realmHeld(base, realm); err != nil || held {
		t.Fatalf("after its delete Keycloak holds the realm: %v (%v)", held, err)
	}
	if err := deleteRealm(base, realm, pw); err != nil {
		t.Fatalf("deleting a realm Keycloak no longer holds: %v", err)
	}
}
