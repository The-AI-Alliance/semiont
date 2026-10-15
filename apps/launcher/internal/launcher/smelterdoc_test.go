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

// The KB config a `semiont init` writes, as far as the Smelter's document
// reads it: the gateway, the issuer, the Qdrant and the Ollama the launcher
// places, and the two chunking numbers.
const smelterDocFixture = `[defaults]
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

[environments.local.vectors]
type = "qdrant"
host = "${QDRANT_HOST}"
port = 6333

[environments.local.embedding]
type = "ollama"
model = "nomic-embed-text"
baseURL = "http://${OLLAMA_HOST}:11434"

[environments.local.embedding.chunking]
chunkSize = 512
overlap = 64
`

// withoutSection: the config without one section of its environment. The
// sections under it stay.
func withoutSection(config, section string) string {
	start := strings.Index(config, "[environments.local."+section+"]")
	if start < 0 {
		return config
	}
	rest := config[start+1:]
	end := strings.Index(rest, "\n[")
	if end < 0 {
		return config[:start]
	}
	return config[:start] + rest[end+1:]
}

// withSection: the config with one section of its environment written anew,
// or added.
func withSection(config, section, body string) string {
	return withoutSection(config, section) + "\n[environments.local." + section + "]\n" + body
}

// voyageEmbedding: an [embedding] section naming Voyage, with the lines given
// after its type and model.
func voyageEmbedding(lines ...string) string {
	return withSection(withoutSection(smelterDocFixture, "embedding.chunking"), "embedding",
		"type = \"voyage\"\nmodel = \"voyage-3\"\n"+strings.Join(lines, ""))
}

func smelterDocumentFrom(t *testing.T, b []byte) semiont.SmelterConfig {
	t.Helper()
	var doc semiont.SmelterConfig
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a SmelterConfig: %v\n%s", err, b)
	}
	return doc
}

// shapeOf reads one of a document's unions back as the shape T, refusing a
// field T lacks: a union written as another of its shapes does not read as T.
func shapeOf[T any](t *testing.T, union json.Marshaler) T {
	t.Helper()
	var shape T
	b, err := union.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&shape); err != nil {
		t.Fatalf("%s is not a %T: %v", b, shape, err)
	}
	return shape
}

// The document is whole and resolved: every address a literal, each union the
// one shape its `type` names, and nothing left for the Smelter to default.
func TestSmelterDocumentIsResolved(t *testing.T) {
	b, err := smelterDocument(envFrom(t, smelterDocFixture), "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "${") {
		t.Errorf("the document holds an unresolved reference:\n%s", b)
	}
	doc := smelterDocumentFrom(t, b)
	if doc.GatewayUrl != "http://192.168.64.1:4000" {
		t.Errorf("gatewayUrl = %q, want the address this start places", doc.GatewayUrl)
	}
	if !strings.HasSuffix(doc.Identity.Issuer, ":8080/realms/semiont") {
		t.Errorf("identity.issuer = %q", doc.Identity.Issuer)
	}
	if doc.Archivist.Host != "192.168.64.1" || doc.Archivist.Port != semiontDescriptor("archivist").ports[0].port {
		t.Errorf("archivist = %+v, want where this start places the Archivist", doc.Archivist)
	}
	wantEmbedding := semiont.OllamaEmbeddingConfig{
		Type:    semiont.OllamaEmbeddingConfigTypeOllama,
		Model:   "nomic-embed-text",
		BaseUrl: "http://192.168.64.1:11434",
	}
	if got := shapeOf[semiont.OllamaEmbeddingConfig](t, doc.Embedding); got != wantEmbedding {
		t.Errorf("embedding = %+v, want %+v", got, wantEmbedding)
	}
	wantVectors := semiont.QdrantVectorsConfig{Type: semiont.QdrantVectorsConfigTypeQdrant, Host: "192.168.64.1", Port: 6333}
	if got := shapeOf[semiont.QdrantVectorsConfig](t, doc.Vectors); got != wantVectors {
		t.Errorf("vectors = %+v, want %+v", got, wantVectors)
	}
	if doc.Chunking.ChunkSize != 512 || doc.Chunking.Overlap != 64 {
		t.Errorf("chunking = %+v, want the config's 512 and 64", doc.Chunking)
	}
	if store := stateStores["anchored-text"]; store.owner != "smelter" || doc.AnchoredTextDir != store.mounts[0].target {
		t.Errorf("anchoredTextDir = %q, want the path the launcher mounts the Smelter's store onto, %q", doc.AnchoredTextDir, store.mounts[0].target)
	}
	if doc.Port != semiontDescriptor("smelter").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.PdfsAtOnce != 1 {
		t.Errorf("pdfsAtOnce = %d, want the one PDF the table's ceiling holds", doc.PdfsAtOnce)
	}
	if doc.LogLevel != "debug" || doc.LogFormat != semiont.LogFormatJson {
		t.Errorf("logLevel, logFormat = %q, %q, want the environment's level and JSON", doc.LogLevel, doc.LogFormat)
	}
}

// The Smelter works on a PDF at once for each 2G of the ceiling it runs with,
// and on one however small the ceiling is: the table's 2G holds one, and an
// environment's [memory] that gives it more lets it take more at once.
func TestSmelterDocumentWorksOnAPdfAtOnceForEachTwoGigabytesOfItsCeiling(t *testing.T) {
	for _, c := range []struct {
		why, memory string
		want        int
	}{
		{"the table's ceiling", "", 1},
		{"eight gigabytes", "smelter = \"8G\"\n", 4},
		{"five gigabytes, which hold two", "smelter = \"5G\"\n", 2},
		{"less than two gigabytes", "smelter = \"1536M\"\n", 1},
		{"another service's ceiling", "worker = \"8G\"\n", 1},
	} {
		config := smelterDocFixture
		if c.memory != "" {
			config = withSection(config, "memory", c.memory)
		}
		b, err := smelterDocument(envFrom(t, config), "container", "192.168.64.1", 8080, nil)
		if err != nil {
			t.Fatalf("%s: %v", c.why, err)
		}
		if got := smelterDocumentFrom(t, b).PdfsAtOnce; got != c.want {
			t.Errorf("%s: pdfsAtOnce = %d, want %d", c.why, got, c.want)
		}
	}
}

// The Smelter defaults nothing, so the launcher writes what the KB's config
// leaves unstated: each chunking number, and the port of Qdrant's REST API.
// An overlap of 0 is a value the config states, and is written as stated.
func TestSmelterDocumentWritesWhatTheConfigLeavesUnstated(t *testing.T) {
	unstated := withoutSection(smelterDocFixture, "embedding.chunking")
	for _, c := range []struct {
		why                string
		config             string
		chunkSize, overlap int
	}{
		{"no chunking section", unstated, 512, 64},
		{"a chunk size alone", unstated + "\n[environments.local.embedding.chunking]\nchunkSize = 300\n", 300, 64},
		{"an overlap alone", unstated + "\n[environments.local.embedding.chunking]\noverlap = 16\n", 512, 16},
		{"chunks that do not overlap", unstated + "\n[environments.local.embedding.chunking]\nchunkSize = 300\noverlap = 0\n", 300, 0},
	} {
		b, err := smelterDocument(envFrom(t, c.config), "container", "192.168.64.1", 8080, nil)
		if err != nil {
			t.Errorf("%s: %v", c.why, err)
			continue
		}
		if got := smelterDocumentFrom(t, b).Chunking; got.ChunkSize != c.chunkSize || got.Overlap != c.overlap {
			t.Errorf("%s: chunking = %+v, want %d and %d", c.why, got, c.chunkSize, c.overlap)
		}
	}

	b, err := smelterDocument(envFrom(t, strings.Replace(smelterDocFixture, "port = 6333\n", "", 1)), "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := shapeOf[semiont.QdrantVectorsConfig](t, smelterDocumentFrom(t, b).Vectors).Port; got != 6333 {
		t.Errorf("a [vectors] that states no port is written port %d, want 6333", got)
	}
}

// Voyage's key is named and never stated: the document names the variable the
// config references, and the Smelter is handed it among the user's. An Ollama
// is asked without a key, so its document names none. A Voyage section that
// states no endpoint is asked at Voyage's own.
func TestSmelterDocumentNamesVoyagesKeyAndNeverStatesIt(t *testing.T) {
	env := envFrom(t, voyageEmbedding("apiKey = \"${VOYAGE_API_KEY}\"\n"))
	b, err := smelterDocument(env, "container", "192.168.64.1", 8080, []string{"--env", "VOYAGE_API_KEY=the-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "the-secret") {
		t.Errorf("the document states Voyage's key:\n%s", b)
	}
	want := semiont.VoyageEmbeddingConfig{
		Type:      semiont.VoyageEmbeddingConfigTypeVoyage,
		Model:     "voyage-3",
		Endpoint:  "https://api.voyageai.com/v1/embeddings",
		ApiKeyEnv: "VOYAGE_API_KEY",
	}
	if got := shapeOf[semiont.VoyageEmbeddingConfig](t, smelterDocumentFrom(t, b).Embedding); got != want {
		t.Errorf("embedding = %+v, want %+v", got, want)
	}
	if got := smelterNamedVars(env); len(got) != 1 || got[0] != "VOYAGE_API_KEY" {
		t.Errorf("the Smelter is handed %v, want the one variable its document names", got)
	}
	if got := smelterNamedVars(envFrom(t, smelterDocFixture)); len(got) != 0 {
		t.Errorf("a config whose embedding is an Ollama's names %v", got)
	}

	stated := envFrom(t, voyageEmbedding("endpoint = \"https://voyage.internal/v1/embeddings\"\n", "apiKey = \"${VOYAGE_API_KEY}\"\n"))
	if b, err = smelterDocument(stated, "container", "192.168.64.1", 8080, nil); err != nil {
		t.Fatal(err)
	}
	if got := shapeOf[semiont.VoyageEmbeddingConfig](t, smelterDocumentFrom(t, b).Embedding).Endpoint; got != "https://voyage.internal/v1/embeddings" {
		t.Errorf("a stated endpoint is written %q, want it as the config states it", got)
	}
}

// A daemon somebody else runs is where the config states it, and the document
// states it as written. So is an Archivist an operator places by hand.
func TestSmelterDocumentStatesWhatSomebodyElseRunsAsWritten(t *testing.T) {
	config := withSection(smelterDocFixture, "vectors", "platform = \"external\"\ntype = \"qdrant\"\nhost = \"qdrant.internal\"\nport = 7000\n")
	config = strings.Replace(config, "baseURL = \"http://${OLLAMA_HOST}:11434\"\n", "platform = \"external\"\nbaseURL = \"http://ollama.internal:11434\"\n", 1)
	config = withSection(config, "archivist", "host = \"archivist.internal\"\nport = 9999\n")
	b, err := smelterDocument(envFrom(t, config), "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := smelterDocumentFrom(t, b)
	if got := shapeOf[semiont.QdrantVectorsConfig](t, doc.Vectors); got.Host != "qdrant.internal" || got.Port != 7000 {
		t.Errorf("vectors = %+v, want somebody else's Qdrant as the config states it", got)
	}
	if got := shapeOf[semiont.OllamaEmbeddingConfig](t, doc.Embedding).BaseUrl; got != "http://ollama.internal:11434" {
		t.Errorf("embedding.baseUrl = %q, want somebody else's Ollama as the config states it", got)
	}
	if doc.Archivist.Host != "archivist.internal" || doc.Archivist.Port != 9999 {
		t.Errorf("archivist = %+v, want the hand-written section", doc.Archivist)
	}
}

// What the document cannot be written from is refused, naming what is
// missing. A key written as a value is refused: a document carries no secret.
func TestSmelterDocumentRefusesWhatItCannotBeWrittenFrom(t *testing.T) {
	for _, c := range []struct {
		why    string
		config string
		names  string
	}{
		{"no gateway", withoutSection(smelterDocFixture, "gateway"), "publicURL"},
		{"no identity", withoutSection(smelterDocFixture, "identity"), "identity"},
		{"no vectors", withoutSection(smelterDocFixture, "vectors"), "[vectors]"},
		{"a kind of index the launcher writes no document for", strings.Replace(smelterDocFixture, `type = "qdrant"`, `type = "memory"`, 1), "memory"},
		{"no host", strings.Replace(smelterDocFixture, "host = \"${QDRANT_HOST}\"\n", "", 1), "host"},
		{"no embedding", withoutSection(withoutSection(smelterDocFixture, "embedding.chunking"), "embedding"), "[embedding]"},
		{"a provider the launcher writes no document for", strings.Replace(smelterDocFixture, `type = "ollama"`, `type = "openai"`, 1), "openai"},
		{"no model", strings.Replace(smelterDocFixture, "model = \"nomic-embed-text\"\n", "", 1), "model"},
		{"an Ollama with no address", strings.Replace(smelterDocFixture, "baseURL = \"http://${OLLAMA_HOST}:11434\"\n", "", 1), "baseURL"},
		{"Voyage with no key", voyageEmbedding(), "embedding.apiKey"},
		{"a key written as a value", voyageEmbedding("apiKey = \"hunter2\"\n"), "embedding.apiKey"},
	} {
		_, err := smelterDocument(envFrom(t, c.config), "container", "192.168.64.1", 8080, nil)
		if err == nil || !strings.Contains(err.Error(), c.names) {
			t.Errorf("%s: err = %v, want a refusal naming %q", c.why, err, c.names)
		}
		if err != nil && strings.Contains(err.Error(), "hunter2") {
			t.Errorf("%s: the refusal repeats the key: %v", c.why, err)
		}
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and the anchored-text store
// where the document says it is. It hands the Smelter nothing else: no copy
// of the KB's config, no path, and no *_HOST variables, because the document
// already carries every address and the store's directory. Its health port is
// the descriptor's, which the document carries, the launcher publishes and
// the image probes.
func TestSmelterDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "smelter", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := smelterDocument(envFrom(t, smelterDocFixture), "container", "1.2.3.4", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := smelterDocumentFrom(t, b)

	args := strings.Join(smelterArgs("/stage", "container", "1.2.3.4", "client-secret", "v", semiontDescriptor("smelter").mem, []string{"--env", "VOYAGE_API_KEY"}, nil,
		"-v", "/state/anchored-text:"+stateStores["anchored-text"].mounts[0].target), " ")
	if want := "/stage/" + smelterDocumentFile + ":" + smelterDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Smelter's document is not mounted onto %s:\n%s", smelterDocumentTarget, args)
	}
	if want := "-v /state/anchored-text:" + doc.AnchoredTextDir + " "; !strings.Contains(args, want) {
		t.Errorf("the anchored-text store is not mounted onto %s, where the Smelter's document says it is:\n%s", doc.AnchoredTextDir, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "QDRANT_HOST", "OLLAMA_HOST", "KEYCLOAK_HOST", ".semiontconfig", ".toml"} {
		if strings.Contains(args, unread) {
			t.Errorf("the Smelter is handed %s, which it does not read:\n%s", unread, args)
		}
	}
	for _, handed := range []string{"SEMIONT_OIDC_CLIENT_ID=" + serviceClientID("smelter"), "SEMIONT_OIDC_CLIENT_SECRET=client-secret", "--env VOYAGE_API_KEY"} {
		if !strings.Contains(args, handed) {
			t.Errorf("the Smelter is not handed %s:\n%s", handed, args)
		}
	}

	port := fmt.Sprint(doc.Port)
	if want := "--publish " + port + ":" + port; !strings.Contains(args, want) {
		t.Errorf("the Smelter's health port is not published (%s):\n%s", want, args)
	}
	for label, re := range map[string]*regexp.Regexp{
		"EXPOSE":          regexp.MustCompile(`(?m)^EXPOSE (\d+)`),
		"HEALTHCHECK":     regexp.MustCompile(`localhost:(\d+)/health`),
		"SUPERVISE_PROBE": regexp.MustCompile(`SUPERVISE_PROBE=http://localhost:(\d+)/health`),
	} {
		if m := re.FindSubmatch(df); m == nil || string(m[1]) != port {
			t.Errorf("the smelter image's %s disagrees with the port its document carries, %s", label, port)
		}
	}
}

// A start hands the Smelter the variable its document names and no other: it
// reads no [graph] and no [inference], so neither the launcher's Neo4j
// password nor a model provider's key reaches it.
func TestTheSmelterIsHandedOnlyWhatItsDocumentNames(t *testing.T) {
	config := voyageEmbedding("apiKey = \"${VOYAGE_API_KEY}\"\n") +
		"\n[environments.local.inference.anthropic]\nplatform = \"external\"\napiKey = \"${ANTHROPIC_API_KEY}\"\n"
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, refs, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	plan := &launchPlan{Roles: map[string]rolePlan{"graph": {Presence: presenceLauncher}, "messaging": {Presence: presenceLauncher}}}
	handed := withDaemonCredentialVars(refs.ByService, plan, true)["smelter"]
	if len(handed) != 1 || handed[0] != "VOYAGE_API_KEY" {
		t.Errorf("the Smelter is handed %v, want the one variable its document names", handed)
	}
	required, _ := refs.read("smelter")
	if len(required) != 1 || required[0] != "VOYAGE_API_KEY" {
		t.Errorf("a start of the Smelter alone demands %v, want the one variable its document names", required)
	}
}
