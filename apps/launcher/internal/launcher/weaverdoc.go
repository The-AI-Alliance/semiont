package launcher

// weaverdoc.go — the Weaver's configuration document: WeaverConfig in specs/,
// the Go type generated from it (packages/sdk-go). The launcher writes it for
// the Weaver it starts, resolved — every ${VAR} a value — and mounts it where
// the Weaver's image points its `--config` flag, so the Weaver neither parses
// TOML nor resolves or defaults anything. A secret is never a value in it:
// the graph database's password is the launcher's own for a Neo4j it runs,
// and a ${NAME} in the KB config for somebody else's, and the document names
// the variable either way.

import (
	"encoding/json"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// weaverDocumentFile: the Weaver is configured by a document, not a copy of
// the KB's config. One name, staged and mounted.
const weaverDocumentFile = "weaver.json"

// weaverDocumentTarget: where the Weaver reads that document — the path its
// image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook holds
// the two together.
const weaverDocumentTarget = "/etc/semiont/weaver.json"

// weaverCheckpointPath: where the Weaver keeps its marks, in its container's
// own temporary directory. The Weaver mounts no state: its marks are never a
// correctness input, and a Weaver that finds none applies the whole record
// again and ends with the same graph.
const weaverCheckpointPath = "/tmp/semiont/weaver-checkpoint.json"

// weaverNamedVars: the variables the Weaver's document names rather than
// resolves — the graph database's password, where the KB config references
// one — and so the ones the Weaver is handed. A Neo4j the launcher runs
// states no password in the config: its variable is the launcher's own, added
// with the other daemon credentials (withDaemonCredentialVars). A password
// that is not exactly ${NAME} names nothing here; writing the document
// refuses it.
func weaverNamedVars(env *envConfig) []string {
	if env.Graph == nil {
		return nil
	}
	if name, _ := secretName("graph.password", env.Graph.Password); name != nil {
		return []string{*name}
	}
	return nil
}

// graphConfig: the graph database a service reaches, as its document states
// it. ONE decider, for the Weaver's document, which writes the graph, and the
// Librarian's, which reads it. graphRun says the launcher runs it, and so
// holds its password. who names the service in a refusal.
func graphConfig(env *envConfig, vars map[string]string, graphRun bool, who string) (graph semiont.GraphConfig, err error) {
	g := env.Graph
	if g == nil {
		return graph, fmt.Errorf("the environment declares no [graph]: %s has no graph database to reach", who)
	}
	if g.Type != string(semiont.Neo4jGraphConfigTypeNeo4j) {
		return graph, fmt.Errorf("[graph] type %q: the launcher writes %s's document for a neo4j graph alone", g.Type, who)
	}
	neo4j := semiont.Neo4jGraphConfig{Username: g.Username, Database: g.Database}
	if neo4j.Username == "" {
		return graph, fmt.Errorf("[graph] states no username: %s has no user to connect to Neo4j as", who)
	}
	if neo4j.Database == "" {
		return graph, fmt.Errorf("[graph] states no database: %s is not told which of Neo4j's databases holds the graph", who)
	}
	if neo4j.Uri, err = resolveRefs("graph.uri", g.URI, vars); err != nil {
		return graph, err
	}
	if neo4j.Uri == "" {
		return graph, fmt.Errorf("[graph] states no uri: %s has no address to reach Neo4j at", who)
	}
	if graphRun {
		// The Neo4j the launcher runs has the password the launcher generates
		// and keeps; the service is handed it under the launcher's own name.
		neo4j.PasswordEnv = daemonPasswords["graph"].env
	} else {
		name, err := secretName("graph.password", g.Password)
		if err != nil {
			return graph, err
		}
		if name == nil {
			return graph, fmt.Errorf("[graph] states no password: write graph.password = \"${NAME}\", and %s's document names the variable that holds it", who)
		}
		neo4j.PasswordEnv = *name
	}
	err = graph.FromNeo4jGraphConfig(neo4j)
	return graph, err
}

// weaverDocument renders the document from the selected environment, the
// address the launcher computed, and the user's variables.
func weaverDocument(env *envConfig, rt, addr string, issuerPort int, userEnv []string, graphRun bool) ([]byte, error) {
	if env.Gateway == nil || env.Gateway.PublicURL == "" {
		return nil, fmt.Errorf("the environment declares no [gateway] publicURL: the Weaver has no gateway to reach")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the Weaver has no issuer to sign in at")
	}
	vars := gatewayDialerVars(rt, addr, issuerPort, userEnv)
	var doc semiont.WeaverConfig
	var err error
	if doc.GatewayUrl, err = resolveRefs("gateway.publicURL", env.Gateway.PublicURL, vars); err != nil {
		return nil, err
	}
	if doc.Identity.Issuer, err = resolveRefs("identity.issuer", env.Identity.Issuer, vars); err != nil {
		return nil, err
	}
	if doc.Graph, err = graphConfig(env, vars, graphRun, "the Weaver"); err != nil {
		return nil, err
	}
	doc.CheckpointPath = weaverCheckpointPath
	doc.Port = semiontDescriptor("weaver").ports[0].port

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.LogLevel(env.LogLevel)
	}
	doc.LogFormat = semiont.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
