package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// externalGraph: st with a Neo4j somebody else runs at graph.internal, signed
// in to as semiont, the graph in its kb database, its password named
// GRAPH_PASSWORD.
func externalGraph(st *stack.Stack) {
	g := &st.KnowledgeIndex.Spec.Graph
	g.Image, g.Resources = nil, nil
	g.Username, g.Database = "semiont", "kb"
	g.External = &stack.KnowledgeIndexGraphExternal{Uri: "bolt://graph.internal:7687", Password: stack.SecretRef{FromEnv: "GRAPH_PASSWORD"}}
}

func weaverDocumentFrom(t *testing.T, b []byte) (api.WeaverConfig, api.Neo4jGraphConfig) {
	t.Helper()
	var doc api.WeaverConfig
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a WeaverConfig: %v\n%s", err, b)
	}
	graph, err := doc.Graph.AsNeo4jGraphConfig()
	if err != nil {
		t.Fatalf("the document's graph is not a Neo4jGraphConfig: %v\n%s", err, b)
	}
	return doc, graph
}

func weaverDocumentOf(t *testing.T, p placement) (api.WeaverConfig, api.Neo4jGraphConfig) {
	t.Helper()
	b, err := weaverDocument(p, exampleKB)
	if err != nil {
		t.Fatal(err)
	}
	return weaverDocumentFrom(t, b)
}

// Every address is the placement's, the password of the Neo4j the launcher
// runs is named by the launcher's own variable, and the log level is the
// KnowledgeIndex's.
func TestWeaverDocumentStatesWhatThePlacementDecides(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeIndex.Spec.LogLevel = api.LogLevelDebug
	doc, graph := weaverDocumentOf(t, placed(t, st))
	if doc.GatewayUrl != "http://192.168.64.1:14000" {
		t.Errorf("gatewayUrl = %q, want the address this start places", doc.GatewayUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/example.github.io-test-kb" {
		t.Errorf("identity.issuer = %q", doc.Identity.Issuer)
	}
	want := api.Neo4jGraphConfig{
		Type:        api.Neo4jGraphConfigTypeNeo4j,
		Uri:         "bolt://192.168.64.1:17687",
		Username:    "neo4j",
		Database:    "neo4j",
		PasswordEnv: daemonPasswords["graph"].env,
	}
	if graph != want {
		t.Errorf("graph = %+v, want %+v", graph, want)
	}
	if doc.CursorsPath != "/tmp/semiont/weaver-cursors.json" {
		t.Errorf("cursorsPath = %q, want the Weaver's file of the container's own disk", doc.CursorsPath)
	}
	if doc.Archivist.Host != "192.168.64.1" || doc.Archivist.Port != semiontDescriptor("archivist").ports[0].port {
		t.Errorf("archivist = %+v, want where this start places the Archivist", doc.Archivist)
	}
	if doc.Port != semiontDescriptor("weaver").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.LogLevel != api.LogLevelDebug || doc.LogFormat != api.LogFormatJson {
		t.Errorf("logLevel, logFormat = %q, %q, want the KnowledgeIndex's level and JSON", doc.LogLevel, doc.LogFormat)
	}
}

// Somebody else's Neo4j is where its document states it, and its password is
// the variable the document names: the Weaver is handed that one.
func TestWeaverDocumentNamesTheGraphPassword(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	externalGraph(st)
	p := placed(t, st)
	_, graph := weaverDocumentOf(t, p)
	if graph.PasswordEnv != "GRAPH_PASSWORD" || graph.Uri != "bolt://graph.internal:7687" || graph.Username != "semiont" || graph.Database != "kb" {
		t.Errorf("graph = %+v, want somebody else's Neo4j as its document states it, its password by name", graph)
	}
	if got := graphSecrets(p); len(got) != 1 || got[0] != "GRAPH_PASSWORD" {
		t.Errorf("the Weaver is handed %v, want the one variable its document names", got)
	}
	if got := graphSecrets(placed(t, fixtureStack(t, "ollama-gemma"))); len(got) != 0 {
		t.Errorf("a Neo4j the launcher runs names %v of the user's", got)
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and hands the Weaver nothing
// else: no copy of the KB's documents, and no *_HOST variables, because its
// own document already carries every address. Its health port is the
// descriptor's, which the document carries, the launcher publishes and the
// image probes.
func TestWeaverDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(serviceDockerfile("weaver"))
	if err != nil {
		t.Fatal(err)
	}

	args := strings.Join(weaverArgs("kb", "/stage", exposure{rt: "container", addr: "1.2.3.4"}, semiontDescriptor("weaver").ports[0].port, "client-secret", "v", semiontDescriptor("weaver").mem, []string{"--env", "NEO4J_PASSWORD"}, nil), " ")
	if want := "/stage/" + weaverDocumentFile + ":" + weaverDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Weaver's document is not mounted onto %s:\n%s", weaverDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "NEO4J_HOST", "KEYCLOAK_HOST", stack.Dir} {
		if strings.Contains(args, unread) {
			t.Errorf("the Weaver is handed %s, which it does not read:\n%s", unread, args)
		}
	}
	for _, handed := range []string{"SEMIONT_OIDC_CLIENT_ID=" + serviceClientID("weaver"), "SEMIONT_OIDC_CLIENT_SECRET=client-secret", "--env NEO4J_PASSWORD"} {
		if !strings.Contains(args, handed) {
			t.Errorf("the Weaver is not handed %s:\n%s", handed, args)
		}
	}

	doc, _ := weaverDocumentOf(t, placed(t, fixtureStack(t, "ollama-gemma")))
	port := fmt.Sprint(doc.Port)
	if want := "--publish 1.2.3.4:" + port + ":" + port; !strings.Contains(args, want) {
		t.Errorf("the Weaver's health port is not published (%s):\n%s", want, args)
	}
	for label, re := range map[string]*regexp.Regexp{
		"EXPOSE":          regexp.MustCompile(`(?m)^EXPOSE (\d+)`),
		"HEALTHCHECK":     regexp.MustCompile(`localhost:(\d+)/health`),
		"SUPERVISE_PROBE": regexp.MustCompile(`SUPERVISE_PROBE=http://localhost:(\d+)/health`),
	} {
		if m := re.FindSubmatch(df); m == nil || string(m[1]) != port {
			t.Errorf("the weaver image's %s disagrees with the port its document carries, %s", label, port)
		}
	}
}

// A Neo4j the launcher runs is reached with the launcher's own password, so a
// start hands the Weaver that variable; for somebody else's, it is handed the
// one the document names, and not the launcher's.
func TestTheWeaverIsHandedTheLaunchersNeo4jPassword(t *testing.T) {
	p := placed(t, fixtureStack(t, "ollama-gemma"))
	if handed := withDaemonCredentialVars(serviceSecrets(p), p.plan, false)["weaver"]; len(handed) != 1 || handed[0] != daemonPasswords["graph"].env {
		t.Errorf("the Weaver is handed %v, want %s", handed, daemonPasswords["graph"].env)
	}
	st := fixtureStack(t, "ollama-gemma")
	externalGraph(st)
	p = placed(t, st)
	if handed := withDaemonCredentialVars(serviceSecrets(p), p.plan, false)["weaver"]; len(handed) != 1 || handed[0] != "GRAPH_PASSWORD" {
		t.Errorf("for somebody else's Neo4j the Weaver is handed %v, want what its document names alone", handed)
	}
}
