package launcher

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// Secret sources: the launcher NEVER persists a secret value, anywhere,
// ever. What it stores (roots.json, machine-wide) is a structured POINTER —
// {provider, path} — and at start it announces the reach, runs the
// provider's own CLI with the terminal attached (so its authorization
// prompt works), and uses the value once, in memory. The environment always
// wins: exporting the variable yourself is the standing escape hatch for
// machines without the provider installed.

type secretRef struct {
	Provider string `json:"provider"` // key into secretProviders ("op")
	Path     string `json:"path"`     // provider-native path ("OSS/Anthropic/credential")
}

// secretProvider models one secret manager. The launcher constructs the
// argv itself from the stored path — no stored shell text is ever executed.
type secretProvider struct {
	display  string                     // human name for announcements
	bin      string                     // binary that must be on PATH
	pathHint string                     // the provider's path shape, for prompts and hints
	argv     func(path string) []string // the read invocation
}

var secretProviders = map[string]secretProvider{
	"op": {
		display:  "1Password",
		bin:      "op",
		pathHint: "<vault>/<item>/<field>",
		argv:     func(p string) []string { return []string{"read", "op://" + p} },
	},
}

// providerSchemes: registry keys, sorted — every prompt and usage line
// enumerates the registry rather than assuming a provider.
func providerSchemes() []string {
	schemes := make([]string, 0, len(secretProviders))
	for s := range secretProviders {
		schemes = append(schemes, s)
	}
	sort.Strings(schemes)
	return schemes
}

// refDisplay is the URI form shown everywhere: scheme://path.
func refDisplay(ref secretRef) string { return ref.Provider + "://" + ref.Path }

// refCommand is the exact command a resolution runs, for announcements.
func refCommand(ref secretRef) string {
	p := secretProviders[ref.Provider]
	return p.bin + " " + strings.Join(p.argv(ref.Path), " ")
}

// requireProviderBin is the clear, early PATH test: nothing else happens
// for a ref whose provider CLI is missing.
func requireProviderBin(u *ui, ref secretRef) bool {
	p := secretProviders[ref.Provider]
	if onPath(p.bin) {
		return true
	}
	u.fail("'%s' (%s CLI) is not on PATH — needed to read %s.", p.bin, p.display, refDisplay(ref))
	fmt.Fprintf(os.Stderr, "  Install it, or just export the variable yourself — the environment always wins.\n")
	return false
}

// resolveSecret runs the provider read with the terminal attached (stdin
// and stderr pass through so authorization prompts — Touch ID, etc. — work)
// and returns trimmed stdout. The value lives only in memory.
func resolveSecret(ref secretRef) (string, error) {
	p := secretProviders[ref.Provider]
	cmd := exec.Command(p.bin, p.argv(ref.Path)...)
	cmd.Stdin, cmd.Stderr = os.Stdin, os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("`%s` failed", refCommand(ref))
	}
	val := strings.TrimSpace(string(out))
	if val == "" {
		return "", fmt.Errorf("`%s` returned nothing", refCommand(ref))
	}
	return val, nil
}

// secretUsage enumerates the provider registry so nothing here assumes one.
func secretUsage() string {
	providers := ""
	for _, s := range providerSchemes() {
		p := secretProviders[s]
		providers += fmt.Sprintf("  %s://%s   %s (%s)\n", s, p.pathHint, p.display, p.bin)
	}
	return `Usage: semiont secret <set|list|rm> ...

Register where config secrets come from. The launcher stores only a POINTER
(provider + path) in roots.json — never a value — and reads it fresh on
every start, with the provider's own authorization prompt. Exporting the
variable yourself always wins, and is the escape hatch on machines without
any secret manager installed.

Commands:
  set <VAR> [<scheme>://<path>]   Register a source (verified with one read
                                  now). With no source given, an interactive
                                  flow picks the provider and path.
  list                            Show registered sources (pointers, never values)
  rm <VAR>                        Forget a source

Providers (the URI scheme picks one):
` + providers + `
Examples:
  semiont secret set ANTHROPIC_API_KEY
  semiont secret set ANTHROPIC_API_KEY op://OSS/Anthropic/credential
  semiont secret rm ANTHROPIC_API_KEY
`
}

// Secret implements `semiont secret` — set / list / rm over the registered
// sources.
func Secret(args []string) int {
	u := newUI(false)
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Print(secretUsage())
		if len(args) == 0 {
			return 1
		}
		return 0
	}
	switch args[0] {
	case "set":
		switch len(args) {
		case 2:
			return secretSetInteractive(u, args[1])
		case 3:
			return secretSet(u, args[1], args[2])
		default:
			u.fail("Usage: semiont secret set <VAR> [<scheme>://<path>]")
			return 1
		}
	case "list":
		reg := loadRoots()
		if len(reg.Secrets) == 0 {
			fmt.Println("No secret sources registered. (semiont secret set <VAR>)")
			return 0
		}
		vars := make([]string, 0, len(reg.Secrets))
		for v := range reg.Secrets {
			vars = append(vars, v)
		}
		sort.Strings(vars)
		for _, v := range vars {
			ref := reg.Secrets[v]
			note := ""
			if p := secretProviders[ref.Provider]; !onPath(p.bin) {
				note = "  " + u.wrap(ansiYellow, "('"+p.bin+"' not on PATH)")
			}
			fmt.Printf("  %s  %s%s\n", u.bold(v), refDisplay(ref), note)
		}
		fmt.Println(u.dim("  (pointers only — values are read fresh on every start; the environment always wins)"))
		return 0
	case "rm":
		if len(args) != 2 {
			u.fail("Usage: semiont secret rm <VAR>")
			return 1
		}
		reg := loadRoots()
		if _, ok := reg.Secrets[args[1]]; !ok {
			u.fail("No secret source registered for %s.", args[1])
			return 1
		}
		delete(reg.Secrets, args[1])
		saveRoots(reg)
		u.ok("Forgot the source for %s.", args[1])
		return 0
	default:
		u.fail("Unknown secret command: %s", args[0])
		fmt.Print(secretUsage())
		return 1
	}
}

func secretSet(u *ui, name, uri string) int {
	scheme, path, ok := strings.Cut(uri, "://")
	if !ok || path == "" {
		u.fail("Secret source must be <scheme>://<path> (supported schemes: %s).", strings.Join(providerSchemes(), ", "))
		return 1
	}
	if _, known := secretProviders[scheme]; !known {
		u.fail("Unknown secret provider '%s' (supported: %s).", scheme, strings.Join(providerSchemes(), ", "))
		return 1
	}
	return storeSecret(u, name, secretRef{Provider: scheme, Path: path})
}

// secretSetInteractive: `semiont secret set <VAR>` with no source — walk the
// provider registry, never assuming one. A lone installed provider is the
// prompt's default; the path prompt carries the provider's own shape.
func secretSetInteractive(u *ui, name string) int {
	fmt.Printf("Registering a secret source for %s — a pointer is stored, never the value.\n", u.bold(name))
	fmt.Println("Providers:")
	def := ""
	for _, s := range providerSchemes() {
		p := secretProviders[s]
		status := ""
		if onPath(p.bin) {
			if def == "" {
				def = s
			}
		} else {
			status = "  " + u.wrap(ansiYellow, "('"+p.bin+"' not on PATH)")
		}
		fmt.Printf("  %s — %s%s\n", u.bold(s), p.display, status)
	}
	in := bufio.NewReader(os.Stdin)
	prompt := "Provider: "
	if def != "" {
		prompt = "Provider [" + def + "]: "
	}
	fmt.Print(prompt)
	line, _ := in.ReadString('\n')
	scheme := strings.TrimSpace(line)
	if scheme == "" {
		scheme = def
	}
	p, known := secretProviders[scheme]
	if !known {
		u.fail("Unknown secret provider '%s' (supported: %s).", scheme, strings.Join(providerSchemes(), ", "))
		return 1
	}
	ref := secretRef{Provider: scheme}
	if !requireProviderBin(u, ref) {
		return 1
	}
	fmt.Printf("Path (%s): ", p.pathHint)
	line, _ = in.ReadString('\n')
	path := strings.TrimSpace(line)
	path = strings.TrimPrefix(path, scheme+"://") // a pasted full URI is fine too
	if path == "" {
		u.fail("A path is required.")
		return 1
	}
	ref.Path = path
	return storeSecret(u, name, ref)
}

// storeSecret is the shared tail of both set forms: early PATH test,
// verification read (value discarded), then the pointer write.
func storeSecret(u *ui, name string, ref secretRef) int {
	if !requireProviderBin(u, ref) {
		return 1
	}
	// Verify NOW, while the path is fresh in mind — a typo should fail at
	// setup, not at tomorrow's start. The value is read and discarded.
	u.log("Verifying: %s %s", refCommand(ref), u.dim("— expect an authorization prompt; the value is discarded"))
	if _, err := resolveSecret(ref); err != nil {
		u.fail("Verification failed: %v", err)
		return 1
	}
	reg := loadRoots()
	if reg.Secrets == nil {
		reg.Secrets = map[string]secretRef{}
	}
	reg.Secrets[name] = ref
	saveRoots(reg)
	u.ok("%s reads from %s at every start %s", u.bold(name), refDisplay(ref),
		u.dim("(pointer stored, never the value; exporting "+name+" overrides)"))
	return 0
}
