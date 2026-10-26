package launcher

// weaverdoc.go — the Weaver's configuration document: WeaverConfig in specs/,
// the Go type generated from it (packages/sdk-go). The launcher writes it for
// the Weaver it starts, every address a literal (placement), and mounts it
// where the Weaver's image points its `--config` flag, so the Weaver neither
// reads a knowledge base's documents nor resolves or defaults anything. A
// secret is never a value in it: the graph database's password is the
// launcher's own for a Neo4j it runs, and the variable the KnowledgeIndex
// names (`fromEnv`) for somebody else's, and the document names the variable
// either way.

import (
	"encoding/json"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// weaverDocumentFile: the Weaver is configured by a document, not a copy of
// the KB's. One name, staged and mounted.
const weaverDocumentFile = "weaver.json"

// weaverDocumentTarget: where the Weaver reads that document — the path its
// image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook holds
// the two together.
const weaverDocumentTarget = "/etc/semiont/weaver.json"

// cursorsPath: where a follower of the record — the Weaver, the Smelter —
// keeps its cursors, in its container's own temporary directory. ONE decider
// for both documents. Never under the knowledge base's .semiont (ruled
// 2026-10-21): a cursor is never a correctness input, so losing the file,
// as every `semiont start` does when it makes the container again, costs
// time and never correctness. The service mounts no state for it.
func cursorsPath(service string) string {
	return "/tmp/semiont/" + service + "-cursors.json"
}

// graphSecrets: the variables a document reaching the graph names, and so the
// ones its service is handed — the password of a graph database somebody else
// runs. The password of the Neo4j the launcher runs is the launcher's own
// (withDaemonCredentialVars).
func graphSecrets(p placement) []string {
	if external := p.st.KnowledgeIndex.Spec.Graph.External; external != nil {
		return []string{external.Password.FromEnv}
	}
	return nil
}

// graphConfig: the graph database a service reaches, as its document states
// it. ONE decider, for the Weaver's document, which writes the graph, and the
// Librarian's, which reads it. who names the service in a refusal.
func graphConfig(p placement, who string) (graph api.GraphConfig, err error) {
	g := p.st.KnowledgeIndex.Spec.Graph
	if g.Type != string(api.Neo4jGraphConfigTypeNeo4j) {
		return graph, planErr(p.st.Files.KnowledgeIndex, "spec.graph.type", "is %q: the launcher writes %s's document for a neo4j graph alone", g.Type, who)
	}
	neo4j := api.Neo4jGraphConfig{Username: g.Username, Database: g.Database, Uri: p.graphURI()}
	if g.External != nil {
		neo4j.PasswordEnv = g.External.Password.FromEnv
	} else {
		// The Neo4j the launcher runs has the password the launcher generates
		// and keeps; the service is handed it under the launcher's own name.
		neo4j.PasswordEnv = daemonPasswords["graph"].env
	}
	err = graph.FromNeo4jGraphConfig(neo4j)
	return graph, err
}

// weaverDocument renders the document from the start's placement. The Weaver
// reads the record by position at the Archivist (placement).
func weaverDocument(p placement) ([]byte, error) {
	var doc api.WeaverConfig
	var err error
	doc.GatewayUrl = p.gatewayURL()
	doc.Identity.Issuer = p.issuer()
	doc.Archivist.Host, doc.Archivist.Port = p.archivist()
	if doc.Graph, err = graphConfig(p, "the Weaver"); err != nil {
		return nil, err
	}
	doc.CursorsPath = cursorsPath("weaver")
	doc.Port = semiontDescriptor("weaver").ports[0].port
	doc.LogLevel = p.st.KnowledgeIndex.Spec.LogLevel
	doc.LogFormat = api.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
