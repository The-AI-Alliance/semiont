package launcher

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The identity preflight (IDENTITY-PREFLIGHT P1). Every case here drives a
// STUB issuer rather than a Keycloak: what these assert is the launcher's
// reading of a token, and a real realm cannot be made to emit the broken
// shapes on demand. The shapes themselves are not invented — they were read
// off a live Keycloak 26.7.4 realm on 2026-09-19.

// stubIssuer: an OIDC discovery document plus a token endpoint, serving
// whatever `grant` decides for each client.
func stubIssuer(t *testing.T, grant func(clientID string) (int, string)) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"issuer":%q,"token_endpoint":%q}`, srv.URL, srv.URL+"/token")
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		code, body := grant(r.PostFormValue("client_id"))
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(code)
		fmt.Fprint(w, body)
	})
	t.Cleanup(srv.Close)
	return srv
}

// token: an unsigned JWT carrying these claims. The preflight decodes without
// verifying — the signature is the gateway's business — so a stub needs no key.
func token(claims map[string]any) string {
	b, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc(b) + ".sig"
}

func grantBody(claims map[string]any) string {
	return fmt.Sprintf(`{"access_token":%q,"expires_in":300,"token_type":"Bearer"}`, token(claims))
}

const testAudience = "https://the-ai-alliance.github.io/semiont-template-kb"

func testSecrets() map[string]string {
	m := map[string]string{}
	for _, svc := range serviceClients {
		m[svc] = "secret-" + svc
	}
	return m
}

// (a) A refused grant names the client. The realm has no such account, or its
// secret differs from the one this run is about to inject — the F1 case, and
// the one an operator hits on a realm that predates the service accounts.
func TestPreflightRefusesWhenGrantIsRefused(t *testing.T) {
	srv := stubIssuer(t, func(clientID string) (int, string) {
		if clientID == serviceClientID("weaver") {
			return 401, `{"error":"invalid_client"}`
		}
		return 200, grantBody(map[string]any{
			"roles": []string{serviceRole},
			"aud":   []string{testAudience, "account"},
		})
	})

	findings := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

	if len(findings) != 1 {
		t.Fatalf("want exactly one finding, got %d: %v", len(findings), findings)
	}
	if !strings.Contains(findings[0].String(), serviceClientID("weaver")) {
		t.Errorf("finding does not name the client: %q", findings[0])
	}
}

// (b) Keycloak's NESTED realm_access.roles is not the flat claim the gateway
// reads, and a realm whose mapper regressed to it would fail every sidecar at
// the agent exchange. Verified live: realm_access.roles carries Keycloak's own
// defaults and never the service role, so reading it would find nothing.
func TestPreflightRefusesNestedRolesClaim(t *testing.T) {
	srv := stubIssuer(t, func(string) (int, string) {
		return 200, grantBody(map[string]any{
			"realm_access": map[string]any{"roles": []string{serviceRole}},
			"aud":          []string{testAudience},
		})
	})

	findings := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

	if len(findings) != len(serviceClients) {
		t.Fatalf("want a finding per client, got %d", len(findings))
	}
	if !strings.Contains(findings[0].String(), "roles") {
		t.Errorf("finding does not name the claim: %q", findings[0])
	}
}

// (c) The audience is the KB's own derived resource identity. A token carrying
// someone else's is a realm built for a different knowledge base.
func TestPreflightRefusesWrongAudience(t *testing.T) {
	srv := stubIssuer(t, func(string) (int, string) {
		return 200, grantBody(map[string]any{
			"roles": []string{serviceRole},
			"aud":   []string{"https://example.invalid/other-kb", "account"},
		})
	})

	findings := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

	if len(findings) != len(serviceClients) {
		t.Fatalf("want a finding per client, got %d", len(findings))
	}
	if !strings.Contains(findings[0].String(), "aud") {
		t.Errorf("finding does not name the claim: %q", findings[0])
	}
}

// (d) The shape a live realm actually emits: a FLAT roles array, and an aud
// ARRAY carrying the KB resource beside Keycloak's own "account". Membership,
// not equality — an equality check fails on a healthy realm.
func TestPreflightPassesOnTheLiveShape(t *testing.T) {
	srv := stubIssuer(t, func(string) (int, string) {
		return 200, grantBody(map[string]any{
			"roles": []string{serviceRole},
			"aud":   []string{testAudience, "account"},
			"azp":   "semiont-weaver",
		})
	})

	if findings := verifyServiceAccounts(srv.URL, testAudience, testSecrets()); len(findings) != 0 {
		t.Fatalf("healthy realm produced findings: %v", findings)
	}
}

// A single-string aud is legal OIDC and some issuers emit it. An operator
// federating their own issuer must not be refused for that.
func TestPreflightAcceptsScalarAudience(t *testing.T) {
	srv := stubIssuer(t, func(string) (int, string) {
		return 200, grantBody(map[string]any{
			"roles": []string{serviceRole},
			"aud":   testAudience,
		})
	})

	if findings := verifyServiceAccounts(srv.URL, testAudience, testSecrets()); len(findings) != 0 {
		t.Fatalf("scalar aud refused: %v", findings)
	}
}

// The refusal must never print a secret. This is the one place in the launcher
// that handles six of them at once, and a token endpoint's error body can echo
// the request that carried one.
func TestPreflightNeverPrintsASecret(t *testing.T) {
	srv := stubIssuer(t, func(clientID string) (int, string) {
		return 400, fmt.Sprintf(`{"error":"invalid_client","detail":"client_secret=%s rejected"}`, "secret-weaver")
	})

	for _, f := range verifyServiceAccounts(srv.URL, testAudience, testSecrets()) {
		if strings.Contains(f.String(), "secret-") {
			t.Fatalf("a finding leaked a client secret: %q", f)
		}
	}
}

// An unreachable issuer is a finding, not a panic or a silent pass: the realm
// answered its health gate a moment ago, so this means something else.
func TestPreflightRefusesWhenDiscoveryIsUnreachable(t *testing.T) {
	findings := verifyServiceAccounts("http://127.0.0.1:1", testAudience, testSecrets())
	if len(findings) == 0 {
		t.Fatal("a dead issuer produced no finding")
	}
}
