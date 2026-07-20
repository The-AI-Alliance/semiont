package launcher

// The executable spec for LAUNCHER-CONFIG-SYNC.md P1: derivePlan(config) must
// reproduce today's hardcoded behavior for the two real template configs
// (field-for-field — the parity constraint), and derive the documented
// alternatives for variant configs. Fixtures for the real configs are the
// same files the black-box suite uses (testdata/kb — copies of the template
// KB's own TOMLs); variants are inline.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadFixtureEnv(t *testing.T, name string) (*envConfig, string) {
	t.Helper()
	env, envName, _, err := loadConfig(filepath.Join("..", "..", "testdata", "kb", ".semiont", "semiontconfig", name))
	if err != nil {
		t.Fatalf("loading fixture %s: %v", name, err)
	}
	return env, envName
}

func writeVariant(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "variant.toml")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// variantConfig is a minimal but complete config for variant tests; sections
// are replaced via the replace map (empty string = drop the section).
func variantConfig(t *testing.T, replace map[string]string) string {
	t.Helper()
	sections := map[string]string{
		"graph": `[environments.local.graph]
platform = "external"
type = "neo4j"
uri = "bolt://${NEO4J_HOST}:7687"
username = "neo4j"
password = "localpass"
`,
		"vectors": `[environments.local.vectors]
type = "qdrant"
host = "${QDRANT_HOST}"
port = 6333
`,
		"database": `[environments.local.database]
platform = "external"
host = "${POSTGRES_HOST}"
port = 5432
name = "semiont"
user = "postgres"
password = "localpass"
`,
		"embedding": `[environments.local.embedding]
platform = "external"
type = "ollama"
model = "nomic-embed-text"
baseURL = "http://${OLLAMA_HOST}:11434"
`,
		"inference": `[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"
`,
	}
	for k, v := range replace {
		if v == "" {
			delete(sections, k)
			continue
		}
		sections[k] = v
	}
	var b strings.Builder
	b.WriteString("[defaults]\nenvironment = \"local\"\n\n[environments.local.backend]\nplatform = \"posix\"\nport = 4000\n\n")
	for _, k := range []string{"graph", "vectors", "database", "embedding", "inference"} {
		if s, ok := sections[k]; ok {
			b.WriteString(s + "\n")
		}
	}
	return writeVariant(t, b.String())
}

func mustDerive(t *testing.T, path string) *launchPlan {
	t.Helper()
	env, envName, _, err := loadConfig(path)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	plan, err := derivePlan(env, envName, path)
	if err != nil {
		t.Fatalf("derivePlan: %v", err)
	}
	return plan
}

func checkRole(t *testing.T, plan *launchPlan, role string, want rolePlan) {
	t.Helper()
	got, ok := plan.Roles[role]
	if !ok {
		t.Fatalf("role %s missing from plan", role)
	}
	if got.Obligation != want.Obligation {
		t.Errorf("%s obligation: got %v want %v", role, got.Obligation, want.Obligation)
	}
	if got.Driver != want.Driver {
		t.Errorf("%s driver: got %q want %q", role, got.Driver, want.Driver)
	}
	if got.Image != want.Image {
		t.Errorf("%s image: got %q want %q", role, got.Image, want.Image)
	}
	if got.Port != want.Port {
		t.Errorf("%s port: got %d want %d", role, got.Port, want.Port)
	}
	if strings.Join(got.Models, " ") != strings.Join(want.Models, " ") {
		t.Errorf("%s models: got %v want %v", role, got.Models, want.Models)
	}
	if strings.Join(got.OllamaServed, " ") != strings.Join(want.OllamaServed, " ") {
		t.Errorf("%s ollama-served: got %v want %v", role, got.OllamaServed, want.OllamaServed)
	}
	if strings.Join(got.Env, " ") != strings.Join(want.Env, " ") {
		t.Errorf("%s env: got %v want %v", role, got.Env, want.Env)
	}
	if got.Address != want.Address {
		t.Errorf("%s address: got %q want %q", role, got.Address, want.Address)
	}
}

// The parity spec: both real template configs derive exactly today's
// hardcoded behavior.
func TestDerivePlanTemplateConfigs(t *testing.T) {
	for _, name := range []string{"ollama-gemma.toml", "anthropic.toml"} {
		t.Run(name, func(t *testing.T) {
			env, envName, _, err := loadConfig(filepath.Join("..", "..", "testdata", "kb", ".semiont", "semiontconfig", name))
			if err != nil {
				t.Fatalf("loadConfig: %v", err)
			}
			plan, err := derivePlan(env, envName, name)
			if err != nil {
				t.Fatalf("derivePlan: %v", err)
			}
			checkRole(t, plan, "graph", rolePlan{
				Obligation: obligationProvided, Driver: "neo4j",
				Image: "neo4j:5.26.28-community", Port: 7687,
				Env: []string{"NEO4J_AUTH=neo4j/localpass", "NEO4J_ACCEPT_LICENSE_AGREEMENT=yes"},
			})
			checkRole(t, plan, "vectors", rolePlan{
				Obligation: obligationProvided, Driver: "qdrant",
				Image: "qdrant/qdrant:v1.18.3", Port: 6333,
			})
			// embedding: with ollama-typed bindings, the inference role runs
			// the Ollama and embedding rides along (external + shares). With
			// all-remote bindings, embedding OWNS the host-process dance —
			// that Ollama exists for it alone.
			if name == "anthropic.toml" {
				checkRole(t, plan, "embedding", rolePlan{
					Obligation: obligationHostProcess, Driver: "ollama",
					Image: "ollama/ollama", Port: 11434,
					Models: []string{"nomic-embed-text"}, OllamaServed: []string{"nomic-embed-text"},
				})
			} else {
				checkRole(t, plan, "embedding", rolePlan{
					Obligation: obligationExternal, Driver: "ollama",
					Address: "localhost", Port: 11434,
					Models: []string{"nomic-embed-text"}, OllamaServed: []string{"nomic-embed-text"},
				})
			}
			checkRole(t, plan, "database", rolePlan{
				Obligation: obligationProvided, Driver: "postgres",
				Image: "postgres:15.18-alpine", Port: 5432,
				Env: []string{"POSTGRES_PASSWORD=localpass", "POSTGRES_DB=semiont"},
			})
			// Both templates use ollama embedding, so inference is needed in
			// both — host-process preferred with container fallback (the
			// config's platform="posix" made explicit).
			// The inference driver is WHO PERFORMS INFERENCE per the
			// bindings, not which process the launcher runs. ollama-gemma
			// binds ollama → the local-Ollama shape. anthropic binds Claude
			// throughout → an external SaaS role; the Ollama that config
			// still needs exists solely for the embedding, and the embedding
			// owns it (asserted below).
			if name == "anthropic.toml" {
				checkRole(t, plan, "inference", rolePlan{
					Obligation: obligationExternal, Driver: "anthropic",
					Address: "api.anthropic.com", Port: 443,
					Models:       []string{"claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"},
					OllamaServed: []string{},
				})
			} else {
				m := []string{"gemma4:26b", "gemma4:e2b"}
				checkRole(t, plan, "inference", rolePlan{
					Obligation: obligationHostProcess, Driver: "ollama",
					Image: "ollama/ollama", Port: 11434,
					Models: m, OllamaServed: m,
				})
			}
			// Only what OLLAMA can serve is pullable — the anthropic config's
			// Claude models are not in this list even though its inference
			// role is ollama-driven.
			wantPull := []string{"gemma4:26b", "gemma4:e2b", "nomic-embed-text"}
			if name == "anthropic.toml" {
				wantPull = []string{"nomic-embed-text"}
			}
			if strings.Join(plan.OllamaModels, ",") != strings.Join(wantPull, ",") {
				t.Errorf("ollama models: got %v want %v", plan.OllamaModels, wantPull)
			}
			if plan.BackendPort != 4000 {
				t.Errorf("backend port: got %d want 4000", plan.BackendPort)
			}
			if len(plan.AuxPorts("graph")) != 1 || plan.AuxPorts("graph")[0].port != 7474 {
				t.Errorf("graph aux ports: got %v", plan.AuxPorts("graph"))
			}
		})
	}
}

func TestDerivePlanExternalGraph(t *testing.T) {
	p := variantConfig(t, map[string]string{"graph": `[environments.local.graph]
platform = "external"
type = "neo4j"
uri = "bolt://graph.example.com:9999"
username = "neo4j"
password = "s3cret"
`})
	plan := mustDerive(t, p)
	checkRole(t, plan, "graph", rolePlan{
		Obligation: obligationExternal, Driver: "neo4j",
		Address: "graph.example.com", Port: 9999,
	})
}

func TestDerivePlanMovedPort(t *testing.T) {
	p := variantConfig(t, map[string]string{"database": `[environments.local.database]
host = "${POSTGRES_HOST}"
port = 5433
name = "semiont"
user = "postgres"
password = "localpass"
`})
	plan := mustDerive(t, p)
	if got := plan.Roles["database"]; got.Port != 5433 || got.Obligation != obligationProvided {
		t.Errorf("moved port: got %+v", got)
	}
}

func TestDerivePlanAbsentVectors(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"vectors": ""}))
	if got := plan.Roles["vectors"]; got.Obligation != obligationAbsent {
		t.Errorf("absent vectors: got %+v", got)
	}
}

func TestDerivePlanNoOllamaAnywhere(t *testing.T) {
	// No embedding section and no ollama-typed binding: inference is absent —
	// the launcher launches Ollama only when the config references it.
	plan := mustDerive(t, variantConfig(t, map[string]string{"embedding": ""}))
	// No [embedding] section: the role still exists, reported absent — the
	// same "not configured" shape every unreferenced role gets.
	checkRole(t, plan, "embedding", rolePlan{Obligation: obligationAbsent})
	// The fixture's worker binds Claude, so inference is a configured
	// EXTERNAL role — "absent" would be the old drag-in logic's answer.
	checkRole(t, plan, "inference", rolePlan{
		Obligation: obligationExternal, Driver: "anthropic",
		Address: "api.anthropic.com", Port: 443,
		Models:       []string{"claude-sonnet-4-5-20250929"},
		OllamaServed: []string{},
	})

	// voyage: remote SaaS. Still external, still a role — the platform is
	// what differs, not its standing. No baseURL is normal there, so the
	// driver's own host and TLS port stand in.
	vp := mustDerive(t, variantConfig(t, map[string]string{"embedding": `[environments.local.embedding]
platform = "external"
type = "voyage"
model = "voyage-3"
`}))
	checkRole(t, vp, "embedding", rolePlan{
		Obligation: obligationExternal, Driver: "voyage",
		Address: "api.voyageai.com", Port: 443,
		Models: []string{"voyage-3"}, // voyage is remote: nothing to install
	})
	// A voyage embedding must not drag Ollama in — and with the fixture's
	// Claude-bound worker, inference is the same external-Anthropic role.
	checkRole(t, vp, "inference", rolePlan{
		Obligation: obligationExternal, Driver: "anthropic",
		Address: "api.anthropic.com", Port: 443,
		Models:       []string{"claude-sonnet-4-5-20250929"},
		OllamaServed: []string{},
	})
}

func TestDerivePlanUnknownType(t *testing.T) {
	p := variantConfig(t, map[string]string{"graph": `[environments.local.graph]
type = "janusgraph"
uri = "bolt://${NEO4J_HOST}:7687"
`})
	env, envName, _, err := loadConfig(p)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	_, err = derivePlan(env, envName, p)
	if err == nil || !strings.Contains(err.Error(), "janusgraph") || !strings.Contains(err.Error(), "neo4j") {
		t.Errorf("unknown type must name the offender and the known drivers, got: %v", err)
	}
}

func TestDerivePlanMissingRequiredKey(t *testing.T) {
	p := variantConfig(t, map[string]string{"graph": `[environments.local.graph]
type = "neo4j"
username = "neo4j"
password = "localpass"
`})
	env, envName, _, err := loadConfig(p)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	_, err = derivePlan(env, envName, p)
	if err == nil || !strings.Contains(err.Error(), "graph") || !strings.Contains(err.Error(), "uri") {
		t.Errorf("missing key must name section and key, got: %v", err)
	}
}

func TestLoadConfigErrors(t *testing.T) {
	if _, _, _, err := loadConfig(writeVariant(t, "not [ valid toml")); err == nil {
		t.Error("invalid TOML must error")
	}
	if _, _, _, err := loadConfig(writeVariant(t, "[defaults]\nenvironment = \"prod\"\n")); err == nil || !strings.Contains(err.Error(), "prod") {
		t.Errorf("missing environment block must name it, got: %v", err)
	}
}

func TestRequiredVarsFromParse(t *testing.T) {
	p := writeVariant(t, `[defaults]
environment = "local"

[environments.local.backend]
platform = "posix"
port = 4000

[environments.local.inference.anthropic]
platform = "external"
# commented-out refs are not requirements: apiKey = "${PHANTOM_KEY}"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.graph]
type = "neo4j"
uri = "bolt://${NEO4J_HOST}:7687"
username = "neo4j"
password = "localpass"

[environments.other.database]
host = "${OTHER_ENV_VAR}"
`)
	_, _, vars, err := loadConfig(p)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	got := strings.Join(vars, ",")
	if got != "ANTHROPIC_API_KEY,OTHER_ENV_VAR" {
		t.Errorf("required vars: got %q — want the real ref and the other-environment ref, minus injected (${NEO4J_HOST}) and comment phantoms (${PHANTOM_KEY})", got)
	}
}

func TestDerivePlanImageOverride(t *testing.T) {
	// The config's optional image key wins over the catalog default — a KB
	// can pin or upgrade an infra image without a launcher release.
	p := variantConfig(t, map[string]string{
		"graph": `[environments.local.graph]
type = "neo4j"
uri = "bolt://${NEO4J_HOST}:7687"
username = "neo4j"
password = "localpass"
image = "neo4j:6.0.1-community"
`,
		"database": `[environments.local.database]
host = "${POSTGRES_HOST}"
name = "semiont"
password = "localpass"
image = "postgres:17.2-alpine"
`,
	})
	plan := mustDerive(t, p)
	if got := plan.Roles["graph"].Image; got != "neo4j:6.0.1-community" {
		t.Errorf("graph image: got %q", got)
	}
	if got := plan.Roles["database"].Image; got != "postgres:17.2-alpine" {
		t.Errorf("database image: got %q", got)
	}
	// Unset override: catalog default (the parity everything else relies on).
	if got := plan.Roles["vectors"].Image; got != "qdrant/qdrant:v1.18.3" {
		t.Errorf("vectors default image: got %q", got)
	}
	// The override flows into the argv the runtime sees.
	args := providedRunArgs("graph", plan.Roles["graph"])
	if args[len(args)-1] != "neo4j:6.0.1-community" {
		t.Errorf("run argv image: got %q", args[len(args)-1])
	}
}

func TestDerivePlanInferenceImageOverride(t *testing.T) {
	// Replacing the inference section drops the fixture's Claude worker too,
	// so NO bindings remain: inference is not configured, and the Ollama the
	// embedding still needs is the embedding's own — the image override
	// follows the Ollama, wherever it lives.
	p := variantConfig(t, map[string]string{"inference": `[environments.local.inference.ollama]
platform = "posix"
baseURL = "http://${OLLAMA_HOST}:11434"
image = "ollama/ollama:0.9.5"
`})
	plan := mustDerive(t, p)
	if got := plan.Roles["inference"].Obligation; got != obligationAbsent {
		t.Errorf("no bindings: inference should be absent, got %v", got)
	}
	if got := plan.Roles["embedding"].Image; got != "ollama/ollama:0.9.5" {
		t.Errorf("embedding (ollama owner) image: got %q", got)
	}
	// And with an ollama-typed WORKER added back, the override lands on
	// inference — the role that owns the Ollama then.
	p2 := variantConfig(t, map[string]string{"inference": `[environments.local.inference.ollama]
platform = "posix"
baseURL = "http://${OLLAMA_HOST}:11434"
image = "ollama/ollama:0.9.5"

[environments.local.workers.default.inference]
type = "ollama"
model = "gemma4:26b"
`})
	plan2 := mustDerive(t, p2)
	if got := plan2.Roles["inference"].Image; got != "ollama/ollama:0.9.5" {
		t.Errorf("inference image: got %q", got)
	}
}
