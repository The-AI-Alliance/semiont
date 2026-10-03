package launcher

// confgen.go — LAUNCHER-BIRTH P2: the generative semiontconfig builder.
// NOTHING IS MASTERED (decision 2/3): the config is synthesized from the
// launcher's own knowledge — the driver shapes derivePlan parses — plus the
// user's model choices. It says what the knowledge base needs and states no
// address: where each daemon listens is the launcher's to place at every
// start (topology.go), so the file is the same on every machine. Bindings are exactly
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
	Inference         string // "anthropic" | "ollama"
	Model             string // heavy: gatherer, matcher, workers.default
	ModelLight        string // optional: emitted as a commented example only
	EmbeddingModel    string // ollama-served embedding model
	AnthropicEndpoint string // honored in the generated config; "" → the default
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
	// New KBs are born on the current spelling. If this kept emitting
	// `backend`, the compat alias would never be able to expire.
	w(`[environments.local.gateway]`)
	w(`platform = "posix"`)
	w(`port = 4000`)
	w(`publicURL = "http://${GATEWAY_HOST:-localhost}:4000"`)
	w(``)
	// A born KB gets the same pair a forked one has, served by ONE messaging
	// daemon with JetStream and its /data store (SIGNAL-PLANE D9).
	//
	// It gets jetstream jobs because the dispatcher's queue is JetStream, and
	// the launcher refuses a config without it.
	//
	// It gets the nats signal driver because that is what puts the
	// gateway's ledger — claims and retained replies — in JetStream KV on that
	// store: durable across restarts and shared by every replica. An
	// in-process signal plane would hold them in one gateway's memory.
	w(`[environments.local.jobs]`)
	w(`type = "jetstream"`)
	w(``)
	w(`[environments.local.signal]`)
	w(`type = "nats"`)
	w(``)
	w(`[environments.local.graph]`)
	w(`platform = "external"`)
	w(`type = "neo4j"`)
	w(`name = "neo4j"`)
	w(`username = "neo4j"`)
	w(`database = "neo4j"`)
	w(``)
	w(`[environments.local.vectors]`)
	w(`type = "qdrant"`)
	w(``)
	w(`[environments.local.embedding]`)
	w(`platform = "external"`)
	w(`type = "ollama"`)
	w(`model = %q`, p.EmbeddingModel)
	w(``)
	w(`[environments.local.embedding.chunking]`)
	w(`chunkSize = 512`)
	w(`overlap = 64`)
	w(``)
	switch p.Inference {
	case "anthropic":
		// Honor --anthropic-endpoint: validating against a proxy but writing
		// the default endpoint would be a silent mismatch (Copilot review,
		// PR #1065).
		endpoint := p.AnthropicEndpoint
		if endpoint == "" {
			endpoint = "https://api.anthropic.com"
		}
		w(`[environments.local.inference.anthropic]`)
		w(`platform = "external"`)
		w(`endpoint = %q`, endpoint)
		w(`apiKey = "${ANTHROPIC_API_KEY}"`)
	case "ollama":
		w(`[environments.local.inference.ollama]`)
		w(`platform = "posix"`)
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
	w(`name = "semiont"`)
	w(`user = "postgres"`)
	w(``)
	w(`[environments.local.identity]`)
	w(`type = "keycloak"`)
	w(`subjectClaim = "sub"`)
	return b.String()
}

// writeVettedConfig writes content to .semiont/semiontconfig/<name>.toml —
// but only after the REAL deriver accepts it: the content lands in a temp
// file, loadConfig + derivePlan judge it, and only success renames it into
// place. The same gate template copies pass through (P4): no path may write
// a config this launcher cannot start.
func writeVettedConfig(u *UI, root, name, content string) bool {
	// name becomes a filename and (via --config-name) is user-controlled — a
	// separator or ".." would escape .semiont/semiontconfig. Require a plain
	// stem (Copilot review, PR #1065).
	if name == "" || name == "." || name == ".." ||
		strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		u.Fail("Config name %q must be a simple file stem (no path separators).", name)
		return false
	}
	// Vet in a SYSTEM temp file: loadConfig+derivePlan judge the content
	// without touching .semiont, so a rejected config never leaves a partial
	// tree behind.
	vf, err := os.CreateTemp("", "semiont-vet-*.toml")
	if err != nil {
		u.Fail("Vetting config: %v", err)
		return false
	}
	vetPath := vf.Name()
	defer os.Remove(vetPath)
	if _, err := vf.WriteString(content); err != nil {
		vf.Close()
		u.Fail("Vetting config: %v", err)
		return false
	}
	vf.Close()
	env, envName, _, err := loadConfig(vetPath)
	if err == nil {
		// Vetting only: any port proves the issuer parses.
		_, err = derivePlan(env, envName, vetPath, descriptorFor("identity", "keycloak").defaultPort)
	}
	if err != nil {
		u.Fail("The config did not pass the launcher's own deriver — refusing to write it: %v", err)
		return false
	}
	dir := filepath.Join(root, ".semiont", "semiontconfig")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		u.Fail("Creating %s: %v", dir, err)
		return false
	}
	if err := os.WriteFile(filepath.Join(dir, name+".toml"), []byte(content), 0o644); err != nil {
		u.Fail("Writing config: %v", err)
		return false
	}
	u.Ok(".semiont/semiontconfig/%s.toml written %s", name, u.Dim("(vetted by the plan deriver)"))
	return true
}
