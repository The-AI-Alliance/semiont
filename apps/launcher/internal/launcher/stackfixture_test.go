package launcher

import (
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// The fixture knowledge base's stack documents name every container's image
// and memory, as a knowledge base's documents do, and they name the
// launcher's own: each daemon at its descriptor's image (the broker's, which
// TestBrokerPairIsReadByTheLaunchedBrokersParser holds to go.mod), each
// Semiont service at latest, and each at its descriptor's memory. A copy of a
// pin nothing moves is refused by lint:nats-version; this is what moves it.
func TestTheFixtureStackNamesTheDescriptorsImages(t *testing.T) {
	dir := filepath.Join("..", "..", "testdata", "kb", ".semiont", "stack")
	kb, err := stack.Read[stack.KnowledgeBase](filepath.Join(dir, "knowledge-base.yaml"), "KnowledgeBase")
	if err != nil {
		t.Fatal(err)
	}
	index, err := stack.Read[stack.KnowledgeIndex](filepath.Join(dir, "index.yaml"), "KnowledgeIndex")
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := stack.Read[stack.Issuer](filepath.Join(dir, "issuer.yaml"), "Issuer")
	if err != nil {
		t.Fatal(err)
	}
	workers, err := stack.Read[stack.WorkerPool](filepath.Join(dir, "workers.yaml"), "WorkerPool")
	if err != nil {
		t.Fatal(err)
	}
	if kb.Spec.Messaging.Image == nil || kb.Spec.Messaging.Resources == nil || index.Spec.Graph.Image == nil || index.Spec.Graph.Resources == nil ||
		index.Spec.Vectors.Image == nil || index.Spec.Vectors.Resources == nil || issuer.Spec.Database.Image == nil || issuer.Spec.Database.Resources == nil {
		t.Fatal("the fixture runs every daemon itself, so each states its image and its resources")
	}

	for _, c := range []struct {
		what               string
		image, memory      string
		wantImage, wantMem string
	}{
		{"the gateway", kb.Spec.Gateway.Image, kb.Spec.Gateway.Resources.Limits.Memory, image("gateway", "latest"), semiontDescriptor("gateway").mem},
		{"the dispatcher", kb.Spec.Dispatcher.Image, kb.Spec.Dispatcher.Resources.Limits.Memory, image("dispatcher", "latest"), semiontDescriptor("dispatcher").mem},
		{"the archivist", kb.Spec.Archivist.Image, kb.Spec.Archivist.Resources.Limits.Memory, image("archivist", "latest"), semiontDescriptor("archivist").mem},
		{"the librarian", index.Spec.Librarian.Image, index.Spec.Librarian.Resources.Limits.Memory, image("librarian", "latest"), semiontDescriptor("librarian").mem},
		{"the smelter", index.Spec.Smelter.Image, index.Spec.Smelter.Resources.Limits.Memory, image("smelter", "latest"), semiontDescriptor("smelter").mem},
		{"the weaver", index.Spec.Weaver.Image, index.Spec.Weaver.Resources.Limits.Memory, image("weaver", "latest"), semiontDescriptor("weaver").mem},
		{"the worker", workers.Spec.Worker.Image, workers.Spec.Worker.Resources.Limits.Memory, image("worker", "latest"), semiontDescriptor("worker").mem},
		{"the broker", *kb.Spec.Messaging.Image, kb.Spec.Messaging.Resources.Limits.Memory, descriptorFor("messaging", "jetstream").image, descriptorFor("messaging", "jetstream").mem},
		{"the graph store", *index.Spec.Graph.Image, index.Spec.Graph.Resources.Limits.Memory, descriptorFor("graph", "neo4j").image, descriptorFor("graph", "neo4j").mem},
		{"the vector store", *index.Spec.Vectors.Image, index.Spec.Vectors.Resources.Limits.Memory, descriptorFor("vectors", "qdrant").image, descriptorFor("vectors", "qdrant").mem},
		{"the issuer", issuer.Spec.Image, issuer.Spec.Resources.Limits.Memory, descriptorFor("identity", "keycloak").image, descriptorFor("identity", "keycloak").mem},
		{"the issuer's database", *issuer.Spec.Database.Image, issuer.Spec.Database.Resources.Limits.Memory, descriptorFor("database", "postgres").image, descriptorFor("database", "postgres").mem},
	} {
		if c.image != c.wantImage {
			t.Errorf("the fixture runs %s from %s, and the launcher's is %s", c.what, c.image, c.wantImage)
		}
		if c.memory != c.wantMem {
			t.Errorf("the fixture gives %s %s, and the launcher's ceiling is %s", c.what, c.memory, c.wantMem)
		}
	}
}
