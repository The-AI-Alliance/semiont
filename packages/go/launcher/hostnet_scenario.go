//go:build scenario

package launcher

// hostnet_scenario.go — the machine's network as the scenario suite's build
// (-tags scenario) sees it. Neither address below is held by the machine
// running the suite, so a dial of either goes to loopback, where the fake
// runtime's stand-in services listen, and a listener asked for the network
// address binds loopback. A released launcher has none of this (hostnet.go).

// fakeHostAddress: the host address the fake runtime reports under Apple
// container (fakert answers `ip route` with it).
const fakeHostAddress = "192.168.64.1"

// fakeLANAddress: the address a `network lan` start reads as this machine's
// on the network.
const fakeLANAddress = "192.168.2.10"

func dialHost(host string) string {
	if host == fakeHostAddress || host == fakeLANAddress {
		return "127.0.0.1"
	}
	return host
}

func listenHost(host string) string {
	if host == fakeLANAddress {
		return "127.0.0.1"
	}
	return host
}

func lanAddress() (string, error) {
	return fakeLANAddress, nil
}
