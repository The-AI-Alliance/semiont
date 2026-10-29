package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// mixedActors: the ollama-gemma fixture with its matcher asking Anthropic's
// haiku, at Anthropic's own address, under the key named ANTHROPIC_API_KEY.
// Its gatherer asks the machine's Ollama.
func mixedActors(t *testing.T) *stack.Stack {
	t.Helper()
	st := fixtureStack(t, "ollama-gemma")
	withAnthropic(st)
	st.Inference.Spec.Roster.Actors.Matcher = anthropicHaiku()
	return st
}

func librarianDocumentFrom(t *testing.T, b []byte) api.LibrarianConfig {
	t.Helper()
	var doc api.LibrarianConfig
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a LibrarianConfig: %v\n%s", err, b)
	}
	return doc
}

func librarianDocumentOf(t *testing.T, p placement) api.LibrarianConfig {
	t.Helper()
	b, err := librarianDocument(p)
	if err != nil {
		t.Fatal(err)
	}
	return librarianDocumentFrom(t, b)
}

// Every address is the placement's, each union the one shape its `type` names,
// each secret named, the bounds the KnowledgeIndex's, and the log level the
// KnowledgeIndex's.
func TestLibrarianDocumentStatesWhatThePlacementDecides(t *testing.T) {
	st := mixedActors(t)
	st.KnowledgeIndex.Spec.LogLevel = api.LogLevelDebug
	doc := librarianDocumentOf(t, placed(t, st))
	if doc.GatewayUrl != "http://192.168.64.1:14000" {
		t.Errorf("gatewayUrl = %q, want the address this start places", doc.GatewayUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/semiont" {
		t.Errorf("identity.issuer = %q", doc.Identity.Issuer)
	}
	if doc.Archivist.Host != "192.168.64.1" || doc.Archivist.Port != semiontDescriptor("archivist").ports[0].port {
		t.Errorf("archivist = %+v, want where this start places the Archivist", doc.Archivist)
	}
	wantGraph := api.Neo4jGraphConfig{
		Type:        api.Neo4jGraphConfigTypeNeo4j,
		Uri:         "bolt://192.168.64.1:17687",
		Username:    "neo4j",
		Database:    "neo4j",
		PasswordEnv: daemonPasswords["graph"].env,
	}
	if got := shapeOf[api.Neo4jGraphConfig](t, doc.Graph); got != wantGraph {
		t.Errorf("graph = %+v, want %+v", got, wantGraph)
	}
	wantVectors := api.QdrantVectorsConfig{Type: api.QdrantVectorsConfigTypeQdrant, Host: "192.168.64.1", Port: 6333}
	if got := shapeOf[api.QdrantVectorsConfig](t, doc.Vectors); got != wantVectors {
		t.Errorf("vectors = %+v, want %+v", got, wantVectors)
	}
	wantEmbedding := api.OllamaEmbeddingConfig{
		Type:    api.OllamaEmbeddingConfigTypeOllama,
		Model:   "nomic-embed-text",
		BaseUrl: "http://192.168.64.1:11434",
	}
	if got := shapeOf[api.OllamaEmbeddingConfig](t, doc.Embedding); got != wantEmbedding {
		t.Errorf("embedding = %+v, want %+v", got, wantEmbedding)
	}
	if doc.Matcher.Agent != *anthropicHaiku() || doc.Matcher.BaseUrl != "https://api.anthropic.com" || doc.Matcher.ApiKeyEnv == nil || *doc.Matcher.ApiKeyEnv != "ANTHROPIC_API_KEY" {
		t.Errorf("matcher = %+v, want %+v at Anthropic's own address, its key named ANTHROPIC_API_KEY", doc.Matcher, *anthropicHaiku())
	}
	gatherer := api.ArchivistRosterRole{Provider: api.ArchivistRosterRoleProviderOllama, Model: "gemma4:26b"}
	if doc.Gatherer.Agent != gatherer || doc.Gatherer.BaseUrl != "http://192.168.64.1:11434" || doc.Gatherer.ApiKeyEnv != nil {
		t.Errorf("gatherer = %+v, want %+v at the Ollama this start places, with no key", doc.Gatherer, gatherer)
	}
	if doc.Gather.SettleTimeoutMs != 15_000 || doc.Search.SemanticFloor != 0.6 {
		t.Errorf("gather, search = %+v, %+v, want the KnowledgeIndex's 15000 and 0.6", doc.Gather, doc.Search)
	}
	if doc.Port != semiontDescriptor("librarian").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.LogLevel != api.LogLevelDebug || doc.LogFormat != api.LogFormatJson {
		t.Errorf("logLevel, logFormat = %q, %q, want the KnowledgeIndex's level and JSON", doc.LogLevel, doc.LogFormat)
	}
}

// The bounds the KnowledgeIndex states are the ones written: a floor of 0 is a
// value, and is written as stated.
func TestLibrarianDocumentWritesTheBoundsTheIndexStates(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeIndex.Spec.Librarian.Gather.SettleTimeoutMs = 4000
	st.KnowledgeIndex.Spec.Librarian.Search.SemanticFloor = 0
	doc := librarianDocumentOf(t, placed(t, st))
	if doc.Gather.SettleTimeoutMs != 4000 || doc.Search.SemanticFloor != 0 {
		t.Errorf("gather, search = %+v, %+v, want the stated 4000 and 0", doc.Gather, doc.Search)
	}
}

// The Librarian's graph is the Weaver's, and its vector index and embedding
// provider the Smelter's: one decider for each, so the Librarian reads the
// graph the Weaver writes and searches the index the Smelter fills, with the
// model that made its vectors.
func TestLibrarianDocumentSharesTheWeaversGraphAndTheSmeltersIndex(t *testing.T) {
	for why, graph := range map[string]func(*stack.Stack){
		"the launcher's Neo4j":  func(*stack.Stack) {},
		"somebody else's Neo4j": externalGraph,
	} {
		st := fixtureStack(t, "ollama-gemma")
		graph(st)
		p := placed(t, st)
		doc := librarianDocumentOf(t, p)
		_, weaversGraph := weaverDocumentOf(t, p)
		if got := shapeOf[api.Neo4jGraphConfig](t, doc.Graph); got != weaversGraph {
			t.Errorf("%s: the Librarian's graph is %+v, the Weaver's %+v", why, got, weaversGraph)
		}
		smelters := smelterDocumentOf(t, p)
		if mine, theirs := shapeOf[api.QdrantVectorsConfig](t, doc.Vectors), shapeOf[api.QdrantVectorsConfig](t, smelters.Vectors); mine != theirs {
			t.Errorf("%s: the Librarian's vectors are %+v, the Smelter's %+v", why, mine, theirs)
		}
		if mine, theirs := shapeOf[api.OllamaEmbeddingConfig](t, doc.Embedding), shapeOf[api.OllamaEmbeddingConfig](t, smelters.Embedding); mine != theirs {
			t.Errorf("%s: the Librarian's embedding is %+v, the Smelter's %+v", why, mine, theirs)
		}
		if doc.Archivist.Host != smelters.Archivist.Host || doc.Archivist.Port != smelters.Archivist.Port {
			t.Errorf("%s: the Librarian's archivist is %+v, the Smelter's %+v", why, doc.Archivist, smelters.Archivist)
		}
	}
}

// A secret is named and never stated: the document names the variable each
// document names, and the Librarian is handed exactly those. An Ollama is
// asked without a key, so a roster whose every actor asks an Ollama names
// none, and two actors under one key are handed it once.
func TestLibrarianDocumentNamesItsSecrets(t *testing.T) {
	st := mixedActors(t)
	externalGraph(st)
	voyageEmbedding(st)
	p := placed(t, st)
	doc := librarianDocumentOf(t, p)
	if got := shapeOf[api.Neo4jGraphConfig](t, doc.Graph).PasswordEnv; got != "GRAPH_PASSWORD" {
		t.Errorf("graph.passwordEnv = %q, want the variable the KnowledgeIndex names", got)
	}
	if got := shapeOf[api.VoyageEmbeddingConfig](t, doc.Embedding).ApiKeyEnv; got != "VOYAGE_API_KEY" {
		t.Errorf("embedding.apiKeyEnv = %q, want the variable the KnowledgeIndex names", got)
	}
	if doc.Matcher.ApiKeyEnv == nil || *doc.Matcher.ApiKeyEnv != "ANTHROPIC_API_KEY" {
		t.Errorf("matcher.apiKeyEnv = %v, want the variable the Inference document names", doc.Matcher.ApiKeyEnv)
	}
	if got, want := strings.Join(librarianSecrets(p), " "), "GRAPH_PASSWORD VOYAGE_API_KEY ANTHROPIC_API_KEY"; got != want {
		t.Errorf("the Librarian is handed %q, want the variables its document names, %q", got, want)
	}

	if got := librarianSecrets(placed(t, fixtureStack(t, "ollama-gemma"))); len(got) != 0 {
		t.Errorf("a roster whose every actor asks an Ollama names %v", got)
	}
	if got := librarianSecrets(placed(t, fixtureStack(t, "anthropic"))); len(got) != 1 || got[0] != "ANTHROPIC_API_KEY" {
		t.Errorf("two actors under one key are handed %v, want the one variable", got)
	}
}

// A model's provider is reached where a worker's agent of that provider is:
// one decider, so a model the worker and the Librarian share is one agent at
// one address.
func TestLibrarianModelsAreReachedWhereTheWorkersAgentsAre(t *testing.T) {
	st := mixedActors(t)
	st.Inference.Spec.Roster.Workers.Mark.Tagging = anthropicHaiku()
	p := placed(t, st)
	doc := librarianDocumentOf(t, p)
	agents, err := workerAgents(p)
	if err != nil {
		t.Fatal(err)
	}
	for actor, model := range map[string]api.LibrarianModelConfig{"matcher": doc.Matcher, "gatherer": doc.Gatherer} {
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
			t.Fatalf("no worker is bound to the %s's model %+v: this test would compare nothing", actor, model.Agent)
		}
	}
}

// An actor is served by `actors.<actor>` and by nothing else: the roster the
// Archivist's document names and the model the Librarian's document names are
// one binding.
func TestLibrarianModelsAreTheRostersActors(t *testing.T) {
	p := placed(t, mixedActors(t))
	roster := archivistDocumentOf(t, p).Roster
	doc := librarianDocumentOf(t, p)
	if roster.Actors.Matcher == nil || *roster.Actors.Matcher != doc.Matcher.Agent {
		t.Errorf("the roster's matcher is %+v, the Librarian's %+v", roster.Actors.Matcher, doc.Matcher.Agent)
	}
	if roster.Actors.Gatherer == nil || *roster.Actors.Gatherer != doc.Gatherer.Agent {
		t.Errorf("the roster's gatherer is %+v, the Librarian's %+v", roster.Actors.Gatherer, doc.Gatherer.Agent)
	}
}

// What the document cannot be written from is refused, naming the document and
// the field: an actor the roster binds no model to, whatever the workers are
// bound to, and a Voyage embedding that names no key.
func TestLibrarianDocumentRefusesWhatItCannotBeWrittenFrom(t *testing.T) {
	for _, c := range []struct {
		why   string
		vary  func(st *stack.Stack)
		names func(st *stack.Stack) string
	}{
		{"no matcher", func(st *stack.Stack) { st.Inference.Spec.Roster.Actors.Matcher = nil },
			func(st *stack.Stack) string { return st.Files.Inference + ": spec.roster.actors.matcher" }},
		{"no gatherer", func(st *stack.Stack) { st.Inference.Spec.Roster.Actors.Gatherer = nil },
			func(st *stack.Stack) string { return st.Files.Inference + ": spec.roster.actors.gatherer" }},
		{"Voyage with no key", func(st *stack.Stack) { voyageEmbedding(st); st.KnowledgeIndex.Spec.Embedding.ApiKey = nil },
			func(st *stack.Stack) string { return st.Files.KnowledgeIndex + ": spec.embedding.apiKey" }},
	} {
		st := fixtureStack(t, "ollama-gemma")
		c.vary(st)
		_, err := librarianDocument(placed(t, st))
		if want := c.names(st); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, want a refusal naming %q", c.why, err, want)
		}
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook). It hands the Librarian nothing
// else: no copy of the KB's documents, no path, and no *_HOST variables,
// because its own document already carries every address. Its health port is
// the descriptor's, which the document carries, the launcher publishes and the
// image probes.
func TestLibrarianDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(serviceDockerfile("librarian"))
	if err != nil {
		t.Fatal(err)
	}
	doc := librarianDocumentOf(t, placed(t, fixtureStack(t, "ollama-gemma")))

	args := strings.Join(librarianArgs("/stage", exposure{rt: "container", addr: "1.2.3.4"}, "client-secret", "v", semiontDescriptor("librarian").mem, []string{"--env", "NEO4J_PASSWORD", "--env", "ANTHROPIC_API_KEY"}, nil), " ")
	if want := "/stage/" + librarianDocumentFile + ":" + librarianDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Librarian's document is not mounted onto %s:\n%s", librarianDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "NEO4J_HOST", "QDRANT_HOST", "OLLAMA_HOST", "KEYCLOAK_HOST", "XDG_STATE_HOME", "JWT_SECRET", stack.Dir} {
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
	if want := "--publish 1.2.3.4:" + port + ":" + port; !strings.Contains(args, want) {
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
// the launcher's Neo4j password, the embedding's key and each actor's
// provider's key — never the pair of a broker it does not dial.
func TestTheLibrarianIsHandedOnlyWhatItsDocumentNames(t *testing.T) {
	st := mixedActors(t)
	voyageEmbedding(st)
	st.KnowledgeBase.Spec.Messaging.Signal.Type = "nats"
	externalBroker(st)
	p := placed(t, st)
	handed := strings.Join(withDaemonCredentialVars(serviceSecrets(p), p.plan, true)["librarian"], " ")
	if want := "VOYAGE_API_KEY ANTHROPIC_API_KEY " + daemonPasswords["graph"].env; handed != want {
		t.Errorf("the Librarian is handed %q, want the variables its document names, %q", handed, want)
	}
	if got, want := strings.Join(secretsRead(p, "librarian"), " "), "ANTHROPIC_API_KEY VOYAGE_API_KEY"; got != want {
		t.Errorf("a start of the Librarian alone demands %q, want %q", got, want)
	}

	externalGraph(st)
	p = placed(t, st)
	if handed := withDaemonCredentialVars(serviceSecrets(p), p.plan, true)["librarian"]; contains(handed, daemonPasswords["graph"].env) {
		t.Errorf("for somebody else's Neo4j the Librarian is handed the launcher's password: %v", handed)
	}
}
