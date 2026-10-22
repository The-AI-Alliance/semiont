package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// The KB config a `semiont init` writes, as far as the Weaver's document reads
// it: the gateway, the issuer, and a Neo4j the launcher runs, which states no
// password.
const weaverDocFixture = `[defaults]
environment = "local"

[environments.local]
logLevel = "debug"

[environments.local.gateway]
platform = "container"
port = 4000
publicURL = "http://${GATEWAY_HOST:-localhost}:4000"

[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
subjectClaim = "sub"

[environments.local.graph]
platform = "container"
type = "neo4j"
uri = "bolt://${NEO4J_HOST}:7687"
username = "neo4j"
database = "neo4j"
`

// somebodyElsesGraph: the fixture with a Neo4j the launcher does not run,
// whose password the config states as written.
func somebodyElsesGraph(password string) string {
	graph := `[environments.local.graph]
platform = "external"
type = "neo4j"
uri = "bolt://graph.internal:7687"
username = "semiont"
database = "kb"
`
	if password != "" {
		graph += "password = \"" + password + "\"\n"
	}
	return weaverDocFixture[:strings.Index(weaverDocFixture, "[environments.local.graph]")] + graph
}

func weaverDocumentFrom(t *testing.T, b []byte) (semiont.WeaverConfig, semiont.Neo4jGraphConfig) {
	t.Helper()
	var doc semiont.WeaverConfig
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

// The document is whole and resolved: every address a literal, the graph
// database's password named and never stated, and nothing left for the Weaver
// to default.
func TestWeaverDocumentIsResolved(t *testing.T) {
	b, err := weaverDocument(envFrom(t, weaverDocFixture), "container", "192.168.64.1", 8080, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "${") {
		t.Errorf("the document holds an unresolved reference:\n%s", b)
	}
	doc, graph := weaverDocumentFrom(t, b)
	if doc.GatewayUrl != "http://192.168.64.1:4000" {
		t.Errorf("gatewayUrl = %q, want the address this start places", doc.GatewayUrl)
	}
	if !strings.HasSuffix(doc.Identity.Issuer, ":8080/realms/semiont") {
		t.Errorf("identity.issuer = %q", doc.Identity.Issuer)
	}
	want := semiont.Neo4jGraphConfig{
		Type:        semiont.Neo4jGraphConfigTypeNeo4j,
		Uri:         "bolt://192.168.64.1:7687",
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
	if doc.LogLevel != "debug" || doc.LogFormat != semiont.LogFormatJson {
		t.Errorf("logLevel, logFormat = %q, %q, want the environment's level and JSON", doc.LogLevel, doc.LogFormat)
	}
}

// A Neo4j the launcher runs has the password the launcher keeps, under the
// launcher's own name. Somebody else's has the one the config references, and
// the document names that variable: the Weaver is handed it among the user's.
func TestWeaverDocumentNamesTheGraphPasswordAndNeverStatesIt(t *testing.T) {
	env := envFrom(t, somebodyElsesGraph("${GRAPH_PASSWORD}"))
	b, err := weaverDocument(env, "container", "192.168.64.1", 8080, []string{"--env", "GRAPH_PASSWORD=the-secret"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "the-secret") {
		t.Errorf("the document states the graph database's password:\n%s", b)
	}
	_, graph := weaverDocumentFrom(t, b)
	if graph.PasswordEnv != "GRAPH_PASSWORD" || graph.Uri != "bolt://graph.internal:7687" || graph.Username != "semiont" || graph.Database != "kb" {
		t.Errorf("graph = %+v, want somebody else's Neo4j as the config states it, its password by name", graph)
	}
	if got := weaverNamedVars(env); len(got) != 1 || got[0] != "GRAPH_PASSWORD" {
		t.Errorf("the Weaver is handed %v, want the one variable its document names", got)
	}
	if got := weaverNamedVars(envFrom(t, weaverDocFixture)); len(got) != 0 {
		t.Errorf("a config that states no graph password names %v", got)
	}
}

// What the document cannot be written from is refused, naming what is
// missing. A password written as a value is refused: a document carries no
// secret.
func TestWeaverDocumentRefusesWhatItCannotBeWrittenFrom(t *testing.T) {
	without := func(section string) string {
		start := strings.Index(weaverDocFixture, "[environments.local."+section+"]")
		rest := weaverDocFixture[start+1:]
		end := strings.Index(rest, "\n[")
		if end < 0 {
			return weaverDocFixture[:start]
		}
		return weaverDocFixture[:start] + rest[end+1:]
	}
	for _, c := range []struct {
		why      string
		config   string
		graphRun bool
		names    string
	}{
		{"no gateway", without("gateway"), true, "publicURL"},
		{"no identity", without("identity"), true, "identity"},
		{"no graph", without("graph"), true, "[graph]"},
		{"a kind of graph the launcher writes no document for", strings.Replace(weaverDocFixture, `type = "neo4j"`, `type = "janusgraph"`, 1), true, "janusgraph"},
		{"no username", strings.Replace(weaverDocFixture, "username = \"neo4j\"\n", "", 1), true, "username"},
		{"no database", strings.Replace(weaverDocFixture, "database = \"neo4j\"\n", "", 1), true, "database"},
		{"somebody else's Neo4j with no password", somebodyElsesGraph(""), false, "graph.password"},
		{"a password written as a value", somebodyElsesGraph("hunter2"), false, "graph.password"},
	} {
		_, err := weaverDocument(envFrom(t, c.config), "container", "192.168.64.1", 8080, nil, c.graphRun)
		if err == nil || !strings.Contains(err.Error(), c.names) {
			t.Errorf("%s: err = %v, want a refusal naming %q", c.why, err, c.names)
		}
		if err != nil && strings.Contains(err.Error(), "hunter2") {
			t.Errorf("%s: the refusal repeats the password: %v", c.why, err)
		}
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and hands the Weaver nothing
// else: no copy of the KB's config, and no *_HOST variables, because the
// document already carries every address. Its health port is the descriptor's,
// which the document carries, the launcher publishes and the image probes.
func TestWeaverDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "weaver", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}

	args := strings.Join(weaverArgs("/stage", "container", "1.2.3.4", "client-secret", "v", semiontDescriptor("weaver").mem, []string{"--env", "NEO4J_PASSWORD"}, nil), " ")
	if want := "/stage/" + weaverDocumentFile + ":" + weaverDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Weaver's document is not mounted onto %s:\n%s", weaverDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "NEO4J_HOST", "KEYCLOAK_HOST", ".semiontconfig", ".toml"} {
		if strings.Contains(args, unread) {
			t.Errorf("the Weaver is handed %s, which it does not read:\n%s", unread, args)
		}
	}
	for _, handed := range []string{"SEMIONT_OIDC_CLIENT_ID=" + serviceClientID("weaver"), "SEMIONT_OIDC_CLIENT_SECRET=client-secret", "--env NEO4J_PASSWORD"} {
		if !strings.Contains(args, handed) {
			t.Errorf("the Weaver is not handed %s:\n%s", handed, args)
		}
	}

	b, err := weaverDocument(envFrom(t, weaverDocFixture), "container", "1.2.3.4", 8080, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := weaverDocumentFrom(t, b)
	port := fmt.Sprint(doc.Port)
	if want := "--publish " + port + ":" + port; !strings.Contains(args, want) {
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
// start hands the Weaver that variable beside what its document names.
func TestTheWeaverIsHandedTheLaunchersNeo4jPassword(t *testing.T) {
	plan := &launchPlan{Roles: map[string]rolePlan{"graph": {Presence: presenceLauncher}, "messaging": {}}}
	handed := withDaemonCredentialVars(map[string][]string{"weaver": nil}, plan, false)["weaver"]
	if len(handed) != 1 || handed[0] != daemonPasswords["graph"].env {
		t.Errorf("the Weaver is handed %v, want %s", handed, daemonPasswords["graph"].env)
	}
	plan.Roles["graph"] = rolePlan{Presence: presenceExternal}
	if handed := withDaemonCredentialVars(map[string][]string{"weaver": {"GRAPH_PASSWORD"}}, plan, false)["weaver"]; len(handed) != 1 || handed[0] != "GRAPH_PASSWORD" {
		t.Errorf("for somebody else's Neo4j the Weaver is handed %v, want what its document names alone", handed)
	}
}
