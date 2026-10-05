package launcher

// topology.go — where a container reaches each daemon of its stack.
//
// Deployment topology is the launcher's to know, never the KB config's to
// declare. A knowledge base's config says WHAT it needs: a graph, a vector
// store, an embedding model, an issuer. WHERE those listen on this machine
// is a fact of the start that placed them. So:
//
//   - A daemon is the launcher's to run and to place unless its section says
//     `platform = "external"`. Its section states no address: loadConfig
//     writes the launcher's own reference there (unstatedAddresses), which the
//     plan reads as "the launcher places this daemon".
//   - `platform = "external"` says somebody else runs the daemon. The section
//     states where; it is verified, never launched, and its address reaches
//     each service as it was written.
//   - Each service's staged copy states every placed address as a literal
//     (stagedServiceConfig), so no container's environment says anything of
//     where its dependencies are.

import (
	"fmt"
	"strconv"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

// keycloakRealmName: the realm of the Keycloak the launcher runs.
const keycloakRealmName = "semiont"

// topologyVars: the launcher's own references, and the address each resolves
// to for one start — every dependency on the host address, the issuer on
// identityHost and its port. Resolved by the launcher, at staging and in the
// documents it writes; never set in a container's environment, and never asked
// of the user's.
func topologyVars(rt, addr string, issuerPort int) map[string]string {
	vars := map[string]string{}
	for _, name := range []string{"POSTGRES_HOST", "NEO4J_HOST", "NATS_HOST", "QDRANT_HOST", "OLLAMA_HOST"} {
		vars[name] = addr
	}
	vars["KEYCLOAK_HOST"] = identityHost(rt, addr)
	vars["KEYCLOAK_PORT"] = strconv.Itoa(issuerPort)
	return vars
}

// topologyNames: the names topologyVars resolves.
var topologyNames = func() map[string]bool {
	names := map[string]bool{}
	for name := range topologyVars("", "", 0) {
		names[name] = true
	}
	return names
}()

// unstatedAddress: an address key of an environment's section, and what it
// reads as when the config leaves it unstated. The default scheme, port and
// realm of each daemon the launcher places are stated here, from the
// descriptors: a config names none of them.
type unstatedAddress struct {
	section []string // below [environments.<env>]
	key     string
	// types: the section `type`s under which the key is the launcher's to
	// place; nil for a section that has no type. A missing type is "".
	types []string
	value func() any
}

var unstatedAddresses = []unstatedAddress{
	{section: []string{"graph"}, key: "uri", types: []string{"neo4j"}, value: func() any {
		return fmt.Sprintf("bolt://${NEO4J_HOST}:%d", descriptorFor("graph", "neo4j").defaultPort)
	}},
	{section: []string{"vectors"}, key: "host", types: []string{"qdrant"}, value: func() any { return "${QDRANT_HOST}" }},
	{section: []string{"vectors"}, key: "port", types: []string{"qdrant"}, value: func() any {
		return int64(descriptorFor("vectors", "qdrant").defaultPort)
	}},
	{section: []string{"database"}, key: "host", types: []string{"", "postgres"}, value: func() any { return "${POSTGRES_HOST}" }},
	{section: []string{"jobs"}, key: "servers", types: []string{"jetstream"}, value: brokerReference},
	{section: []string{"signal"}, key: "servers", types: []string{"nats"}, value: brokerReference},
	{section: []string{"identity"}, key: "issuer", types: []string{"keycloak"}, value: func() any {
		return "http://${KEYCLOAK_HOST}:${KEYCLOAK_PORT}/realms/" + keycloakRealmName
	}},
	{section: []string{"embedding"}, key: "baseURL", types: []string{"ollama"}, value: ollamaReference},
	{section: []string{"inference", "ollama"}, key: "baseURL", value: ollamaReference},
}

func brokerReference() any {
	return fmt.Sprintf("${NATS_HOST}:%d", descriptorFor("messaging", "jetstream").defaultPort)
}

func ollamaReference() any {
	return fmt.Sprintf("http://${OLLAMA_HOST}:%d", descriptorFor("inference", "ollama").defaultPort)
}

// placeUnstated writes the launcher's reference at every address the
// environment's sections leave unstated — in the sections named, or in all of
// them when none is. A section the config does not have is not created: a
// daemon the config does not name is not part of the stack.
func placeUnstated(envSection map[string]any, sections []string) {
	for _, a := range unstatedAddresses {
		if sections != nil && !contains(sections, a.section[0]) {
			continue
		}
		table := envSection
		for _, name := range a.section {
			table, _ = table[name].(map[string]any)
		}
		if table == nil {
			continue
		}
		if a.types != nil {
			typ, _ := table["type"].(string)
			if !contains(a.types, typ) {
				continue
			}
		}
		if stated, ok := table[a.key]; ok && stated != "" {
			continue
		}
		// A daemon somebody else runs has no address the launcher could give
		// it: the section states one, and derivePlan refuses it if not.
		if table["platform"] == "external" {
			continue
		}
		table[a.key] = a.value()
	}
}

// resolveTopology replaces the launcher's references in every string below v
// with the addresses of this start, by the placeholder rule every resolver
// shares: a set variable wins, a default or not. A reference to anything else
// — a secret, an operator's own variable — is left, default and all, for the
// consumer's loader.
func resolveTopology(v any, vars map[string]string) any {
	switch t := v.(type) {
	case string:
		return placeholderRe.ReplaceAllStringFunc(t, func(ref string) string {
			name, _, _ := strings.Cut(ref[2:len(ref)-1], ":-")
			if value, ok := vars[name]; ok {
				return value
			}
			return ref
		})
	case map[string]any:
		for k, vv := range t {
			t[k] = resolveTopology(vv, vars)
		}
	case []any:
		for i, vv := range t {
			t[i] = resolveTopology(vv, vars)
		}
	}
	return v
}

// stagedServiceConfig: one service's copy of the KB config, with everything
// the launcher knows and the config does not written into the sections that
// service reads:
//
//   - every address the launcher places, as a literal (vars);
//   - the credential references of the daemons the launcher runs — a [graph]
//     reader names ${NEO4J_PASSWORD}, a [jobs] reader the broker pair; the
//     values reach the service as the variables its sections name (envFor);
//   - for a service that dials the Archivist, its address, from the
//     descriptor's port;
//   - for a service that describes a KB tree it does not mount, a top-level
//     [kb] with the KB's committed name and domain. The domain is omitted
//     when the KB declares none, so the consumer's refusal still fires:
//     staging a fabricated identity is the one thing worse than failing
//     loudly.
//
// A hand-written section wins: an address, an [archivist] or a [kb] the config
// states is an operator describing what the launcher cannot see. A section the
// service does not read is left as written. Invalid TOML passes through
// untouched: the consumer's own loader owns that error and its message.
func stagedServiceConfig(svc string, cfg []byte, plan *launchPlan, vars map[string]string, addr, kbName, kbDomain string) []byte {
	var doc map[string]any
	if err := toml.Unmarshal(cfg, &doc); err != nil {
		return cfg
	}
	env := environmentSection(doc, plan.EnvName)
	if env == nil {
		return cfg
	}
	sections := serviceConfigSections[svc]
	placeUnstated(env, sections)
	for _, section := range sections {
		// `gateway` includes its legacy spelling, `backend` (sectionRefs).
		for _, name := range sectionSpellings(section) {
			if table, ok := env[name]; ok {
				env[name] = resolveTopology(table, vars)
			}
		}
	}
	if graph, ok := env["graph"].(map[string]any); ok && contains(sections, "graph") && plan.Roles["graph"].Presence == presenceLauncher {
		graph["password"] = referenceTo(daemonPasswords["graph"].env)
	}
	if jobs, ok := env["jobs"].(map[string]any); ok && contains(sections, "jobs") && plan.Roles["messaging"].Presence == presenceLauncher {
		jobs["user"], jobs["password"] = referenceTo("NATS_USER"), referenceTo(daemonPasswords["messaging"].env)
	}
	if _, stated := env["archivist"]; archivistDialers[svc] && !stated {
		env["archivist"] = map[string]any{"host": addr, "port": int64(semiontDescriptor("archivist").ports[0].port)}
	}
	if _, stated := doc["kb"]; kbIdentityStaged[svc] && !stated {
		kb := map[string]any{"name": kbName}
		if kbDomain != "" {
			kb["domain"] = kbDomain
		}
		doc["kb"] = kb
	}
	out, err := toml.Marshal(doc)
	if err != nil {
		return cfg
	}
	return append([]byte("# Staged by the launcher: the KB config, with the addresses and credentials of this start written into the sections "+svc+" reads.\n"), out...)
}

// placedAddresses: the addresses a start places for this config — each address
// key the config leaves to the launcher, with the literal it resolves to — as
// "[section] key = value" lines, for a dry run to show what the launcher
// decided.
func placedAddresses(cfg []byte, envName string, vars map[string]string) []string {
	var doc map[string]any
	if err := toml.Unmarshal(cfg, &doc); err != nil {
		return nil
	}
	env := environmentSection(doc, envName)
	if env == nil {
		return nil
	}
	placeUnstated(env, nil)
	var lines []string
	for _, a := range unstatedAddresses {
		table := env
		for _, name := range a.section {
			table, _ = table[name].(map[string]any)
		}
		written, ok := table[a.key].(string)
		if !ok {
			continue
		}
		if placed := resolveTopology(written, vars); placed != written {
			lines = append(lines, fmt.Sprintf("[%s] %s = %v", strings.Join(a.section, "."), a.key, placed))
		}
	}
	return lines
}

// sectionSpellings: the keys a section is written under — `gateway` and its
// legacy spelling, `backend`.
func sectionSpellings(section string) []string {
	if section == "gateway" {
		return []string{"gateway", "backend"}
	}
	return []string{section}
}
