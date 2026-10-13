package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// The KB config a `semiont init` writes, as far as the Librarian's document
// reads it: the gateway, the issuer, a Neo4j the launcher runs, the Qdrant and
// the Ollama the launcher places, the two providers, and a model for each
// actor. It states neither bound.
const librarianDocFixture = `[defaults]
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

[environments.local.vectors]
type = "qdrant"
host = "${QDRANT_HOST}"
port = 6333

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"
baseURL = "http://${OLLAMA_HOST}:11434"

[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.inference.ollama]
platform = "posix"
baseURL = "http://${OLLAMA_HOST}:11434"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.actors.gatherer.inference]
type = "ollama"
model = "gemma3:4b"
`

// librarianConfig: the fixture with one section of its environment written
// anew, or added.
func librarianConfig(section, body string) string {
	return withSection(librarianDocFixture, section, body)
}

func librarianDocumentFrom(t *testing.T, b []byte) semiont.LibrarianConfig {
	t.Helper()
	var doc semiont.LibrarianConfig
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a LibrarianConfig: %v\n%s", err, b)
	}
	return doc
}

// librarianDocumentOf: the document written from a config for a Neo4j the
// launcher runs, or the refusal.
func librarianDocumentOf(t *testing.T, config string, userEnv ...string) ([]byte, error) {
	t.Helper()
	return librarianDocument(envFrom(t, config), "local", "test-kb", "container", "192.168.64.1", 8080, userEnv, true)
}

// The document is whole and resolved: every address a literal, each union the
// one shape its `type` names, each secret named and never stated, and nothing
// left for the Librarian to default.
func TestLibrarianDocumentIsResolved(t *testing.T) {
	b, err := librarianDocumentOf(t, librarianDocFixture, "--env", "ANTHROPIC_API_KEY=the-secret")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "${") {
		t.Errorf("the document holds an unresolved reference:\n%s", b)
	}
	if strings.Contains(string(b), "the-secret") {
		t.Errorf("the document states a provider's key:\n%s", b)
	}
	doc := librarianDocumentFrom(t, b)
	if doc.GatewayUrl != "http://192.168.64.1:4000" {
		t.Errorf("gatewayUrl = %q, want the address this start places", doc.GatewayUrl)
	}
	if !strings.HasSuffix(doc.Identity.Issuer, ":8080/realms/semiont") {
		t.Errorf("identity.issuer = %q", doc.Identity.Issuer)
	}
	if doc.Archivist.Host != "192.168.64.1" || doc.Archivist.Port != semiontDescriptor("archivist").ports[0].port {
		t.Errorf("archivist = %+v, want where this start places the Archivist", doc.Archivist)
	}
	if store := stateStores["state"]; doc.StateHome != store.mounts[0].target {
		t.Errorf("stateHome = %q, want the path the launcher mounts the state volume onto, %q", doc.StateHome, store.mounts[0].target)
	}
	if doc.KbName != "test-kb" {
		t.Errorf("kbName = %q, want the knowledge base's name", doc.KbName)
	}
	wantGraph := semiont.Neo4jGraphConfig{
		Type:        semiont.Neo4jGraphConfigTypeNeo4j,
		Uri:         "bolt://192.168.64.1:7687",
		Username:    "neo4j",
		Database:    "neo4j",
		PasswordEnv: daemonPasswords["graph"].env,
	}
	if got := shapeOf[semiont.Neo4jGraphConfig](t, doc.Graph); got != wantGraph {
		t.Errorf("graph = %+v, want %+v", got, wantGraph)
	}
	wantVectors := semiont.QdrantVectorsConfig{Type: semiont.QdrantVectorsConfigTypeQdrant, Host: "192.168.64.1", Port: 6333}
	if got := shapeOf[semiont.QdrantVectorsConfig](t, doc.Vectors); got != wantVectors {
		t.Errorf("vectors = %+v, want %+v", got, wantVectors)
	}
	wantEmbedding := semiont.OllamaEmbeddingConfig{
		Type:    semiont.OllamaEmbeddingConfigTypeOllama,
		Model:   "nomic-embed-text",
		BaseUrl: "http://192.168.64.1:11434",
	}
	if got := shapeOf[semiont.OllamaEmbeddingConfig](t, doc.Embedding); got != wantEmbedding {
		t.Errorf("embedding = %+v, want %+v", got, wantEmbedding)
	}
	matcher := semiont.ArchivistRosterRole{Provider: semiont.ArchivistRosterRoleProviderAnthropic, Model: "claude-haiku-4-5-20251001"}
	if doc.Matcher.Agent != matcher || doc.Matcher.BaseUrl != "https://api.anthropic.com" || doc.Matcher.ApiKeyEnv == nil || *doc.Matcher.ApiKeyEnv != "ANTHROPIC_API_KEY" {
		t.Errorf("matcher = %+v, want %+v at Anthropic's address, its key named ANTHROPIC_API_KEY", doc.Matcher, matcher)
	}
	gatherer := semiont.ArchivistRosterRole{Provider: semiont.ArchivistRosterRoleProviderOllama, Model: "gemma3:4b"}
	if doc.Gatherer.Agent != gatherer || doc.Gatherer.BaseUrl != "http://192.168.64.1:11434" || doc.Gatherer.ApiKeyEnv != nil {
		t.Errorf("gatherer = %+v, want %+v at the Ollama this start places, with no key", doc.Gatherer, gatherer)
	}
	if doc.Gather.SettleTimeoutMs != 15_000 || doc.Search.SemanticFloor != 0.6 {
		t.Errorf("gather, search = %+v, %+v, want the launcher's 15000 and 0.6", doc.Gather, doc.Search)
	}
	if doc.Port != semiontDescriptor("librarian").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.LogLevel != "debug" || doc.LogFormat != semiont.LogFormatJson {
		t.Errorf("logLevel, logFormat = %q, %q, want the environment's level and JSON", doc.LogLevel, doc.LogFormat)
	}
}

// The Librarian defaults nothing, so the launcher writes each bound the KB's
// config leaves unstated. A floor of 0 is a value the config states, and is
// written as stated.
func TestLibrarianDocumentWritesWhatTheConfigLeavesUnstated(t *testing.T) {
	for _, c := range []struct {
		why             string
		config          string
		settleTimeoutMs int
		semanticFloor   float32
	}{
		{"no make-meaning section", librarianDocFixture, 15_000, 0.6},
		{"a settle timeout alone", librarianConfig("make-meaning.gather", "settleTimeoutMs = 4000\n"), 4000, 0.6},
		{"a floor alone", librarianConfig("make-meaning.search", "semanticFloor = 0.75\n"), 15_000, 0.75},
		{"a floor of 0", librarianConfig("make-meaning.search", "semanticFloor = 0.0\n"), 15_000, 0},
		{"both", librarianConfig("make-meaning.gather", "settleTimeoutMs = 4000\n") + "\n[environments.local.make-meaning.search]\nsemanticFloor = 1.0\n", 4000, 1},
	} {
		b, err := librarianDocumentOf(t, c.config)
		if err != nil {
			t.Errorf("%s: %v", c.why, err)
			continue
		}
		if doc := librarianDocumentFrom(t, b); doc.Gather.SettleTimeoutMs != c.settleTimeoutMs || doc.Search.SemanticFloor != c.semanticFloor {
			t.Errorf("%s: gather, search = %+v, %+v, want %d and %v", c.why, doc.Gather, doc.Search, c.settleTimeoutMs, c.semanticFloor)
		}
	}
}

// The Librarian's graph is the Weaver's, and its vector index and embedding
// provider the Smelter's: one decider for each, so the Librarian reads the
// graph the Weaver writes and searches the index the Smelter fills, with the
// model that made its vectors.
func TestLibrarianDocumentSharesTheWeaversGraphAndTheSmeltersIndex(t *testing.T) {
	for _, graphRun := range []bool{true, false} {
		config := librarianDocFixture
		if !graphRun {
			config = librarianConfig("graph", "platform = \"external\"\ntype = \"neo4j\"\nuri = \"bolt://graph.internal:7687\"\nusername = \"semiont\"\ndatabase = \"kb\"\npassword = \"${GRAPH_PASSWORD}\"\n")
		}
		env := envFrom(t, config)
		librarian, err := librarianDocument(env, "local", "test-kb", "container", "192.168.64.1", 8080, nil, graphRun)
		if err != nil {
			t.Fatal(err)
		}
		weaver, err := weaverDocument(env, "container", "192.168.64.1", 8080, nil, graphRun)
		if err != nil {
			t.Fatal(err)
		}
		smelter, err := smelterDocument(env, "container", "192.168.64.1", 8080, nil)
		if err != nil {
			t.Fatal(err)
		}
		doc := librarianDocumentFrom(t, librarian)
		_, weaversGraph := weaverDocumentFrom(t, weaver)
		if got := shapeOf[semiont.Neo4jGraphConfig](t, doc.Graph); got != weaversGraph {
			t.Errorf("graphRun %v: the Librarian's graph is %+v, the Weaver's %+v", graphRun, got, weaversGraph)
		}
		smelters := smelterDocumentFrom(t, smelter)
		if mine, theirs := shapeOf[semiont.QdrantVectorsConfig](t, doc.Vectors), shapeOf[semiont.QdrantVectorsConfig](t, smelters.Vectors); mine != theirs {
			t.Errorf("graphRun %v: the Librarian's vectors are %+v, the Smelter's %+v", graphRun, mine, theirs)
		}
		if mine, theirs := shapeOf[semiont.OllamaEmbeddingConfig](t, doc.Embedding), shapeOf[semiont.OllamaEmbeddingConfig](t, smelters.Embedding); mine != theirs {
			t.Errorf("graphRun %v: the Librarian's embedding is %+v, the Smelter's %+v", graphRun, mine, theirs)
		}
		if doc.Archivist.Host != smelters.Archivist.Host || doc.Archivist.Port != smelters.Archivist.Port {
			t.Errorf("graphRun %v: the Librarian's archivist is %+v, the Smelter's %+v", graphRun, doc.Archivist, smelters.Archivist)
		}
	}
}

// A secret is named and never stated: the document names the variable the
// config references, and the Librarian is handed it among the user's. An
// Ollama is asked without a key, so a config whose every provider is an Ollama
// names none.
func TestLibrarianDocumentNamesItsSecretsAndNeverStatesThem(t *testing.T) {
	config := librarianConfig("graph", "platform = \"external\"\ntype = \"neo4j\"\nuri = \"bolt://graph.internal:7687\"\nusername = \"semiont\"\ndatabase = \"kb\"\npassword = \"${GRAPH_PASSWORD}\"\n")
	config = withSection(config, "embedding", "type = \"voyage\"\nmodel = \"voyage-3\"\napiKey = \"${VOYAGE_API_KEY}\"\n")
	env := envFrom(t, config)
	b, err := librarianDocument(env, "local", "test-kb", "container", "192.168.64.1", 8080,
		[]string{"--env", "GRAPH_PASSWORD=graph-secret", "--env", "VOYAGE_API_KEY=voyage-secret", "--env", "ANTHROPIC_API_KEY=model-secret"}, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"graph-secret", "voyage-secret", "model-secret"} {
		if strings.Contains(string(b), secret) {
			t.Errorf("the document states a secret (%s):\n%s", secret, b)
		}
	}
	doc := librarianDocumentFrom(t, b)
	if got := shapeOf[semiont.Neo4jGraphConfig](t, doc.Graph).PasswordEnv; got != "GRAPH_PASSWORD" {
		t.Errorf("graph.passwordEnv = %q, want the variable the config references", got)
	}
	if got := shapeOf[semiont.VoyageEmbeddingConfig](t, doc.Embedding).ApiKeyEnv; got != "VOYAGE_API_KEY" {
		t.Errorf("embedding.apiKeyEnv = %q, want the variable the config references", got)
	}
	if doc.Matcher.ApiKeyEnv == nil || *doc.Matcher.ApiKeyEnv != "ANTHROPIC_API_KEY" {
		t.Errorf("matcher.apiKeyEnv = %v, want the variable the config references", doc.Matcher.ApiKeyEnv)
	}
	if got, want := strings.Join(librarianNamedVars(env), " "), "GRAPH_PASSWORD VOYAGE_API_KEY ANTHROPIC_API_KEY"; got != want {
		t.Errorf("the Librarian is handed %q, want the variables its document names, %q", got, want)
	}

	ollamaAlone := librarianConfig("actors.matcher.inference", "type = \"ollama\"\nmodel = \"gemma3:4b\"\n")
	if got := librarianNamedVars(envFrom(t, ollamaAlone)); len(got) != 0 {
		t.Errorf("a config whose every provider is an Ollama names %v", got)
	}
	// Two actors under one key are handed it once.
	bothAnthropic := librarianConfig("actors.gatherer.inference", "type = \"anthropic\"\nmodel = \"claude-sonnet-4-5-20250929\"\n")
	if got := librarianNamedVars(envFrom(t, bothAnthropic)); len(got) != 1 || got[0] != "ANTHROPIC_API_KEY" {
		t.Errorf("two actors under one key are handed %v, want the one variable", got)
	}
}

// A model's provider is reached where a worker's agent of that provider is:
// one decider, so a model the worker and the Librarian share is one agent at
// one address.
func TestLibrarianModelsAreReachedWhereTheWorkersAgentsAre(t *testing.T) {
	config := librarianDocFixture +
		"\n[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-haiku-4-5-20251001\"\n" +
		"\n[environments.local.workers.yield.inference]\ntype = \"ollama\"\nmodel = \"gemma3:4b\"\n"
	env := envFrom(t, config)
	b, err := librarianDocumentOf(t, config)
	if err != nil {
		t.Fatal(err)
	}
	doc := librarianDocumentFrom(t, b)
	agents, err := workerAgents(env, "local", gatewayDialerVars("container", "192.168.64.1", 8080, nil))
	if err != nil {
		t.Fatal(err)
	}
	for actor, model := range map[string]semiont.LibrarianModelConfig{"matcher": doc.Matcher, "gatherer": doc.Gatherer} {
		found := false
		for _, agent := range agents {
			if agent.Agent != model.Agent {
				continue
			}
			found = true
			if agent.BaseUrl != model.BaseUrl || !reflect.DeepEqual(agent.ApiKeyEnv, model.ApiKeyEnv) {
				t.Errorf("the %s asks %+v at %q under %v, and the worker's agent is at %q under %v", actor, model.Agent, model.BaseUrl, model.ApiKeyEnv, agent.BaseUrl, agent.ApiKeyEnv)
			}
		}
		if !found {
			t.Fatalf("the fixture binds no worker to the %s's model %+v: this test would compare nothing", actor, model.Agent)
		}
	}

	// An Anthropic section that states no endpoint is reached at Anthropic's own.
	unstated := strings.Replace(librarianDocFixture, "endpoint = \"https://api.anthropic.com\"\n", "", 1)
	if b, err = librarianDocumentOf(t, unstated); err != nil {
		t.Fatal(err)
	}
	if got := librarianDocumentFrom(t, b).Matcher.BaseUrl; got != "https://api.anthropic.com" {
		t.Errorf("a section that states no endpoint is reached at %q, want Anthropic's own address", got)
	}
}

// An actor is served by `actors.<actor>` and by nothing else: the roster the
// Archivist's document names and the model the Librarian's document names are
// one binding.
func TestLibrarianModelsAreTheRostersActors(t *testing.T) {
	env := envFrom(t, librarianDocFixture)
	roster, err := archivistRoster(env)
	if err != nil {
		t.Fatal(err)
	}
	b, err := librarianDocumentOf(t, librarianDocFixture)
	if err != nil {
		t.Fatal(err)
	}
	doc := librarianDocumentFrom(t, b)
	if roster.Actors.Matcher == nil || *roster.Actors.Matcher != doc.Matcher.Agent {
		t.Errorf("the roster's matcher is %+v, the Librarian's %+v", roster.Actors.Matcher, doc.Matcher.Agent)
	}
	if roster.Actors.Gatherer == nil || *roster.Actors.Gatherer != doc.Gatherer.Agent {
		t.Errorf("the roster's gatherer is %+v, the Librarian's %+v", roster.Actors.Gatherer, doc.Gatherer.Agent)
	}
	// A worker's binding serves no actor.
	workersAlone := withoutSection(librarianDocFixture, "actors.matcher.inference") +
		"\n[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-haiku-4-5-20251001\"\n"
	if _, err := librarianDocumentOf(t, workersAlone); err == nil || !strings.Contains(err.Error(), "[environments.local.actors.matcher.inference]") {
		t.Errorf("workers.default served the matcher: err = %v, want a refusal naming the actor's own section", err)
	}
}

// What the document cannot be written from is refused, naming what is
// missing. A secret written as a value is refused: a document carries no
// secret.
func TestLibrarianDocumentRefusesWhatItCannotBeWrittenFrom(t *testing.T) {
	externalGraph := func(password string) string {
		return librarianConfig("graph", "platform = \"external\"\ntype = \"neo4j\"\nuri = \"bolt://graph.internal:7687\"\nusername = \"semiont\"\ndatabase = \"kb\"\n"+password)
	}
	for _, c := range []struct {
		why      string
		config   string
		graphRun bool
		names    string
	}{
		{"no gateway", withoutSection(librarianDocFixture, "gateway"), true, "publicURL"},
		{"no identity", withoutSection(librarianDocFixture, "identity"), true, "identity"},
		{"no graph", withoutSection(librarianDocFixture, "graph"), true, "[graph]"},
		{"a graph kept in memory", strings.Replace(librarianDocFixture, `type = "neo4j"`, `type = "memory"`, 1), true, "[graph] type \"memory\""},
		{"no graph database named", strings.Replace(librarianDocFixture, "database = \"neo4j\"\n", "", 1), true, "database"},
		{"somebody else's Neo4j with no password", externalGraph(""), false, "graph.password"},
		{"a graph password written as a value", externalGraph("password = \"hunter2\"\n"), false, "graph.password"},
		{"no vectors", withoutSection(librarianDocFixture, "vectors"), true, "[vectors]"},
		{"an index kept in memory", strings.Replace(librarianDocFixture, `type = "qdrant"`, `type = "memory"`, 1), true, "[vectors] type \"memory\""},
		{"no embedding", withoutSection(librarianDocFixture, "embedding"), true, "[embedding]"},
		{"an embedding provider the launcher writes no document for", librarianConfig("embedding", "type = \"openai\"\nmodel = \"m\"\n"), true, "openai"},
		{"Voyage with no key", librarianConfig("embedding", "type = \"voyage\"\nmodel = \"voyage-3\"\n"), true, "embedding.apiKey"},
		{"no matcher", withoutSection(librarianDocFixture, "actors.matcher.inference"), true, "[environments.local.actors.matcher.inference]"},
		{"no gatherer", withoutSection(librarianDocFixture, "actors.gatherer.inference"), true, "[environments.local.actors.gatherer.inference]"},
		{"half an agent", librarianConfig("actors.matcher.inference", "type = \"anthropic\"\n"), true, "actors.matcher.inference"},
		{"a provider Semiont has no client for", librarianConfig("actors.gatherer.inference", "type = \"mistral\"\nmodel = \"m\"\n"), true, "actors.gatherer.inference"},
		{"a provider with no section", withoutSection(librarianDocFixture, "inference.anthropic"), true, "[environments.local.inference.anthropic]"},
		{"an Ollama with no address", strings.Replace(librarianDocFixture, "platform = \"posix\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"", "platform = \"external\"", 1), true, "[environments.local.inference.ollama]"},
		{"a model provider's key written as a value", strings.Replace(librarianDocFixture, `apiKey = "${ANTHROPIC_API_KEY}"`, `apiKey = "hunter2"`, 1), true, "inference.anthropic.apiKey"},
		{"a gather that waits no time", librarianConfig("make-meaning.gather", "settleTimeoutMs = 0\n"), true, "make-meaning.gather.settleTimeoutMs"},
		{"a floor above every similarity", librarianConfig("make-meaning.search", "semanticFloor = 1.5\n"), true, "make-meaning.search.semanticFloor"},
	} {
		_, err := librarianDocument(envFrom(t, c.config), "local", "test-kb", "container", "192.168.64.1", 8080, nil, c.graphRun)
		if err == nil || !strings.Contains(err.Error(), c.names) {
			t.Errorf("%s: err = %v, want a refusal naming %q", c.why, err, c.names)
		}
		if err != nil && strings.Contains(err.Error(), "hunter2") {
			t.Errorf("%s: the refusal repeats the secret: %v", c.why, err)
		}
	}
	if _, err := librarianDocument(envFrom(t, librarianDocFixture), "local", "", "container", "192.168.64.1", 8080, nil, true); err == nil || !strings.Contains(err.Error(), "name") {
		t.Errorf("a knowledge base with no name: err = %v, want a refusal", err)
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and the state volume where the
// document says it is. It hands the Librarian nothing else: no copy of the
// KB's config, no path, and no *_HOST variables, because the document already
// carries every address, the state volume's directory and the knowledge
// base's name. Its health port is the descriptor's, which the document
// carries, the launcher publishes and the image probes.
func TestLibrarianDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "librarian", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := librarianDocument(envFrom(t, librarianDocFixture), "local", "test-kb", "container", "1.2.3.4", 8080, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	doc := librarianDocumentFrom(t, b)

	args := strings.Join(librarianArgs("/stage", "container", "1.2.3.4", "client-secret", "v", []string{"--env", "NEO4J_PASSWORD", "--env", "ANTHROPIC_API_KEY"}, nil,
		"-v", "/state/state:"+stateStores["state"].mounts[0].target), " ")
	if want := "/stage/" + librarianDocumentFile + ":" + librarianDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Librarian's document is not mounted onto %s:\n%s", librarianDocumentTarget, args)
	}
	if want := "-v /state/state:" + doc.StateHome + " "; !strings.Contains(args, want) {
		t.Errorf("the state volume is not mounted onto %s, where the Librarian's document says it is:\n%s", doc.StateHome, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "NEO4J_HOST", "QDRANT_HOST", "OLLAMA_HOST", "KEYCLOAK_HOST", "XDG_STATE_HOME", "JWT_SECRET", ".semiontconfig", ".toml"} {
		if strings.Contains(args, unread) {
			t.Errorf("the Librarian is handed %s, which it does not read:\n%s", unread, args)
		}
	}
	for _, handed := range []string{"SEMIONT_OIDC_CLIENT_ID=" + serviceClientID("librarian"), "SEMIONT_OIDC_CLIENT_SECRET=client-secret", "--env NEO4J_PASSWORD", "--env ANTHROPIC_API_KEY"} {
		if !strings.Contains(args, handed) {
			t.Errorf("the Librarian is not handed %s:\n%s", handed, args)
		}
	}

	port := fmt.Sprint(doc.Port)
	if want := "--publish " + port + ":" + port; !strings.Contains(args, want) {
		t.Errorf("the Librarian's health port is not published (%s):\n%s", want, args)
	}
	for label, re := range map[string]*regexp.Regexp{
		"EXPOSE":          regexp.MustCompile(`(?m)^EXPOSE (\d+)`),
		"HEALTHCHECK":     regexp.MustCompile(`localhost:(\d+)/health`),
		"SUPERVISE_PROBE": regexp.MustCompile(`SUPERVISE_PROBE=http://localhost:(\d+)/health`),
	} {
		if m := re.FindSubmatch(df); m == nil || string(m[1]) != port {
			t.Errorf("the librarian image's %s disagrees with the port its document carries, %s", label, port)
		}
	}
}

// A start hands the Librarian the variables its document names and no other:
// the launcher's Neo4j password, each provider's key, and nothing a section it
// does not read references.
func TestTheLibrarianIsHandedOnlyWhatItsDocumentNames(t *testing.T) {
	config := withSection(librarianDocFixture, "embedding", "type = \"voyage\"\nmodel = \"voyage-3\"\napiKey = \"${VOYAGE_API_KEY}\"\n") +
		"\n[environments.local.jobs]\nplatform = \"external\"\ntype = \"jetstream\"\nservers = \"nats.internal:4222\"\nuser = \"${BROKER_USER}\"\npassword = \"${BROKER_PASSWORD}\"\n"
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, refs, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	plan := &launchPlan{Roles: map[string]rolePlan{"graph": {Presence: presenceLauncher}, "messaging": {Presence: presenceLauncher}}}
	handed := strings.Join(withDaemonCredentialVars(refs.ByService, plan, true)["librarian"], " ")
	if want := "VOYAGE_API_KEY ANTHROPIC_API_KEY " + daemonPasswords["graph"].env; handed != want {
		t.Errorf("the Librarian is handed %q, want the variables its document names, %q", handed, want)
	}
	required, _ := refs.read("librarian")
	if got, want := strings.Join(required, " "), "ANTHROPIC_API_KEY VOYAGE_API_KEY"; got != want {
		t.Errorf("a start of the Librarian alone demands %q, want %q", got, want)
	}
	plan.Roles["graph"] = rolePlan{Presence: presenceExternal}
	if handed := withDaemonCredentialVars(refs.ByService, plan, true)["librarian"]; contains(handed, daemonPasswords["graph"].env) {
		t.Errorf("for somebody else's Neo4j the Librarian is handed the launcher's password: %v", handed)
	}
}
