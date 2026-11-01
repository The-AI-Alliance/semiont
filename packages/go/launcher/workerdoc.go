package launcher

// workerdoc.go — the worker's configuration document: WorkerConfig in specs/,
// the Go type generated from it (packages/go/sdk). The launcher writes it for
// the machine's one worker from the knowledge bases on its list
// (workerkbs.go), every address a literal (placement), keeps it with the
// machine's containers' configs, and mounts it where the worker's image points
// its `--config` flag, so the worker neither reads a knowledge base's
// documents nor resolves or defaults anything. Secrets are never values in
// it: a provider's key is a variable an Inference document names (`fromEnv`),
// and the document names it.

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
// the worker is handed — the key of each provider an engine names: this
// start's jobs' engines, and those of every other local knowledge base on the
// list this start leaves (planWorkerServing). An added knowledge base is
// offered a local one's engines, so it names none of its own.
func workerSecrets(p placement) []string {
	var names []string
	add := func(name *string) {
		if name != nil && !contains(names, *name) {
			names = append(names, *name)
		}
	}
	for _, j := range jobEngines(p.st.Inference.Spec.Engines) {
		add(providerKeyName(p, j.engine.Provider))
	}
	for _, kb := range p.plan.Serving.others.Local {
		for _, e := range kb.Engines {
			add(e.ApiKeyEnv)
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
// engine has none, and is refused: an entry's `engines` is never empty. A
// start of such a document puts no entry on the worker's list (workerPlan,
// flowWorker), and a worker asked for by name is refused before anything runs
// (flowServices).
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

// workerEntry: the knowledge base at kbDomain's entry on the worker's list,
// as this start places it: at the gateway and the issuer it places, signed in
// at as this machine's own worker, and offered the engines its Inference
// document gives jobs (workerEngines).
func workerEntry(p placement, kbDomain string) (api.WorkerKnowledgeBaseConfig, error) {
	engines, err := workerEngines(p)
	if err != nil {
		return api.WorkerKnowledgeBaseConfig{}, err
	}
	entry := api.WorkerKnowledgeBaseConfig{Domain: kbDomain, GatewayUrl: p.gatewayURL(), Engines: engines}
	entry.Identity.Issuer = p.issuer()
	entry.Identity.ClientId = serviceClientID("worker")
	return entry, nil
}

// workerDocument renders the document for the machine's worker from the
// entries its list serves (workerList.served), in their order, and the
// machine's worker document, whose log level it carries.
func workerDocument(entries []api.WorkerKnowledgeBaseConfig, pool workerPoolDocument) ([]byte, error) {
	var doc api.WorkerConfig
	doc.KnowledgeBases = entries
	doc.ModelCatalogue = modelCatalogueTarget
	doc.Port = semiontDescriptor("worker").ports[0].port
	doc.LogLevel = pool.spec.LogLevel
	doc.LogFormat = api.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
