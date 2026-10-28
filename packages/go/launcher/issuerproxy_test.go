package launcher

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// The proxy passes the realm's own paths and Keycloak's assets, and nothing
// else: not the admin console or API, not the master realm, not another realm,
// and not a path that walks out of the realm once cleaned (Keycloak's
// reverse-proxy guide; LOCAL-ONLY-STACK D3b-A1).
func TestIssuerProxyPassesTheRealmAlone(t *testing.T) {
	for _, p := range []string{
		"/realms/semiont",
		"/realms/semiont/",
		"/realms/semiont/.well-known/openid-configuration",
		"/realms/semiont/protocol/openid-connect/auth",
		"/realms/semiont/protocol/openid-connect/token",
		"/realms/semiont/protocol/openid-connect/certs",
		"/realms/semiont/login-actions/authenticate",
		"/resources/abc12/login/keycloak.v2/css/styles.css",
	} {
		if !issuerPathAllowed("semiont", p) {
			t.Errorf("the proxy refuses %s, which sign-in needs", p)
		}
	}
	for _, p := range []string{
		"/",
		"/admin/",
		"/admin/master/console/",
		"/admin/realms/semiont/users",
		"/realms/master/protocol/openid-connect/token",
		"/realms/semiontx/protocol/openid-connect/token",
		"/realms/semiont/../master/protocol/openid-connect/token",
		"/realms/semiont/./protocol/openid-connect/token",
		"/resources/../admin/master/console/",
		"/resources",
		"/metrics",
		"/health",
		"//admin/",
	} {
		if issuerPathAllowed("semiont", p) {
			t.Errorf("the proxy passes %s", p)
		}
	}
}

// What the proxy passes reaches Keycloak with the Host its caller asked:
// Keycloak names the endpoints behind its fixed hostname at the address a
// request asked, so a caller on the network must be answered with endpoints
// at the network address, not at the bridge address the proxy dials. What it
// refuses reaches Keycloak not at all.
func TestIssuerProxyKeepsTheHostItWasAskedAndPassesNothingElse(t *testing.T) {
	var gotHost, gotPath string
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		gotHost, gotPath = r.Host, r.URL.Path
		_, _ = io.WriteString(w, "keycloak")
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(issuerProxyHandler(target, "semiont"))
	defer proxy.Close()

	ask := func(path string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, proxy.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = lanAddr + ":8080"
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}

	if resp := ask("/realms/semiont/.well-known/openid-configuration"); resp.StatusCode != http.StatusOK {
		t.Fatalf("discovery through the proxy answered %d", resp.StatusCode)
	}
	if gotHost != lanAddr+":8080" {
		t.Errorf("Keycloak was asked with Host %q, want the one the caller asked, %s:8080", gotHost, lanAddr)
	}
	if gotPath != "/realms/semiont/.well-known/openid-configuration" {
		t.Errorf("Keycloak was asked for %q", gotPath)
	}

	before := calls
	for _, path := range []string{"/admin/master/console/", "/realms/master/protocol/openid-connect/token", "/realms/semiont%2F..%2Fmaster/protocol/openid-connect/token"} {
		if resp := ask(path); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s through the proxy answered %d, want 404", path, resp.StatusCode)
		}
	}
	if calls != before {
		t.Errorf("a refused path reached Keycloak %d time(s)", calls-before)
	}
}
