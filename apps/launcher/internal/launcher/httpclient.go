package launcher

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// launcherTransport carries every HTTP request the launcher makes. A host that
// is `localhost` or ends in `.localhost` is loopback by rule (RFC 6761). Browsers
// apply the rule; Go's resolver asks the system, and a minimal Linux host answers
// nothing for keycloak.localhost, the issuer of a Docker or Podman stack. So the
// launcher dials those names at loopback itself, 127.0.0.1 first and then ::1,
// and never through a proxy, which cannot reach this machine's loopback. Every
// other name resolves as before.
var launcherTransport = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil || !isLocalhostName(host) {
			return dialer.DialContext(ctx, network, addr)
		}
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
		if err == nil {
			return conn, nil
		}
		if conn6, err6 := dialer.DialContext(ctx, network, net.JoinHostPort("::1", port)); err6 == nil {
			return conn6, nil
		}
		return nil, err
	}
	t.Proxy = func(r *http.Request) (*url.URL, error) {
		if isLocalhostName(r.URL.Hostname()) {
			return nil, nil
		}
		return http.ProxyFromEnvironment(r)
	}
	return t
}()

func isLocalhostName(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "localhost" || strings.HasSuffix(host, ".localhost")
}
