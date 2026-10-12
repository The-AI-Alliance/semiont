package launcher

// librariandoc.go — the Librarian's configuration document: LibrarianConfig in
// specs/, the Go type generated from it (packages/sdk-go). The launcher writes
// it for the Librarian it starts, resolved — every ${VAR} a value, and every
// number the KB's config leaves unstated written — and mounts it where the
// Librarian's image points its `--config` flag, so the Librarian neither
// parses TOML nor resolves or defaults anything. A secret is never a value in
// it: the graph database's password, the embedding provider's key and each
// model provider's key are named by the variable that holds them.

import (
	"encoding/json"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// librarianDocumentFile: the Librarian is configured by a document, not a copy
// of the KB's config. One name, staged and mounted.
const librarianDocumentFile = "librarian.json"

// librarianDocumentTarget: where the Librarian reads that document — the path
// its image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook
// holds the two together.
const librarianDocumentTarget = "/etc/semiont/librarian.json"

// unstatedBounds: the two bounds the Librarian answers within, each written
// where the KB's config does not state it: how long a gather waits for the
// Smelter, in milliseconds, and the least similarity a hit by meaning must
// have. The launcher is the one decider: the Librarian defaults nothing.
var unstatedBounds = struct {
	settleTimeoutMs int
	semanticFloor   float32
}{settleTimeoutMs: 15_000, semanticFloor: 0.6}

// librarianActors: the two actors the Librarian works as, each asking a model
// of its own.
var librarianActors = []string{"matcher", "gatherer"}

// librarianModel: the model one actor asks, as the Librarian's document states
// it. Who serves the actor is `actors.<actor>`, and nothing else: the binding
// the Archivist's roster names (archivistRoster). Where its provider is
// reached and which variable holds its key are decided as a worker's agent's
// are (providerAddress, providerKeyName). An actor the environment binds no
// model to is refused: the Librarian cannot start without both.
func librarianModel(env *envConfig, envName, actor string, vars map[string]string) (model semiont.LibrarianModelConfig, err error) {
	role, err := rosterRole("actors."+actor, binding(env.Actors, actor))
	if err != nil {
		return model, err
	}
	if role == nil {
		return model, fmt.Errorf("the environment binds no model to the %s: the Librarian has no model to ask — add [environments.%s.actors.%s.inference] with type = \"anthropic\" or \"ollama\" and a model", actor, envName, actor)
	}
	model.Agent = *role
	if model.BaseUrl, err = providerAddress(env, envName, role.Provider, vars, "the Librarian"); err != nil {
		return model, err
	}
	model.ApiKeyEnv, err = providerKeyName(env, role.Provider)
	return model, err
}

// librarianNamedVars: the variables the Librarian's document names rather than
// resolves — the graph database's password, where the KB config references
// one; Voyage's key, where Voyage makes the vectors; and the key of each
// provider an actor asks — and so the ones the Librarian is handed. A Neo4j
// the launcher runs states no password in the config: its variable is the
// launcher's own, added with the other daemon credentials
// (withDaemonCredentialVars). A credential that is not exactly ${NAME} names
// nothing here; writing the document refuses it.
func librarianNamedVars(env *envConfig) []string {
	var names []string
	add := func(found ...string) {
		for _, name := range found {
			if !contains(names, name) {
				names = append(names, name)
			}
		}
	}
	add(weaverNamedVars(env)...)
	add(smelterNamedVars(env)...)
	for _, actor := range librarianActors {
		role, _ := rosterRole("actors."+actor, binding(env.Actors, actor))
		if role == nil {
			continue
		}
		if name, _ := providerKeyName(env, role.Provider); name != nil {
			add(*name)
		}
	}
	return names
}

// librarianBounds: the two bounds as the document states them — the config's,
// else unstatedBounds. A bound the Librarian's contract does not admit is
// refused by its key.
func librarianBounds(env *envConfig) (settleTimeoutMs int, semanticFloor float32, err error) {
	settleTimeoutMs, semanticFloor = unstatedBounds.settleTimeoutMs, unstatedBounds.semanticFloor
	if stated := env.MakeMeaning; stated != nil {
		if stated.Gather != nil && stated.Gather.SettleTimeoutMs != nil {
			settleTimeoutMs = *stated.Gather.SettleTimeoutMs
		}
		if stated.Search != nil && stated.Search.SemanticFloor != nil {
			semanticFloor = *stated.Search.SemanticFloor
		}
	}
	if settleTimeoutMs < 1 {
		return 0, 0, fmt.Errorf("make-meaning.gather.settleTimeoutMs is %d: a gather waits at least 1 millisecond", settleTimeoutMs)
	}
	if semanticFloor < 0 || semanticFloor > 1 {
		return 0, 0, fmt.Errorf("make-meaning.search.semanticFloor is %v: a similarity is between 0 and 1", semanticFloor)
	}
	return settleTimeoutMs, semanticFloor, nil
}

// librarianDocument renders the document from the selected environment and its
// name, the knowledge base's name, the address the launcher computed, and the
// user's variables. kbName is the name the Archivist reads from the tree it
// mounts (effectiveKBName): the Archivist writes the views under it in the
// state volume, and the Librarian reads them there. The Archivist is where
// this start places it, and a hand-written archivist section wins
// (archivistAddress). The graph is the Weaver's (graphConfig), and the vector
// index and the embedding provider the Smelter's (vectorsConfig,
// embeddingConfig). graphRun says the launcher runs the graph database.
func librarianDocument(env *envConfig, envName, kbName, rt, addr string, issuerPort int, userEnv []string, graphRun bool) ([]byte, error) {
	if env.Gateway == nil || env.Gateway.PublicURL == "" {
		return nil, fmt.Errorf("the environment declares no [gateway] publicURL: the Librarian has no gateway to reach")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the Librarian has no issuer to sign in at")
	}
	if kbName == "" {
		return nil, fmt.Errorf("the knowledge base has no name: the Librarian cannot find the Archivist's views in the state volume")
	}
	vars := gatewayDialerVars(rt, addr, issuerPort, userEnv)
	var doc semiont.LibrarianConfig
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
	doc.StateHome = stateHomeTarget
	doc.KbName = kbName
	if doc.Graph, err = graphConfig(env, vars, graphRun, "the Librarian"); err != nil {
		return nil, err
	}
	if doc.Vectors, err = vectorsConfig(env, vars, "the Librarian"); err != nil {
		return nil, err
	}
	if doc.Embedding, err = embeddingConfig(env, vars, "the Librarian"); err != nil {
		return nil, err
	}
	if doc.Matcher, err = librarianModel(env, envName, "matcher", vars); err != nil {
		return nil, err
	}
	if doc.Gatherer, err = librarianModel(env, envName, "gatherer", vars); err != nil {
		return nil, err
	}
	if doc.Gather.SettleTimeoutMs, doc.Search.SemanticFloor, err = librarianBounds(env); err != nil {
		return nil, err
	}
	doc.Port = semiontDescriptor("librarian").ports[0].port

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.LogLevel(env.LogLevel)
	}
	doc.LogFormat = semiont.Json
	return json.MarshalIndent(doc, "", "  ")
}
