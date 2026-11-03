package launcher

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// The proxy passes the paths of the realms it serves and Keycloak's assets,
// and nothing else: not the admin console or API, not the master realm, not a
// realm it does not serve, and not a path that walks out of a realm once
// cleaned (Keycloak's reverse-proxy guide).
func TestIssuerProxyPassesItsRealmsAlone(t *testing.T) {
	realms := []string{"example.github.io-a", "example.github.io-b"}
	for _, realm := range realms {
		for _, p := range []string{
			"/realms/" + realm,
			"/realms/" + realm + "/",
			"/realms/" + realm + "/.well-known/openid-configuration",
			"/realms/" + realm + "/protocol/openid-connect/auth",
			"/realms/" + realm + "/protocol/openid-connect/token",
			"/realms/" + realm + "/protocol/openid-connect/certs",
			"/realms/" + realm + "/login-actions/authenticate",
		} {
			if !issuerPathAllowed(realms, p) {
				t.Errorf("the proxy refuses %s, which sign-in needs", p)
			}
		}
	}
	if !issuerPathAllowed(realms, "/resources/abc12/login/keycloak.v2/css/styles.css") {
		t.Error("the proxy refuses Keycloak's assets, which its sign-in pages load")
	}
	for _, p := range []string{
		"/",
		"/admin/",
		"/admin/master/console/",
		"/admin/realms/example.github.io-a/users",
		"/realms/master/protocol/openid-connect/token",
		"/realms/example.github.io-c/protocol/openid-connect/token",
		"/realms/example.github.io-ax/protocol/openid-connect/token",
		"/realms/example.github.io-a/../master/protocol/openid-connect/token",
		"/realms/example.github.io-a/../example.github.io-c/protocol/openid-connect/token",
		"/realms/example.github.io-b/./protocol/openid-connect/token",
		"/resources/../admin/master/console/",
		"/resources",
		"/metrics",
		"/health",
		"//admin/",
	} {
		if issuerPathAllowed(realms, p) {
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
	proxy := httptest.NewServer(issuerProxyHandler(target, []string{"semiont"}))
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

// The proxy's own arguments. Any it cannot serve with is a usage error, said
// before it listens: the start that spawned it reports the proxy's own line.
func TestIssuerProxyRefusesArgumentsItCannotServeWith(t *testing.T) {
	for _, c := range []struct {
		name string
		args []string
	}{
		{"an unknown flag", []string{"--realm", "semiont", "--port", "8080"}},
		{"a flag without a value", []string{"--listen"}},
		{"a required flag missing", []string{"--listen", "127.0.0.1:8080", "--upstream", "127.0.0.1:18080"}},
		{"a --listen that is not host:port", []string{"--listen", "8080", "--upstream", "127.0.0.1:18080", "--realm", "semiont"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, stderr := harness.CaptureOutput(t, func() {
				if code := IssuerProxy(c.args); code != 64 {
					t.Errorf("exit %d, want 64", code)
				}
			})
			harness.MustContainAll(t, "stderr", stderr, "issuer proxy:")
		})
	}
}

// A port the proxy cannot take ends it at once, saying why.
func TestIssuerProxyEndsOnAPortItCannotTake(t *testing.T) {
	held, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	_, stderr := harness.CaptureOutput(t, func() {
		if code := IssuerProxy([]string{"--listen", held.Addr().String(), "--upstream", "127.0.0.1:18080", "--realm", "semiont"}); code != 1 {
			t.Errorf("exit %d, want 1", code)
		}
	})
	harness.MustContainAll(t, "stderr", stderr, "issuer proxy:")
}
