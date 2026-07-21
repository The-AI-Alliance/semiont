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
	Role             string
	Obligation       obligation
	Driver           string   // config `type` (catalog key)
	Image            string   // catalog, for provided/host-fallback launches
	Address          string   // external host, for reachability probes
	Port             int      // primary port (config, else driver default)
	SharesOllamaWith string   // role under which the launcher runs the Ollama this one uses
	Models           []string // models this role uses, whoever serves them (sorted, deduped)
	OllamaServed     []string // the subset of Models that OLLAMA serves — the only ones with an install state
	Env              []string // container env derived from config (creds)
}

type launchPlan struct {
	Roles       map[string]rolePlan
	BackendPort int
	// OllamaModels: every model this config asks OLLAMA to serve — the
	// ollama-typed actor/worker bindings plus an ollama embedding. Distinct
	// from the per-role Models (which list what a role uses whoever serves
	// it): only these can be pulled, and pulling a Claude into Ollama is not
	// a thing.
	OllamaModels []string
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
		// Remote SaaS: no image (nothing to launch), port is TLS. The row it
		// yields is external — participates in status, no start/stop.
		"anthropic": {display: "Anthropic", defaultPort: 443},
	},
	// embedding drivers carry no image: the launcher never provides this
	// role. ollama means the inference role's Ollama also serves embeddings;
	// voyage is remote SaaS reached over TLS.
	"embedding": {
		"ollama": {display: "Ollama", defaultPort: 11434, portLabel: "Ollama"},
		"voyage": {display: "Voyage", defaultPort: 443, portLabel: "Voyage"},
	},
	// traces is launcher-owned (no config section yet) — catalog entry
	// carries the display name for status's TECH column.
	"traces": {
		"jaeger": {image: "jaegertracing/all-in-one:1.76.0", display: "Jaeger", defaultPort: 16686, portLabel: "Jaeger UI"},
	},
}

// ollamaModels: the models this config asks Ollama to serve — bindings whose
// inference type is ollama, plus an ollama-typed embedding. These are exactly
// the models a "pull" is defined for.
func ollamaBindingModels(env *envConfig) []string {
	seen := map[string]bool{}
	// Non-nil even when empty: "no ollama-served models here" is a real
	// answer that must survive a round trip through the record, distinct
	// from "this record predates the field".
	out := []string{}
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			if b.Inference.Type == "ollama" && b.Inference.Model != "" && !seen[b.Inference.Model] {
				seen[b.Inference.Model] = true
				out = append(out, b.Inference.Model)
			}
		}
	}
	sort.Strings(out)
	return out
}

func ollamaModels(env *envConfig) []string {
	seen := map[string]bool{}
	var out []string
	add := func(m string) {
		if m != "" && !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			if b.Inference.Type == "ollama" {
				add(b.Inference.Model)
			}
		}
	}
	if env.Embedding != nil && env.Embedding.Type == "ollama" {
		add(env.Embedding.Model)
	}
	sort.Strings(out)
	return out
}

// remoteInferenceDriver: the (sorted-first) non-ollama provider type the
// bindings name. With one remote provider — the real case — this is it; a
// hypothetical mixed-remote config gets the alphabetically first, and its
// models still all list (bindingModels is unfiltered).
func remoteInferenceDriver(env *envConfig) string {
	set := map[string]bool{}
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			if t := b.Inference.Type; t != "" && t != "ollama" {
				set[t] = true
			}
		}
	}
	types := make([]string, 0, len(set))
	for t := range set {
		types = append(types, t)
	}
	sort.Strings(types)
	if len(types) == 0 {
		return ""
	}
	return types[0]
}

// bindingModels: every model the config's actors and workers bind for
// inference, sorted and deduped. Deliberately NOT filtered by provider type:
// these are the models this stack performs inference with, whoever serves
// them — a mixed config lists all of them.
func bindingModels(env *envConfig) []string {
	seen := map[string]bool{}
	var out []string
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			if m := b.Inference.Model; m != "" && !seen[m] {
				seen[m] = true
				out = append(out, m)
			}
		}
	}
	sort.Strings(out)
	return out
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
	// NO --rm: a crashed container must remain inspectable — its logs are
	// the diagnosis (a friction log lost most of a day to --rm destroying
	// them; the runtime's `logs` answered "No such container"). Cleanup is
	// already explicit at both ends: start's preflight and stop both
	// stop+rm by name.
	a := []string{"run", "-d", "--name", roles[role].container}
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

// ollamaRunArgs: the semiont-ollama `run -d` argv. Separate from
// providedRunArgs because the OWNING role varies (inference, or embedding
// when the bindings are all-remote) while the container, image and port
// shape do not — roles[owner].container would be wrong for embedding.
func ollamaRunArgs(rp rolePlan, extra ...string) []string {
	spec := driverCatalog["inference"]["ollama"]
	a := []string{"run", "-d", "--name", "semiont-ollama"} // no --rm: see providedRunArgs
	a = append(a, "-p", fmt.Sprintf("%d:%d", rp.Port, spec.defaultPort))
	a = append(a, extra...)
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
	plan := &launchPlan{Roles: map[string]rolePlan{}, BackendPort: 4000, OllamaModels: ollamaModels(env)}
	if env.Backend != nil && env.Backend.Port != 0 {
		plan.BackendPort = env.Backend.Port
	}
	secErr := func(section, format string, a ...any) error {
		return fmt.Errorf("%s: [environments.%s.%s] %s", path, envName, section, fmt.Sprintf(format, a...))
	}
	// bindingsUseOllama: does any actor/worker perform inference through the
	// local Ollama? This decides who owns that Ollama (inference vs
	// embedding) and what the inference role IS.
	bindingsUseOllama := false
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			if b.Inference.Type == "ollama" {
				bindingsUseOllama = true
			}
		}
	}

	// classify: an address that is exactly the launcher-injected var means
	// "the launcher provides this"; anything else is externally provided.
	//
	// This DELIBERATELY ignores the section's own `platform` key (adjudicated
	// 2026-07-20), which is read only for the posix case below. The fleet's
	// configs declare platform = "external" on graph/vectors/database while
	// pointing at ${NEO4J_HOST}/${QDRANT_HOST}/${POSTGRES_HOST} — addresses
	// the launcher itself injects — so honoring the declaration would stop
	// launching Neo4j, Qdrant and PostgreSQL for every KB in the fleet.
	// Reading it there is not a latent bug to fix: "external" in those files
	// means external to the backend PROCESS, not "someone else runs it".
	// Until that word means one thing in both places, the address shape is
	// the authority. See GO-LAUNCHER.md follow-ups.
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
		img := spec.image
		if g.Image != "" {
			img = g.Image
		}
		rp := rolePlan{Role: "graph", Driver: g.Type, Port: port}
		switch {
		case g.Platform == "posix":
			rp.Obligation = obligationHostProcess
			rp.Image = img
		case classify(host, "NEO4J_HOST") == obligationProvided:
			if g.Username == "" || g.Password == "" {
				return nil, secErr("graph", "missing required key %q (needed to provision the container)", "username/password")
			}
			rp.Obligation = obligationProvided
			rp.Image = img
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
			if v.Image != "" {
				rp.Image = v.Image
			}
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
			if d.Image != "" {
				rp.Image = d.Image
			}
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

	// embedding — a role the launcher never launches. Its platform is
	// external in both shapes: ollama means the inference role's Ollama also
	// serves embeddings (same process, same port — which is why embedding has
	// no container of its own and never contends for a port), voyage means
	// remote SaaS. Absent means the KB declares no embedding at all, which
	// status reports as "not configured" exactly as it does for any other
	// unreferenced role.
	if e := env.Embedding; e == nil {
		plan.Roles["embedding"] = rolePlan{Role: "embedding", Obligation: obligationAbsent}
	} else {
		if e.Type == "" {
			return nil, secErr("embedding", "missing required key %q", "type")
		}
		spec, ok := driverCatalog["embedding"][e.Type]
		if !ok {
			return nil, secErr("embedding", "unknown type %q (known drivers: %s)", e.Type, knownDrivers("embedding"))
		}
		rawHost, port := parseHostPort(e.BaseURL)
		if port == 0 {
			port = spec.defaultPort
		}
		// ${OLLAMA_HOST} is the launcher-injected address of the machine
		// hosting Ollama; the probe runs ON that machine, so it dials
		// localhost. A voyage config usually names no baseURL at all.
		host := rawHost
		switch {
		case host == "" && e.Type == "voyage":
			host = "api.voyageai.com"
		case strings.HasPrefix(host, "${"):
			host = "localhost"
		case host == "":
			return nil, secErr("embedding", "missing required key %q", "baseURL")
		}
		rp := rolePlan{
			Role: "embedding", Obligation: obligationExternal,
			Driver: e.Type, Address: host, Port: port,
		}
		if e.Model != "" {
			rp.Models = []string{e.Model}
			rp.OllamaServed = []string{}
			if e.Type == "ollama" {
				rp.OllamaServed = []string{e.Model}
			}
		}
		// WHO runs the local Ollama an ollama embedding needs? If any actor/
		// worker binding is ollama-typed, the inference role runs it and the
		// embedding rides along (SharesOllamaWith names that, so both rows
		// report the one process the same way). If NO binding is — the
		// anthropic config: Claude does the inference, Ollama exists solely
		// for embeddings — then EMBEDDING owns the host-process dance itself,
		// and the inference role is free to be what it really is: Anthropic.
		if e.Type == "ollama" && rawHost == "${OLLAMA_HOST}" {
			if bindingsUseOllama {
				rp.SharesOllamaWith = "inference"
			} else {
				rp.Obligation = obligationHostProcess
				rp.Address = ""
				rp.Image = spec.image
				if rp.Image == "" {
					rp.Image = driverCatalog["inference"]["ollama"].image
				}
				if p, ok := env.Inference["ollama"]; ok && p.Image != "" {
					rp.Image = p.Image
				}
			}
		}
		plan.Roles["embedding"] = rp
	}

	// inference — the driver is WHO PERFORMS INFERENCE per the bindings, not
	// which process the launcher happens to run. Any ollama-typed binding →
	// the local-Ollama shape (host-process dance / external per address).
	// All-remote bindings (anthropic) → an external SaaS role: participates
	// in status, launches nothing — even when an Ollama runs locally for the
	// embedding, because that Ollama is the embedding's (see above). No
	// bindings at all → not configured.
	switch {
	case !bindingsUseOllama && len(bindingModels(env)) > 0:
		driver := remoteInferenceDriver(env)
		host, port := "", 0
		if p, ok := env.Inference[driver]; ok && p.Endpoint != "" {
			host, port = parseHostPort(p.Endpoint)
			if port == 0 && strings.HasPrefix(p.Endpoint, "https://") {
				port = 443
			}
		}
		if host == "" && driver == "anthropic" {
			host = "api.anthropic.com"
		}
		if port == 0 {
			port = driverCatalog["inference"][driver].defaultPort
		}
		if port == 0 {
			port = 443 // an unknown remote provider is still TLS SaaS
		}
		plan.Roles["inference"] = rolePlan{
			Role: "inference", Obligation: obligationExternal,
			Driver: driver, Address: host, Port: port,
			Models: bindingModels(env), OllamaServed: []string{},
		}
	case !bindingsUseOllama:
		plan.Roles["inference"] = rolePlan{Role: "inference", Obligation: obligationAbsent}
	default:
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
		img := spec.image
		if p, ok := env.Inference["ollama"]; ok && p.Image != "" {
			img = p.Image
		}
		rp := rolePlan{Role: "inference", Driver: "ollama", Port: port, Image: img}
		rp.Models = bindingModels(env)
		// Only the ollama-typed bindings have an install state. A Claude in
		// this list is served by Anthropic and must never be checked against
		// — let alone "pulled" into — Ollama.
		rp.OllamaServed = ollamaBindingModels(env)
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
