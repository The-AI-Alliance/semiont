package launcher

// workerdoc.go — the worker's configuration document: WorkerConfig in specs/,
// the Go type generated from it (packages/sdk-go). The launcher writes it for
// the worker it starts, every address a literal (placement), and mounts it
// where the worker's image points its `--config` flag, so the worker neither
// reads a knowledge base's documents nor resolves or defaults anything.
// Secrets are never values in it: a provider's key is a variable the Inference
// document names (`fromEnv`), and the document names it.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// workerDocumentFile: the worker is configured by a document, not a copy of
// the KB's. One name, staged and mounted.
const workerDocumentFile = "worker.json"

// workerDocumentTarget: where the worker reads that document — the path its
// image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook holds
// the two together.
const workerDocumentTarget = "/etc/semiont/worker.json"

// jobFilter: the filter naming one job of the roster, as a claim states it:
// "mark.<motivation>" is the `mark` jobs of that motivation, and "yield" the
// `yield` jobs. TestEveryRosterJobHasAFilter holds it to every job the roster
// has a worker role for.
func jobFilter(job string) (filter semiont.JobFilter, err error) {
	jobType, motivation, _ := strings.Cut(job, ".")
	switch {
	case jobType == string(semiont.MarkJobFilterJobTypeMark) && semiont.Motivation(motivation).Valid():
		var mark semiont.MarkJobFilter
		mark.Params.Motivation = semiont.Motivation(motivation)
		err = filter.FromMarkJobFilter(mark)
	case job == string(semiont.YieldJobFilterJobTypeYield):
		err = filter.FromYieldJobFilter(semiont.YieldJobFilter{})
	default:
		err = fmt.Errorf("the roster has a worker role for %q, and no job filter names that job", job)
	}
	return filter, err
}

// providerAddress: where a provider's API is reached — the baseURL its entry
// in the Inference document states. An Ollama that states none is the
// machine's, at this start's address; an Anthropic that states none is
// reached where the launcher itself reaches Anthropic (remoteProviderAddress).
// Every other provider states one: the launcher keeps no vendor's address but
// Anthropic's, and runs no server but Ollama's. ONE decider, for the worker's
// agents and the Librarian's two models. who names the service in a refusal.
func providerAddress(p placement, provider semiont.ArchivistRosterRoleProvider, who string) (string, error) {
	baseURL := p.st.Inference.Spec.Providers[provider].BaseURL
	switch {
	case provider == semiont.ArchivistRosterRoleProviderOllama:
		return p.ollama(baseURL), nil
	case baseURL != nil:
		return *baseURL, nil
	case provider == semiont.ArchivistRosterRoleProviderAnthropic:
		return saasBase(remoteProviderAddress(p.st, string(provider))), nil
	}
	return "", planErr(p.st.Files.Inference, "spec.providers."+string(provider)+".baseURL", "is not stated: %s has no address to reach %s at", who, provider)
}

// providerKeyName: the variable holding a provider's key, as its entry in the
// Inference document names it; none when it names none.
func providerKeyName(p placement, provider semiont.ArchivistRosterRoleProvider) *string {
	if key := p.st.Inference.Spec.Providers[provider].ApiKey; key != nil {
		return &key.FromEnv
	}
	return nil
}

// modelCatalogueTarget: where the worker's image and the Librarian's each
// carry the model catalogue file, which each one's document names. A service
// reads the file only for a provider whose own API leaves a model's facts
// unsaid, and which those are is the service's to know, not the launcher's.
// TestModelCatalogueIsWhereTheImagesCarryIt holds this to the two Dockerfiles.
const modelCatalogueTarget = "/usr/share/semiont/model-catalogue.json"

// workerSecrets: the variables the worker's document names, and so the ones
// the worker is handed — the key of each provider that serves a job.
func workerSecrets(p placement) []string {
	var names []string
	for _, s := range servedJobs(p.st.Inference.Spec.Roster) {
		if name := providerKeyName(p, s.role.Provider); name != nil && !contains(names, *name) {
			names = append(names, *name)
		}
	}
	return names
}

// workerBinding: where a roster binds jobs to a worker, as the launcher names
// it for an operator to add one.
func workerBinding(inference string) string {
	return inference + " spec.roster.workers"
}

// workerAgents: the agents the worker works as, projected from the roles the
// roster binds to jobs (servedJobs). An agent is an engine — a provider and a
// model, at one address, under one key — and accepts every job that engine
// serves: agents are in the order of the first job that needs each, and an
// agent's filters in workerJobs' order. A roster that binds no job has no
// agents, and is refused: the document's `agents` is never empty. A start of
// such a roster runs no worker and writes no document (workerPlan), and a
// worker asked for by name is refused before anything runs (flowOneService).
// errNoWorkerJob: the refusal of a worker for a roster, in the Inference
// document at inference, that binds it no job.
func errNoWorkerJob(inference string) error {
	return fmt.Errorf("the roster binds no job to a worker: the worker has no job to serve — bind one in %s", workerBinding(inference))
}

func workerAgents(p placement) ([]semiont.WorkerAgentConfig, error) {
	served := servedJobs(p.st.Inference.Spec.Roster)
	if len(served) == 0 {
		return nil, errNoWorkerJob(p.st.Files.Inference)
	}
	var agents []semiont.WorkerAgentConfig
	for _, s := range served {
		filter, err := jobFilter(s.job.name)
		if err != nil {
			return nil, err
		}
		engine := semiont.WorkerAgentConfig{Agent: *s.role, ApiKeyEnv: providerKeyName(p, s.role.Provider)}
		if engine.BaseUrl, err = providerAddress(p, s.role.Provider, "the worker"); err != nil {
			return nil, err
		}
		at := 0
		for at < len(agents) && !sameEngine(agents[at], engine) {
			at++
		}
		if at == len(agents) {
			agents = append(agents, engine)
		}
		agents[at].Accepts = append(agents[at].Accepts, filter)
	}
	return agents, nil
}

// sameEngine: whether two agents are one — the same provider and model, at
// the same address, under the same key.
func sameEngine(a, b semiont.WorkerAgentConfig) bool {
	return a.Agent == b.Agent && a.BaseUrl == b.BaseUrl && reflect.DeepEqual(a.ApiKeyEnv, b.ApiKeyEnv)
}

// workerDocument renders the document from the start's placement. It is
// staged only for a worker the plan runs, and derivePlan refuses a roster that
// binds the worker a job when there is no WorkerPool document.
func workerDocument(p placement) ([]byte, error) {
	var doc semiont.WorkerConfig
	var err error
	doc.GatewayUrl = p.gatewayURL()
	doc.Identity.Issuer = p.issuer()
	if doc.Agents, err = workerAgents(p); err != nil {
		return nil, err
	}
	doc.ModelCatalogue = modelCatalogueTarget
	doc.Port = semiontDescriptor("worker").ports[0].port
	doc.LogLevel = p.st.Workers.Spec.LogLevel
	doc.LogFormat = semiont.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
