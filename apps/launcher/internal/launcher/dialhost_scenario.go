//go:build scenario

package launcher

// fakeHostAddress: the host address the fake runtime reports under Apple
// container (internal/fakert answers `ip route` with it). The machine running
// the scenario suite holds no such address.
const fakeHostAddress = "192.168.64.1"

// dialHost, in a launcher built for the scenario suite (-tags scenario): a
// dial of the fake runtime's host address goes to loopback, where the fake's
// stand-in services listen. Every other host is dialed as given. A released
// launcher has no such redirect.
func dialHost(host string) string {
	if host == fakeHostAddress {
		return "127.0.0.1"
	}
	return host
}
