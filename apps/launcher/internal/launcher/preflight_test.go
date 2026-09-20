package launcher

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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

// --- the clients PEOPLE sign in through -------------------------------------
//
// verifyServiceAccounts covers the six machine identities and proves nothing
// about whether anyone can log in. These drive a stub issuer that answers the
// device and authorization endpoints the way a live Keycloak 26.7.4 realm was
// observed to on 2026-09-20 — `invalid_client` vs `unauthorized_client` at the
// device endpoint, and 400 for either authorization failure.

type publicStub struct {
	missingClient string // device endpoint: 401 invalid_client for this id
	noDeviceGrant string // device endpoint: 400 unauthorized_client for this id
	pinnedPort    bool   // authorization endpoint: only :3000 redirects accepted
	omitDevice    bool   // discovery names no device_authorization_endpoint
	authRedirect  string // authorization endpoint 302s here instead of rendering
	authHits      *int32 // incremented each time the authorization endpoint is reached
}

func stubPublicIssuer(t *testing.T, s publicStub) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		device := fmt.Sprintf(`"device_authorization_endpoint":%q,`, srv.URL+"/device")
		if s.omitDevice {
			device = ""
		}
		fmt.Fprintf(w, `{"issuer":%q,%s"authorization_endpoint":%q,"token_endpoint":%q}`,
			srv.URL, device, srv.URL+"/auth", srv.URL+"/token")
	})
	mux.HandleFunc("/device", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("content-type", "application/json")
		switch r.PostFormValue("client_id") {
		case s.missingClient:
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":"invalid_client"}`)
		case s.noDeviceGrant:
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":"unauthorized_client"}`)
		default:
			fmt.Fprint(w, `{"device_code":"d","user_code":"U","verification_uri":"v","expires_in":600,"interval":5}`)
		}
	})
	mux.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
		if s.authHits != nil {
			atomic.AddInt32(s.authHits, 1)
		}
		if s.authRedirect != "" {
			http.Redirect(w, r, s.authRedirect, http.StatusFound)
			return
		}
		if s.pinnedPort && !strings.Contains(r.URL.Query().Get("redirect_uri"), ":3000/") {
			http.Error(w, "Invalid parameter: redirect_uri", 400)
			return
		}
		fmt.Fprint(w, "<html>Sign in</html>")
	})
	t.Cleanup(srv.Close)
	return srv
}

func findingFor(findings []publicClientFinding, clientID string) (publicClientFinding, bool) {
	for _, f := range findings {
		if f.clientID == clientID {
			return f, true
		}
	}
	return publicClientFinding{}, false
}

// A realm carrying both clients, with loopback registered portlessly, is clean.
func TestPublicClientsPassOnAHealthyRealm(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{})
	if findings := verifyPublicClients(srv.URL); len(findings) != 0 {
		t.Fatalf("a healthy realm produced findings: %v", findings)
	}
}

// The failure this whole check exists for: the six services authenticate
// perfectly and no person can get in.
func TestPublicClientsRefuseWhenTheBrowserClientIsMissing(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{missingClient: browserClientID})
	f, ok := findingFor(verifyPublicClients(srv.URL), browserClientID)
	if !ok {
		t.Fatal("a realm with no semiont-browser client passed")
	}
	if f.warnOnly {
		t.Error("a missing sign-in client must stop the start, not warn")
	}
	if !strings.Contains(f.reason, "no such client") {
		t.Errorf("reason does not name the cause: %q", f.reason)
	}
	// It must not be reported as a redirect problem: that would send an
	// operator to edit redirect URIs on a client that does not exist.
	if strings.Contains(f.reason, "redirect") {
		t.Errorf("a missing client was reported as a redirect failure: %q", f.reason)
	}
}

func TestPublicClientsRefuseWhenTheCliClientIsMissing(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{missingClient: cliClientID})
	f, ok := findingFor(verifyPublicClients(srv.URL), cliClientID)
	if !ok {
		t.Fatal("a realm with no semiont-cli client passed")
	}
	if !strings.Contains(f.reason, "no such client") {
		t.Errorf("reason does not name the cause: %q", f.reason)
	}
}

// The client exists but may not use the grant — a different fix from a missing
// client, so a different message.
func TestPublicClientsRefuseWhenTheDeviceGrantIsDisabled(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{noDeviceGrant: cliClientID})
	f, ok := findingFor(verifyPublicClients(srv.URL), cliClientID)
	if !ok {
		t.Fatal("a client that cannot use the device grant passed")
	}
	if strings.Contains(f.reason, "no such client") {
		t.Errorf("an existing client was reported as missing: %q", f.reason)
	}
	if !strings.Contains(f.fix, "device grant") {
		t.Errorf("fix does not name the device grant: %q", f.fix)
	}
}

// A realm that pins loopback to :3000 works — it just predates RFC 8252 §7.3
// being honoured, so `--port` will not. That warns; it must not strand an
// otherwise healthy deployment.
func TestPublicClientsWarnButDoNotRefuseOnAPinnedPort(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{pinnedPort: true})
	findings := verifyPublicClients(srv.URL)
	f, ok := findingFor(findings, browserClientID)
	if !ok {
		t.Fatal("a realm pinning the browser to :3000 produced no finding")
	}
	if !f.warnOnly {
		t.Fatal("a pinned port refused the start; a realm older than the change still works")
	}
	if !strings.Contains(f.fix, "--port") {
		t.Errorf("fix does not say what stops working: %q", f.fix)
	}
}

func TestPublicClientsRefuseWhenTheIssuerServesNoDeviceEndpoint(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{omitDevice: true})
	f, ok := findingFor(verifyPublicClients(srv.URL), cliClientID)
	if !ok {
		t.Fatal("an issuer with no device endpoint passed")
	}
	if !strings.Contains(f.reason, "device_authorization_endpoint") {
		t.Errorf("reason does not name the missing endpoint: %q", f.reason)
	}
}

// The authorization probe must NOT follow a redirect. Some authorization
// errors are returned by redirecting to the registered callback — which is the
// Browser's own port — and following one would have the launcher issue a
// request against a service it is in the middle of starting.
func TestAuthorizationProbeDoesNotFollowRedirects(t *testing.T) {
	var followed int32
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&followed, 1)
	}))
	t.Cleanup(sink.Close)

	var authHits int32
	srv := stubPublicIssuer(t, publicStub{authRedirect: sink.URL + "/en/auth/callback", authHits: &authHits})
	verifyPublicClients(srv.URL)

	// Asserted first: without it this test passes when nothing probes at all.
	if atomic.LoadInt32(&authHits) == 0 {
		t.Fatal("the authorization endpoint was never reached, so nothing was proven about redirects")
	}
	if n := atomic.LoadInt32(&followed); n != 0 {
		t.Fatalf("the preflight followed the authorization redirect %d time(s) — it would dial the Browser mid-start", n)
	}
}

// An unreachable issuer is one finding, not a cascade.
func TestPublicClientsReportAnUnreachableIssuerOnce(t *testing.T) {
	findings := verifyPublicClients("http://127.0.0.1:1")
	if len(findings) != 1 {
		t.Fatalf("want one finding for a dead issuer, got %d: %v", len(findings), findings)
	}
}
