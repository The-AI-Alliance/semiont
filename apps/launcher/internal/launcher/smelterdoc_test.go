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

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// voyageEmbedding: st with its vectors made by Voyage's voyage-3, at Voyage's
// own address, under the key named VOYAGE_API_KEY.
func voyageEmbedding(st *stack.Stack) {
	e := &st.KnowledgeIndex.Spec.Embedding
	e.Type, e.Model, e.Endpoint = "voyage", "voyage-3", nil
	e.ApiKey = &stack.SecretRef{FromEnv: "VOYAGE_API_KEY"}
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

func smelterDocumentOf(t *testing.T, p placement) semiont.SmelterConfig {
	t.Helper()
	b, err := smelterDocument(p)
	if err != nil {
		t.Fatal(err)
	}
	return smelterDocumentFrom(t, b)
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

// Every address is the placement's, each union the one shape its `type` names,
// the numbers the KnowledgeIndex's, and the log level the KnowledgeIndex's.
func TestSmelterDocumentStatesWhatThePlacementDecides(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.KnowledgeIndex.Spec.LogLevel = semiont.LogLevelDebug
	doc := smelterDocumentOf(t, placed(t, st))
	if doc.GatewayUrl != "http://192.168.64.1:14000" {
		t.Errorf("gatewayUrl = %q, want the address this start places", doc.GatewayUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/semiont" {
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
		t.Errorf("chunking = %+v, want the KnowledgeIndex's 512 and 64", doc.Chunking)
	}
	// The anchored-text store is the Archivist's: the Smelter's document names no directory of it.
	if store := stateStores["anchored-text"]; store.owner != "archivist" || !store.unstamped {
		t.Errorf("the anchored-text store is owned by %q (unstamped %v), want the Archivist's, with no image stamp", store.owner, store.unstamped)
	}
	if doc.Port != semiontDescriptor("smelter").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.PdfsAtOnce != 1 {
		t.Errorf("pdfsAtOnce = %d, want the KnowledgeIndex's 1", doc.PdfsAtOnce)
	}
	if doc.CursorsPath != "/tmp/semiont/smelter-cursors.json" {
		t.Errorf("cursorsPath = %q, want the Smelter's file of the container's own disk", doc.CursorsPath)
	}
	if doc.LogLevel != semiont.LogLevelDebug || doc.LogFormat != semiont.LogFormatJson {
		t.Errorf("logLevel, logFormat = %q, %q, want the KnowledgeIndex's level and JSON", doc.LogLevel, doc.LogFormat)
	}
}

// The numbers the KnowledgeIndex states are the ones written, whatever the
// Smelter's ceiling would give: chunks that do not overlap, and three PDFs at
// once in a ceiling of eight gigabytes.
func TestSmelterDocumentWritesTheNumbersTheIndexStates(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	index := &st.KnowledgeIndex.Spec
	index.Embedding.Chunking.ChunkSize, index.Embedding.Chunking.Overlap = 300, 0
	index.Smelter.Resources.Limits.Memory, index.Smelter.PdfsAtOnce = "8G", 3
	doc := smelterDocumentOf(t, placed(t, st))
	if doc.Chunking.ChunkSize != 300 || doc.Chunking.Overlap != 0 {
		t.Errorf("chunking = %+v, want the stated 300 and 0", doc.Chunking)
	}
	if doc.PdfsAtOnce != 3 {
		t.Errorf("pdfsAtOnce = %d, want the stated 3", doc.PdfsAtOnce)
	}
}

// Voyage's key is named and never stated: the document names the variable the
// KnowledgeIndex names, and the Smelter is handed it. An Ollama is asked
// without a key, so its document names none. A Voyage embedding that states no
// endpoint is asked at Voyage's own.
func TestSmelterDocumentNamesVoyagesKey(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	voyageEmbedding(st)
	p := placed(t, st)
	want := semiont.VoyageEmbeddingConfig{
		Type:      semiont.VoyageEmbeddingConfigTypeVoyage,
		Model:     "voyage-3",
		Endpoint:  "https://api.voyageai.com/v1/embeddings",
		ApiKeyEnv: "VOYAGE_API_KEY",
	}
	if got := shapeOf[semiont.VoyageEmbeddingConfig](t, smelterDocumentOf(t, p).Embedding); got != want {
		t.Errorf("embedding = %+v, want %+v", got, want)
	}
	if got := embeddingSecrets(p); len(got) != 1 || got[0] != "VOYAGE_API_KEY" {
		t.Errorf("the Smelter is handed %v, want the one variable its document names", got)
	}
	if got := embeddingSecrets(placed(t, fixtureStack(t, "ollama-gemma"))); len(got) != 0 {
		t.Errorf("an embedding by Ollama names %v", got)
	}

	st = fixtureStack(t, "ollama-gemma")
	voyageEmbedding(st)
	endpoint := "https://voyage.internal/v1/embeddings"
	st.KnowledgeIndex.Spec.Embedding.Endpoint = &endpoint
	if got := shapeOf[semiont.VoyageEmbeddingConfig](t, smelterDocumentOf(t, placed(t, st)).Embedding).Endpoint; got != endpoint {
		t.Errorf("a stated endpoint is written %q, want it as the KnowledgeIndex states it", got)
	}
}

// A daemon somebody else runs is where its document states it, and the
// Smelter's document states it as written. So is an Archivist the
// KnowledgeBase places.
func TestSmelterDocumentStatesWhatSomebodyElseRunsAsWritten(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	vectors := &st.KnowledgeIndex.Spec.Vectors
	vectors.Image, vectors.Resources = nil, nil
	vectors.External = &stack.HostPort{Host: "qdrant.internal", Port: 7000}
	endpoint := "http://ollama.internal:11434"
	st.KnowledgeIndex.Spec.Embedding.Endpoint = &endpoint
	st.KnowledgeBase.Spec.Archivist.Address = &stack.HostPort{Host: "archivist.internal", Port: 9999}
	doc := smelterDocumentOf(t, placed(t, st))
	if got := shapeOf[semiont.QdrantVectorsConfig](t, doc.Vectors); got.Host != "qdrant.internal" || got.Port != 7000 {
		t.Errorf("vectors = %+v, want somebody else's Qdrant as its document states it", got)
	}
	if got := shapeOf[semiont.OllamaEmbeddingConfig](t, doc.Embedding).BaseUrl; got != endpoint {
		t.Errorf("embedding.baseUrl = %q, want somebody else's Ollama as its document states it", got)
	}
	if doc.Archivist.Host != "archivist.internal" || doc.Archivist.Port != 9999 {
		t.Errorf("archivist = %+v, want the stated address", doc.Archivist)
	}
}

// A Voyage embedding that names no key has no document: Voyage is asked with
// one, and a document carries no secret, only the variable that holds it.
func TestSmelterDocumentRefusesVoyageWithNoKey(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	voyageEmbedding(st)
	st.KnowledgeIndex.Spec.Embedding.ApiKey = nil
	_, err := smelterDocument(placed(t, st))
	if want := st.Files.KnowledgeIndex + ": spec.embedding.apiKey"; err == nil || !strings.Contains(err.Error(), want) {
		t.Errorf("err = %v, want a refusal naming %q", err, want)
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and nothing else: no store, no
// copy of the KB's documents, no path, and no *_HOST variables, because its
// own document already carries every address. Its health port is the
// descriptor's, which the document carries, the launcher publishes and the
// image probes.
func TestSmelterDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "smelter", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	doc := smelterDocumentOf(t, placed(t, fixtureStack(t, "ollama-gemma")))

	args := strings.Join(smelterArgs("/stage", "container", "1.2.3.4", "client-secret", "v", semiontDescriptor("smelter").mem, []string{"--env", "VOYAGE_API_KEY"}, nil), " ")
	if want := "/stage/" + smelterDocumentFile + ":" + smelterDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the Smelter's document is not mounted onto %s:\n%s", smelterDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "QDRANT_HOST", "OLLAMA_HOST", "KEYCLOAK_HOST", stack.Dir, anchoredTextTarget} {
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
	if want := "--publish 1.2.3.4:" + port + ":" + port; !strings.Contains(args, want) {
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
// reads no graph and no model provider, so neither the launcher's Neo4j
// password nor a provider's key reaches it.
func TestTheSmelterIsHandedOnlyWhatItsDocumentNames(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	voyageEmbedding(st)
	p := placed(t, st)
	handed := withDaemonCredentialVars(serviceSecrets(p), p.plan, true)["smelter"]
	if len(handed) != 1 || handed[0] != "VOYAGE_API_KEY" {
		t.Errorf("the Smelter is handed %v, want the one variable its document names", handed)
	}
	if required := secretsRead(p, "smelter"); len(required) != 1 || required[0] != "VOYAGE_API_KEY" {
		t.Errorf("a start of the Smelter alone demands %v, want the one variable its document names", required)
	}
}
