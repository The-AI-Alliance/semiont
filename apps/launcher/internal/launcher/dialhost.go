//go:build !scenario

package launcher

// dialHost: the host a dial of host goes to. A released launcher dials what it
// is given; only the scenario suite's build redirects (dialhost_scenario.go).
func dialHost(host string) string {
	return host
}
