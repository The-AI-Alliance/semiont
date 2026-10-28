package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/stack"
)

// anthropicHaiku: Anthropic's haiku, as a roster binds it.
func anthropicHaiku() *api.ArchivistRosterRole {
	return &api.ArchivistRosterRole{Provider: api.ArchivistRosterRoleProviderAnthropic, Model: "claude-haiku-4-5-20251001"}
}

// withAnthropic: st with the anthropic provider stated, at Anthropic's own
// address, under the key named ANTHROPIC_API_KEY.
func withAnthropic(st *stack.Stack) {
	st.Inference.Spec.Providers[api.ArchivistRosterRoleProviderAnthropic] = stack.Provider{ApiKey: &stack.SecretRef{FromEnv: "ANTHROPIC_API_KEY"}}
}

// threeEngines: the ollama-gemma fixture with its highlighting jobs bound to
// Anthropic's haiku — three engines, one of them first needed after another's
// first job.
func threeEngines(t *testing.T) *stack.Stack {
	t.Helper()
	st := fixtureStack(t, "ollama-gemma")
	withAnthropic(st)
	st.Inference.Spec.Roster.Workers.Mark.Highlighting = anthropicHaiku()
	return st
}

func workerDocumentFrom(t *testing.T, b []byte) api.WorkerConfig {
	t.Helper()
	var doc api.WorkerConfig
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the document is not a WorkerConfig: %v\n%s", err, b)
	}
	return doc
}

func workerDocumentOf(t *testing.T, p placement) api.WorkerConfig {
	t.Helper()
	b, err := workerDocument(p)
	if err != nil {
		t.Fatal(err)
	}
	return workerDocumentFrom(t, b)
}

// jobOf: the job a filter names, as the roster keys it: "mark.tagging",
// "yield".
func jobOf(t *testing.T, filter api.JobFilter) string {
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
func acceptedBy(t *testing.T, doc api.WorkerConfig) []string {
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
func documentServes(t *testing.T, doc api.WorkerConfig) map[string]api.ArchivistRosterRole {
	t.Helper()
	serves := map[string]api.ArchivistRosterRole{}
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
func rosterServes(roster api.ArchivistRoster) map[string]api.ArchivistRosterRole {
	serves := map[string]api.ArchivistRosterRole{}
	for _, job := range workerJobs() {
		if role := job.slot(reflect.ValueOf(&roster.Workers).Elem()).Interface().(*api.ArchivistRosterRole); role != nil {
			serves[job.name] = *role
		}
	}
	return serves
}

// Every address is the placement's, each provider's key is named, and the log
// level is the WorkerPool's. Jobs one engine serves are one agent.
func TestWorkerDocumentStatesWhatThePlacementDecides(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	st.Workers.Spec.LogLevel = api.LogLevelDebug
	doc := workerDocumentOf(t, placed(t, st))
	want := []string{
		"anthropic/claude-sonnet-4-5-20250929: mark.assessing mark.linking yield",
		"anthropic/claude-haiku-4-5-20251001: mark.commenting mark.highlighting mark.tagging",
	}
	if got := acceptedBy(t, doc); !reflect.DeepEqual(got, want) {
		t.Errorf("agents =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
	for _, agent := range doc.Agents {
		if agent.BaseUrl != "https://api.anthropic.com" || agent.ApiKeyEnv == nil || *agent.ApiKeyEnv != "ANTHROPIC_API_KEY" {
			t.Errorf("%s/%s is reached at %q under %v, want the provider's baseURL and its key named", agent.Agent.Provider, agent.Agent.Model, agent.BaseUrl, agent.ApiKeyEnv)
		}
	}
	if doc.GatewayUrl != "http://192.168.64.1:14000" {
		t.Errorf("gatewayUrl = %q, want the gateway at the launcher's address", doc.GatewayUrl)
	}
	if doc.Identity.Issuer != "http://192.168.64.1:8080/realms/semiont" {
		t.Errorf("issuer = %q", doc.Identity.Issuer)
	}
	if doc.ModelCatalogue != "/usr/share/semiont/model-catalogue.json" {
		t.Errorf("modelCatalogue = %q, want where the image carries it", doc.ModelCatalogue)
	}
	if doc.Port != semiontDescriptor("worker").ports[0].port {
		t.Errorf("port = %d, want the descriptor's", doc.Port)
	}
	if doc.LogLevel != api.LogLevelDebug || doc.LogFormat != api.LogFormatJson {
		t.Errorf("log = %q %q, want the WorkerPool's level and JSON", doc.LogLevel, doc.LogFormat)
	}
}

// An agent is an engine: a provider and a model. Agents are in the order of
// the first job that needs each, an agent's filters in the jobs' order, and
// the same documents are the same document every time.
func TestWorkerDocumentGroupsJobsByEngineInJobOrder(t *testing.T) {
	b, err := workerDocument(placed(t, threeEngines(t)))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"ollama/gemma4:26b: mark.assessing mark.linking yield",
		"ollama/gemma4:e2b: mark.commenting mark.tagging",
		"anthropic/claude-haiku-4-5-20251001: mark.highlighting",
	}
	if got := acceptedBy(t, workerDocumentFrom(t, b)); !reflect.DeepEqual(got, want) {
		t.Errorf("agents =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
	for i := 0; i < 50; i++ {
		again, err := workerDocument(placed(t, threeEngines(t)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(again, b) {
			t.Fatalf("the same documents gave two worker documents:\n%s\nand\n%s", b, again)
		}
	}
}

// One roster, two projections: the agent the worker's document gives each job
// is the one the Archivist's roster names for it, so `browse:agents` names
// exactly the agents that claim the work.
func TestWorkerDocumentServesWhatTheRosterSays(t *testing.T) {
	yieldAlone := func(t *testing.T) *stack.Stack {
		st := fixtureStack(t, "ollama-gemma")
		st.Inference.Spec.Roster.Workers.Mark = nil
		return st
	}
	for why, st := range map[string]func(*testing.T) *stack.Stack{
		"the anthropic fixture":    func(t *testing.T) *stack.Stack { return fixtureStack(t, "anthropic") },
		"the ollama-gemma fixture": func(t *testing.T) *stack.Stack { return fixtureStack(t, "ollama-gemma") },
		"three engines":            threeEngines,
		"yield alone":              yieldAlone,
	} {
		p := placed(t, st(t))
		roster := archivistDocumentOf(t, p).Roster
		want := rosterServes(roster)
		if len(want) == 0 {
			t.Fatalf("%s: the roster serves no job — this case compares nothing", why)
		}
		if got := documentServes(t, workerDocumentOf(t, p)); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: the document serves %v\nthe roster says      %v", why, got, want)
		}
	}
}

// One roster decides whether there is a worker at all: the plan runs one
// exactly when the roster binds a job, which is exactly when the worker's
// document can be written. A roster that binds none has no document — `agents`
// is never empty — and the refusal names where a job is bound.
func TestPlanRunsAWorkerExactlyWhenTheRosterBindsAJob(t *testing.T) {
	for _, c := range []struct {
		why   string
		roles func(st *stack.Stack)
		want  presence
	}{
		{"every job bound", func(*stack.Stack) {}, presenceLauncher},
		{"yield alone", func(st *stack.Stack) { st.Inference.Spec.Roster.Workers.Mark = nil }, presenceLauncher},
		{"one motivation alone", func(st *stack.Stack) {
			st.Inference.Spec.Roster.Workers.Yield = nil
			mark := st.Inference.Spec.Roster.Workers.Mark
			mark.Assessing, mark.Commenting, mark.Highlighting, mark.Linking = nil, nil, nil, nil
		}, presenceLauncher},
		{"no job", func(st *stack.Stack) {
			st.Inference.Spec.Roster.Workers.Mark, st.Inference.Spec.Roster.Workers.Yield = nil, nil
		}, presenceAbsent},
	} {
		st := fixtureStack(t, "ollama-gemma")
		c.roles(st)
		p := placed(t, st)
		if got := p.plan.Roles["worker"].Presence; got != c.want {
			t.Errorf("%s: the plan's worker is %s, want %s", c.why, got, c.want)
		}
		_, err := workerDocument(p)
		switch {
		case c.want == presenceLauncher && err != nil:
			t.Errorf("%s: the plan runs a worker, and its document is refused: %v", c.why, err)
		case c.want == presenceAbsent && (err == nil || !strings.Contains(err.Error(), workerBinding(st.Files.Inference))):
			t.Errorf("%s: want a refusal naming %s, got %v", c.why, workerBinding(st.Files.Inference), err)
		}
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

// A provider's key is the variable its entry in the Inference document names;
// the worker's document names it, and the worker is handed exactly the names
// its document carries. An Ollama that names no key is asked without one.
func TestWorkerDocumentNamesAKey(t *testing.T) {
	p := placed(t, threeEngines(t))
	for _, agent := range workerDocumentOf(t, p).Agents {
		switch agent.Agent.Provider {
		case api.ArchivistRosterRoleProviderAnthropic:
			if agent.ApiKeyEnv == nil || *agent.ApiKeyEnv != "ANTHROPIC_API_KEY" {
				t.Errorf("the anthropic agent's apiKeyEnv = %v, want the key named", agent.ApiKeyEnv)
			}
		default:
			if agent.ApiKeyEnv != nil {
				t.Errorf("the %s agent's apiKeyEnv = %q, and its provider names no key", agent.Agent.Provider, *agent.ApiKeyEnv)
			}
		}
	}
	if got := strings.Join(workerSecrets(p), ","); got != "ANTHROPIC_API_KEY" {
		t.Errorf("the worker is handed %q, want exactly the names its document carries", got)
	}
}

// The key of a provider no job is bound to is not the worker's: its document
// does not name it, and it is not handed it.
func TestWorkerIsHandedOnlyTheKeysItsAgentsUse(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	withAnthropic(st)
	p := placed(t, st)
	b, err := workerDocument(p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "ANTHROPIC_API_KEY") || strings.Contains(string(b), "anthropic") {
		t.Errorf("the document names a provider no job is bound to:\n%s", b)
	}
	if got := workerSecrets(p); len(got) != 0 {
		t.Errorf("the worker is handed %v, and its document names no key", got)
	}
}

// A key is its provider's entry's to state, whichever the provider: an Ollama
// somebody else runs behind a key names it as Anthropic's is named.
func TestWorkerDocumentNamesTheKeyOfEveryProviderThatStatesOne(t *testing.T) {
	st := threeEngines(t)
	baseURL := "https://ollama.internal"
	st.Inference.Spec.Providers[api.ArchivistRosterRoleProviderOllama] = stack.Provider{BaseURL: &baseURL, ApiKey: &stack.SecretRef{FromEnv: "OLLAMA_API_KEY"}}
	p := placed(t, st)
	for _, agent := range workerDocumentOf(t, p).Agents {
		if agent.Agent.Provider != api.ArchivistRosterRoleProviderOllama {
			continue
		}
		if agent.ApiKeyEnv == nil || *agent.ApiKeyEnv != "OLLAMA_API_KEY" {
			t.Errorf("the ollama agent %s's apiKeyEnv = %v, want the key its entry names", agent.Agent.Model, agent.ApiKeyEnv)
		}
	}
	if got := strings.Join(workerSecrets(p), ","); got != "OLLAMA_API_KEY,ANTHROPIC_API_KEY" {
		t.Errorf("the worker is handed %q, want exactly the names its document carries", got)
	}
}

// An address a provider's entry states is the worker's, as written: a server
// somebody else runs, or a proxy in front of Anthropic.
func TestWorkerDocumentStatesAProvidersAddressAsItsEntryDoes(t *testing.T) {
	st := threeEngines(t)
	ollama, proxy := "http://ollama.internal:11434", "https://proxy.internal/v1"
	st.Inference.Spec.Providers[api.ArchivistRosterRoleProviderOllama] = stack.Provider{BaseURL: &ollama}
	st.Inference.Spec.Providers[api.ArchivistRosterRoleProviderAnthropic] = stack.Provider{BaseURL: &proxy, ApiKey: &stack.SecretRef{FromEnv: "ANTHROPIC_API_KEY"}}
	for _, agent := range workerDocumentOf(t, placed(t, st)).Agents {
		want := map[api.ArchivistRosterRoleProvider]string{
			api.ArchivistRosterRoleProviderOllama:    ollama,
			api.ArchivistRosterRoleProviderAnthropic: proxy,
		}[agent.Agent.Provider]
		if agent.BaseUrl != want {
			t.Errorf("%s/%s is reached at %q, want %q, as its entry states", agent.Agent.Provider, agent.Agent.Model, agent.BaseUrl, want)
		}
	}
}

// An Anthropic entry that states no baseURL is reached where the launcher
// itself reaches Anthropic for the remote-model check: one decider.
func TestWorkerDocumentReachesAnthropicWhereTheLauncherDoes(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	anthropic := st.Inference.Spec.Providers[api.ArchivistRosterRoleProviderAnthropic]
	anthropic.BaseURL = nil
	st.Inference.Spec.Providers[api.ArchivistRosterRoleProviderAnthropic] = anthropic
	p := placed(t, st)
	rp := p.plan.Roles["inference"]
	if rp.Driver != "anthropic" {
		t.Fatalf("the fixture's inference role is %q: this test compares against the remote-model check's address", rp.Driver)
	}
	doc := workerDocumentOf(t, p)
	if len(doc.Agents) == 0 {
		t.Fatal("the fixture binds no job")
	}
	for _, agent := range doc.Agents {
		if want := saasBase(rp.Address, rp.Port); agent.BaseUrl != want {
			t.Errorf("%s/%s is reached at %q, and the launcher checks its models at %q", agent.Agent.Provider, agent.Agent.Model, agent.BaseUrl, want)
		}
	}
}

// An Ollama entry that states no baseURL is the machine's, at the address this
// start places it.
func TestWorkerDocumentReachesTheOllamaTheLauncherPlaces(t *testing.T) {
	p := placed(t, fixtureStack(t, "ollama-gemma"))
	doc := workerDocumentOf(t, p)
	if len(doc.Agents) == 0 {
		t.Fatal("the fixture binds no job")
	}
	want := fmt.Sprintf("http://192.168.64.1:%d", p.plan.Roles["inference"].Port)
	for _, agent := range doc.Agents {
		if agent.BaseUrl != want {
			t.Errorf("%s/%s is reached at %q, and the launcher runs Ollama at %q", agent.Agent.Provider, agent.Agent.Model, agent.BaseUrl, want)
		}
	}
}

// The launcher mounts the document where the image's command points --config
// (TestConfigDocumentsAreWhereTheImagesLook), and hands the worker nothing
// else: no copy of the KB's documents, and no *_HOST variables, because its
// own document already carries every address. Its health port is the
// descriptor's, which the document carries, the launcher publishes and the
// image probes.
func TestWorkerDocumentIsWhereTheImageLooks(t *testing.T) {
	df, err := os.ReadFile(serviceDockerfile("worker"))
	if err != nil {
		t.Fatal(err)
	}

	args := strings.Join(workerArgs("/stage", exposure{rt: "container", addr: "1.2.3.4"}, "client-secret", "v", semiontDescriptor("worker").mem, nil, nil), " ")
	if want := "/stage/" + workerDocumentFile + ":" + workerDocumentTarget + ":ro"; !strings.Contains(args, want) {
		t.Errorf("the worker's document is not mounted onto %s:\n%s", workerDocumentTarget, args)
	}
	for _, unread := range []string{"GATEWAY_HOST", "OLLAMA_HOST", "KEYCLOAK_HOST", stack.Dir} {
		if strings.Contains(args, unread) {
			t.Errorf("the worker is handed %s, which it does not read:\n%s", unread, args)
		}
	}
	for _, handed := range []string{"SEMIONT_OIDC_CLIENT_ID=" + serviceClientID("worker"), "SEMIONT_OIDC_CLIENT_SECRET=client-secret"} {
		if !strings.Contains(args, handed) {
			t.Errorf("the worker is not handed its service account (%s):\n%s", handed, args)
		}
	}

	port := fmt.Sprint(workerDocumentOf(t, placed(t, fixtureStack(t, "ollama-gemma"))).Port)
	if want := "--publish 1.2.3.4:" + port + ":" + port; !strings.Contains(args, want) {
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
