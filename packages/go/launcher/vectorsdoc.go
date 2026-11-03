package launcher

// vectorsdoc.go — the vector store's document: the Qdrant the launcher runs
// for every knowledge base here that names `shared`, each knowledge base's
// index in collections of its own, and the port it is published on. It
// belongs to no knowledge base, so its document is one of the state home's
// (statehomedoc.go).

import "github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"

// sharedVectorStorePort: where the catalog publishes the machine's Qdrant.
// A port block places a knowledge base's own Qdrant at 6333 and every tenth
// port above it, so 6333 is block 0's; 6334 is Qdrant's gRPC port and 6335
// its cluster port, which a reader would take this one for.
const sharedVectorStorePort = 6330

// vectorStoreDocumentPath: where the vector store's document is.
func vectorStoreDocumentPath() string {
	return stateHomeDocumentPath(stack.VectorStoreFile)
}

// vectorStoreDocument: the vector store's document as a command read it.
type vectorStoreDocument struct {
	path string
	spec stack.VectorStoreSpec
	// fromCatalog: there was no document. This command wrote the catalog's,
	// or, in a dry run, plans with what a start would write.
	fromCatalog bool
}

// catalogVectorStore: the vector store's document as the launcher writes it,
// from its catalog.
func catalogVectorStore() stack.VectorStore {
	qdrant := descriptorFor("vectors", "qdrant")
	return stack.VectorStore{
		ApiVersion: stack.APIVersion,
		Kind:       "VectorStore",
		Metadata:   stack.Metadata{Name: "vectors"},
		Spec: stack.VectorStoreSpec{
			Type:      "qdrant",
			Image:     qdrant.image,
			Resources: limits(qdrant.mem),
			Port:      sharedVectorStorePort,
		},
	}
}

// loadVectorStoreDocument: the vector store's document, written from the
// catalog first when there is none, unless preview (a dry run), which writes
// nothing.
func loadVectorStoreDocument(preview bool) (vectorStoreDocument, error) {
	read, path, fromCatalog, err := loadStateHomeDocument(stack.VectorStoreFile, "VectorStore", "the vector store's", catalogVectorStore(), preview)
	return vectorStoreDocument{path: path, spec: read.Spec, fromCatalog: fromCatalog}, err
}

// readVectorStoreDocument: loadVectorStoreDocument for a command, which says
// where it wrote one and refuses one that does not hold.
func readVectorStoreDocument(u *UI, preview bool) (vectorStoreDocument, bool) {
	doc, err := loadVectorStoreDocument(preview)
	return doc, reportStateHomeDocument(u, "VectorStore", "the image, memory or port", doc.path, doc.fromCatalog, preview, err)
}

// vectorStoreOf: the vector store's document for a knowledge base whose stack
// is st — read when it names the shared vector store, and nil when its
// vector store is its own or somebody else's.
func vectorStoreOf(u *UI, st *stack.Stack, preview bool) (*vectorStoreDocument, bool) {
	if st.KnowledgeIndex.Spec.Vectors.Shared == nil {
		return nil, true
	}
	doc, ok := readVectorStoreDocument(u, preview)
	return &doc, ok
}
