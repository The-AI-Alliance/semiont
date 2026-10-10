package launcher

// archivistdoc.go — the Archivist's configuration document: ArchivistConfig
// in specs/, the Go type generated from it (packages/sdk-go). The launcher
// writes it for the Archivist it starts, resolved — every ${VAR} a value, and
// every role's fallback applied — and mounts it where the Archivist's image
// points its `--config` flag, so the Archivist neither parses the
// environment's TOML nor resolves or defaults anything. It carries no secret.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// archivistDocumentFile: the Archivist is configured by a document, not a
// copy of the KB's config. One name, staged and mounted.
const archivistDocumentFile = "archivist.json"

// archivistDocumentTarget: where the Archivist reads that document — the path
// its image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook
// holds the two together.
const archivistDocumentTarget = "/etc/semiont/archivist.json"

// anchoredTextTarget: where the anchored-text store is mounted in the
// containers that hold it.
const anchoredTextTarget = "/anchored-text"

// stateHomeTarget: where the state volume is mounted in the containers that
// hold it. The Archivist's document names it; the Librarian is told it as
// XDG_STATE_HOME.
const stateHomeTarget = "/semiont-state"

// archivistStaging: how far a deployed Archivist's staging may run behind the
// working tree. The launcher is the one decider: the Archivist defaults
// neither, and a test harness writes its own.
var archivistStaging = struct{ flushMs, maxWaitMs int }{flushMs: 250, maxWaitMs: 2_000}

// rosterRole: one binding as the roster states it. A binding that names
// neither a provider nor a model binds nothing; one that names half of an
// agent, or a provider Semiont has no client for, is refused by name.
func rosterRole(field string, b *bindingCfg) (*semiont.ArchivistRosterRole, error) {
	if b == nil || (b.Inference.Type == "" && b.Inference.Model == "") {
		return nil, nil
	}
	provider := semiont.ArchivistRosterRoleProvider(b.Inference.Type)
	if !provider.Valid() || b.Inference.Model == "" {
		return nil, fmt.Errorf("%s.inference must name type \"anthropic\" or \"ollama\" and a model (got type %q, model %q)", field, b.Inference.Type, b.Inference.Model)
	}
	return &semiont.ArchivistRosterRole{Provider: provider, Model: b.Inference.Model}, nil
}

// binding: the entry a role map holds under name, or none.
func binding(m map[string]bindingCfg, name string) *bindingCfg {
	if b, ok := m[name]; ok {
		return &b
	}
	return nil
}

// firstBound: the first of the candidates that binds an agent.
func firstBound(candidates ...func() (*semiont.ArchivistRosterRole, error)) (*semiont.ArchivistRosterRole, error) {
	for _, candidate := range candidates {
		role, err := candidate()
		if role != nil || err != nil {
			return role, err
		}
	}
	return nil, nil
}

// rosterRoleType: one role, as the generated roster holds it.
var rosterRoleType = reflect.TypeOf((*semiont.ArchivistRosterRole)(nil))

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
	walk(reflect.TypeOf(semiont.ArchivistRoster{}.Workers), "", nil)
	return jobs
}

// slot: where a roster's `workers` holds the role serving this job. The
// structs above the slot are made as it is reached, so a group of jobs no one
// serves stays absent from the roster.
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

// servingSections: the sections of `workers` that can serve a job, nearest
// first: its own, each one above it, and `default`. For "mark.tagging":
// mark.tagging, mark, default.
func servingSections(job string) []string {
	sections := []string{job}
	for at := job; strings.Contains(at, "."); {
		at = at[:strings.LastIndex(at, ".")]
		sections = append(sections, at)
	}
	return append(sections, "default")
}

// workerSections: every section of `workers` that serves a job, sorted.
func workerSections() []string {
	var sections []string
	for _, job := range workerJobs() {
		for _, section := range servingSections(job.name) {
			if !contains(sections, section) {
				sections = append(sections, section)
			}
		}
	}
	sort.Strings(sections)
	return sections
}

// servesUnder: whether a section of `workers` has sections under it, as
// `mark` has one per motivation.
func servesUnder(sections []string, section string) bool {
	for _, other := range sections {
		if strings.HasPrefix(other, section+".") {
			return true
		}
	}
	return false
}

// servedJob: a job, and the role serving it.
type servedJob struct {
	job  workerJob
	role *semiont.ArchivistRosterRole
}

// workerRoles: the role serving each job, in workerJobs' order, with every
// fallback the KB's config allows applied. A job is served by its own section
// of `workers`, else each section above it, else `workers.default`: a `mark`
// job of a motivation by `workers.mark.<motivation>`, `workers.mark`,
// `workers.default`, and a `yield` job by `workers.yield`, `workers.default`.
// A job no section serves is absent. ONE resolution: the Archivist's roster
// names these roles (archivistRoster) and the worker's document claims their
// jobs (workerAgents), so `browse:agents` names exactly the agents the work
// goes to. specs/src/service-config/roster-cases.json holds both to its
// answer.
func workerRoles(env *envConfig) ([]servedJob, error) {
	var served []servedJob
	for _, job := range workerJobs() {
		var candidates []func() (*semiont.ArchivistRosterRole, error)
		for _, section := range servingSections(job.name) {
			candidates = append(candidates, func() (*semiont.ArchivistRosterRole, error) {
				return rosterRole("workers."+section, binding(env.Workers, section))
			})
		}
		role, err := firstBound(candidates...)
		if err != nil {
			return nil, err
		}
		if role != nil {
			served = append(served, servedJob{job: job, role: role})
		}
	}
	return served, nil
}

// archivistRoster: who serves each role. A job is served as workerRoles says,
// with every fallback the KB's config allows applied. An actor is served by
// `actors.<actor>`, and by nothing else. The TypeScript loader decides an
// actor's the same way for the Librarian, which calls the models, and
// specs/src/service-config/roster-cases.json holds the two to one answer.
func archivistRoster(env *envConfig) (roster semiont.ArchivistRoster, err error) {
	served, err := workerRoles(env)
	if err != nil {
		return roster, err
	}
	for _, s := range served {
		s.job.slot(reflect.ValueOf(&roster.Workers).Elem()).Set(reflect.ValueOf(s.role))
	}
	for _, slot := range []struct {
		role **semiont.ArchivistRosterRole
		name string
	}{
		{&roster.Actors.Gatherer, "gatherer"},
		{&roster.Actors.Matcher, "matcher"},
	} {
		if *slot.role, err = rosterRole("actors."+slot.name, binding(env.Actors, slot.name)); err != nil {
			return roster, err
		}
	}
	return roster, nil
}

// archivistDocument renders the document from the selected environment, the
// address the launcher computed, and the user's variables.
func archivistDocument(env *envConfig, rt, addr string, issuerPort int, userEnv []string) ([]byte, error) {
	if env.Gateway == nil || env.Gateway.PublicURL == "" {
		return nil, fmt.Errorf("the environment declares no [gateway] publicURL: the Archivist has no gateway to reach")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the Archivist has no issuer to sign in at")
	}
	vars := gatewayDialerVars(rt, addr, issuerPort, userEnv)
	var doc semiont.ArchivistConfig
	var err error
	if doc.GatewayUrl, err = resolveRefs("gateway.publicURL", env.Gateway.PublicURL, vars); err != nil {
		return nil, err
	}
	if doc.Identity.Issuer, err = resolveRefs("identity.issuer", env.Identity.Issuer, vars); err != nil {
		return nil, err
	}
	doc.Root = kbMountTarget
	doc.StateHome = stateHomeTarget
	doc.AnchoredTextDir = anchoredTextTarget
	if doc.Roster, err = archivistRoster(env); err != nil {
		return nil, err
	}
	doc.Port = semiontDescriptor("archivist").ports[0].port
	doc.SkipRebuild = false
	doc.Staging.FlushMs = archivistStaging.flushMs
	doc.Staging.MaxWaitMs = archivistStaging.maxWaitMs

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.LogLevel(env.LogLevel)
	}
	doc.LogFormat = semiont.Json
	return json.MarshalIndent(doc, "", "  ")
}
