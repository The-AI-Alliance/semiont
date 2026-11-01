package launcher

// plan.go — derivePlan: the pure function from a knowledge base's documents
// (package stack, each already held to its schema) to the launcher's work.
// Per dependency role the documents decide the OBLIGATION: a daemon that
// states `external` is somebody else's, at the address it states, and one
// that does not is the launcher's, run from the image and with the memory it
// states, at the address the launcher places it. The driver catalog owns what
// no document states: the ports of the daemons the launcher runs, and their
// aux ports, which a knowledge base's port block places (hostPort). What the schemas cannot state, a rule that spans fields or
// documents, is refused here, naming the document and the field.

import (
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
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
	Driver           string        // the document's `type` (catalog key)
	Image            string        // the document's, for provided/host-fallback launches
	Address          string        // external host, for reachability probes
	Port             int           // primary port (an external daemon's, else the driver's on the knowledge base's port block); zero for a launcher-fiat port, the plan's (servicePort)
	SharesOllamaWith string        // role under which the launcher runs the Ollama this one uses
	Models           []servedModel // models this role uses, each with the provider that serves it
	Env              []string      // container env derived from the documents (no credential: those are added at launch)
	// Memory: the --memory ceiling of a daemon the launcher runs, as its
	// document states it.
	Memory string
	// User: the login a launcher-kept password belongs to (graph: NEO4J_AUTH's
	// user half).
	User string
	// ExternalDBPassword: identity on an EXTERNAL PostgreSQL — the variable its
	// password is read from (the Issuer document's database.external.password).
	ExternalDBPassword string
	// APIKey: inference on a remote provider — the variable its key is read
	// from (the Inference document's providers.<provider>.apiKey), for the
	// remote-model check.
	APIKey string
	// CmdExtra: arguments appended AFTER the driver's own command. The
	// messaging role uses it for `-c` when the broker is authenticated; the
	// path is fixed, so the derivation can state it and the flow only has to
	// mount the file there.
	CmdExtra []string
	// Issuer: identity's issuer URL as this host reaches it — an external
	// one as its document states it, the launcher's Keycloak at localhost on
	// its port (issuerURL gives a container's view).
	Issuer string
	// AccessTokenLifespan: seconds, for the realm the launcher imports.
	// Zero means the built-in default; only a launcher-run Keycloak has one.
	AccessTokenLifespan int
}

type launchPlan struct {
	// Roles: the roles whose presence the documents decide — every
	// dependency role, and the worker. Semiont's other services are in every
	// stack and have no row (runs).
	Roles       map[string]rolePlan
	GatewayPort int
	// Block: the knowledge base's port block (portBlockOf), which places each
	// port of its stack the launcher publishes but the gateway's and the
	// Keycloak's, whose ports this start was handed (hostPort).
	Block int
	// Inference: the file of the Inference document this start chose, for the
	// messages that name it.
	Inference string
	// OllamaModels: every model the documents ask the MACHINE'S Ollama to
	// serve — the ollama engines when the Inference document states no
	// providers.ollama.baseURL, plus an ollama embedding with no endpoint.
	// Distinct from the per-role Models (which list what a role uses whoever
	// serves it): only these are pulled, into the shared Ollama; an Ollama
	// somebody else runs is theirs to provision.
	//
	// Each carries the ROLES that asked for it. One Ollama can serve both
	// inference and embedding, so this set crosses role boundaries: it is
	// provisioned under the inference banner but a failure here may be an
	// EMBEDDING failure. Output must name the role, not the section it
	// happened to be printed under.
	OllamaModels []modelNeed
	// ServiceVars: the user variables each stack service is handed — only
	// those its configuration document names.
	ServiceVars map[string][]string
	// Images and Memory: each of Semiont's services this stack runs, with the
	// image its document names and the ceiling it states. The worker's are
	// the shared worker document's (runWorkerAs).
	Images map[string]string
	Memory map[string]string
	// Worker: the shared worker document, for a start that runs the
	// worker (runWorkerAs); its log level is the worker's.
	Worker workerPoolDocument
	// Serving: what this start does with the shared worker's list, for a
	// start that reconciles the worker (planWorkerServing).
	Serving workerServing
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
// provider of the engine, or the `type` of the section, that names it. A
// role's driver does not say this: a config can give most jobs Anthropic's
// engines and one job type Ollama's, and the inference row then lists Claude
// under a driver of "ollama". Key holders report limits by the same provider
// and model: an engine.
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

// boundEngine: an engine the Inference document's engines name, at its place
// in them ("actors.gatherer", "jobs.mark.tagging").
type boundEngine struct {
	at     string
	engine api.Engine
}

// boundEngines: every engine the engines name — each actor's, then each
// job's, in the engines' own order.
func boundEngines(engines api.ArchivistEngines) []boundEngine {
	var bound []boundEngine
	for _, actor := range []struct {
		name   string
		engine *api.Engine
	}{{"gatherer", engines.Actors.Gatherer}, {"matcher", engines.Actors.Matcher}} {
		if actor.engine != nil {
			bound = append(bound, boundEngine{at: "actors." + actor.name, engine: *actor.engine})
		}
	}
	for _, j := range jobEngines(engines) {
		bound = append(bound, boundEngine{at: "jobs." + j.job.name, engine: *j.engine})
	}
	return bound
}

// jobEngines: each job the engines give an engine, in engineJobs' order.
func jobEngines(engines api.ArchivistEngines) []jobEngine {
	var given []jobEngine
	jobs := reflect.ValueOf(engines.Jobs)
	for _, job := range engineJobs() {
		if engine := job.engine(jobs); engine != nil {
			given = append(given, jobEngine{job: job, engine: engine})
		}
	}
	return given
}

// ollamaModels: the models this stack asks the shared Ollama to serve —
// engines whose provider is ollama, when the Inference document places that
// Ollama nowhere else, plus an ollama-typed embedding with no endpoint. These
// are exactly the models a "pull" is defined for.
func ollamaModels(st *stack.Stack) []modelNeed {
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
	// Every actor's and job's engine is the INFERENCE role however many
	// engines name the same model; the embedding role is added last, so Roles
	// ends up in one order.
	if st.Inference.Spec.Providers[api.EngineProviderOllama].BaseURL == nil {
		for _, b := range boundEngines(st.Inference.Spec.Engines) {
			if b.engine.Provider == api.EngineProviderOllama {
				add(b.engine.Model, roleInference)
			}
		}
	}
	if e := st.KnowledgeIndex.Spec.Embedding; e.Type == "ollama" && e.Endpoint == nil {
		add(e.Model, roleEmbedding)
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

// remoteInferenceDriver: the (sorted-first) non-ollama provider the engines
// name. With one remote provider — the real case — this is it; engines of
// several remote providers get the alphabetically first, and their models
// still all list (engineModels is unfiltered).
func remoteInferenceDriver(st *stack.Stack) string {
	set := map[string]bool{}
	for _, b := range boundEngines(st.Inference.Spec.Engines) {
		if p := string(b.engine.Provider); p != "ollama" {
			set[p] = true
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
// baseURL its entry states, else the provider's own. ONE decider: the
// inference role the remote-model check dials (saasBase), and the address a
// worker's document gives an engine whose provider states none (workerdoc.go).
func remoteProviderAddress(st *stack.Stack, driver string) (host string, port int) {
	if p, ok := st.Inference.Spec.Providers[api.EngineProvider(driver)]; ok && p.BaseURL != nil {
		host, port = parseHostPort(*p.BaseURL)
		if port == 0 && strings.HasPrefix(*p.BaseURL, "https://") {
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

// engineModels: every model the engines of the actors and the jobs name for
// inference, with its provider, sorted and deduped. Deliberately NOT filtered
// by provider: these are the models this stack performs inference with,
// whoever serves them — engines of mixed providers list all of them.
func engineModels(st *stack.Stack) []servedModel {
	seen := map[servedModel]bool{}
	var out []servedModel
	for _, b := range boundEngines(st.Inference.Spec.Engines) {
		m := servedModel{Model: b.engine.Model, Provider: string(b.engine.Provider)}
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
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

// providedRunArgs builds the `run -d` argv for a launcher-provided role of the
// knowledge base keyed key from its row of plan: aux ports first, where plan publishes them, then the primary publish (host side the plan's,
// container side the driver default), driver extras, the env the documents
// derive, image — with the memory its document states.
func providedRunArgs(e exposure, plan *launchPlan, rp rolePlan, key string, extra ...string) []string {
	role := rp.Role
	spec := descriptorFor(role, rp.Driver)
	// NO --rm: a crashed container must remain inspectable — its logs are
	// the diagnosis, and --rm destroys them (the runtime's `logs` answers
	// "No such container"). Cleanup is already explicit at both ends:
	// start's preflight and stop both stop+rm by name.
	a := []string{"run", "-d", "--name", spec.containerName(key), "--memory", rp.Memory}
	for _, ap := range spec.auxPorts {
		a = append(a, e.publish("-p", role, plan.hostPort(role, ap.port), ap.port)...)
	}
	a = append(a, e.publish("-p", role, rp.Port, spec.defaultPort)...)
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
// when the engines are all remote) while the container, image and port
// shape do not — the OWNER's descriptor would be wrong for embedding, whose
// row carries no container precisely because it never runs one.
func ollamaRunArgs(e exposure, rp rolePlan, extra ...string) []string {
	spec := descriptorFor("inference", "ollama")
	// The ceiling is the INFERENCE row's whichever role owns the container
	// (an all-remote embedding config still runs one Ollama), and it comes
	// from the descriptor ALONE — a second -m from a caller wins by flag
	// order and desyncs the memory preflight.
	a := []string{"run", "-d", "--name", sharedContainer("inference"), "--memory", spec.mem} // no --rm: see providedRunArgs
	a = append(a, e.publish("-p", "inference", rp.Port, spec.defaultPort)...)
	a = append(a, extra...)
	return append(a, rp.Image)
}

// runs: whether this start runs role's container, asked of the roles the
// launcher places by fiat — Semiont's own services and the observability tier
// — and never of a dependency role, whose presence has more answers than two
// (flowDepRole). The plan carries the one fiat role a config decides, the
// worker; a role it does not carry runs whenever the walk reaches it.
func (p *launchPlan) runs(role string) bool {
	rp, planned := p.Roles[role]
	return !planned || rp.Presence == presenceLauncher
}

// workerRuns: whether the shared worker runs once this start is done —
// whether the list it leaves serves a knowledge base: its own, when one of
// its jobs has an engine (runs), or another.
func (p *launchPlan) workerRuns() bool {
	entries, _ := p.Serving.others.served()
	return p.runs("worker") || len(entries) > 0
}

// planPortChecks: the must-be-free ports, derived from the plan — only roles
// the launcher actually provides claim ports, and a port a person and the
// containers both dial claims its containers' side too (e). The order is the
// order the checks run in, and the start goldens pin it.
func planPortChecks(plan *launchPlan, e exposure) []portNeed {
	var checks []portNeed
	addRole := func(role string) {
		rp := plan.Roles[role]
		if rp.Presence != presenceLauncher {
			return
		}
		spec := descriptorFor(role, rp.Driver)
		checks = append(checks, plan.AuxPorts(role)...)
		need := portNeed{rp.Port, spec.portLabel}
		checks = append(append(checks, need), e.containersSideNeed(role, need, spec.defaultPort)...)
	}
	addRole("graph")
	addRole("vectors")
	addRole("identity-store")
	addRole("messaging")
	addRole("identity")
	// The gateway's port is config-owned; every other Semiont port is
	// launcher fiat, on the knowledge base's port block. No browser here: the
	// Browser is not a stack member — its port is checked inside flowBrowser,
	// and only when (re)starting.
	gateway := portNeed{plan.GatewayPort, "Gateway"}
	checks = append(append(checks, gateway), e.containersSideNeed("gateway", gateway, plan.GatewayPort)...)
	for _, role := range fiatRoles() {
		if plan.runs(role) {
			checks = append(checks, plan.portNeeds(role)...)
		}
	}
	return checks
}

// fiatRoles: the stack's roles whose ports are the launcher's fiat, whatever
// a config says — the Semiont services behind the gateway. ONE list for the
// two sites that decide it: a full start requires the ports of the ones it
// runs free, and a stop holding no record of the stack's claims verifies
// every one's released. The telemetry's and the worker's are shared,
// not a stack's.
func fiatRoles() []string {
	return []string{"smelter", "weaver", "archivist", "librarian", "dispatcher"}
}

func knownDrivers(role string) string {
	return strings.Join(driversFor(role), ", ")
}

// blockRoles: the roles whose ports a knowledge base's port block places —
// Semiont's services behind the gateway, and the daemons of its stack whose
// port is the launcher's to choose. The gateway's is its document's, the
// Keycloak's this start's (keycloakPort), and the shared containers' the
// machine's.
var blockRoles = slices.Concat(fiatRoles(), []string{"graph", "vectors", "identity-store", "messaging"})

// hostPort: where this start publishes role's port that its container
// listens on at ctrPort — on the knowledge base's port block for one of
// blockRoles the launcher runs, else at ctrPort itself. A nil plan, a probe
// of a stack no start recorded, is on block 0.
func (p *launchPlan) hostPort(role string, ctrPort int) int {
	if p == nil || !slices.Contains(blockRoles, role) {
		return ctrPort
	}
	if rp, planned := p.Roles[role]; planned && rp.Presence != presenceLauncher {
		return ctrPort
	}
	return blockPort(ctrPort, p.Block)
}

// servicePort: where this start publishes one of Semiont's services behind
// the gateway (fiatRoles).
func (p *launchPlan) servicePort(role string) int {
	return p.hostPort(role, semiontDescriptor(role).ports[0].port)
}

// portNeeds: role's launcher-fiat port claims (stackPortNeeds), where this
// start publishes them.
func (p *launchPlan) portNeeds(role string) []portNeed {
	var out []portNeed
	for _, n := range stackPortNeeds(role) {
		out = append(out, portNeed{p.hostPort(role, n.port), n.label})
	}
	return out
}

// AuxPorts: catalog-owned secondary ports for a role's selected driver
// (Neo4j's 7474 browser — the config only declares bolt), where this start
// publishes them.
func (p *launchPlan) AuxPorts(role string) []portNeed {
	var out []portNeed
	for _, ap := range descriptorFor(role, p.Roles[role].Driver).auxPorts {
		out = append(out, portNeed{p.hostPort(role, ap.port), ap.label})
	}
	return out
}

// parseHostPort splits "scheme://host:port", "host:port", or bare "host".
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

// workerPlan: the worker's row of the plan. The shared worker serves the
// knowledge base when the engines give a job an engine, and not when they
// give none. ONE decision, read from the engines the worker's entry and the
// Archivist's document are written from (jobEngines); everything that
// enumerates the stack follows it (launchPlan.runs).
func workerPlan(st *stack.Stack) rolePlan {
	worker := rolePlan{Role: "worker", Driver: driverSemiont, Presence: presenceLauncher}
	if len(jobEngines(st.Inference.Spec.Engines)) == 0 {
		worker.Presence = presenceAbsent
	}
	return worker
}

// planErr: a refusal of what a document says, naming the document and the
// field.
func planErr(file, field, format string, a ...any) error {
	return fmt.Errorf("%s: %s %s", file, field, fmt.Sprintf(format, a...))
}

// derivePlan maps a knowledge base's documents to each role's presence.
// keycloakPort is the port this launch gives the Keycloak it runs
// (keycloakPort in root.go), and block the knowledge base's port block
// (portBlockOf).
func derivePlan(st *stack.Stack, keycloakPort, block int) (*launchPlan, error) {
	kb, index, files := st.KnowledgeBase.Spec, st.KnowledgeIndex.Spec, st.Files
	plan := &launchPlan{
		Roles:        map[string]rolePlan{},
		GatewayPort:  kb.Gateway.Port,
		Block:        block,
		Inference:    files.Inference,
		OllamaModels: ollamaModels(st),
		Images: map[string]string{
			"gateway": kb.Gateway.Image, "dispatcher": kb.Dispatcher.Image, "archivist": kb.Archivist.Image,
			"librarian": index.Librarian.Image, "smelter": index.Smelter.Image, "weaver": index.Weaver.Image,
		},
		Memory: map[string]string{
			"gateway": kb.Gateway.Resources.Limits.Memory, "dispatcher": kb.Dispatcher.Resources.Limits.Memory,
			"archivist": kb.Archivist.Resources.Limits.Memory, "librarian": index.Librarian.Resources.Limits.Memory,
			"smelter": index.Smelter.Resources.Limits.Memory, "weaver": index.Weaver.Resources.Limits.Memory,
		},
	}

	// Every provider an engine names is one the Inference document says how
	// to reach.
	providers := st.Inference.Spec.Providers
	enginesUseOllama := false
	for _, b := range boundEngines(st.Inference.Spec.Engines) {
		if _, stated := providers[b.engine.Provider]; !stated {
			return nil, planErr(files.Inference, "spec.engines."+b.at+".provider", "is %q, and spec.providers says nothing of it — add spec.providers.%s", b.engine.Provider, b.engine.Provider)
		}
		if b.engine.Provider == api.EngineProviderOllama {
			enginesUseOllama = true
		}
	}
	// inferenceOllama: where the Ollama that performs inference is — the
	// Inference document's to say, and nil for the shared one.
	inferenceOllama := providers[api.EngineProviderOllama].BaseURL

	// graph
	{
		g := index.Graph
		spec, ok := lookupDescriptor("graph", g.Type)
		if !ok {
			return nil, planErr(files.KnowledgeIndex, "spec.graph.type", "is %q, which no driver runs (known drivers: %s)", g.Type, knownDrivers("graph"))
		}
		rp := rolePlan{Role: "graph", Driver: g.Type, Port: spec.defaultPort}
		if g.External != nil {
			host, port := parseHostPort(g.External.Uri)
			if port != 0 {
				rp.Port = port
			}
			rp.Presence, rp.Address = presenceExternal, host
		} else {
			rp.Presence, rp.Image, rp.Memory = presenceLauncher, *g.Image, g.Resources.Limits.Memory
			rp.Port = plan.hostPort("graph", spec.defaultPort)
			rp.User = g.Username
			rp.Env = []string{"NEO4J_ACCEPT_LICENSE_AGREEMENT=yes"}
		}
		plan.Roles["graph"] = rp
	}

	// vectors. `memory` is unusable here: a launcher-managed stack runs the
	// Smelter, which writes the index, and the Librarian, which reads it, as
	// separate containers, and an in-process index cannot be shared across
	// processes. Named explicitly so an operator is told WHY, rather than that
	// the value is unknown.
	{
		v := index.Vectors
		if v.Type == "memory" {
			return nil, planErr(files.KnowledgeIndex, "spec.vectors.type", `is "memory", which keeps the index inside one process, and a launcher-managed stack runs the Smelter and the Librarian as separate containers — they cannot share it. Use "qdrant".`)
		}
		spec, ok := lookupDescriptor("vectors", v.Type)
		if !ok {
			return nil, planErr(files.KnowledgeIndex, "spec.vectors.type", "is %q, which no driver runs (known drivers: %s)", v.Type, knownDrivers("vectors"))
		}
		rp := rolePlan{Role: "vectors", Driver: v.Type, Port: spec.defaultPort}
		if v.External != nil {
			rp.Presence, rp.Address, rp.Port = presenceExternal, v.External.Host, v.External.Port
		} else {
			rp.Presence, rp.Image, rp.Memory = presenceLauncher, *v.Image, v.Resources.Limits.Memory
			rp.Port = plan.hostPort("vectors", spec.defaultPort)
		}
		plan.Roles["vectors"] = rp
	}

	// identity-store — the Issuer's, so present only with the Keycloak the launcher
	// runs.
	if st.Issuer == nil {
		plan.Roles["identity-store"] = rolePlan{Role: "identity-store", Presence: presenceAbsent}
	} else {
		d := st.Issuer.Spec.Database
		spec, ok := lookupDescriptor("identity-store", d.Type)
		if !ok {
			return nil, planErr(files.Issuer, "spec.database.type", "is %q, which no driver runs (known drivers: %s)", d.Type, knownDrivers("identity-store"))
		}
		rp := rolePlan{Role: "identity-store", Driver: d.Type, Port: spec.defaultPort}
		if d.External != nil {
			rp.Presence, rp.Address, rp.Port = presenceExternal, d.External.Host, d.External.Port
		} else {
			rp.Presence, rp.Image, rp.Memory = presenceLauncher, *d.Image, d.Resources.Limits.Memory
			rp.Port = plan.hostPort("identity-store", spec.defaultPort)
			rp.Env = []string{"POSTGRES_DB=" + d.Name}
			// POSTGRES_USER only when it departs from the image's own.
			if d.User != "postgres" {
				rp.Env = append(rp.Env, "POSTGRES_USER="+d.User)
			}
		}
		plan.Roles["identity-store"] = rp
	}

	// messaging — the one broker: the dispatcher's queue is JetStream, and a
	// `nats` signal plane rides the same daemon. Its one shape, -js with the
	// stamped store, serves both: the job queue's stream, and the signal
	// driver's KV tables, where the gateway's ledger keeps its claims.
	{
		m := kb.Messaging
		if m.Jobs.Type != "jetstream" {
			return nil, planErr(files.KnowledgeBase, "spec.messaging.jobs.type", `is %q: the dispatcher's queue is JetStream — write "jetstream"`, m.Jobs.Type)
		}
		switch m.Signal.Type {
		case "in-process", "nats":
		default:
			return nil, planErr(files.KnowledgeBase, "spec.messaging.signal.type", `is %q (use "in-process", or "nats")`, m.Signal.Type)
		}
		spec := descriptorFor("messaging", "jetstream")
		rp := rolePlan{Role: "messaging", Driver: "jetstream", Port: spec.defaultPort}
		if m.External != nil {
			host, port := parseHostPort(m.External.Servers)
			if port != 0 {
				rp.Port = port
			}
			rp.Presence, rp.Address = presenceExternal, host
		} else {
			rp.Presence, rp.Image, rp.Memory = presenceLauncher, *m.Image, m.Resources.Limits.Memory
			rp.Port = plan.hostPort("messaging", spec.defaultPort)
			// The pair arrives as the daemon's own environment at launch.
			// nats-server reads no credential from the environment by itself,
			// so the staged config interpolates the two names.
			rp.CmdExtra = []string{"-c", natsConfPath}
		}
		plan.Roles["messaging"] = rp
	}

	// identity — the issuer the gateway trusts. The AUDIENCE is not stated
	// anywhere: it is the KB's own resource identifier, derived from the
	// committed did:web domain, so it cannot disagree with the identity the
	// KB already publishes. An Issuer document is a Keycloak the launcher
	// runs, with the staged realm and its database on the PostgreSQL that
	// document names; spec.issuer.external is an issuer somebody else runs,
	// verified, never launched.
	if ref := kb.Issuer.Ref; ref != nil {
		is := st.Issuer.Spec
		if is.Type != "keycloak" {
			return nil, planErr(files.Issuer, "spec.type", `is %q: the issuer the launcher runs is "keycloak"`, is.Type)
		}
		rp := rolePlan{
			Role: "identity", Driver: "keycloak", Port: keycloakPort, Presence: presenceLauncher,
			Issuer:              fmt.Sprintf("http://localhost:%d/realms/%s", keycloakPort, keycloakRealmName),
			AccessTokenLifespan: is.AccessTokenLifespan,
			Image:               is.Image, Memory: is.Resources.Limits.Memory,
			Env: []string{"KC_DB=postgres", "KC_DB_USERNAME=" + is.Database.User,
				"KC_BOOTSTRAP_ADMIN_USERNAME=" + keycloakAdminUser},
		}
		// A launcher-run PostgreSQL's password is kept by the launcher and
		// handed to Keycloak at launch; an external one's is read from the
		// variable its document names.
		if external := is.Database.External; external != nil {
			rp.ExternalDBPassword = external.Password.FromEnv
		}
		plan.Roles["identity"] = rp
	} else {
		external := kb.Issuer.External
		switch external.Type {
		case "keycloak", "oidc":
		default:
			return nil, planErr(files.KnowledgeBase, "spec.issuer.external.type", `is %q (use "keycloak", or "oidc")`, external.Type)
		}
		host, port, _, err := splitIssuer(external.Url)
		if err != nil {
			return nil, planErr(files.KnowledgeBase, "spec.issuer.external.url", "%q %v", external.Url, err)
		}
		if port == 0 {
			port = descriptorFor("identity", external.Type).defaultPort
		}
		plan.Roles["identity"] = rolePlan{
			Role: "identity", Driver: external.Type, Port: port, Presence: presenceExternal,
			Address: host, Issuer: external.Url, AccessTokenLifespan: keycloakAccessTokenLifespan,
		}
	}

	// embedding — a role the launcher never launches. An ollama embedding
	// with no endpoint is served by the shared Ollama (same process, same
	// port — which is why embedding has no container of its own and never
	// contends for a port); one with an endpoint is somebody else's Ollama;
	// voyage is remote SaaS.
	{
		e := index.Embedding
		spec, ok := lookupDescriptor("embedding", e.Type)
		if !ok {
			return nil, planErr(files.KnowledgeIndex, "spec.embedding.type", "is %q, which no driver serves (known drivers: %s)", e.Type, knownDrivers("embedding"))
		}
		ownOllama := e.Type == "ollama" && e.Endpoint == nil
		host, port := "", spec.defaultPort
		switch {
		case ownOllama:
			// The shared Ollama: the probe runs ON this machine.
			host = "localhost"
		case e.Type == "ollama":
			h, p := parseHostPort(*e.Endpoint)
			host = h
			if p != 0 {
				port = p
			}
		default:
			host = voyageHost
		}
		rp := rolePlan{
			Role: "embedding", Presence: presenceExternal,
			Driver: e.Type, Address: host, Port: port,
			Models: []servedModel{{Model: e.Model, Provider: e.Type}},
		}
		// WHO runs the shared Ollama an ollama embedding needs? If inference
		// runs on the shared Ollama too, the inference role runs it and the
		// embedding rides along (SharesOllamaWith names that, so both rows
		// report the one process the same way). If not — the engines are
		// remote, or name somebody else's Ollama — EMBEDDING owns the
		// host-process dance itself.
		if ownOllama {
			if enginesUseOllama && inferenceOllama == nil {
				rp.SharesOllamaWith = "inference"
			} else {
				rp.Presence = presenceHostPreferred
				rp.Address = ""
				rp.Image = descriptorFor("inference", "ollama").image
			}
		}
		plan.Roles["embedding"] = rp
	}

	// inference — the driver is WHO PERFORMS INFERENCE per the engines, not
	// which process the launcher happens to run. Any ollama engine → the
	// local-Ollama shape (host-process dance, or external at its address).
	// All-remote engines → an external SaaS role: participates in status,
	// launches nothing — even when an Ollama runs locally for the embedding,
	// because that Ollama is the embedding's. No engines → not configured.
	switch {
	case !enginesUseOllama && len(engineModels(st)) > 0:
		driver := remoteInferenceDriver(st)
		host, port := remoteProviderAddress(st, driver)
		rp := rolePlan{
			Role: "inference", Presence: presenceExternal,
			Driver: driver, Address: host, Port: port,
			Models: engineModels(st),
		}
		if key := providers[api.EngineProvider(driver)].ApiKey; key != nil {
			rp.APIKey = key.FromEnv
		}
		plan.Roles["inference"] = rp
	case !enginesUseOllama:
		plan.Roles["inference"] = rolePlan{Role: "inference", Presence: presenceAbsent}
	default:
		spec := descriptorFor("inference", "ollama")
		rp := rolePlan{Role: "inference", Driver: "ollama", Port: spec.defaultPort, Image: spec.image, Models: engineModels(st)}
		if inferenceOllama == nil {
			rp.Presence = presenceHostPreferred
		} else {
			host, port := parseHostPort(*inferenceOllama)
			if port != 0 {
				rp.Port = port
			}
			rp.Presence, rp.Address, rp.Image = presenceExternal, host, ""
		}
		plan.Roles["inference"] = rp
	}

	// worker — the one of Semiont's own services the documents decide: run
	// when the engines give a job an engine, as the shared worker document
	// says (runWorkerAs).
	plan.Roles["worker"] = workerPlan(st)

	return plan, nil
}
