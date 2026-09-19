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
func verifyServiceAccounts(issuerBase, audience string, secrets map[string]string) []serviceAccountFinding {
	endpoint, err := discoverTokenEndpoint(issuerBase)
	if err != nil {
		// One finding, not six: the issuer is the common cause, and six copies
		// of the same sentence buries it.
		return []serviceAccountFinding{{
			svc:    serviceClients[0],
			reason: fmt.Sprintf("OIDC discovery at %s failed: %v", issuerBase, err),
			fix:    "is the issuer reachable from this host?",
		}}
	}

	var findings []serviceAccountFinding
	for _, svc := range serviceClients {
		claims, err := serviceAccountClaims(endpoint, serviceClientID(svc), secrets[svc])
		if err != nil {
			findings = append(findings, serviceAccountFinding{
				svc:    svc,
				reason: err.Error(),
				fix:    "the realm has no such client, or its secret differs from the one this start would inject",
			})
			continue
		}
		if f, bad := checkServiceAccountClaims(svc, claims, audience); bad {
			findings = append(findings, f)
		}
	}
	return findings
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
	if !audienceContains(claims["aud"], audience) {
		return serviceAccountFinding{
			svc:    svc,
			reason: fmt.Sprintf("token's `aud` does not carry this knowledge base's resource identity (%s)", audience),
			fix:    "the realm's audience mapper names a different knowledge base",
		}, true
	}
	return serviceAccountFinding{}, false
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

// discoverTokenEndpoint reads `token_endpoint` from the issuer's discovery
// document. Discovered rather than constructed: every issuer publishes it, and
// guessing a vendor's path would put that vendor's layout in a launcher that
// has no other reason to know it.
func discoverTokenEndpoint(issuerBase string) (string, error) {
	base := strings.TrimSuffix(issuerBase, "/")
	resp, err := preflightHTTP.Get(base + "/.well-known/openid-configuration")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var doc struct {
		TokenEndpoint string `json:"token_endpoint"`
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || json.Unmarshal(b, &doc) != nil || doc.TokenEndpoint == "" {
		return "", fmt.Errorf("discovery document names no token_endpoint")
	}
	return doc.TokenEndpoint, nil
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
