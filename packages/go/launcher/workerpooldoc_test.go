package launcher

// The worker's document: where it is kept, that the first command that needs
// it writes it from the launcher's catalog, and that a start's plan runs the
// worker as it says. Refusing one that does not hold is the state home's
// reader's, held by the Browser's tests.

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// It is kept in the state home, in stack/, beside the Browser's.
func TestTheWorkerDocumentIsKeptInTheStateHome(t *testing.T) {
	harness.Home(t)
	want := filepath.Join(filepath.Dir(statePath()), "stack", "workers.yaml")
	if path := workerPoolDocumentPath(); path != want {
		t.Errorf("the worker's document is at %s, want %s", path, want)
	}
}

// The catalog's runs the launcher's own worker: its image at latest, with its
// descriptor's memory, logging at info.
func TestTheCatalogWorkerIsTheLaunchersOwn(t *testing.T) {
	spec := catalogWorkerPool().Spec
	if spec.Worker.Image != semiontImage("worker", "latest") || spec.Worker.Resources.Limits.Memory != semiontDescriptor("worker").mem || spec.LogLevel != api.LogLevelInfo {
		t.Errorf("the catalog's worker is %+v, want %s with %s at info", spec, semiontImage("worker", "latest"), semiontDescriptor("worker").mem)
	}
}

// The first command that needs it and finds none writes the catalog's, which
// holds to the schema. From then on the file is what runs.
func TestTheFirstNeedWritesTheWorkerDocumentFromTheCatalog(t *testing.T) {
	harness.Home(t)
	doc, err := loadWorkerPoolDocument(false)
	if err != nil {
		t.Fatal(err)
	}
	catalog := catalogWorkerPool().Spec
	if !doc.fromCatalog || doc.spec != catalog || doc.path != workerPoolDocumentPath() {
		t.Errorf("with no document: %+v, want the catalog's %+v, written at %s", doc, catalog, workerPoolDocumentPath())
	}
	text, err := os.ReadFile(workerPoolDocumentPath())
	if err != nil {
		t.Fatalf("the document was not written: %v", err)
	}
	if refusals, err := stack.Check("WorkerPool", text); err != nil || len(refusals) > 0 {
		t.Fatalf("the document written does not hold to its schema: %v %+v\n%s", err, refusals, text)
	}

	local := strings.Replace(string(text), "semiont-worker:latest", "semiont-worker:local", 1)
	if local == string(text) {
		t.Fatalf("the document written names no image: %s", text)
	}
	if err := os.WriteFile(workerPoolDocumentPath(), []byte(local), 0o644); err != nil {
		t.Fatal(err)
	}
	again, err := loadWorkerPoolDocument(false)
	if err != nil {
		t.Fatal(err)
	}
	if again.fromCatalog || again.spec.Worker.Image != semiontImage("worker", "local") {
		t.Errorf("an edited document read as %+v, want the local image from the file", again)
	}
}

// A dry run writes nothing: it plans with the document a start would write.
func TestADryRunWritesNoWorkerDocument(t *testing.T) {
	harness.Home(t)
	doc, err := loadWorkerPoolDocument(true)
	if err != nil {
		t.Fatal(err)
	}
	if !doc.fromCatalog || doc.spec != catalogWorkerPool().Spec {
		t.Errorf("a dry run with no document planned %+v, want the catalog's", doc)
	}
	if _, err := os.Stat(doc.path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a dry run wrote %s (%v)", doc.path, err)
	}
}

// A plan runs its worker as the document says: its image, its memory, and,
// in the worker's configuration document, its log level.
func TestAPlanRunsTheWorkerAsItsDocumentSays(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	plan, err := derivePlan(st, 8080)
	if err != nil {
		t.Fatal(err)
	}
	doc := catalogWorkerPoolDocument
	doc.spec.Worker.Image = semiontImage("worker", "local")
	doc.spec.Worker.Resources = limits("3G")
	doc.spec.LogLevel = api.LogLevelDebug
	plan.runWorkerAs(doc)
	if plan.Images["worker"] != semiontImage("worker", "local") || plan.Memory["worker"] != "3G" {
		t.Errorf("the plan runs the worker from %q with %q, want the document's local image with 3G", plan.Images["worker"], plan.Memory["worker"])
	}
	config := workerDocumentOf(t, placement{st: st, plan: plan, rt: "container", addr: "192.168.64.1"})
	if config.LogLevel != api.LogLevelDebug {
		t.Errorf("the worker logs at %q, want the document's debug", config.LogLevel)
	}
}
