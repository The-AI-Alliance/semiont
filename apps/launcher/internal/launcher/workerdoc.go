package launcher

// workerdoc.go — the worker's configuration document: WorkerConfig in specs/,
// the Go type generated from it (packages/sdk-go). The launcher writes it for
// the worker it starts, resolved — every ${VAR} a value, and every job's
// fallback applied — and mounts it where the worker's image points its
// `--config` flag, so the worker neither parses TOML nor resolves or defaults
// anything. Secrets are never values in it: a provider's key is a ${NAME} in
// the KB config, and the document names NAME.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// workerDocumentFile: the worker is configured by a document, not a copy of
// the KB's config. One name, staged and mounted.
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

// providerAddress: where a provider's API is reached — the address its section
// of the environment states, resolved. An Ollama the launcher places states
// none in the KB config, and loadConfig reads it as the launcher's own
// reference (topology.go), which resolves here to the address of this start.
// An Anthropic section that states none is reached where the launcher itself
// reaches Anthropic (remoteProviderAddress). ONE decider, for the worker's
// agents and the Librarian's two models. who names the service in a refusal.
func providerAddress(env *envConfig, envName string, provider semiont.ArchivistRosterRoleProvider, vars map[string]string, who string) (string, error) {
	section, declared := env.Inference[string(provider)]
	if !declared {
		return "", fmt.Errorf("the environment declares no [environments.%s.inference.%s]: %s has no address to reach %s at", envName, provider, who, provider)
	}
	if provider == semiont.ArchivistRosterRoleProviderAnthropic {
		if section.Endpoint == "" {
			return saasBase(remoteProviderAddress(env, string(provider))), nil
		}
		return resolveRefs("inference.anthropic.endpoint", section.Endpoint, vars)
	}
	// Every other provider is reached where its section says: the launcher keeps no vendor's address but
	// Anthropic's, and runs no server but Ollama's.
	if section.BaseURL == "" {
		return "", fmt.Errorf("[environments.%s.inference.%s] states no baseURL: %s has no address to reach %s at", envName, provider, who, provider)
	}
	// Each field is written out: the census of the sections the launcher resolves reads it from the call.
	switch provider {
	case semiont.ArchivistRosterRoleProviderGoogle:
		return resolveRefs("inference.google.baseURL", section.BaseURL, vars)
	case semiont.ArchivistRosterRoleProviderLlamacpp:
		return resolveRefs("inference.llamacpp.baseURL", section.BaseURL, vars)
	case semiont.ArchivistRosterRoleProviderOllama:
		return resolveRefs("inference.ollama.baseURL", section.BaseURL, vars)
	case semiont.ArchivistRosterRoleProviderOpenai:
		return resolveRefs("inference.openai.baseURL", section.BaseURL, vars)
	case semiont.ArchivistRosterRoleProviderTogether:
		return resolveRefs("inference.together.baseURL", section.BaseURL, vars)
	case semiont.ArchivistRosterRoleProviderVllm:
		return resolveRefs("inference.vllm.baseURL", section.BaseURL, vars)
	}
	return "", fmt.Errorf("%s's document has no address for the provider %q", who, provider)
}

// providerKeyName: the variable holding a provider's key, as its section of
// the environment names it; none when the section states no key.
func providerKeyName(env *envConfig, provider semiont.ArchivistRosterRoleProvider) (*string, error) {
	key := env.Inference[string(provider)].APIKey
	// Each field is written out: the census of the sections the launcher resolves reads it from the call.
	switch provider {
	case semiont.ArchivistRosterRoleProviderAnthropic:
		return secretName("inference.anthropic.apiKey", key)
	case semiont.ArchivistRosterRoleProviderGoogle:
		return secretName("inference.google.apiKey", key)
	case semiont.ArchivistRosterRoleProviderLlamacpp:
		return secretName("inference.llamacpp.apiKey", key)
	case semiont.ArchivistRosterRoleProviderOllama:
		return secretName("inference.ollama.apiKey", key)
	case semiont.ArchivistRosterRoleProviderOpenai:
		return secretName("inference.openai.apiKey", key)
	case semiont.ArchivistRosterRoleProviderTogether:
		return secretName("inference.together.apiKey", key)
	case semiont.ArchivistRosterRoleProviderVllm:
		return secretName("inference.vllm.apiKey", key)
	}
	return nil, nil
}

// modelCatalogueTarget: where the worker's image and the Librarian's each
// carry the model catalogue file, which each one's document names. A service
// reads the file only for a provider whose own API leaves a model's facts
// unsaid, and which those are is the service's to know, not the launcher's.
// TestModelCatalogueIsWhereTheImagesCarryIt holds this to the two Dockerfiles.
const modelCatalogueTarget = "/usr/share/semiont/model-catalogue.json"

// workerNamedVars: the variables the worker's document names rather than
// resolves — the key of each provider that serves a job — and so the ones the
// worker is handed. A key that is not exactly ${NAME} names nothing here;
// writing the document refuses it.
func workerNamedVars(env *envConfig) []string {
	var names []string
	served, _ := workerRoles(env)
	for _, s := range served {
		if name, _ := providerKeyName(env, s.role.Provider); name != nil && !contains(names, *name) {
			names = append(names, *name)
		}
	}
	return names
}

// workerBindingSection: the section that binds every job to a worker, as the
// launcher names it for an operator to add.
func workerBindingSection(envName string) string {
	return fmt.Sprintf("[environments.%s.workers.default.inference]", envName)
}

// workerAgents: the agents the worker works as, projected from the roles
// workerRoles resolves. An agent is an engine — a provider and a model, at one
// address, under one key — and accepts every job that engine serves: agents
// are in the order of the first job that needs each, and an agent's filters in
// workerJobs' order. An environment that binds no job has no agents, and is
// refused: the document's `agents` is never empty. A full start of such an
// environment runs no worker and writes no document (workerPlan); this is the
// refusal of a worker asked for by name.
func workerAgents(env *envConfig, envName string, vars map[string]string) ([]semiont.WorkerAgentConfig, error) {
	served, err := workerRoles(env)
	if err != nil {
		return nil, err
	}
	if len(served) == 0 {
		return nil, fmt.Errorf("the environment binds no job to a worker: the worker has no job to serve — add %s with a type (%s) and a model", workerBindingSection(envName), providerNames)
	}
	var agents []semiont.WorkerAgentConfig
	for _, s := range served {
		filter, err := jobFilter(s.job.name)
		if err != nil {
			return nil, err
		}
		engine := semiont.WorkerAgentConfig{Agent: *s.role}
		if engine.BaseUrl, err = providerAddress(env, envName, s.role.Provider, vars, "the worker"); err != nil {
			return nil, err
		}
		if engine.ApiKeyEnv, err = providerKeyName(env, s.role.Provider); err != nil {
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

// workerDocument renders the document from the selected environment and its
// name, the address the launcher computed, and the user's variables.
func workerDocument(env *envConfig, envName, rt, addr string, issuerPort int, userEnv []string) ([]byte, error) {
	if env.Gateway == nil || env.Gateway.PublicURL == "" {
		return nil, fmt.Errorf("the environment declares no [gateway] publicURL: the worker has no gateway to reach")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the worker has no issuer to sign in at")
	}
	vars := gatewayDialerVars(rt, addr, issuerPort, userEnv)
	var doc semiont.WorkerConfig
	var err error
	if doc.GatewayUrl, err = resolveRefs("gateway.publicURL", env.Gateway.PublicURL, vars); err != nil {
		return nil, err
	}
	if doc.Identity.Issuer, err = resolveRefs("identity.issuer", env.Identity.Issuer, vars); err != nil {
		return nil, err
	}
	if doc.Agents, err = workerAgents(env, envName, vars); err != nil {
		return nil, err
	}
	doc.ModelCatalogue = modelCatalogueTarget
	doc.Port = semiontDescriptor("worker").ports[0].port

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.LogLevel(env.LogLevel)
	}
	doc.LogFormat = semiont.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
