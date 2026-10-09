package launcher

import "sort"

// serviceConfigSections: the [environments.<env>] sections each service that
// loads the KB's config reads — the launcher forwards a service only the
// variables those sections reference. The authority is
// specs/src/service-config/sections.json, which the TypeScript loader
// enforces; TestServiceSectionsAgreeWithTheSpec holds this copy to it.
var serviceConfigSections = map[string][]string{
	"librarian": {"gateway", "graph", "vectors", "embedding", "identity", "archivist", "make-meaning", "actors", "inference"},
	"weaver":    {"gateway", "graph", "identity"},
	"smelter":   {"gateway", "vectors", "embedding", "identity", "archivist"},
}

// launcherReads: the sections whose ${VAR} values the launcher resolves itself,
// keyed by the role it resolves them for — the gateway's, the dispatcher's,
// the Archivist's and the worker's documents, Keycloak's external PostgreSQL
// password, and the remote-model check's key.
// TestLauncherReadsAreTheSectionsTheLauncherResolves reads them from the
// resolving calls.
var launcherReads = map[string][]string{
	"gateway":    {"gateway", "identity", "archivist", "signal"},
	"dispatcher": {"gateway", "identity", "jobs"},
	"archivist":  {"gateway", "identity"},
	"worker":     {"gateway", "identity", "inference"},
	"identity":   {"database"},
	"inference":  {"inference"},
}

// readSections: the sections a start of svc reads — the ones svc loads itself,
// and the ones the launcher resolves for it. "" is the whole stack.
func readSections(svc string) []string {
	if svc != "" {
		return append(append([]string{}, serviceConfigSections[svc]...), launcherReads[svc]...)
	}
	var all []string
	for _, sections := range serviceConfigSections {
		all = append(all, sections...)
	}
	for _, sections := range launcherReads {
		all = append(all, sections...)
	}
	return all
}

// environmentSection: [environments.<envName>] of the parsed document.
func environmentSection(doc any, envName string) map[string]any {
	root, _ := doc.(map[string]any)
	envs, _ := root["environments"].(map[string]any)
	section, _ := envs[envName].(map[string]any)
	return section
}

// sectionRefs: the user variables the named sections of an environment
// reference, minus the ones the launcher resolves itself — required when any
// reference to the name is, by placeholderRefs' rule. `gateway` includes its
// legacy spelling, `backend`.
func sectionRefs(envSection map[string]any, sections []string) (required, optional []string) {
	isRequired := map[string]bool{}
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case string:
			req, opt := placeholderRefs(t)
			for _, name := range req {
				if !launcherResolved(name) {
					isRequired[name] = true
				}
			}
			for _, name := range opt {
				if _, named := isRequired[name]; !named && !launcherResolved(name) {
					isRequired[name] = false
				}
			}
		case map[string]any:
			for _, vv := range t {
				walk(vv)
			}
		case []any:
			for _, vv := range t {
				walk(vv)
			}
		}
	}
	for _, sec := range sections {
		for _, name := range sectionSpellings(sec) {
			walk(envSection[name])
		}
	}
	for name, req := range isRequired {
		if req {
			required = append(required, name)
		} else {
			optional = append(optional, name)
		}
	}
	sort.Strings(required)
	sort.Strings(optional)
	return required, optional
}

// serviceVars: for each stack service, the user variables it is handed — the
// references in the sections it reads. The gateway, the dispatcher, the
// Archivist and the worker read no KB config: their variables are the ones
// their documents name, and the Archivist's names none.
func serviceVars(envSection map[string]any, env *envConfig) map[string][]string {
	out := map[string][]string{"gateway": gatewayNamedVars(env), "dispatcher": dispatcherNamedVars(env), "archivist": nil, "worker": workerNamedVars(env)}
	for svc, sections := range serviceConfigSections {
		required, optional := sectionRefs(envSection, sections)
		names := append(required, optional...)
		sort.Strings(names)
		out[svc] = names
	}
	return out
}

// withDaemonCredentialVars adds, to each service's variables, the credential
// names of the daemons the launcher runs that the service dials: a [graph]
// reader the Neo4j password, a [jobs] reader the broker pair, and the gateway
// the pair when its signal plane is that broker.
func withDaemonCredentialVars(byService map[string][]string, plan *launchPlan, signalOnBroker bool) map[string][]string {
	out := map[string][]string{}
	for svc, names := range byService {
		out[svc] = append([]string{}, names...)
	}
	graphRun := plan.Roles["graph"].Presence == presenceLauncher
	brokerRun := plan.Roles["messaging"].Presence == presenceLauncher
	pair := []string{"NATS_USER", daemonPasswords["messaging"].env}
	for svc, sections := range serviceConfigSections {
		if graphRun && contains(sections, "graph") {
			out[svc] = append(out[svc], daemonPasswords["graph"].env)
		}
		if brokerRun && contains(sections, "jobs") {
			out[svc] = append(out[svc], pair...)
		}
	}
	if brokerRun && signalOnBroker {
		out["gateway"] = append(out["gateway"], pair...)
	}
	if brokerRun {
		out["dispatcher"] = append(out["dispatcher"], pair...)
	}
	return out
}
