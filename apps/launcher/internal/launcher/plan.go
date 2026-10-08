package launcher

// plan.go — derivePlan: the pure function from a parsed semiontconfig
// environment to the launcher's work. Per dependency role the config decides
// the OBLIGATION and owns address and port, and the credentials of a daemon
// the launcher does not run; the driver catalog owns what the config doesn't
// declare (image, aux ports). Validation is strict for keys the launcher
// consumes: missing required keys fail naming file, section, and key; keys
// with documented defaults (vectors.platform, database.type, ports) don't
// trip it.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// presence: whether a role is part of this stack, and WHO runs it. What the
// launcher may change inside a service is a separate question — `authority`,
// declared on the descriptor — and the memory preflight reads presence
// because "do we run it" is genuinely its question.
//
// `absent` is not a way to run. It is a presence — the role is not here —
// and naming it so is what stops it being treated as a fourth mechanism.
//
// Distinct from ServiceState.Provided, which shares this vocabulary and is
// NOT a restatement of it: presence is plan-time INTENT (host preferred, a
// container if there is none), Provided is the OUTCOME a start recorded.
type presence int

const (
	presenceAbsent        presence = iota // no section / not referenced: not needed
	presenceLauncher                      // the launcher runs it here (driver by type)
	presenceExternal                      // somebody else runs it: verify, never launch
	presenceHostPreferred                 // a host process is preferred; a container is the fallback
)

func (p presence) String() string {
	return [...]string{"absent", "provided", "external", "host-process"}[p]
}

type rolePlan struct {
	Role             string
	Presence         presence
	Driver           string        // config `type` (catalog key)
	Image            string        // catalog, for provided/host-fallback launches
	Address          string        // external host, for reachability probes
	Port             int           // primary port (config, else driver default)
	SharesOllamaWith string        // role under which the launcher runs the Ollama this one uses
	Models           []servedModel // models this role uses, each with the provider that serves it
	Env              []string      // container env derived from config (no credential: those are added at launch)
	// User: the login a launcher-kept password belongs to (graph: NEO4J_AUTH's
	// user half).
	User string
	// ExternalDBPassword: identity on an EXTERNAL PostgreSQL — the config's
	// [database] password as written, resolved at launch by the shared rule.
	ExternalDBPassword string
	// APIKey: inference on a remote provider — its [inference] apiKey as
	// written, resolved by the shared rule for the remote-model check.
	APIKey string
	// CmdExtra: arguments appended AFTER the driver's own command. The
	// messaging role uses it for `-c` when the broker is authenticated; the
	// path is fixed, so the derivation can state it and the flow only has to
	// mount the file there.
	CmdExtra []string
	Issuer   string // identity: the OIDC issuer URL as configured
	// AccessTokenLifespan: seconds, for the realm the launcher imports.
	// Zero means the built-in default; only a launcher-run Keycloak has one.
	AccessTokenLifespan int
}

type launchPlan struct {
	Roles       map[string]rolePlan
	GatewayPort int
	// EnvName is the [defaults]-selected environment — staging needs it to
	// address the section it stages (see stagedServiceConfig).
	EnvName string
	// OllamaModels: every model this config asks OLLAMA to serve — the
	// ollama-typed actor/worker bindings plus an ollama embedding. Distinct
	// from the per-role Models (which list what a role uses whoever serves
	// it): only these can be pulled, and pulling a Claude into Ollama is not
	// a thing.
	//
	// Each carries the ROLES that asked for it. One Ollama can serve both
	// inference and embedding, so this set crosses role boundaries: it is
	// provisioned under the inference banner but a failure here may be an
	// EMBEDDING failure. Output must name the role, not the section it
	// happened to be printed under.
	OllamaModels []modelNeed
	// ServiceVars: the user variables each stack service is handed — only
	// those its own config sections reference.
	ServiceVars map[string][]string
}

// The two roles a model can be asked to serve. Providers vary (ollama,
// anthropic, voyage); these do not.
const (
	roleInference = "inference"
	roleEmbedding = "embedding"
)

// modelNeed: a model that must be present, and the roles that asked for it —
// the sibling of portNeed. (Not ollamaModel, which is Ollama's /api/tags
// response shape: what it HAS, not what the config wants.)
type modelNeed struct {
	Name  string
	Roles []string // roleInference and/or roleEmbedding
}

// servedModel: one model a role uses and the provider that serves it — the
// config `type` of the binding or section that names it. A role's driver does
// not say this: a config can point workers at Anthropic and one job type at
// Ollama, and the inference row then lists Claude under a driver of "ollama".
// The pair is also how key holders report limits.
type servedModel struct {
	Model    string `json:"model"`
	Provider string `json:"provider"`
}

// servedBy: the names of the models one provider serves.
func servedBy(models []servedModel, provider string) []string {
	var out []string
	for _, m := range models {
		if m.Provider == provider {
			out = append(out, m.Model)
		}
	}
	return out
}

// ollamaModels: the models this config asks Ollama to serve — bindings whose
// inference type is ollama, plus an ollama-typed embedding. These are exactly
// the models a "pull" is defined for.
func ollamaModels(env *envConfig) []modelNeed {
	idx := map[string]*modelNeed{}
	var names []string
	add := func(name, role string) {
		if name == "" {
			return
		}
		m, ok := idx[name]
		if !ok {
			m = &modelNeed{Name: name}
			idx[name] = m
			names = append(names, name)
		}
		for _, r := range m.Roles {
			if r == role {
				return
			}
		}
		m.Roles = append(m.Roles, role)
	}
	// Every actor/worker binding is the INFERENCE role however many bindings
	// name the same model; the embedding role is added last, so Roles ends up
	// deterministically ordered despite Go's map iteration.
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			if b.Inference.Type == "ollama" {
				add(b.Inference.Model, roleInference)
			}
		}
	}
	if env.Embedding != nil && env.Embedding.Type == "ollama" {
		add(env.Embedding.Model, roleEmbedding)
	}
	sort.Strings(names)
	out := make([]modelNeed, 0, len(names))
	for _, n := range names {
		out = append(out, *idx[n])
	}
	return out
}

// modelNames: just the names, for the places that only need the list.
func modelNames(models []modelNeed) []string {
	out := make([]string, 0, len(models))
	for _, m := range models {
		out = append(out, m.Name)
	}
	return out
}

// modelRoles: the union of roles across a model set, in a stable order — what
// a provisioning step is FOR, said in role terms rather than provider terms.
func modelRoles(models []modelNeed) []string {
	var out []string
	for _, want := range []string{roleInference, roleEmbedding} {
		for _, m := range models {
			for _, r := range m.Roles {
				if r == want {
					out = append(out, want)
					goto next
				}
			}
		}
	next:
	}
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

// remoteProviderAddress: where a remote inference provider's API is — the
// endpoint its section states, else the provider's own. ONE decider: the
// inference role the remote-model check dials (saasBase), and the address a
// worker's document gives an agent whose section states none (workerdoc.go).
func remoteProviderAddress(env *envConfig, driver string) (host string, port int) {
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
		port = descriptorFor("inference", driver).defaultPort
	}
	if port == 0 {
		port = 443 // an unknown remote provider is still TLS SaaS
	}
	return host, port
}

// bindingModels: every model the config's actors and workers bind for
// inference, with its provider, sorted and deduped. Deliberately NOT filtered
// by provider: these are the models this stack performs inference with,
// whoever serves them — a mixed config lists all of them.
func bindingModels(env *envConfig) []servedModel {
	seen := map[servedModel]bool{}
	var out []servedModel
	for _, bindings := range []map[string]bindingCfg{env.Actors, env.Workers} {
		for _, b := range bindings {
			m := servedModel{Model: b.Inference.Model, Provider: b.Inference.Type}
			if m.Model != "" && !seen[m] {
				seen[m] = true
				out = append(out, m)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Model != out[j].Model {
			return out[i].Model < out[j].Model
		}
		return out[i].Provider < out[j].Provider
	})
	return out
}

// driverDisplay: the product name behind a role's selected driver.
func driverDisplay(role, driver string) string {
	if s, ok := lookupDescriptor(role, driver); ok {
		return s.display
	}
	return driver
}

// providedRunArgs builds the `run -d` argv for a launcher-provided role from
// its plan: aux ports first, then the primary publish (host side from
// config, container side the driver default), driver extras (inference's
// memory/volume), config-derived env, image.
func providedRunArgs(role string, rp rolePlan, extra ...string) []string {
	spec := descriptorFor(role, rp.Driver)
	// NO --rm: a crashed container must remain inspectable — its logs are
	// the diagnosis, and --rm destroys them (the runtime's `logs` answers
	// "No such container"). Cleanup is already explicit at both ends:
	// start's preflight and stop both stop+rm by name.
	a := []string{"run", "-d", "--name", spec.container, "--memory", spec.mem}
	for _, ap := range spec.auxPorts {
		a = append(a, "-p", fmt.Sprintf("%d:%d", ap.port, ap.port))
	}
	a = append(a, "-p", fmt.Sprintf("%d:%d", rp.Port, spec.defaultPort))
	a = append(a, extra...)
	for _, e := range rp.Env {
		a = append(a, "-e", e)
	}
	a = append(a, rp.Image)
	a = append(a, spec.cmd...)
	return append(a, rp.CmdExtra...)
}

// ollamaRunArgs: the semiont-ollama `run -d` argv. Separate from
// providedRunArgs because the OWNING role varies (inference, or embedding
// when the bindings are all-remote) while the container, image and port
// shape do not — the OWNER's descriptor would be wrong for embedding, whose
// row carries no container precisely because it never runs one.
func ollamaRunArgs(rp rolePlan, extra ...string) []string {
	spec := descriptorFor("inference", "ollama")
	// The ceiling is the INFERENCE row's whichever role owns the container
	// (an all-remote embedding config still runs one Ollama), and it comes
	// from the descriptor ALONE — a second -m from a caller wins by flag
	// order and desyncs the memory preflight.
	a := []string{"run", "-d", "--name", spec.container, "--memory", spec.mem} // no --rm: see providedRunArgs
	a = append(a, "-p", fmt.Sprintf("%d:%d", rp.Port, spec.defaultPort))
	a = append(a, extra...)
	return append(a, rp.Image)
}

// planPortChecks: the must-be-free ports, derived from the plan — only roles
// the launcher actually provides claim ports. The order is the order the
// checks run in, and the start goldens pin it.
func planPortChecks(plan *launchPlan, observe bool) []portNeed {
	var checks []portNeed
	addRole := func(role string) {
		rp := plan.Roles[role]
		if rp.Presence != presenceLauncher {
			return
		}
		spec := descriptorFor(role, rp.Driver)
		checks = append(checks, spec.auxPorts...)
		checks = append(checks, portNeed{rp.Port, spec.portLabel})
	}
	addRole("graph")
	addRole("vectors")
	addRole("database")
	addRole("messaging")
	addRole("identity")
	// The gateway's port is config-owned; every other Semiont port is
	// launcher fiat and comes from the descriptor set. No browser here: the
	// Browser is not a stack member — its port is checked inside flowBrowser,
	// and only when (re)starting.
	checks = append(checks, portNeed{plan.GatewayPort, "Gateway"})
	return append(checks, fiatPortNeeds(observe)...)
}

// fiatPortNeeds: the ports a stack claims whatever its config says — the
// Semiont services behind the gateway, then observability. ONE list for the
// two sites that decide it: a full start requires these free, and a stop
// holding no record of the stack's claims verifies these released.
func fiatPortNeeds(observe bool) []portNeed {
	var needs []portNeed
	for _, role := range []string{"worker", "smelter", "weaver", "archivist", "librarian", "dispatcher"} {
		needs = append(needs, stackPortNeeds(role)...)
	}
	// The collector runs on every start, observed or not.
	needs = append(needs, stackPortNeeds("collector")...)
	if observe {
		// --no-observe declines the observability BACKENDS (Jaeger, Prometheus).
		needs = append(needs, stackPortNeeds("traces")...)
		needs = append(needs, stackPortNeeds("metrics")...)
	}
	return needs
}

func knownDrivers(role string) string {
	return strings.Join(driversFor(role), ", ")
}

// AuxPorts: catalog-owned secondary ports for a role's selected driver
// (Neo4j's 7474 browser — the config only declares bolt).
func (p *launchPlan) AuxPorts(role string) []portNeed {
	return descriptorFor(role, p.Roles[role].Driver).auxPorts
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

// derivePlan maps the selected environment to each role's presence.
// keycloakPort is KEYCLOAK_PORT as this launch resolves it (keycloakPort in
// root.go) — the value an issuer's ${KEYCLOAK_PORT} names.
func derivePlan(env *envConfig, envName, path string, keycloakPort int) (*launchPlan, error) {
	plan := &launchPlan{Roles: map[string]rolePlan{}, GatewayPort: 4000, EnvName: envName, OllamaModels: ollamaModels(env)}
	if env.Gateway != nil && env.Gateway.Port != 0 {
		plan.GatewayPort = env.Gateway.Port
	}
	secErr := func(section, format string, a ...any) error {
		return fmt.Errorf("%s: [environments.%s.%s] %s", path, envName, section, fmt.Sprintf(format, a...))
	}
	// launcherOwnedErr: a config names the credential of a daemon the
	// launcher runs, which the launcher generates and keeps.
	launcherOwnedErr := func(section, key, daemon string) error {
		return secErr(section, "names a %s, but the launcher generates and keeps the credentials of the %s it runs — delete the key (to rotate: delete its file in this root's state dir, then semiont clean --store)", key, daemon)
	}
	// envErr names the ENVIRONMENT rather than one of its sections — for the
	// refusals where the missing thing IS the section, so secErr's prefix
	// would point at a heading that does not exist.
	envErr := func(format string, a ...any) error {
		return fmt.Errorf("%s: [environments.%s] %s", path, envName, fmt.Sprintf(format, a...))
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

	// somebodyElses: who runs the daemon a section names. `platform =
	// "external"` is how a config says somebody else does: the section then
	// states where it is, and the launcher verifies it and launches nothing.
	// Under any other platform, or none, the daemon is the launcher's to run
	// and to place, and an address stated there is refused: it would be a
	// second answer to who runs it.
	//
	// The launcher's own reference is the launcher's whatever the platform
	// says — what loadConfig writes where no address is stated (topology.go),
	// and what a config commits under `platform = "external"` when it means
	// external to the gateway process.
	somebodyElses := func(section, key, platform, address, host, reference string) (bool, error) {
		switch {
		case referenceName(host) == reference:
			return false, nil
		case platform != "external":
			return false, secErr(section, "states %s = %q, and the launcher places every daemon it runs — add platform = \"external\" if somebody else runs this one, or delete %s", key, address, key)
		case address == "":
			return false, secErr(section, "says platform = \"external\": somebody else runs this, so the section states where — add %q", key)
		}
		return true, nil
	}

	// graph
	if g := env.Graph; g == nil {
		plan.Roles["graph"] = rolePlan{Role: "graph", Presence: presenceAbsent}
	} else {
		if g.Type == "" {
			return nil, secErr("graph", "missing required key %q", "type")
		}
		spec, ok := lookupDescriptor("graph", g.Type)
		if !ok {
			return nil, secErr("graph", "unknown type %q (known drivers: %s)", g.Type, knownDrivers("graph"))
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
		external, err := somebodyElses("graph", "uri", g.Platform, g.URI, host, "NEO4J_HOST")
		if err != nil {
			return nil, err
		}
		switch {
		case external:
			rp.Presence = presenceExternal
			rp.Address = host
		case g.Platform == "posix":
			rp.Presence = presenceHostPreferred
			rp.Image = img
		default:
			if g.Password != "" {
				return nil, launcherOwnedErr("graph", "password", "Neo4j")
			}
			if g.Username == "" {
				return nil, secErr("graph", "missing required key %q (needed to provision the container)", "username")
			}
			rp.Presence = presenceLauncher
			rp.Image = img
			rp.User = g.Username
			rp.Env = []string{"NEO4J_ACCEPT_LICENSE_AGREEMENT=yes"}
		}
		plan.Roles["graph"] = rp
	}

	// vectors — REQUIRED. Semantic search is always available, so the
	// gateway's TOML loader refuses a config that names no vector store; the
	// launcher reads the same file with its own structs, so it refuses the
	// same configs, one round trip earlier — before a single container is
	// launched. Same rule, same words. platform defaults to "external" (the
	// template omits it); type is required, and the address is the
	// launcher's unless the config states one.
	v := env.Vectors
	if v == nil {
		return nil, envErr(`names no vector store — add [environments.%s.vectors] with type = "qdrant". Semiont requires a vector store; nothing is defaulted.`, envName)
	}
	if v.Type == "" {
		return nil, secErr("vectors", "missing required key %q", "type")
	}
	// `memory` is a first-class store to the GATEWAY, and unusable here: a
	// launcher-managed stack runs the gateway and the Smelter as separate
	// containers, and an in-process index cannot be shared across processes.
	// Named explicitly so an operator who followed the loader's own advice is
	// told WHY, rather than that the value is unknown.
	if v.Type == "memory" {
		return nil, secErr("vectors", `type "memory" keeps the index inside one process, and a launcher-managed stack runs the gateway and the Smelter as separate containers — they cannot share it. Use type = "qdrant" here.`)
	}
	vspec, knownVectors := lookupDescriptor("vectors", v.Type)
	if !knownVectors {
		return nil, secErr("vectors", "unknown type %q (known drivers: %s)", v.Type, knownDrivers("vectors"))
	}
	vectorsPort := v.Port
	if vectorsPort == 0 {
		vectorsPort = vspec.defaultPort
	}
	vectorsPlan := rolePlan{Role: "vectors", Driver: v.Type, Port: vectorsPort}
	vectorsExternal, err := somebodyElses("vectors", "host", v.Platform, v.Host, v.Host, "QDRANT_HOST")
	if err != nil {
		return nil, err
	}
	if !vectorsExternal {
		vectorsPlan.Presence = presenceLauncher
		vectorsPlan.Image = vspec.image
		if v.Image != "" {
			vectorsPlan.Image = v.Image
		}
	} else {
		vectorsPlan.Presence = presenceExternal
		vectorsPlan.Address = v.Host
	}
	plan.Roles["vectors"] = vectorsPlan

	// database — type defaults to "postgres" (the template omits it).
	if d := env.Database; d == nil {
		plan.Roles["database"] = rolePlan{Role: "database", Presence: presenceAbsent}
	} else {
		typ := d.Type
		if typ == "" {
			typ = "postgres"
		}
		spec, ok := lookupDescriptor("database", typ)
		if !ok {
			return nil, secErr("database", "unknown type %q (known drivers: %s)", typ, knownDrivers("database"))
		}
		port := d.Port
		if port == 0 {
			port = spec.defaultPort
		}
		rp := rolePlan{Role: "database", Driver: typ, Port: port}
		external, err := somebodyElses("database", "host", d.Platform, d.Host, d.Host, "POSTGRES_HOST")
		if err != nil {
			return nil, err
		}
		if !external {
			if d.Password != "" {
				return nil, launcherOwnedErr("database", "password", "PostgreSQL")
			}
			if d.Name == "" {
				return nil, secErr("database", "missing required key %q (needed to provision the container)", "name")
			}
			rp.Presence = presenceLauncher
			rp.Image = spec.image
			if d.Image != "" {
				rp.Image = d.Image
			}
			rp.Env = []string{"POSTGRES_DB=" + d.Name}
			// POSTGRES_USER only when it departs from the image default.
			if d.User != "" && d.User != "postgres" {
				rp.Env = append(rp.Env, "POSTGRES_USER="+d.User)
			}
		} else {
			rp.Presence = presenceExternal
			rp.Address = d.Host
		}
		plan.Roles["database"] = rp
	}

	// messaging — the shared NATS daemon. The dispatcher's queue is JetStream,
	// so [jobs] is required and always starts it; [signal] type = "nats" rides
	// the same daemon. One role is one daemon: when [signal] names the broker,
	// its servers and credentials must agree with [jobs] — a config error,
	// never silently reconciled. The daemon has ONE shape, -js with the stamped
	// store, because both use that store: the job queue's stream, and the
	// signal driver's KV tables, where the gateway's ledger keeps its claims.
	j := env.Jobs
	sig := env.Signal
	if j == nil || j.Type != "jetstream" {
		return nil, envErr(`must declare [environments.%s.jobs] with type = "jetstream": the dispatcher's queue is JetStream`, envName)
	}
	if sig != nil {
		switch sig.Type {
		case "":
			return nil, secErr("signal", "missing required key %q", "type")
		case "in-process", "nats":
		default:
			return nil, secErr("signal", "unknown type %q (use \"in-process\", or \"nats\")", sig.Type)
		}
	}
	user, pass := j.User, j.Password
	// credSection names the section a credential refusal points at: [jobs],
	// unless the only credential in play is [signal]'s.
	credSection := "jobs"
	if sig != nil && sig.Type == "nats" {
		if sig.Servers != j.Servers {
			return nil, secErr("signal", "[jobs] and [signal] name different servers (%q vs %q) — one role is one daemon; they must match", j.Servers, sig.Servers)
		}
		if (sig.Platform == "external") != (j.Platform == "external") {
			return nil, secErr("signal", "[jobs] and [signal] disagree on who runs the broker (platform %q vs %q) — one role is one daemon; they must match", j.Platform, sig.Platform)
		}
		if user != "" && sig.User != "" && sig.User != user {
			return nil, secErr("signal", "[jobs] and [signal] name different broker users (%q vs %q) — one role is one daemon; they must match", j.User, sig.User)
		}
		if pass != "" && sig.Password != "" && sig.Password != pass {
			return nil, secErr("signal", "[jobs] and [signal] name different broker passwords — one role is one daemon; they must match")
		}
		if user == "" && pass == "" && (sig.User != "" || sig.Password != "") {
			credSection = "signal"
		}
		if user == "" {
			user = sig.User
		}
		if pass == "" {
			pass = sig.Password
		}
	}
	if (user == "") != (pass == "") {
		return nil, secErr(credSection, "broker credentials are incomplete — set both %q and %q, or neither", "user", "password")
	}

	spec := descriptorFor("messaging", "jetstream")
	host, port := parseHostPort(j.Servers)
	if port == 0 {
		port = spec.defaultPort
	}
	messaging := rolePlan{Role: "messaging", Driver: "jetstream", Port: port}
	brokerExternal, err := somebodyElses("jobs", "servers", j.Platform, j.Servers, host, "NATS_HOST")
	if err != nil {
		return nil, err
	}
	if !brokerExternal {
		// The broker the launcher runs is always authenticated, with a pair
		// the launcher keeps: a config naming one is a second place deciding
		// it.
		if user != "" || pass != "" {
			return nil, launcherOwnedErr(credSection, "user/password", "the broker")
		}
		messaging.Presence = presenceLauncher
		messaging.Image = spec.image
		// The pair arrives as the daemon's own environment at launch.
		// nats-server reads no credential from the environment by itself,
		// so the staged config interpolates the two names.
		messaging.CmdExtra = []string{"-c", natsConfPath}
	} else {
		// Semiont's clients authenticate to a broker by username and
		// password only; one somebody else runs, reached without them,
		// lets anyone who reaches it read and write the job queue and
		// the signal plane.
		if user == "" {
			return nil, secErr("jobs", "broker %s is not run by the launcher, so it needs credentials — set %q and %q", host, "user", "password")
		}
		messaging.Presence = presenceExternal
		messaging.Address = host
	}
	plan.Roles["messaging"] = messaging

	// identity — the OIDC issuer the gateway trusts. One shape for both types:
	// the issuer is stated, never inferred. The AUDIENCE is not configured at
	// all — it is the KB's own resource identifier, derived from the committed
	// did:web domain, so it cannot disagree with the identity the KB already
	// publishes. A keycloak whose issuer the config leaves to the launcher is
	// provided — launched with the staged realm, its database on the PostgreSQL
	// the [database] section names. An issuer the config states, and every oidc
	// issuer, is external: verified, never launched.
	// MANDATORY: a stack with no identity role is one nobody can sign in to
	// and whose gateway cannot reach its own record.
	if env.Identity == nil {
		return nil, secErr("identity", "no section — every knowledge base trusts an issuer; add type and issuer")
	}
	{
		id := env.Identity
		switch id.Type {
		case "":
			return nil, secErr("identity", "missing required key %q", "type")
		case "keycloak", "oidc":
		default:
			return nil, secErr("identity", "unknown type %q (use \"keycloak\", or \"oidc\")", id.Type)
		}
		// Only an issuer somebody else runs can be unstated here: loadConfig
		// places a keycloak's.
		if id.Issuer == "" {
			return nil, secErr("identity", "missing required key %q — an issuer Semiont does not run is stated, never inferred (the URL in a token's iss claim)", "issuer")
		}
		if id.SubjectClaim == "" {
			return nil, secErr("identity", "missing required key %q (e.g. \"sub\" — the issuer claim a person's DID is built from: did:web:<site domain>:users:<its value>)", "subjectClaim")
		}
		spec := descriptorFor("identity", id.Type)
		// The port is the launcher's to place, like the host — but unlike the
		// host it is a NUMBER every planning decision needs (publish, port
		// checks, the realm's endpoint), so it resolves here. The host stays
		// a reference: classify reads it as the launcher's.
		host, port, path, err := splitIssuer(strings.ReplaceAll(id.Issuer, "${KEYCLOAK_PORT}", strconv.Itoa(keycloakPort)))
		if err != nil {
			return nil, secErr("identity", "issuer %q %v", id.Issuer, err)
		}
		if port == 0 {
			port = spec.defaultPort
		}
		// accessTokenLifespan is the realm's to honour, so it is only ours to
		// set when we write the realm. Naming it against an issuer somebody
		// else runs is refused rather than ignored: silently dropping it would
		// leave an operator believing they had shortened their revocation
		// window.
		lifespan := keycloakAccessTokenLifespan
		if id.AccessTokenLifespan != nil {
			if id.Type != "keycloak" {
				return nil, secErr("identity", "accessTokenLifespan applies only to type = \"keycloak\" — an issuer Semiont does not run sets its own token lifetimes")
			}
			if *id.AccessTokenLifespan <= 0 {
				return nil, secErr("identity", "accessTokenLifespan must be a positive number of seconds, not %d", *id.AccessTokenLifespan)
			}
			lifespan = *id.AccessTokenLifespan
		}
		rp := rolePlan{Role: "identity", Driver: id.Type, Port: port, Issuer: id.Issuer, AccessTokenLifespan: lifespan}
		// An oidc issuer is somebody else's by its type; a keycloak says so.
		keycloakExternal := false
		if id.Type == "keycloak" {
			if keycloakExternal, err = somebodyElses("identity", "issuer", id.Platform, id.Issuer, host, "KEYCLOAK_HOST"); err != nil {
				return nil, err
			}
		}
		switch {
		case id.Type == "keycloak" && !keycloakExternal:
			if keycloakRealm(path) == "" {
				return nil, secErr("identity", "issuer %q must end in /realms/<realm> for type \"keycloak\"", id.Issuer)
			}
			// The driver REQUIRES the role, the config DECLARES it, and
			// the refusal is rendered from the edge — so the requirement has
			// one home and this branch cannot disagree with the descriptor.
			if dep, unmet := unmetRequirement(env.declaresRole, "identity", id.Type); unmet {
				return nil, secErr("identity", "type = %q needs a [%s] section — %s", id.Type, dep.role, dep.because)
			}
			d := env.Database
			// A launcher-run PostgreSQL's password is kept by the launcher and
			// handed to Keycloak at launch; an external one's is the config's
			// reference, resolved then.
			if plan.Roles["database"].Presence != presenceLauncher {
				if d.Password == "" {
					return nil, secErr("identity", "[database] names no password — Keycloak dials the external PostgreSQL with it")
				}
				rp.ExternalDBPassword = d.Password
			}
			user := d.User
			if user == "" {
				user = "postgres"
			}
			rp.Presence = presenceLauncher
			rp.Image = spec.image
			if id.Image != "" {
				rp.Image = id.Image
			}
			rp.Env = []string{"KC_DB=postgres", "KC_DB_USERNAME=" + user,
				"KC_BOOTSTRAP_ADMIN_USERNAME=" + keycloakAdminUser}
		case referenceName(host) != "":
			return nil, secErr("identity", "issuer %q names an address only the launcher's own Keycloak has — state the issuer's URL, or use type = \"keycloak\" and state none", id.Issuer)
		default:
			rp.Presence = presenceExternal
			rp.Address = host
		}
		plan.Roles["identity"] = rp
	}

	// embedding — REQUIRED, and a role the launcher never launches. Its
	// platform is external in both shapes: ollama means the inference role's
	// Ollama also serves embeddings (same process, same port — which is why
	// embedding has no container of its own and never contends for a port),
	// voyage means remote SaaS. Type AND model are both required, matching the
	// gateway loader exactly: half a rule enforced here is the drift this
	// refusal exists to end.
	if e := env.Embedding; e == nil {
		return nil, envErr(`names no embedding provider — add [environments.%s.embedding] with type = "ollama" or "voyage" and a model. Semiont requires an embedding provider; nothing is defaulted.`, envName)
	} else {
		if e.Type == "" {
			return nil, secErr("embedding", "missing required key %q", "type")
		}
		if e.Model == "" {
			return nil, secErr("embedding", "missing required key %q", "model")
		}
		spec, ok := lookupDescriptor("embedding", e.Type)
		if !ok {
			return nil, secErr("embedding", "unknown type %q (known drivers: %s)", e.Type, knownDrivers("embedding"))
		}
		rawHost, port := parseHostPort(e.BaseURL)
		if port == 0 {
			port = spec.defaultPort
		}
		// An ollama embedding is served by the stack's own Ollama unless the
		// section says somebody else runs one. Voyage is remote by its type.
		ownOllama := false
		if e.Type == "ollama" {
			external, err := somebodyElses("embedding", "baseURL", e.Platform, e.BaseURL, rawHost, "OLLAMA_HOST")
			if err != nil {
				return nil, err
			}
			ownOllama = !external
		}
		// The launcher's reference is the address of the machine hosting
		// Ollama; the probe runs ON that machine, so it dials localhost. A
		// voyage config usually names no baseURL at all.
		host := rawHost
		switch {
		case host == "" && e.Type == "voyage":
			host = "api.voyageai.com"
		case referenceName(host) != "":
			host = "localhost"
		}
		rp := rolePlan{
			Role: "embedding", Presence: presenceExternal,
			Driver: e.Type, Address: host, Port: port,
		}
		rp.Models = []servedModel{{Model: e.Model, Provider: e.Type}}
		// WHO runs the local Ollama an ollama embedding needs? If any actor/
		// worker binding is ollama-typed, the inference role runs it and the
		// embedding rides along (SharesOllamaWith names that, so both rows
		// report the one process the same way). If NO binding is — the
		// anthropic config: Claude does the inference, Ollama exists solely
		// for embeddings — then EMBEDDING owns the host-process dance itself,
		// and the inference role is free to be what it really is: Anthropic.
		if ownOllama {
			if bindingsUseOllama {
				rp.SharesOllamaWith = "inference"
			} else {
				rp.Presence = presenceHostPreferred
				rp.Address = ""
				rp.Image = spec.image
				if rp.Image == "" {
					rp.Image = descriptorFor("inference", "ollama").image
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
		host, port := remoteProviderAddress(env, driver)
		plan.Roles["inference"] = rolePlan{
			Role: "inference", Presence: presenceExternal,
			Driver: driver, Address: host, Port: port,
			Models: bindingModels(env),
			APIKey: env.Inference[driver].APIKey,
		}
	case !bindingsUseOllama:
		plan.Roles["inference"] = rolePlan{Role: "inference", Presence: presenceAbsent}
	default:
		spec := descriptorFor("inference", "ollama")
		// Where the Ollama that performs inference is: the embedding's, when
		// the embedding is ollama too (one process serves both), else the
		// provider section's.
		section, platform, baseURL := "", "", ""
		if env.Embedding != nil && env.Embedding.Type == "ollama" {
			section, platform, baseURL = "embedding", env.Embedding.Platform, env.Embedding.BaseURL
		}
		if p, ok := env.Inference["ollama"]; ok && baseURL == "" {
			section, platform, baseURL = "inference.ollama", p.Platform, p.BaseURL
		}
		if section == "" {
			return nil, secErr("inference", "a binding names ollama, and the config has no [environments.%s.inference.ollama] section to say how it runs — add one with a platform", envName)
		}
		host, port := parseHostPort(baseURL)
		external, err := somebodyElses(section, "baseURL", platform, baseURL, host, "OLLAMA_HOST")
		if err != nil {
			return nil, err
		}
		if port == 0 {
			port = spec.defaultPort
		}
		img := spec.image
		if p, ok := env.Inference["ollama"]; ok && p.Image != "" {
			img = p.Image
		}
		rp := rolePlan{Role: "inference", Driver: "ollama", Port: port, Image: img}
		rp.Models = bindingModels(env)
		if !external {
			rp.Presence = presenceHostPreferred
		} else {
			rp.Presence = presenceExternal
			rp.Address = host
			rp.Image = ""
		}
		plan.Roles["inference"] = rp
	}

	return plan, nil
}
