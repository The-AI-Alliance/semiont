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
			checkRole(t, plan, "database", rolePlan{
				Obligation: obligationProvided, Driver: "postgres",
				Image: "postgres:15.18-alpine", Port: 5432,
				Env: []string{"POSTGRES_PASSWORD=localpass", "POSTGRES_DB=semiont"},
			})
			// Both templates use ollama embedding, so inference is needed in
			// both — host-process preferred with container fallback (the
			// config's platform="posix" made explicit).
			checkRole(t, plan, "inference", rolePlan{
				Obligation: obligationHostProcess, Driver: "ollama",
				Image: "ollama/ollama", Port: 11434,
			})
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
	if got := plan.Roles["inference"]; got.Obligation != obligationAbsent {
		t.Errorf("no-ollama config: got %+v", got)
	}
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
