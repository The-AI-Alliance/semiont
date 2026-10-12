package launcher

import "sort"

// launcherReads: the sections whose ${VAR} values the launcher resolves,
// keyed by the role it resolves them for — the gateway's, the dispatcher's,
// the Archivist's, the worker's, the Smelter's, the Weaver's and the
// Librarian's documents, Keycloak's external PostgreSQL password, and the
// remote-model check's key.
// TestLauncherReadsAreTheSectionsTheLauncherResolves reads them from the
// resolving calls.
var launcherReads = map[string][]string{
	"gateway":    {"gateway", "identity", "archivist", "signal"},
	"dispatcher": {"gateway", "identity", "jobs"},
	"archivist":  {"gateway", "identity"},
	"worker":     {"gateway", "identity", "inference"},
	"smelter":    {"gateway", "identity", "archivist", "vectors", "embedding"},
	"weaver":     {"gateway", "identity", "graph"},
	"librarian":  {"gateway", "identity", "archivist", "graph", "vectors", "embedding", "inference"},
	"identity":   {"database"},
	"inference":  {"inference"},
}

// readSections: the sections a start of svc reads — the ones the launcher
// resolves for it. "" is the whole stack. No service reads the KB's config.
func readSections(svc string) []string {
	if svc != "" {
		return launcherReads[svc]
	}
	var all []string
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
// reference to the name is, by placeholderRefs' rule.
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
		walk(envSection[sec])
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

// serviceVars: for each stack service, the user variables it is handed. No
// service reads the KB's config: a service's variables are the ones its
// document names, and the Archivist's names none.
func serviceVars(env *envConfig) map[string][]string {
	return map[string][]string{"gateway": gatewayNamedVars(env), "dispatcher": dispatcherNamedVars(env), "archivist": nil, "worker": workerNamedVars(env), "smelter": smelterNamedVars(env), "weaver": weaverNamedVars(env), "librarian": librarianNamedVars(env)}
}

// withDaemonCredentialVars adds, to each service's variables, the credential
// names of the daemons the launcher runs that the service dials: the Weaver
// and the Librarian the Neo4j password, the dispatcher the broker pair, and
// the gateway the pair when its signal plane is that broker.
func withDaemonCredentialVars(byService map[string][]string, plan *launchPlan, signalOnBroker bool) map[string][]string {
	out := map[string][]string{}
	for svc, names := range byService {
		out[svc] = append([]string{}, names...)
	}
	graphRun := plan.Roles["graph"].Presence == presenceLauncher
	brokerRun := plan.Roles["messaging"].Presence == presenceLauncher
	pair := []string{"NATS_USER", daemonPasswords["messaging"].env}
	if graphRun {
		out["weaver"] = append(out["weaver"], daemonPasswords["graph"].env)
		out["librarian"] = append(out["librarian"], daemonPasswords["graph"].env)
	}
	if brokerRun && signalOnBroker {
		out["gateway"] = append(out["gateway"], pair...)
	}
	if brokerRun {
		out["dispatcher"] = append(out["dispatcher"], pair...)
	}
	return out
}
