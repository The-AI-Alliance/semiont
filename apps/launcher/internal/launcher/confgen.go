package launcher

// confgen.go — LAUNCHER-BIRTH P2: the generative semiontconfig builder.
// NOTHING IS MASTERED (decision 2/3): the config is synthesized from the
// launcher's own knowledge — the same injected-var and driver shapes
// derivePlan parses — plus the user's model choices. Bindings are exactly
// the three-name roster (actors.gatherer, actors.matcher, workers.default;
// resolveWorkerInference falls back to default — verified 2026-07-22);
// per-worker refinement is the user's edit, as it always really was.
//
// Every generated config passes through the SAME vet as a template copy:
// loadConfig + derivePlan on a temp file before the real name exists. A
// generator bug is a refusal, never a KB that cannot start.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type genParams struct {
	Inference      string // "anthropic" | "ollama"
	Model          string // heavy: gatherer, matcher, workers.default
	ModelLight     string // optional: emitted as a commented example only
	EmbeddingModel string // ollama-served embedding model
}

func generateSemiontconfig(p genParams) string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }

	w(`[user]`)
	w(`name = ""`)
	w(`email = ""`)
	w(``)
	w(`[defaults]`)
	w(`environment = "local"`)
	w(``)
	w(`[environments.local.backend]`)
	w(`platform = "posix"`)
	w(`port = 4000`)
	w(`publicURL = "http://${BACKEND_HOST:-localhost}:4000"`)
	w(``)
	w(`[environments.local.graph]`)
	w(`platform = "external"`)
	w(`type = "neo4j"`)
	w(`name = "neo4j"`)
	w(`uri = "bolt://${NEO4J_HOST}:7687"`)
	w(`username = "neo4j"`)
	w(`password = "localpass"`)
	w(`database = "neo4j"`)
	w(``)
	w(`[environments.local.vectors]`)
	w(`type = "qdrant"`)
	w(`host = "${QDRANT_HOST}"`)
	w(`port = 6333`)
	w(``)
	w(`[environments.local.embedding]`)
	w(`platform = "external"`)
	w(`type = "ollama"`)
	w(`model = %q`, p.EmbeddingModel)
	w(`baseURL = "http://${OLLAMA_HOST}:11434"`)
	w(``)
	w(`[environments.local.embedding.chunking]`)
	w(`chunkSize = 512`)
	w(`overlap = 64`)
	w(``)
	switch p.Inference {
	case "anthropic":
		w(`[environments.local.inference.anthropic]`)
		w(`platform = "external"`)
		w(`endpoint = "https://api.anthropic.com"`)
		w(`apiKey = "${ANTHROPIC_API_KEY}"`)
	case "ollama":
		w(`[environments.local.inference.ollama]`)
		w(`platform = "posix"`)
		w(`baseURL = "http://${OLLAMA_HOST}:11434"`)
	}
	w(``)
	for _, binding := range []string{
		"actors.gatherer.inference",
		"actors.matcher.inference",
		"workers.default.inference",
	} {
		w(`[environments.local.%s]`, binding)
		w(`type = %q`, p.Inference)
		w(`model = %q`, p.Model)
		w(``)
	}
	if p.ModelLight != "" {
		w(`# Per-worker refinement is yours to make. For example, a lighter`)
		w(`# model for the high-volume annotation workers:`)
		w(`# [environments.local.workers.tag-annotation.inference]`)
		w(`# type = %q`, p.Inference)
		w(`# model = %q`, p.ModelLight)
		w(``)
	}
	w(`[environments.local.database]`)
	w(`platform = "external"`)
	w(`host = "${POSTGRES_HOST}"`)
	w(`port = 5432`)
	w(`name = "semiont"`)
	w(`user = "postgres"`)
	w(`password = "localpass"`)
	return b.String()
}

// writeVettedConfig writes content to .semiont/semiontconfig/<name>.toml —
// but only after the REAL deriver accepts it: the content lands in a temp
// file, loadConfig + derivePlan judge it, and only success renames it into
// place. The same gate template copies pass through (P4): no path may write
// a config this launcher cannot start.
func writeVettedConfig(u *ui, root, name, content string) bool {
	dir := filepath.Join(root, ".semiont", "semiontconfig")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		u.fail("Creating %s: %v", dir, err)
		return false
	}
	tmp := filepath.Join(dir, "."+name+".toml.vetting")
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		u.fail("Writing config: %v", err)
		return false
	}
	env, envName, _, err := loadConfig(tmp)
	if err == nil {
		_, err = derivePlan(env, envName, tmp)
	}
	if err != nil {
		_ = os.Remove(tmp)
		u.fail("The generated config did not pass the launcher's own deriver — refusing to write it: %v", err)
		return false
	}
	final := filepath.Join(dir, name+".toml")
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		u.fail("Placing config: %v", err)
		return false
	}
	u.ok(".semiont/semiontconfig/%s.toml written %s", name, u.dim("(vetted by the plan deriver)"))
	return true
}
