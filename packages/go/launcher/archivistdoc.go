package launcher

// archivistdoc.go — the Archivist's configuration document: ArchivistConfig
// in specs/, the Go type generated from it (packages/go/sdk). The launcher
// writes it for the Archivist it starts, every address a literal (placement),
// and mounts it where the Archivist's image points its `--config` flag, so the
// Archivist neither reads a knowledge base's documents nor resolves or
// defaults anything. It carries no secret.

import (
	"encoding/json"
	"reflect"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// archivistDocumentFile: the Archivist is configured by a document, not a
// copy of the KB's. One name, staged and mounted.
const archivistDocumentFile = "archivist.json"

// archivistDocumentTarget: where the Archivist reads that document — the path
// its image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook
// holds the two together.
const archivistDocumentTarget = "/etc/semiont/archivist.json"

// anchoredTextTarget: where the anchored-text store is mounted in the
// Archivist, the one container that holds it.
const anchoredTextTarget = "/anchored-text"

// stateHomeTarget: where the Archivist's state volume is mounted, and where
// the gateway and the Librarian each mount a store of their own: supervise.sh
// keeps a supervisor's events log under it. The Archivist's document names it.
const stateHomeTarget = "/semiont-state"

// archivistStaging: how far a deployed Archivist's staging may run behind the
// working tree. The launcher is the one decider: the Archivist defaults
// neither, and a test harness writes its own.
var archivistStaging = struct{ flushMs, maxWaitMs int }{flushMs: 250, maxWaitMs: 2_000}

// engineType: one engine, as the generated engines hold it.
var engineType = reflect.TypeOf((*api.Engine)(nil))

// jsonName: the name a generated field is written under.
func jsonName(field reflect.StructField) string {
	name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
	return name
}

// engineJob: a job the generated engines' `jobs` can give an engine.
type engineJob struct {
	// name: the job as a job description keys it, which is its place in the
	// engines' `jobs`: "mark.tagging", "yield".
	name string
	// at: the field holding its engine, from the engines' `jobs` down.
	at []int
}

// engineJobs: every job the generated engines' `jobs` can give an engine.
func engineJobs() []engineJob {
	var jobs []engineJob
	var walk func(slots reflect.Type, above string, at []int)
	walk = func(slots reflect.Type, above string, at []int) {
		for i := 0; i < slots.NumField(); i++ {
			field, here := slots.Field(i), append(at[:len(at):len(at)], i)
			if field.Type == engineType {
				jobs = append(jobs, engineJob{name: above + jsonName(field), at: here})
				continue
			}
			walk(field.Type.Elem(), above+jsonName(field)+".", here)
		}
	}
	walk(reflect.TypeOf(api.ArchivistEngines{}.Jobs), "", nil)
	return jobs
}

// slot: where the engines' `jobs` holds this job's engine, for engines being
// written. The structs above the slot are made as it is reached.
func (job engineJob) slot(jobs reflect.Value) reflect.Value {
	for _, i := range job.at[:len(job.at)-1] {
		group := jobs.Field(i)
		if group.IsNil() {
			group.Set(reflect.New(group.Type().Elem()))
		}
		jobs = group.Elem()
	}
	return jobs.Field(job.at[len(job.at)-1])
}

// engine: the engine the engines' `jobs` give this job; nil when they give
// it none, or none to the group above it.
func (job engineJob) engine(jobs reflect.Value) *api.Engine {
	for _, i := range job.at[:len(job.at)-1] {
		group := jobs.Field(i)
		if group.IsNil() {
			return nil
		}
		jobs = group.Elem()
	}
	return jobs.Field(job.at[len(job.at)-1]).Interface().(*api.Engine)
}

// jobEngine: a job, and its engine.
type jobEngine struct {
	job    engineJob
	engine *api.Engine
}

// archivistDocument renders the document from the start's placement. Its
// engines are the Inference document's: the worker's document claims the same
// jobs with the same engines (workerEngines), and the Librarian's gives its
// actors the same engines (librarianEngine), so `browse:engines` names exactly
// the engines the work is done with.
func archivistDocument(p placement) ([]byte, error) {
	var doc api.ArchivistConfig
	doc.GatewayUrl = p.gatewayURL()
	doc.Identity.Issuer = p.issuer()
	doc.Root = kbMountTarget
	doc.StateHome = stateHomeTarget
	doc.AnchoredTextDir = anchoredTextTarget
	doc.Engines = p.st.Inference.Spec.Engines
	doc.Port = semiontDescriptor("archivist").ports[0].port
	doc.SkipRebuild = false
	doc.Staging.FlushMs = archivistStaging.flushMs
	doc.Staging.MaxWaitMs = archivistStaging.maxWaitMs
	doc.LogLevel = p.st.KnowledgeBase.Spec.LogLevel
	doc.LogFormat = api.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
