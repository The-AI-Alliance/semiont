package launcher

// workerpooldoc.go — the worker's document: the image the worker runs, its
// memory and its log level. They are the machine's, not any knowledge base's,
// so the document is one of the state home's (statehomedoc.go). A knowledge
// base's jobs are done when its Inference document gives a job an engine
// (workerPlan); the worker that does them runs as this document says.

import (
	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// workerPoolDocument: the worker's document as a command read it.
type workerPoolDocument struct {
	path string
	spec stack.WorkerPoolSpec
	// fromCatalog: there was no document. This command wrote the catalog's,
	// or, in a dry run, plans with what a start would write.
	fromCatalog bool
}

// workerPoolDocumentPath: where the worker's document is kept; "" when there
// is no state home.
func workerPoolDocumentPath() string {
	return stateHomeDocumentPath(stack.WorkerPoolFile)
}

// catalogWorkerPool: the worker's document as the launcher writes it, from
// its catalog.
func catalogWorkerPool() stack.WorkerPool {
	return stack.WorkerPool{
		ApiVersion: stack.APIVersion,
		Kind:       "WorkerPool",
		Metadata:   stack.Metadata{Name: "workers"},
		Spec: stack.WorkerPoolSpec{
			LogLevel: api.LogLevelInfo,
			Worker: stack.WorkerPoolWorker{
				Image:     semiontImage("worker", "latest"),
				Resources: limits(semiontDescriptor("worker").mem),
			},
		},
	}
}

// loadWorkerPoolDocument: the worker's document, written from the catalog
// first when there is none, unless preview (a dry run), which writes nothing.
func loadWorkerPoolDocument(preview bool) (workerPoolDocument, error) {
	read, path, fromCatalog, err := loadStateHomeDocument(stack.WorkerPoolFile, "WorkerPool", "the worker's", catalogWorkerPool(), preview)
	return workerPoolDocument{path: path, spec: read.Spec, fromCatalog: fromCatalog}, err
}

// readWorkerPoolDocument: loadWorkerPoolDocument for a command, which says
// where it wrote one and refuses one that does not hold.
func readWorkerPoolDocument(u *UI, preview bool) (workerPoolDocument, bool) {
	doc, err := loadWorkerPoolDocument(preview)
	return doc, reportStateHomeDocument(u, "Worker", "the image, memory or log level", doc.path, doc.fromCatalog, preview, err)
}

// runWorkerAs: the plan's worker runs as doc says — from its image, with its
// memory, at its log level.
func (p *launchPlan) runWorkerAs(doc workerPoolDocument) {
	p.Worker = doc
	p.Images["worker"] = doc.spec.Worker.Image
	p.Memory["worker"] = doc.spec.Worker.Resources.Limits.Memory
}
