package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// The KB config a `semiont init` writes, as far as the worker's document reads
// it: two motivations bound to one engine and `yield` to another, written in
// an order that is not the jobs'.
const workerDocFixture = `[defaults]
environment = "local"

[environments.local]
logLevel = "debug"

[environments.local.gateway]
platform = "container"
port = 4000
publicURL = "http://${GATEWAY_HOST:-localhost}:4000"

[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
subjectClaim = "sub"

[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.inference.ollama]
platform = "posix"
baseURL = "http://${OLLAMA_HOST}:11434"

[environments.local.workers.yield.inference]
type = "ollama"
model = "gemma4:26b"

[environments.local.workers.mark.tagging.inference]
type = "anthropic"
model = "claude-haiku-4-5"

[environments.local.workers.mark.highlighting.inference]
type = "anthropic"
model = "claude-haiku-4-5"
`

func workerDocumentFrom(t *testing.T, b []byte) semiont.WorkerConfig {
	t.Helper()
	var doc semiont.WorkerConfig
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a WorkerConfig: %v\n%s", err, b)
	}
	return doc
}

// jobOf: the job a filter names, as the roster keys it: "mark.tagging",
// "yield".
func jobOf(t *testing.T, filter semiont.JobFilter) string {
	t.Helper()
	b, err := json.Marshal(filter)
	if err != nil {
		t.Fatal(err)
	}
	var named struct {
		JobType string `json:"jobType"`
		Params  *struct {
			Motivation string `json:"motivation"`
		} `json:"params"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&named); err != nil {
		t.Fatalf("the filter %s states more than a job type and a motivation: %v", b, err)
	}
	if named.Params != nil {
		return named.JobType + "." + named.Params.Motivation
	}
	return named.JobType
}

// acceptedBy: the jobs each agent of a document accepts, in the document's
// order, each agent written "provider/model: job job".
func acceptedBy(t *testing.T, doc semiont.WorkerConfig) []string {
	t.Helper()
	var agents []string
	for _, agent := range doc.Agents {
		var jobs []string
		for _, filter := range agent.Accepts {
			jobs = append(jobs, jobOf(t, filter))
		}
		agents = append(agents, fmt.Sprintf("%s/%s: %s", agent.Agent.Provider, agent.Agent.Model, strings.Join(jobs, " ")))
	}
	return agents
}

// documentServes: the agent a document gives each job. A job two agents accept
// is a job two workers would claim.
func documentServes(t *testing.T, doc semiont.WorkerConfig) map[string]semiont.ArchivistRosterRole {
	t.Helper()
	serves := map[string]semiont.ArchivistRosterRole{}
	for _, agent := range doc.Agents {
		for _, filter := range agent.Accepts {
			job := jobOf(t, filter)
			if _, twice := serves[job]; twice {
				t.Errorf("two agents accept %s", job)
			}
			serves[job] = agent.Agent
		}
	}
	return serves
}

// rosterServes: the agent a roster gives each job.
func rosterServes(roster semiont.ArchivistRoster) map[string]semiont.ArchivistRosterRole {
	serves := map[string]semiont.ArchivistRosterRole{}
	for _, job := range workerJobs() {
		if role := job.slot(reflect.ValueOf(&roster.Workers).Elem()).Interface().(*semiont.ArchivistRosterRole); role != nil {
			serves[job.name] = *role
		}
	}
	return serves
}

// Resolved: every ${VAR} a value, every job's fallback applied, and each
// provider's key named, never carried. Jobs one engine serves are one agent.
func TestWorkerDocumentIsExactlyTheResolvedConfig(t *testing.T) {
	b, err := workerDocument(envFrom(t, workerDocFixture), "local", "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{
  "agents": [
    {
      "accepts": [
        {
          "jobType": "mark",
          "params": {
            "motivation": "highlighting"
          }
        },
        {
          "jobType": "mark",
          "params": {
            "motivation": "tagging"
          }
        }
      ],
      "agent": {
        "model": "claude-haiku-4-5",
        "provider": "anthropic"
      },
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "baseUrl": "https://api.anthropic.com"
    },
    {
      "accepts": [
        {
          "jobType": "yield"
        }
      ],
      "agent": {
        "model": "gemma4:26b",
        "provider": "ollama"
      },
      "baseUrl": "http://192.168.64.1:11434"
    }
  ],
  "gatewayUrl": "http://192.168.64.1:4000",
  "identity": {
    "issuer": "http://192.168.64.1:8080/realms/semiont"
  },
  "logFormat": "json",
  "logLevel": "debug",
  "port": 24100
}`
	if string(b) != want {
		t.Errorf("the document is\n%s\nwant\n%s", b, want)
	}
	if doc := workerDocumentFrom(t, b); doc.Port != semiontDescriptor("worker").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
}

// An agent is an engine: a provider and a model. Agents are in the order of
// the first job that needs each, an agent's filters in the jobs' order, and
// the same config is the same document every time.
func TestWorkerDocumentGroupsJobsByEngineInJobOrder(t *testing.T) {
	text := workerDocFixture + `
[environments.local.workers.default.inference]
type = "ollama"
model = "gemma4:26b"

[environments.local.workers.mark.linking.inference]
type = "ollama"
model = "gemma4:e2b"
`
	b, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"ollama/gemma4:26b: mark.assessing mark.commenting yield",
		"anthropic/claude-haiku-4-5: mark.highlighting mark.tagging",
		"ollama/gemma4:e2b: mark.linking",
	}
	if got := acceptedBy(t, workerDocumentFrom(t, b)); !reflect.DeepEqual(got, want) {
		t.Errorf("agents =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
	for i := 0; i < 50; i++ {
		again, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(again, b) {
			t.Fatalf("the same config gave two documents:\n%s\nand\n%s", b, again)
		}
	}
}

// One resolution, two projections: for every case of the shared table, the
// agent the worker's document gives each job is the one the Archivist's roster
// names for it, so `browse:agents` names exactly the agents that claim the
// work.
func TestWorkerDocumentServesWhatTheRosterSays(t *testing.T) {
	served := 0
	for _, c := range readSharedRosterTable(t).Cases {
		t.Run(c.Why, func(t *testing.T) {
			var roster semiont.ArchivistRoster
			dec := json.NewDecoder(bytes.NewReader(c.Roster))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&roster); err != nil {
				t.Fatalf("the case's roster is not an ArchivistRoster: %v", err)
			}
			want := rosterServes(roster)
			served += len(want)

			// A case is a roster's config, not a start's: it states no gateway
			// and no issuer, and it writes its key as a literal, which a
			// document refuses.
			env := envFrom(t, c.Config)
			env.Gateway = &gatewayCfg{PublicURL: "http://gateway.internal:4000"}
			env.Identity = &identityCfg{Issuer: "http://issuer.internal/realms/semiont"}
			for name, provider := range env.Inference {
				if provider.APIKey != "" {
					provider.APIKey = "${PROVIDER_KEY}"
					env.Inference[name] = provider
				}
			}
			b, err := workerDocument(env, "local", "container", "192.168.64.1", 8080, nil)
			if len(want) == 0 {
				if err == nil || !strings.Contains(err.Error(), "[environments.local.workers.default.inference]") {
					t.Fatalf("the roster serves no job: want a refusal naming the section to add, got %v\n%s", err, b)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := documentServes(t, workerDocumentFrom(t, b)); !reflect.DeepEqual(got, want) {
				t.Errorf("the document serves %v\nthe roster says      %v", got, want)
			}
		})
	}
	if served == 0 {
		t.Fatal("no case of the shared table serves a job: a gate that compares nothing passes on silence")
	}
}

// One resolution decides whether there is a worker at all: for every case of
// the shared table, the plan runs one exactly when the case's roster serves a
// job — which is exactly when the worker's document can be written
// (TestWorkerDocumentServesWhatTheRosterSays).
func TestPlanRunsAWorkerExactlyWhenTheRosterServesAJob(t *testing.T) {
	ran, absent := 0, 0
	for _, c := range readSharedRosterTable(t).Cases {
		var roster semiont.ArchivistRoster
		if err := json.Unmarshal(c.Roster, &roster); err != nil {
			t.Fatalf("%s: the case's roster is not an ArchivistRoster: %v", c.Why, err)
		}
		serves := len(rosterServes(roster))
		want := presenceAbsent
		if serves > 0 {
			want = presenceLauncher
			ran++
		} else {
			absent++
		}
		if got := workerPlan(envFrom(t, c.Config)).Presence; got != want {
			t.Errorf("%s: the roster serves %d jobs and the plan's worker is %s", c.Why, serves, got)
		}
	}
	if ran == 0 || absent == 0 {
		t.Fatalf("the shared table has %d cases with a worker and %d without: this gate needs both", ran, absent)
	}
}

// Every job the roster has a worker role for has a filter that names it: a job
// the roster gained and no filter describes would be served by an agent that
// claims nothing.
func TestEveryRosterJobHasAFilter(t *testing.T) {
	jobs := workerJobs()
	if len(jobs) == 0 {
		t.Fatal("the roster has no worker job: a gate that checks nothing passes on silence")
	}
	for _, job := range jobs {
		filter, err := jobFilter(job.name)
		if err != nil {
			t.Errorf("%s: %v", job.name, err)
			continue
		}
		if got := jobOf(t, filter); got != job.name {
			t.Errorf("the filter for %s names %s", job.name, got)
		}
	}
	if _, err := jobFilter("mark.no-such-motivation"); err == nil {
		t.Error("a motivation no mark job has was given a filter")
	}
	if _, err := jobFilter("beckon"); err == nil {
		t.Error("a job type no worker serves was given a filter")
	}
}

// A provider's key is a ${NAME} in the KB config; the document names NAME, and
// the worker is handed exactly the names its document carries.
func TestWorkerDocumentNamesAKeyAndNeverCarriesIt(t *testing.T) {
	userEnv := []string{"--env", "ANTHROPIC_API_KEY=the-key-value"}
	b, err := workerDocument(envFrom(t, workerDocFixture), "local", "container", "192.168.64.1", 8080, userEnv)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "the-key-value") {
		t.Fatalf("a secret value reached the document:\n%s", b)
	}
	doc := workerDocumentFrom(t, b)
	if len(doc.Agents) != 2 {
		t.Fatalf("agents = %v, want the two the fixture binds", acceptedBy(t, doc))
	}
	if key := doc.Agents[0].ApiKeyEnv; key == nil || *key != "ANTHROPIC_API_KEY" {
		t.Errorf("the anthropic agent's apiKeyEnv = %v, want the key named", key)
	}
	if key := doc.Agents[1].ApiKeyEnv; key != nil {
		t.Errorf("the ollama agent's apiKeyEnv = %q, and its section states no key", *key)
	}
	if got := workerNamedVars(envFrom(t, workerDocFixture)); strings.Join(got, ",") != "ANTHROPIC_API_KEY" {
		t.Errorf("the worker is handed %v, want exactly the names its document carries", got)
	}
}

// The key of a provider no job is bound to is not the worker's: its document
// does not name it, and it is not handed it.
func TestWorkerIsHandedOnlyTheKeysItsAgentsUse(t *testing.T) {
	text := strings.ReplaceAll(workerDocFixture, "type = \"anthropic\"\nmodel = \"claude-haiku-4-5\"", "type = \"ollama\"\nmodel = \"gemma4:e2b\"")
	b, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "ANTHROPIC_API_KEY") || strings.Contains(string(b), "anthropic") {
		t.Errorf("the document names a provider no job is bound to:\n%s", b)
	}
	if got := workerNamedVars(envFrom(t, text)); len(got) != 0 {
		t.Errorf("the worker is handed %v, and its document names no key", got)
	}
}

// A key is its provider's section's to state, whichever the provider: an
// Ollama somebody else runs behind a key names it as Anthropic's is named.
func TestWorkerDocumentNamesTheKeyOfEveryProviderThatStatesOne(t *testing.T) {
	text := strings.Replace(workerDocFixture, "platform = \"posix\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"", "platform = \"external\"\nbaseURL = \"https://ollama.internal\"\napiKey = \"${OLLAMA_API_KEY}\"", 1)
	if !strings.Contains(text, "OLLAMA_API_KEY") {
		t.Fatal("the fixture's [inference.ollama] no longer reads as this test expects")
	}
	b, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, []string{"--env", "OLLAMA_API_KEY=the-ollama-key"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "the-ollama-key") {
		t.Fatalf("a secret value reached the document:\n%s", b)
	}
	if key := workerDocumentFrom(t, b).Agents[1].ApiKeyEnv; key == nil || *key != "OLLAMA_API_KEY" {
		t.Errorf("the ollama agent's apiKeyEnv = %v, want the key its section states, named", key)
	}
	if got := workerNamedVars(envFrom(t, text)); strings.Join(got, ",") != "ANTHROPIC_API_KEY,OLLAMA_API_KEY" {
		t.Errorf("the worker is handed %v, want exactly the names its document carries", got)
	}
}

func TestWorkerDocumentRefusesALiteralKey(t *testing.T) {
	text := strings.Replace(workerDocFixture, `apiKey = "${ANTHROPIC_API_KEY}"`, `apiKey = "sk-live-secret"`, 1)
	_, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
	if err == nil || !strings.Contains(err.Error(), "inference.anthropic.apiKey") || !strings.Contains(err.Error(), "${") {
		t.Fatalf("want a refusal naming the field and the ${VAR} form, got %v", err)
	}
	if strings.Contains(err.Error(), "sk-live-secret") {
		t.Fatalf("the refusal repeated the secret: %v", err)
	}
	if got := workerNamedVars(envFrom(t, text)); len(got) != 0 {
		t.Errorf("a literal key names %v", got)
	}
}

// A job bound to a provider the environment has no section for is refused by
// the section's name: the worker would have no address to reach it at.
func TestWorkerDocumentRefusesAProviderWithNoSection(t *testing.T) {
	for _, provider := range []string{"anthropic", "ollama"} {
		env := envFrom(t, workerDocFixture)
		delete(env.Inference, provider)
		_, err := workerDocument(env, "local", "container", "192.168.64.1", 8080, nil)
		if want := "[environments.local.inference." + provider + "]"; err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("no %s section: want a refusal naming %s, got %v", provider, want, err)
		}
	}
}

// An environment that binds no job to a worker has no document: `agents` is
// never empty. The refusal names the section an operator adds, in the
// environment the start selected, and what it needs.
func TestWorkerDocumentRefusesAnEnvironmentThatBindsNoJob(t *testing.T) {
	unbound := workerDocFixture[:strings.Index(workerDocFixture, "[environments.local.workers")]
	text := strings.NewReplacer(`environment = "local"`, `environment = "staging"`, "[environments.local", "[environments.staging").Replace(unbound)
	_, err := workerDocument(envFrom(t, text), "staging", "container", "192.168.64.1", 8080, nil)
	if err == nil {
		t.Fatal("a document was written for a worker that serves no job")
	}
	for _, want := range []string{"[environments.staging.workers.default.inference]", "type", "model"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not say %q: %v", want, err)
		}
	}
}

func TestWorkerDocumentRefusesAMissingGatewayOrIssuer(t *testing.T) {
	noGateway := strings.Replace(workerDocFixture, `publicURL = "http://${GATEWAY_HOST:-localhost}:4000"`, "", 1)
	if _, err := workerDocument(envFrom(t, noGateway), "local", "container", "192.168.64.1", 8080, nil); err == nil || !strings.Contains(err.Error(), "publicURL") {
		t.Errorf("no publicURL: want a refusal naming it, got %v", err)
	}
	env := envFrom(t, workerDocFixture)
	env.Identity = nil
	if _, err := workerDocument(env, "local", "container", "192.168.64.1", 8080, nil); err == nil || !strings.Contains(err.Error(), "identity") {
		t.Errorf("no [identity]: want a refusal naming it, got %v", err)
	}
}

// A malformed binding is refused by its place in the config, as the roster
// refuses it: the two are one resolution.
func TestWorkerDocumentRefusesAMalformedBinding(t *testing.T) {
	text := workerDocFixture + "\n[environments.local.workers.mark.assessing.inference]\ntype = \"openai\"\nmodel = \"m\"\n"
	_, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
	if err == nil || !strings.Contains(err.Error(), "workers.mark.assessing.inference") {
		t.Errorf("want a refusal naming the binding, got %v", err)
	}
}

// An address a provider's section states is the worker's, as written and
// resolved: a daemon somebody else runs, or an operator's own variable.
func TestWorkerDocumentStatesAProvidersAddressAsItsSectionDoes(t *testing.T) {
	text := strings.Replace(workerDocFixture, "platform = \"posix\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"", "platform = \"external\"\nbaseURL = \"http://ollama.internal:11434\"", 1)
	text = strings.Replace(text, `endpoint = "https://api.anthropic.com"`, `endpoint = "https://${ANTHROPIC_PROXY}/v1"`, 1)
	if !strings.Contains(text, "ollama.internal") || !strings.Contains(text, "ANTHROPIC_PROXY") {
		t.Fatal("the fixture's provider sections no longer read as this test expects")
	}
	b, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, []string{"--env", "ANTHROPIC_PROXY=proxy.internal"})
	if err != nil {
		t.Fatal(err)
	}
	doc := workerDocumentFrom(t, b)
	if got := doc.Agents[0].BaseUrl; got != "https://proxy.internal/v1" {
		t.Errorf("the anthropic agent's baseUrl = %q, want the stated endpoint, resolved", got)
	}
	if got := doc.Agents[1].BaseUrl; got != "http://ollama.internal:11434" {
		t.Errorf("the ollama agent's baseUrl = %q, want the stated address", got)
	}
	if _, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil); err == nil || !strings.Contains(err.Error(), "inference.anthropic.endpoint") || !strings.Contains(err.Error(), "ANTHROPIC_PROXY") {
		t.Errorf("an unset variable in the endpoint: want a refusal naming the field and the variable, got %v", err)
	}
}

// An Anthropic section that states no endpoint is reached where the launcher
// itself reaches Anthropic for the remote-model check: one decider.
func TestWorkerDocumentReachesAnthropicWhereTheLauncherDoes(t *testing.T) {
	cfg := []byte(strings.Replace(string(fixtureConfig(t, "anthropic.toml")), "endpoint = \"https://api.anthropic.com\"\n", "", 1))
	if strings.Contains(string(cfg), "endpoint") {
		t.Fatal("the fixture's [inference.anthropic] no longer reads as this test expects")
	}
	env, plan := loadedFrom(t, cfg)
	rp := plan.Roles["inference"]
	if rp.Driver != "anthropic" {
		t.Fatalf("the fixture's inference role is %q: this test compares against the remote-model check's address", rp.Driver)
	}
	b, err := workerDocument(env, plan.EnvName, "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := workerDocumentFrom(t, b)
	if len(doc.Agents) == 0 {
		t.Fatal("the fixture binds no job")
	}
	for _, agent := range doc.Agents {
		if want := saasBase(rp.Address, rp.Port); agent.BaseUrl != want {
			t.Errorf("%s/%s is reached at %q, and the launcher checks its models at %q", agent.Agent.Provider, agent.Agent.Model, agent.BaseUrl, want)
		}
	}
}

// An Ollama the launcher places states no address in the KB config: loadConfig
// reads it as the launcher's own reference, and the document resolves that to
// the address of this start.
func TestWorkerDocumentReachesTheOllamaTheLauncherPlaces(t *testing.T) {
	env, plan := loadedFrom(t, withoutAddresses(fixtureConfig(t, "ollama-gemma.toml")))
	b, err := workerDocument(env, plan.EnvName, "container", "192.168.64.1", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := workerDocumentFrom(t, b)
	if len(doc.Agents) == 0 {
		t.Fatal("the fixture binds no job")
	}
	want := fmt.Sprintf("http://192.168.64.1:%d", plan.Roles["inference"].Port)
	for _, agent := range doc.Agents {
		if agent.BaseUrl != want {
			t.Errorf("%s/%s is reached at %q, and the launcher runs Ollama at %q", agent.Agent.Provider, agent.Agent.Model, agent.BaseUrl, want)
		}
	}
}

// An Ollama somebody else runs is where its section says, and a section that
// says nowhere is refused by name.
func TestWorkerDocumentRefusesAnOllamaWithNoAddress(t *testing.T) {
	text := strings.Replace(workerDocFixture, "platform = \"posix\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"", "platform = \"external\"", 1)
	_, err := workerDocument(envFrom(t, text), "local", "container", "192.168.64.1", 8080, nil)
	if err == nil || !strings.Contains(err.Error(), "[environments.local.inference.ollama]") || !strings.Contains(err.Error(), "baseURL") {
		t.Errorf("want a refusal naming the section and the key, got %v", err)
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and hands the worker nothing
// else: no copy of the KB's config, and no *_HOST variables, because the
// document already carries every address. Its health port is the descriptor's,
// which the document carries, the launcher publishes and the image probes.
func TestWorkerDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "worker", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}

	args := strings.Join(workerArgs("/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil), " ")
	if want := "/stage/" + workerDocumentFile + ":" + workerDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the worker's document is not mounted onto %s:\n%s", workerDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "BACKEND_HOST", "OLLAMA_HOST", "KEYCLOAK_HOST", ".semiontconfig", ".toml"} {
		if strings.Contains(args, unread) {
			t.Errorf("the worker is handed %s, which it does not read:\n%s", unread, args)
		}
	}
	for _, handed := range []string{"SEMIONT_OIDC_CLIENT_ID=" + serviceClientID("worker"), "SEMIONT_OIDC_CLIENT_SECRET=client-secret"} {
		if !strings.Contains(args, handed) {
			t.Errorf("the worker is not handed its service account (%s):\n%s", handed, args)
		}
	}

	b, err := workerDocument(envFrom(t, workerDocFixture), "local", "container", "1.2.3.4", 8080, nil)
	if err != nil {
		t.Fatal(err)
	}
	port := fmt.Sprint(workerDocumentFrom(t, b).Port)
	if want := "--publish " + port + ":" + port; !strings.Contains(args, want) {
		t.Errorf("the worker's health port is not published (%s):\n%s", want, args)
	}
	for label, re := range map[string]*regexp.Regexp{
		"EXPOSE":          regexp.MustCompile(`(?m)^EXPOSE (\d+)`),
		"HEALTHCHECK":     regexp.MustCompile(`localhost:(\d+)/health`),
		"SUPERVISE_PROBE": regexp.MustCompile(`SUPERVISE_PROBE=http://localhost:(\d+)/health`),
	} {
		if m := re.FindSubmatch(df); m == nil || string(m[1]) != port {
			t.Errorf("the worker image's %s disagrees with the port its document carries, %s", label, port)
		}
	}
}
