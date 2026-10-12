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
//   - Each service's document states every placed address as a literal, so
//     no container's environment says anything of where its dependencies are.

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
// identityHost and its port. Resolved by the launcher, in the documents it
// writes; never set in a container's environment, and never asked of the
// user's.
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
// environment's sections leave unstated. A section the config does not have is
// not created: a daemon the config does not name is not part of the stack.
func placeUnstated(envSection map[string]any) {
	for _, a := range unstatedAddresses {
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

// resolveTopology replaces the launcher's references in a value with the
// addresses of this start, by the placeholder rule resolveRefs follows: a set
// variable wins, a default or not. A reference to anything else — a secret, an
// operator's own variable — is left, default and all.
func resolveTopology(value string, vars map[string]string) string {
	return placeholderRe.ReplaceAllStringFunc(value, func(ref string) string {
		name, _, _ := strings.Cut(ref[2:len(ref)-1], ":-")
		if resolved, ok := vars[name]; ok {
			return resolved
		}
		return ref
	})
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
	placeUnstated(env)
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
