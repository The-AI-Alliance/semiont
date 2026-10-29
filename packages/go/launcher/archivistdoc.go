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

// rosterRoleType: one role, as the generated roster holds it.
var rosterRoleType = reflect.TypeOf((*api.ArchivistRosterRole)(nil))

// jsonName: the name a generated field is written under.
func jsonName(field reflect.StructField) string {
	name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
	return name
}

// workerJob: a job the generated roster has a worker role for.
type workerJob struct {
	// name: the job as a job description keys it, which is its place in the
	// roster: "mark.tagging", "yield".
	name string
	// at: the field holding its role, from the roster's `workers` down.
	at []int
}

// workerJobs: every job the generated roster has a worker role for.
func workerJobs() []workerJob {
	var jobs []workerJob
	var walk func(roles reflect.Type, above string, at []int)
	walk = func(roles reflect.Type, above string, at []int) {
		for i := 0; i < roles.NumField(); i++ {
			field, here := roles.Field(i), append(at[:len(at):len(at)], i)
			if field.Type == rosterRoleType {
				jobs = append(jobs, workerJob{name: above + jsonName(field), at: here})
				continue
			}
			walk(field.Type.Elem(), above+jsonName(field)+".", here)
		}
	}
	walk(reflect.TypeOf(api.ArchivistRoster{}.Workers), "", nil)
	return jobs
}

// slot: where a roster's `workers` holds the role serving this job, for a
// roster being written. The structs above the slot are made as it is reached.
func (job workerJob) slot(workers reflect.Value) reflect.Value {
	for _, i := range job.at[:len(job.at)-1] {
		group := workers.Field(i)
		if group.IsNil() {
			group.Set(reflect.New(group.Type().Elem()))
		}
		workers = group.Elem()
	}
	return workers.Field(job.at[len(job.at)-1])
}

// bound: the role a roster's `workers` binds to this job; nil when it binds
// none, or none of the group above it.
func (job workerJob) bound(workers reflect.Value) *api.ArchivistRosterRole {
	for _, i := range job.at[:len(job.at)-1] {
		group := workers.Field(i)
		if group.IsNil() {
			return nil
		}
		workers = group.Elem()
	}
	return workers.Field(job.at[len(job.at)-1]).Interface().(*api.ArchivistRosterRole)
}

// servedJob: a job, and the role serving it.
type servedJob struct {
	job  workerJob
	role *api.ArchivistRosterRole
}

// archivistDocument renders the document from the start's placement. Its
// roster is the Inference document's: the worker's document claims the same
// jobs (workerAgents), and the Librarian's names the same actors
// (librarianModel), so `browse:agents` names exactly the agents the work goes
// to.
func archivistDocument(p placement) ([]byte, error) {
	var doc api.ArchivistConfig
	doc.GatewayUrl = p.gatewayURL()
	doc.Identity.Issuer = p.issuer()
	doc.Root = kbMountTarget
	doc.StateHome = stateHomeTarget
	doc.AnchoredTextDir = anchoredTextTarget
	doc.Roster = p.st.Inference.Spec.Roster
	doc.Port = semiontDescriptor("archivist").ports[0].port
	doc.SkipRebuild = false
	doc.Staging.FlushMs = archivistStaging.flushMs
	doc.Staging.MaxWaitMs = archivistStaging.maxWaitMs
	doc.LogLevel = p.st.KnowledgeBase.Spec.LogLevel
	doc.LogFormat = api.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
