package launcher

// initcmd.go — `semiont init`, LAUNCHER-BIRTH.md P1: birth a KB locally with
// correct identity AT birth (the template path assigns identity by post-fork
// rewrite — a workaround this command exists to not need). P1 is the
// scaffold: identity + .semiont/config + git + roots registration. The
// config BUILDER (semiontconfig generation, live model registries, template
// copy) lands in later phases of the plan.

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const initUsage = `Usage: semiont init [options]

Create a new Semiont KB in the current directory: its permanent identity
(.semiont/config), a git repository (the /kb mount requires a clone), and a
registration in the launcher's roots.

Interactive by design — every prompt has a flag twin, so callers can run it
prompt-free; --yes accepts defaults where a safe default exists. The one
thing with NO safe default is the did:web domain: it is the KB's PERMANENT
identity, stamped into the committed event log. It comes from --domain, or
is derived from this directory's git origin (<owner_lc>.github.io:<name> —
the same rule the template's post-fork action applies), or is prompted for.
With --yes and neither source, init refuses rather than guessing.

  --name <n>          Project name (default: directory basename)
  --domain <d>        did:web domain (colon-path form, e.g. owner.github.io:repo)
  --site-name <s>     Human-readable site name (default: the project name)
  --admin-email <e>   Admin email recorded in the site config
  --inference <p>     Build a config: anthropic or ollama
  --model <id>        The heavy model (gatherer, matcher, workers.default)
  --model-light <id>  Emitted as a commented per-worker example, not a binding
  --embedding <e>     ollama:<model> (voyage: not yet — no established key var)
  --config-name <n>   Config file name (default: the provider name)
  --from-template [s] Copy semiontconfig from the template instead of building
                      (s: URL or local dir; default the canonical template repo;
                      every copy is vetted by the plan deriver pre-write)
  --template-ref <r>  Git ref for a URL template source (default main)
  --devcontainer      Also copy .devcontainer (display name rewritten) — makes
                      this KB codespace-capable
  --anthropic-endpoint <u>  Anthropic API base (proxy knob; default https://api.anthropic.com)
  --ollama-base <u>         Local Ollama base (default http://localhost:11434)
  --ollama-registry <u>     Ollama registry base (default https://registry.ollama.ai)
  --no-git            Skip git init/add; sets git.sync = false (stated consequences)
  --force             Re-initialize over an existing .semiont/
  --yes               Accept defaults; never prompt (refuses where no safe default exists)
  --dry-run           Print what would be created; write and execute nothing
  --help, -h          Show this help
`

// Init implements `semiont init`.
func Init(args []string) int {
	u := newUI(false)
	var name, domain, siteName, adminEmail string
	var inference, model, modelLight, embedding, configName string
	var fromTemplate, templateRef string
	var devcontainer bool
	anthropicEndpoint := "https://api.anthropic.com"
	ollamaBase := "http://localhost:11434"
	ollamaRegistry := "https://registry.ollama.ai"
	var noGit, yes, force, dryRun bool
	for i := 0; i < len(args); i++ {
		need := func() (string, bool) {
			if i+1 >= len(args) {
				u.fail("Missing value for %s", args[i])
				return "", false
			}
			return args[i+1], true
		}
		switch args[i] {
		case "--name":
			v, ok := need()
			if !ok {
				return 1
			}
			name = v
			i++
		case "--domain":
			v, ok := need()
			if !ok {
				return 1
			}
			domain = v
			i++
		case "--site-name":
			v, ok := need()
			if !ok {
				return 1
			}
			siteName = v
			i++
		case "--admin-email":
			v, ok := need()
			if !ok {
				return 1
			}
			adminEmail = v
			i++
		case "--inference":
			v, ok := need()
			if !ok {
				return 1
			}
			inference = v
			i++
		case "--model":
			v, ok := need()
			if !ok {
				return 1
			}
			model = v
			i++
		case "--model-light":
			v, ok := need()
			if !ok {
				return 1
			}
			modelLight = v
			i++
		case "--embedding":
			v, ok := need()
			if !ok {
				return 1
			}
			embedding = v
			i++
		case "--config-name":
			v, ok := need()
			if !ok {
				return 1
			}
			configName = v
			i++
		case "--from-template":
			// Optional value: a URL or local directory; bare flag = the
			// canonical template repo.
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				fromTemplate = args[i+1]
				i++
			} else {
				fromTemplate = defaultTemplateRepo
			}
		case "--template-ref":
			v, ok := need()
			if !ok {
				return 1
			}
			templateRef = v
			i++
		case "--devcontainer":
			devcontainer = true
		case "--anthropic-endpoint":
			v, ok := need()
			if !ok {
				return 1
			}
			anthropicEndpoint = v
			i++
		case "--ollama-base":
			v, ok := need()
			if !ok {
				return 1
			}
			ollamaBase = v
			i++
		case "--ollama-registry":
			v, ok := need()
			if !ok {
				return 1
			}
			ollamaRegistry = v
			i++
		case "--no-git":
			noGit = true
		case "--yes":
			yes = true
		case "--force":
			force = true
		case "--dry-run":
			dryRun = true
		case "--help", "-h":
			fmt.Print(initUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	// Config-builder inputs validate BEFORE anything touches disk.
	if fromTemplate != "" && inference != "" {
		u.fail("--from-template and --inference are two sources for the same configs — pick one.")
		return 1
	}
	if templateRef == "" {
		templateRef = "main"
	}
	if inference != "" && inference != "anthropic" && inference != "ollama" {
		u.fail("--inference must be anthropic or ollama, got %q.", inference)
		return 1
	}
	embModel := ""
	if embedding != "" {
		kind, m, _ := strings.Cut(embedding, ":")
		switch kind {
		case "ollama":
			if m == "" {
				u.fail("--embedding ollama:<model> needs a model name.")
				return 1
			}
			embModel = m
		case "voyage":
			// No established key variable exists for voyage, and the
			// launcher never invents environment variables. Deferred.
			u.fail("voyage embedding is not supported yet (no established key variable) — use --embedding ollama:<model>.")
			return 1
		default:
			u.fail("--embedding must be ollama:<model>, got %q.", embedding)
			return 1
		}
	}
	if inference == "ollama" && model == "" && yes {
		// No registry listing exists to derive an ollama default from.
		u.fail("--inference ollama needs --model <id> (no list-all registry API exists to pick a default from).")
		return 1
	}

	dir, err := os.Getwd()
	if err != nil {
		u.fail("Cannot determine the current directory: %v", err)
		return 1
	}
	if name == "" {
		name = filepath.Base(dir)
	}
	if _, err := os.Stat(filepath.Join(dir, ".semiont")); err == nil && !force {
		u.fail(".semiont/ already exists here — this KB is already born. Re-initialize with --force.")
		return 1
	}

	in := bufio.NewReader(os.Stdin)
	prompt := func(question, def string) string {
		if def != "" {
			fmt.Printf("  %s [%s]: ", question, def)
		} else {
			fmt.Printf("  %s: ", question)
		}
		line, _ := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			return def
		}
		return line
	}

	// The did:web ladder (LAUNCHER-BIRTH decision 6): flag → derived from
	// the git origin by the SAME rule as the template's post-fork action
	// (<owner_lc>.github.io:<repo>) → prompt. Permanent identity has no
	// safe default, so --yes with neither source REFUSES.
	if domain == "" {
		if origin, err := capture("git", "-C", dir, "remote", "get-url", "origin"); err == nil && origin != "" {
			if slug, ok := parseGitHubSlug(origin); ok {
				owner, repo, _ := strings.Cut(slug, "/")
				domain = strings.ToLower(owner) + ".github.io:" + repo
				u.log("did:web domain derived from the git origin: %s", u.bold(domain))
			}
		}
	}
	if domain == "" {
		if yes {
			u.fail("No did:web domain: it is the KB's permanent identity (stamped into the committed event log) and has no safe default.")
			fmt.Fprintln(os.Stderr, "  Pass --domain <owner_lc>.github.io:<name>, or run from a clone whose git origin can supply it.")
			return 1
		}
		fmt.Println("The did:web domain is this KB's permanent identity — it is stamped")
		fmt.Println("into the committed event log and should never change.")
		domain = prompt("did:web domain (e.g. owner.github.io:repo)", "")
		if domain == "" {
			u.fail("A did:web domain is required.")
			return 1
		}
	}
	if siteName == "" {
		if yes {
			siteName = name
		} else {
			siteName = prompt("Site name", name)
		}
	}
	if adminEmail == "" && !yes {
		adminEmail = prompt("Admin email", "")
	}

	cfg := fmt.Sprintf(`[project]
name = %q
version = "0.1.0"

[git]
sync = %t

[site]
domain = %q
siteName = %q
adminEmail = %q
`, name, !noGit, domain, siteName, adminEmail)

	if dryRun {
		fmt.Println("# semiont init --dry-run — what a real run would create. Nothing is written.")
		fmt.Println("# .semiont/config:")
		for _, l := range strings.Split(strings.TrimRight(cfg, "\n"), "\n") {
			fmt.Println("#   " + l)
		}
		if !noGit {
			fmt.Println("git init")
			fmt.Println("git add .semiont")
		}
		if inference != "" {
			cn := configName
			if cn == "" {
				cn = inference
			}
			fmt.Printf("# .semiont/semiontconfig/%s.toml — generated (%s inference, %s embedding), vetted by derivePlan before writing\n", cn, inference, embModel)
		}
		if fromTemplate != "" {
			fmt.Printf("# copy semiontconfig tomls from %s (ref %s) — each vetted by derivePlan pre-write; identity NEVER copied\n", fromTemplate, templateRef)
		}
		if devcontainer {
			fmt.Println("# copy .devcontainer from the template, display name rewritten to the KB's")
		}
		fmt.Println("# register root in " + rootsPath())
		return 0
	}

	if noGit {
		u.warn("--no-git: git init is skipped, git.sync = false, and .semiont/ is not staged — the backend versions the event log via git, so this KB cannot run the full stack until it becomes a clone.")
	}
	if err := os.MkdirAll(filepath.Join(dir, ".semiont"), 0o755); err != nil {
		u.fail("Creating .semiont/: %v", err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(dir, ".semiont", "config"), []byte(cfg), 0o644); err != nil {
		u.fail("Writing .semiont/config: %v", err)
		return 1
	}
	u.ok(".semiont/config written %s", u.dim("("+domain+")"))

	if !noGit {
		if !onPath("git") {
			u.warn("git is not on PATH — skipping git init/add; the full stack needs this KB to be a clone.")
		} else {
			if out, err := captureBoth("git", "-C", dir, "init"); err != nil {
				u.fail("git init: %s", strings.TrimSpace(out))
				return 1
			}
			u.ok("git init")
			if out, err := captureBoth("git", "-C", dir, "add", ".semiont"); err != nil {
				u.fail("git add .semiont: %s", strings.TrimSpace(out))
				return 1
			}
			u.ok("git add .semiont")
		}
	}

	// The config builder (P2): flags first; interactively, prompts fill the
	// gaps (typed entry — the live pickers are P3); --yes with no
	// --inference skips generation rather than guessing a provider.
	if inference == "" && !yes {
		fmt.Println("Configure inference now? The config is built from the launcher's own")
		fmt.Println("knowledge — nothing is copied, and the file is yours from its first byte.")
		inference = prompt("Inference provider (anthropic / ollama / skip)", "skip")
		if inference == "skip" || inference == "" {
			inference = ""
		} else if inference != "anthropic" && inference != "ollama" {
			u.fail("Provider must be anthropic or ollama, got %q.", inference)
			return 1
		}
		if inference != "" && model == "" {
			model = prompt("Model id (heavy: gatherer, matcher, default worker)", "")
			if model == "" {
				u.fail("A model id is required.")
				return 1
			}
		}
		if inference != "" && embModel == "" {
			embModel = prompt("Embedding model (served by Ollama)", "nomic-embed-text")
		}
	}
	if inference != "" {
		if embModel == "" {
			embModel = "nomic-embed-text"
		}
		// Live validation (P3): the choices are checked against the sources
		// that will have to serve them — refusals now, not failed jobs later.
		switch inference {
		case "anthropic":
			m, ok := resolveAnthropicModel(u, anthropicEndpoint, os.Getenv("ANTHROPIC_API_KEY"), model)
			if !ok {
				return 1
			}
			model = m
		case "ollama":
			if !validateOllamaModel(u, ollamaBase, ollamaRegistry, model) {
				return 1
			}
		}
		if !validateOllamaModel(u, ollamaBase, ollamaRegistry, embModel) {
			return 1
		}
		cn := configName
		if cn == "" {
			cn = inference
		}
		content := generateSemiontconfig(genParams{
			Inference: inference, Model: model, ModelLight: modelLight, EmbeddingModel: embModel,
		})
		if !writeVettedConfig(u, dir, cn, content) {
			return 1
		}
		if !noGit && onPath("git") {
			if out, err := captureBoth("git", "-C", dir, "add", ".semiont"); err != nil {
				u.fail("git add .semiont: %s", strings.TrimSpace(out))
				return 1
			}
		}
	}

	if fromTemplate != "" || devcontainer {
		src := fromTemplate
		if src == "" {
			src = defaultTemplateRepo // --devcontainer alone still needs the tree
		}
		tplDir, cleanup, ok := materializeTemplate(u, src, templateRef)
		if !ok {
			return 1
		}
		defer cleanup()
		if fromTemplate != "" {
			if !copyTemplateConfigs(u, dir, tplDir) {
				return 1
			}
		}
		if devcontainer {
			if !copyDevcontainer(u, dir, tplDir, name) {
				return 1
			}
		}
		if !noGit && onPath("git") {
			addArgs := []string{"-C", dir, "add", ".semiont"}
			if devcontainer {
				addArgs = append(addArgs, ".devcontainer")
			}
			if out, err := captureBoth("git", addArgs...); err != nil {
				u.fail("git add: %s", strings.TrimSpace(out))
				return 1
			}
		}
	}

	registerRootUse(dir, false, "")
	warnICloudRoot(u, dir)

	fmt.Println()
	fmt.Printf("%s\n", u.wrap(ansiBold+ansiGreen, "🌱 "+name+" is born"))
	fmt.Println()
	fmt.Println("  Next steps:")
	step := 1
	if inference == "" {
		fmt.Printf("    %d. %s %s\n", step, u.bold("add a config"), u.dim("(rerun with --inference, or write .semiont/semiontconfig/<name>.toml)"))
		step++
	}
	if inference == "anthropic" {
		fmt.Printf("    %d. %s\n", step, u.bold("semiont secret set ANTHROPIC_API_KEY"))
		step++
	}
	fmt.Printf("    %d. %s\n", step, u.bold("semiont start"))
	return 0
}
