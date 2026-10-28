package launcher

// The executable spec for derivePlan, the pure function from a knowledge
// base's documents to the launcher's plan: for the fixture's two Inference
// documents it must derive the plan pinned here, field for field, and for
// variants of them the documented alternatives. The fixture is the one the
// black-box suite reads (testdata/kb); each variant is a fresh copy of it,
// changed as a document would state the change.

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

func mustPlan(t *testing.T, st *stack.Stack) *launchPlan {
	t.Helper()
	plan, err := derivePlan(st, 8080)
	if err != nil {
		t.Fatalf("derivePlan: %v", err)
	}
	return plan
}

// mustRefuse derives and requires a refusal naming the given fragments. The
// message is the deliverable here: documents the stack cannot run must be
// refused BEFORE anything is launched, and saying where is the whole value.
func mustRefuse(t *testing.T, st *stack.Stack, want ...string) {
	t.Helper()
	plan, err := derivePlan(st, 8080)
	if err == nil {
		t.Fatalf("derivePlan accepted documents the stack cannot run: %+v", plan.Roles)
	}
	for _, w := range want {
		if !strings.Contains(err.Error(), w) {
			t.Errorf("refusal missing %q; got: %v", w, err)
		}
	}
}

// asSomebodyElses: st with role's daemon stated as somebody else's —
// `external` in place of `image` and `resources`, as the schema has it.
func asSomebodyElses(st *stack.Stack, role string) {
	switch role {
	case "graph":
		g := &st.KnowledgeIndex.Spec.Graph
		g.Image, g.Resources = nil, nil
		g.External = &stack.KnowledgeIndexGraphExternal{Uri: "bolt://graph.example.com:9999", Password: stack.SecretRef{FromEnv: "EXT_GRAPH_PASSWORD"}}
	case "vectors":
		v := &st.KnowledgeIndex.Spec.Vectors
		v.Image, v.Resources = nil, nil
		v.External = &stack.HostPort{Host: "vectors.example.com", Port: 6334}
	case "database":
		d := &st.Issuer.Spec.Database
		d.Image, d.Resources = nil, nil
		d.External = &stack.IssuerDatabaseExternal{Host: "db.example.com", Port: 5433, Password: stack.SecretRef{FromEnv: "EXT_DB_PASSWORD"}}
	case "messaging":
		m := &st.KnowledgeBase.Spec.Messaging
		m.Image, m.Resources = nil, nil
		m.External = &stack.KnowledgeBaseMessagingExternal{Servers: "nats.example.com:4223",
			User: stack.SecretRef{FromEnv: "EXT_NATS_USER"}, Password: stack.SecretRef{FromEnv: "EXT_NATS_PASSWORD"}}
	default:
		panic("no daemon of the fixture is " + role)
	}
}

func checkRole(t *testing.T, plan *launchPlan, role string, want rolePlan) {
	t.Helper()
	got, ok := plan.Roles[role]
	if !ok {
		t.Fatalf("role %s missing from plan", role)
	}
	if got.Presence != want.Presence {
		t.Errorf("%s presence: got %v want %v", role, got.Presence, want.Presence)
	}
	if got.Driver != want.Driver {
		t.Errorf("%s driver: got %q want %q", role, got.Driver, want.Driver)
	}
	if got.User != want.User {
		t.Errorf("%s user: got %q want %q", role, got.User, want.User)
	}
	if got.Image != want.Image {
		t.Errorf("%s image: got %q want %q", role, got.Image, want.Image)
	}
	if got.Memory != want.Memory {
		t.Errorf("%s memory: got %q want %q", role, got.Memory, want.Memory)
	}
	if got.Port != want.Port {
		t.Errorf("%s port: got %d want %d", role, got.Port, want.Port)
	}
	if fmt.Sprint(got.Models) != fmt.Sprint(want.Models) {
		t.Errorf("%s models: got %v want %v", role, got.Models, want.Models)
	}
	if strings.Join(got.Env, " ") != strings.Join(want.Env, " ") {
		t.Errorf("%s env: got %v want %v", role, got.Env, want.Env)
	}
	if got.Address != want.Address {
		t.Errorf("%s address: got %q want %q", role, got.Address, want.Address)
	}
}

// Both of the fixture's Inference documents derive exactly the plan pinned
// here.
func TestDerivePlanTemplateConfigs(t *testing.T) {
	ollama := descriptorFor("inference", "ollama").image
	for _, name := range []string{"ollama-gemma", "anthropic"} {
		t.Run(name, func(t *testing.T) {
			plan := mustPlan(t, fixtureStack(t, name))
			checkRole(t, plan, "graph", rolePlan{
				Presence: presenceLauncher, Driver: "neo4j",
				Image: "neo4j:5.26.28-community@sha256:ff32db30b2baff97971e441b46bfd9c832c1b62c970398ef579244c06b21d357", Memory: "2G", Port: 7687,
				User: "neo4j", Env: []string{"NEO4J_ACCEPT_LICENSE_AGREEMENT=yes"},
			})
			checkRole(t, plan, "vectors", rolePlan{
				Presence: presenceLauncher, Driver: "qdrant",
				Image: "qdrant/qdrant:v1.19.1@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10", Memory: "2G", Port: 6333,
			})
			// embedding: with ollama bindings, the inference role runs the
			// Ollama and embedding rides along (external, sharing it). With
			// all-remote bindings, embedding OWNS the host-process dance —
			// that Ollama exists for it alone.
			if name == "anthropic" {
				checkRole(t, plan, "embedding", rolePlan{
					Presence: presenceHostPreferred, Driver: "ollama",
					Image: ollama, Port: 11434,
					Models: []servedModel{{Model: "nomic-embed-text", Provider: "ollama"}},
				})
			} else {
				checkRole(t, plan, "embedding", rolePlan{
					Presence: presenceExternal, Driver: "ollama",
					Address: "localhost", Port: 11434,
					Models: []servedModel{{Model: "nomic-embed-text", Provider: "ollama"}},
				})
				if got := plan.Roles["embedding"].SharesOllamaWith; got != "inference" {
					t.Errorf("the embedding shares the Ollama of %q, want the inference role's", got)
				}
			}
			checkRole(t, plan, "database", rolePlan{
				Presence: presenceLauncher, Driver: "postgres",
				Image: "postgres:15.18-alpine@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f", Memory: "1G", Port: 5432,
				Env: []string{"POSTGRES_DB=keycloak"},
			})
			// The inference driver is WHO PERFORMS INFERENCE per the roster,
			// not which process the launcher runs. ollama-gemma binds ollama →
			// the local-Ollama shape. anthropic binds Claude throughout → an
			// external SaaS role, whose key the remote-model check reads; the
			// Ollama it still needs exists solely for the embedding, and the
			// embedding owns it (above).
			if name == "anthropic" {
				checkRole(t, plan, "inference", rolePlan{
					Presence: presenceExternal, Driver: "anthropic",
					Address: "api.anthropic.com", Port: 443,
					Models: []servedModel{
						{Model: "claude-haiku-4-5-20251001", Provider: "anthropic"},
						{Model: "claude-sonnet-4-5-20250929", Provider: "anthropic"},
					},
				})
				if got := plan.Roles["inference"].APIKey; got != "ANTHROPIC_API_KEY" {
					t.Errorf("the remote-model check reads the key from %q, want the variable the provider names", got)
				}
			} else {
				checkRole(t, plan, "inference", rolePlan{
					Presence: presenceHostPreferred, Driver: "ollama",
					Image: ollama, Port: 11434,
					Models: []servedModel{
						{Model: "gemma4:26b", Provider: "ollama"},
						{Model: "gemma4:e2b", Provider: "ollama"},
					},
				})
			}
			// Only what OLLAMA can serve is pullable — the anthropic roster's
			// Claude models are not in this list.
			wantPull := []string{"gemma4:26b", "gemma4:e2b", "nomic-embed-text"}
			if name == "anthropic" {
				wantPull = []string{"nomic-embed-text"}
			}
			if strings.Join(modelNames(plan.OllamaModels), ",") != strings.Join(wantPull, ",") {
				t.Errorf("ollama models: got %v want %v", modelNames(plan.OllamaModels), wantPull)
			}
			// Each model carries the ROLE that asked for it, so a failed pull
			// can name what stops working. The anthropic roster's inference
			// runs on Claude, so its ONE ollama-served model is embedding-only
			// — a set that crosses no role boundary, unlike ollama-gemma's.
			wantRoles := map[string][]string{
				"gemma4:26b":       {roleInference},
				"gemma4:e2b":       {roleInference},
				"nomic-embed-text": {roleEmbedding},
			}
			for _, m := range plan.OllamaModels {
				if got, want := strings.Join(m.Roles, "+"), strings.Join(wantRoles[m.Name], "+"); got != want {
					t.Errorf("%s roles: got %q want %q", m.Name, got, want)
				}
			}
			if plan.GatewayPort != 4000 {
				t.Errorf("gateway port: got %d want 4000", plan.GatewayPort)
			}
			if len(plan.AuxPorts("graph")) != 1 || plan.AuxPorts("graph")[0].port != 7474 {
				t.Errorf("graph aux ports: got %v", plan.AuxPorts("graph"))
			}
		})
	}
}

// A daemon whose document states `external` is somebody else's: verified at
// the address it states, never launched, and given no image or memory.
func TestDerivePlanExternalDaemons(t *testing.T) {
	for _, c := range []struct {
		role string
		want rolePlan
	}{
		{"graph", rolePlan{Presence: presenceExternal, Driver: "neo4j", Address: "graph.example.com", Port: 9999}},
		{"vectors", rolePlan{Presence: presenceExternal, Driver: "qdrant", Address: "vectors.example.com", Port: 6334}},
		{"database", rolePlan{Presence: presenceExternal, Driver: "postgres", Address: "db.example.com", Port: 5433}},
		{"messaging", rolePlan{Presence: presenceExternal, Driver: "jetstream", Address: "nats.example.com", Port: 4223}},
	} {
		t.Run(c.role, func(t *testing.T) {
			st := fixtureStack(t, "anthropic")
			asSomebodyElses(st, c.role)
			checkRole(t, mustPlan(t, st), c.role, c.want)
		})
	}
}

// The Keycloak the launcher runs keeps its realm on a PostgreSQL somebody else
// runs, and signs in to it with the password the variable the Issuer document
// names holds.
func TestTheLaunchersKeycloakReadsAnExternalDatabasesPasswordFromItsVariable(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	asSomebodyElses(st, "database")
	if got := mustPlan(t, st).Roles["identity"].ExternalDBPassword; got != "EXT_DB_PASSWORD" {
		t.Errorf("the Keycloak reads its database's password from %q, want the variable the Issuer document names", got)
	}
	if got := mustPlan(t, fixtureStack(t, "anthropic")).Roles["identity"].ExternalDBPassword; got != "" {
		t.Errorf("a launcher-run PostgreSQL's password is the launcher's, and the plan reads it from %q", got)
	}
}

// A daemon the launcher runs is run from the image its document names, with
// the memory it states — the plan carries both, and both reach the argv the
// runtime sees.
func TestDerivePlanRunsADaemonFromTheImageItsDocumentNames(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	graphImage, dbImage := "neo4j:6.0.1-community", "postgres:17.2-alpine"
	st.KnowledgeIndex.Spec.Graph.Image = &graphImage
	st.KnowledgeIndex.Spec.Graph.Resources.Limits.Memory = "4G"
	st.Issuer.Spec.Database.Image = &dbImage
	plan := mustPlan(t, st)
	if got := plan.Roles["graph"]; got.Image != graphImage || got.Memory != "4G" {
		t.Errorf("graph runs from %q with %q, want %s with 4G", got.Image, got.Memory, graphImage)
	}
	if got := plan.Roles["database"].Image; got != dbImage {
		t.Errorf("database image: got %q", got)
	}
	args := providedRunArgs(exposure{}, "graph", plan.Roles["graph"])
	if args[len(args)-1] != graphImage {
		t.Errorf("run argv image: got %q", args[len(args)-1])
	}
	if at := slices.Index(args, "--memory"); at < 0 || args[at+1] != "4G" {
		t.Errorf("run argv %v does not give the graph its document's 4G", args)
	}
}

// Each of Semiont's services the stack runs is run from the image its
// document names, with the memory its document states: the plan carries one
// of each for every such service and for nothing else, and a change to one
// service's document changes that service alone. (A stack that runs no
// worker: TestPlanRunsAWorkerOnlyWhenAJobIsBound.)
func TestThePlanRunsEachServiceAsItsDocumentSays(t *testing.T) {
	before := mustPlan(t, fixtureStack(t, "anthropic"))
	for what, services := range map[string]map[string]string{"an image": before.Images, "a memory": before.Memory} {
		var got []string
		for svc := range services {
			got = append(got, svc)
		}
		sort.Strings(got)
		want := slices.Clone(stackServices)
		sort.Strings(want)
		if !slices.Equal(got, want) {
			t.Errorf("the plan gives %s to %v, want each service the stack runs: %v", what, got, want)
		}
	}

	st := fixtureStack(t, "anthropic")
	st.KnowledgeIndex.Spec.Smelter.Resources.Limits.Memory = "8G"
	st.KnowledgeBase.Spec.Gateway.Image = "ghcr.io/the-ai-alliance/semiont-gateway:local"
	after := mustPlan(t, st)
	for svc := range before.Memory {
		want := before.Memory[svc]
		if svc == "smelter" {
			want = "8G"
		}
		if after.Memory[svc] != want {
			t.Errorf("%s is given %s, want %s", svc, after.Memory[svc], want)
		}
	}
	for svc := range before.Images {
		want := before.Images[svc]
		if svc == "gateway" {
			want = st.KnowledgeBase.Spec.Gateway.Image
		}
		if after.Images[svc] != want {
			t.Errorf("%s runs from %s, want %s", svc, after.Images[svc], want)
		}
	}
}

// A voyage embedding and no ollama binding: nothing asks for the local
// Ollama, so the launcher launches nothing for either role. Voyage is remote
// SaaS — still external, still a role. No endpoint is normal there, so the
// driver's own host and TLS port stand in.
func TestDerivePlanNoOllamaAnywhere(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	e := &st.KnowledgeIndex.Spec.Embedding
	e.Type, e.Model, e.ApiKey = "voyage", "voyage-3", &stack.SecretRef{FromEnv: "VOYAGE_API_KEY"}
	plan := mustPlan(t, st)
	checkRole(t, plan, "embedding", rolePlan{
		Presence: presenceExternal, Driver: "voyage",
		Address: voyageHost, Port: 443,
		Models: []servedModel{{Model: "voyage-3", Provider: "voyage"}}, // voyage is remote: nothing to install
	})
	// The roster binds Claude, so inference is a configured EXTERNAL role, not
	// an absent one, and a voyage embedding must not drag Ollama in either.
	checkRole(t, plan, "inference", rolePlan{
		Presence: presenceExternal, Driver: "anthropic",
		Address: "api.anthropic.com", Port: 443,
		Models: []servedModel{
			{Model: "claude-haiku-4-5-20251001", Provider: "anthropic"},
			{Model: "claude-sonnet-4-5-20250929", Provider: "anthropic"},
		},
	})
	if len(plan.OllamaModels) != 0 {
		t.Errorf("Ollama is asked to serve %v", modelNames(plan.OllamaModels))
	}
	for role, rp := range plan.Roles {
		if rp.Presence == presenceHostPreferred {
			t.Errorf("%s runs an Ollama nothing asks for", role)
		}
	}
}

// A roster that binds nothing performs no inference, and the Ollama an ollama
// embedding still needs is the embedding's own, run from the catalog's image.
func TestDerivePlanWithNothingBoundRunsNoInference(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	st.Inference.Spec.Roster = api.ArchivistRoster{}
	plan := mustPlan(t, st)
	if got := plan.Roles["inference"].Presence; got != presenceAbsent {
		t.Errorf("no bindings: inference should be absent, got %v", got)
	}
	checkRole(t, plan, "embedding", rolePlan{
		Presence: presenceHostPreferred, Driver: "ollama",
		Image: descriptorFor("inference", "ollama").image, Port: 11434,
		Models: []servedModel{{Model: "nomic-embed-text", Provider: "ollama"}},
	})
}

func TestDerivePlanUnknownType(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	st.KnowledgeIndex.Spec.Graph.Type = "janusgraph"
	mustRefuse(t, st, st.Files.KnowledgeIndex+": spec.graph.type", `"janusgraph"`, "neo4j")
}

// `memory` is unusable in a launcher-managed stack, which runs the Smelter
// and the Librarian as separate containers. Refusing it is right; refusing it
// as an "unknown driver" is not: the operator would be told the value does
// not exist.
func TestDerivePlanExplainsWhyMemoryIsNotAvailableHere(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	st.KnowledgeIndex.Spec.Vectors.Type = "memory"
	mustRefuse(t, st, st.Files.KnowledgeIndex+": spec.vectors.type", "separate containers", `Use "qdrant"`)
}

// The dispatcher's queue is JetStream, and the signal plane is in-process or
// on that broker: the plan refuses any other type of either.
func TestPlanRefusesAMessagingTypeItHasNoDriverFor(t *testing.T) {
	for _, c := range []struct {
		field string
		state func(m *stack.KnowledgeBaseMessaging)
		want  []string
	}{
		{"spec.messaging.jobs.type", func(m *stack.KnowledgeBaseMessaging) { m.Jobs.Type = "fs" },
			[]string{`"fs"`, "dispatcher's queue is JetStream", `write "jetstream"`}},
		{"spec.messaging.signal.type", func(m *stack.KnowledgeBaseMessaging) { m.Signal.Type = "redis" },
			[]string{`"redis"`, `"in-process"`, `"nats"`}},
	} {
		st := fixtureStack(t, "anthropic")
		c.state(&st.KnowledgeBase.Spec.Messaging)
		mustRefuse(t, st, append([]string{st.Files.KnowledgeBase + ": " + c.field}, c.want...)...)
	}
}

// ── Broker credentials ──────────────────────────────────────────────────────
//
// The broker the launcher runs is always authenticated, with the pair the
// launcher generates and keeps: pointed at the authorization block, its pair
// added at launch as the daemon's own environment, because nats-server reads
// none by itself and argv would put it in every process listing. That the
// pair reaches the daemon and both clients is proven end to end
// (TestLauncherRunBrokerIsAuthenticated). A broker somebody else runs is
// given nothing: its pair is the KnowledgeBase's, for its clients.

func TestLauncherRunBrokerIsAlwaysAuthenticated(t *testing.T) {
	rp := mustPlan(t, fixtureStack(t, "anthropic")).Roles["messaging"]
	if !slices.Contains(rp.CmdExtra, "-c") || !slices.Contains(rp.CmdExtra, natsConfPath) {
		t.Fatalf("CmdExtra = %v, want -c %s", rp.CmdExtra, natsConfPath)
	}
	if len(rp.Env) != 0 {
		t.Fatalf("the plan carries a credential (%v); the pair is added at launch", rp.Env)
	}

	st := fixtureStack(t, "anthropic")
	asSomebodyElses(st, "messaging")
	if extra := mustPlan(t, st).Roles["messaging"].CmdExtra; len(extra) != 0 {
		t.Errorf("a broker somebody else runs is given %v", extra)
	}
}

// The plan carries the port this launch gives the Keycloak it runs — what
// Keycloak publishes on, what the port check guards, and what the realm is
// reached at.
func TestIssuerPortResolvesFromKeycloakPort(t *testing.T) {
	plan, err := derivePlan(fixtureStack(t, "anthropic"), 8081)
	if err != nil {
		t.Fatal(err)
	}
	rp := plan.Roles["identity"]
	if rp.Presence != presenceLauncher || rp.Port != 8081 {
		t.Errorf("identity = %s on %d, want launcher-run on 8081", rp.Presence, rp.Port)
	}
	if rp.Issuer != "http://localhost:8081/realms/semiont" {
		t.Errorf("issuer %q, want the realm on this launch's port", rp.Issuer)
	}
}

// The descriptor set says which ports each role claims at stack level, and a
// full start must find every one of them free before it publishes any: a
// claim planPortChecks misses is a port the post-sweep settle never waits on,
// and whose squatter surfaces as a failed `run` instead of a named conflict.
// A role bound to somebody else's service claims nothing — this start binds
// nothing for it.
func TestPlanPortChecksCoverEveryStackPortClaim(t *testing.T) {
	plan := mustPlan(t, fixtureStack(t, "anthropic"))
	checked := portNumbers(planPortChecks(plan, true, exposure{}))
	for _, role := range startOrder {
		if rp, planned := plan.Roles[role]; planned && rp.Presence != presenceLauncher {
			continue
		}
		for _, need := range stackPortNeeds(role) {
			if !slices.Contains(checked, need.port) {
				t.Errorf("%s claims %d (%s) at stack level, but a full start never requires it free", role, need.port, need.label)
			}
		}
	}
}

// The worker is a role of the plan like any other the documents decide: run
// by the launcher when the roster binds a job to one, from the image and with
// the memory the WorkerPool states; absent when it binds none. An actor's
// binding binds no job.
func TestPlanRunsAWorkerOnlyWhenAJobIsBound(t *testing.T) {
	claude := &api.ArchivistRosterRole{Provider: api.ArchivistRosterRoleProviderAnthropic, Model: "claude-sonnet-4-5-20250929"}
	for _, c := range []struct {
		why  string
		bind func(r *api.ArchivistRoster)
		want presence
	}{
		{"every job is bound", func(r *api.ArchivistRoster) {}, presenceLauncher},
		{"one job is bound", func(r *api.ArchivistRoster) { *r = api.ArchivistRoster{}; r.Workers.Yield = claude }, presenceLauncher},
		{"only an actor is bound", func(r *api.ArchivistRoster) { *r = api.ArchivistRoster{}; r.Actors.Gatherer = claude }, presenceAbsent},
		{"nothing is bound", func(r *api.ArchivistRoster) { *r = api.ArchivistRoster{} }, presenceAbsent},
	} {
		st := fixtureStack(t, "anthropic")
		c.bind(&st.Inference.Spec.Roster)
		plan := mustPlan(t, st)
		worker, planned := plan.Roles["worker"]
		if !planned {
			t.Fatalf("%s: the plan carries no worker", c.why)
		}
		if worker.Presence != c.want {
			t.Errorf("%s: the worker is %s, want %s", c.why, worker.Presence, c.want)
		}
		if _, ours := lookupDescriptor(worker.Role, worker.Driver); !ours {
			t.Errorf("%s: the worker's row names (%q, %q), which is no descriptor", c.why, worker.Role, worker.Driver)
		}
		_, imaged := plan.Images["worker"]
		_, sized := plan.Memory["worker"]
		if run := c.want == presenceLauncher; imaged != run || sized != run {
			t.Errorf("%s: the plan gives the worker an image (%v) and memory (%v), and runs it: %v", c.why, imaged, sized, run)
		}
	}
}

// A knowledge base with no workers.yaml runs no worker, so a roster that binds
// a job to one is refused, naming both documents.
func TestPlanRefusesAJobBoundToAWorkerTheKnowledgeBaseHasNot(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	st.Workers = nil
	mustRefuse(t, st, st.Files.Inference+": spec.roster.workers", st.Files.Workers)

	st = fixtureStack(t, "anthropic")
	st.Workers = nil
	st.Inference.Spec.Roster.Workers = api.ArchivistRoster{}.Workers
	if got := mustPlan(t, st).Roles["worker"].Presence; got != presenceAbsent {
		t.Errorf("a roster binding no job, with no workers.yaml, plans the worker %s", got)
	}
}

// A stack without a worker claims everything a stack with one does but the
// worker's port, in the same order.
func TestPlanPortChecksClaimNoPortForAnAbsentWorker(t *testing.T) {
	bound := mustPlan(t, fixtureStack(t, "anthropic"))
	st := fixtureStack(t, "anthropic")
	st.Inference.Spec.Roster.Workers = api.ArchivistRoster{}.Workers
	unbound := mustPlan(t, st)
	var want []int
	for _, port := range portNumbers(planPortChecks(bound, true, exposure{})) {
		if !slices.Contains(portNumbers(stackPortNeeds("worker")), port) {
			want = append(want, port)
		}
	}
	got := portNumbers(planPortChecks(unbound, true, exposure{}))
	if !slices.Equal(got, want) {
		t.Errorf("a stack without a worker requires %v free\nwant %v", got, want)
	}
	if len(want) == len(planPortChecks(bound, true, exposure{})) {
		t.Fatal("a stack with a worker claims no worker port: this test would prove nothing")
	}
}

// `start --service worker` claims the worker's own port: the launcher's fiat,
// which the descriptor carries and the plan does not.
func TestServicePortNeedsOfTheWorkerAreItsDescriptors(t *testing.T) {
	plan := mustPlan(t, fixtureStack(t, "anthropic"))
	got := servicePortNeeds("worker", plan, startOptions{}, exposure{})
	if want := stackPortNeeds("worker"); !slices.Equal(got, want) {
		t.Errorf("--service worker claims %v, want %v", got, want)
	}
}

// A stop holding no record of the stack's claims verifies fiatPorts instead,
// so every stack-level claim such a stop can know must be in it: one it
// misses is a survivor nobody reports, and the next start fails on it.
func TestStopFallbackVerifiesEveryFiatPortClaim(t *testing.T) {
	// The documents set these roles' ports and may bind them to somebody
	// else's service, and a stop with no record reads no document.
	configOwned := []string{"gateway", "graph", "vectors", "database", "identity"}
	for _, role := range startOrder {
		if slices.Contains(configOwned, role) {
			continue
		}
		for _, need := range stackPortNeeds(role) {
			if !slices.Contains(fiatPorts, need.port) {
				t.Errorf("%s claims %d (%s) at stack level, but a stop with no record never verifies it released", role, need.port, need.label)
			}
		}
	}
}

// Each document says where its own Ollama is: the KnowledgeIndex's
// embedding.endpoint the embedding's, the Inference document's
// providers.ollama.baseURL inference's. The two share the machine's Ollama only
// when neither states one, and the plan, the worker's document, the dry run's
// placed lines and the models the machine's Ollama pulls agree on where each is.
func TestEachOllamaIsWhereItsOwnDocumentSays(t *testing.T) {
	somewhere := "http://ollama.example.org:11500"
	ollama := api.ArchivistRosterRoleProviderOllama

	t.Run("the embedding's is somebody else's", func(t *testing.T) {
		st := fixtureStack(t, "ollama-gemma")
		st.KnowledgeIndex.Spec.Embedding.Endpoint = &somewhere
		p := placed(t, st)
		if rp := p.plan.Roles["inference"]; rp.Presence != presenceHostPreferred || rp.Address != "" {
			t.Errorf("inference is not on the machine's Ollama: %+v", rp)
		}
		if rp := p.plan.Roles["embedding"]; rp.Presence != presenceExternal || rp.Address != "ollama.example.org" || rp.Port != 11500 || rp.SharesOllamaWith != "" {
			t.Errorf("the embedding is not somebody else's at its endpoint: %+v", rp)
		}
		if at, err := providerAddress(p, ollama, "the worker"); err != nil || at != p.ollama(nil) {
			t.Errorf("the worker reaches its models at %q (%v), and the plan runs them on the machine's Ollama, %s", at, err, p.ollama(nil))
		}
		lines := p.placedLines()
		if !slices.Contains(lines, "inference: "+p.ollama(nil)) || slices.ContainsFunc(lines, func(l string) bool { return strings.HasPrefix(l, "embedding:") }) {
			t.Errorf("the placed lines are %q", lines)
		}
		if got := modelNames(p.plan.OllamaModels); !slices.Equal(got, []string{"gemma4:26b", "gemma4:e2b"}) {
			t.Errorf("the machine's Ollama pulls %v: the roster's models, and not the embedding's, which somebody else's Ollama serves", got)
		}
	})

	t.Run("inference's is somebody else's", func(t *testing.T) {
		st := fixtureStack(t, "ollama-gemma")
		provider := st.Inference.Spec.Providers[ollama]
		provider.BaseURL = &somewhere
		st.Inference.Spec.Providers[ollama] = provider
		p := placed(t, st)
		if rp := p.plan.Roles["inference"]; rp.Presence != presenceExternal || rp.Address != "ollama.example.org" || rp.Port != 11500 {
			t.Errorf("inference is not somebody else's at its baseURL: %+v", rp)
		}
		if rp := p.plan.Roles["embedding"]; rp.Presence != presenceHostPreferred || rp.SharesOllamaWith != "" || rp.Image == "" {
			t.Errorf("the embedding does not run the machine's Ollama itself: %+v", rp)
		}
		if at, err := providerAddress(p, ollama, "the worker"); err != nil || at != somewhere {
			t.Errorf("the worker reaches its models at %q (%v), not at the stated %s", at, err, somewhere)
		}
		lines := p.placedLines()
		if !slices.Contains(lines, "embedding: "+p.ollama(nil)) || slices.ContainsFunc(lines, func(l string) bool { return strings.HasPrefix(l, "inference:") }) {
			t.Errorf("the placed lines are %q", lines)
		}
		if got := modelNames(p.plan.OllamaModels); !slices.Equal(got, []string{"nomic-embed-text"}) {
			t.Errorf("the machine's Ollama pulls %v: the embedding's model, and none of the roster's, which somebody else's Ollama serves", got)
		}
	})
}
