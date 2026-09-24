package launcher

import (
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
	{role: "gateway", driver: driverSemiont, container: "semiont-gateway", mem: "2G", ports: []portNeed{{4000, "Gateway"}}},
	{role: "worker", driver: driverSemiont, container: "semiont-worker", mem: "2G", ports: []portNeed{{24100, "Worker"}}},
	{role: "smelter", driver: driverSemiont, container: "semiont-smelter", mem: "2G", ports: []portNeed{{24101, "Smelter"}}},
	{role: "weaver", driver: driverSemiont, container: "semiont-weaver", mem: "2G", ports: []portNeed{{24102, "Weaver"}}},
	{role: "archivist", driver: driverSemiont, container: "semiont-archivist", mem: "2G", ports: []portNeed{{24103, "Archivist"}}},
	{role: "librarian", driver: driverSemiont, container: "semiont-librarian", mem: "2G", ports: []portNeed{{24104, "Librarian"}}},
	{role: "dispatcher", driver: driverSemiont, container: "semiont-dispatcher", mem: "2G", ports: []portNeed{{24105, "Dispatcher"}}},
	// browser: the Browser owns its port inside flowBrowser — an empty ports
	// list keeps 3000 out of every stack-level claim and sweep.
	{role: "browser", driver: driverSemiont, container: "semiont-browser", mem: "1G"},

	{role: "database", driver: "postgres", container: "semiont-postgres", image: "postgres:15.18-alpine", mem: "1G",
		ports: []portNeed{{5432, "PostgreSQL"}}, display: "PostgreSQL", defaultPort: 5432, portLabel: "PostgreSQL"},

	// graph 2G: a JVM auto-sizing its heap from visible memory — the silent
	// 1G VM default was the known-tight spot on Apple container.
	{role: "graph", driver: "neo4j", container: "semiont-neo4j", image: "neo4j:5.26.28-community", mem: "2G",
		ports:   []portNeed{{7474, "Neo4j HTTP"}, {7687, "Neo4j Bolt"}},
		display: "Neo4j", defaultPort: 7687, portLabel: "Neo4j Bolt", auxPorts: []portNeed{{7474, "Neo4j HTTP"}}},

	{role: "vectors", driver: "qdrant", container: "semiont-qdrant", image: "qdrant/qdrant:v1.19.1", mem: "2G",
		ports: []portNeed{{6333, "Qdrant"}}, display: "Qdrant", defaultPort: 6333, portLabel: "Qdrant"},

	// NATS keeps its product port (tier 2). 512M ceiling: measured 26 MiB
	// idle with JetStream on (2026-09-15); the headroom is for stream replay
	// after restart. Runs when [jobs] selects jetstream or [signal] selects
	// nats (SIGNAL-PLANE D9): ONE daemon, TWO shapes, chosen by the jobs
	// vote. "jetstream" (jobs want the broker) adds -js and the stamped
	// /data store; "nats" (signal-only) is the LEAN daemon — core subjects,
	// no store (DRIVER-SCOPED-MOUNTS: no space a selected driver won't use),
	// and JetStream disabled server-side makes D3 structural on that root.
	// JOB-QUEUE-DRIVER P2: "fs" is a valid config type but not a driver here
	// — it runs inside the gateway and launches nothing.
	{role: "messaging", driver: "jetstream", container: "semiont-nats", image: "nats:2.14.0-alpine", mem: "512M",
		ports: []portNeed{{4222, "NATS"}}, display: "NATS", defaultPort: 4222, portLabel: "NATS",
		cmd: []string{"-js", "-sd", "/data"}},
	{role: "messaging", driver: "nats", container: "semiont-nats", image: "nats:2.14.0-alpine", mem: "512M",
		ports: []portNeed{{4222, "NATS"}}, display: "NATS", defaultPort: 4222, portLabel: "NATS"},

	// EXTERNAL-IDENTITY D5: the OIDC issuer the gateway trusts. "keycloak" is
	// an upstream pin like postgres — the dev-mode server, importing the
	// realm the launcher stages, on its own database of the [database]
	// PostgreSQL (D6). A JVM like graph, but its image caps the heap at 70%
	// of the container ceiling, so 1G leaves ~700M of heap — ample for one
	// KB's realm. "oidc" is an issuer somebody else runs: the launcher
	// verifies it and launches nothing, which is why it carries no container.
	{role: "identity", driver: "keycloak", container: "semiont-keycloak", image: "quay.io/keycloak/keycloak:26.7.4", mem: "1G",
		ports: []portNeed{{8080, "Keycloak"}}, display: "Keycloak", defaultPort: 8080, portLabel: "Keycloak",
		cmd: []string{"start-dev", "--import-realm"}},
	{role: "identity", driver: "oidc", display: "OIDC issuer", defaultPort: 443},

	// inference 24G: a loaded small model (gemma-class) needs 4-5G; the
	// silent 1G default cannot even load one.
	{role: "inference", driver: "ollama", container: "semiont-ollama", image: "ollama/ollama", mem: "24G",
		display: "Ollama", defaultPort: 11434, portLabel: "Ollama"},
	// Remote SaaS: no image (nothing to launch), port is TLS. The row it
	// yields is external — participates in status, no start/stop.
	{role: "inference", driver: "anthropic", display: "Anthropic", defaultPort: 443},

	// embedding is a role the launcher never provides a container for: either
	// the Ollama the inference role already runs serves it, or it is remote
	// SaaS over TLS. Like every external row it participates in status and
	// supports no start/stop.
	{role: "embedding", driver: "ollama", display: "Ollama", defaultPort: 11434, portLabel: "Ollama"},
	{role: "embedding", driver: "voyage", display: "Voyage", defaultPort: 443, portLabel: "Voyage"},

	// The collector owns 4318 (the port services target); Jaeger's own OTLP
	// ingest sits behind it on 14318. Both are ephemeral: observability data
	// is disposable in a dev stack.
	{role: "traces", driver: "jaeger", container: "semiont-jaeger", image: "jaegertracing/all-in-one:1.76.0", mem: "1G",
		ports:   []portNeed{{16686, "Jaeger UI"}, {14318, "Jaeger OTLP"}},
		display: "Jaeger", defaultPort: 16686, portLabel: "Jaeger UI"},
	// Prometheus keeps its product port (tier 2) — free since the worker
	// moved to 24100.
	{role: "metrics", driver: "prometheus", container: "semiont-prometheus", image: "prom/prometheus:v3.9.1", mem: "1G",
		ports: []portNeed{{9090, "Prometheus UI"}}, display: "Prometheus", defaultPort: 9090, portLabel: "Prometheus UI"},
	{role: "collector", driver: "otel", container: "semiont-otel-collector", image: "otel/opentelemetry-collector:0.137.0", mem: "1G",
		ports:   []portNeed{{4318, "Collector OTLP"}, {24110, "Collector metrics"}},
		display: "OTel", defaultPort: 4318, portLabel: "Collector OTLP"},
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

// roleOrder: every role the launcher knows, in the table's reading order.
var roleOrder = func() []string {
	var out []string
	seen := map[string]bool{}
	for _, d := range serviceDescriptors {
		if !seen[d.role] {
			seen[d.role] = true
			out = append(out, d.role)
		}
	}
	return out
}()

// roleList: the roles a `--service` flag accepts, for usage and refusals.
var roleList = func() string {
	if len(roleOrder) < 2 {
		return strings.Join(roleOrder, ", ")
	}
	return strings.Join(roleOrder[:len(roleOrder)-1], ", ") + ", or " + roleOrder[len(roleOrder)-1]
}()

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

// roleTitle is the detail-bearing display form: the role, with the driver's
// product in parens when there is one ("graph (Neo4j)"). A role whose driver
// is not known here reads as the bare role — the launcher does not guess a
// product for a technology nobody selected.
func roleTitle(role, driver string) string {
	if p := descriptorFor(role, driver).display; p != "" {
		return role + " (" + p + ")"
	}
	return role
}

// restartDriver: which driver a single-service restart is about. A
// dependency role's comes from the plan, which is the only thing that knows
// what the config selected. A role with exactly ONE driver has no choice to
// make — Semiont's own services and the observability backends — so the
// table answers directly. A role with several and no plan gets "", and the
// banner reads as the bare role rather than naming a technology at random.
func restartDriver(role string, plan *launchPlan) string {
	if plan != nil {
		if rp, ok := plan.Roles[role]; ok && rp.Driver != "" {
			return rp.Driver
		}
	}
	if ds := descriptorsForRole(role); len(ds) == 1 {
		return ds[0].driver
	}
	return ""
}

// containersFor maps a sweep's role order to the container names it removes.
func containersFor(roles []string) []string {
	var out []string
	for _, r := range roles {
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
