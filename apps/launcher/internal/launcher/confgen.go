package launcher

// confgen.go — the documents `semiont init` writes for a knowledge base it
// gives birth to. NOTHING IS MASTERED — no document is embedded in this repo:
// each is built from the launcher's own knowledge — the images and memory of
// its catalog, the shapes derivePlan reads — plus the user's model choices.
// They say what the knowledge base needs and state no address: where each
// daemon listens is the launcher's to place at every start (topology.go), so
// the files are the same on every machine. The roster binds every job and
// both actors to the one model chosen; per-job refinement is the user's edit.
//
// Every generated document passes through the SAME vet as a template copy:
// stack.Load + derivePlan on a temporary tree before the real files exist. A
// generator bug is a refusal, never a KB that cannot start.

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

type genParams struct {
	Inference         string // "anthropic" | "ollama"
	Model             string // the model every role is bound to
	ModelLight        string // optional: emitted as a commented example only
	EmbeddingModel    string // ollama-served embedding model
	AnthropicEndpoint string // the baseURL the Inference document states
}

// initChunking: the two numbers a text is cut by before it is embedded, in
// tokens, as `semiont init` writes them into the KnowledgeIndex.
var initChunking = struct{ chunkSize, overlap int }{chunkSize: 512, overlap: 64}

// initBounds: the two bounds the Librarian answers within, as `semiont init`
// writes them: how long a gather waits for the Smelter, in milliseconds, and
// the least similarity a hit by meaning must have.
var initBounds = struct {
	settleTimeoutMs int
	semanticFloor   float64
}{settleTimeoutMs: 15_000, semanticFloor: 0.6}

// gigabytesForEachPdf: how much of the Smelter's memory one PDF under way is
// given, which decides the pdfsAtOnce `semiont init` writes. A reading, not a
// measurement: a PDF holds its bytes, a page of a scan in pixels beside the
// tesseract process reading it, and its text and vectors, and eight of them
// at once overflowed the 2G one fits in.
const gigabytesForEachPdf = 2

// limits: a container's resources, with the ceiling its catalog entry gives
// it.
func limits(mem string) stack.Resources {
	return stack.Resources{Limits: stack.ResourcesLimits{Memory: mem}}
}

// The fixed names of the documents `semiont init` writes (D17).
const (
	initKnowledgeBase = "knowledge-base"
	initIssuer        = "issuer"
)

// generateStack: the documents `semiont init` writes, each as YAML, by its
// path below .semiont/stack — the four the knowledge base shares, and the
// Inference document named name.
func generateStack(p genParams, name string) (map[string][]byte, error) {
	daemon := func(role, driver string) (*string, *stack.Resources) {
		d := descriptorFor(role, driver)
		image, resources := d.image, limits(d.mem)
		return &image, &resources
	}
	service := func(svc string) (string, stack.Resources) {
		return semiontImage(svc, "latest"), limits(semiontDescriptor(svc).mem)
	}
	meta := func(kind, name string) (string, string, stack.Metadata) {
		return stack.APIVersion, kind, stack.Metadata{Name: name}
	}

	var kb stack.KnowledgeBase
	kb.ApiVersion, kb.Kind, kb.Metadata = meta("KnowledgeBase", initKnowledgeBase)
	kb.Spec.LogLevel = api.LogLevelInfo
	kb.Spec.Gateway.Image, kb.Spec.Gateway.Resources = service("gateway")
	kb.Spec.Gateway.Port = semiontDescriptor("gateway").ports[0].port
	kb.Spec.Gateway.PublicURL = fmt.Sprintf("http://localhost:%d", kb.Spec.Gateway.Port)
	kb.Spec.Dispatcher.Image, kb.Spec.Dispatcher.Resources = service("dispatcher")
	kb.Spec.Archivist.Image, kb.Spec.Archivist.Resources = service("archivist")
	// The dispatcher's queue is JetStream, and the nats signal plane puts the
	// gateway's ledger — claims and retained replies — in JetStream KV on the
	// same broker: durable across restarts and shared by every replica. An
	// in-process plane would hold them in one gateway's memory.
	kb.Spec.Messaging.Jobs.Type, kb.Spec.Messaging.Signal.Type = "jetstream", "nats"
	kb.Spec.Messaging.Image, kb.Spec.Messaging.Resources = daemon("messaging", "jetstream")
	issuerRef := initIssuer
	kb.Spec.Issuer.Ref, kb.Spec.Issuer.SubjectClaim = &issuerRef, "sub"

	var index stack.KnowledgeIndex
	index.ApiVersion, index.Kind, index.Metadata = meta("KnowledgeIndex", "index")
	index.Spec.KnowledgeBase, index.Spec.LogLevel = initKnowledgeBase, api.LogLevelInfo
	index.Spec.Graph.Type, index.Spec.Graph.Username, index.Spec.Graph.Database = "neo4j", "neo4j", "neo4j"
	index.Spec.Graph.Image, index.Spec.Graph.Resources = daemon("graph", "neo4j")
	index.Spec.Vectors.Type = "qdrant"
	index.Spec.Vectors.Image, index.Spec.Vectors.Resources = daemon("vectors", "qdrant")
	index.Spec.Embedding.Type, index.Spec.Embedding.Model = "ollama", p.EmbeddingModel
	index.Spec.Embedding.Chunking.ChunkSize, index.Spec.Embedding.Chunking.Overlap = initChunking.chunkSize, initChunking.overlap
	index.Spec.Librarian.Image, index.Spec.Librarian.Resources = service("librarian")
	index.Spec.Librarian.Gather.SettleTimeoutMs = initBounds.settleTimeoutMs
	index.Spec.Librarian.Search.SemanticFloor = initBounds.semanticFloor
	index.Spec.Smelter.Image, index.Spec.Smelter.Resources = service("smelter")
	index.Spec.Smelter.PdfsAtOnce = max(1, int(memCeilingGB(index.Spec.Smelter.Resources.Limits.Memory))/gigabytesForEachPdf)
	index.Spec.Weaver.Image, index.Spec.Weaver.Resources = service("weaver")

	var issuer stack.Issuer
	issuer.ApiVersion, issuer.Kind, issuer.Metadata = meta("Issuer", initIssuer)
	issuer.Spec.Type = "keycloak"
	identity := descriptorFor("identity", "keycloak")
	issuer.Spec.Image, issuer.Spec.Resources = identity.image, limits(identity.mem)
	issuer.Spec.AccessTokenLifespan = keycloakAccessTokenLifespan
	issuer.Spec.Database.Type, issuer.Spec.Database.Name, issuer.Spec.Database.User = "postgres", "keycloak", "postgres"
	issuer.Spec.Database.Image, issuer.Spec.Database.Resources = daemon("database", "postgres")

	var workers stack.WorkerPool
	workers.ApiVersion, workers.Kind, workers.Metadata = meta("WorkerPool", "workers")
	workers.Spec.KnowledgeBase, workers.Spec.LogLevel = initKnowledgeBase, api.LogLevelInfo
	workers.Spec.Worker.Image, workers.Spec.Worker.Resources = service("worker")

	var inference stack.Inference
	inference.ApiVersion, inference.Kind, inference.Metadata = meta("Inference", name)
	provider := api.ArchivistRosterRoleProvider(p.Inference)
	switch provider {
	case api.ArchivistRosterRoleProviderAnthropic:
		baseURL := p.AnthropicEndpoint
		inference.Spec.Providers = map[api.ArchivistRosterRoleProvider]stack.Provider{
			provider: {BaseURL: &baseURL, ApiKey: &stack.SecretRef{FromEnv: "ANTHROPIC_API_KEY"}},
		}
	case api.ArchivistRosterRoleProviderOllama:
		inference.Spec.Providers = map[api.ArchivistRosterRoleProvider]stack.Provider{provider: {}}
	default:
		return nil, fmt.Errorf("the provider %q: init writes an Inference document for anthropic or ollama", p.Inference)
	}
	role := func() *api.ArchivistRosterRole {
		return &api.ArchivistRosterRole{Provider: provider, Model: p.Model}
	}
	inference.Spec.Roster.Actors.Gatherer, inference.Spec.Roster.Actors.Matcher = role(), role()
	workerRoster := reflect.ValueOf(&inference.Spec.Roster.Workers).Elem()
	for _, job := range workerJobs() {
		job.slot(workerRoster).Set(reflect.ValueOf(role()))
	}

	files := map[string]any{
		stack.KnowledgeBaseFile:                         kb,
		stack.KnowledgeIndexFile:                        index,
		stack.IssuerFile:                                issuer,
		stack.WorkerPoolFile:                            workers,
		filepath.Join(stack.InferenceDir, name+".yaml"): inference,
	}
	out := map[string][]byte{}
	for path, document := range files {
		text, err := stack.Marshal(document)
		if err != nil {
			return nil, err
		}
		out[path] = text
	}
	if p.ModelLight != "" {
		at := filepath.Join(stack.InferenceDir, name+".yaml")
		out[at] = append(out[at], []byte(fmt.Sprintf(
			"# Per-job refinement is yours to make. For example, a lighter model\n"+
				"# for the high-volume annotation jobs: under spec.roster.workers.mark,\n"+
				"# { provider: %s, model: %s } for highlighting, commenting and tagging.\n",
			p.Inference, p.ModelLight))...)
	}
	return out, nil
}

// writeVettedStack writes documents into root's .semiont/stack — but only
// after the REAL loader and deriver accept them: they land in a temporary
// tree, stack.Load + derivePlan judge it once for each Inference document,
// and only success writes them in place. The same gate template copies pass
// through: no path may write documents this launcher cannot start.
func writeVettedStack(u *UI, root string, files map[string][]byte) bool {
	vet, err := os.MkdirTemp("", "semiont-vet-*")
	if err != nil {
		u.Fail("Vetting the documents: %v", err)
		return false
	}
	defer os.RemoveAll(vet)
	if err := writeStackFiles(vet, files); err != nil {
		u.Fail("Vetting the documents: %v", err)
		return false
	}
	names := stack.InferenceNames(vet)
	if len(names) == 0 {
		u.Fail("The documents hold no Inference document (%s/<name>.yaml): a start has no models to run with.", filepath.Join(stack.Dir, stack.InferenceDir))
		return false
	}
	for _, name := range names {
		st, err := stack.Load(vet, name)
		if err == nil {
			// Vetting only: any port proves the issuer is planned.
			_, err = derivePlan(st, descriptorFor("identity", "keycloak").defaultPort)
		}
		if err != nil {
			u.Fail("The documents did not pass the launcher's own reading — refusing to write them: %v", err)
			return false
		}
	}
	if err := writeStackFiles(root, files); err != nil {
		u.Fail("Writing the documents: %v", err)
		return false
	}
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	u.Ok("%s/ written: %s %s", stack.Dir, strings.Join(paths, ", "), u.Dim("(vetted by the plan deriver)"))
	return true
}

// writeStackFiles writes each document below root's .semiont/stack. A path
// that would leave it is refused.
func writeStackFiles(root string, files map[string][]byte) error {
	dir := filepath.Join(root, stack.Dir)
	for path, text := range files {
		target := filepath.Join(dir, path)
		if rel, err := filepath.Rel(dir, target); err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("%q is not a path below %s", path, stack.Dir)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, text, 0o644); err != nil {
			return err
		}
	}
	return nil
}
