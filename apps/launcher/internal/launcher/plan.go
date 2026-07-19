package launcher

// plan.go — derivePlan: the pure function from a parsed semiontconfig
// environment to the launcher's work (LAUNCHER-CONFIG-SYNC.md's derivation
// model). Per dependency role the config decides the OBLIGATION and owns
// address/port/credentials; the driver catalog owns what the config doesn't
// declare (image, aux ports). Validation is strict for keys the launcher
// consumes (P0 q4): missing required keys fail naming file, section, and
// key; keys with documented defaults (vectors.platform, database.type,
// ports) don't trip it.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type obligation int

const (
	obligationAbsent      obligation = iota // no section / not referenced: not needed
	obligationProvided                      // launcher launches a container (driver by type)
	obligationExternal                      // provided elsewhere: verify, never launch
	obligationHostProcess                   // host process preferred (container fallback per driver)
)

func (o obligation) String() string {
	return [...]string{"absent", "provided", "external", "host-process"}[o]
}

type rolePlan struct {
	Role       string
	Obligation obligation
	Driver     string   // config `type` (catalog key)
	Image      string   // catalog, for provided/host-fallback launches
	Address    string   // external host, for reachability probes
	Port       int      // primary port (config, else driver default)
	Env        []string // container env derived from config (creds)
}

type launchPlan struct {
	Roles       map[string]rolePlan
	BackendPort int
}

// driverSpec: what the config does NOT declare about a driver — the
// launcher-side analogue of the containers' driver selection. defaultPort is
// both the config default AND the container-side listen port: a config that
// moves a port moves the HOST side only (publish host:containerDefault).
type driverSpec struct {
	image       string
	display     string // product name for banners/messages
	defaultPort int
	portLabel   string // primary port's name in conflict errors
	auxPorts    []portNeed
}

var driverCatalog = map[string]map[string]driverSpec{
	"graph": {
		"neo4j": {image: "neo4j:5.26.28-community", display: "Neo4j", defaultPort: 7687, portLabel: "Neo4j Bolt", auxPorts: []portNeed{{7474, "Neo4j HTTP"}}},
	},
	"vectors": {
		"qdrant": {image: "qdrant/qdrant:v1.18.3", display: "Qdrant", defaultPort: 6333, portLabel: "Qdrant"},
	},
	"database": {
		"postgres": {image: "postgres:15.18-alpine", display: "PostgreSQL", defaultPort: 5432, portLabel: "PostgreSQL"},
	},
	"inference": {
		"ollama": {image: "ollama/ollama", display: "Ollama", defaultPort: 11434, portLabel: "Ollama"},
	},
}

// driverDisplay: the product name behind a role's selected driver.
func driverDisplay(role, driver string) string {
	if s, ok := driverCatalog[role][driver]; ok {
		return s.display
	}
	return driver
}

// providedRunArgs builds the `run -d` argv for a launcher-provided role from
// its plan: aux ports first (byte-parity with the historical builders), then
// the primary publish (host side from config, container side the driver
// default), driver extras (inference's memory/volume), config-derived env,
// image.
func providedRunArgs(role string, rp rolePlan, extra ...string) []string {
	spec := driverCatalog[role][rp.Driver]
	a := []string{"run", "-d", "--rm", "--name", roles[role].container}
	for _, ap := range spec.auxPorts {
		a = append(a, "-p", fmt.Sprintf("%d:%d", ap.port, ap.port))
	}
	a = append(a, "-p", fmt.Sprintf("%d:%d", rp.Port, spec.defaultPort))
	a = append(a, extra...)
	for _, e := range rp.Env {
		a = append(a, "-e", e)
	}
	return append(a, rp.Image)
}

// planPortChecks: the must-be-free ports, derived from the plan — only roles
// the launcher actually provides claim ports. Order preserves the historical
// check order (graph aux, graph, vectors, database, backend, sidecars,
// frontend, traces-when-observing).
func planPortChecks(plan *launchPlan, observe bool) []portNeed {
	var checks []portNeed
	addRole := func(role string) {
		rp := plan.Roles[role]
		if rp.Obligation != obligationProvided {
			return
		}
		spec := driverCatalog[role][rp.Driver]
		checks = append(checks, spec.auxPorts...)
		checks = append(checks, portNeed{rp.Port, spec.portLabel})
	}
	addRole("graph")
	addRole("vectors")
	addRole("database")
	checks = append(checks,
		portNeed{plan.BackendPort, "Backend"},
		portNeed{9090, "Worker"},
		portNeed{9091, "Smelter"},
		portNeed{9092, "Weaver"},
		portNeed{3000, "Frontend"},
	)
	if observe {
		checks = append(checks, portNeed{16686, "Jaeger UI"}, portNeed{4318, "Jaeger OTLP"})
	}
	return checks
}

func knownDrivers(role string) string {
	names := make([]string, 0, len(driverCatalog[role]))
	for n := range driverCatalog[role] {
		names = append(names, n)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// AuxPorts: catalog-owned secondary ports for a role's selected driver
// (Neo4j's 7474 browser — the config only declares bolt).
func (p *launchPlan) AuxPorts(role string) []portNeed {
	return driverCatalog[role][p.Roles[role].Driver].auxPorts
}

// parseHostPort splits "scheme://host:port", "host:port", or bare "host" —
// the host may be a verbatim ${VAR} reference (never interpolated here).
func parseHostPort(s string) (host string, port int) {
	if _, rest, ok := strings.Cut(s, "://"); ok {
		s = rest
	}
	if i := strings.LastIndex(s, ":"); i >= 0 {
		if p, err := strconv.Atoi(s[i+1:]); err == nil {
			return s[:i], p
		}
	}
	return s, 0
}

// derivePlan maps the selected environment to per-role launch obligations.
func derivePlan(env *envConfig, envName, path string) (*launchPlan, error) {
	plan := &launchPlan{Roles: map[string]rolePlan{}, BackendPort: 4000}
	if env.Backend != nil && env.Backend.Port != 0 {
		plan.BackendPort = env.Backend.Port
	}
	secErr := func(section, format string, a ...any) error {
		return fmt.Errorf("%s: [environments.%s.%s] %s", path, envName, section, fmt.Sprintf(format, a...))
	}
	// classify: an address that is exactly the launcher-injected var means
	// "the launcher provides this"; anything else is externally provided.
	classify := func(host, injectedVar string) obligation {
		if host == "${"+injectedVar+"}" {
			return obligationProvided
		}
		return obligationExternal
	}

	// graph
	if g := env.Graph; g == nil {
		plan.Roles["graph"] = rolePlan{Role: "graph", Obligation: obligationAbsent}
	} else {
		if g.Type == "" {
			return nil, secErr("graph", "missing required key %q", "type")
		}
		spec, ok := driverCatalog["graph"][g.Type]
		if !ok {
			return nil, secErr("graph", "unknown type %q (known drivers: %s)", g.Type, knownDrivers("graph"))
		}
		if g.URI == "" {
			return nil, secErr("graph", "missing required key %q", "uri")
		}
		host, port := parseHostPort(g.URI)
		if port == 0 {
			port = spec.defaultPort
		}
		rp := rolePlan{Role: "graph", Driver: g.Type, Port: port}
		switch {
		case g.Platform == "posix":
			rp.Obligation = obligationHostProcess
			rp.Image = spec.image
		case classify(host, "NEO4J_HOST") == obligationProvided:
			if g.Username == "" || g.Password == "" {
				return nil, secErr("graph", "missing required key %q (needed to provision the container)", "username/password")
			}
			rp.Obligation = obligationProvided
			rp.Image = spec.image
			rp.Env = []string{"NEO4J_AUTH=" + g.Username + "/" + g.Password, "NEO4J_ACCEPT_LICENSE_AGREEMENT=yes"}
		default:
			rp.Obligation = obligationExternal
			rp.Address = host
		}
		plan.Roles["graph"] = rp
	}

	// vectors — platform defaults to "external" (the template omits it);
	// type is required.
	if v := env.Vectors; v == nil {
		plan.Roles["vectors"] = rolePlan{Role: "vectors", Obligation: obligationAbsent}
	} else {
		if v.Type == "" {
			return nil, secErr("vectors", "missing required key %q", "type")
		}
		spec, ok := driverCatalog["vectors"][v.Type]
		if !ok {
			return nil, secErr("vectors", "unknown type %q (known drivers: %s)", v.Type, knownDrivers("vectors"))
		}
		if v.Host == "" {
			return nil, secErr("vectors", "missing required key %q", "host")
		}
		port := v.Port
		if port == 0 {
			port = spec.defaultPort
		}
		rp := rolePlan{Role: "vectors", Driver: v.Type, Port: port}
		if classify(v.Host, "QDRANT_HOST") == obligationProvided {
			rp.Obligation = obligationProvided
			rp.Image = spec.image
		} else {
			rp.Obligation = obligationExternal
			rp.Address = v.Host
		}
		plan.Roles["vectors"] = rp
	}

	// database — type defaults to "postgres" (the template omits it).
	if d := env.Database; d == nil {
		plan.Roles["database"] = rolePlan{Role: "database", Obligation: obligationAbsent}
	} else {
		typ := d.Type
		if typ == "" {
			typ = "postgres"
		}
		spec, ok := driverCatalog["database"][typ]
		if !ok {
			return nil, secErr("database", "unknown type %q (known drivers: %s)", typ, knownDrivers("database"))
		}
		if d.Host == "" {
			return nil, secErr("database", "missing required key %q", "host")
		}
		port := d.Port
		if port == 0 {
			port = spec.defaultPort
		}
		rp := rolePlan{Role: "database", Driver: typ, Port: port}
		if classify(d.Host, "POSTGRES_HOST") == obligationProvided {
			if d.Password == "" {
				return nil, secErr("database", "missing required key %q (needed to provision the container)", "password")
			}
			if d.Name == "" {
				return nil, secErr("database", "missing required key %q (needed to provision the container)", "name")
			}
			rp.Obligation = obligationProvided
			rp.Image = spec.image
			rp.Env = []string{"POSTGRES_PASSWORD=" + d.Password, "POSTGRES_DB=" + d.Name}
			// POSTGRES_USER only when it departs from the image default —
			// keeps derivation byte-identical with today's argv.
			if d.User != "" && d.User != "postgres" {
				rp.Env = append(rp.Env, "POSTGRES_USER="+d.User)
			}
		} else {
			rp.Obligation = obligationExternal
			rp.Address = d.Host
		}
		plan.Roles["database"] = rp
	}

	// inference — needed iff the config references ollama (embedding, or any
	// actor/worker binding); the anthropic provider is remote SaaS, nothing
	// for the launcher to run. Address ${OLLAMA_HOST} means the host-process-
	// preferred dance (probe host Ollama, container fallback) — the config's
	// inference.ollama.platform = "posix" made explicit.
	ollamaUsed := env.Embedding != nil && env.Embedding.Type == "ollama"
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			if b.Inference.Type == "ollama" {
				ollamaUsed = true
			}
		}
	}
	if !ollamaUsed {
		plan.Roles["inference"] = rolePlan{Role: "inference", Obligation: obligationAbsent}
	} else {
		spec := driverCatalog["inference"]["ollama"]
		baseURL := ""
		if env.Embedding != nil && env.Embedding.Type == "ollama" {
			baseURL = env.Embedding.BaseURL
		}
		if p, ok := env.Inference["ollama"]; ok && baseURL == "" {
			baseURL = p.BaseURL
		}
		if baseURL == "" {
			return nil, secErr("embedding", "missing required key %q (ollama is referenced but has no baseURL)", "baseURL")
		}
		host, port := parseHostPort(baseURL)
		if port == 0 {
			port = spec.defaultPort
		}
		rp := rolePlan{Role: "inference", Driver: "ollama", Port: port, Image: spec.image}
		if host == "${OLLAMA_HOST}" {
			rp.Obligation = obligationHostProcess
		} else {
			rp.Obligation = obligationExternal
			rp.Address = host
			rp.Image = ""
		}
		plan.Roles["inference"] = rp
	}

	return plan, nil
}
