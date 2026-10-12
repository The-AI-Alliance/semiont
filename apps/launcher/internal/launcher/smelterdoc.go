package launcher

// smelterdoc.go — the Smelter's configuration document: SmelterConfig in
// specs/, the Go type generated from it (packages/sdk-go). The launcher writes
// it for the Smelter it starts, resolved — every ${VAR} a value, and every
// number the KB's config leaves unstated written — and mounts it where the
// Smelter's image points its `--config` flag, so the Smelter neither parses
// TOML nor resolves or defaults anything. A secret is never a value in it:
// Voyage's key is a ${NAME} in the KB config, and the document names NAME.

import (
	"encoding/json"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// smelterDocumentFile: the Smelter is configured by a document, not a copy of
// the KB's config. One name, staged and mounted.
const smelterDocumentFile = "smelter.json"

// smelterDocumentTarget: where the Smelter reads that document — the path its
// image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook holds
// the two together.
const smelterDocumentTarget = "/etc/semiont/smelter.json"

// voyageHost: where Voyage AI's API is. ONE statement: it is the address of
// the plan's embedding role (derivePlan), and where the Smelter's document
// asks when the KB's config states no endpoint.
const voyageHost = "api.voyageai.com"

// voyageEmbeddingsEndpoint: the whole address of Voyage's embeddings call.
const voyageEmbeddingsEndpoint = "https://" + voyageHost + "/v1/embeddings"

// unstatedChunking: the two numbers a text is cut by before it is embedded,
// in tokens, each written where the KB's config does not state it. The
// launcher is the one decider: the Smelter defaults nothing.
var unstatedChunking = struct{ chunkSize, overlap int }{chunkSize: 512, overlap: 64}

// smelterNamedVars: the variables the Smelter's document names rather than
// resolves — Voyage's key, where Voyage makes the vectors — and so the ones
// the Smelter is handed. An Ollama is asked without a key. A key that is not
// exactly ${NAME} names nothing here; writing the document refuses it.
func smelterNamedVars(env *envConfig) []string {
	if env.Embedding == nil || env.Embedding.Type != string(semiont.Voyage) {
		return nil
	}
	if name, _ := secretName("embedding.apiKey", env.Embedding.APIKey); name != nil {
		return []string{*name}
	}
	return nil
}

// smelterEmbedding: the provider the Smelter asks for vectors, as its
// document states it. An Ollama the launcher places states no baseURL in the
// KB config, and loadConfig reads it as the launcher's own reference
// (topology.go), which resolves here to the address of this start. A Voyage
// section that states no endpoint is asked at Voyage's own.
func smelterEmbedding(env *envConfig, vars map[string]string) (embedding semiont.EmbeddingConfig, err error) {
	e := env.Embedding
	if e == nil {
		return embedding, fmt.Errorf("the environment declares no [embedding]: the Smelter has no provider to ask for vectors")
	}
	if e.Model == "" {
		return embedding, fmt.Errorf("[embedding] states no model: the Smelter has no model to ask for vectors")
	}
	switch e.Type {
	case string(semiont.OllamaEmbeddingConfigTypeOllama):
		if e.BaseURL == "" {
			return embedding, fmt.Errorf("[embedding] states no baseURL: the Smelter has no address to reach Ollama at")
		}
		ollama := semiont.OllamaEmbeddingConfig{Model: e.Model}
		if ollama.BaseUrl, err = resolveRefs("embedding.baseURL", e.BaseURL, vars); err != nil {
			return embedding, err
		}
		err = embedding.FromOllamaEmbeddingConfig(ollama)
	case string(semiont.Voyage):
		voyage := semiont.VoyageEmbeddingConfig{Model: e.Model, Endpoint: voyageEmbeddingsEndpoint}
		if e.Endpoint != "" {
			if voyage.Endpoint, err = resolveRefs("embedding.endpoint", e.Endpoint, vars); err != nil {
				return embedding, err
			}
		}
		var name *string
		if name, err = secretName("embedding.apiKey", e.APIKey); err != nil {
			return embedding, err
		}
		if name == nil {
			return embedding, fmt.Errorf("[embedding] states no apiKey: write embedding.apiKey = \"${NAME}\", and the Smelter's document names the variable that holds Voyage's key")
		}
		voyage.ApiKeyEnv = *name
		err = embedding.FromVoyageEmbeddingConfig(voyage)
	default:
		err = fmt.Errorf("[embedding] type %q: the launcher writes the Smelter's document for an ollama or a voyage embedding alone", e.Type)
	}
	return embedding, err
}

// smelterVectors: the vector index the Smelter writes, as its document states
// it. A Qdrant the launcher places states no address in the KB config, and
// loadConfig reads it as the launcher's own reference (topology.go), which
// resolves here to the address of this start. A section that states no port
// is reached on Qdrant's own.
func smelterVectors(env *envConfig, vars map[string]string) (vectors semiont.VectorsConfig, err error) {
	v := env.Vectors
	if v == nil {
		return vectors, fmt.Errorf("the environment declares no [vectors]: the Smelter has no vector index to write")
	}
	if v.Type != string(semiont.Qdrant) {
		return vectors, fmt.Errorf("[vectors] type %q: the launcher writes the Smelter's document for a qdrant index alone", v.Type)
	}
	if v.Host == "" {
		return vectors, fmt.Errorf("[vectors] states no host: the Smelter has no address to reach Qdrant at")
	}
	qdrant := semiont.QdrantVectorsConfig{Port: v.Port}
	if qdrant.Port == 0 {
		qdrant.Port = descriptorFor("vectors", "qdrant").defaultPort
	}
	if qdrant.Host, err = resolveRefs("vectors.host", v.Host, vars); err != nil {
		return vectors, err
	}
	err = vectors.FromQdrantVectorsConfig(qdrant)
	return vectors, err
}

// smelterDocument renders the document from the selected environment, the
// address the launcher computed, and the user's variables. The Archivist is
// where this start places it, and a hand-written archivist section wins
// (archivistAddress). The anchored-text store is where the launcher mounts it
// (flowSidecar).
func smelterDocument(env *envConfig, rt, addr string, issuerPort int, userEnv []string) ([]byte, error) {
	if env.Gateway == nil || env.Gateway.PublicURL == "" {
		return nil, fmt.Errorf("the environment declares no [gateway] publicURL: the Smelter has no gateway to reach")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the Smelter has no issuer to sign in at")
	}
	vars := gatewayDialerVars(rt, addr, issuerPort, userEnv)
	var doc semiont.SmelterConfig
	var err error
	if doc.GatewayUrl, err = resolveRefs("gateway.publicURL", env.Gateway.PublicURL, vars); err != nil {
		return nil, err
	}
	if doc.Identity.Issuer, err = resolveRefs("identity.issuer", env.Identity.Issuer, vars); err != nil {
		return nil, err
	}
	if doc.Archivist.Host, doc.Archivist.Port, err = archivistAddress(env, addr, vars); err != nil {
		return nil, err
	}
	if doc.Embedding, err = smelterEmbedding(env, vars); err != nil {
		return nil, err
	}
	if doc.Vectors, err = smelterVectors(env, vars); err != nil {
		return nil, err
	}
	doc.Chunking.ChunkSize, doc.Chunking.Overlap = unstatedChunking.chunkSize, unstatedChunking.overlap
	if stated := env.Embedding.Chunking; stated != nil {
		if stated.ChunkSize != nil {
			doc.Chunking.ChunkSize = *stated.ChunkSize
		}
		if stated.Overlap != nil {
			doc.Chunking.Overlap = *stated.Overlap
		}
	}
	doc.AnchoredTextDir = anchoredTextTarget
	doc.Port = semiontDescriptor("smelter").ports[0].port

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.LogLevel(env.LogLevel)
	}
	doc.LogFormat = semiont.Json
	return json.MarshalIndent(doc, "", "  ")
}
