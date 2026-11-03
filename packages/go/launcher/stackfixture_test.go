package launcher

import (
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// fixtureRoot: the fixture knowledge base the launcher's tests read.
var fixtureRoot = filepath.Join("testdata", "kb")

// exampleKB: the knowledge base a document writer under test is handed, as a
// start hands it (kbRoot.served).
var exampleKB = api.KbIdentity{Name: "Example KB", Domain: "example.github.io:example-kb"}

// fixtureKB: the fixture knowledge base as a start resolves it, with the
// identity its config states. Its key is the realm its Keycloak keeps it in.
func fixtureKB(t *testing.T) kbRoot {
	t.Helper()
	ident, err := readKBIdentity(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	return kbRoot{dir: fixtureRoot, ident: ident}
}

// fixtureStack: the fixture knowledge base's documents, with the Inference
// document named inference ("anthropic" or "ollama-gemma"), read as a start
// reads them. Each call is a fresh copy, for a test to change before it plans
// or places it.
func fixtureStack(t *testing.T, inference string) *stack.Stack {
	t.Helper()
	st, err := stack.Load(fixtureRoot, inference)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// fixtureIssuer: the issuer's document the launcher's tests plan with,
// testdata/issuer.yaml, read as a start reads the state home's. Each call is
// a fresh copy, for a test to change before it plans.
func fixtureIssuer(t *testing.T) *issuerDocument {
	t.Helper()
	path := filepath.Join("testdata", stack.IssuerFile)
	read, err := stack.Read[stack.Issuer](path, "Issuer")
	if err != nil {
		t.Fatal(err)
	}
	return &issuerDocument{path: path, spec: read.Spec}
}

// issuerFor: the issuer's document a start plans st with — the fixture's when
// st names the shared issuer, and none when it trusts somebody else's.
func issuerFor(t *testing.T, st *stack.Stack) *issuerDocument {
	t.Helper()
	if st.KnowledgeBase.Spec.Issuer.Shared == nil {
		return nil
	}
	return fixtureIssuer(t)
}

// fixtureVectorStore: the vector store's document the launcher's tests plan
// with, testdata/vectors.yaml, read as a start reads the state home's. Each
// call is a fresh copy, for a test to change before it plans.
func fixtureVectorStore(t *testing.T) *vectorStoreDocument {
	t.Helper()
	path := filepath.Join("testdata", stack.VectorStoreFile)
	read, err := stack.Read[stack.VectorStore](path, "VectorStore")
	if err != nil {
		t.Fatal(err)
	}
	return &vectorStoreDocument{path: path, spec: read.Spec}
}

// vectorStoreFor: the vector store's document a start plans st with — the
// fixture's when st names the shared vector store, and none when its vector
// store is its own or somebody else's.
func vectorStoreFor(t *testing.T, st *stack.Stack) *vectorStoreDocument {
	t.Helper()
	if st.KnowledgeIndex.Spec.Vectors.Shared == nil {
		return nil
	}
	return fixtureVectorStore(t)
}

// ownVectors: st running a Qdrant of its own, at the catalog's image and
// memory, rather than the machine's.
func ownVectors(st *stack.Stack) {
	qdrant := descriptorFor("vectors", "qdrant")
	resources := limits(qdrant.mem)
	st.KnowledgeIndex.Spec.Vectors = stack.KnowledgeIndexVectors{Type: "qdrant", Image: &qdrant.image, Resources: &resources}
}

// placed: a start's placement of st — the plan derivePlan makes of it, its
// worker run as the catalog's worker document says, on the runtime and at the
// host address the scenarios use.
func placed(t *testing.T, st *stack.Stack) placement {
	t.Helper()
	return placement{st: st, plan: mustPlan(t, st), rt: "container", addr: "192.168.64.1"}
}

// catalogWorkerPoolDocument: the worker's document as the launcher writes it,
// read.
var catalogWorkerPoolDocument = workerPoolDocument{spec: catalogWorkerPool().Spec}

// The fixture knowledge base's stack documents, and the issuer's document the
// tests plan with, name every container's image and memory, as a knowledge
// base's documents and the state home's do, and they name the
// launcher's own: each daemon at its descriptor's image (the broker's, which
// TestBrokerPairIsReadByTheLaunchedBrokersParser holds to go.mod), each
// Semiont service at latest, and each at its descriptor's memory. A copy of a
// pin nothing moves is refused by lint:nats-version; this is what moves it.
func TestTheFixtureStackNamesTheDescriptorsImages(t *testing.T) {
	dir := filepath.Join(fixtureRoot, ".semiont", "stack")
	kb, err := stack.Read[stack.KnowledgeBase](filepath.Join(dir, "knowledge-base.yaml"), "KnowledgeBase")
	if err != nil {
		t.Fatal(err)
	}
	index, err := stack.Read[stack.KnowledgeIndex](filepath.Join(dir, "index.yaml"), "KnowledgeIndex")
	if err != nil {
		t.Fatal(err)
	}
	issuer, vectors := fixtureIssuer(t), fixtureVectorStore(t)
	if kb.Spec.Messaging.Image == nil || kb.Spec.Messaging.Resources == nil || index.Spec.Graph.Image == nil || index.Spec.Graph.Resources == nil ||
		index.Spec.Vectors.Shared == nil || issuer.spec.Database.Image == nil || issuer.spec.Database.Resources == nil {
		t.Fatal("the fixture runs every daemon itself, its vector store the machine's, so each states its image and its resources")
	}

	for _, c := range []struct {
		what               string
		image, memory      string
		wantImage, wantMem string
	}{
		{"the gateway", kb.Spec.Gateway.Image, kb.Spec.Gateway.Resources.Limits.Memory, semiontImage("gateway", "latest"), semiontDescriptor("gateway").mem},
		{"the dispatcher", kb.Spec.Dispatcher.Image, kb.Spec.Dispatcher.Resources.Limits.Memory, semiontImage("dispatcher", "latest"), semiontDescriptor("dispatcher").mem},
		{"the archivist", kb.Spec.Archivist.Image, kb.Spec.Archivist.Resources.Limits.Memory, semiontImage("archivist", "latest"), semiontDescriptor("archivist").mem},
		{"the librarian", index.Spec.Librarian.Image, index.Spec.Librarian.Resources.Limits.Memory, semiontImage("librarian", "latest"), semiontDescriptor("librarian").mem},
		{"the smelter", index.Spec.Smelter.Image, index.Spec.Smelter.Resources.Limits.Memory, semiontImage("smelter", "latest"), semiontDescriptor("smelter").mem},
		{"the weaver", index.Spec.Weaver.Image, index.Spec.Weaver.Resources.Limits.Memory, semiontImage("weaver", "latest"), semiontDescriptor("weaver").mem},
		{"the broker", *kb.Spec.Messaging.Image, kb.Spec.Messaging.Resources.Limits.Memory, descriptorFor("messaging", "jetstream").image, descriptorFor("messaging", "jetstream").mem},
		{"the graph store", *index.Spec.Graph.Image, index.Spec.Graph.Resources.Limits.Memory, descriptorFor("graph", "neo4j").image, descriptorFor("graph", "neo4j").mem},
		{"the vector store", vectors.spec.Image, vectors.spec.Resources.Limits.Memory, descriptorFor("vectors", "qdrant").image, descriptorFor("vectors", "qdrant").mem},
		{"the issuer", issuer.spec.Image, issuer.spec.Resources.Limits.Memory, descriptorFor("identity", "keycloak").image, descriptorFor("identity", "keycloak").mem},
		{"the issuer's database", *issuer.spec.Database.Image, issuer.spec.Database.Resources.Limits.Memory, descriptorFor("identity-store", "postgres").image, descriptorFor("identity-store", "postgres").mem},
	} {
		if c.image != c.wantImage {
			t.Errorf("the fixture runs %s from %s, and the launcher's is %s", c.what, c.image, c.wantImage)
		}
		if c.memory != c.wantMem {
			t.Errorf("the fixture gives %s %s, and the launcher's ceiling is %s", c.what, c.memory, c.wantMem)
		}
	}
}
