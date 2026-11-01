package launcher

// smelterdoc.go — the Smelter's configuration document: SmelterConfig in
// specs/, the Go type generated from it (packages/go/sdk). The launcher writes
// it for the Smelter it starts, every address a literal (placement), and
// mounts it where the Smelter's image points its `--config` flag, so the
// Smelter neither reads a knowledge base's documents nor resolves or defaults
// anything. A secret is never a value in it: Voyage's key is a variable the
// KnowledgeIndex names (`fromEnv`), and the document names it.

import (
	"encoding/json"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// smelterDocumentFile: the Smelter is configured by a document, not a copy of
// the KB's. One name, staged and mounted.
const smelterDocumentFile = "smelter.json"

// smelterDocumentTarget: where the Smelter reads that document — the path its
// image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook holds
// the two together.
const smelterDocumentTarget = "/etc/semiont/smelter.json"

// voyageHost: where Voyage AI's API is. ONE statement: it is the address of
// the plan's embedding role (derivePlan), and where the Smelter's document
// asks when the KnowledgeIndex states no endpoint.
const voyageHost = "api.voyageai.com"

// voyageEmbeddingsEndpoint: the whole address of Voyage's embeddings call.
const voyageEmbeddingsEndpoint = "https://" + voyageHost + "/v1/embeddings"

// embeddingSecrets: the variables a document asking for vectors names, and so
// the ones its service is handed — Voyage's key, where Voyage makes the
// vectors. An Ollama is asked without a key.
func embeddingSecrets(p placement) []string {
	if key := p.st.KnowledgeIndex.Spec.Embedding.ApiKey; key != nil {
		return []string{key.FromEnv}
	}
	return nil
}

// embeddingConfig: the provider a service asks for vectors, as its document
// states it. ONE decider, for the Smelter's document and the Librarian's: a
// vector is compared only with vectors of the model that made it. who names
// the service in a refusal. An ollama embedding that states no endpoint is
// the shared Ollama, at this start's address; a voyage one that states
// none is asked at Voyage's own.
func embeddingConfig(p placement, who string) (embedding api.EmbeddingConfig, err error) {
	e := p.st.KnowledgeIndex.Spec.Embedding
	switch e.Type {
	case string(api.OllamaEmbeddingConfigTypeOllama):
		err = embedding.FromOllamaEmbeddingConfig(api.OllamaEmbeddingConfig{Model: e.Model, BaseUrl: p.ollama(e.Endpoint)})
	case string(api.VoyageEmbeddingConfigTypeVoyage):
		voyage := api.VoyageEmbeddingConfig{Model: e.Model, Endpoint: voyageEmbeddingsEndpoint}
		if e.Endpoint != nil {
			voyage.Endpoint = *e.Endpoint
		}
		if e.ApiKey == nil {
			return embedding, planErr(p.st.Files.KnowledgeIndex, "spec.embedding.apiKey", "is not stated: name the variable that holds Voyage's key ({ fromEnv: NAME }), and %s's document names it", who)
		}
		voyage.ApiKeyEnv = e.ApiKey.FromEnv
		err = embedding.FromVoyageEmbeddingConfig(voyage)
	default:
		err = planErr(p.st.Files.KnowledgeIndex, "spec.embedding.type", "is %q: the launcher writes %s's document for an ollama or a voyage embedding alone", e.Type, who)
	}
	return embedding, err
}

// vectorsConfig: the vector index a service reaches, as its document states
// it. ONE decider, for the Smelter's document, which writes the index, and the
// Librarian's, which searches it. who names the service in a refusal.
func vectorsConfig(p placement, who string) (vectors api.VectorsConfig, err error) {
	v := p.st.KnowledgeIndex.Spec.Vectors
	if v.Type != string(api.QdrantVectorsConfigTypeQdrant) {
		return vectors, planErr(p.st.Files.KnowledgeIndex, "spec.vectors.type", "is %q: the launcher writes %s's document for a qdrant index alone", v.Type, who)
	}
	var qdrant api.QdrantVectorsConfig
	qdrant.Host, qdrant.Port = p.vectors()
	err = vectors.FromQdrantVectorsConfig(qdrant)
	return vectors, err
}

// smelterDocument renders the document from the start's placement and the
// knowledge base it serves. The Smelter keeps the anchored-text store at the
// Archivist (placement).
func smelterDocument(p placement, served api.KbIdentity) ([]byte, error) {
	index := p.st.KnowledgeIndex.Spec
	var doc api.SmelterConfig
	var err error
	doc.Kb = served
	doc.GatewayUrl = p.gatewayURL()
	doc.Identity.Issuer = p.issuer()
	doc.Archivist.Host, doc.Archivist.Port = p.archivist()
	if doc.Embedding, err = embeddingConfig(p, "the Smelter"); err != nil {
		return nil, err
	}
	if doc.Vectors, err = vectorsConfig(p, "the Smelter"); err != nil {
		return nil, err
	}
	doc.Chunking.ChunkSize, doc.Chunking.Overlap = index.Embedding.Chunking.ChunkSize, index.Embedding.Chunking.Overlap
	doc.PdfsAtOnce = index.Smelter.PdfsAtOnce
	doc.CursorsPath = cursorsPath("smelter")
	doc.Port = semiontDescriptor("smelter").ports[0].port
	doc.LogLevel = index.LogLevel
	doc.LogFormat = api.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
