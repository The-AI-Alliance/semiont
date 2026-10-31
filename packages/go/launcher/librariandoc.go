package launcher

// librariandoc.go — the Librarian's configuration document: LibrarianConfig in
// specs/, the Go type generated from it (packages/go/sdk). The launcher writes
// it for the Librarian it starts, every address a literal (placement), and
// mounts it where the Librarian's image points its `--config` flag, so the
// Librarian neither reads a knowledge base's documents nor resolves or
// defaults anything. A secret is never a value in it: the graph database's
// password, the embedding provider's key and each model provider's key are
// named by the variable that holds them.

import (
	"encoding/json"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// librarianDocumentFile: the Librarian is configured by a document, not a copy
// of the KB's. One name, staged and mounted.
const librarianDocumentFile = "librarian.json"

// librarianDocumentTarget: where the Librarian reads that document — the path
// its image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook
// holds the two together.
const librarianDocumentTarget = "/etc/semiont/librarian.json"

// librarianActors: the two actors the Librarian works as, each asking an
// engine of its own, with where the engines give each one.
var librarianActors = []struct {
	name   string
	engine func(api.ArchivistEngines) *api.Engine
}{
	{"matcher", func(e api.ArchivistEngines) *api.Engine { return e.Actors.Matcher }},
	{"gatherer", func(e api.ArchivistEngines) *api.Engine { return e.Actors.Gatherer }},
}

// librarianEngine: the engine one actor asks, as the Librarian's document
// states it. The actor's engine is the engines' `actors.<actor>`, and nothing
// else: the one the Archivist's engines name. Where its provider is reached
// and which variable holds its key are decided as the worker's engines' are
// (providerAddress, providerKeyName). An actor given no engine is refused: the
// Librarian cannot start without both.
func librarianEngine(p placement, actor string, engine *api.Engine) (config api.LibrarianEngineConfig, err error) {
	if engine == nil {
		return config, planErr(p.st.Files.Inference, "spec.engines.actors."+actor, "is not stated: the Librarian has no engine to ask — give it a provider and a model")
	}
	config.Engine = *engine
	config.ApiKeyEnv = providerKeyName(p, engine.Provider)
	config.BaseUrl, err = providerAddress(p, engine.Provider, "the Librarian")
	return config, err
}

// librarianSecrets: the variables the Librarian's document names, and so the
// ones it is handed — the graph database's password, where somebody else runs
// it; Voyage's key, where Voyage makes the vectors; and the key of each
// provider an actor's engine names.
func librarianSecrets(p placement) []string {
	var names []string
	add := func(found ...string) {
		for _, name := range found {
			if !contains(names, name) {
				names = append(names, name)
			}
		}
	}
	add(graphSecrets(p)...)
	add(embeddingSecrets(p)...)
	for _, actor := range librarianActors {
		if engine := actor.engine(p.st.Inference.Spec.Engines); engine != nil {
			if name := providerKeyName(p, engine.Provider); name != nil {
				add(*name)
			}
		}
	}
	return names
}

// librarianDocument renders the document from the start's placement and the
// knowledge base it serves. The graph is the Weaver's (graphConfig), and the
// vector index and the embedding provider the Smelter's (vectorsConfig,
// embeddingConfig).
func librarianDocument(p placement, served api.KbIdentity) ([]byte, error) {
	index := p.st.KnowledgeIndex.Spec
	var doc api.LibrarianConfig
	var err error
	doc.Kb = served
	doc.GatewayUrl = p.gatewayURL()
	doc.Identity.Issuer = p.issuer()
	doc.Archivist.Host, doc.Archivist.Port = p.archivist()
	if doc.Graph, err = graphConfig(p, "the Librarian"); err != nil {
		return nil, err
	}
	if doc.Vectors, err = vectorsConfig(p, "the Librarian"); err != nil {
		return nil, err
	}
	if doc.Embedding, err = embeddingConfig(p, "the Librarian"); err != nil {
		return nil, err
	}
	engines := p.st.Inference.Spec.Engines
	if doc.Matcher, err = librarianEngine(p, "matcher", engines.Actors.Matcher); err != nil {
		return nil, err
	}
	if doc.Gatherer, err = librarianEngine(p, "gatherer", engines.Actors.Gatherer); err != nil {
		return nil, err
	}
	doc.ModelCatalogue = modelCatalogueTarget
	doc.Gather.SettleTimeoutMs = index.Librarian.Gather.SettleTimeoutMs
	doc.Search.SemanticFloor = index.Librarian.Search.SemanticFloor
	doc.Port = semiontDescriptor("librarian").ports[0].port
	doc.LogLevel = index.LogLevel
	doc.LogFormat = api.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
