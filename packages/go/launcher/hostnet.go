//go:build !scenario

package launcher

import (
	"fmt"
	"net"
	"strings"
)

// hostnet.go — the launcher's view of this machine's network: where a dial
// goes, where a listener binds, and the machine's address on the network. A
// released launcher uses the machine as it is; only the scenario suite's build
// stands in for it (hostnet_scenario.go).

// dialHost: the host a dial of host goes to.
func dialHost(host string) string {
	return host
}

// listenHost: the host a listener asked to bind host binds.
func listenHost(host string) string {
	return host
}

// lanAddress: this Mac's address on the network, read afresh at every
// `network lan` start (D3a): the IPv4 address of the interface the default
// route leaves by.
func lanAddress() (string, error) {
	out, err := capture("route", "-n", "get", "default")
	if err != nil {
		return "", fmt.Errorf("`route -n get default` failed: %v", err)
	}
	iface := ""
	for _, line := range strings.Split(out, "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "interface:"); ok {
			iface = strings.TrimSpace(rest)
		}
	}
	if iface == "" {
		return "", fmt.Errorf("`route -n get default` names no interface: is this machine on a network?")
	}
	ifc, err := net.InterfaceByName(iface)
	if err != nil {
		return "", fmt.Errorf("the default route leaves by %s, which cannot be read: %v", iface, err)
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return "", fmt.Errorf("the addresses of %s cannot be read: %v", iface, err)
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.To4() != nil && !ipnet.IP.IsLoopback() {
			return ipnet.IP.String(), nil
		}
	}
	return "", fmt.Errorf("%s, which the default route leaves by, has no IPv4 address", iface)
}
