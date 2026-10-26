package launcher

import "fmt"

// exposure.go — who dials each port the stack publishes, and so where it is
// published and where the launcher asks for it (LOCAL-ONLY-STACK).
//
// Under Apple container (D1-A) nothing is published on an interface the
// network can reach: a port a person dials is published on loopback, and a
// port a container dials on the host's bridge address, which containers and
// the host reach and the network does not. Under Docker and Podman every
// port is still published on every interface, until D1 is ruled for them.
//
// With `semiont settings network lan` (D3), the network reaches two things
// more: the gateway, published on every interface, and the issuer, at this
// Mac's address on the network, served by the launcher's filtering proxy
// (issuerproxy.go) with Keycloak behind it on the bridge address.

// reach: who dials a port.
type reach int

const (
	reachPerson     reach = 1 << iota // a person's browser, or the CLI
	reachContainers                   // a container of the stack
)

// containersSide: how far above its person's port the containers' side of a
// port both dial is published. One host port cannot be published on two
// addresses (measured on Apple container 0.11.0), so the gateway's 4000 is a
// person's and 14000 the containers', and Neo4j's 7687 likewise 17687.
const containersSide = 10000

// reachOf: who dials role's port, by the host port it is published on. The
// LOCAL-ONLY-STACK table, read from what each service's document places and
// what a person opens; every port not named here only containers dial, or
// only the launcher's probes, which follow the containers.
func reachOf(role string, hostPort int) reach {
	switch role {
	case "browser", "metrics":
		return reachPerson
	case "gateway":
		return reachPerson | reachContainers
	case "graph":
		if hostPort == descriptorFor("graph", "neo4j").auxPorts[0].port {
			return reachPerson // the Neo4j Browser
		}
		return reachPerson | reachContainers // bolt
	case "traces":
		if hostPort == descriptorFor("traces", "jaeger").defaultPort {
			return reachPerson // Jaeger's UI
		}
		return reachContainers // its OTLP ingest, which the collector dials
	}
	return reachContainers
}

// exposure: a start's runtime, the host address its containers reach, and,
// under `network lan`, this Mac's address on the network.
type exposure struct {
	rt, addr string
	// lan: this Mac's address on the network when the start is `network lan`,
	// else empty. Only a confined runtime carries one (startNetwork).
	lan string
}

// confined: whether this runtime publishes only where a port's dialers are.
// D1-A is ruled for Apple container alone.
func (e exposure) confined() bool {
	return e.rt == "container"
}

// behindProxy: whether role's dialers reach it through the launcher's
// filtering proxy rather than at its own publish — the issuer, under
// `network lan` (D3b-A1). Its own port is then published for the proxy and
// the launcher alone, on the bridge address, at the containers' side.
func (e exposure) behindProxy(role string) bool {
	return e.lan != "" && role == "identity"
}

// publishSpecs: the publish specs (`[address:]host:container`) of one of
// role's ports — a person's on loopback, the containers' on the bridge
// address, both for a port both dial. Under `network lan` the gateway's
// person side is published on every interface, and the issuer's own port
// behind the proxy.
func (e exposure) publishSpecs(role string, hostPort, ctrPort int) []string {
	if !e.confined() {
		return []string{fmt.Sprintf("%d:%d", hostPort, ctrPort)}
	}
	if e.behindProxy(role) {
		return []string{fmt.Sprintf("%s:%d:%d", e.addr, hostPort+containersSide, ctrPort)}
	}
	r := reachOf(role, hostPort)
	var specs []string
	switch {
	case r&reachPerson != 0 && e.lan != "" && role == "gateway":
		specs = append(specs, fmt.Sprintf("%d:%d", hostPort, ctrPort))
	case r&reachPerson != 0:
		specs = append(specs, fmt.Sprintf("127.0.0.1:%d:%d", hostPort, ctrPort))
	}
	if r&reachContainers != 0 {
		specs = append(specs, fmt.Sprintf("%s:%d:%d", e.addr, e.containersPort(role, hostPort), ctrPort))
	}
	return specs
}

// publish: role's port, published as publishSpecs says, each spec after flag
// (`-p` or `--publish`, as its run line writes it).
func (e exposure) publish(flag, role string, hostPort, ctrPort int) []string {
	var args []string
	for _, spec := range e.publishSpecs(role, hostPort, ctrPort) {
		args = append(args, flag, spec)
	}
	return args
}

// containersPort: the host port a container dials role's port at — its own,
// or the containers' side of a port a person dials too.
func (e exposure) containersPort(role string, hostPort int) int {
	if e.confined() && reachOf(role, hostPort) == reachPerson|reachContainers {
		return hostPort + containersSide
	}
	return hostPort
}

// containersSideNeed: the extra must-be-free port the containers' side of
// role's port claims, when there is one: the containers' side of a port a
// person dials too, or the issuer's own port behind the proxy.
func (e exposure) containersSideNeed(role string, need portNeed) []portNeed {
	if e.behindProxy(role) {
		return []portNeed{{need.port + containersSide, need.label + " (behind the issuer proxy)"}}
	}
	if p := e.containersPort(role, need.port); p != need.port {
		return []portNeed{{p, need.label + " (containers)"}}
	}
	return nil
}

// recordedExposure: where the local stack of the root keyed key was
// published, as its record says — for a command that reaches the stack
// outside a start. The zero exposure, which asks loopback, when no recorded
// stack runs that root.
func recordedExposure(key string) exposure {
	if st := LoadStackSet().Stacks["local"]; st != nil && rootKey(st.KBDid, st.KBRoot) == key {
		return st.exposure()
	}
	return exposure{}
}

// probeHost: where the launcher asks role's port — loopback for a port a
// person dials, else where the containers dial it (D5), so a probe passes
// only on an address something uses. The issuer behind the proxy is asked
// where everyone dials it, at the network address.
func (e exposure) probeHost(role string, hostPort int) string {
	if e.behindProxy(role) {
		return e.lan
	}
	if !e.confined() || reachOf(role, hostPort)&reachPerson != 0 {
		return "localhost"
	}
	return e.addr
}

// keycloakAt: where the launcher reaches the Keycloak it runs on port, for
// its own waits and its administration: where the issuer is asked, or, behind
// the proxy, Keycloak's own publish on the bridge address.
func (e exposure) keycloakAt(port int) (string, int) {
	if e.behindProxy("identity") {
		return e.addr, port + containersSide
	}
	return e.probeHost("identity", port), port
}
