package launcher

import (
	"fmt"
	"sort"
	"strings"
)

// descriptors.go — the service descriptor set (LAUNCHER-SERVICE-MODEL D1/D2).
//
// A stack is described by two axes that used to be one. The ROLE is what the
// stack needs — graph, database, identity, gateway — abstract, independent of
// who provides it. The DRIVER is the technology providing it — neo4j,
// postgres, keycloak, oidc — and it owns every concrete fact: the container
// name, the image, the memory ceiling, the ports, the product name.
//
// Keeping those facts on the role was a lie the reader had to correct at
// every site: the identity ROW asserted `semiont-keycloak` even when the
// config selected an external OIDC issuer, which launches nothing. Here a row
// is a (role, driver) pair, so that assertion is not a row anybody can write.
//
// Semiont's own services are roles with exactly one driver — themselves. They
// carry no image: theirs is built from the registry and the version at start.
//
// Everything that used to be a hand-written list of container names derives
// from this table (the two sweeps, the status roster, the realm's client
// list, the `--service` usage string), gated by descriptor_census_test.go.

const driverSemiont = "semiont"

// dependency: an edge from a (role, driver) to a role it cannot come up
// after — or, when `because` is set, cannot come up WITHOUT.
type dependency struct {
	role string
	// because, when set, makes the edge a REQUIREMENT: the config must
	// declare that role's section, and derivePlan refuses naming this reason
	// when it does not (O1 — drivers require roles, configs declare them,
	// and the conditionality lives in plan derivation so the graph stays
	// static). Empty means the edge only ORDERS the walk: the role is
	// brought up first when the config has it, and its absence is no error.
	because string
}

// authority: what the launcher may do INSIDE a service it does not run.
//
// The one fact in this model that derives from nothing else, and the pair
// already in the code is the proof. We start neither a host-installed Ollama
// nor an external PostgreSQL — same presence — yet we pull models INTO the
// Ollama and refuse to create a database in the PostgreSQL. Same mechanism,
// opposite permission, because the difference is a POLICY: pulling a model
// is idempotent, cheap and reversible; creating a database in somebody's
// shared server is a privileged, persistent change. No fact about where a
// thing runs can tell you that.
//
// Full ownership is NOT a value here: a service the launcher runs is ours
// entirely, which mayConfigure derives from presence rather than restating
// per row (O2 — carry the lines the code already draws, subdivide only when
// something concrete demands it).
type authority int

const (
	// authorityObserve: probe it, read it, and change nothing. The default,
	// and what the external-PostgreSQL and external-issuer refusals are.
	authorityObserve authority = iota
	// authorityConfigure: idempotent, cheap, reversible changes inside
	// somebody else's process — pulling a model into a host Ollama.
	authorityConfigure
)

// healthProbe: how a driver answers "are you up?" — the one fact that used
// to have three homes (a status roster of 17 literals, a serviceEndpoint
// switch of 15 cases missing three roles, and literals inside the sidecar
// flows), which disagreed: status probed NATS on 4222 whatever the config
// said.
type healthProbe struct {
	// tcp: a TCP connect rather than an HTTP GET. A server with no health
	// route answers the only question we can ask it.
	tcp bool
	// port pins a health port that is NOT the one the config names — the
	// collector answers on its metrics port, Neo4j on HTTP rather than bolt.
	// Zero means "whatever port this role is running on".
	port int
	path string
}

// needs spells the ordering-only edges, which are most of them.
func needs(roles ...string) []dependency {
	out := make([]dependency, 0, len(roles))
	for _, r := range roles {
		out = append(out, dependency{role: r})
	}
	return out
}

// portNeed: a port that must be free, and its name in a conflict message.
type portNeed struct {
	port  int
	label string
}

type serviceDescriptor struct {
	role   string
	driver string

	// container is the wire-level name this driver runs under, "" when the
	// driver launches nothing (an external issuer, a SaaS API, or an Ollama
	// another role already runs). "" is the structural fact the rest of the
	// launcher reads as "no start, no stop, no logs" — never a missing value.
	container string
	image     string // "" for Semiont's own services: registry + version, at start

	// mem is the container's memory CEILING (--memory). On Apple container it
	// sizes the per-container VM (≈ a commitment); on docker/podman it is a
	// cgroup cap inside one shared VM (caps are not reservations). Explicit
	// for every container-bearing driver — the silent default is 1G on Apple
	// container and unlimited on docker. This table is the ONE home; every
	// args builder and the memory preflight read it. No floors: apps size
	// themselves from the ceiling (node cgroup-aware heap, Neo4j auto-config).
	//
	// Sized from `container stats` on an idle stack (2026-08-31/09-03):
	// every Node service ≤ ~310 MiB, collector 153, neo4j 922 — so 2G ≈ 6x
	// headroom for the services, and neo4j keeps the 2G it actually uses.
	// Re-measure before trusting a ceiling after a service's scope changes.
	mem string

	// ports: the stack-level claims this driver makes — the ports a start
	// insists are free before it runs. Config-owned ports (a dependency role
	// whose section moves its port) come from the plan instead; these are the
	// launcher-fiat ones. Empty means the driver claims none at stack level:
	// inference's port is claimed inside flowInference, the Browser's inside
	// flowBrowser, so neither enters a stack-wide sweep.
	ports []portNeed

	// needs: the roles that must be up before this one. The edges the start
	// walk is ordered by and the teardown walk is ordered against — declared
	// per (role, driver), because a requirement can be the DRIVER's and not
	// the role's: Keycloak keeps its realm in a database, an external OIDC
	// issuer needs nothing from us.
	needs []dependency

	// authority: what the launcher may change inside this service when it is
	// not the one running it. Zero is observe-only, which is the right
	// default: a driver earns more by being named below, never by omission.
	authority authority

	// health: the probe a start gates on and status reports. One home.
	health healthProbe

	display     string     // product name for banners, status and messages
	defaultPort int        // config default AND the container-side listen port
	portLabel   string     // the primary port's name in conflict errors
	auxPorts    []portNeed // secondary ports the config never declares
	cmd         []string   // trailing container args (NATS needs "-js -sd <dir>")
}

// Port policy: (1) contract-standard ports keep the standard (4318 OTLP);
// (2) third-party products keep their product ports (5432, 7474/7687, 6333,
// 11434, 16686); (3) user-facing Semiont stays memorable (3000 Browser,
// 4000 Gateway); (4) Semiont-internal services listen in 241xx — nobody's
// default, below both ephemeral floors (Linux 32768, macOS 49152). The
// 909x block they used to squat is Prometheus/Pushgateway/Kafka/
// Alertmanager territory.
//
// Order is the reading order: Semiont's own services, then the
// infrastructure they run on, then the model providers, then observability.
// It is what `roleList` and every role enumeration inherit; the two sweep
// orders below are separate and stay that way until dependencies are data.
var serviceDescriptors = []serviceDescriptor{
	// The gateway waits for the issuer whose keys it verifies tokens against
	// and the broker its signal plane dials; it dials no graph, vector,
	// embedding or database client of its own. The collector precedes it
	// because the gateway is the first process to export to it.
	{role: "gateway", driver: driverSemiont, container: "semiont-gateway", mem: "2G", ports: []portNeed{{4000, "Gateway"}},
		needs:  needs("collector", "identity", "messaging"),
		health: healthProbe{path: "/api/health"}},
	// The three make-meaning sidecars open with boot-time bus requests the
	// Archivist answers (the smelter's reconcile opens with browse:resources),
	// and its /health only turns on after its bus pumps attach — so this edge
	// is what closes the startup race a 3.5-second head start once lost a
	// smelter to.
	{role: "worker", driver: driverSemiont, container: "semiont-worker", mem: "2G", ports: []portNeed{{24100, "Worker"}},
		needs: needs("gateway", "archivist"), health: healthProbe{path: "/health"}},
	{role: "smelter", driver: driverSemiont, container: "semiont-smelter", mem: "2G", ports: []portNeed{{24101, "Smelter"}},
		needs: needs("gateway", "archivist"), health: healthProbe{path: "/health"}},
	{role: "weaver", driver: driverSemiont, container: "semiont-weaver", mem: "2G", ports: []portNeed{{24102, "Weaver"}},
		needs: needs("gateway", "archivist"), health: healthProbe{path: "/health"}},
	// The Archivist is where the stores the actors dial become preconditions:
	// each of them gates it, and none of them gates the gateway above.
	{role: "archivist", driver: driverSemiont, container: "semiont-archivist", mem: "2G", ports: []portNeed{{24103, "Archivist"}},
		needs:  needs("gateway", "graph", "vectors", "inference", "embedding"),
		health: healthProbe{path: "/health"}},
	{role: "librarian", driver: driverSemiont, container: "semiont-librarian", mem: "2G", ports: []portNeed{{24104, "Librarian"}},
		needs: needs("gateway"), health: healthProbe{path: "/health"}},
	// The dispatcher's JetStream queue dials the same broker the signal plane
	// does.
	{role: "dispatcher", driver: driverSemiont, container: "semiont-dispatcher", mem: "2G", ports: []portNeed{{24105, "Dispatcher"}},
		needs:  needs("gateway", "messaging"),
		health: healthProbe{path: "/health"}},
	// browser: the Browser owns its port inside flowBrowser — an empty ports
	// list keeps 3000 out of every stack-level claim and sweep.
	// The Browser's port is the one a flag may move, so the probe pins the
	// default; a running Browser is reported from its record instead.
	{role: "browser", driver: driverSemiont, container: "semiont-browser", mem: "1G", health: healthProbe{port: 3000}},

	{role: "database", driver: "postgres", container: "semiont-postgres", image: "postgres:15.18-alpine", mem: "1G",
		ports: []portNeed{{5432, "PostgreSQL"}}, display: "PostgreSQL", defaultPort: 5432, portLabel: "PostgreSQL",
		health: healthProbe{tcp: true}},

	// graph 2G: a JVM auto-sizing its heap from visible memory — the silent
	// 1G VM default was the known-tight spot on Apple container.
	{role: "graph", driver: "neo4j", container: "semiont-neo4j", image: "neo4j:5.26.28-community", mem: "2G",
		ports:   []portNeed{{7474, "Neo4j HTTP"}, {7687, "Neo4j Bolt"}},
		display: "Neo4j", defaultPort: 7687, portLabel: "Neo4j Bolt", auxPorts: []portNeed{{7474, "Neo4j HTTP"}},
		// Neo4j answers HTTP on its browser port; bolt is not a health route.
		health: healthProbe{port: 7474}},

	{role: "vectors", driver: "qdrant", container: "semiont-qdrant", image: "qdrant/qdrant:v1.19.1", mem: "2G",
		ports: []portNeed{{6333, "Qdrant"}}, display: "Qdrant", defaultPort: 6333, portLabel: "Qdrant",
		health: healthProbe{path: "/readyz"}},

	// NATS keeps its product port (tier 2). 512M ceiling: measured 26 MiB
	// idle with JetStream on (2026-09-15); the headroom is for stream replay
	// after restart. Runs when [jobs] selects jetstream or [signal] selects
	// nats (SIGNAL-PLANE D9): ONE daemon, ONE shape — JetStream on, with the
	// stamped /data store — because both drivers that select it use that
	// store: the job queue's stream, and the signal driver's KV tables, where
	// the gateway's ledger keeps its claims (LEDGER-STATE-TO-THE-BROKER P0).
	// JOB-QUEUE-DRIVER P2: "fs" is a valid config type but not a driver here
	// — it runs inside the gateway and launches nothing.
	{role: "messaging", driver: "jetstream", container: "semiont-nats", image: "nats:2.14.0-alpine", mem: "512M",
		ports: []portNeed{{4222, "NATS"}}, display: "NATS", defaultPort: 4222, portLabel: "NATS",
		cmd: []string{"-js", "-sd", "/data"}, health: healthProbe{tcp: true}},

	// EXTERNAL-IDENTITY D5: the OIDC issuer the gateway trusts. "keycloak" is
	// an upstream pin like postgres — the dev-mode server, importing the
	// realm the launcher stages, on its own database of the [database]
	// PostgreSQL (D6). A JVM like graph, but its image caps the heap at 70%
	// of the container ceiling, so 1G leaves ~700M of heap — ample for one
	// KB's realm. "oidc" is an issuer somebody else runs: the launcher
	// verifies it and launches nothing, which is why it carries no container.
	{role: "identity", driver: "keycloak", container: "semiont-keycloak", image: "quay.io/keycloak/keycloak:26.7.4", mem: "1G",
		ports: []portNeed{{8080, "Keycloak"}}, display: "Keycloak", defaultPort: 8080, portLabel: "Keycloak",
		cmd:   []string{"start-dev", "--import-realm"},
		needs: []dependency{{role: "database", because: "Keycloak keeps its realm in its own database on that PostgreSQL"}},
		// The master realm always exists, so it answers for a server whose
		// own realm this launcher has not been told about. A configured
		// stack is probed at its issuer instead (healthEndpoint).
		health: healthProbe{path: "/realms/master"}},
	{role: "identity", driver: "oidc", display: "OIDC issuer", defaultPort: 443,
		health: healthProbe{path: "/.well-known/openid-configuration"}},

	// inference 24G: a loaded small model (gemma-class) needs 4-5G; the
	// silent 1G default cannot even load one.
	// authorityConfigure: the launcher pulls models into an Ollama it did not
	// start. A pull is idempotent, cheap and reversible, which is the whole
	// of the argument — and the argument PostgreSQL does not get.
	{role: "inference", driver: "ollama", container: "semiont-ollama", image: "ollama/ollama", mem: "24G",
		display: "Ollama", defaultPort: 11434, portLabel: "Ollama", authority: authorityConfigure,
		health: healthProbe{path: "/api/version"}},
	// Remote SaaS: no image (nothing to launch), port is TLS. The row it
	// yields is external — participates in status, no start/stop.
	{role: "inference", driver: "anthropic", display: "Anthropic", defaultPort: 443},

	// embedding is a role the launcher never provides a container for: either
	// the Ollama the inference role already runs serves it, or it is remote
	// SaaS over TLS. Like every external row it participates in status and
	// supports no start/stop.
	{role: "embedding", driver: "ollama", display: "Ollama", defaultPort: 11434, portLabel: "Ollama", authority: authorityConfigure,
		health: healthProbe{path: "/api/version"}},
	{role: "embedding", driver: "voyage", display: "Voyage", defaultPort: 443, portLabel: "Voyage"},

	// The collector owns 4318 (the port services target); Jaeger's own OTLP
	// ingest sits behind it on 14318. Both are ephemeral: observability data
	// is disposable in a dev stack.
	{role: "traces", driver: "jaeger", container: "semiont-jaeger", image: "jaegertracing/all-in-one:1.76.0", mem: "1G",
		ports:   []portNeed{{16686, "Jaeger UI"}, {14318, "Jaeger OTLP"}},
		display: "Jaeger", defaultPort: 16686, portLabel: "Jaeger UI", health: healthProbe{}},
	// Prometheus keeps its product port (tier 2) — free since the worker
	// moved to 24100.
	{role: "metrics", driver: "prometheus", container: "semiont-prometheus", image: "prom/prometheus:v3.9.1", mem: "1G",
		ports: []portNeed{{9090, "Prometheus UI"}}, display: "Prometheus", defaultPort: 9090, portLabel: "Prometheus UI",
		health: healthProbe{path: "/-/healthy"}},
	{role: "collector", driver: "otel", container: "semiont-otel-collector", image: "otel/opentelemetry-collector:0.137.0", mem: "1G",
		ports:   []portNeed{{4318, "Collector OTLP"}, {24110, "Collector metrics"}},
		display: "OTel", defaultPort: 4318, portLabel: "Collector OTLP", needs: needs("traces"),
		// The collector's readout port, not the OTLP port services target.
		health: healthProbe{port: 24110, path: "/metrics"}},
}

// descriptorIndex: (role, driver) → descriptor. Built once; the slice above
// stays the single source and keeps the reading order.
var descriptorIndex = func() map[string]map[string]serviceDescriptor {
	m := map[string]map[string]serviceDescriptor{}
	for _, d := range serviceDescriptors {
		if m[d.role] == nil {
			m[d.role] = map[string]serviceDescriptor{}
		}
		m[d.role][d.driver] = d
	}
	return m
}()

// startOrder is the ONE order in the launcher: the sequence a full start
// brings the roles up in. Teardown is this walk reversed (D4 — a stop order
// is never written down), and both sweeps derive from that, so there is no
// second or third list to drift from this one.
//
// It is a chosen total order, not a computed one: the `needs` edges admit
// many valid sequences and this is the one the start flow walks, with the
// judgement the edges do not carry — the observability tier first so a first
// export lands, the gateway ahead of the stores because it has the most ways
// to fail. TestStartOrderRespectsEveryDependency proves the choice is legal;
// TestDryRunLaunchOrderFollowsTheDeclaredStartOrder proves the flow walks it.
//
// The Browser is last and belongs to no stack (BROWSER-LIFECYCLE.md): it is
// in this order only so `--service browser` and the role census can find it.
var startOrder = []string{
	"traces", "metrics", "collector",
	"database", "messaging", "identity",
	"gateway",
	"graph", "vectors", "inference", "embedding",
	"archivist", "librarian", "dispatcher",
	"worker", "smelter", "weaver",
	"browser",
}

// roleOrder: every role the launcher knows. The start order IS the reading
// order — a reader meeting them in the sequence they come up meets them in
// the order they depend on each other.
var roleOrder = startOrder

// teardownOrder: the start walk reversed. Dependents go down before the
// things they depend on, because reversing a legal start order is what that
// means — it is not a list anyone maintains.
var teardownOrder = func() []string {
	out := make([]string, 0, len(startOrder))
	for i := len(startOrder) - 1; i >= 0; i-- {
		out = append(out, startOrder[i])
	}
	return out
}()

// startRank: a role's position in the start walk, for the tests and refusals
// that need to compare two roles. -1 for a name that is not a role.
func startRank(role string) int {
	for i, r := range startOrder {
		if r == role {
			return i
		}
	}
	return -1
}

// dependenciesOf: every edge out of a role, across all its drivers. The
// order walks are static — they run before any config is read — so they see
// the union: an edge one driver declares orders the role.
func dependenciesOf(role string) []dependency {
	var out []dependency
	for _, d := range descriptorsForRole(role) {
		for _, dep := range d.needs {
			dup := false
			for _, have := range out {
				if have.role == dep.role {
					dup = true
					break
				}
			}
			if !dup {
				out = append(out, dep)
			}
		}
	}
	return out
}

// unmetRequirement: the first role this driver cannot run WITHOUT that the
// config never declares (O1). Ordering-only edges are not requirements —
// their absence is a stack without that role, not a broken config.
func unmetRequirement(declared func(role string) bool, role, driver string) (dependency, bool) {
	for _, dep := range descriptorFor(role, driver).needs {
		if dep.because != "" && !declared(dep.role) {
			return dep, true
		}
	}
	return dependency{}, false
}

// roleList: the roles a `--service` flag accepts, for usage and refusals.
var roleList = func() string {
	if len(roleOrder) < 2 {
		return strings.Join(roleOrder, ", ")
	}
	return strings.Join(roleOrder[:len(roleOrder)-1], ", ") + ", or " + roleOrder[len(roleOrder)-1]
}()

// roleListWrapped renders roleList across lines no wider than width,
// continuing each with indent. Help text is read in a terminal: one
// 200-column line is not help.
func roleListWrapped(width int, indent string) string {
	var b strings.Builder
	col := len(indent)
	for i, word := range strings.Split(roleList, " ") {
		switch {
		case i == 0:
		case col+1+len(word) > width:
			b.WriteString("\n" + indent)
			col = len(indent)
		default:
			b.WriteString(" ")
			col++
		}
		b.WriteString(word)
		col += len(word)
	}
	return b.String()
}

func knownRole(role string) bool { return descriptorIndex[role] != nil }

func lookupDescriptor(role, driver string) (serviceDescriptor, bool) {
	d, ok := descriptorIndex[role][driver]
	return d, ok
}

// descriptorFor: the (role, driver) row, zero when the pair is unknown — a
// zero descriptor answers "no container, no image, no ports", which is what
// every consumer already does with a role it cannot place.
func descriptorFor(role, driver string) serviceDescriptor {
	return descriptorIndex[role][driver]
}

// semiontDescriptor: the row for one of Semiont's own services, whose only
// driver is itself.
func semiontDescriptor(role string) serviceDescriptor {
	return descriptorIndex[role][driverSemiont]
}

// descriptorsForRole: every driver's row for a role, in table order. The
// answer for sites that must consider a role WITHOUT knowing which driver a
// config selected — a sweep, `stop --service`, a port claim before any
// config is read.
func descriptorsForRole(role string) []serviceDescriptor {
	var out []serviceDescriptor
	for _, d := range serviceDescriptors {
		if d.role == role {
			out = append(out, d)
		}
	}
	return out
}

// driversFor: the driver names a role accepts, sorted — the "known drivers"
// of a config refusal.
func driversFor(role string) []string {
	names := make([]string, 0, len(descriptorIndex[role]))
	for n := range descriptorIndex[role] {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// containersForRole: every container name a driver of this role could run,
// deduped, in table order. Empty for a role no driver launches (embedding),
// and today never longer than one — but a role whose drivers run different
// containers must be swept for all of them, not for a guess.
func containersForRole(role string) []string {
	var out []string
	for _, d := range descriptorsForRole(role) {
		if d.container == "" || contains(out, d.container) {
			continue
		}
		out = append(out, d.container)
	}
	return out
}

// roleContainer: the one container name a role can run, "" when it runs
// none. For the single-handle sites (status's inspect target, a codespace's
// wire-level name) that predate multi-container roles.
func roleContainer(role string) string {
	if names := containersForRole(role); len(names) > 0 {
		return names[0]
	}
	return ""
}

// stackPortNeeds: the launcher-fiat ports a role claims, whichever driver a
// config picks. Deduped, in table order.
func stackPortNeeds(role string) []portNeed {
	var out []portNeed
	for _, d := range descriptorsForRole(role) {
		for _, p := range d.ports {
			dup := false
			for _, have := range out {
				if have.port == p.port {
					dup = true
					break
				}
			}
			if !dup {
				out = append(out, p)
			}
		}
	}
	return out
}

// roleByContainer inverts the descriptor set (container name → role).
// Container-less drivers must not be indexed: mapping "" would hand a role
// back for every unmatched lookup, and stop would then believe a container
// it cannot name belongs to it.
var roleByContainer = func() map[string]string {
	m := map[string]string{}
	for _, d := range serviceDescriptors {
		if d.container != "" {
			m[d.container] = d.role
		}
	}
	return m
}()

// mayConfigure: may the launcher change anything INSIDE this role's
// service? A service the launcher runs is ours entirely, so ownership
// answers for itself; for one it does not run, the driver's declared
// authority decides. Three refusals used to answer this question separately,
// each by asking whether the role was "launcher-run".
func mayConfigure(rp rolePlan) bool {
	if rp.Presence == presenceLauncher {
		return true
	}
	return descriptorFor(rp.Role, rp.Driver).authority >= authorityConfigure
}

// healthEndpoint: the URL a start gates on and status reports, for one
// (role, driver). THE home for that fact.
//
// The port follows the plan when the config owns it, and the descriptor
// otherwise — which is what makes status honest about a config that moved a
// port, and what the three separate copies of this could not do.
func healthEndpoint(role, driver string, plan *launchPlan) string {
	d := descriptorFor(role, driver)
	// identity is the one driver-specific shape: a configured issuer names
	// its own realm path, and that realm — not master — is what a start
	// waits for, because the import is what makes it answer.
	if role == "identity" && plan != nil {
		if rp, ok := plan.Roles[role]; ok && rp.Issuer != "" {
			return identityEndpoint(rp)
		}
	}
	port := d.health.port
	if port == 0 {
		port = healthPort(role, d, plan)
	}
	if port == 0 {
		return ""
	}
	if d.health.tcp {
		return fmt.Sprintf("tcp:localhost:%d", port)
	}
	return fmt.Sprintf("http://localhost:%d%s", port, d.health.path)
}

// healthPort: the port this role is actually running on — the gateway's from
// the plan (the one port a config moves that no role row carries), a
// dependency role's from the plan, and a launcher-fiat one from the
// descriptor.
func healthPort(role string, d serviceDescriptor, plan *launchPlan) int {
	if plan != nil {
		if role == "gateway" {
			return plan.GatewayPort
		}
		if rp, ok := plan.Roles[role]; ok && rp.Port != 0 {
			return rp.Port
		}
	}
	if len(d.ports) > 0 {
		return d.ports[0].port
	}
	return d.defaultPort
}

// probeDriver: the driver status assumes when no record names one. A role
// with a single driver has no assumption to make; a role with several
// answers with the first that runs a container — the one a stack that has
// not recorded itself would be running. A recorded stack never reaches here:
// its endpoint comes from the record its start wrote.
func probeDriver(role string) string {
	ds := descriptorsForRole(role)
	for _, d := range ds {
		if d.container != "" {
			return d.driver
		}
	}
	if len(ds) > 0 {
		return ds[0].driver
	}
	return ""
}

// stackServices: Semiont's own services, in start order, minus the Browser.
//
// ONE list for three jobs that coincide on it, and coincide for one reason —
// the Browser is machine-level, not a stack member (BROWSER-LIFECYCLE): the
// images a start pulls, the configs it stages and mounts, and the realm
// accounts those services present. They were three hand-written lists, and
// one of them had six entries where the others had seven, so
// `start --service dispatcher` staged no config and passed empty hosts.
var stackServices = func() []string {
	var out []string
	for _, role := range startOrder {
		if role == "browser" {
			continue
		}
		if _, ours := lookupDescriptor(role, driverSemiont); ours {
			out = append(out, role)
		}
	}
	return out
}()

// sweepNames: the containers a teardown sweep removes, in teardown order,
// skipping the roles the caller names as exempt. Both sweeps are this
// function; they differ only in what they exempt, which is the whole of the
// difference between them.
func sweepNames(exempt ...string) []string {
	var out []string
	for _, r := range teardownOrder {
		if contains(exempt, r) {
			continue
		}
		for _, c := range containersForRole(r) {
			if !contains(out, c) {
				out = append(out, c)
			}
		}
	}
	return out
}

func contains(list []string, name string) bool {
	for _, n := range list {
		if n == name {
			return true
		}
	}
	return false
}
