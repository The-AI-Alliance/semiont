package launcher

// librariandoc.go — the Librarian's configuration document: LibrarianConfig in
// specs/, the Go type generated from it (packages/sdk-go). The launcher writes
// it for the Librarian it starts, every address a literal (placement), and
// mounts it where the Librarian's image points its `--config` flag, so the
// Librarian neither reads a knowledge base's documents nor resolves or
// defaults anything. A secret is never a value in it: the graph database's
// password, the embedding provider's key and each model provider's key are
// named by the variable that holds them.

import (
	"encoding/json"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// librarianDocumentFile: the Librarian is configured by a document, not a copy
// of the KB's. One name, staged and mounted.
const librarianDocumentFile = "librarian.json"

// librarianDocumentTarget: where the Librarian reads that document — the path
// its image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook
// holds the two together.
const librarianDocumentTarget = "/etc/semiont/librarian.json"

// librarianActors: the two actors the Librarian works as, each asking a model
// of its own, with where the roster binds each.
var librarianActors = []struct {
	name string
	role func(api.ArchivistRoster) *api.ArchivistRosterRole
}{
	{"matcher", func(r api.ArchivistRoster) *api.ArchivistRosterRole { return r.Actors.Matcher }},
	{"gatherer", func(r api.ArchivistRoster) *api.ArchivistRosterRole { return r.Actors.Gatherer }},
}

// librarianModel: the model one actor asks, as the Librarian's document states
// it. Who serves the actor is the roster's `actors.<actor>`, and nothing else:
// the binding the Archivist's roster names. Where its provider is reached and
// which variable holds its key are decided as a worker's agent's are
// (providerAddress, providerKeyName). An actor the roster binds no model to is
// refused: the Librarian cannot start without both.
func librarianModel(p placement, actor string, bound *api.ArchivistRosterRole) (model api.LibrarianModelConfig, err error) {
	if bound == nil {
		return model, planErr(p.st.Files.Inference, "spec.roster.actors."+actor, "is not bound: the Librarian has no model to ask — bind a provider and a model")
	}
	model.Agent = *bound
	model.ApiKeyEnv = providerKeyName(p, bound.Provider)
	model.BaseUrl, err = providerAddress(p, bound.Provider, "the Librarian")
	return model, err
}

// librarianSecrets: the variables the Librarian's document names, and so the
// ones it is handed — the graph database's password, where somebody else runs
// it; Voyage's key, where Voyage makes the vectors; and the key of each
// provider an actor asks.
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
		if bound := actor.role(p.st.Inference.Spec.Roster); bound != nil {
			if name := providerKeyName(p, bound.Provider); name != nil {
				add(*name)
			}
		}
	}
	return names
}

// librarianDocument renders the document from the start's placement. The
// graph is the Weaver's (graphConfig), and the vector index and the embedding
// provider the Smelter's (vectorsConfig, embeddingConfig).
func librarianDocument(p placement) ([]byte, error) {
	index := p.st.KnowledgeIndex.Spec
	var doc api.LibrarianConfig
	var err error
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
	roster := p.st.Inference.Spec.Roster
	if doc.Matcher, err = librarianModel(p, "matcher", roster.Actors.Matcher); err != nil {
		return nil, err
	}
	if doc.Gatherer, err = librarianModel(p, "gatherer", roster.Actors.Gatherer); err != nil {
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
