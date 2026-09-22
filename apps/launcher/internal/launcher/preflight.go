package launcher

// preflight.go — prove the service accounts work BEFORE anything tries to use
// them (IDENTITY-PREFLIGHT P1).
//
// Until the shared worker secret was retired, there was nothing here a check
// could have discovered: the launcher generated one value and injected it in
// the same act, so both sides agreed by construction. Now the credential lives
// in two stores with independent lifecycles — a file per root, and a realm
// written by an import that runs on FIRST BOOT AND NEVER AGAIN — and the
// token's SHAPE matters as well as its value.
//
// So a start can hand six services credentials the realm has never seen, and
// the only symptom is six services failing to authenticate with nothing
// obviously wrong in the config. This turns that into one refusal that names
// the client and the likely cause.
//
// It does NOT verify signatures. That is the gateway's job, against the
// issuer's published keys; this is a configuration check and decodes the
// token without trusting it.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// serviceAccountFinding: one service client's reason for refusal. A finding
// exists only when something is wrong — a clean realm produces none.
type serviceAccountFinding struct {
	svc    string // the bare service name, e.g. "weaver"
	reason string
	fix    string // what an operator does about it; may be empty
}

func (f serviceAccountFinding) String() string {
	s := serviceClientID(f.svc) + ": " + f.reason
	if f.fix != "" {
		s += " — " + f.fix
	}
	return s
}

// preflightHTTP: short. The realm answered its own health gate moments ago, so
// a slow answer here is a symptom, not something to wait out.
var preflightHTTP = &http.Client{Timeout: 10 * time.Second}

// preflightNoRedirect: the same, for the authorization probe. See
// authorizationProbe on why a redirect must not be followed.
var preflightNoRedirect = &http.Client{
	Timeout:       10 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// verifyServiceAccounts performs the client-credentials grant for every entry
// in `serviceClients` against `issuerBase`, and checks what comes back.
//
// `issuerBase` is the realm as THIS PROCESS can reach it, which for a
// launcher-run Keycloak is localhost and for an external issuer is the
// configured URL. Deliberately not compared against the token's `iss`: a
// Keycloak token is stamped with the URL it was requested FROM, so the
// services — which ask through ${KEYCLOAK_HOST} — get an `iss` matching their
// own configuration whatever this function used. Checking it here would
// refuse a healthy realm.
func verifyServiceAccounts(issuerBase, audience string, secrets map[string]string) ([]serviceAccountFinding, int) {
	eps, err := discoverEndpoints(issuerBase)
	endpoint := eps.token
	if err != nil {
		// One finding, not six: the issuer is the common cause, and six copies
		// of the same sentence buries it.
		return []serviceAccountFinding{{
			svc:    serviceClients[0],
			reason: fmt.Sprintf("OIDC discovery at %s failed: %v", issuerBase, err),
			fix:    "is the issuer reachable from this host?",
		}}, 0
	}

	var findings []serviceAccountFinding
	observedLifespan := 0
	for _, svc := range serviceClients {
		claims, err := serviceAccountClaims(endpoint, serviceClientID(svc), secrets[svc])
		if err != nil {
			findings = append(findings, serviceAccountFinding{
				svc:    svc,
				reason: err.Error(),
				// Two causes, and the grant cannot tell them apart: Keycloak
				// answers `invalid_client` for both. Naming both here and
				// resolving them in the steps below is the honest shape —
				// see preflightIdentity, where the remedy differs per cause.
				fix: "the realm has no such client, or its secret differs",
			})
			continue
		}
		if observedLifespan == 0 {
			observedLifespan = tokenLifespan(claims)
		}
		if f, bad := checkServiceAccountClaims(svc, claims, audience); bad {
			findings = append(findings, f)
		}
	}
	return findings, observedLifespan
}

// tokenLifespan: `exp - iat`, the lifetime the realm actually stamped. 0 when
// either claim is missing or the arithmetic is nonsense.
//
// This is the only reading of the realm's accessTokenLifespan available without
// administrator credentials, and it is a faithful one for THESE tokens: a
// client-credentials grant has no session behind it, so nothing caps the
// lifetime below the realm's setting the way an SSO idle timeout can for a
// person's token. The clients the launcher writes set no per-client override.
func tokenLifespan(claims map[string]any) int {
	num := func(k string) (int, bool) {
		f, ok := claims[k].(float64) // encoding/json decodes every number as float64
		return int(f), ok
	}
	iat, okIat := num("iat")
	exp, okExp := num("exp")
	if !okIat || !okExp || exp <= iat {
		return 0
	}
	return exp - iat
}

// checkServiceAccountClaims: the two assertions that decide whether a token
// this realm mints will be ACCEPTED by the services that receive it.
func checkServiceAccountClaims(svc string, claims map[string]any, audience string) (serviceAccountFinding, bool) {
	if !flatRolesContain(claims["roles"], serviceRole) {
		reason := fmt.Sprintf("token carries no flat `roles` array containing %q", serviceRole)
		fix := "the realm's hardcoded-claim mapper for this client"
		if nested, ok := claims["realm_access"].(map[string]any); ok && flatRolesContain(nested["roles"], serviceRole) {
			// Naming this case is the point: it is the one wrong shape that
			// looks right in the Keycloak console.
			reason = "token carries " + serviceRole + " in the NESTED realm_access.roles, not the flat `roles` claim the gateway reads"
			fix = "fix the client's hardcoded-claim mapper (claim.name must be `roles`)"
		}
		return serviceAccountFinding{svc: svc, reason: reason, fix: fix}, true
	}
	// Every further role the realm document stamps on THIS client — today the
	// worker's, which the dispatcher admits a job:claim by. Derived from the
	// function that renders the mapper, so a role added there is asked for here
	// without a second list to forget. A realm imported before the role holds
	// the mapper rendering only the service role: the worker authenticates and
	// can never claim a job — a broken deployment, so a refusal, not a warning.
	for _, role := range serviceRoles(svc) {
		if role == serviceRole || flatRolesContain(claims["roles"], role) {
			continue
		}
		reason := fmt.Sprintf("token's flat `roles` lacks %q, which the realm document stamps on this client", role)
		if role == workerRole {
			reason += " — this worker can never claim a job"
		}
		return serviceAccountFinding{
			svc:    svc,
			reason: reason,
			fix:    fmt.Sprintf("the realm's hardcoded-claim mapper for this client does not render %q — a realm imported before that role", role),
		}, true
	}
	if !audienceContains(claims["aud"], audience) {
		return serviceAccountFinding{
			svc:    svc,
			reason: fmt.Sprintf("token's `aud` does not carry this knowledge base's resource identity (%s)", audience),
			fix:    "the realm's audience mapper names a different knowledge base",
		}, true
	}
	return serviceAccountFinding{}, false
}

// publicClientFinding: one human-facing client's problem. `warnOnly` findings
// describe a realm that works but is older than a change to it — the stack runs,
// so saying so and continuing beats refusing to start an otherwise healthy
// deployment.
type publicClientFinding struct {
	clientID string
	reason   string
	fix      string
	warnOnly bool
}

func (f publicClientFinding) String() string {
	s := f.clientID + ": " + f.reason
	if f.fix != "" {
		s += " — " + f.fix
	}
	return s
}

// probeRedirect: the loopback callback the browser client must accept. Any port
// would do — the realm matches this as a string and nothing listens on it
// during the probe — but the one a default start uses is the honest choice.
const probeRedirect = "http://localhost:3000/en/auth/callback"

// The two response types these probes ask for. `code` is the flow the Browser
// must use; `token` is the one it must not be offered.
const (
	responseCode  = "code"
	responseToken = "token"
)

// probeRedirectOtherPort: the same callback on a port no default start uses.
// A realm that registers loopback WITHOUT a port (RFC 8252 §7.3, which is what
// keycloakRealmJSON writes) accepts this; one that pins `localhost:3000` does
// not. So a rejection here dates the realm rather than condemning it.
const probeRedirectOtherPort = "http://localhost:61234/en/auth/callback"

// verifyBrowserRedirect: can this realm redirect to the port the Browser is
// about to move to?
//
// `--service browser --port N` is the one flow that changes the redirect URI
// without touching the realm, and until this existed it was also the one flow
// that never asked. The loopback entries are registered PORTLESS so any port
// matches (RFC 8252 §7.3) — but a realm imported before that line, or edited
// by hand, pins :3000, and then the move produces a healthy Browser nobody can
// sign in to. `verifyPublicClients` reports the same condition as a WARNING,
// because a stack on the default port still works; here the operator has
// asked for the port that does not, so it refuses.
//
// Narrow on purpose: this flow starts no service account and no CLI, so it
// checks the one thing it is about to change.
// Refuses ONLY on a positive answer: the realm was asked and declined. Every
// other outcome — issuer unreachable, no authorization endpoint, probe error —
// is "cannot tell", and cannot tell must not block. The Browser is
// machine-level and belongs to no stack (BROWSER-LIFECYCLE), so moving it with
// nothing running is ordinary; refusing then would make an absent realm a
// reason not to move a viewer that does not need one yet.
func verifyBrowserRedirect(issuerBase string, port int) (publicClientFinding, bool) {
	eps, err := discoverEndpoints(issuerBase)
	if err != nil || eps.authorization == "" {
		return publicClientFinding{}, false
	}
	redirect := fmt.Sprintf("http://localhost:%d/en/auth/callback", port)
	code, err := authorizationProbe(eps.authorization, browserClientID, redirect, responseCode, withPKCE)
	if err != nil || code == http.StatusOK {
		return publicClientFinding{}, false // unreachable, or accepted
	}
	return publicClientFinding{
		clientID: browserClientID,
		reason:   fmt.Sprintf("the realm will not redirect to %s (HTTP %d)", redirect, code),
		fix:      fmt.Sprintf("this realm pins the Browser to :3000 — it predates the portless loopback redirect (RFC 8252 §7.3). Re-import it, add `http://localhost/*` to the client, or run `semiont identity sync`; the Browser would start on :%d and no one could sign in", port),
	}, true
}

// verifyPublicClients proves the two clients PEOPLE authenticate through.
//
// verifyServiceAccounts covers the six machine identities and says nothing about
// whether anyone can log in: a realm missing `semiont-browser` passes it and
// starts a stack nobody can reach. These clients are public — no secret, so no
// client-credentials grant to run — and are instead probed on the very endpoints
// a real sign-in uses, with no credential involved.
//
// Existence is decided by the DEVICE endpoint for both, because it answers JSON
// with documented OAuth error codes: `invalid_client` means the realm has no
// such client, while a client that exists but may not use the grant is refused
// as `unauthorized_client`. That distinction is unavailable from the
// authorization endpoint, which renders an HTML error page for either.
func verifyPublicClients(issuerBase string) []publicClientFinding {
	eps, err := discoverEndpoints(issuerBase)
	if err != nil {
		return []publicClientFinding{{
			clientID: browserClientID,
			reason:   fmt.Sprintf("OIDC discovery at %s failed: %v", issuerBase, err),
			fix:      "is the issuer reachable from this host?",
		}}
	}

	var findings []publicClientFinding

	// `semiont-cli` — the device grant, which is how a script or the launcher
	// itself signs a person in. 200 is the only passing answer: it means the
	// client exists AND may use the grant.
	if eps.device == "" {
		findings = append(findings, publicClientFinding{
			clientID: cliClientID,
			reason:   "the issuer publishes no device_authorization_endpoint",
			fix:      "`semiont login` cannot work against this issuer",
		})
	} else {
		switch code, oauthErr, err := deviceGrantProbe(eps.device, cliClientID); {
		case err != nil:
			findings = append(findings, publicClientFinding{clientID: cliClientID, reason: err.Error()})
		case code == http.StatusOK:
			// exists, and the grant is enabled
		case oauthErr == "invalid_client":
			findings = append(findings, publicClientFinding{
				clientID: cliClientID,
				reason:   "the realm has no such client",
				fix:      "a realm imported before this client existed will not have it",
			})
		default:
			findings = append(findings, publicClientFinding{
				clientID: cliClientID,
				reason:   fmt.Sprintf("device authorization refused (HTTP %d, %s)", code, oauthErr),
				fix:      "the client exists but may not use the device grant",
			})
		}
	}

	// `semiont-browser` — existence first, so a missing client is not reported
	// as a redirect problem.
	browserExists := true
	if eps.device != "" {
		if _, oauthErr, err := deviceGrantProbe(eps.device, browserClientID); err == nil && oauthErr == "invalid_client" {
			browserExists = false
			findings = append(findings, publicClientFinding{
				clientID: browserClientID,
				reason:   "the realm has no such client",
				fix:      "a realm imported before this client existed will not have it; nobody can sign in from a browser",
			})
		}
	}

	if browserExists && eps.authorization == "" {
		findings = append(findings, publicClientFinding{
			clientID: browserClientID,
			reason:   "the issuer publishes no authorization_endpoint",
			fix:      "nobody could sign in from a browser against this issuer",
		})
	} else if browserExists {
		if code, err := authorizationProbe(eps.authorization, browserClientID, probeRedirect, responseCode, withPKCE); err != nil {
			findings = append(findings, publicClientFinding{clientID: browserClientID, reason: err.Error()})
		} else if code != http.StatusOK {
			findings = append(findings, publicClientFinding{
				clientID: browserClientID,
				reason:   fmt.Sprintf("the realm will not redirect to %s (HTTP %d)", probeRedirect, code),
				fix:      "its registered redirect URIs do not cover the Browser; sign-in would fail at the issuer",
			})
		} else {
			if code, err := authorizationProbe(eps.authorization, browserClientID, probeRedirectOtherPort, responseCode, withPKCE); err == nil && code != http.StatusOK {
				findings = append(findings, publicClientFinding{
					clientID: browserClientID,
					warnOnly: true,
					reason:   "the realm pins the Browser to port 3000",
					fix:      "`--port` will not work: this realm predates the portless loopback redirect (RFC 8252 §7.3). Re-import it, or add `http://localhost/*` to the client",
				})
			}
			// PKCE must be REQUIRED, not merely supported. A realm that
			// enforces it answers an authorization request carrying no code
			// challenge with an error; one that does not serves the login page,
			// and the code flow is then interceptable for a public client that
			// holds no secret.
			// The IMPLICIT flow returns the access token in the redirect
			// FRAGMENT, where browser history and any script on the page can
			// read it. A realm with it disabled refuses `response_type=token`
			// outright; one that allows it serves the login page. Fatal rather
			// than a warning: its neighbours here describe a realm that is
			// merely behind, while this one is a live way to leak a bearer
			// token, and a stack that starts is a stack that leaks it.
			if code, err := authorizationProbe(eps.authorization, browserClientID, probeRedirect, responseToken, withoutPKCE); err == nil && code == http.StatusOK {
				findings = append(findings, publicClientFinding{
					clientID: browserClientID,
					reason:   "the realm allows the IMPLICIT flow — an authorization request with response_type=token is accepted",
					fix:      "set `implicitFlowEnabled` to false on this client; the access token would come back in a redirect fragment rather than through the code exchange",
				})
			}
			if code, err := authorizationProbe(eps.authorization, browserClientID, probeRedirect, responseCode, withoutPKCE); err == nil && code == http.StatusOK {
				findings = append(findings, publicClientFinding{
					clientID: browserClientID,
					warnOnly: true,
					reason:   "the realm does not REQUIRE PKCE — an authorization request carrying no code challenge is accepted",
					fix:      "set `pkce.code.challenge.method` to S256 on the client; this client holds no secret, so PKCE is what binds the code to its requester",
				})
			}
		}
	}

	// Neither client may accept a password at the token endpoint. The
	// resource-owner grant hands a public client someone's password directly —
	// no browser, nothing phishing-resistant, and it walks straight past the
	// realm's required actions, including the first-sign-in profile form.
	for _, id := range []string{browserClientID, cliClientID} {
		oauthErr, err := directAccessGrantProbe(eps.token, id)
		if err != nil || oauthErr == "unauthorized_client" {
			continue // unreachable, or correctly refused
		}
		findings = append(findings, publicClientFinding{
			clientID: id,
			warnOnly: true,
			reason:   "the realm allows the resource-owner password grant for this client",
			fix:      "turn off direct access grants; a public client should never take a password",
		})
	}
	return findings
}

// Named for the call sites: authorizationProbe(…, withPKCE) reads, a bare
// `true` does not.
const (
	withPKCE    = true
	withoutPKCE = false
)

// directAccessGrantProbe asks the token endpoint for the resource-owner
// password grant as `clientID`, sending NO username and NO password. Returns
// the `error` field of the JSON body.
//
// The absence is what makes this safe AND sufficient: a client forbidden the
// grant is refused as `unauthorized_client` before the missing credentials are
// ever looked at, while a client allowed it gets as far as complaining that
// `username` is missing. So the answer separates the two without a credential
// — real or invented — being sent anywhere.
func directAccessGrantProbe(tokenEndpoint, clientID string) (string, error) {
	resp, err := preflightHTTP.PostForm(tokenEndpoint, url.Values{
		"grant_type": {"password"},
		"client_id":  {clientID},
	})
	if err != nil {
		return "", fmt.Errorf("password-grant probe failed: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		Error string `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = json.Unmarshal(b, &body)
	return body.Error, nil
}

// deviceGrantProbe asks the device endpoint for a code as `clientID`, with no
// credential. Returns the status and the `error` field of the JSON body.
//
// A passing probe leaves a device code pending at the issuer. Nothing redeems
// it and it expires on its own — the cost of proving the grant works is one
// unused code per start.
func deviceGrantProbe(endpoint, clientID string) (int, string, error) {
	resp, err := preflightHTTP.PostForm(endpoint, url.Values{"client_id": {clientID}})
	if err != nil {
		return 0, "", fmt.Errorf("device authorization request failed: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		Error string `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = json.Unmarshal(b, &body)
	return resp.StatusCode, body.Error, nil
}

// authorizationProbe issues the authorization request a browser sign-in starts
// with, and reports the status. 200 is the login page: the client resolved and
// the redirect URI is registered.
//
// Redirects are NOT followed. Some authorization errors are returned by
// redirecting to the registered callback, and following that would have the
// launcher issue a request against the Browser's own port mid-start.
func authorizationProbe(endpoint, clientID, redirectURI, responseType string, pkce bool) (int, error) {
	q := url.Values{
		"response_type": {responseType},
		"scope":         {"openid"},
		"client_id":     {clientID},
		"redirect_uri":  {redirectURI},
	}
	if pkce {
		// A syntactically valid S256 challenge. Never redeemed: this request is
		// abandoned at the login page, so the verifier behind it is irrelevant.
		q.Set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
		q.Set("code_challenge_method", "S256")
	}
	req, err := http.NewRequest(http.MethodGet, endpoint+"?"+q.Encode(), nil)
	if err != nil {
		return 0, err
	}
	resp, err := preflightNoRedirect.Do(req)
	if err != nil {
		return 0, fmt.Errorf("authorization request failed: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, nil
}

// flatRolesContain: `roles` as a flat array of strings, the vendor-neutral
// shape the gateway reads. JSON numbers and objects in the array are simply
// not the role, so they do not match.
func flatRolesContain(claim any, want string) bool {
	arr, ok := claim.([]any)
	if !ok {
		return false
	}
	for _, v := range arr {
		if s, ok := v.(string); ok && s == want {
			return true
		}
	}
	return false
}

// audienceContains: `aud` is an array OR a single string — both legal, and
// Keycloak emits the array form with its own "account" alongside ours. So
// membership, never equality.
func audienceContains(claim any, want string) bool {
	switch v := claim.(type) {
	case string:
		return v == want
	case []any:
		for _, a := range v {
			if s, ok := a.(string); ok && s == want {
				return true
			}
		}
	}
	return false
}

// oidcEndpoints: the three endpoints this preflight uses, as the issuer
// publishes them.
type oidcEndpoints struct {
	token         string
	authorization string
	device        string
}

// discoverEndpoints reads the issuer's discovery document. Discovered rather
// than constructed: every issuer publishes these, and guessing a vendor's paths
// would put that vendor's layout in a launcher that has no other reason to know
// it.
//
// Only `token_endpoint` is required. An issuer that publishes no device
// endpoint cannot serve `semiont login`, but that is a finding for the check
// that needs it to report, not a reason discovery itself fails.
func discoverEndpoints(issuerBase string) (oidcEndpoints, error) {
	base := strings.TrimSuffix(issuerBase, "/")
	resp, err := preflightHTTP.Get(base + "/.well-known/openid-configuration")
	if err != nil {
		return oidcEndpoints{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return oidcEndpoints{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var doc struct {
		TokenEndpoint string `json:"token_endpoint"`
		AuthEndpoint  string `json:"authorization_endpoint"`
		DeviceEnder   string `json:"device_authorization_endpoint"`
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || json.Unmarshal(b, &doc) != nil || doc.TokenEndpoint == "" {
		return oidcEndpoints{}, fmt.Errorf("discovery document names no token_endpoint")
	}
	return oidcEndpoints{token: doc.TokenEndpoint, authorization: doc.AuthEndpoint, device: doc.DeviceEnder}, nil
}

// serviceAccountClaims runs the grant and decodes what comes back.
//
// Errors carry the STATUS and never the body: a token endpoint's error body
// can echo the request, and this request carried a client secret.
func serviceAccountClaims(tokenEndpoint, clientID, clientSecret string) (map[string]any, error) {
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {clientID},
		"client_secret": {clientSecret},
	}
	resp, err := preflightHTTP.PostForm(tokenEndpoint, form)
	if err != nil {
		return nil, fmt.Errorf("client-credentials grant failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("client-credentials grant refused (HTTP %d)", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || json.Unmarshal(b, &body) != nil || body.AccessToken == "" {
		return nil, fmt.Errorf("token endpoint returned no access_token")
	}
	return decodeJWTClaims(body.AccessToken)
}

// decodeJWTClaims: base64 on the middle segment, no signature check and no new
// dependency. A client-credentials access token is not REQUIRED to be a JWT,
// so a token that is not one is reported as such rather than assumed broken.
func decodeJWTClaims(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("access token is not a JWT, so its claims cannot be checked here")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("access token's claims are not valid base64url")
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, fmt.Errorf("access token's claims are not valid JSON")
	}
	return claims, nil
}
