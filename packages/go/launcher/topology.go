package launcher

// topology.go — where a container reaches each daemon of its stack.
//
// Deployment topology is the launcher's to know, never a document's to
// declare. A knowledge base's documents say WHAT it needs: a graph, a vector
// store, an embedding model, an issuer. WHERE those listen on this machine is
// a fact of the start that placed them. So:
//
//   - A daemon whose document states no `external` is the launcher's to run
//     and to place: at this start's address, on its driver's port.
//   - A daemon whose document states `external` is somebody else's, at the
//     address it states; it is verified, never launched.
//   - Each service's document states every address as a literal, so no
//     container's environment says anything of where its dependencies are.
//
// placement is the one decider of each address, for every document the
// launcher writes and for the dry run that shows them.

import (
	"fmt"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// keycloakRealmName: the realm of the Keycloak the launcher runs.
const keycloakRealmName = "semiont"

// placement: a start's documents and plan, and where it runs: what each
// address in a service's document is decided from.
type placement struct {
	st   *stack.Stack
	plan *launchPlan
	rt   string
	// addr: the address this start places the daemons it runs at.
	addr string
	// lan: this Mac's address on the network for a `network lan` start, where
	// the issuer is; else empty.
	lan string
}

// placementOf: a start's placement, where e publishes.
func placementOf(fc flowCtx, e exposure) placement {
	return placement{st: fc.stack, plan: fc.plan, rt: e.rt, addr: e.addr, lan: e.lan}
}

// placed: whether the launcher runs role's daemon in this start.
func (p placement) placed(role string) bool {
	return p.plan.Roles[role].Presence == presenceLauncher
}

// gatewayURL: where a service that dials the gateway reaches it — this
// start's address on the gateway's port. The publicURL is where clients
// reach it, and is written into the gateway's own document alone.
func (p placement) gatewayURL() string {
	return fmt.Sprintf("http://%s:%d", p.addr, p.exposure().containersPort("gateway", p.plan.GatewayPort, p.plan.GatewayPort))
}

// exposure: where this start publishes and probes each port, by who dials it.
func (p placement) exposure() exposure {
	return exposure{rt: p.rt, addr: p.addr, lan: p.lan}
}

// issuer: the issuer a container signs in at — the Keycloak the launcher runs
// at the host a container reaches it by, or the issuer somebody else runs as
// its document states it.
func (p placement) issuer() string {
	rp := p.plan.Roles["identity"]
	if rp.Presence != presenceLauncher {
		return rp.Issuer
	}
	return p.keycloakHostname() + "/realms/" + keycloakRealmName
}

// keycloakHostname: the origin of the issuer the launcher's Keycloak serves.
// Keycloak is started with it as its fixed hostname, so every token names this
// issuer wherever it was asked for, and the endpoints a caller dials behind it
// (token, keys) follow the address it asked at. Under `network lan` it is
// this Mac's address on the network, where every client reaches it (D3a).
func (p placement) keycloakHostname() string {
	host := identityHost(p.rt, p.addr)
	if p.exposure().behindProxy("identity") {
		host = p.lan
	}
	return fmt.Sprintf("http://%s:%d", host, p.plan.Roles["identity"].Port)
}

// archivist: where a service that reads the record reaches the Archivist —
// the address the KnowledgeBase states for one somebody else runs, else this
// start's, where the plan publishes it.
func (p placement) archivist() (host string, port int) {
	if stated := p.st.KnowledgeBase.Spec.Archivist.Address; stated != nil {
		return stated.Host, stated.Port
	}
	return p.addr, p.plan.servicePort("archivist")
}

// graphURI: where the graph database is.
func (p placement) graphURI() string {
	if external := p.st.KnowledgeIndex.Spec.Graph.External; external != nil {
		return external.Uri
	}
	rp := p.plan.Roles["graph"]
	return fmt.Sprintf("bolt://%s:%d", p.addr, p.exposure().containersPort("graph", rp.Port, descriptorFor("graph", rp.Driver).defaultPort))
}

// vectors: where the vector index is.
func (p placement) vectors() (host string, port int) {
	if external := p.st.KnowledgeIndex.Spec.Vectors.External; external != nil {
		return external.Host, external.Port
	}
	return p.addr, p.plan.Roles["vectors"].Port
}

// brokerServers: where the broker is, as its clients name it.
func (p placement) brokerServers() string {
	if external := p.st.KnowledgeBase.Spec.Messaging.External; external != nil {
		return external.Servers
	}
	return fmt.Sprintf("%s:%d", p.addr, p.plan.Roles["messaging"].Port)
}

// ollama: an Ollama's address — the one a document states, else the
// machine's, at this start's address.
func (p placement) ollama(stated *string) string {
	if stated != nil {
		return *stated
	}
	return fmt.Sprintf("http://%s:%d", p.addr, descriptorFor("inference", "ollama").defaultPort)
}

// placedLines: the addresses this start places, one line for each daemon the
// launcher runs and each service of the machine's Ollama — for a dry run to
// show what the launcher decided.
func (p placement) placedLines() []string {
	var lines []string
	add := func(role, at string) {
		lines = append(lines, fmt.Sprintf("%s: %s", role, at))
	}
	if p.placed("graph") {
		add("graph", p.graphURI())
	}
	if p.placed("vectors") {
		host, port := p.vectors()
		add("vectors", fmt.Sprintf("%s:%d", host, port))
	}
	if p.placed("identity-store") {
		add("identity-store", fmt.Sprintf("%s:%d", p.addr, p.plan.Roles["identity-store"].Port))
	}
	if p.placed("messaging") {
		add("messaging", p.brokerServers())
	}
	if p.placed("identity") {
		add("identity", p.issuer())
	}
	if e := p.st.KnowledgeIndex.Spec.Embedding; e.Type == "ollama" && e.Endpoint == nil {
		add("embedding", p.ollama(nil))
	}
	if rp := p.plan.Roles["inference"]; rp.Driver == "ollama" && rp.Presence == presenceHostPreferred {
		add("inference", p.ollama(nil))
	}
	return lines
}
