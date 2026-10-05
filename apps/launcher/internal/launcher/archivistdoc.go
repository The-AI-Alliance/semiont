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

// archivistRoster: who serves each role, with every fallback the KB's config
// allows applied — a job type by `workers.<type>`, else `workers.default`; an
// actor by `make-meaning.actors.<actor>`, else `actors.<actor>`, else
// `make-meaning.default`. The TypeScript loader decides the same thing for
// the services that call the models, and
// specs/src/service-config/roster-cases.json holds the two to one answer.
func archivistRoster(env *envConfig) (roster semiont.ArchivistRoster, err error) {
	worker := func(jobType string) (*semiont.ArchivistRosterRole, error) {
		return firstBound(
			func() (*semiont.ArchivistRosterRole, error) {
				return rosterRole("workers."+jobType, binding(env.Workers, jobType))
			},
			func() (*semiont.ArchivistRosterRole, error) {
				return rosterRole("workers.default", binding(env.Workers, "default"))
			},
		)
	}
	actor := func(name string) (*semiont.ArchivistRosterRole, error) {
		var own, fallback *bindingCfg
		if env.MakeMeaning != nil {
			own, fallback = binding(env.MakeMeaning.Actors, name), env.MakeMeaning.Default
		}
		return firstBound(
			func() (*semiont.ArchivistRosterRole, error) {
				return rosterRole("make-meaning.actors."+name, own)
			},
			func() (*semiont.ArchivistRosterRole, error) {
				return rosterRole("actors."+name, binding(env.Actors, name))
			},
			func() (*semiont.ArchivistRosterRole, error) {
				return rosterRole("make-meaning.default", fallback)
			},
		)
	}
	for _, slot := range []struct {
		role **semiont.ArchivistRosterRole
		find func(string) (*semiont.ArchivistRosterRole, error)
		name string
	}{
		{&roster.Workers.ReferenceAnnotation, worker, "reference-annotation"},
		{&roster.Workers.HighlightAnnotation, worker, "highlight-annotation"},
		{&roster.Workers.AssessmentAnnotation, worker, "assessment-annotation"},
		{&roster.Workers.CommentAnnotation, worker, "comment-annotation"},
		{&roster.Workers.TagAnnotation, worker, "tag-annotation"},
		{&roster.Workers.Generation, worker, "generation"},
		{&roster.Actors.Gatherer, actor, "gatherer"},
		{&roster.Actors.Matcher, actor, "matcher"},
	} {
		if *slot.role, err = slot.find(slot.name); err != nil {
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
