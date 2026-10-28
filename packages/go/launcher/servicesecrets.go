package launcher

import "sort"

// serviceSecrets: for each stack service, the variables its document names
// (`fromEnv`), and so the ones it is handed. No service reads a knowledge
// base's documents: a service's variables are the ones its own document names,
// and the Archivist's names none.
func serviceSecrets(p placement) map[string][]string {
	return map[string][]string{
		"gateway": gatewaySecrets(p), "dispatcher": dispatcherSecrets(p), "archivist": nil,
		"worker": workerSecrets(p), "smelter": embeddingSecrets(p), "weaver": graphSecrets(p),
		"librarian": librarianSecrets(p),
	}
}

// secretsRead: the variables a start of svc reads ("" is the whole stack) —
// each one a service it starts is handed, and each one the launcher reads
// itself: the password of the PostgreSQL somebody else runs for the Keycloak
// it runs, and a remote provider's key for the remote-model check. Sorted.
func secretsRead(p placement, svc string) []string {
	var names []string
	add := func(found ...string) {
		for _, name := range found {
			if name != "" && !contains(names, name) {
				names = append(names, name)
			}
		}
	}
	for service, secrets := range serviceSecrets(p) {
		if svc == "" || svc == service {
			add(secrets...)
		}
	}
	if svc == "" || svc == "identity" {
		add(p.plan.Roles["identity"].ExternalDBPassword)
	}
	if svc == "" || svc == "inference" {
		add(p.plan.Roles["inference"].APIKey)
	}
	sort.Strings(names)
	return names
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
