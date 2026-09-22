package launcher

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
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

// stampedRoles: the flat `roles` the realm document stamps on this client's
// token — DERIVED from serviceRoles, so a healthy stub can never drift from
// what the import renders. The worker carries the worker role too
// (EXTRACT-JOBS P0); restating `[serviceRole]` here would be a second copy of
// that fact, and the one that silently goes stale.
func stampedRoles(clientID string) []string {
	return serviceRoles(strings.TrimPrefix(clientID, "semiont-"))
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
			"roles": stampedRoles(clientID),
			"aud":   []string{testAudience, "account"},
		})
	})

	findings, _ := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

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

	findings, _ := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

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
	srv := stubIssuer(t, func(clientID string) (int, string) {
		return 200, grantBody(map[string]any{
			"roles": stampedRoles(clientID),
			"aud":   []string{"https://example.invalid/other-kb", "account"},
		})
	})

	findings, _ := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

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
	srv := stubIssuer(t, func(clientID string) (int, string) {
		return 200, grantBody(map[string]any{
			"roles": stampedRoles(clientID),
			"aud":   []string{testAudience, "account"},
			"azp":   clientID,
		})
	})

	if findings, _ := verifyServiceAccounts(srv.URL, testAudience, testSecrets()); len(findings) != 0 {
		t.Fatalf("healthy realm produced findings: %v", findings)
	}
}

// (e) EXTRACT-JOBS P0: the dispatcher admits a job:claim only from a token
// carrying the worker role, and the worker's agent tokens are stamped with it
// only if the worker's OWN service token carried it at the mint. A realm
// imported before P0 has a roles mapper on semiont-worker that renders just the
// service role: every client authenticates, every other check passes, and the
// worker can never claim a job. That is a broken deployment, not a realm that
// merely predates a change, so it refuses. Observed live 2026-09-21: the
// gateway minted the worker's agents with `worker:false` and the dispatcher
// re-announced one job every 30s, forever, with nothing in any log saying why.
func TestPreflightRefusesAWorkerThatCannotClaim(t *testing.T) {
	// The pre-P0 realm: every token carries exactly the service role.
	srv := stubIssuer(t, func(string) (int, string) {
		return 200, grantBody(map[string]any{
			"roles": []string{serviceRole},
			"aud":   []string{testAudience, "account"},
		})
	})

	findings, _ := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

	// One finding — the worker's. The other clients carry exactly what the
	// realm document gives them; asking the worker role of them would refuse
	// every healthy realm.
	if len(findings) != 1 {
		t.Fatalf("want exactly one finding (the worker's), got %d: %v", len(findings), findings)
	}
	f := findings[0]
	if f.svc != "worker" {
		t.Fatalf("finding names %q, want the worker", f.svc)
	}
	// The ROLE is asserted on the reason, not on String(): the worker's client
	// id is also "semiont-worker", so String() would match the role string by
	// coincidence and prove nothing.
	if !strings.Contains(f.reason, workerRole) {
		t.Errorf("reason does not name the missing role %q: %q", workerRole, f.reason)
	}
	if !strings.Contains(f.reason, "claim") {
		t.Errorf("reason does not say what the worker cannot do (claim jobs): %q", f.reason)
	}
	if !strings.Contains(f.fix, "mapper") {
		t.Errorf("fix does not point at the client's roles mapper: %q", f.fix)
	}
}

// A single-string aud is legal OIDC and some issuers emit it. An operator
// federating their own issuer must not be refused for that.
func TestPreflightAcceptsScalarAudience(t *testing.T) {
	srv := stubIssuer(t, func(clientID string) (int, string) {
		return 200, grantBody(map[string]any{
			"roles": stampedRoles(clientID),
			"aud":   testAudience,
		})
	})

	if findings, _ := verifyServiceAccounts(srv.URL, testAudience, testSecrets()); len(findings) != 0 {
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

	findings, _ := verifyServiceAccounts(srv.URL, testAudience, testSecrets())
	for _, f := range findings {
		if strings.Contains(f.String(), "secret-") {
			t.Fatalf("a finding leaked a client secret: %q", f)
		}
	}
}

// An unreachable issuer is a finding, not a panic or a silent pass: the realm
// answered its health gate a moment ago, so this means something else.
func TestPreflightRefusesWhenDiscoveryIsUnreachable(t *testing.T) {
	findings, _ := verifyServiceAccounts("http://127.0.0.1:1", testAudience, testSecrets())
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
	pkceOptional  bool   // authorization endpoint serves the login page with no code challenge
	implicitOn    bool   // authorization endpoint accepts response_type=token
	passwordGrant string // token endpoint allows the resource-owner grant for this client
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
		// A realm with the implicit flow DISABLED refuses response_type=token
		// outright; one that allows it serves the login page, and the token
		// then comes back in a redirect fragment.
		if r.URL.Query().Get("response_type") == "token" && !s.implicitOn {
			http.Redirect(w, r, r.URL.Query().Get("redirect_uri")+"?error=unsupported_response_type", http.StatusFound)
			return
		}
		// A realm REQUIRING PKCE refuses a request carrying no code challenge,
		// and delivers that refusal as a redirect to the callback. It binds the
		// CODE to its requester, so it is not asked of an implicit request —
		// there is no code to exchange.
		if r.URL.Query().Get("response_type") == "code" && !s.pkceOptional && r.URL.Query().Get("code_challenge") == "" {
			http.Redirect(w, r, r.URL.Query().Get("redirect_uri")+"?error=invalid_request", http.StatusFound)
			return
		}
		fmt.Fprint(w, "<html>Sign in</html>")
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("content-type", "application/json")
		if r.PostFormValue("grant_type") != "password" {
			fmt.Fprint(w, `{"error":"unsupported_grant_type"}`)
			return
		}
		// Allowed for this client: the missing username is reached. Forbidden:
		// refused before the credentials are looked at.
		if r.PostFormValue("client_id") == s.passwordGrant {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":"invalid_request","error_description":"Missing parameter: username"}`)
			return
		}
		w.WriteHeader(400)
		fmt.Fprint(w, `{"error":"unauthorized_client"}`)
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

// --- the flags, not just the existence --------------------------------------
//
// Both probes below send NO credential. The discriminations they rely on were
// read off a live Keycloak 26.7.4 on 2026-09-20, each with a positive AND a
// negative control — a client with the flag set and one without — so neither
// infers "enabled" from a single observation.

// PKCE must be REQUIRED. A realm that merely SUPPORTS it serves the login page
// to a request carrying no code challenge, and the authorization code is then
// interceptable for a client that holds no secret.
func TestPublicClientsWarnWhenPKCEIsNotRequired(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{pkceOptional: true})
	f, ok := findingFor(verifyPublicClients(srv.URL), browserClientID)
	if !ok {
		t.Fatal("a realm that does not require PKCE produced no finding")
	}
	if !f.warnOnly {
		t.Error("PKCE is a posture finding, not a reason to refuse an otherwise working realm")
	}
	if !strings.Contains(f.reason, "PKCE") {
		t.Errorf("reason does not name PKCE: %q", f.reason)
	}
}

// The control: a realm that DOES require PKCE must not be reported. Without
// this, the check above would pass just as well if it fired on every realm.
func TestPublicClientsDoNotReportPKCEWhenItIsRequired(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{})
	for _, f := range verifyPublicClients(srv.URL) {
		if strings.Contains(f.reason, "PKCE") {
			t.Fatalf("a realm requiring PKCE was reported anyway: %q", f)
		}
	}
}

// A public client must never take a password. The resource-owner grant skips
// the browser entirely, so it also skips every required action the realm
// has — including the first-sign-in profile form.
func TestPublicClientsWarnOnTheResourceOwnerPasswordGrant(t *testing.T) {
	for _, id := range []string{browserClientID, cliClientID} {
		srv := stubPublicIssuer(t, publicStub{passwordGrant: id})
		f, ok := findingFor(verifyPublicClients(srv.URL), id)
		if !ok {
			t.Fatalf("%s: a realm allowing the password grant produced no finding", id)
		}
		if !f.warnOnly {
			t.Errorf("%s: refused rather than warned; the realm still works", id)
		}
		if !strings.Contains(f.reason, "password grant") {
			t.Errorf("%s: reason does not name the grant: %q", id, f.reason)
		}
	}
}

// The control: a realm refusing the grant for both clients says nothing.
func TestPublicClientsDoNotReportARefusedPasswordGrant(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{})
	for _, f := range verifyPublicClients(srv.URL) {
		if strings.Contains(f.reason, "password grant") {
			t.Fatalf("a realm refusing the password grant was reported anyway: %q", f)
		}
	}
}

// Neither probe may send a credential. The password probe's whole safety
// argument is that it stops at "username missing" — if it ever started
// inventing one, this fails.
func TestFlagProbesSendNoCredential(t *testing.T) {
	var sawCredential atomic.Bool
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"issuer":%q,"authorization_endpoint":%q,"device_authorization_endpoint":%q,"token_endpoint":%q}`,
			srv.URL, srv.URL+"/auth", srv.URL+"/device", srv.URL+"/token")
	})
	watch := func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		for _, k := range []string{"username", "password", "client_secret", "code_verifier"} {
			if r.Form.Get(k) != "" {
				sawCredential.Store(true)
			}
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(400)
		fmt.Fprint(w, `{"error":"unauthorized_client"}`)
	}
	mux.HandleFunc("/token", watch)
	mux.HandleFunc("/device", watch)
	mux.HandleFunc("/auth", watch)

	verifyPublicClients(srv.URL)

	if sawCredential.Load() {
		t.Fatal("a preflight probe sent a credential to the issuer")
	}
}

// --- the realm's ACTUAL revocation window ------------------------------------
//
// A realm imports on first boot and never again, so a knowledge base can
// configure a lifespan its realm has never heard of. `exp - iat` on a
// service-account token is what the realm really stamps, and the only reading
// available without administrator credentials.

func lifespanToken(t *testing.T, clientID string, seconds int) string {
	t.Helper()
	return grantBody(map[string]any{
		"roles": stampedRoles(clientID),
		"aud":   []string{testAudience, "account"},
		"iat":   1700000000,
		"exp":   1700000000 + seconds,
	})
}

func TestPreflightReadsTheRealmsActualLifespan(t *testing.T) {
	srv := stubIssuer(t, func(clientID string) (int, string) { return 200, lifespanToken(t, clientID, 900) })

	findings, observed := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

	if len(findings) != 0 {
		t.Fatalf("healthy realm produced findings: %v", findings)
	}
	if observed != 900 {
		t.Errorf("lifespan read off the token: got %d, want 900", observed)
	}
}

// Missing or nonsensical claims report 0 — "unknown" — rather than a number
// the caller would compare against and warn about.
func TestTokenLifespanIsZeroWhenUnreadable(t *testing.T) {
	for _, c := range []struct {
		name   string
		claims map[string]any
	}{
		{"no iat", map[string]any{"exp": float64(1700000300)}},
		{"no exp", map[string]any{"iat": float64(1700000000)}},
		{"exp before iat", map[string]any{"iat": float64(1700000300), "exp": float64(1700000000)}},
		{"equal", map[string]any{"iat": float64(1700000000), "exp": float64(1700000000)}},
		{"not numbers", map[string]any{"iat": "soon", "exp": "later"}},
		{"empty", map[string]any{}},
	} {
		if got := tokenLifespan(c.claims); got != 0 {
			t.Errorf("%s: want 0 (unknown), got %d", c.name, got)
		}
	}
}

// The realm agreeing with the config must read as agreement, not as a warning
// nobody can act on.
func TestPreflightLifespanMatchesWhenTheRealmAgrees(t *testing.T) {
	srv := stubIssuer(t, func(clientID string) (int, string) {
		return 200, lifespanToken(t, clientID, keycloakAccessTokenLifespan)
	})

	_, observed := verifyServiceAccounts(srv.URL, testAudience, testSecrets())

	if observed != keycloakAccessTokenLifespan {
		t.Fatalf("got %d, want %d", observed, keycloakAccessTokenLifespan)
	}
}

// The implicit flow hands the access token back in a redirect FRAGMENT, where
// it lands in browser history and any script on the page. The realm document
// disables it on every client, but a realm imported before that line — or an
// issuer someone configured by hand — can have it on, and nothing said so.
//
// Fatal, not a warning (user, 2026-09-20). Its siblings here are posture
// findings about a realm that is merely behind; this one is a live way to leak
// a bearer token, and a stack that starts is a stack that leaks it.
func TestPublicClientsRefuseWhenImplicitFlowIsEnabled(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{implicitOn: true})
	f, ok := implicitFinding(verifyPublicClients(srv.URL))
	if !ok {
		t.Fatal("a realm accepting response_type=token produced no finding")
	}
	if f.warnOnly {
		t.Error("the implicit flow must refuse the start, not warn past it")
	}
	if f.clientID != browserClientID {
		t.Errorf("finding names %q, want the Browser client", f.clientID)
	}
}

// The control. Without it this passes against a probe that reports every realm.
func TestPublicClientsDoNotReportImplicitWhenDisabled(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{})
	if f, ok := implicitFinding(verifyPublicClients(srv.URL)); ok {
		t.Fatalf("a realm refusing response_type=token was reported: %q", f.reason)
	}
}

func implicitFinding(findings []publicClientFinding) (publicClientFinding, bool) {
	for _, f := range findings {
		if strings.Contains(strings.ToLower(f.reason), "implicit") {
			return f, true
		}
	}
	return publicClientFinding{}, false
}

// `semiont start --service browser --port N` moves the Browser to a port the
// realm may not redirect to. The portless loopback entry (RFC 8252 §7.3) is
// what makes any port work, and it is exactly what a realm imported before
// that line, or edited by hand, does not have. Without this check the port
// move succeeds, the Browser is healthy, and nobody can sign in.
func TestBrowserRedirectRefusedOnAPinnedRealm(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{pinnedPort: true})
	if _, bad := verifyBrowserRedirect(srv.URL, 61234); !bad {
		t.Fatal("a realm pinned to :3000 accepted a move to :61234")
	}
	if _, bad := verifyBrowserRedirect(srv.URL, 3000); bad {
		t.Error("the port the realm DOES accept was reported")
	}
}

// An issuer nobody can reach is not evidence the realm pins the port. The
// Browser belongs to no stack, so moving it with nothing running is ordinary
// and must not be refused on a probe that never got an answer.
func TestBrowserRedirectDoesNotBlockOnAnUnreachableIssuer(t *testing.T) {
	if f, bad := verifyBrowserRedirect("http://127.0.0.1:1/unreachable", 61234); bad {
		t.Fatalf("an unreachable issuer blocked the port move: %q", f.reason)
	}
}

// A realm registered portlessly takes any port — the whole point of §7.3.
func TestBrowserRedirectAcceptedOnAPortlessRealm(t *testing.T) {
	srv := stubPublicIssuer(t, publicStub{})
	if f, bad := verifyBrowserRedirect(srv.URL, 61234); bad {
		t.Fatalf("a portless realm refused :61234: %q", f.reason)
	}
}

// GATE: no path that handles the six service-account secrets may ever echo one.
//
// This is the one place in the launcher holding all six at once, and both the
// refusal and the repair render operator-facing text from data derived from
// them. A leak here lands in a terminal, a CI log, and whatever the operator
// pastes into an issue.
func TestNoServiceAccountSecretIsEverPrinted(t *testing.T) {
	const marker = "SECRET-THAT-MUST-NOT-APPEAR"
	secrets := map[string]string{}
	for _, svc := range serviceClients {
		secrets[svc] = marker + "-" + svc
	}

	// A realm that refuses every grant: the maximal-findings case.
	srv := stubIssuer(t, func(string) (int, string) {
		return 401, `{"error":"invalid_client"}`
	})
	findings, _ := verifyServiceAccounts(srv.URL, "semiont-gateway", secrets)
	if len(findings) == 0 {
		t.Fatal("a realm refusing every grant produced no findings; this gate would prove nothing")
	}
	for _, f := range findings {
		if strings.Contains(f.String(), marker) {
			t.Errorf("a refusal echoed a client secret: %q", f.String())
		}
	}

	// The repair renders its own operator-facing lines from the same secrets.
	admin := newStubAdmin(t, "semiont", nil)
	rep, err := syncRealm(admin.srv.URL, "semiont", "admin", "pw", "semiont-gateway", 300,
		func(svc string) string { return secrets[svc] })
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	for _, line := range slices.Concat(rep.created, rep.present, rep.updated) {
		if strings.Contains(line, marker) {
			t.Errorf("the sync report echoed a client secret: %q", line)
		}
	}
}
