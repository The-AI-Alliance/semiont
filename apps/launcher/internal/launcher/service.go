package launcher

import (
	"fmt"
	"time"
)

// The launcher's primary vocabulary is the ROLE a container plays in the
// stack: database, graph, vectors, inference, traces — plus Semiont's own services
// by name. The concrete product behind an infra role (PostgreSQL, Neo4j, …)
// and its image string are DETAIL, shown where there's room for it (banners,
// echoed argv, error messages); container names and config env vars stay at
// the wire level (semiont-postgres, NEO4J_HOST) — they're shared contracts
// with compose and the running fleet.
type portNeed struct {
	port  int
	label string
}

type roleSpec struct {
	product   string // concrete product behind an infra role; "" = a Semiont service
	container string
	ports     []portNeed // must-be-free ports (inference: owned by flowInference)
	// mem is the container's memory CEILING (--memory). On Apple container it
	// sizes the per-container VM (≈ a commitment); on docker/podman it is a
	// cgroup cap inside one shared VM (caps are not reservations). Explicit
	// for every containered role — the silent default is 1G on Apple
	// container and unlimited on docker. This table is the ONE home; every
	// args builder and the memory preflight read it. No floors: apps size
	// themselves from the ceiling (node cgroup-aware heap, Neo4j auto-config).
	//
	// Sized from `container stats` on an idle stack (2026-08-31/09-03):
	// every Node service ≤ ~310 MiB, collector 153, neo4j 922 — so 2G ≈ 6x
	// headroom for the services, and neo4j keeps the 2G it actually uses.
	// Re-measure before trusting a ceiling after a service's scope changes.
	mem string
}

// Port policy: (1) contract-standard ports keep the standard (4318 OTLP);
// (2) third-party products keep their product ports (5432, 7474/7687, 6333,
// 11434, 16686); (3) user-facing Semiont stays memorable (3000 Browser,
// 4000 Gateway); (4) Semiont-internal services listen in 241xx — nobody's
// default, below both ephemeral floors (Linux 32768, macOS 49152). The
// 909x block they used to squat is Prometheus/Pushgateway/Kafka/
// Alertmanager territory.
var roles = map[string]roleSpec{
	// The collector owns 4318 (the port services target); Jaeger's own OTLP
	// ingest sits behind it on 14318.
	"traces":    {"Jaeger", "semiont-jaeger", []portNeed{{16686, "Jaeger UI"}, {14318, "Jaeger OTLP"}}, "1G"},
	"collector": {"OTel", "semiont-otel-collector", []portNeed{{4318, "Collector OTLP"}, {24110, "Collector metrics"}}, "1G"},
	// Prometheus keeps its product port (tier 2) — free since the worker
	// moved to 24100. Ephemeral like Jaeger: observability data is
	// disposable in a dev stack.
	"metrics": {"Prometheus", "semiont-prometheus", []portNeed{{9090, "Prometheus UI"}}, "1G"},
	// NATS keeps its product port (tier 2). 512M ceiling: measured 26 MiB
	// idle with JetStream on (2026-09-15); the headroom is for stream
	// replay after restart. Runs when [jobs] selects jetstream or [signal]
	// selects nats (SIGNAL-PLANE D9).
	"messaging": {"NATS", "semiont-nats", []portNeed{{4222, "NATS"}}, "512M"},
	// Keycloak keeps its product port (tier 2). A JVM like graph, but its
	// image caps the heap at 70% of the container ceiling, so 1G leaves
	// ~700M of heap — ample for one KB's realm. Runs when [identity]
	// selects keycloak on the launcher-injected ${KEYCLOAK_HOST}.
	"identity": {"Keycloak", "semiont-keycloak", []portNeed{{8080, "Keycloak"}}, "1G"},
	// graph 2G: a JVM auto-sizing its heap from visible memory — the silent
	// 1G VM default was the known-tight spot on Apple container.
	"graph":   {"Neo4j", "semiont-neo4j", []portNeed{{7474, "Neo4j HTTP"}, {7687, "Neo4j Bolt"}}, "2G"},
	"vectors": {"Qdrant", "semiont-qdrant", []portNeed{{6333, "Qdrant"}}, "2G"},
	// inference 8G: a loaded small model (gemma-class) needs 4-5G; the
	// silent 1G default cannot even load one.
	"inference": {"Ollama", "semiont-ollama", nil, "24G"},
	// embedding is a role with no container of its own: its platform is
	// always "external" in practice — either the Ollama the inference role
	// already provides, or a remote SaaS (Voyage). Like every external role
	// it participates in status but supports no start/stop.
	"embedding":  {"", "", nil, ""},
	"database":   {"PostgreSQL", "semiont-postgres", []portNeed{{5432, "PostgreSQL"}}, "1G"},
	"gateway":    {"", "semiont-gateway", []portNeed{{4000, "Gateway"}}, "2G"},
	"worker":     {"", "semiont-worker", []portNeed{{24100, "Worker"}}, "2G"},
	"smelter":    {"", "semiont-smelter", []portNeed{{24101, "Smelter"}}, "2G"},
	"weaver":     {"", "semiont-weaver", []portNeed{{24102, "Weaver"}}, "2G"},
	"archivist":  {"", "semiont-archivist", []portNeed{{24103, "Archivist"}}, "2G"},
	"librarian":  {"", "semiont-librarian", []portNeed{{24104, "Librarian"}}, "2G"},
	"dispatcher": {"", "semiont-dispatcher", []portNeed{{24105, "Dispatcher"}}, "2G"},
	// browser: the Browser owns its port inside flowBrowser — an empty
	// ports list here keeps 3000 out of every stack-level claim and sweep.
	"browser": {"", "semiont-browser", nil, "1G"},
}

const roleList = "gateway, worker, smelter, weaver, archivist, librarian, dispatcher, browser, database, graph, vectors, messaging, identity, inference, embedding, traces, metrics, or collector"

// roleByContainer inverts the roles table (container name → role).
var roleByContainer = func() map[string]string {
	m := make(map[string]string, len(roles))
	for r, s := range roles {
		// Container-less roles (embedding) must not be indexed: mapping ""
		// would hand that role back for every unmatched lookup, and stop
		// would then believe a container it cannot name belongs to it.
		if s.container == "" {
			continue
		}
		m[s.container] = r
	}
	return m
}()

// roleTitle is the detail-bearing display form: the role, with the product
// in parens when there is one ("graph (Neo4j)").
func roleTitle(role string) string {
	if p := roles[role].product; p != "" {
		return role + " (" + p + ")"
	}
	return role
}

func isConfigConsumer(svc string) bool {
	return svc == "gateway" || svc == "worker" || svc == "smelter" || svc == "weaver" || svc == "archivist" || svc == "librarian"
}

func serviceNeedsAddr(svc string) bool {
	return isConfigConsumer(svc) || svc == "database" || svc == "inference"
}

// digString walks a nested inspect entry for a string leaf.
func digString(m map[string]any, path ...string) (string, bool) {
	var cur any = m
	for _, k := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return "", false
		}
		cur = mm[k]
	}
	s, ok := cur.(string)
	return s, ok
}

// runStartService: the live `start --service` — flowOneService with
// liveExec, plus the live-only rocket summary (skipped for the external/
// absent no-ops, which launch nothing).
func runStartService(u *ui, rt, version, root, configFile string, opts startOptions, userEnv []string, plan *launchPlan) int {
	t0 := time.Now()
	x := &liveExec{u: u, rt: rt, version: version, root: root, plan: plan}
	if code := flowOneService(x, flowCtx{plan: plan, opts: opts, version: version, root: root, configFile: configFile, userEnv: userEnv}); code != 0 {
		return code
	}
	if plan != nil {
		if rp, ok := plan.Roles[opts.service]; ok && (rp.Obligation == obligationExternal || rp.Obligation == obligationAbsent) {
			return 0
		}
	}
	fmt.Println()
	fmt.Printf("%s  %s\n", u.wrap(ansiBold+ansiGreen, "🚀 "+opts.service+" is up"), u.dim("("+took(time.Since(t0))+")"))
	fmt.Printf("  Check health:  %s\n", u.bold("semiont status"))
	return 0
}

// renderServicePlan is --dry-run for --service: the same flow, plan mode.
// Real root for the same reason as renderStartPlan: the state path is
// plan-time truth; the kb mount keeps its placeholder via val().
func renderServicePlan(rt, version, root string, opts startOptions, userEnv []string, plan *launchPlan) {
	x := &planExec{rt: rt}
	x.c("semiont start --service %s --dry-run — the exact runtime commands a real", opts.service)
	x.c("run would execute, in order. Values known only at runtime appear as <placeholders>.")
	flowOneService(x, flowCtx{plan: plan, opts: opts, version: version, root: root, configFile: opts.configName, userEnv: userEnv})
}

// serviceEndpoint: the health endpoint status should probe for a service the
// launcher just (re)started. plan is nil only for browser/traces (config-free).
func serviceEndpoint(svc string, plan *launchPlan) string {
	switch svc {
	case "traces":
		return "http://localhost:16686"
	case "collector":
		return "http://localhost:24110/metrics"
	case "messaging":
		return "tcp:localhost:4222"
	case "identity":
		return identityEndpoint(plan.Roles[svc])
	case "metrics":
		return "http://localhost:9090/-/healthy"
	case "browser":
		return "http://localhost:3000"
	case "gateway":
		return fmt.Sprintf("http://localhost:%d/api/health", plan.GatewayPort)
	case "worker":
		return "http://localhost:24100/health"
	case "smelter":
		return "http://localhost:24101/health"
	case "weaver":
		return "http://localhost:24102/health"
	case "graph":
		return fmt.Sprintf("http://localhost:%d", plan.AuxPorts("graph")[0].port)
	case "vectors":
		return fmt.Sprintf("http://localhost:%d/readyz", plan.Roles[svc].Port)
	case "inference":
		return fmt.Sprintf("http://localhost:%d/api/version", plan.Roles[svc].Port)
	case "database":
		return fmt.Sprintf("tcp:localhost:%d", plan.Roles[svc].Port)
	}
	return ""
}
