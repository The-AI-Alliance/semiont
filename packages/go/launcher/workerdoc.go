package launcher

// workerdoc.go — the worker's configuration document: WorkerConfig in specs/,
// the Go type generated from it (packages/go/sdk). The launcher writes it for
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

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// workerDocumentFile: the worker is configured by a document, not a copy of
// the KB's. One name, staged and mounted.
const workerDocumentFile = "worker.json"

// workerDocumentTarget: where the worker reads that document — the path its
// image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook holds
// the two together.
const workerDocumentTarget = "/etc/semiont/worker.json"

// jobFilter: the filter naming one job of the engines' `jobs`, as a claim
// states it: "mark.<motivation>" is the `mark` jobs of that motivation, and
// "yield" the `yield` jobs. TestEveryEngineJobHasAFilter holds it to every job
// the engines can give an engine.
func jobFilter(job string) (filter api.JobFilter, err error) {
	jobType, motivation, _ := strings.Cut(job, ".")
	switch {
	case jobType == string(api.MarkJobFilterJobTypeMark) && api.Motivation(motivation).Valid():
		var mark api.MarkJobFilter
		mark.Params.Motivation = api.Motivation(motivation)
		err = filter.FromMarkJobFilter(mark)
	case job == string(api.YieldJobFilterJobTypeYield):
		err = filter.FromYieldJobFilter(api.YieldJobFilter{})
	default:
		err = fmt.Errorf("the engines can give %q an engine, and no job filter names that job", job)
	}
	return filter, err
}

// providerAddress: where a provider's API is reached — the baseURL its entry
// in the Inference document states. An Ollama that states none is the
// machine's, at this start's address; an Anthropic that states none is
// reached where the launcher itself reaches Anthropic (remoteProviderAddress).
// Every other provider states one: the launcher keeps no vendor's address but
// Anthropic's, and runs no server but Ollama's. ONE decider, for the worker's
// engines and the Librarian actors'. who names the service in a refusal.
func providerAddress(p placement, provider api.EngineProvider, who string) (string, error) {
	baseURL := p.st.Inference.Spec.Providers[provider].BaseURL
	switch {
	case provider == api.EngineProviderOllama:
		return p.ollama(baseURL), nil
	case baseURL != nil:
		return *baseURL, nil
	case provider == api.EngineProviderAnthropic:
		return saasBase(remoteProviderAddress(p.st, string(provider))), nil
	}
	return "", planErr(p.st.Files.Inference, "spec.providers."+string(provider)+".baseURL", "is not stated: %s has no address to reach %s at", who, provider)
}

// providerKeyName: the variable holding a provider's key, as its entry in the
// Inference document names it; none when it names none.
func providerKeyName(p placement, provider api.EngineProvider) *string {
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
// the worker is handed — the key of each provider a job's engine names.
func workerSecrets(p placement) []string {
	var names []string
	for _, j := range jobEngines(p.st.Inference.Spec.Engines) {
		if name := providerKeyName(p, j.engine.Provider); name != nil && !contains(names, *name) {
			names = append(names, *name)
		}
	}
	return names
}

// jobEnginesAt: where the Inference document at inference gives jobs an
// engine, as the launcher names it for an operator to give one.
func jobEnginesAt(inference string) string {
	return inference + " spec.engines.jobs"
}

// errNoJobEngine: the refusal of a worker for an Inference document, at
// inference, that gives no job an engine.
func errNoJobEngine(inference string) error {
	return fmt.Errorf("no job has an engine: the worker has no job to do — give one an engine in %s", jobEnginesAt(inference))
}

// workerEngines: the engines the worker does its jobs with, projected from
// the engines the Inference document gives jobs (jobEngines). Each is a
// provider and a model, at one address, under one key, and takes every job
// given it: they are in the order of the first job that needs each, and each
// one's jobs in engineJobs' order. An Inference document that gives no job an
// engine has none, and is refused: the document's `engines` is never empty. A
// start of such a document runs no worker and writes no document (workerPlan),
// and a worker asked for by name is refused before anything runs
// (flowOneService).
func workerEngines(p placement) ([]api.WorkerEngineConfig, error) {
	given := jobEngines(p.st.Inference.Spec.Engines)
	if len(given) == 0 {
		return nil, errNoJobEngine(p.st.Files.Inference)
	}
	var engines []api.WorkerEngineConfig
	for _, j := range given {
		filter, err := jobFilter(j.job.name)
		if err != nil {
			return nil, err
		}
		engine := api.WorkerEngineConfig{Engine: *j.engine, ApiKeyEnv: providerKeyName(p, j.engine.Provider)}
		if engine.BaseUrl, err = providerAddress(p, j.engine.Provider, "the worker"); err != nil {
			return nil, err
		}
		at := 0
		for at < len(engines) && !sameEngine(engines[at], engine) {
			at++
		}
		if at == len(engines) {
			engines = append(engines, engine)
		}
		engines[at].Jobs = append(engines[at].Jobs, filter)
	}
	return engines, nil
}

// sameEngine: whether two of the worker's engines are one — the same
// provider and model, at the same address, under the same key.
func sameEngine(a, b api.WorkerEngineConfig) bool {
	return a.Engine == b.Engine && a.BaseUrl == b.BaseUrl && reflect.DeepEqual(a.ApiKeyEnv, b.ApiKeyEnv)
}

// workerDocument renders the document from the start's placement, the
// committed identity of the knowledge base it starts, and the knowledge bases
// added to this machine's worker (workerkbs.go). The first of its
// knowledgeBases is the one this start runs, at the gateway and the issuer it
// places, as this machine's own worker; then each added one, in the order
// they are kept. Every one is offered the same engines: the ones this start's
// Inference document gives jobs, on this machine's providers' keys
// (workerSecrets). It is staged only for a worker the plan runs, and
// derivePlan refuses an Inference document that gives a job an engine when
// there is no WorkerPool document.
func workerDocument(p placement, kbDomain string, added []addedKB) ([]byte, error) {
	if kbDomain == "" {
		return nil, fmt.Errorf("the knowledge base declares no site.domain in its .semiont/config.yaml: the worker has no knowledge base to confirm")
	}
	if err := refuseOwnKB(kbDomain, added); err != nil {
		return nil, err
	}
	engines, err := workerEngines(p)
	if err != nil {
		return nil, err
	}
	own := api.WorkerKnowledgeBaseConfig{Domain: kbDomain, GatewayUrl: p.gatewayURL(), Engines: engines}
	own.Identity.Issuer = p.issuer()
	own.Identity.ClientId = serviceClientID("worker")
	var doc api.WorkerConfig
	doc.KnowledgeBases = []api.WorkerKnowledgeBaseConfig{own}
	for _, kb := range added {
		doc.KnowledgeBases = append(doc.KnowledgeBases, kb.entry(engines))
	}
	doc.ModelCatalogue = modelCatalogueTarget
	doc.Port = semiontDescriptor("worker").ports[0].port
	doc.LogLevel = p.st.Workers.Spec.LogLevel
	doc.LogFormat = api.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
