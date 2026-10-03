// Golden tests for the semiont launcher — the executable spec ported from
// the fleet's start.sh/logs.sh/stop.sh (GO-LAUNCHER.md §3).
//
// Everything external is faked: a private PATH holds one binary (fakert)
// under the name of each program the launcher runs — container, docker,
// podman, git, and what it asks this system about ports and processes — which
// records every invocation to an argv log and plays scripted responses. Detached `run -d`
// spawns real localhost listeners on the published ports so the launcher's
// health gates open. Tests never touch a real runtime.
//
// Run with -update-goldens to rewrite golden files after an adjudicated
// change — the bash scripts (and GO-LAUNCHER.md §3) stay the arbiter of what
// the goldens should say.
package main_test

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

var updateGoldens = flag.Bool("update-goldens", false, "rewrite golden files from observed output")

var (
	launcherBin string
	fakertBin   string
)

func TestMain(m *testing.M) {
	flag.Parse()
	// Refuse to run if a (possibly live) stack's staged configs exist: the
	// launcher's preflight sweeps /tmp/semiont-config.* and deleting the
	// backing files under a live container mount breaks that stack. In CI and
	// in a build container /tmp is clean; on a dev host, stop the stack first.
	// Windows has no shared /tmp to guard: a scenario there stages under the
	// temporary directory its own environment names.
	if runtime.GOOS != "windows" {
		if pre, _ := filepath.Glob("/tmp/semiont-config.*"); len(pre) > 0 {
			fmt.Fprintf(os.Stderr, "refusing to run: %v exist — a live stack may mount them (run semiont stop, or test in a container)\n", pre)
			os.Exit(1)
		}
	}
	binDir, err := os.MkdirTemp("", "launcher-bins")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(binDir)
	launcherBin = filepath.Join(binDir, harness.Exe("semiont"))
	fakertBin = filepath.Join(binDir, harness.Exe("fakert"))
	for target, pkg := range map[string]string{launcherBin: ".", fakertBin: "./internal/fakert"} {
		out, err := exec.Command("go", "build", "-o", target, pkg).CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr, "building %s: %v\n%s", pkg, err, out)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}

// askedOfTheSystem: the programs the launcher asks this system about ports
// and processes, which fakert answers as in every scenario.
func askedOfTheSystem() []string {
	if runtime.GOOS == "windows" {
		return []string{"netstat", "tasklist"}
	}
	return []string{"lsof", "ps", "pgrep"}
}

// shimDir builds a private PATH dir where fakert impersonates the given
// runtimes plus git and what the launcher asks the system (always present).
func shimDir(t *testing.T, runtimes ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range append(append([]string{"git"}, askedOfTheSystem()...), runtimes...) {
		// A symlink, or on Windows a hard link: a program is found there by
		// its .exe, and making a symlink takes a privilege.
		link := os.Symlink
		if runtime.GOOS == "windows" {
			link = os.Link
		}
		if err := link(fakertBin, filepath.Join(dir, harness.Exe(name))); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// mkKB lays out a fake KB clone with the two real config TOMLs.
func mkKB(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	cfgDir := filepath.Join(root, ".semiont", "semiontconfig")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ollama-gemma.toml", "anthropic.toml"} {
		b, err := os.ReadFile(filepath.Join("testdata", "kb", ".semiont", "semiontconfig", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cfgDir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The KB's committed identity card (.semiont/config).
	b, err := os.ReadFile(filepath.Join("testdata", "kb", ".semiont", "config"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".semiont", "config"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

type scenario struct {
	shim        string
	kb          string // also FAKERT_GIT_ROOT unless gitRoot overridden
	noGitRoot   bool
	noJWTSecret bool   // drop JWT_SECRET from the env (exercise generate + persist)
	cwd         string // launcher working dir; defaults to kb
	home        string
	fakertDir   string
	log         string
	extraEnv    []string
	stdin       string
}

func newScenario(t *testing.T, runtimes ...string) *scenario {
	t.Helper()
	s := &scenario{
		shim:      shimDir(t, runtimes...),
		kb:        asTheSystemNamesIt(t, mkKB(t)),
		home:      asTheSystemNamesIt(t, t.TempDir()),
		fakertDir: t.TempDir(),
	}
	if runtime.GOOS == "windows" {
		if err := os.MkdirAll(s.stagingParent(), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s.log = filepath.Join(s.fakertDir, "argv.log")
	// The audience fakert's issuer stamps into service-account tokens, so the
	// start's identity preflight sees what a real realm would emit. Derived
	// from the SAME committed fixture the launcher reads, so the two cannot
	// drift into disagreeing about this knowledge base's identity.
	if err := os.WriteFile(filepath.Join(s.fakertDir, "kb-resource.txt"),
		[]byte(kbFixtureResource(t)), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.killServes(t) })
	return s
}

// asTheSystemNamesIt: a directory by the one name the launcher will print for
// it. A temporary directory can be reached by another: through a symlink, or
// on Windows by a short name (RUNNER~1), and a path the launcher resolved
// would then match no placeholder.
func asTheSystemNamesIt(t *testing.T, dir string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

// stagingParent: where this scenario's launcher stages the configs it mounts.
// /tmp on macOS and Linux, which every scenario shares; on Windows the
// temporary directory the scenario's environment names.
func (s *scenario) stagingParent() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(s.home, "AppData", "Local", "Temp")
	}
	return "/tmp"
}

// stagingPattern: every staging dir under it, as the launcher prints it.
func (s *scenario) stagingPattern() string {
	return filepath.Join(s.stagingParent(), "semiont-config.*")
}

// stageRe matches one staging dir.
func (s *scenario) stageRe() *regexp.Regexp {
	return regexp.MustCompile(regexp.QuoteMeta(filepath.Join(s.stagingParent(), "semiont-config.")) + `[A-Za-z0-9]+`)
}

// kbFixtureResource: the resource identifier the KB fixture's committed
// `[site] domain` yields — the same derivation kbResource performs, which
// lives in an internal package this binary-level test cannot import.
func kbFixtureResource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "kb", ".semiont", "config"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), "domain")
		if !ok {
			continue
		}
		rest = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(rest), "="))
		domain := strings.Trim(rest, `"`)
		if domain == "" {
			break
		}
		return "https://" + strings.ReplaceAll(domain, ":", "/")
	}
	t.Fatalf("no [site] domain in the KB fixture — the preflight's audience cannot be derived")
	return ""
}

func (s *scenario) mustLog(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(s.log)
	if err != nil {
		t.Fatalf("argv log: %v", err)
	}
	return b
}

// killServes reaps the detached port listeners fakert spawned for `run -d`,
// waiting for each PORT to come free — the next test rebinds the same fixed
// ports, and a merely-signalled process can still hold one for a beat.
//
// The wait is on the ports, not on the pids, because a pid wait cannot
// succeed here: these listeners are spawned by the launcher (fakert's
// `run -d`), so the test process is not their parent and never wait()s for
// them. A killed orphan therefore stays a ZOMBIE — and a zombie still
// answers kill(pid, 0) — so the old loop ran its full 3-second budget on
// every call, about 200 times a suite. The ports are what the next test
// needs anyway, and the kernel frees those at exit, zombie or not.
// errorReporter: what killServes needs of a testing.T.
type errorReporter interface {
	Helper()
	Errorf(format string, args ...any)
}

func (s *scenario) killServes(t errorReporter) {
	t.Helper()
	pidfiles, _ := filepath.Glob(filepath.Join(s.fakertDir, "serve-*.pid"))
	type held struct{ port, pidfile string }
	var ports []held
	for _, pf := range pidfiles {
		b, err := os.ReadFile(pf)
		if err != nil {
			continue
		}
		// Pidfiles are "pid\n<ports>" — fakert records the ports for exactly
		// this wait (its own `stop` does the same). pid <= 1 is never one of
		// ours, and kill(-1) would signal every process.
		lines := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)
		if pid, err := strconv.Atoi(strings.TrimSpace(lines[0])); err == nil && pid > 1 {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		}
		if len(lines) > 1 {
			for _, port := range strings.Fields(lines[1]) {
				ports = append(ports, held{port, filepath.Base(pf)})
			}
		}
		_ = os.Remove(pf)
	}
	// Each port gets its own deadline, and one that never comes free fails
	// THIS test, naming it: a listener left behind otherwise answers for
	// whichever test next publishes the port.
	for _, h := range ports {
		freed := false
		for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
			ln, err := net.Listen("tcp", "127.0.0.1:"+h.port)
			if err == nil {
				_ = ln.Close()
				freed = true
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !freed {
			t.Errorf("port %s (%s) is still held 3s after its listener was killed: a later test publishing it would reach this one's listener", h.port, h.pidfile)
		}
	}
}

// repoRoot: the monorepo root, from this package's own location. Tests run
// with the package directory as cwd, which is apps/launcher.
func repoRoot() string {
	abs, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		panic(err)
	}
	return abs
}

func (s *scenario) env() []string {
	env := []string{
		"PATH=" + s.shim,
		"HOME=" + s.home,
		"FAKERT_LOG=" + s.log,
		"FAKERT_DIR=" + s.fakertDir,
		// The repo, so a fake service can read what its own image declares
		// it serves (FAKE-RUNTIME-FIDELITY P1). A PATH, not a belief: the
		// fake reads the Dockerfile, it is not told the answer.
		"FAKERT_REPO=" + repoRoot(),
	}
	if runtime.GOOS == "windows" {
		// Windows names the home, the application-data directory and the
		// temporary directory by variables of its own.
		env = append(env,
			"USERPROFILE="+s.home,
			"LOCALAPPDATA="+filepath.Join(s.home, "AppData", "Local"),
			"TEMP="+s.stagingParent(),
			"TMP="+s.stagingParent(),
		)
	}
	{
		// Pinned so the boot goldens are deterministic: an unpinned run
		// generates a fresh credential per service and every golden would
		// differ from the last.
		//
		// Tracks `serviceClients` in internal/launcher, which this external test
		// package cannot see. Drift is loud rather than silent: a service missing
		// from this list gets a generated credential and its boot golden differs
		// on the very next run.
		for _, svc := range []string{"archivist", "dispatcher", "gateway", "librarian", "smelter", "weaver", "worker"} {
			env = append(env, "SEMIONT_OIDC_CLIENT_SECRET_"+strings.ToUpper(svc)+"=test-"+svc+"-client-secret")
		}
	}
	// Pinned for the same reason the retired worker secret was: a generated one is
	// random, and the boot goldens compare argv verbatim. Tests that need the
	// generate-and-persist path set noJWTSecret.
	if !s.noJWTSecret {
		env = append(env, "JWT_SECRET=test-jwt-secret-0123456789abcdef")
	}
	if !s.noGitRoot {
		env = append(env, "FAKERT_GIT_ROOT="+s.kb)
	}
	return append(env, s.extraEnv...)
}

func (s *scenario) run(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, launcherBin, args...)
	cmd.Dir = s.kb
	if s.cwd != "" {
		cmd.Dir = s.cwd
	}
	cmd.Env = s.env()
	cmd.Stdin = strings.NewReader(s.stdin)
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("launcher timed out\nstdout:\n%s\nstderr:\n%s", out.String(), errb.String())
	}
	code = 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("running launcher: %v", err)
	}
	return out.String(), errb.String(), code
}

// containerEnv: the value a container started with for name — whether it rode
// the command line or crossed through the runtime's own environment, which
// fakert records per container (env-<container>) as `inspect` would show it.
func (s *scenario) containerEnv(t *testing.T, container, name string) (string, bool) {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(s.fakertDir, "env-"+container))
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(l, name+"="); ok {
			return v, true
		}
	}
	return "", false
}

// argv returns the recorded invocation log with run-specific paths
// normalized to stable placeholders.
func (s *scenario) argv(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(s.log)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return s.norm(string(b))
}

// norm replaces the scenario's per-run paths with stable placeholders — the
// same normalization for argv logs and stdout goldens, so a host path in
// either (the discovery mount taught us) can never bake a tmp dir into a
// golden that greens on refresh and reds on every later run.
func (s *scenario) norm(text string) string {
	// A directory before the one it is under: on Windows the staging dir and
	// both homes are under the scenario's home.
	out := strings.ReplaceAll(text, s.stagingPattern(), "<config-stages>")
	out = withPlaceholder(out, s.stageRe(), "<config-stage>")
	for _, d := range []struct{ dir, placeholder string }{
		{dataHomeFor(s.home), "<data-home>"},
		{stateHomeFor(s.home), "<state-home>"},
		{s.kb, "<kb-root>"},
		{s.home, "<home>"},
	} {
		out = withPlaceholder(out, regexp.MustCompile(regexp.QuoteMeta(d.dir)), d.placeholder)
	}
	// The Keycloak bootstrap admin password is GENERATED per root and
	// persisted there, so it is different in every scenario and every run —
	// a value that bakes into a golden which greens on refresh and reds
	// forever after, exactly like the tmp dirs above. Plan mode already
	// renders this placeholder (executor.go), so live and dry-run goldens
	// now agree on the one line that cannot be a literal.
	out = keycloakAdminPwRe.ReplaceAllString(out, "KC_BOOTSTRAP_ADMIN_PASSWORD=<keycloak-admin-password>")
	return out
}

// inJSON: a path as it reads inside a JSON string, where Windows' separator
// is written twice.
func inJSON(path string) string {
	return strings.ReplaceAll(path, `\`, `\\`)
}

// nowhere: an absolute path, on this system, to a directory that is not
// there.
func nowhere(t *testing.T, names ...string) string {
	t.Helper()
	return filepath.Join(append([]string{asTheSystemNamesIt(t, t.TempDir())}, names...)...)
}

// stopHint: the command the launcher suggests for ending processes here.
func stopHint(pid string) string {
	if runtime.GOOS == "windows" {
		return "taskkill /PID " + pid
	}
	return "kill " + pid
}

// withPlaceholder swaps a per-run directory for a stable placeholder wherever
// text names it or a path beneath it, and writes that path with slashes,
// which is how the goldens have it on every system.
func withPlaceholder(text string, dir *regexp.Regexp, placeholder string) string {
	if os.PathSeparator == '/' {
		return dir.ReplaceAllString(text, placeholder)
	}
	beneath := regexp.MustCompile(`(` + dir.String() + `)((?:\\[^\\\s:"',]+)*)`)
	return beneath.ReplaceAllStringFunc(text, func(path string) string {
		tail := beneath.FindStringSubmatch(path)[2]
		return placeholder + strings.ReplaceAll(tail, `\`, "/")
	})
}

// asThisSystemRuns: a golden as this system's launcher produces it. The
// goldens are written on Linux, which differs from the others in two ways a
// placeholder cannot hide: it keeps its state and its data in two homes where
// macOS and Windows keep one, and it asks lsof and ps what Windows asks
// netstat and tasklist.
func asThisSystemRuns(golden string) string {
	if dataHomeFor("") == stateHomeFor("") {
		golden = strings.ReplaceAll(golden, "<state-home>", "<data-home>")
	}
	if runtime.GOOS == "windows" {
		golden = lsofLine.ReplaceAllString(golden, "netstat -ano -p TCP")
		golden = psLine.ReplaceAllString(golden, "tasklist /FI PID eq $1 /FO CSV /NH")
	}
	return golden
}

var (
	lsofLine = regexp.MustCompile(`(?m)^lsof -nP -iTCP:\d+ -sTCP:LISTEN$`)
	psLine   = regexp.MustCompile(`(?m)^ps -p (\d+) -o comm=$`)
)

// Any generated value — the hex the launcher mints — but NOT a pinned one a
// test set deliberately (KC_BOOTSTRAP_ADMIN_PASSWORD=test-keycloak-admin),
// which is stable and worth asserting verbatim.
var keycloakAdminPwRe = regexp.MustCompile(`KC_BOOTSTRAP_ADMIN_PASSWORD=[0-9a-f]{32}`)

func checkGolden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "golden", name)
	if *updateGoldens {
		if runtime.GOOS != "linux" {
			t.Fatalf("the goldens are written on Linux (asThisSystemRuns): -update-goldens on %s would write this system's into them", runtime.GOOS)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update-goldens after adjudicating): %v", name, err)
	}
	if want := asThisSystemRuns(string(written)); want != got {
		t.Errorf("golden mismatch for %s\n--- want ---\n%s\n--- got ---\n%s", name, want, got)
	}
}

func mustContain(t *testing.T, label, haystack string, needles ...string) {
	t.Helper()
	for _, n := range needles {
		if !strings.Contains(haystack, n) {
			t.Errorf("%s missing %q; full text:\n%s", label, n, haystack)
		}
	}
}

// emits returns every /bus/emit body the fake captured, in order, across
// every run of the scenario. lastEmit is the most recent one — the right
// assertion for a verb whose final exchange is the interesting one (match
// gathers before it searches; yield --delegate gathers before it creates a
// job). A verb that sends SEVERAL commands must be checked against emits.
func emits(t *testing.T, s *scenario) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(s.fakertDir, "bus-emit.jsonl"))
	if err != nil {
		t.Fatalf("no emits captured: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		t.Fatal("no emits captured: the file is empty")
	}
	return lines
}

func lastEmit(t *testing.T, s *scenario) string {
	t.Helper()
	all := emits(t, s)
	return all[len(all)-1]
}

// --- start: full boots against the fake runtime ---

// A knowledge base's config says what it needs and nothing of where: with
// every address line gone, the launcher places the same stack, command for
// command, as it does for a config that writes each address as the launcher's
// reference. The golden is the default boot's own.
func TestStartBootsAConfigThatStatesNoAddress(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", "ollama-gemma.toml")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	stated := regexp.MustCompile(`(?m)^(servers|uri|host|baseURL|issuer) = .*\n`)
	if n := len(stated.FindAll(b, -1)); n < 6 {
		t.Fatalf("the fixture config states only %d addresses: this test would prove little", n)
	}
	if err := os.WriteFile(p, stated.ReplaceAll(b, nil), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-default-boot.argv", s.argv(t))
	// What each service is staged states where everything is, as literals.
	librarian := stagedFile(t, s, "librarian.toml")
	mustContain(t, "staged librarian.toml", librarian,
		"bolt://192.168.64.1:7687", "http://192.168.64.1:11434", "http://192.168.64.1:8080/realms/semiont")
	if strings.Contains(librarian, "_HOST}") {
		t.Errorf("the staged librarian.toml leaves an address to its environment:\n%s", librarian)
	}
	mustContain(t, "staged dispatcher.json", stagedFile(t, s, "dispatcher.json"), "192.168.64.1:4222")
}

func TestStartDefaultBoot(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-default-boot.argv", s.argv(t))
	// embedding is a ROLE, like any other. It has no container of its own —
	// the config declares it external, served here by the same Ollama the
	// inference role provides — and an external role participates in status
	// while supporting no start/stop. So: a row, runtime "external", and no
	// container in the record.
	rec, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(rec), `"embedding"`)
	if strings.Contains(string(rec), `"container": "semiont-embedding"`) {
		t.Errorf("embedding recorded a container it does not own:\n%s", rec)
	}
	// An ollama embedding is served by the SAME Ollama the inference role
	// provides, so it must report the same provider — describing one process
	// two ways ("host" here, "external" there) is the bug this pins.
	var doc struct {
		Stacks map[string]struct {
			Services map[string]struct {
				Provided string `json:"provided"`
			} `json:"services"`
		} `json:"stacks"`
	}
	if err := json.Unmarshal(rec, &doc); err != nil {
		t.Fatalf("stack.json: %v", err)
	}
	svcs := doc.Stacks["local"].Services
	if got, want := svcs["embedding"].Provided, svcs["inference"].Provided; got != want {
		t.Errorf("embedding provider %q != inference provider %q — same Ollama, two answers", got, want)
	}
	sstdout, _, _ := s.run(t, "status")
	mustContain(t, "status", sstdout, "embedding (Ollama)")
	mustContain(t, "stdout", stdout,
		"KB: Test Knowledge Base did:web:example.github.io:test-kb",
		"No prior containers",
		"🚀 Semiont stack is up",
		"http://localhost:3000",
		"http://localhost:4000",
		"http://localhost:7474",
		"http://localhost:6333/dashboard",
		"http://localhost:16686",
		"semiont status",
		"semiont logs",
		"semiont stop",
	)
	// A service credential must never reach the terminal, or the command line
	// the terminal echoes: it crosses through the runtime's environment
	// (SECRET-DELIVERY P6). Six of them, one per service account.
	if strings.Contains(stdout, "test-gateway-client-secret") || strings.Contains(s.argv(t), "test-gateway-client-secret") {
		t.Error("a service-account secret reached stdout or a command line")
	}
	mustContain(t, "stdout", stdout, "--env SEMIONT_OIDC_CLIENT_SECRET ")
}

// The launcher half of the split supervision gate (ORCHESTRATOR-NATIVE-IMAGES
// D3/D6; the image half is scripts/compliance/audit-supervision.sh). Published
// images run their CMD directly — supervision is a per-run opt-in, and LOCAL
// placement is the one place with no orchestrator restart policy, so the
// launcher must grant it to every service it starts. A service missing the
// flag runs silently unsupervised: its first crash stays down, which is
// exactly the outage the supervisor exists to prevent.
func TestStartOptsEveryServiceIntoSupervision(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(s.argv(t), "\n") {
		for _, svc := range []string{"gateway", "worker", "smelter", "weaver", "archivist", "librarian", "browser"} {
			if strings.Contains(line, " --name semiont-"+svc+" ") {
				seen[svc] = true
				mustContain(t, "semiont-"+svc+" run argv", line, "--env SEMIONT_SUPERVISE=1")
			}
		}
	}
	for _, svc := range []string{"gateway", "worker", "smelter", "weaver", "archivist", "librarian", "browser"} {
		if !seen[svc] {
			t.Errorf("no run argv for semiont-%s — the gate saw nothing to check", svc)
		}
	}
}

func TestStartDaemonDownAdvisesSystemStart(t *testing.T) {
	s := newScenario(t, "container")
	// The Apple container apiserver is down: the first command that NEEDS
	// an answer is the host-address probe, so daemon-down surfaces there
	// wearing a networking costume. The failure must diagnose the actual
	// condition and name the fix.
	s.extraEnv = append(s.extraEnv, "FAKERT_DAEMON_DOWN=1")
	stdout, stderr, code := s.run(t, "start")
	if code == 0 {
		t.Fatalf("start with the daemon down must fail\nstdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
	mustContain(t, "daemon-down fix-it", stdout+stderr, "container system start")
}

// On a codespace resume, post-start's start ran eight seconds after dockerd:
// the daemon answered, but its first probe container could not run, and start
// refused — a resumed KB with no stack (bugs/post-start-races-docker-on-resume.md).
// An answering daemon gets a bounded wait; its own error is quoted if it never
// comes good.
func TestHostProbeWaitsForARuntimeThatCannotRunContainersYet(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_BUSYBOX_FAIL_FIRST=3")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("a runtime that comes good within the budget must not refuse: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "the wait is announced", stdout+stderr, "cannot run a container yet")
}

func TestHostProbeRefusalQuotesTheRuntime(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_BUSYBOX_FAIL_FIRST=1000")
	_, stderr, code := s.run(t, "start")
	if code == 0 {
		t.Fatal("a runtime that never runs the probe must refuse")
	}
	mustContain(t, "the runtime's own words", stderr, "network bridge not found")
}

// Two starts on one KB root at once — live 2026-09-29, a codespace's post-start
// and the laptop's issuer move — interleaved: each swept containers the other was
// about to use, and the stack ended half on each issuer port
// (bugs/codespace-issuer-move-races-post-start.md P1). The second now waits for
// the first, then runs its own whole sequence.
func TestConcurrentStartsOnOneRootQueue(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_RUN_HOLD=semiont-archivist")
	type result struct {
		out  string
		code int
	}
	first, second := make(chan result, 1), make(chan result, 1)
	go func() { o, e, c := s.run(t, "start"); first <- result{o + e, c} }()
	held := filepath.Join(s.fakertDir, "holding-semiont-archivist")
	for i := 0; i < 600; i++ {
		if _, err := os.Stat(held); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	go func() { o, e, c := s.run(t, "start"); second <- result{o + e, c} }()
	time.Sleep(3 * time.Second) // time enough to interleave, if it can
	if err := os.WriteFile(filepath.Join(s.fakertDir, "release-semiont-archivist"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	r1, r2 := <-first, <-second
	if r1.code != 0 || r2.code != 0 {
		t.Fatalf("both starts must succeed: first %d, second %d\nfirst:\n%s\nsecond:\n%s", r1.code, r2.code, r1.out, r2.out)
	}
	mustContain(t, "the second start says what it waits for", r2.out, "Another semiont start is running for this KB")
	// No interleaving: the second start's first container command (the host
	// probe) comes after the first start has run its last service.
	lines := strings.Split(s.argv(t), "\n")
	firstWeaver, secondProbe, probes := -1, -1, 0
	for i, l := range lines {
		if firstWeaver < 0 && strings.Contains(l, "--name semiont-weaver") {
			firstWeaver = i
		}
		if strings.Contains(l, "ip route") {
			if probes++; probes == 2 {
				secondProbe = i
			}
		}
	}
	if firstWeaver < 0 || secondProbe < 0 || secondProbe < firstWeaver {
		t.Errorf("the second start ran while the first was mid-flight (second's host probe at line %d, first's weaver at %d):\n%s", secondProbe, firstWeaver, s.argv(t))
	}
}

// status --root is what a laptop asks a codespace before moving its issuer:
// "is the stack up?" A stack mid-start is not, however healthy its gateway
// already is — the record lists only what has started so far.
func TestStatusRootSaysNotReadyWhileAStartRuns(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_RUN_HOLD=semiont-archivist")
	done := make(chan int, 1)
	go func() { _, _, c := s.run(t, "start"); done <- c }()
	held := filepath.Join(s.fakertDir, "holding-semiont-archivist")
	for i := 0; i < 600; i++ {
		if _, err := os.Stat(held); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	_, stderr, code := s.run(t, "status", "--root", s.kb)
	if err := os.WriteFile(filepath.Join(s.fakertDir, "release-semiont-archivist"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if c := <-done; c != 0 {
		t.Fatalf("the held start failed: exit %d", c)
	}
	if code == 0 {
		t.Fatal("status --root reported a stack ready while its start was still running")
	}
	mustContain(t, "status names the start in progress", stderr, "A semiont start is running for this KB")
}

func TestStartRuntimeDockerBoot(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	s.extraEnv = append(s.extraEnv, "FAKERT_NSLOOKUP=ok")
	stdout, stderr, code := s.run(t, "start", "--runtime", "docker")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-docker-boot.argv", s.argv(t))
}

// movableKeycloakPort rewrites the KB's configs to name the issuer's port by
// ${KEYCLOAK_PORT}, as a newborn KB's do, so a start takes and records it.
func movableKeycloakPort(t *testing.T, s *scenario) {
	t.Helper()
	for _, name := range []string{"ollama-gemma.toml", "anthropic.toml"} {
		p := filepath.Join(s.kb, ".semiont", "semiontconfig", name)
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		b = []byte(strings.ReplaceAll(string(b), "${KEYCLOAK_HOST}:8080/realms", "${KEYCLOAK_HOST}:${KEYCLOAK_PORT}/realms"))
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// CODESPACE-IDENTITY B4: the issuer's port is the launcher's to place, like
// its host — one Keycloak port per KB, the same number on both ends, so a
// laptop can hold a forward per codespace KB. KEYCLOAK_PORT follows the
// launcher's env shape: the environment wins, the root records it, and 8080
// is the default. The codespace's post-start runs a bare start on every
// resume, which is why the port a laptop moved it to must stick. The port
// reaches each service as part of the issuer its staged config states.
func TestKeycloakPortIsPlacedAndSticky(t *testing.T) {
	s := newScenario(t, "container")
	movableKeycloakPort(t, s)
	keycloakRun := func(t *testing.T, argv string) string {
		t.Helper()
		for _, line := range strings.Split(argv, "\n") {
			if strings.Contains(line, "run -d --name semiont-keycloak") {
				return line
			}
		}
		t.Fatalf("no Keycloak run in:\n%s", argv)
		return ""
	}
	base := s.extraEnv
	for _, step := range []struct {
		name string
		env  []string
		want string
	}{
		{"default", nil, "8080"},
		{"environment wins", []string{"KEYCLOAK_PORT=8081"}, "8081"},
		{"recorded for the next bare start", nil, "8081"},
	} {
		s.extraEnv = append(append([]string{}, base...), step.env...)
		before := len(s.argv(t))
		stdout, stderr, code := s.run(t, "start")
		if code != 0 {
			t.Fatalf("%s: exit %d\nstdout:\n%s\nstderr:\n%s", step.name, code, stdout, stderr)
		}
		argv := s.argv(t)[before:]
		if run := keycloakRun(t, argv); !strings.Contains(run, "-p "+step.want+":8080") {
			t.Errorf("%s: Keycloak not published on %s:\n%s", step.name, step.want, run)
		}
		issuer := "http://192.168.64.1:" + step.want + "/realms/semiont"
		for _, staged := range []string{"worker.toml", "archivist.toml", "gateway.json", "dispatcher.json"} {
			if !strings.Contains(stagedFile(t, s, staged), issuer) {
				t.Errorf("%s: the staged %s does not state the issuer at port %s:\n%s", step.name, staged, step.want, stagedFile(t, s, staged))
			}
		}
		if strings.Contains(argv, "KEYCLOAK_PORT=") || strings.Contains(argv, "KEYCLOAK_HOST=") {
			t.Errorf("%s: a container is told of the issuer through its environment:\n%s", step.name, argv)
		}
	}
	roots, err := os.ReadFile(filepath.Join(filepath.Dir(statePathFor(s.home)), "roots.json"))
	if err != nil {
		t.Fatal(err)
	}
	mustContain(t, "roots.json", string(roots), `"keycloakPort": 8081`)
}

// Under Docker and Podman the issuer is named keycloak.localhost, whatever the
// host-address probe answers. An issuer is one URL — the Browser and every
// container must reach it by the same name — and the Browser is never on the
// Docker host's bridge: in docker-in-docker (a codespace) the alias does not
// resolve, the probe falls back to the bridge gateway, and a laptop cannot
// reach 172.17.0.1. The probe still decides every other dependency host.
func TestDockerAndPodmanNameTheIssuerKeycloakLocalhost(t *testing.T) {
	for _, rt := range []string{"docker", "podman"} {
		for _, probe := range []struct {
			name string
			env  []string
			addr string
		}{
			{"alias", []string{"FAKERT_NSLOOKUP=ok"}, map[string]string{"docker": "host.docker.internal", "podman": "host.containers.internal"}[rt]},
			{"bridge", []string{"FAKERT_GATEWAY=172.17.0.1"}, "172.17.0.1"},
		} {
			t.Run(rt+"/"+probe.name, func(t *testing.T) {
				s := newScenario(t, "container", "docker", "podman")
				s.extraEnv = append(s.extraEnv, probe.env...)
				stdout, stderr, code := s.run(t, "start", "--runtime", rt)
				if code != 0 {
					t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
				}
				// Every container that holds a credential at the realm must
				// resolve the issuer's name; a builder that forgot either half
				// would fail sign-in or its own start.
				dialers := 0
				for _, line := range strings.Split(s.argv(t), "\n") {
					if !strings.Contains(line, "SEMIONT_OIDC_CLIENT_ID=") {
						continue
					}
					dialers++
					if !strings.Contains(line, "--add-host keycloak.localhost:host-gateway") {
						t.Errorf("a container holding a realm credential cannot resolve the issuer's name:\n%s", line)
					}
				}
				if dialers == 0 {
					t.Fatal("no container carries SEMIONT_OIDC_CLIENT_ID — the scan matched nothing, so it proved nothing")
				}
				// The issuer is named in what each service is staged; the probe's
				// answer still places every other daemon.
				librarian := stagedFile(t, s, "librarian.toml")
				if !strings.Contains(librarian, "http://keycloak.localhost:8080/realms/semiont") {
					t.Errorf("the staged issuer is not the issuer's name:\n%s", librarian)
				}
				if !strings.Contains(librarian, "bolt://"+probe.addr+":7687") {
					t.Errorf("the probe's answer %s no longer places the other daemons:\n%s", probe.addr, librarian)
				}
			})
		}
	}
}

func TestStartNoObserveBoot(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--no-observe")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-no-observe-boot.argv", s.argv(t))
	// Against the normalized output, for the reason
	// TestServiceGatewayPortFollowsConfig gives.
	if said := s.norm(stdout); strings.Contains(said, "16686") {
		t.Errorf("--no-observe stdout mentions Jaeger:\n%s", said)
	}
}

func TestStartHostOllamaBoot(t *testing.T) {
	// A listener on 11434 makes the launcher's host-Ollama probe succeed;
	// FAKERT_OLLAMA_REACHABLE scripts the container-side reachability probe.
	ln, err := net.Listen("tcp", "127.0.0.1:11434")
	if err != nil {
		t.Fatalf("port 11434 unavailable for host-Ollama simulation: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `{"version":"0.0.0-fake"}`)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_OLLAMA_REACHABLE=1")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-host-ollama-boot.argv", s.argv(t))
	mustContain(t, "stdout", stdout, "inference — using host Ollama at http://localhost:11434")
}

// CODESPACE-IDENTITY B6: a re-run start over a live stack took its OWN Ollama
// container for a host install — "using host Ollama at http://localhost:11434"
// on the spike's second run, with semiont-ollama left running and recorded as
// the host's. B4 reruns start over a live stack, so this is the normal path.
func TestRerunStartReplacesItsOwnOllama(t *testing.T) {
	s := newScenario(t, "container")
	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("first start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	before := len(s.argv(t))
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if strings.Contains(stdout, "using host Ollama") {
		t.Errorf("the re-run took the stack's own semiont-ollama for a host install:\n%s", stdout)
	}
	second := s.argv(t)[before:]
	mustContain(t, "second run's argv", second, "rm semiont-ollama", "--name semiont-ollama")
}

func TestStartLocalVersionBoot(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "SEMIONT_VERSION=local")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-local-version-boot.argv", s.argv(t))
	if strings.Contains(s.argv(t), " pull ") {
		t.Error("SEMIONT_VERSION=local must not pull images")
	}
}

// --- start: fail-fast paths ---

func TestStartMissingEnvVar(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--config", "anthropic")
	if code != 1 {
		t.Fatalf("want exit 1, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stderr", stderr,
		"Config 'anthropic' references ${ANTHROPIC_API_KEY} but it is not set in the environment.",
		"register a secret source once:  semiont settings secret set ANTHROPIC_API_KEY")
	checkGolden(t, "start-missing-env.argv", s.argv(t))
}

func TestStartPortConflict(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_LSOF_7474=12345", "FAKERT_PS_12345=node")
	stdout, stderr, code := s.run(t, "start")
	if code != 1 {
		t.Fatalf("want exit 1, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stderr", stderr,
		"Port 7474 (needed for Neo4j HTTP) is held by 12345 (node).",
		"This is not a Semiont container. Stop it and re-run (e.g. "+stopHint("12345")+").")
	checkGolden(t, "start-port-conflict.argv", s.argv(t))
}

func TestStartHelpOutsideClone(t *testing.T) {
	s := newScenario(t, "container")
	s.noGitRoot = true
	stdout, _, code := s.run(t, "start", "--help")
	if code != 0 {
		t.Fatalf("start --help outside a clone must exit 0, got %d", code)
	}
	mustContain(t, "stdout", stdout, "--config <name>", "--dry-run", "--ollama-cache")
	if got := s.argv(t); got != "" {
		t.Errorf("--help must not run any external command, ran:\n%s", got)
	}
}

func TestStartOutsideCloneFails(t *testing.T) {
	s := newScenario(t, "container")
	s.noGitRoot = true
	_, stderr, code := s.run(t, "start")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "git clone", "Download ZIP")
}

func TestStartUnknownArg(t *testing.T) {
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "start", "--bogus")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "Unknown argument: --bogus")
}

func TestStartCredentialValidation(t *testing.T) {
	// Admin seeding moved to `semiont useradd` (the exec bridge); start no
	// longer knows these flags at all.
	s := newScenario(t, "container")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"start", "--email", "a@b.co"}, "Unknown argument: --email"},
		{[]string{"start", "--password", "longenough"}, "Unknown argument: --password"},
	} {
		_, stderr, code := s.run(t, tc.args...)
		if code != 1 {
			t.Errorf("%v: want exit 1, got %d", tc.args, code)
		}
		mustContain(t, fmt.Sprintf("stderr for %v", tc.args), stderr, tc.want)
	}
}

func TestStartListConfigs(t *testing.T) {
	s := newScenario(t, "container")
	stdout, _, code := s.run(t, "start", "--list-configs")
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	mustContain(t, "stdout", stdout, "Available configs:", "anthropic", "ollama-gemma")
}

func TestStartConfigNotFound(t *testing.T) {
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "start", "--config", "nope")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "Config not found: "+filepath.FromSlash(".semiont/semiontconfig/nope.toml"))
}

func TestStartNoRuntime(t *testing.T) {
	s := newScenario(t) // shim has git/lsof/ps only — no runtimes
	_, stderr, code := s.run(t, "start")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "No container runtime found. Install Apple Container, Docker, or Podman.")
}

func TestStartRuntimeValidation(t *testing.T) {
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "start", "--runtime", "banana")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "Unknown --runtime 'banana'")

	_, stderr, code = s.run(t, "start", "--runtime", "docker")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "--runtime docker requested, but 'docker' is not on PATH.")
}

func TestStartCleanOllama(t *testing.T) {
	s := newScenario(t, "container")
	stdout, _, code := s.run(t, "start", "--clean-ollama")
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	mustContain(t, "stdout", stdout, "Removed.")
	mustContain(t, "argv", s.argv(t), "container volume rm semiont-ollama-models")

	s2 := newScenario(t, "container")
	s2.extraEnv = append(s2.extraEnv, "FAKERT_VOLUME_ABSENT=1")
	stdout, _, code = s2.run(t, "start", "--clean-ollama")
	if code != 0 {
		t.Fatalf("want exit 0 when volume absent, got %d", code)
	}
	mustContain(t, "stdout", stdout, "Volume not found.")
}

// --- start: --dry-run goldens (the legibility seam) ---

// The per-service dry-runs for the two observability backends: the exact
// `container run` an operator would get, pinned so the rendering cannot
// silently regress (the full-start dry-runs are pinned; per-service ones
// mostly are not).
func TestStartDryRunServiceTraces(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--service", "traces", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "start-dryrun-service-traces.txt", s.norm(stdout))
}

func TestStartDryRunServiceMetrics(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--service", "metrics", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "start-dryrun-service-metrics.txt", s.norm(stdout))
}

func TestStartDryRunDefault(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "start-dryrun-default.txt", s.norm(stdout))
	// Dry run must execute nothing beyond KB-root resolution.
	if got := s.argv(t); got != "git -C <kb-root> rev-parse --show-toplevel\n" {
		t.Errorf("dry run executed external commands:\n%s", got)
	}
}

func TestStartDryRunLocalVersion(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "SEMIONT_VERSION=local")
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "start-dryrun-local.txt", s.norm(stdout))
}

// --- local-stack state persistence (LAUNCHER-STATE.md) ---

// stateHomeFor and dataHomeFor: where the launcher keeps its state and its
// data under a scenario's home, on this system. Linux has the two XDG homes;
// macOS and Windows keep both in one.
func stateHomeFor(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "semiont")
	case "windows":
		return filepath.Join(home, "AppData", "Local", "semiont")
	}
	return filepath.Join(home, ".local", "state", "semiont")
}

func dataHomeFor(home string) string {
	switch runtime.GOOS {
	case "darwin", "windows":
		return stateHomeFor(home)
	}
	return filepath.Join(home, ".local", "share", "semiont")
}

// stateRootFor: a root's state dir under the scenario's home.
func stateRootFor(home, key string) string {
	return filepath.Join(dataHomeFor(home), "roots", key)
}

// testKBKey: the slug of the test KB's did:web (testdata/kb/.semiont/config).
const testKBKey = "example.github.io-test-kb"

func TestStatePersistsAcrossStarts(t *testing.T) {
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("first start: exit %d\nstderr:\n%s", code, stderr)
	}
	dir := stateRootFor(s.home, testKBKey)
	meta, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatalf("meta.json after start: %v", err)
	}
	mustContain(t, "meta.json", string(meta), "postgres:15.18-alpine", inJSON(s.kb))
	if _, err := os.Stat(filepath.Join(dir, "postgres")); err != nil {
		t.Fatalf("postgres state dir after start: %v", err)
	}
	// A second start must REUSE the same dir — that is the whole feature:
	// the mount appears in both boots' argv, same path both times.
	s.killServes(t)
	_, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstderr:\n%s", code, stderr)
	}
	mount := filepath.Join(dir, "postgres") + ":/var/lib/postgresql/data"
	if got := strings.Count(string(s.mustLog(t)), mount); got != 2 {
		t.Errorf("state mount should appear in both boots (want 2, got %d)", got)
	}
}

// The anchored-text store — a coordinate map per representation that costs
// ~2.9s/page of OCR to rebuild — is mounted state, not container state.
// Unmounted it lives in the container and dies with it on every `stop`, and
// nothing re-derives it: reconcile plans work from Qdrant, which persists, so
// it sees matching checksums and does nothing.
//
// The container path is a constant of the gateway image, declared as
// SEMIONT_ANCHORED_TEXT_DIR the way SEMIONT_ROOT=/kb is — so this mount looks
// like every other one: KB identity on the host side only.
func TestGatewayDataPersistsAcrossStarts(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("first start: exit %d\nstderr:\n%s", code, stderr)
	}
	dir := stateRootFor(s.home, testKBKey)
	if _, err := os.Stat(filepath.Join(dir, "anchored-text")); err != nil {
		t.Fatalf("anchored-text state dir after start: %v", err)
	}
	mount := filepath.Join(dir, "anchored-text") + ":/anchored-text"
	firstBoot := strings.Count(string(s.mustLog(t)), mount)

	s.killServes(t)
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("second start: exit %d\nstderr:\n%s", code, stderr)
	}
	// The invariant is PERSISTENCE — a restart mounts the store exactly as
	// the first boot did — so it is asserted against the first boot rather
	// than against a hard-coded total.
	//
	// A literal count would encode fleet size, which is not what this test is
	// about and which keeps moving: two mounters, then three when the Smelter
	// took the store (ANCHORED-TEXT-TO-SMELTER P1), and two again at that
	// plan's P5 when the stamp follows the writer and the gateway's mount
	// goes. Every one of those is a correct state, and none of them should
	// make this test fail.
	if firstBoot == 0 {
		t.Fatalf("anchored-text mount absent from the first boot")
	}
	if total := strings.Count(string(s.mustLog(t)), mount); total != firstBoot*2 {
		t.Errorf("anchored-text mount did not survive the restart: %d on the first boot, %d across both", firstBoot, total)
	}
}

// It is a projection — every entry is reproducible from the resource's bytes —
// so `clean` may take it, and an image change clears rather than refuses.
func TestCleanTakesGatewayState(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	dir := stateRootFor(s.home, testKBKey)
	// Sharded the way the KB's own event log is sharded (decision E), so the
	// sweep must reach through the fan-out, not just the top directory.
	entry := filepath.Join(dir, "anchored-text", "ab", "cd")
	if err := os.MkdirAll(entry, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(entry, "deadbeef.json"), []byte(`{"v":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, stderr, code := s.run(t, "clean", "--store", "anchored-text")
	if code != 0 {
		t.Fatalf("clean --store anchored-text: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(dir, "anchored-text")); !os.IsNotExist(err) {
		t.Errorf("clean --store anchored-text left the tree behind: %v", err)
	}
	// And the other stores are untouched — a scoped clean is scoped.
	if _, err := os.Stat(filepath.Join(dir, "postgres")); err != nil {
		t.Errorf("clean --store anchored-text took postgres too: %v", err)
	}
}

func TestStateImageMismatchRefuses(t *testing.T) {
	s := newScenario(t, "container")
	// Existing postgres data written by a DIFFERENT image version: the
	// launcher must refuse — user rows are not a projection it may delete.
	dir := stateRootFor(s.home, testKBKey)
	pg := filepath.Join(dir, "postgres", "pgdata")
	if err := os.MkdirAll(pg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pg, "PG_VERSION"), []byte("14\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := `{"kbRoot":"` + inJSON(s.kb) + `","stores":{"database":{"image":"postgres:14.9-alpine"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	// What that earlier stack also kept: the password its data was
	// initialized with (SECRET-DELIVERY P4).
	if err := os.WriteFile(filepath.Join(dir, "postgres-password"), []byte("kept-by-an-earlier-start\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start")
	if code == 0 {
		t.Fatalf("start over another image's data must refuse\nstdout:\n%s", stdout)
	}
	mustContain(t, "refusal", stdout+stderr,
		"postgres:14.9-alpine",           // what wrote the data
		"postgres:15.18-alpine",          // what the plan wants
		"semiont clean --store database") // the way out
	if _, err := os.Stat(filepath.Join(pg, "PG_VERSION")); err != nil {
		t.Error("a refusal must not touch the data dir")
	}
}

// SHARED-STORE-CLEAR-PREFLIGHT P1: the state store is SHARED — the gateway
// and librarian attach what the archivist stamps — so its mismatch-clear
// must resolve before the boot's first service container runs. A clear at
// the stamp owner's own prep delete-and-recreates a directory earlier
// services have already attached, orphaning their virtiofs shares (measured
// 2026-09-07: ls total 0, every write ENOENT, 14 e2e failures).
func TestSharedStoreClearResolvesBeforeFirstRun(t *testing.T) {
	s := newScenario(t, "container")
	dir := stateRootFor(s.home, testKBKey)
	sentinel := filepath.Join(dir, "state", "stale-view")
	if err := os.MkdirAll(filepath.Dir(sentinel), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sentinel, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := `{"kbRoot":"` + inJSON(s.kb) + `","stores":{"state":{"image":"ghcr.io/the-ai-alliance/semiont-archivist:0.0.0-old"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	statLog := filepath.Join(s.fakertDir, "stat.log")
	s.extraEnv = append(s.extraEnv, "FAKERT_STAT_PATH="+sentinel, "FAKERT_STAT_LOG="+statLog)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("start with a state-store mismatch must boot: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	b, err := os.ReadFile(statLog)
	if err != nil {
		t.Fatalf("stat log (did no service container run?): %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	// "present" at the first service run means the clear had not resolved
	// yet — it will delete-and-recreate a mount another container already
	// attached. "absent" throughout also proves the clear happened at all.
	for i, l := range lines {
		if l != "absent" {
			t.Fatalf("state-store sentinel still %s at service run %d of %d — the mismatch-clear resolved mid-boot, after a sharer attached", l, i+1, len(lines))
		}
	}
}

// SHARED-STORE-CLEAR-PREFLIGHT P2: a clear removes a store's CONTENTS and
// keeps the mount-root directory itself. Delete-and-recreate orphans every
// share attached to the old directory (Apple container virtiofs, measured
// 2026-09-07); a contents-clear is invisible to attached shares. The test
// holds the directory open across the boot — exactly what an attached share
// does — and checks it was never unlinked: an open handle to a deleted
// directory has link count zero. (Inode-number comparison cannot pin this:
// an immediate recreate reuses the freed inode number.)
func TestStoreClearKeepsMountRootDir(t *testing.T) {
	s := newScenario(t, "container")
	dir := stateRootFor(s.home, testKBKey)
	sd := filepath.Join(dir, "state")
	if err := os.MkdirAll(sd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sd, "stale-view"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := `{"kbRoot":"` + inJSON(s.kb) + `","stores":{"state":{"image":"ghcr.io/the-ai-alliance/semiont-archivist:0.0.0-old"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	held, err := os.Open(sd)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("start with a state-store mismatch must boot: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(sd, "stale-view")); err == nil {
		t.Error("stale state-store contents survived the mismatch-clear")
	}
	fi, err := held.Stat()
	if err != nil {
		t.Fatalf("stat of the held state-store handle: %v", err)
	}
	if links, ok := linkCount(fi); ok && links == 0 {
		t.Error("the state store dir was unlinked by the clear — every share attached before it is orphaned; clear contents, keep the directory")
	}
}

func TestStateProjectionAutoCleans(t *testing.T) {
	s := newScenario(t, "container")
	// Graph/vectors are PROJECTIONS of the event log: data written by a
	// different image is auto-cleaned (announced), never a refusal — the
	// rebuild is the freshness guarantee. Contrast: the database refusal
	// in TestStateImageMismatchRefuses.
	dir := stateRootFor(s.home, testKBKey)
	stale := filepath.Join(dir, "neo4j", "data", "databases")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "stale.db"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := `{"kbRoot":"` + inJSON(s.kb) + `","stores":{"graph":{"image":"neo4j:5.20.0-community"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	// What that earlier stack also kept: the password its data was
	// initialized with (SECRET-DELIVERY P4).
	if err := os.WriteFile(filepath.Join(dir, "neo4j-password"), []byte("kept-by-an-earlier-start\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("projection mismatch must not refuse: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "auto-clean announcement", stdout, "neo4j:5.20.0-community", "clearing")
	if _, err := os.Stat(filepath.Join(stale, "stale.db")); err == nil {
		t.Error("stale projection data survived the auto-clean")
	}
	newMeta, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatalf("meta.json after start: %v", err)
	}
	mustContain(t, "meta.json restamp", string(newMeta), "neo4j:5.26.28-community")
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), storeClear(filepath.Join(dir, "neo4j")))
	// The neo4j mount dirs must exist again (and 0777 for the virtiofs
	// test -w gate its entrypoint runs).
	for _, sub := range []string{"data", "logs"} {
		fi, err := os.Stat(filepath.Join(dir, "neo4j", sub))
		if err != nil {
			t.Fatalf("neo4j %s dir after start: %v", sub, err)
		}
		if perm := fi.Mode().Perm(); perm != 0o777 {
			t.Errorf("neo4j %s dir mode = %o, want 777 (neo4j's entrypoint gates on test -w)", sub, perm)
		}
	}
	// ...while the root's state dir — the UNMOUNTED parent of every store —
	// is clamped owner-only, so the 0777 leaves nothing traversable by other
	// local users.
	if open := harness.OpenToOthers(t, dir); open != "" {
		t.Errorf("root state dir %s (owner-only parent clamp)", open)
	}
}

func TestStartRefusesAnEnvironmentSite(t *testing.T) {
	// A knowledge base declares its identity once: [site], at the top level of
	// its committed .semiont/config. An environment [site] used to replace that
	// table whole for every service loading the config — renaming the KB's
	// agents and people, or dropping the domain when it declared only a
	// siteName. Nothing overrides a KB's identity, so start refuses the section
	// by name, as every service's loader does.
	withSite := func(t *testing.T, s *scenario, site string) {
		t.Helper()
		writeKBConfig(t, s, "sited", stdGraph+stdVectors+stdEmbedding+stdDatabase+site)
	}

	for _, site := range []string{
		"[environments.local.site]\ndomain = \"elsewhere.example:other-kb\"\n",
		"[environments.local.site]\nsiteName = \"Example\"\n",
	} {
		s := newScenario(t, "container")
		withSite(t, s, site)
		_, stderr, code := s.run(t, "start", "--config", "sited", "--dry-run")
		if code != 1 {
			t.Fatalf("an environment [site] must refuse: exit %d\n%s", code, site)
		}
		mustContain(t, "environment [site] refusal", stderr, "[environments.local.site]", "sited.toml")
	}

	// No environment [site] at all — every launcher-generated config — starts.
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start", "--dry-run"); code != 0 {
		t.Fatalf("plain start: exit %d\nstderr:\n%s", code, stderr)
	}
}

func TestStartRefusesKBWithoutDid(t *testing.T) {
	// A did:web is REQUIRED (KB-IDENTITY-VS-ADDRESS decision 8, 2026-07-27).
	// The launcher publishes a discovery document in which `did` is a required
	// field, so a KB with no [site] domain cannot be represented — and the
	// alternative to refusing is worse than it looks: any default at all would
	// have every such KB on a machine report one fabricated, colliding
	// identity. An address wearing a name is the category error this
	// whole plan is about. Identity is declared, never defaulted.
	s := newScenario(t, "container")
	if err := os.WriteFile(filepath.Join(s.kb, ".semiont", "config"),
		[]byte("[project]\nname = \"No Did KB\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Refused even in --dry-run: a plan for a KB that cannot be identified is
	// not a plan worth printing.
	_, stderr, code := s.run(t, "start", "--dry-run")
	if code != 1 {
		t.Fatalf("did-less start: want exit 1, got %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr, "did:web", "[site]", "domain")

	// And the fix-it must be actionable: adding the domain makes it start.
	if err := os.WriteFile(filepath.Join(s.kb, ".semiont", "config"),
		[]byte("[project]\nname = \"No Did KB\"\n\n[site]\ndomain = \"example.github.io:no-did-kb\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("declared-domain start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "state key", s.norm(stdout), "roots/example.github.io-no-did-kb/postgres")
}

// --- clean ---

// seedStateDir fabricates a populated per-root state dir with all three
// stores and a fully-stamped meta.json.
func seedStateDir(t *testing.T, s *scenario) string {
	t.Helper()
	dir := stateRootFor(s.home, testKBKey)
	for sub, content := range map[string]string{
		"postgres/pgdata/PG_VERSION": "15\n",
		"qdrant/collections/spike":   strings.Repeat("q", 2048),
		"neo4j/data/databases/x":     strings.Repeat("n", 1024),
	} {
		p := filepath.Join(dir, sub)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	meta := `{"kbRoot":"` + inJSON(s.kb) + `","did":"did:web:example.github.io:test-kb","stores":{` +
		`"database":{"image":"postgres:15.18-alpine"},` +
		`"vectors":{"image":"qdrant/qdrant:v1.19.1"},` +
		`"graph":{"image":"neo4j:5.26.28-community"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// storeClear: the run that empties a store dir. A container wrote what is
// in it — as neo4j 7474, postgres 70, qdrant and nats root, Semiont 1001 —
// and on Linux only a container's root can remove it (CODESPACE-IDENTITY F1).
func storeClear(sd string) string {
	return "container run --rm -v " + sd + ":/store busybox:1.38.0 find /store -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
}

func TestCleanDryRunListsAndKeeps(t *testing.T) {
	s := newScenario(t)
	dir := seedStateDir(t, s)
	stdout, stderr, code := s.run(t, "clean", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "dry-run", stdout, "would remove", "dry-run")
	if _, err := os.Stat(filepath.Join(dir, "postgres", "pgdata", "PG_VERSION")); err != nil {
		t.Error("--dry-run removed data")
	}
	if log, _ := os.ReadFile(s.log); strings.Contains(string(log), "find /store") {
		t.Errorf("--dry-run ran a store clear:\n%s", log)
	}
}

func TestCleanRemovesRootState(t *testing.T) {
	s := newScenario(t, "container")
	dir := seedStateDir(t, s)
	stdout, stderr, code := s.run(t, "clean")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "clean", stdout, "Removed")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("state dir survived clean: %v", err)
	}
	// Every store is emptied by a container; the root dir itself — its
	// secrets and meta.json are the invoker's — is never mounted.
	log, _ := os.ReadFile(s.log)
	for _, sub := range []string{"postgres", "qdrant", "neo4j"} {
		mustContain(t, "argv log", string(log), storeClear(filepath.Join(dir, sub)))
	}
	if strings.Contains(string(log), "-v "+dir+":") {
		t.Errorf("the root dir, secrets and all, was mounted into a container:\n%s", log)
	}
}

func TestCleanStoreScopes(t *testing.T) {
	s := newScenario(t, "container")
	dir := seedStateDir(t, s)
	stdout, stderr, code := s.run(t, "clean", "--store", "vectors")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	// The success message names the STORE dir it removed, not the root —
	// a scoped clean must not claim it wiped everything.
	mustContain(t, "scoped message", stdout, filepath.Join(dir, "qdrant"))
	if strings.Contains(stdout, "Removed "+dir+" ") {
		t.Errorf("scoped clean claimed to remove the whole root:\n%s", stdout)
	}
	if _, err := os.Stat(filepath.Join(dir, "qdrant")); !os.IsNotExist(err) {
		t.Error("--store vectors left the qdrant dir")
	}
	for _, keep := range []string{"postgres", "neo4j"} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("--store vectors touched %s: %v", keep, err)
		}
	}
	meta, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatalf("meta.json after scoped clean: %v", err)
	}
	if strings.Contains(string(meta), `"vectors"`) {
		t.Error("vectors stamp survived its store's clean")
	}
	mustContain(t, "meta.json keeps other stamps", string(meta), `"database"`, `"graph"`)
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), storeClear(filepath.Join(dir, "qdrant")))
	if strings.Count(string(log), "find /store") != 1 {
		t.Errorf("a scoped clean emptied more than its one store:\n%s", log)
	}
}

func TestCleanRefusesRunningStack(t *testing.T) {
	s := newScenario(t)
	seedStateDir(t, s)
	// A recorded local stack on this root: clean must refuse — those dirs
	// may be mounted right now.
	stack := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"` + inJSON(s.kb) +
		`","kbDid":"did:web:example.github.io:test-kb","services":{}}}}`
	if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePathFor(s.home), []byte(stack), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "clean")
	if code == 0 {
		t.Fatalf("clean under a recorded stack must refuse\nstdout:\n%s", stdout)
	}
	mustContain(t, "refusal", stdout+stderr, "semiont stop")
	if _, err := os.Stat(stateRootFor(s.home, testKBKey)); err != nil {
		t.Error("refusal must not remove anything")
	}
}

func TestCleanOrphanKeyTarget(t *testing.T) {
	s := newScenario(t, "container")
	// State whose KB no longer exists anywhere: targetable by its literal
	// key, exactly as status names it.
	orphan := stateRootFor(s.home, "gone.example.org-old-kb")
	if err := os.MkdirAll(filepath.Join(orphan, "qdrant"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "qdrant", "f"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "clean", "--root", "gone.example.org-old-kb")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Error("orphan state survived clean --root <key>")
	}
}

func TestStartServiceDatabaseMountsState(t *testing.T) {
	s := newScenario(t, "container")
	// --service must apply the SAME persistence rules as a full start: a
	// database restarted alone that silently skipped its mount would write
	// rows into a container that dies with it.
	_, stderr, code := s.run(t, "start", "--service", "database")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	mount := filepath.Join(stateRootFor(s.home, testKBKey), "postgres") + ":/var/lib/postgresql/data"
	mustContain(t, "service-mode state mount", string(s.mustLog(t)), mount)
}

func TestCleanRejectsTraversalKey(t *testing.T) {
	s := newScenario(t)
	dir := seedStateDir(t, s)
	// A --root value that is not a plain key must never reach RemoveAll:
	// "roots/.." is the data dir itself.
	stdout, _, code := s.run(t, "clean", "--root", "..")
	if code == 0 {
		t.Fatalf("traversal --root value accepted\nstdout:\n%s", stdout)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("traversal --root removed state outside roots/: %v", err)
	}
}

func TestCleanNothingToRemove(t *testing.T) {
	s := newScenario(t)
	stdout, stderr, code := s.run(t, "clean")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "no-op clean", stdout, "Nothing to remove")
}

func TestStatusVerboseDiskUsage(t *testing.T) {
	s := newScenario(t, "container")
	seedStateDir(t, s) // postgres 3 B, qdrant 2048 B, neo4j 1024 B
	// A second, ORPHANED root: stamped kbRoot no longer exists.
	orphan := stateRootFor(s.home, "gone.example.org-old-kb")
	if err := os.MkdirAll(filepath.Join(orphan, "qdrant"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "qdrant", "f"), []byte("xxxx"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "meta.json"),
		[]byte(`{"kbRoot":"/nowhere/does/not/exist","stores":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "status", "--verbose")
	_ = code // status exit reflects health; the paths section prints regardless
	_ = stderr
	mustContain(t, "active-root data row", stdout,
		filepath.Join("roots", testKBKey),
		"postgres 3 B", "qdrant 2.0 KB", "neo4j 1.0 KB")
	mustContain(t, "all-roots row", stdout,
		"2 roots", "1 orphaned", "semiont clean --root gone.example.org-old-kb")
}

func TestStatusVerboseNoState(t *testing.T) {
	s := newScenario(t, "container")
	stdout, _, _ := s.run(t, "status", "--verbose")
	// No state anywhere: the data row says so honestly — absent, not a
	// zero-byte fiction.
	mustContain(t, "data row absent", stdout, "data")
	if strings.Contains(stdout, "0 B:") {
		t.Errorf("absent state must read as absent, not zero bytes:\n%s", stdout)
	}
	mustContain(t, "no roots", stdout, "no persistent state")
}

// --- login (sdk-go glue) ---

// tokensPathFor mirrors the launcher's token store path for the scenario's
// fake HOME — GOOS-aware like statePathFor.
func tokensPathFor(home string) string {
	return filepath.Join(stateHomeFor(home), "tokens.json")
}

// EXTERNAL-IDENTITY P4 (launcher lane): `semiont login` is the device
// authorization grant (RFC 8628). The launcher learns the issuer from the
// knowledge base's resource metadata, asks it for a code as the launcher's
// own public client, and stores the tokens the issuer returns — no --email,
// no stdin, no password anywhere in this process.
func TestLoginDeviceGrantStoresTokens(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, stderr, code := s.run(t, "login")
	if code != 0 {
		t.Fatalf("login: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "output", stdout+stderr, "realms/semiont", "FAKE-CODE")
	mustContain(t, "stdout", stdout, "Logged in", "admin@example.com")
	if strings.Contains(stdout+stderr, "Password") {
		t.Errorf("login asked for a password:\n%s\n%s", stdout, stderr)
	}
	// The grant went to the issuer as the launcher's own public client,
	// asking for a refresh token that outlives the browser session.
	da, err := os.ReadFile(filepath.Join(s.fakertDir, "device-auth.txt"))
	if err != nil {
		t.Fatalf("device authorization request not recorded: %v", err)
	}
	mustContain(t, "device authorization", string(da), "client_id=semiont-cli", "offline_access")
	b, err := os.ReadFile(tokensPathFor(s.home))
	if err != nil {
		t.Fatalf("tokens.json after login: %v", err)
	}
	mustContain(t, "tokens.json", string(b), "fake-jwt-token", "fake-refresh-token", `"local"`,
		`"issuer"`, "http://localhost:4000/realms/semiont", `"tokenEndpoint"`)
	if open := harness.OpenToOthers(t, tokensPathFor(s.home)); open != "" {
		t.Errorf("tokens.json %s (it holds a bearer token)", open)
	}
}

func TestLoginDeniedAtIssuer(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_DEVICE_DENY=1")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	_, stderr, code := s.run(t, "login")
	if code == 0 {
		t.Fatal("login must fail when the user denies the sign-in at the issuer")
	}
	mustContain(t, "denial", stderr, "denied")
	if _, err := os.Stat(tokensPathFor(s.home)); err == nil {
		t.Error("a denied login stored a token")
	}
}

func TestVerbStackContradictionRefuses(t *testing.T) {
	// --repo + --runtime is contradictory for EVERY knowledge verb; the
	// check lives in the shared ladder so no verb can silently resolve the
	// pair to the local stack (Copilot caught login/yield doing exactly
	// that after the useradd extraction).
	s := newScenario(t, "container")
	for _, verb := range []string{"useradd", "login", "yield"} {
		args := []string{verb, "--repo", "a/b", "--runtime", "container"}
		switch verb {
		case "useradd":
			args = append(args, "--email", "x@y.example")
		case "yield":
			args = append(args, "--upload", "docs/note.md")
		}
		_, stderr, code := s.run(t, args...)
		if code == 0 {
			t.Errorf("%s accepted --repo with --runtime", verb)
		}
		mustContain(t, verb+" contradiction", stderr, "contradictory")
	}
}

func TestLoginWithoutStackRefuses(t *testing.T) {
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "login")
	if code == 0 {
		t.Fatal("login with no running stack must refuse")
	}
	mustContain(t, "fix-it", stderr, "semiont start")
}

// --- yield (sdk-go glue) ---

// yieldScenario boots the fake stack, logs in, and seeds docs/note.md.
// extraEnv lands BEFORE start: the fake gateway serve keeps its birth env,
// so per-run env set after start never reaches it (learned RED-first).
func yieldScenario(t *testing.T, login bool, extraEnv ...string) *scenario {
	t.Helper()
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, extraEnv...)
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if login {
		if _, stderr, code := s.run(t, "login"); code != 0 {
			t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
		}
	}
	if err := os.MkdirAll(filepath.Join(s.kb, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.kb, "docs", "note.md"), []byte("# hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestYieldUploadsFile(t *testing.T) {
	s := yieldScenario(t, true)
	stdout, stderr, code := s.run(t, "yield", "--upload", "docs/note.md")
	if code != 0 {
		t.Fatalf("yield: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Yielded", "docs/note.md", "fake-resource-id")
	// What the gateway actually received — the multipart per the spec's
	// schema, the bearer token, the bytes.
	b, err := os.ReadFile(filepath.Join(s.fakertDir, "yield-upload.json"))
	if err != nil {
		t.Fatalf("upload capture: %v", err)
	}
	mustContain(t, "multipart", string(b),
		`"name":"note"`,
		`"format":"text/markdown"`,
		`"storageUri":"file://docs/note.md"`,
		`"authorization":"Bearer fake-jwt-token"`,
		`"filecontent":"# hi\n"`)
}

// The format an upload states comes from the media-type registry
// (specs/src/media-types/registry.json), through the Go SDK: every extension
// a row states, the registry's aliases, and its rule that a shared extension
// is the first row's. An extension no row states uploads as octet-stream; the
// gateway's create route stays the validator of record.
func TestYieldNamesTheFormatFromTheRegistry(t *testing.T) {
	s := yieldScenario(t, true)
	for _, c := range []struct{ file, format string }{
		{"docs/styles.css", "text/css"},                // a row the hand-written table never had
		{"docs/config.YML", "application/yaml"},        // an alias, in upper case
		{"docs/clip.webm", "video/webm"},               // shared with audio/webm: the first row's
		{"docs/thing.xyz", "application/octet-stream"}, // no row states it
	} {
		if err := os.WriteFile(filepath.Join(s.kb, c.file), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if stdout, stderr, code := s.run(t, "yield", "--upload", c.file); code != 0 {
			t.Fatalf("yield %s: exit %d\nstdout:\n%s\nstderr:\n%s", c.file, code, stdout, stderr)
		}
		b, err := os.ReadFile(filepath.Join(s.fakertDir, "yield-upload.json"))
		if err != nil {
			t.Fatalf("upload capture: %v", err)
		}
		mustContain(t, c.file, string(b), `"format":"`+c.format+`"`)
	}
}

func TestYieldOutsideRootRefuses(t *testing.T) {
	s := yieldScenario(t, true)
	outside := filepath.Join(t.TempDir(), "stray.md")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "yield", "--upload", outside)
	if code == 0 {
		t.Fatalf("upload outside the KB root must refuse\nstdout:\n%s", stdout)
	}
	mustContain(t, "refusal", stdout+stderr, "KB root", "Copy it")
	if _, err := os.ReadFile(filepath.Join(s.fakertDir, "yield-upload.json")); err == nil {
		t.Error("refused upload still reached the gateway")
	}
}

func TestYieldWithoutSessionAdvisesLogin(t *testing.T) {
	s := yieldScenario(t, false)
	stdout, stderr, code := s.run(t, "yield", "--upload", "docs/note.md")
	if code == 0 {
		t.Fatalf("yield without a session must refuse\nstdout:\n%s", stdout)
	}
	mustContain(t, "fix-it", stdout+stderr, "semiont login")
}

func TestYieldAutoRefreshesExpiredToken(t *testing.T) {
	// The login-issued access token has expired (they live an hour); the
	// stored refresh token must renew it INVISIBLY — login is a
	// once-a-month event, not an hourly chore. (Login itself never sends a
	// bearer, so the from-birth stale flag doesn't break the setup.)
	s := yieldScenario(t, true, "FAKERT_STALE_TOKEN=1")
	stdout, stderr, code := s.run(t, "yield", "--upload", "docs/note.md")
	if code != 0 {
		t.Fatalf("yield with refreshable token: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Yielded", "fake-resource-id")
	// The upload went out under the REFRESHED token…
	b, err := os.ReadFile(filepath.Join(s.fakertDir, "yield-upload.json"))
	if err != nil {
		t.Fatalf("upload capture: %v", err)
	}
	mustContain(t, "multipart", string(b), `"authorization":"Bearer fake-jwt-token-2"`)
	// …and the rotation was SAVED: next command starts from the new token,
	// keeping the original refresh token (the server does not rotate it).
	tb, err := os.ReadFile(tokensPathFor(s.home))
	if err != nil {
		t.Fatalf("tokens.json: %v", err)
	}
	mustContain(t, "tokens.json", string(tb), "fake-jwt-token-2", "fake-refresh-token")
}

func TestYieldPostRefreshRejectionSaysSo(t *testing.T) {
	// Refresh SUCCEEDS but the renewed token is also rejected (account
	// disabled, tokens revoked server-side): the failure must not claim
	// "the refresh token could not renew it" — it did. Distinct message.
	s := yieldScenario(t, true, "FAKERT_ALL_TOKENS_STALE=1")
	stdout, stderr, code := s.run(t, "yield", "--upload", "docs/note.md")
	if code == 0 {
		t.Fatalf("yield must fail when every token is rejected\nstdout:\n%s", stdout)
	}
	mustContain(t, "post-refresh rejection", stdout+stderr, "after a successful refresh", "semiont login")
	if strings.Contains(stdout+stderr, "could not renew") {
		t.Errorf("claimed the refresh failed when it succeeded:\n%s\n%s", stdout, stderr)
	}
}

func TestLogoutForgetsSession(t *testing.T) {
	s := yieldScenario(t, true)
	stdout, stderr, code := s.run(t, "logout")
	if code != 0 {
		t.Fatalf("logout: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Logged out", "local", "revoked at the issuer")
	if tb, err := os.ReadFile(tokensPathFor(s.home)); err == nil {
		if strings.Contains(string(tb), "fake-jwt-token") {
			t.Errorf("token survived logout:\n%s", tb)
		}
	}
	// The refresh token was revoked at the issuer (RFC 7009), as the
	// launcher's own client — not merely forgotten locally.
	rv, err := os.ReadFile(filepath.Join(s.fakertDir, "revoked.txt"))
	if err != nil {
		t.Fatalf("no revocation reached the issuer: %v", err)
	}
	mustContain(t, "revocation", string(rv), "token=fake-refresh-token", "client_id=semiont-cli")
	// A second logout is a benign no-op, said plainly.
	stdout, _, code = s.run(t, "logout")
	if code != 0 {
		t.Fatalf("repeat logout should no-op, got exit %d", code)
	}
	mustContain(t, "stdout", stdout, "No session")
}

func TestStatusVerboseShowsSessions(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	// Before any login: the section says so, without inventing a session.
	stdout, _, _ := s.run(t, "status", "--verbose")
	mustContain(t, "no sessions yet", stdout, "SESSIONS", "none — semiont login")
	if _, stderr, code := s.run(t, "login"); code != 0 {
		t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, _, _ = s.run(t, "status", "--verbose")
	mustContain(t, "session row", stdout, "SESSIONS", "local", "admin@example.com", "valid")
}

// --- stop ---

func TestStopSweepsAllRuntimes(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	// Simulate leftover staging from a previous run.
	stage, err := os.MkdirTemp(s.stagingParent(), "semiont-config.")
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "stop-all-runtimes.argv", s.argv(t))
	mustContain(t, "stdout", stdout,
		"Sweeping 16 container(s) across container, docker, podman",
		"container: none found",
		"docker: none found",
		"podman: none found",
		"staged config dir(s)",
		"Semiont stack stopped.")
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Errorf("staged config dir %s not removed", stage)
	}
}

func TestStopSingleRuntime(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	_, stderr, code := s.run(t, "stop", "--runtime", "docker")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "stop-docker-only.argv", s.argv(t))
}

func TestStopNoRuntime(t *testing.T) {
	s := newScenario(t)
	_, stderr, code := s.run(t, "stop")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "No container runtime found. Install Apple Container, Docker, or Podman.")
}

func TestStopDryRun(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	stdout, stderr, code := s.run(t, "stop", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "stop-dryrun.txt", s.norm(stdout))
	if got := s.argv(t); got != "" {
		t.Errorf("dry run executed external commands:\n%s", got)
	}
}

// --- status ---

// serveHealth binds 200-answering listeners on the given fixed ports (also
// satisfies raw TCP dials), closed on test cleanup.
func serveHealth(t *testing.T, ports ...int) {
	t.Helper()
	for _, p := range ports {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			t.Fatalf("port %d unavailable for health simulation: %v", p, err)
		}
		srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintln(w, "ok")
		})}
		go srv.Serve(ln)
		t.Cleanup(func() { srv.Close() })
	}
}

func TestStatusMixed(t *testing.T) {
	// docker-only runtime; gateway running+healthy, worker running but
	// unhealthy, smelter exited, everything else absent — except a host
	// Ollama answering with no container, which must report runtime "host".
	s := newScenario(t, "docker")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_gateway=running",
		"FAKERT_STATE_worker=running",
		"FAKERT_STATE_smelter=exited",
	)
	serveHealth(t, 4000, 11434)
	// The default report covers every stack, so its exit says only that
	// status ran; --root/--service are the health-coded forms.
	stdout, stderr, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("default status should exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if _, _, code := s.run(t, "status", "--service", "worker"); code != 1 {
		t.Errorf("--service names one stack, so it must exit on health; got %d", code)
	}
	mustContain(t, "stdout", stdout,
		"SERVICE", "RUNTIME", "STATUS",
		"LOCAL STACK",
		"KNOWLEDGE BASES",
		"semiont roots",
		// The merged STATUS cell: mark + word, probe dimmed after. The
		// diagnostic matrix each word pins: running-and-healthy, running-
		// but-unhealthy, crashed, absent, host-provided.
		"✓ running", "✗ running", "✗ exited", "✗ absent", "✓ reachable",
		"http://localhost:4000/api/health",
		"http://localhost:24100/health",
		"tcp://localhost:5432",
	)
	// No stack is recorded here, so the rows are discovered BY NAME and no
	// config has selected a driver. The report says so by naming no product:
	// "database (PostgreSQL)" would be a guess that is only right while the
	// database role has one driver, and guessing it is exactly what the
	// descriptor set removed (LAUNCHER-SERVICE-MODEL P1). A recorded stack
	// still names its products — every record carries its driver.
	mustNotContain(t, "stdout", stdout, "PostgreSQL", "Neo4j", "Qdrant", "Jaeger")
	// LAUNCHER PATHS describes the launcher, not any KB — asked for, not shown.
	if strings.Contains(stdout, "LAUNCHER PATHS") {
		t.Errorf("default status printed LAUNCHER PATHS without --verbose:\n%s", stdout)
	}
	vstdout, _, vcode := s.run(t, "status", "--verbose")
	if vcode != 0 {
		t.Fatalf("status --verbose: exit %d", vcode)
	}
	mustContain(t, "verbose stdout", vstdout,
		"LAUNCHER PATHS", "config", "cache", "staging", s.stagingPattern())

	for _, line := range strings.Split(stdout, "\n") {
		if !strings.Contains(line, "localhost") {
			continue // service-table rows only, not the host-dirs block
		}
		switch {
		case strings.Contains(line, "gateway"):
			mustContain(t, "gateway row", line, "running", "docker", "✓")
		case strings.Contains(line, "worker"):
			mustContain(t, "worker row", line, "running", "✗")
		case strings.Contains(line, "inference"):
			mustContain(t, "inference row", line, "host", "✓")
		case strings.Contains(line, "weaver"):
			mustContain(t, "weaver row", line, "—", "✗")
		}
	}
}

func TestStatusAllHealthy(t *testing.T) {
	// Full stack running and healthy (Apple container JSON inspect path);
	// Jaeger absent is fine — observability is optional, exit stays 0.
	s := newScenario(t, "container")
	for _, svc := range []string{"gateway", "worker", "smelter", "weaver", "browser", "neo4j", "qdrant", "postgres", "ollama"} {
		s.extraEnv = append(s.extraEnv, "FAKERT_STATE_"+svc+"=running")
	}
	serveHealth(t, 4000, 24100, 24101, 24102, 24103, 24104, 3000, 7474, 6333, 5432, 11434)
	stdout, stderr, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("want exit 0 with all core healthy, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "traces")
	for _, line := range strings.Split(stdout, "\n") {
		if strings.Contains(line, "gateway") && strings.Contains(line, "✗") {
			t.Errorf("gateway reported unhealthy:\n%s", stdout)
		}
	}
}

func TestStatusNoRuntime(t *testing.T) {
	s := newScenario(t)
	_, stderr, code := s.run(t, "status")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "No container runtime found. Install Apple Container, Docker, or Podman.")
}

// --- invocation log ---

// invLogPath mirrors the launcher's logDir for the scenario's fake HOME.
func invLogPath(home string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Logs", "semiont", "launcher.log")
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(stateHomeFor(home), "logs", "launcher.log")
	}
	return filepath.Join(stateHomeFor(home), "launcher.log")
}

func TestInvocationLog(t *testing.T) {
	s := newScenario(t)
	if _, _, code := s.run(t, "version"); code != 0 {
		t.Fatalf("version: exit %d", code)
	}
	// --password is refused now, but a user who types it has still put the
	// secret in the launcher's OWN argv — and the invocation log is a file
	// that outlives the command, so the value must never be written there.
	if _, _, code := s.run(t, "useradd", "--email", "a@b.co", "--password", "supersecretpw"); code != 1 {
		t.Fatalf("rejection run: want exit 1, got %d", code)
	}
	b, err := os.ReadFile(invLogPath(s.home))
	if err != nil {
		t.Fatalf("invocation log not written: %v", err)
	}
	log := string(b)
	mustContain(t, "invocation log", log,
		"invoke semiont version (version dev",
		"exit 0 semiont version",
		"invoke semiont useradd --email a@b.co --password <redacted>",
		"exit 1 semiont useradd",
	)
	if strings.Contains(log, "supersecretpw") {
		t.Error("password leaked into the invocation log")
	}
}

// --- useradd ---

func TestUseradd(t *testing.T) {
	// useradd is a thin exec bridge: launcher finds the stack's runtime and
	// gateway handle, execs the in-container CLI's useradd, and passes every
	// flag through verbatim. The PASSWORD is the one thing that never rides in
	// argv — it goes down the exec's stdin, because argv is visible in `ps`
	// (host and container) and in the caller's shell history.
	s := newScenario(t, "container", "docker")
	const secret = "password123"

	// The LOCAL path administers the realm from here — no container, and the
	// gateway need not be running (WHO-RUNS-USERADD P3). With no stack
	// recorded there is no realm to reach, and the refusal says so.
	s.stdin = secret + "\n"
	_, stderr, code := s.run(t, "useradd", "--email", "a@b.co")
	if code != 1 {
		t.Fatalf("no-stack useradd: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "semiont start")
	if strings.Contains(stderr, "gateway") {
		t.Errorf("the refusal still blames the gateway, which this path no longer uses:\n%s", stderr)
	}

	// Whatever it does, it never runs a container for a local stack.
	log, _ := os.ReadFile(s.log)
	if strings.Contains(string(log), "semiont-useradd") {
		t.Errorf("the local path still reaches for the gateway's bin:\n%s", log)
	}
	// And the password never appears anywhere it could be read back.
	if strings.Contains(string(log), secret) || strings.Contains(stderr, secret) {
		t.Error("the password leaked into the argv log or stderr")
	}

	// Flag refusals the launcher owns. They fire before any realm is reached,
	// so they need no stack at all.
	//
	// The removed --password flag is refused with the way that replaced it —
	// it is documented in enough places that a bare "unknown flag" would read
	// as a launcher bug.
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--password", secret); code != 1 {
		t.Errorf("--password should be refused, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "--password", "no longer accepted", "--generate-password")
	}

	// Contradictory account flags are refused here rather than at the far end:
	// on the codespace path the far end is an ssh hop away.
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--update", "--upsert"); code != 1 {
		t.Errorf("--update --upsert should be refused, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "contradictory")
	}
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--active", "--inactive"); code != 1 {
		t.Errorf("--active --inactive should be refused, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "contradictory")
	}
	if _, stderr, code := s.run(t, "useradd", "--email", "not-an-email"); code != 1 {
		t.Errorf("a malformed email should be refused, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "invalid email")
	}
	// An unknown flag is refused rather than ignored. The far end used to
	// refuse it; this IS the far end for a local stack now, and `--admin` is
	// still advertised in places — it must fail, not appear to work.
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--admin"); code != 1 {
		t.Errorf("an unknown flag should be refused, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "Unknown flag", "--admin")
	}

	// Asking for both a supplied and a generated password is refused HERE. The
	// launcher strips --password-stdin and re-adds it only when it actually
	// read one, so forwarding alone would hand the gateway just
	// --generate-password — its own mutual-exclusion check would never fire and
	// the user would silently get a password they did not ask to keep.
	if _, stderr, code := s.run(t, "useradd", "--email", "b@c.co",
		"--generate-password", "--password-stdin"); code != 1 {
		t.Errorf("contradictory password flags should be refused, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "contradictory")
	}

	// A create with nothing on stdin cannot proceed — say so rather than
	// hanging or sending an empty password. This fires before any realm is
	// reached, which is the point: nobody should be asked for a secret by an
	// invocation that was already going to be refused. So a local stack is
	// recorded here: without one, "no local stack is running" is the refusal
	// that comes first.
	if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePathFor(s.home), []byte(`{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"`+inJSON(s.kb)+`","services":{}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s.stdin = ""
	if _, stderr, code := s.run(t, "useradd", "--email", "d@e.co"); code != 1 {
		t.Errorf("empty stdin should fail, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "password")
	}
	// Bare useradd prints usage and fails; --help succeeds.
	if _, _, code := s.run(t, "useradd"); code != 1 {
		t.Error("bare useradd should exit 1")
	}
	stdout, _, code := s.run(t, "useradd", "--help")
	if code != 0 {
		t.Error("useradd --help should exit 0")
	}
	mustContain(t, "help", stdout, "--generate-password", "--inactive", "--upsert")
	if strings.Contains(stdout, "--password <") {
		t.Error("help still advertises the removed --password flag")
	}
	// No route grants access on the basis of a role, so there is nothing for a
	// role flag to grant; advertising one would send people to a refusal.
	for _, gone := range []string{"--admin", "--moderator"} {
		if strings.Contains(stdout, gone) {
			t.Errorf("help advertises %s, which grants nothing", gone)
		}
	}
}

// --- secret sources ---

func TestSecretCommand(t *testing.T) {
	// `semiont secret` stores POINTERS (provider + path) in roots.json —
	// never a value. set verifies with one read (discarded); list shows
	// pointers; rm forgets.
	s := newScenario(t, "container", "op")

	stdout, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential")
	if code != 0 {
		t.Fatalf("secret set: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "set stdout", stdout,
		"Verifying: op read op://OSS/Anthropic/credential",
		"expect an authorization prompt",
		"pointer stored, never the value")
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "op read op://OSS/Anthropic/credential")
	b, _ := os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json", string(b), `"provider": "op"`, `"path": "OSS/Anthropic/credential"`)
	if strings.Contains(string(b), "fake-op-secret") {
		t.Fatalf("secret VALUE persisted to roots.json:\n%s", b)
	}
	if strings.Contains(stdout, "fake-op-secret") {
		t.Errorf("secret value printed by set:\n%s", stdout)
	}

	stdout, _, code = s.run(t, "settings", "secret")
	if code != 0 {
		t.Fatalf("secret list: exit %d", code)
	}
	mustContain(t, "list stdout", stdout,
		"ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential", "the environment wins")

	// Unknown scheme rejected; verification failure stores nothing.
	if _, stderr, code := s.run(t, "settings", "secret", "set", "X", "vault://a/b"); code != 1 {
		t.Error("unknown scheme should fail")
	} else {
		mustContain(t, "stderr", stderr, "Unknown secret provider 'vault'")
	}
	s.extraEnv = append(s.extraEnv, "FAKERT_OP_FAIL=1")
	if _, stderr, code := s.run(t, "settings", "secret", "set", "OTHER_KEY", "op://a/b/c"); code != 1 {
		t.Error("failed verification should fail set")
	} else {
		mustContain(t, "stderr", stderr, "Verification failed")
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	if strings.Contains(string(b), "a/b/c") {
		t.Errorf("failed verification still stored the source:\n%s", b)
	}

	// rm forgets; a second rm is an honest error.
	if _, _, code := s.run(t, "settings", "secret", "rm", "ANTHROPIC_API_KEY"); code != 0 {
		t.Fatal("secret rm failed")
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	if strings.Contains(string(b), "Anthropic/credential") {
		t.Errorf("rm left the source behind:\n%s", b)
	}
	if _, _, code := s.run(t, "settings", "secret", "rm", "ANTHROPIC_API_KEY"); code != 1 {
		t.Error("rm of an absent source should fail")
	}
}

// `secret` moved under `settings` (LAUNCHER-SETTINGS D2): the old verb is gone,
// not kept as an alias.
func TestSecretIsNoLongerAVerb(t *testing.T) {
	s := newScenario(t, "container", "op")
	_, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential")
	if code == 0 {
		t.Fatal("semiont secret still runs")
	}
	mustContain(t, "stderr", stderr, "Unknown command: secret")
}

func TestSecretSetInteractive(t *testing.T) {
	// `secret set <VAR>` with no source URI walks the provider registry
	// interactively: pick a provider (the lone installed one is the
	// default), then the path in the provider's own shape.
	s := newScenario(t, "container", "op")

	// Empty provider input takes the default; a pasted full URI as the
	// path is tolerated.
	s.stdin = "\nop://OSS/Anthropic/credential\n"
	stdout, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY")
	if code != 0 {
		t.Fatalf("interactive set: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"Registering a secret source for ANTHROPIC_API_KEY",
		"op — 1Password",
		"Provider [op]:",
		"Path (<vault>/<item>/<field>):",
		"pointer stored, never the value")
	b, _ := os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json", string(b), `"path": "OSS/Anthropic/credential"`)
	if strings.Contains(string(b), "fake-op-secret") {
		t.Fatalf("secret VALUE persisted:\n%s", b)
	}

	// An unknown provider name is a clean failure.
	s.stdin = "vault\n"
	if _, stderr, code := s.run(t, "settings", "secret", "set", "X"); code != 1 {
		t.Error("unknown interactive provider should fail")
	} else {
		mustContain(t, "stderr", stderr, "Unknown secret provider 'vault'")
	}

	// An empty path is a clean failure.
	s.stdin = "op\n\n"
	if _, stderr, code := s.run(t, "settings", "secret", "set", "X"); code != 1 {
		t.Error("empty path should fail")
	} else {
		mustContain(t, "stderr", stderr, "A path is required.")
	}
}

func TestSecretSetInteractiveWithoutProvider(t *testing.T) {
	// No provider CLI installed: the picker says so per provider, and
	// choosing one fails the early PATH test with the escape hatch.
	s := newScenario(t, "container") // no "op" shim
	s.stdin = "op\n"
	stdout, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stdout", stdout, "op — 1Password", "('op' not on PATH)")
	mustContain(t, "stderr", stderr,
		"'op' (1Password CLI) is not on PATH",
		"the environment always wins")
}

func TestSecretSetRequiresProviderOnPath(t *testing.T) {
	// The clear, early PATH test: no op binary, no set — with the escape
	// hatch spelled out.
	s := newScenario(t, "container") // deliberately no "op" shim
	_, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/x/y")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"'op' (1Password CLI) is not on PATH",
		"the environment always wins")
}

func TestSecretPush(t *testing.T) {
	// A codespace runs on GitHub's machine and can't reach the local
	// provider, so `secret push` copies the CURRENT value into GitHub's
	// Codespaces user secrets — resolved fresh, handed over on STDIN (never
	// argv), and unioned into the existing repo selection.
	s := newScenario(t, "container", "op", "gh")
	if _, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\nstderr:\n%s", code, stderr)
	}

	// Existing selection must survive: gh's --repos REPLACES the list.
	s.extraEnv = append(s.extraEnv,
		`FAKERT_GH_SECRET_REPOS={"total_count":1,"repositories":[{"full_name":"other/already-had-it"}]}`)
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "settings", "secret", "push", "ANTHROPIC_API_KEY", "--repo", "pingel-org/foo-kb")
	if code != 0 {
		t.Fatalf("push: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "push stdout", stdout,
		"reading from 1Password", "expect an authorization prompt",
		"is now a Codespaces user secret",
		"other/already-had-it, pingel-org/foo-kb", // union, not replacement
		"never stored locally")

	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"gh secret set ANTHROPIC_API_KEY --user --app codespaces --repos other/already-had-it,pingel-org/foo-kb")
	// The value must NEVER appear in argv (ps-readable) — only on stdin.
	if strings.Contains(string(log), "fake-op-secret") {
		t.Fatalf("secret value leaked into argv:\n%s", log)
	}
	if strings.Contains(stdout, "fake-op-secret") {
		t.Errorf("secret value echoed to the terminal:\n%s", stdout)
	}
	stdin, err := os.ReadFile(filepath.Join(s.fakertDir, "secret-set-stdin"))
	if err != nil || strings.TrimSpace(string(stdin)) != "fake-op-secret" {
		t.Fatalf("value did not reach gh on stdin: %q (%v)", stdin, err)
	}
	// Nor into roots.json or the invocation log.
	if b, _ := os.ReadFile(rootsPathFor(s.home)); strings.Contains(string(b), "fake-op-secret") {
		t.Error("secret value persisted to roots.json")
	}
	if b, _ := os.ReadFile(invLogPath(s.home)); strings.Contains(string(b), "fake-op-secret") {
		t.Error("secret value reached the invocation log")
	}

	// Already-selected repo isn't duplicated.
	s2 := newScenario(t, "container", "op", "gh")
	if _, _, code := s2.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatal("set failed")
	}
	s2.extraEnv = append(s2.extraEnv,
		`FAKERT_GH_SECRET_REPOS={"total_count":1,"repositories":[{"full_name":"pingel-org/foo-kb"}]}`)
	if err := os.Truncate(s2.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, code := s2.run(t, "settings", "secret", "push", "ANTHROPIC_API_KEY", "--repo", "pingel-org/foo-kb"); code != 0 {
		t.Fatal("push failed")
	}
	log, _ = os.ReadFile(s2.log)
	mustContain(t, "argv log", string(log), "--repos pingel-org/foo-kb")
	if strings.Contains(string(log), "foo-kb,pingel-org/foo-kb") {
		t.Errorf("repo duplicated in the selection:\n%s", log)
	}

	// Failure paths: no registered source, bad slug, gh rejecting the write.
	s3 := newScenario(t, "container", "op", "gh")
	if _, stderr, code := s3.run(t, "settings", "secret", "push", "NOPE_KEY", "--repo", "a/b"); code != 1 {
		t.Error("push without a source should fail")
	} else {
		mustContain(t, "stderr", stderr, "No secret source registered for NOPE_KEY",
			"semiont settings secret set NOPE_KEY")
	}
	if _, stderr, code := s3.run(t, "settings", "secret", "push", "ANTHROPIC_API_KEY", "--repo", "notaslug"); code != 1 {
		t.Error("bad slug should fail")
	} else {
		mustContain(t, "stderr", stderr, "--repo must be owner/name")
	}
	if _, _, code := s3.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatal("set failed")
	}
	s3.extraEnv = append(s3.extraEnv, "FAKERT_GH_SECRET_SET_FAIL=1")
	if _, stderr, code := s3.run(t, "settings", "secret", "push", "ANTHROPIC_API_KEY", "--repo", "a/b"); code != 1 {
		t.Error("gh failure should fail the push")
	} else {
		mustContain(t, "stderr", stderr, "Could not set the Codespaces user secret")
	}
}

func TestCodespaceSecretMissingPointsAtPush(t *testing.T) {
	// The create-path secret preflight names the ONE command that fixes it
	// when a local source is registered — and the generic gh hint otherwise.
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_SECRET_404=1")
	_, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "gh secret set ANTHROPIC_API_KEY --user --app codespaces")

	s2 := newScenario(t, "container", "op", "gh")
	if _, _, code := s2.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatal("set failed")
	}
	s2.extraEnv = append(s2.extraEnv,
		"FAKERT_GIT_ORIGIN=git@github.com:"+csRepo+".git", "FAKERT_GH_SECRET_404=1")
	_, stderr, code = s2.run(t, "start", "--runtime", "codespace")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"You have a local source registered (op://OSS/Anthropic/credential)",
		"semiont settings secret push ANTHROPIC_API_KEY --repo "+csRepo)
}

// A secret value never rides a container's command line, where any process on
// the machine can read it with ps; it crosses through the runtime's own
// environment and still arrives (SECRET-DELIVERY P6, D3: "keep secret values
// off the command line"). Custody values, a user's forwarded value and the
// daemons' credentials alike.
func TestSecretValuesStayOffTheCommandLine(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	if _, stderr, code := s.run(t, "start", "--config", "anthropic"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	secrets := []string{"ANTHROPIC_API_KEY", "JWT_SECRET", "SEMIONT_OIDC_CLIENT_SECRET", "KC_BOOTSTRAP_ADMIN_PASSWORD", "POSTGRES_PASSWORD", "KC_DB_PASSWORD"}
	for _, l := range strings.Split(s.argv(t), "\n") {
		if !strings.HasPrefix(l, "container run") {
			continue
		}
		for _, name := range secrets {
			if strings.Contains(l, " "+name+"=") {
				t.Errorf("%s's value is on the command line:\n%s", name, l)
			}
		}
	}
	for _, c := range []struct{ container, name, want string }{
		{"semiont-worker", "ANTHROPIC_API_KEY", "test-key"},
		{"semiont-gateway", "JWT_SECRET", ""},
		{"semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET", ""},
		{"semiont-keycloak", "KC_BOOTSTRAP_ADMIN_PASSWORD", ""},
		{"semiont-keycloak", "KC_DB_PASSWORD", ""},
		{"semiont-postgres", "POSTGRES_PASSWORD", ""},
	} {
		got, _ := s.containerEnv(t, c.container, c.name)
		if got == "" || (c.want != "" && got != c.want) {
			t.Errorf("%s did not receive %s through the runtime's environment (got %q)", c.container, c.name, got)
		}
	}
}

// Each service is handed only the variables its own config sections
// reference (SECRET-DELIVERY P5, D2: "send each service only the secrets it
// uses"). The anthropic config names ANTHROPIC_API_KEY in [inference], which
// the Librarian and Worker read and nothing else does: the Archivist lists the
// collaborator roster without it (ruled 2026-09-29: "The worker and the
// librarian are the only two images that should get inference secrets").
func TestEachServiceGetsOnlyTheSecretsItReads(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	if _, stderr, code := s.run(t, "start", "--config", "anthropic"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	log := s.argv(t)
	runLine := func(svc string) string {
		for _, l := range strings.Split(log, "\n") {
			if strings.HasPrefix(l, "container run") && strings.Contains(l, "--name semiont-"+svc+" ") {
				return l
			}
		}
		t.Fatalf("no run line for %s:\n%s", svc, log)
		return ""
	}
	for _, svc := range []string{"librarian", "worker"} {
		if v, _ := s.containerEnv(t, "semiont-"+svc, "ANTHROPIC_API_KEY"); v != "test-key" {
			t.Errorf("%s reads [inference] but was not handed ANTHROPIC_API_KEY", svc)
		}
	}
	for _, svc := range []string{"archivist", "gateway", "dispatcher", "weaver", "smelter"} {
		if _, handed := s.containerEnv(t, "semiont-"+svc, "ANTHROPIC_API_KEY"); handed || strings.Contains(runLine(svc), "ANTHROPIC_API_KEY") {
			t.Errorf("%s reads no section naming ANTHROPIC_API_KEY but was handed it", svc)
		}
	}
}

// Start demands a variable only when something reads it: a service handed it,
// or the launcher itself. A reference in an environment nobody selected, or in
// a section no service lists, reaches no one and is not demanded.
func TestStartDemandsOnlyTheVariablesSomethingReads(t *testing.T) {
	s := newScenario(t, "container")
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", "ollama-gemma.toml")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	unread := "\n[environments.local.browser]\nurl = \"${INERT}\"\n\n[environments.other.graph]\ntype = \"neo4j\"\npassword = \"${ONLY_ELSEWHERE}\"\n"
	if err := os.WriteFile(p, append(b, unread...), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := s.run(t, "start", "--config", "ollama-gemma"); code != 0 {
		t.Fatalf("start demanded a variable nothing reads: exit %d\n%s", code, stderr)
	}
}

// A role started alone resolves what the launcher reads on its behalf:
// Keycloak's external PostgreSQL password, and the key the model check sends.
func TestStartServiceResolvesWhatTheLauncherReadsForIt(t *testing.T) {
	s := newScenario(t, "container")
	writeKBConfig(t, s, "external-db", stdGraph+stdVectors+stdEmbedding+
		"[environments.local.database]\nplatform = \"external\"\nhost = \"db.example.com\"\nport = 5432\nname = \"semiont\"\nuser = \"semiont\"\npassword = \"${EXT_PG}\"\n\n")
	s.extraEnv = append(s.extraEnv, "EXT_PG=pgsecret", "ANTHROPIC_API_KEY=test-key")
	for _, c := range []struct{ service, config string }{{"identity", "external-db"}, {"inference", "anthropic"}} {
		if stdout, stderr, code := s.run(t, "start", "--service", c.service, "--config", c.config); code != 0 {
			t.Errorf("start --service %s: exit %d\n%s%s", c.service, code, stdout, stderr)
		}
	}
}

// The remote-model check uses the key the config's [inference] apiKey
// references, whatever the variable is called.
func TestRemoteModelCheckReadsTheConfiguredKey(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	keys := make(chan string, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case keys <- r.Header.Get("x-api-key"):
		default:
		}
		fmt.Fprintln(w, `{"data":[{"id":"claude-sonnet-4-5-20250929"}]}`)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	s := newScenario(t, "container")
	writeKBConfig(t, s, "own-key", stdGraph+stdVectors+stdEmbedding+stdDatabase+
		"[environments.local.inference.anthropic]\nendpoint = \"http://"+ln.Addr().String()+"\"\napiKey = \"${MY_KEY}\"\n\n"+
		"[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-sonnet-4-5-20250929\"\n\n")
	s.extraEnv = append(s.extraEnv, "MY_KEY=sk-mine")
	if _, stderr, code := s.run(t, "start", "--config", "own-key"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	select {
	case got := <-keys:
		if got != "sk-mine" {
			t.Errorf("the model check sent x-api-key %q, want the value of ${MY_KEY}", got)
		}
	default:
		t.Error("the model check never ran: it looked for ANTHROPIC_API_KEY, not the variable the config names")
	}
}

// A Node service started alone reaches only for its own sections' variables:
// the smelter reads no [inference], so restarting it raises no provider
// prompt for ANTHROPIC_API_KEY (SECRET-DELIVERY P5).
func TestStartServiceResolvesOnlyItsOwnSecrets(t *testing.T) {
	s := newScenario(t, "container", "op")
	if _, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\n%s", code, stderr)
	}
	// `secret set` verifies the source with one read of its own.
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start", "--service", "smelter", "--config", "anthropic")
	if code != 0 {
		t.Fatalf("start --service smelter: exit %d\n%s", code, stderr)
	}
	if strings.Contains(stdout, "reading from 1Password") || strings.Contains(s.argv(t), "op read") {
		t.Errorf("the smelter reached for a secret it never reads:\n%s", stdout)
	}
}

// A ${NAME:-default} names a variable the operator may set. The container's
// loader resolves it against the environment the launcher forwards, so an
// exported NAME that is not forwarded loses to its default
// (SECRET-DELIVERY F7). Unset, nothing is demanded.
func TestStartForwardsAnOptionalReferenceOnlyWhenSet(t *testing.T) {
	s := newScenario(t, "container", "op")
	cfg := filepath.Join(s.kb, ".semiont", "semiontconfig", "anthropic.toml")
	f, err := os.OpenFile(cfg, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	// In a section the worker reads: a service is handed only its own
	// sections' variables (SECRET-DELIVERY P5).
	if _, err := f.WriteString("\n[environments.local.workers.probe]\nnote = \"${SD_OPTIONAL:-fallback}\"\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")

	if _, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic"); code != 0 {
		t.Fatalf("unset: exit %d\n%s", code, stderr)
	}
	log, _ := os.ReadFile(s.log)
	if _, handed := s.containerEnv(t, "semiont-worker", "SD_OPTIONAL"); handed || strings.Contains(string(log), "SD_OPTIONAL") {
		t.Errorf("forwarded an optional reference nobody set:\n%s", log)
	}

	// A registered source sets it, as it would a required one.
	if _, stderr, code := s.run(t, "settings", "secret", "set", "SD_OPTIONAL", "op://OSS/Optional/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\n%s", code, stderr)
	}
	s.killServes(t)
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic"); code != 0 {
		t.Fatalf("registered: exit %d\n%s", code, stderr)
	}
	if v, _ := s.containerEnv(t, "semiont-worker", "SD_OPTIONAL"); v != "fake-op-secret" {
		t.Errorf("the registered source's value did not arrive (got %q)", v)
	}

	// Set to the empty string is set, and wins over both the source and the
	// default (the shared table's rule), so it is forwarded empty.
	s.killServes(t)
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	s.extraEnv = append(s.extraEnv, "SD_OPTIONAL=")
	if _, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic"); code != 0 {
		t.Fatalf("set empty: exit %d\n%s", code, stderr)
	}
	if v, handed := s.containerEnv(t, "semiont-worker", "SD_OPTIONAL"); !handed || v != "" {
		t.Errorf("an optional variable set to the empty string was not forwarded empty (got %q, handed %v)", v, handed)
	}

	// The environment wins over the source.
	s.killServes(t)
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	s.extraEnv = append(s.extraEnv, "SD_OPTIONAL=from-env")
	if _, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic"); code != 0 {
		t.Fatalf("set: exit %d\n%s", code, stderr)
	}
	if v, _ := s.containerEnv(t, "semiont-worker", "SD_OPTIONAL"); v != "from-env" {
		t.Errorf("the exported value did not win (got %q)", v)
	}
	log, _ = os.ReadFile(s.log)
	if strings.Contains(string(log), "op read") {
		t.Errorf("read the source although the environment set the variable:\n%s", log)
	}
}

func TestStartResolvesSecret(t *testing.T) {
	// A registered source feeds start: announced BEFORE the reach, resolved
	// fresh, injected into the container argv (redacted in echoes). Dry-run
	// reaches for nothing; the environment always wins over the source.
	s := newScenario(t, "container", "op")
	if _, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\nstderr:\n%s", code, stderr)
	}

	stdout, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic")
	if code != 0 {
		t.Fatalf("start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"ANTHROPIC_API_KEY: reading from 1Password (op read op://OSS/Anthropic/credential)",
		"expect an authorization prompt")
	if v, _ := s.containerEnv(t, "semiont-worker", "ANTHROPIC_API_KEY"); v != "fake-op-secret" {
		t.Errorf("the worker did not receive the resolved secret (got %q)", v)
	}
	log, _ := os.ReadFile(s.log)
	if strings.Contains(stdout, "fake-op-secret") || strings.Contains(string(log), "fake-op-secret") {
		t.Errorf("resolved secret leaked into the echoed output:\n%s", stdout)
	}

	// Dry-run must not reach into the vault: with the provider failing, the
	// plan still renders, with the placeholder.
	s.killServes(t)
	s.extraEnv = append(s.extraEnv, "FAKERT_OP_FAIL=1")
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code = s.run(t, "start", "--dry-run", "--config", "anthropic")
	if code != 0 {
		t.Fatalf("dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "dry-run stdout", stdout, "--env ANTHROPIC_API_KEY ")
	log, _ = os.ReadFile(s.log)
	if strings.Contains(string(log), "op read") {
		t.Errorf("dry-run reached into the vault:\n%s", log)
	}

	// A failing reach is a pointed failure naming the fix and the hatch.
	_, stderr, code = s.run(t, "start", "--service", "worker", "--config", "anthropic")
	if code != 1 {
		t.Fatalf("failing op: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"`op read op://OSS/Anthropic/credential` failed",
		"the environment always wins")

	// The environment always wins: with op still failing, an exported var
	// starts fine and op is never invoked.
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=from-env")
	stdout, stderr, code = s.run(t, "start", "--service", "worker", "--config", "anthropic")
	if code != 0 {
		t.Fatalf("env-wins start: exit %d\nstderr:\n%s", code, stderr)
	}
	if v, _ := s.containerEnv(t, "semiont-worker", "ANTHROPIC_API_KEY"); v != "from-env" {
		t.Errorf("the worker did not receive the exported value (got %q)", v)
	}
	log, _ = os.ReadFile(s.log)
	if strings.Contains(string(log), "op read") {
		t.Errorf("op invoked although the environment provided the value:\n%s", log)
	}
	if strings.Contains(stdout, "reading from 1Password") {
		t.Errorf("announced a reach that must not happen:\n%s", stdout)
	}
}

func TestStartSecretProviderMissing(t *testing.T) {
	// A registered source whose provider CLI is missing fails early and
	// clearly, before anything launches — with the escape hatch named.
	s := newScenario(t, "container") // no "op" shim
	reg := `{"schema":1,"secrets":{"ANTHROPIC_API_KEY":{"provider":"op","path":"OSS/x/y"}},"roots":[]}`
	p := rootsPathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(reg), 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"'op' (1Password CLI) is not on PATH",
		"the environment always wins")
}

// --- codespace placement (CODESPACE-KB-LAUNCH.md §2) ---

const csRepo = "pingel-org/foo-kb"
const csSecretRepos = `{"total_count":2,"repositories":[{"full_name":"pingel-org/foo-kb"},{"full_name":"other/bar"}]}`

func newCodespaceScenario(t *testing.T) *scenario {
	s := newScenario(t, "container", "gh")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_GIT_ORIGIN=git@github.com:"+csRepo+".git",
		"FAKERT_GH_SECRET_REPOS="+csSecretRepos,
	)
	return s
}

func TestCodespaceStartCreates(t *testing.T) {
	// The whole §1 recipe as one command, from a KB clone: preflights,
	// create, detached forward, health through it, credentials displayed.
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv, "FAKERT_GIT_DIRTY=1")
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"gh auth status",
		"gh api user/codespaces/secrets/ANTHROPIC_API_KEY/repositories",
		"gh codespace list --json name,state,repository",
		// Cost levers ride every create, explicitly (CODESPACE-COSTS.md P0
		// q3/q4): 60m idle, 30-day retention — GitHub's max, stated so a
		// tighter account default cannot silently shorten the KB's life.
		"--idle-timeout 60m --retention-period 720h",
		"gh codespace create --repo "+csRepo+" --machine premiumLinux",
		"gh codespace ports forward 4000:4000 -c fake-cs-1") // <codespacePort>:<localPort>
	mustContain(t, "stdout", stdout,
		"KB repo: "+csRepo,
		"Starting a CODESPACE for", "as PUSHED", "uncommitted changes",
		"Creating codespace for "+csRepo,
		// The health wait tails the creation log on the CREATE path (a
		// resume's creation log is stale history). The echoed command is
		// the deterministic observable — in the fake world health passes
		// on the first probe and the follower is killed before it can
		// exec, so the argv log may legitimately never see it.
		"gh codespace logs --follow -c fake-cs-1",
		"Semiont KB is up in codespace fake-cs-1",
		"Semiont KB         http://localhost:4000",
		// Codespace start ENSURES the local Browser (a runtime exists in
		// this scenario), so the summary names the live endpoint.
		"Semiont Browser    http://localhost:3000",
		// Nothing auto-creates an account, so the summary leads the
		// follow-ups with the command that makes the first one.
		"First user:", "semiont useradd --repo "+csRepo,
		"local uncommitted changes don't travel",
		"Halt compute:")
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b),
		`"name": "fake-cs-1"`, `"repo": "pingel-org/foo-kb"`,
		`"forwardPid"`, `"forwardPort": 4000`)
	// No credentials exist to leak any more — the launcher neither reads nor
	// prints them. Assert the record stays free of any password-shaped field so
	// a future feature cannot quietly reintroduce one.
	if strings.Contains(strings.ToLower(string(b)), "password") {
		t.Fatalf("a password-shaped field reached stack.json:\n%s", b)
	}
	// Placement is never sticky: no machine-wide runtime preference written.
	if rb, err := os.ReadFile(rootsPathFor(s.home)); err == nil && strings.Contains(string(rb), `"runtime": "codespace"`) {
		t.Errorf("codespace recorded as sticky runtime:\n%s", rb)
	}
}

func TestCodespaceWaitsForRemoteBeforeForwarding(t *testing.T) {
	// A FRESH create could never succeed in one command (live 2026-07-27).
	// `gh codespace ports forward` binds locally at once but EXITS the first
	// time a local connection cannot be opened through to the remote port
	// ("ssh: rejected: connect failed"). Devcontainer hooks take minutes, so
	// the launcher's own bind check — forwardAlive(), which DIALS the port —
	// killed the tunnel it was checking, and the death surfaced a step later
	// as "the port forward died after 1s — the stack may be fine."
	//
	// The checker must not destroy the thing it checks: readiness is asked
	// over ssh (which does not touch the tunnel), and the forward is only
	// established once the remote answers.
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv, "FAKERT_REMOTE_READY_AFTER=3") // up on the 3rd probe
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("a stack that comes up mid-wait must succeed: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// The readiness question was asked over ssh, before any forward existed.
	log := s.argv(t)
	sshAt := strings.Index(log, "SEMIONT_KB_READY") // the stack-readiness probe
	fwdAt := strings.Index(log, "ports forward")
	if sshAt < 0 {
		t.Fatalf("readiness was never asked over ssh:\n%s", log)
	}
	if fwdAt >= 0 && fwdAt < sshAt {
		t.Errorf("the forward was established before the remote was known ready — the ordering that killed it:\n%s", log)
	}
	if strings.Contains(stdout+stderr, "died") {
		t.Errorf("no forward should have died:\n%s\n%s", stdout, stderr)
	}
}

func TestCodespaceWaitsOutATransientSshOutage(t *testing.T) {
	// Live 2026-07-28 (semiont-caselaw-kb): on a FRESH create sshd is
	// installed during the devcontainer build, so ssh is unreachable exactly
	// during the window the readiness gate exists for. Treating the first
	// "cannot ask" as permanent skipped the wait, built the tunnel into a
	// stack that was still coming up, and reproduced the original bug —
	// politely, with a warning that predicted it.
	//
	// The launcher no longer waits on ssh at all when ssh cannot answer: it
	// probes by FORWARDING, and a tunnel that dies "connection refused" is
	// the not-ready answer, so it waits and retries. Same conclusion, no
	// timer — and a codespace that never grows an sshd is never stalled.
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv,
		"FAKERT_GH_SSH_FAIL_FIRST=2",  // sshd arrives on the 3rd attempt
		"FAKERT_REMOTE_READY_AFTER=4") // the stack a beat after that
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("a late sshd must not fail the start: exit %d\nstderr:\n%s", code, stderr)
	}
	both := stdout + stderr
	// It must have WAITED, not bailed: the give-up warning names the grace
	// period, and reaching it here would mean the outage was called permanent.
	if strings.Contains(both, "continuing without the stack check") {
		t.Errorf("a transient ssh outage was treated as permanent:\n%s", both)
	}
	if strings.Contains(both, "died") {
		t.Errorf("the forward was built before the stack was ready:\n%s", both)
	}
}

func TestCodespaceHookFailureFailsFastWithTheCause(t *testing.T) {
	// Live 2026-07-27: the devcontainer hooks failed, the creation log said so
	// in plain text — "postStartCommand from devcontainer.json failed with
	// exit code 1" — and the launcher waited out its whole readiness budget
	// anyway, because the log was rendered but never read. A stack whose setup
	// failed will never come up; waiting is time spent on a foregone
	// conclusion, and the eventual timeout blames the KB for a setup error.
	//
	// Failing FAST is only half of it: the marker is the announcement, not the
	// reason. The cause sat ~18 lines above it (a gateway refusing to boot),
	// so the report must carry the run-up or it is merely quick and useless.
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv,
		"FAKERT_GH_HOOKS_FAIL=1",
		"FAKERT_REMOTE_DOWN=1") // the stack never answers, as it cannot
	start := time.Now()
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	elapsed := time.Since(start)

	if code == 0 {
		t.Fatalf("a failed devcontainer setup must fail the start\nstdout:\n%s", stdout)
	}
	// The readiness budget is minutes; this must not approach it.
	if elapsed > 90*time.Second {
		t.Errorf("waited %s on hooks that had already failed", elapsed.Round(time.Second))
	}
	both := stdout + stderr
	mustContain(t, "diagnosis", both,
		"setup failed",          // named as a setup failure...
		"postStartCommand",      // ...quoting the devcontainer's marker
		"JWT_SECRET is not set", // ...and the CAUSE from the run-up
		"gh codespace logs")     // ...with the way to see the rest
	if strings.Contains(both, "did not come up inside") {
		t.Errorf("a setup failure was reported as a readiness timeout:\n%s", both)
	}
	// The advice names this repo, and works as printed: a failed setup leaves
	// a codespace no record names, and stop finds it the way start did.
	advice := "semiont stop --repo " + csRepo + " --delete"
	mustContain(t, "cleanup advice", both, advice)
	if _, stderr, code := s.run(t, strings.Fields(advice)[1:]...); code != 0 {
		t.Errorf("the printed cleanup advice fails: exit %d\n%s", code, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace delete -c fake-cs-1 --force")
	// The stream does NOT stop at the failure — the fake emits 30 trailing
	// lines, as the real one does — and the readiness loop only looks every
	// few seconds. Reporting from the LIVE ring would let those lines push the
	// cause out of the window, so the context is snapshotted at the latch.
	// The JWT assertion above proves the cause survived; this proves the
	// window is not merely the tail of the stream.
	if strings.Contains(both, "trailing 29") {
		t.Errorf("the report window drifted past the failure into later output:\n%s", both)
	}
	// The marker is the headline. Repeating it inside its own run-up is noise,
	// and its presence there would mean the snapshot included itself.
	if i := strings.Index(both, "Log leading up to it:"); i >= 0 {
		if strings.Contains(both[i:], "postStartCommand from devcontainer.json failed") {
			t.Errorf("the marker is duplicated inside its own run-up:\n%s", both[i:])
		}
	}
}

func TestCodespaceForwardDeathFailsFast(t *testing.T) {
	// The mid-wait forward death observed live 2026-07-23: the tunnel
	// bound, then its process died while the health gate polled — and the
	// launcher burned the full budget blaming an innocent KB. A dead
	// forward must fail FAST, name the forward, and point at the rerun.
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv,
		"FAKERT_GH_FORWARD_SICK=1",             // bound, but health never OK
		"FAKERT_GH_FORWARD_DIES_AFTER_MS=2500") // dies during the health wait
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code == 0 {
		t.Fatalf("start must fail when the forward dies\nstdout:\n%s", stdout)
	}
	mustContain(t, "diagnosis", stdout+stderr,
		"port forward", "died", "semiont start")
	if strings.Contains(stdout+stderr, "did not become ready") {
		t.Errorf("forward death misblamed the KB:\n%s\n%s", stdout, stderr)
	}
}

func TestCodespaceBareResumeRootless(t *testing.T) {
	// After a create, a BARE `semiont start` from any directory resumes the
	// recorded codespace: no --repo, no clone, no root discovery, no create.
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	s.killServes(t)
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	s.cwd = t.TempDir() // rootless: nothing resembling a KB here
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("bare resume: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"Using recorded stack's platform: codespace",
		"Resuming recorded codespace fake-cs-1",
		// The wait narrates a RESUME, not a fresh create — the VM wakes
		// with the stack already provisioned.
		"already provisioned")
	if strings.Contains(stdout, "a fresh create runs devcontainer hooks") {
		t.Errorf("resume borrowed the fresh-create wait wording:\n%s", stdout)
	}
	log, _ := os.ReadFile(s.log)
	if strings.Contains(string(log), "codespace create") {
		t.Errorf("resume created a new codespace:\n%s", log)
	}
	if strings.Contains(string(log), "rev-parse") {
		t.Errorf("resume attempted root discovery:\n%s", log)
	}

	// A different --repo is not a mismatch — it's a SECOND stack: codespace
	// stacks coexist, keyed by repo.
	s.killServes(t)
	stdout, stderr, code = s.run(t, "start", "--runtime", "codespace", "--repo", "other/bar")
	if code != 0 {
		t.Fatalf("second repo: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), "codespace:"+csRepo, "codespace:other/bar",
		`"forwardPort": 4001`) // foo's recorded 4000 stays reserved for its re-attach

	// With several codespace stacks and none forwarded, a bare start must
	// be told which.
	s.killServes(t)
	_, stderr, code = s.run(t, "start")
	if code != 1 {
		t.Fatalf("ambiguous bare start: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"2 codespace stacks are recorded",
		"--repo "+csRepo, "--repo other/bar")
}

func TestCodespaceAdoptAndDisambiguate(t *testing.T) {
	// No record, the repo already has a codespace (another machine, or a
	// deleted record): adopt it, announced — never create a second.
	s := newCodespaceScenario(t)
	s.cwd = t.TempDir() // no clone anywhere in sight
	s.extraEnv = append(s.extraEnv,
		`FAKERT_GH_CS_LIST=[{"name":"old-cs","state":"Shutdown","repository":"pingel-org/foo-kb"}]`)
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
	if code != 0 {
		t.Fatalf("adopt: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Found existing codespace for "+csRepo+": old-cs", "adopting it, not creating one")
	log, _ := os.ReadFile(s.log)
	if strings.Contains(string(log), "codespace create") {
		t.Errorf("adopt created:\n%s", log)
	}

	// Several codespaces: fail listing them; --codespace disambiguates (the
	// one corner where the name is ever input).
	s2 := newCodespaceScenario(t)
	s2.cwd = t.TempDir()
	s2.extraEnv = append(s2.extraEnv,
		`FAKERT_GH_CS_LIST=[{"name":"cs-a","state":"Available","repository":"pingel-org/foo-kb"},{"name":"cs-b","state":"Shutdown","repository":"pingel-org/foo-kb"}]`)
	_, stderr, code = s2.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
	if code != 1 {
		t.Fatalf("several: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "has 2 codespaces", "cs-a", "cs-b", "--codespace <name>")
	stdout, stderr, code = s2.run(t, "start", "--runtime", "codespace", "--repo", csRepo, "--codespace", "cs-b")
	if code != 0 {
		t.Fatalf("disambiguated: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s2.home))
	mustContain(t, "stack.json", string(b), `"name": "cs-b"`)
}

func TestCodespaceCreate503Retry(t *testing.T) {
	// §1's GitHub-side incident: 503s are retried with backoff, then the
	// create proceeds.
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_CREATE_FAILS=2")
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "GitHub returned 503", "retrying")
	log, _ := os.ReadFile(s.log)
	if n := strings.Count(string(log), "gh codespace create"); n != 3 {
		t.Errorf("want 3 create attempts, got %d:\n%s", n, log)
	}
}

func TestCodespacePreflights(t *testing.T) {
	// §1's silent/late failures become first-second failures — each with
	// the fix spelled out.
	for _, tc := range []struct {
		name string
		env  []string
		want []string
	}{
		{"scope", []string{"FAKERT_GH_SCOPES='repo'"},
			[]string{"missing the 'codespace' scope", "gh auth refresh -h github.com -s codespace"}},
		{"auth", []string{"FAKERT_GH_AUTH_FAIL=1"},
			[]string{"gh is not authenticated", "gh auth login"}},
		{"secret", []string{"FAKERT_GH_SECRET_404=1"},
			[]string{"ANTHROPIC_API_KEY is not a Codespaces user secret", "gh secret set ANTHROPIC_API_KEY"}},
	} {
		s := newCodespaceScenario(t)
		s.extraEnv = append(s.extraEnv, tc.env...)
		_, stderr, code := s.run(t, "start", "--runtime", "codespace")
		if code != 1 {
			t.Errorf("%s: want exit 1, got %d", tc.name, code)
		}
		mustContain(t, tc.name+" stderr", stderr, tc.want...)
	}
	// gh absent entirely: the earliest failure of all.
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 1 {
		t.Fatalf("no gh: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "'gh' is not on PATH", "https://cli.github.com")
}

func TestCodespaceMachinePreflight(t *testing.T) {
	// The machine list is preflighted on the CREATE path and is
	// hostRequirements-filtered by GitHub, so anything in it is adequate:
	// premiumLinux when offered, else the largest — announced. An explicit
	// --machine must actually be available; we never substitute for it.
	only := func(names ...string) string {
		all := map[string]string{
			"standardLinux32gb": `{"name":"standardLinux32gb","display_name":"4 cores, 16 GB RAM, 32 GB storage","cpus":4,"memory_in_bytes":17179869184}`,
			"premiumLinux":      `{"name":"premiumLinux","display_name":"8 cores, 32 GB RAM, 64 GB storage","cpus":8,"memory_in_bytes":34359738368}`,
			"largePremiumLinux": `{"name":"largePremiumLinux","display_name":"16 cores, 64 GB RAM, 128 GB storage","cpus":16,"memory_in_bytes":68719476736}`,
		}
		parts := []string{}
		for _, n := range names {
			parts = append(parts, all[n])
		}
		return "FAKERT_GH_MACHINES={\"machines\":[" + strings.Join(parts, ",") + "]}"
	}

	// Default: premium is offered, so premium is used — silently.
	s := newCodespaceScenario(t)
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("default: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"gh api /repos/"+csRepo+"/codespaces/machines",
		"gh codespace create --repo "+csRepo+" --machine premiumLinux")
	if strings.Contains(stdout, "isn't available") {
		t.Errorf("announced a fallback that did not happen:\n%s", stdout)
	}

	// No premium: fall back to the largest offered, announced with the reason.
	s.killServes(t) // free the parked forward: THIS test is about machine selection, not port laddering
	s2 := newCodespaceScenario(t)
	s2.extraEnv = append(s2.extraEnv, only("standardLinux32gb"))
	stdout, stderr, code = s2.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("fallback: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "fallback stdout", stdout,
		"premiumLinux isn't available to you for "+csRepo,
		"using standardLinux32gb (4 cores, 16 GB RAM, 32 GB storage)")
	log, _ = os.ReadFile(s2.log)
	mustContain(t, "argv log", string(log), "--machine standardLinux32gb")

	// Largest wins the fallback, not merely the first offered.
	s2.killServes(t) // free the parked forward: THIS test is about machine selection, not port laddering
	s3 := newCodespaceScenario(t)
	s3.extraEnv = append(s3.extraEnv, only("standardLinux32gb", "largePremiumLinux"))
	if _, stderr, code := s3.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("largest: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	log, _ = os.ReadFile(s3.log)
	mustContain(t, "argv log", string(log), "--machine largePremiumLinux")

	// Explicit and available: used, no announcement.
	s3.killServes(t) // free the parked forward: THIS test is about machine selection, not port laddering
	s4 := newCodespaceScenario(t)
	stdout, stderr, code = s4.run(t, "start", "--runtime", "codespace", "--machine", "standardLinux32gb")
	if code != 0 {
		t.Fatalf("explicit: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	log, _ = os.ReadFile(s4.log)
	mustContain(t, "argv log", string(log), "--machine standardLinux32gb")
	if strings.Contains(stdout, "isn't available") {
		t.Errorf("explicit available should not announce:\n%s", stdout)
	}

	// Explicit and NOT available: hard fail listing what is, by display name
	// — never silently substituted.
	s5 := newCodespaceScenario(t)
	s5.extraEnv = append(s5.extraEnv, only("standardLinux32gb"))
	_, stderr, code = s5.run(t, "start", "--runtime", "codespace", "--machine", "largePremiumLinux")
	if code != 1 {
		t.Fatalf("explicit unavailable: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"--machine largePremiumLinux is not available to you for "+csRepo,
		"standardLinux32gb", "4 cores, 16 GB RAM, 32 GB storage")
	if l, _ := os.ReadFile(s5.log); strings.Contains(string(l), "codespace create") {
		t.Errorf("created despite an unavailable machine:\n%s", l)
	}

	// Empty list and API error both fail with causes, before any create.
	for _, tc := range []struct{ env, want string }{
		{`FAKERT_GH_MACHINES={"machines":[]}`, "offers no machine classes"},
		{"FAKERT_GH_MACHINES=ERROR", "Could not list machine classes"},
	} {
		sx := newCodespaceScenario(t)
		sx.extraEnv = append(sx.extraEnv, tc.env)
		_, stderr, code := sx.run(t, "start", "--runtime", "codespace")
		if code != 1 {
			t.Errorf("%s: want exit 1, got %d", tc.env, code)
		}
		mustContain(t, "stderr for "+tc.env, stderr, tc.want)
	}
}

func TestCodespaceMachineInertOnResume(t *testing.T) {
	// --machine chooses hardware at creation only; on a resume it can't
	// change anything, so it is called out rather than looking effective.
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	s.killServes(t)
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--machine", "largePremiumLinux")
	if code != 0 {
		t.Fatalf("resume: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "resume stdout", stdout,
		"--machine largePremiumLinux ignored", "keeps the class it was created with")
}

func TestCodespaceSshFailureDoesNotBlockAHealthyStack(t *testing.T) {
	// The ssh at the end of a codespace start is a nicety — it backfills the
	// recorded KB identity. A failure there must not fail an otherwise healthy
	// stack, and must not stop the summary being printed.
	//
	// (This test previously covered the same invariant for an admin-credentials
	// read at the same point. That read is gone — nothing auto-creates an
	// admin — but reconcileDid still reaches over ssh here, so the invariant is
	// still worth pinning.)
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_SSH_FAIL=1")
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("a failed ssh must not fail the start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stdout", stdout,
		"Semiont KB is up in codespace", // stack still reported up
		"First user:")                   // and the next step still told
	// The launcher must never print credentials: it has none, and no KB
	// auto-creates an account for it to have.
	for _, forbidden := range []string{"Connect as ", "Reading admin credentials", "admin.json"} {
		if strings.Contains(stdout, forbidden) {
			t.Errorf("stdout still speaks of auto-created credentials (%q):\n%s", forbidden, stdout)
		}
	}
}

func TestUseraddCodespace(t *testing.T) {
	// useradd reaches a codespace stack over ssh → docker exec, and quotes
	// every argument: the remote side is a SHELL, unlike the local path.
	s := newCodespaceScenario(t)
	writeCodespaceState(t, s)

	// The password crosses on STDIN, so it is no longer shell-quoted at all —
	// the sharpest edge of this path is gone rather than escaped around. A
	// password of pure shell metacharacters must still arrive intact, and must
	// appear nowhere in the remote command line.
	nasty := "p a$s'w\"o`rd;rm -rf /"
	s.stdin = nasty + "\n"
	stdout, stderr, code := s.run(t, "useradd", "--email", "alice$NAME@example.com",
		// A flag the launcher does not know. Forwarding argv verbatim is the
		// promise, so an argument it has never heard of must cross intact and
		// quoted — that is what breaks if this path starts interpreting flags.
		"--upsert")
	if code != 0 {
		t.Fatalf("codespace useradd: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// fakert echoes the exact remote command line the shell would receive.
	if !strings.Contains(stdout, "remote-cmd: ") {
		t.Fatalf("no remote command echoed:\n%s", stdout)
	}
	remote := stdout[strings.Index(stdout, "remote-cmd: "):]
	remote = remote[:strings.IndexByte(remote, '\n')]
	mustContain(t, "remote command", remote,
		"cd /workspaces/* &&", // the KB clone; the remote shell expands the glob
		"semiont useradd",     // the codespace's OWN launcher, not a container
		"'alice$NAME@example.com'", "'--upsert'", "'--password-stdin'")
	if strings.Contains(remote, "rm -rf") {
		t.Fatalf("the password reached the remote COMMAND LINE:\n%s", remote)
	}
	// The realm administrator's password is not mentioned at all: the launcher
	// over there reads it from that machine's own environment, so this machine
	// neither holds it nor names it.
	if strings.Contains(remote, "KC_BOOTSTRAP_ADMIN") {
		t.Errorf("the remote command still carries the admin credential:\n%s", remote)
	}
	if strings.Contains(remote, "docker") || strings.Contains(remote, "semiont-gateway") {
		t.Errorf("the codespace path still reaches into a container:\n%s", remote)
	}
	// Arguments cross a SHELL, so they must be quoted. The remaining free-text
	// value is the email — validated for shape, not for shell metacharacters —
	// so a `$` in one must survive as a literal rather than expand.
	mustContain(t, "remote command", remote, "'alice$NAME@example.com'")
	// The echoed command is now IDENTICAL to the one run — with no secret in
	// argv there is nothing left to redact.
	echoed := stdout[strings.Index(stdout, "$ gh"):]
	echoed = echoed[:strings.IndexByte(echoed, '\n')]
	mustContain(t, "echoed command", echoed, "'alice$NAME@example.com'", "'--upsert'")
	if strings.Contains(echoed, "rm -rf") || strings.Contains(echoed, "redacted") {
		t.Errorf("echoed command should carry no secret and need no redaction:\n%s", echoed)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace ssh -c fake-cs-1 --")

	// --repo targets a specific codespace stack.
	if _, stderr, code := s.run(t, "useradd", "--repo", csRepo, "--email", "b@c.co", "--generate-password"); code != 0 {
		t.Fatalf("--repo useradd: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "useradd", "--repo", "no/such", "--email", "b@c.co"); code != 1 {
		t.Error("unknown --repo should fail")
	} else {
		mustContain(t, "stderr", stderr, "no/such has no codespace", "semiont start --runtime codespace --repo no/such")
	}
}

// CODESPACE-IDENTITY B5: a codespace can exist with no record on this machine
// — start adopts one it finds, but writes the record only once the stack
// answers, so a failed setup leaves a billing codespace nothing else could
// see. Every --repo verb resolves it the way start does: the record, else
// what GitHub says the repo has.
func TestRepoVerbsAdoptAnUnrecordedCodespace(t *testing.T) {
	const orphan = `FAKERT_GH_CS_LIST=[{"name":"orphan-cs","state":"Available","repository":"` + csRepo + `"}]`
	for _, c := range []struct {
		name string
		args []string
		want string // in the argv log: the verb reached the adopted codespace
	}{
		{"stop --delete", []string{"stop", "--repo", csRepo, "--delete"}, "gh codespace delete -c orphan-cs --force"},
		{"stop", []string{"stop", "--repo", csRepo}, "gh codespace stop -c orphan-cs"},
		{"status", []string{"status", "--repo", csRepo}, "-c orphan-cs"},
		{"logs", []string{"logs", "--repo", csRepo}, "gh codespace ssh -c orphan-cs"},
		{"export", []string{"export", "--repo", csRepo, "--output", "kb.tar.gz"}, "gh codespace ssh -c orphan-cs"},
		{"useradd", []string{"useradd", "--repo", csRepo, "--email", "b@c.co", "--generate-password"}, "gh codespace ssh -c orphan-cs"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := newCodespaceScenario(t)
			s.cwd = t.TempDir()
			s.extraEnv = append(s.extraEnv, orphan)
			_, stderr, _ := s.run(t, c.args...)
			if strings.Contains(stderr, "No codespace stack recorded") || strings.Contains(stderr, "has no codespace") {
				t.Fatalf("%s refused a codespace GitHub lists for %s:\n%s", c.name, csRepo, stderr)
			}
			log, _ := os.ReadFile(s.log)
			mustContain(t, "argv log", string(log), c.want)
		})
	}

	// A verb that dials the KB needs the forward only start establishes. The
	// codespace is found, so the answer is how to reach it — not that it is
	// missing.
	t.Run("login", func(t *testing.T) {
		s := newCodespaceScenario(t)
		s.cwd = t.TempDir()
		s.extraEnv = append(s.extraEnv, orphan)
		_, stderr, code := s.run(t, "login", "--repo", csRepo)
		if code != 1 {
			t.Fatalf("login with no forward: want exit 1, got %d\n%s", code, stderr)
		}
		mustContain(t, "stderr", stderr, "orphan-cs", "not forwarded", "semiont start --runtime codespace --repo "+csRepo)
	})
}

// useradd administers the stack it selected. With a local stack running for
// one knowledge base, running it from inside another must still reach the
// running stack's realm: that root's config, issuer port and admin password.
// It used to start over from the current directory and refuse about a
// knowledge base that has no stack at all.
func TestUseraddLocalAdministersTheRunningStackNotTheCwd(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	s.cwd = mkKB(t) // another knowledge base, never started
	_, stderr, _ := s.run(t, "useradd", "--runtime", "container", "--email", "a@b.co", "--generate-password")
	if strings.Contains(stderr, "Cannot tell which config this knowledge base runs") || strings.Contains(stderr, s.cwd) {
		t.Errorf("useradd administered the knowledge base in the current directory, not the running stack's:\n%s", stderr)
	}
}

func TestUseraddAmbiguousStacks(t *testing.T) {
	// Local + codespace recorded: useradd must NOT silently pick local —
	// writing a user into the wrong KB is not a silent-default decision.
	s := newCodespaceScenario(t)
	p := statePathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	both := `{"schema":3,"stacks":{` +
		`"local":{"runtime":"container","services":{"gateway":{"container":"semiont-gateway","id":"fid-semiont-gateway","provided":"launcher","startedAt":"2026-07-19T00:00:00Z"}}},` +
		`"codespace:` + csRepo + `":{"codespace":{"name":"fake-cs-1","repo":"` + csRepo + `","forwardPort":4001},"services":{}}}}`
	if err := os.WriteFile(p, []byte(both), 0o644); err != nil {
		t.Fatal(err)
	}
	s.stdin = "password123\n"
	_, stderr, code := s.run(t, "useradd", "--email", "a@b.co")
	if code != 1 {
		t.Fatalf("ambiguous useradd: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "Multiple stacks are recorded",
		"semiont useradd --runtime container", "semiont useradd --repo "+csRepo)

	// Naming the codespace resolves it; the local stack is reachable by
	// simply omitting --repo is NOT true here, so it must still refuse —
	// but --repo works.
	s.stdin = "password123\n"
	if _, stderr, code := s.run(t, "useradd", "--repo", csRepo, "--email", "a@b.co"); code != 0 {
		t.Fatalf("--repo disambiguation: exit %d\nstderr:\n%s", code, stderr)
	}
}

func TestCodespaceWithoutGh(t *testing.T) {
	// A missing gh must be NAMED, never inferred from downstream symptoms —
	// and --dry-run must still render, since a plan reaches for nothing.
	noGh := func(t *testing.T) *scenario {
		t.Helper()
		return newScenario(t, "container") // deliberately no "gh" shim
	}

	// --dry-run works with no gh installed at all.
	s := noGh(t)
	s.cwd = t.TempDir()
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo, "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run must not need gh: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "dry-run stdout", stdout, "gh codespace create --repo "+csRepo)

	// A real start says so plainly.
	_, stderr, code = s.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
	if code != 1 {
		t.Fatalf("start without gh: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "'gh' is not on PATH", "https://cli.github.com")

	// stop names the cause instead of failing opaquely.
	s2 := noGh(t)
	writeCodespaceState(t, s2)
	_, stderr, code = s2.run(t, "stop", "--repo", csRepo)
	if code != 1 {
		t.Fatalf("stop without gh: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "stopping a codespace stack needs the GitHub CLI", "'gh' is not on PATH")

	// status must NOT call a live codespace deleted just because it cannot ask.
	s3 := noGh(t)
	writeCodespaceState(t, s3)
	stdout, stderr, code = s3.run(t, "status", "--repo", csRepo)
	if code != 1 {
		t.Fatalf("status --repo without gh: want exit 1, got %d", code)
	}
	all := stdout + stderr
	// The catalog form must also refuse to call it deleted (the remote rows
	// moved from status's overview to the roots verb).
	ov, _, _ := s3.run(t, "roots")
	mustContain(t, "roots catalog", ov, "state unknown — gh unavailable")
	mustContain(t, "status output", all,
		"Could not ask GitHub about this codespace",
		"it may well be running")
	if strings.Contains(all, "deleted?") || strings.Contains(all, "no longer exists") {
		t.Errorf("an unqueryable codespace was reported as deleted:\n%s", all)
	}
	if strings.Contains(all, "semiont stop --delete") {
		t.Errorf("suggested discarding the record of a possibly-live codespace:\n%s", all)
	}
}

// writeCodespaceState plants a codespace-only record set.
func writeCodespaceState(t *testing.T, s *scenario) {
	t.Helper()
	p := statePathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	// The placement IS the platform (LAUNCHER-SERVICE-MODEL P3): no runtime
	// key, and the four codespace facts travel together inside it.
	body := `{"schema":3,"stacks":{"codespace:` + csRepo + `":{` +
		`"codespace":{"name":"fake-cs-1","repo":"` + csRepo + `","forwardPort":4001},"ports":[4001],"services":{}}}}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestKBPortAllocationDodgesLiveHolders(t *testing.T) {
	// Two scenarios alive at once (separate HOMEs, so neither sees the
	// other's records) must not collide on the KB port: allocation consults
	// lsof, and the fake answers for REAL listeners — the fidelity gap that
	// let CI hand out an unbindable 4000 (run 30143820210).
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("first create: exit %d\nstderr:\n%s", code, stderr)
	}
	s2 := newCodespaceScenario(t)
	s2.cwd = t.TempDir()
	stdout, stderr, code := s2.run(t, "start", "--runtime", "codespace", "--repo", "other/bar")
	if code != 0 {
		t.Fatalf("second create: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// It stepped over the port the first scenario's forward really holds.
	mustContain(t, "second stack's forward", string(s2.mustLog(t)), "ports forward 4000:4001")
	// Stable substrings, not the full sentences — wording may change.
	if strings.Contains(stdout, "did not come up") || strings.Contains(stdout, "port forward exited") {
		t.Errorf("second create collided on the KB port:\n%s", stdout)
	}
}

func TestCodespaceDidIsRecordedNotInferred(t *testing.T) {
	// did:web is the permanent identity in the committed event log, so the
	// remote-KB line must show only what was READ from the clone whose origin
	// named this repo — never a did matched by directory name, which would
	// attach one fork's identity to another's.
	s := newCodespaceScenario(t) // cwd is a KB clone with a .semiont/config
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), `"kbDid": "did:web:example.github.io:test-kb"`)
	stdout, _, _ := s.run(t, "roots")
	mustContain(t, "roots", stdout, "did:web:example.github.io:test-kb")

	// A --repo-only create has no clone to read — so it learns the identity
	// from the codespace itself, over the ssh it is already making for the
	// credentials. What must never happen is a did matched by name.
	s2 := newCodespaceScenario(t)
	s2.cwd = t.TempDir()
	if _, stderr, code := s2.run(t, "start", "--runtime", "codespace", "--repo", "other/bar"); code != 0 {
		t.Fatalf("repo-only create: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ = os.ReadFile(statePathFor(s2.home))
	mustContain(t, "stack.json", string(b), `"kbDid": "did:web:example.com:remote-kb"`)
	stdout, _, _ = s2.run(t, "roots")
	mustContain(t, "roots", stdout, "did:web:example.com:remote-kb")
}

func TestCodespaceDidRefreshConfirmsAndReportsDrift(t *testing.T) {
	// The recorded did is a CLAIM about which KB a codespace runs. --refresh
	// re-reads it over ssh; a disagreement is reported, never silently
	// overwritten, because did:web is the permanent identity stamped into the
	// committed event log and the interesting fact is that the two differ.
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	repo := "pingel-org/foo-kb"

	// Agreement: the remote config matches what the clone recorded.
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_KBCONFIG=[site]\ndomain = \"example.github.io:test-kb\"\n")
	stdout, stderr, code := s.run(t, "status", "--repo", repo, "--refresh")
	if code != 0 {
		t.Fatalf("refresh: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "refresh", stdout+stderr, "KB identity confirmed", "did:web:example.github.io:test-kb")

	// Drift: the codespace now answers with a different identity.
	s.extraEnv[len(s.extraEnv)-1] = "FAKERT_GH_KBCONFIG=[site]\ndomain = \"elsewhere.org:other-kb\"\n"
	stdout, stderr, _ = s.run(t, "status", "--repo", repo, "--refresh")
	mustContain(t, "drift", stdout+stderr,
		"does not match the record", "did:web:example.github.io:test-kb", "did:web:elsewhere.org:other-kb")
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json is unchanged by drift", string(b), `"kbDid": "did:web:example.github.io:test-kb"`)

	// A stopped codespace is NOT woken to satisfy a reporting command.
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	before, _ := os.ReadFile(s.log)
	stdout, stderr, _ = s.run(t, "status", "--repo", repo, "--refresh")
	mustContain(t, "refresh on stopped", stdout+stderr, "would wake this codespace")
	after, _ := os.ReadFile(s.log)
	if strings.Contains(strings.TrimPrefix(string(after), string(before)), "codespace ssh") {
		t.Errorf("status --refresh ssh-ed into a stopped codespace, waking it:\n%s",
			strings.TrimPrefix(string(after), string(before)))
	}
}

// The reaped-record advice must work where people actually run it — beside a
// local stack. Live 2026-09-28: status said a bare `semiont stop --delete`,
// which a second recorded stack turns into a refusal whose menu dropped
// --delete, so following it ran `gh codespace stop` against a codespace that
// no longer exists.
func TestReapedCodespaceAdviceWorksBesideOtherStacks(t *testing.T) {
	s := newCodespaceScenario(t)
	s.cwd = t.TempDir()
	both := `{"schema":3,"stacks":{` +
		`"local":{"runtime":"container","kbRoot":"/elsewhere","ports":[4000],"services":{}},` +
		`"codespace:` + csRepo + `":{"codespace":{"name":"fake-cs-1","repo":"` + csRepo + `","forwardPort":4001},"ports":[4001],"services":{}}}}`
	if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePathFor(s.home), []byte(both), 0o644); err != nil {
		t.Fatal(err)
	}
	advice := "semiont stop --repo " + csRepo + " --delete"

	// A bare stop cannot choose; its menu must keep the --delete it was given.
	_, stderr, _ := s.run(t, "stop", "--delete")
	mustContain(t, "stop's menu", stderr, advice)

	stdout, stderr, _ := s.run(t, "status", "--repo", csRepo)
	mustContain(t, "status advice", stdout+stderr, "no longer exists", advice)
	if _, stderr, code := s.run(t, strings.Fields(advice)[1:]...); code != 0 {
		t.Fatalf("the printed advice fails: exit %d\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	if strings.Contains(string(b), "fake-cs-1") {
		t.Errorf("the advice left the reaped record:\n%s", b)
	}
	if !strings.Contains(string(b), `"local"`) {
		t.Errorf("forgetting the codespace touched the local stack's record:\n%s", b)
	}
}

// Every codespace reaches "reaped": the launcher itself passes
// --retention-period 720h, so GitHub deletes a stopped codespace after 30
// days and the record outlives it. start must fail FAST with the real
// reason — not poll a ghost as "Provisioning" for ten minutes — and it must
// not auto-create (user-decided: a paid VM is a cost event, never a bug-fix
// side effect).
func TestStartFailsFastOnReapedCodespace(t *testing.T) {
	s := newCodespaceScenario(t)
	writeCodespaceState(t, s) // record names fake-cs-1; gh list reports [] — reaped
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
	if code != 1 {
		t.Fatalf("start on a reaped codespace: want fail-fast exit 1, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	all := stdout + stderr
	mustContain(t, "fail-fast reason and remedy", all,
		"no longer exists",
		"semiont stop --repo "+csRepo+" --delete")
	if strings.Contains(all, "Waiting for the codespace VM") {
		t.Errorf("start polled a ghost instead of failing fast:\n%s", all)
	}
	// The record cannot say why: a codespace created with another
	// --retention-period, adopted from GitHub's UI, or deleted by hand ends
	// the same way.
	if strings.Contains(all, "30-day") {
		t.Errorf("the reason names a retention the launcher cannot know:\n%s", all)
	}
	if strings.Contains(string(mustLogOrEmpty(s)), "gh codespace create") {
		t.Errorf("start auto-created a codespace from a stale record")
	}
}

// --delete's goal state is "no codespace, no record". A codespace GitHub
// already reaped is halfway there; the delete must finish the job (forget
// the record, exit 0) instead of failing on the 404 and leaving the record
// as a permanent dead end.
func TestStopDeleteForgetsReapedCodespace(t *testing.T) {
	s := newCodespaceScenario(t)
	writeCodespaceState(t, s)
	stdout, stderr, code := s.run(t, "stop", "--repo", csRepo, "--delete")
	if code != 0 {
		t.Fatalf("stop --delete on a reaped codespace: want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "delete output", stdout+stderr, "already", "record")
	if strings.Contains(stdout+stderr, "30-day") {
		t.Errorf("the message names a retention the launcher cannot know:\n%s", stdout+stderr)
	}
	if b, err := os.ReadFile(statePathFor(s.home)); err == nil && strings.Contains(string(b), "codespace:"+csRepo) {
		t.Errorf("record kept after --delete on a reaped codespace:\n%s", b)
	}
}

// A plain stop of a codespace GitHub already removed refuses with the real
// reason and the forget advice, rather than running `gh codespace stop` into
// GitHub's raw 404. Forgetting the record is --delete's job, so it stays.
func TestPlainStopOnReapedCodespaceNamesTheForget(t *testing.T) {
	s := newCodespaceScenario(t)
	writeCodespaceState(t, s)
	stdout, stderr, code := s.run(t, "stop", "--repo", csRepo)
	if code == 0 {
		t.Fatalf("stop on a reaped codespace succeeded\nstdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
	mustContain(t, "stop output", stdout+stderr, "no longer exists", "semiont stop --repo "+csRepo+" --delete")
	if strings.Contains(string(mustLogOrEmpty(s)), "gh codespace stop") {
		t.Errorf("stop ran gh codespace stop against a codespace GitHub no longer has")
	}
	if b, _ := os.ReadFile(statePathFor(s.home)); !strings.Contains(string(b), "fake-cs-1") {
		t.Errorf("a plain stop forgot the record:\n%s", b)
	}
}

// mustLogOrEmpty: the argv log, or empty when no runtime call was made —
// distinct from mustLog, which fails the test on absence.
func mustLogOrEmpty(s *scenario) []byte {
	b, _ := os.ReadFile(s.log)
	return b
}

// CODESPACE-IDENTITY B4: a codespace KB's issuer is http://keycloak.localhost:<N>
// — loopback on this machine — so the laptop forwards <N>:<N>, the same
// number on both ends, one <N> per KB so one Browser can sign in to several.
func TestCodespaceForwardsItsIssuer(t *testing.T) {
	record := func(t *testing.T, s *scenario) string {
		t.Helper()
		b, err := os.ReadFile(statePathFor(s.home))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	t.Run("fresh: 8080, no move", func(t *testing.T) {
		s := newCodespaceScenario(t)
		if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
			t.Fatalf("exit %d\n%s", code, stderr)
		}
		log, _ := os.ReadFile(s.log)
		mustContain(t, "argv log", string(log), "gh codespace ports forward 8080:8080 -c fake-cs-1")
		if strings.Contains(string(log), "KEYCLOAK_PORT=") {
			t.Errorf("moved a codespace already on the port it was given:\n%s", log)
		}
		mustContain(t, "stack.json", record(t, s), `"keycloakPort": 8080`, `"keycloakForwardPid"`)

		// stop ends both forwards.
		if _, stderr, code := s.run(t, "stop", "--repo", csRepo); code != 0 {
			t.Fatalf("stop: exit %d\n%s", code, stderr)
		}
		if strings.Contains(record(t, s), `"keycloakForwardPid"`) {
			t.Errorf("stop left the issuer forward recorded:\n%s", record(t, s))
		}
		if c, err := net.DialTimeout("tcp", "127.0.0.1:8080", time.Second); err == nil {
			c.Close()
			t.Error("the issuer forward still answers on 8080 after stop")
		}
	})

	t.Run("8080 taken: allocate 8081 and move the codespace", func(t *testing.T) {
		s := newCodespaceScenario(t)
		// A local stack on this machine holds 8080 (its own Keycloak).
		local := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"/elsewhere","ports":[8080],"services":{}}}}`
		if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(statePathFor(s.home), []byte(local), 0o644); err != nil {
			t.Fatal(err)
		}
		stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
		if code != 0 {
			t.Fatalf("exit %d\n%s", code, stderr)
		}
		log, _ := os.ReadFile(s.log)
		mustContain(t, "argv log", string(log),
			"KEYCLOAK_PORT=8081 semiont start",
			"gh codespace ports forward 8081:8081 -c fake-cs-1")
		mustContain(t, "stack.json", record(t, s), `"keycloakPort": 8081`)
		// The codespace's own summary names ITS ports, which are wrong from
		// the laptop whenever the laptop allocated others. Only the outer
		// summary may print URLs (bugs/codespace-move-output-misleads.md).
		if strings.Contains(stdout, "Semiont stack is up") || strings.Count(stdout, "Semiont KB  ") != 1 {
			t.Errorf("the codespace's own summary reached the laptop:\n%s", stdout)
		}
		mustContain(t, "the move's one line", stdout, "restarted its stack with the issuer on 8081")
	})

	t.Run("resume keeps its recorded port", func(t *testing.T) {
		s := newCodespaceScenario(t)
		s.extraEnv = append(s.extraEnv,
			`FAKERT_GH_CS_LIST=[{"name":"fake-cs-1","state":"Available","repository":"`+csRepo+`"}]`,
			"FAKERT_GH_CS_KEYCLOAK_PORT=8082")
		rec := `{"schema":3,"stacks":{"codespace:` + csRepo + `":{"codespace":{"name":"fake-cs-1","repo":"` + csRepo +
			`","forwardPort":4000,"keycloakPort":8082},"ports":[4000],"services":{}}}}`
		if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(statePathFor(s.home), []byte(rec), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo); code != 0 {
			t.Fatalf("exit %d\n%s", code, stderr)
		}
		log, _ := os.ReadFile(s.log)
		mustContain(t, "argv log", string(log), "gh codespace ports forward 8082:8082 -c fake-cs-1")
		if strings.Contains(string(log), "KEYCLOAK_PORT=") {
			t.Errorf("a resume on its recorded port rewrote the codespace:\n%s", log)
		}
	})

	t.Run("a holder that takes the port after allocation is refused, named", func(t *testing.T) {
		s := newCodespaceScenario(t)
		local := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"/elsewhere","ports":[8080],"services":{}}}}`
		if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(statePathFor(s.home), []byte(local), 0o644); err != nil {
			t.Fatal(err)
		}
		// 8081 is free when allocated; the move is held, and something else
		// takes 8081 before the forward.
		s.extraEnv = append(s.extraEnv, "FAKERT_RUN_HOLD=fake-cs-1")
		type result struct {
			stderr string
			code   int
		}
		done := make(chan result, 1)
		go func() { _, e, c := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo); done <- result{e, c} }()
		held := filepath.Join(s.fakertDir, "holding-fake-cs-1")
		for i := 0; i < 600; i++ {
			if _, err := os.Stat(held); err == nil {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if _, err := os.Stat(held); err != nil {
			t.Fatal("the issuer move never ran")
		}
		holder, err := net.Listen("tcp", "127.0.0.1:8081")
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Close()
		if err := os.WriteFile(filepath.Join(s.fakertDir, "release-fake-cs-1"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		r := <-done
		if r.code == 0 {
			t.Fatal("started with the issuer's port taken by another process")
		}
		mustContain(t, "stderr", r.stderr, "Port 8081 (needed for the issuer (forward)) is held by")
		if log, _ := os.ReadFile(s.log); strings.Contains(string(log), "ports forward 8081:8081") {
			t.Errorf("forwarded onto a port another process holds:\n%s", log)
		}
		// The codespace moved to 8081, so the record keeps that claim; only
		// the forward is missing.
		mustContain(t, "stack.json", record(t, s), `"keycloakPort": 8081`)
		if strings.Contains(record(t, s), `"keycloakForwardPid"`) {
			t.Errorf("recorded an issuer forward it could not make:\n%s", record(t, s))
		}
	})

	t.Run("an issuer the codespace does not run is not forwarded", func(t *testing.T) {
		s := newCodespaceScenario(t)
		s.extraEnv = append(s.extraEnv, "FAKERT_GH_CS_ISSUER=https://id.example.com/realms/semiont")
		if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
			t.Fatalf("exit %d\n%s", code, stderr)
		}
		log, _ := os.ReadFile(s.log)
		if strings.Count(string(log), "codespace ports forward") != 1 {
			t.Errorf("forwarded something besides the KB for an external issuer:\n%s", log)
		}
		if strings.Contains(record(t, s), `"keycloakPort"`) {
			t.Errorf("recorded an issuer port for an issuer this codespace does not run:\n%s", record(t, s))
		}
	})
}

// Two codespace KBs created from one laptop at once. Each allocates its issuer
// port from what is recorded, and a move takes minutes live, so a claim
// recorded only after the move lets the second allocate the first's port. Both
// must come up, on different issuer ports.
func TestSimultaneousCodespaceCreatesTakeDifferentIssuerPorts(t *testing.T) {
	s := newCodespaceScenario(t)
	local := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"/elsewhere","ports":[8080],"services":{}}}}`
	if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePathFor(s.home), []byte(local), 0o644); err != nil {
		t.Fatal(err)
	}
	s.extraEnv = append(s.extraEnv, "FAKERT_RUN_HOLD=fake-cs-1")
	second := *s
	second.extraEnv = append(append([]string{}, s.extraEnv...), "FAKERT_GH_CS_NAME=fake-cs-2")
	type result struct {
		out  string
		code int
	}
	first, other := make(chan result, 1), make(chan result, 1)
	go func() {
		o, e, c := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
		first <- result{o + e, c}
	}()
	held := filepath.Join(s.fakertDir, "holding-fake-cs-1")
	for i := 0; i < 600; i++ {
		if _, err := os.Stat(held); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, err := os.Stat(held); err != nil {
		t.Fatal("the first create never moved its issuer")
	}
	// The second create runs whole while the first is mid-move.
	go func() {
		o, e, c := second.run(t, "start", "--runtime", "codespace", "--repo", "other/bar")
		other <- result{o + e, c}
	}()
	r2 := <-other
	if err := os.WriteFile(filepath.Join(s.fakertDir, "release-fake-cs-1"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	r1 := <-first
	if r1.code != 0 || r2.code != 0 {
		t.Fatalf("both creates must succeed: first %d, second %d\nfirst:\n%s\nsecond:\n%s", r1.code, r2.code, r1.out, r2.out)
	}
	log := s.argv(t)
	mustContain(t, "argv log", log,
		"gh codespace ports forward 8081:8081 -c fake-cs-1",
		"gh codespace ports forward 8082:8082 -c fake-cs-2")
}

// The laptop moves a codespace's issuer only once the codespace's OWN start has
// finished — not when its gateway first answers. Live 2026-09-29, ssh could not
// answer yet, readiness was proven by the forward (the gateway), and the move's
// rerun collided with post-start's start still bringing up the rest
// (bugs/codespace-issuer-move-races-post-start.md P2).
func TestCodespaceMovesOnlyAfterItsOwnStartFinishes(t *testing.T) {
	s := newCodespaceScenario(t)
	local := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"/elsewhere","ports":[8080],"services":{}}}}`
	if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePathFor(s.home), []byte(local), 0o644); err != nil {
		t.Fatal(err)
	}
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_SSH_FAIL_FIRST=1", "FAKERT_REMOTE_STACK_READY_AFTER=3")
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	lines := strings.Split(s.argv(t), "\n")
	move, stackProbes, lastProbe := -1, 0, -1
	for i, l := range lines {
		if strings.Contains(l, "semiont status") && strings.Contains(l, "SEMIONT_KB_READY") {
			stackProbes++
			lastProbe = i
		}
		if move < 0 && strings.Contains(l, "KEYCLOAK_PORT=8081 semiont start") {
			move = i
		}
	}
	if stackProbes < 3 {
		t.Fatalf("the laptop asked the codespace's own launcher %d times, want until it said ready (3):\n%s", stackProbes, s.argv(t))
	}
	if move < 0 || move < lastProbe {
		t.Errorf("the issuer moved (line %d) before the codespace's start was done (last stack probe line %d)", move, lastProbe)
	}
}

// A start right after a stop meets GitHub still shutting the codespace down.
// Live 2026-09-29: the wake was decided once, for exactly "Shutdown", so a
// resume that saw "ShuttingDown" waited ten minutes on a codespace nothing
// would ever wake (bugs/codespace-resume-during-shutdown-never-wakes.md).
func TestCodespaceResumeWakesAfterAShutdownFinishes(t *testing.T) {
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv,
		`FAKERT_GH_CS_LIST=[{"name":"fake-cs-1","state":"Shutdown","repository":"`+csRepo+`"}]`,
		"FAKERT_GH_CS_SHUTTING_DOWN_LISTS=2")
	rec := `{"schema":3,"stacks":{"codespace:` + csRepo + `":{"codespace":{"name":"fake-cs-1","repo":"` + csRepo +
		`","forwardPort":4000},"ports":[4000],"services":{}}}}`
	if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePathFor(s.home), []byte(rec), 0o644); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo)
	if code != 0 {
		t.Fatalf("resume during a shutdown: exit %d after %s\nstdout:\n%s\nstderr:\n%s", code, time.Since(start).Round(time.Second), stdout, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace ssh -c fake-cs-1 -- true")
	if strings.Contains(stdout, "Provisioning") {
		t.Errorf("the wait narrated Provisioning while GitHub reported ShuttingDown:\n%s", stdout)
	}
}

func TestCodespaceStopKeepsRecordDeleteForgets(t *testing.T) {
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}

	// stop: gh codespace stop, forward killed, record KEPT (the codespace
	// still exists — state and credentials persist). Its advice names the
	// repo, so it works beside a local stack too.
	stdout, stderr, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop stdout", stdout, "billing halted", "state and credentials persist",
		"semiont start --runtime codespace --repo "+csRepo, "semiont stop --repo "+csRepo+" --delete")
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace stop -c fake-cs-1")
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatal("stop forgot a codespace record that still mirrors an existing codespace")
	}
	mustContain(t, "stack.json after stop", string(b), `"name": "fake-cs-1"`)
	if strings.Contains(string(b), `"forwardPid"`) {
		t.Errorf("stop left a dead forward pid recorded:\n%s", b)
	}
	// A record without a live forward is not "active" — status must not
	// claim it (active = the forward answers locally, nothing less).
	stdout, _, _ = s.run(t, "status")
	if strings.Contains(stdout, "active: https://github.com/"+csRepo) {
		t.Errorf("a stopped codespace (no forward) listed as active:\n%s", stdout)
	}

	// stop --delete: destroy and forget.
	stdout, stderr, code = s.run(t, "stop", "--delete")
	if code != 0 {
		t.Fatalf("delete: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "delete stdout", stdout, "deleted", "destroyed")
	log, _ = os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace delete -c fake-cs-1 --force")
	// The codespace record is forgotten — but stack.json itself now
	// legitimately survives: codespace start ensured the local Browser,
	// whose machine-level record lives there.
	b, _ = os.ReadFile(statePathFor(s.home))
	if strings.Contains(string(b), "codespace:") {
		t.Errorf("deleted codespace stack still recorded:\n%s", b)
	}

	// --delete is codespace-only.
	writeStackState(t, s, "container")
	_, stderr, code = s.run(t, "stop", "--delete")
	if code != 1 {
		t.Fatalf("--delete on local record: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "--delete only applies to a codespace stack")
}

func TestCodespaceStatus(t *testing.T) {
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	s.killServes(t) // forward dead: status must re-establish it

	// Available: identity line, healthy table through the respawned
	// forward, credentials read fresh.
	s.extraEnv = append(s.extraEnv,
		`FAKERT_GH_CS_LIST=[{"name":"fake-cs-1","state":"Available","repository":"pingel-org/foo-kb"}]`)
	// The default report POINTS at the catalog; `semiont roots` lists the
	// remote repos.
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout,
		"LOCAL STACK", "KNOWLEDGE BASES", "semiont roots")
	// The forward is dead (killServes above): a record without a live
	// tunnel is history, not activity.
	if strings.Contains(stdout, "active: https://github.com/"+csRepo) {
		t.Errorf("dead forward listed as active:\n%s", stdout)
	}
	stdout, _, code = s.run(t, "roots")
	if code != 0 {
		t.Fatalf("roots: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "roots stdout", stdout, csRepo, "codespace fake-cs-1")

	// --repo names ONE stack: full detail, health-coded, credentials fresh.
	stdout, _, code = s.run(t, "status", "--repo", csRepo)
	if code != 0 {
		t.Fatalf("status --repo: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "status --repo stdout", stdout,
		"CODESPACE", "fake-cs-1", csRepo, "state: Available",
		"re-establishing",
		"KB", "healthy", "http://localhost:4000/api/health",
		"the codespace's own launcher runs the stack inside it; only the KB is forwarded",
		// No credentials: status reports where to connect and how to make a
		// user, never an account it cannot vouch for.
		"connect at Host localhost, Port 4000", "semiont useradd --repo "+csRepo)

	// The respawned forward makes it ACTIVE — bare status now says so,
	// with the local port that answers.
	stdout, _, _ = s.run(t, "status")
	mustContain(t, "status after respawn", stdout,
		"active: https://github.com/"+csRepo, "http://localhost:4000)")

	// Stopped: honest stopped-but-existing, scriptably unhealthy.
	s.killServes(t)
	s.extraEnv = append(s.extraEnv[:len(s.extraEnv)-1],
		`FAKERT_GH_CS_LIST=[{"name":"fake-cs-1","state":"Shutdown","repository":"pingel-org/foo-kb"}]`)
	stdout, _, code = s.run(t, "status", "--repo", csRepo)
	if code != 1 {
		t.Fatalf("stopped status --repo: want exit 1, got %d\n%s", code, stdout)
	}
	mustContain(t, "stopped status stdout", stdout,
		"state: Shutdown", "stopped — state and credentials persist", "semiont start")
}

func TestCodespaceGuardsAndScoping(t *testing.T) {
	// Cross-placement guards: a recorded stack of either kind binds.
	// A LOCAL stack no longer blocks a codespace start: they coexist, and
	// the codespace KB simply allocates around the local stack's ports.
	s := newCodespaceScenario(t)
	statePath := statePathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
		t.Fatal(err)
	}
	local := `{"schema":3,"stacks":{"local":{"runtime":"container","ports":[3000,4000,24100],` +
		`"services":{"gateway":{"container":"semiont-gateway","id":"fid-semiont-gateway","provided":"launcher","startedAt":"2026-07-19T00:00:00Z"}}}}}`
	if err := os.WriteFile(statePath, []byte(local), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("local record + codespace start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "coexist stdout", stdout, "Semiont KB         http://localhost:4001")
	if l, _ := os.ReadFile(s.log); !strings.Contains(string(l), "ports forward 4000:4001") {
		t.Errorf("forward argv must be <codespacePort>:<localPort> = 4000:4001:\n%s", l)
	}
	b, _ := os.ReadFile(statePath)
	mustContain(t, "stack.json", string(b), `"local"`, "codespace:"+csRepo, `"forwardPort": 4001`)

	s2 := newCodespaceScenario(t)
	if _, _, code := s2.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatal("create failed")
	}
	s2.killServes(t)
	// A codespace stack no longer blocks a local start — they coexist (the
	// dry-run proves the local plan renders; only the lens would contend,
	// and it's dropped live).
	stdout, stderr, code = s2.run(t, "start", "--runtime", "container", "--dry-run")
	if code != 0 {
		t.Fatalf("codespace record + local dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "local plan stdout", stdout, "container run -d --name semiont-gateway")

	// useradd now WORKS against a codespace stack (the generated admin is
	// only the FIRST user; everything after it is useradd's job).
	if _, stderr, code := s2.run(t, "useradd", "--email", "a@b.co", "--generate-password"); code != 0 {
		t.Fatalf("useradd on codespace: exit %d\nstderr:\n%s", code, stderr)
	}

	// status --service and stop --service don't apply.
	// --repo and --root/--service name different stacks; combining them is
	// a contradiction, not a silent preference.
	if _, stderr, code := s2.run(t, "status", "--repo", csRepo, "--service", "gateway"); code != 1 {
		t.Error("--repo with --service should fail")
	} else {
		mustContain(t, "stderr", stderr, "--repo names a remote stack")
	}
	if _, stderr, code := s2.run(t, "stop", "--service", "worker"); code != 1 {
		t.Error("stop --service on codespace should fail")
	} else {
		mustContain(t, "stderr", stderr, "--service does not apply to a codespace stack (the codespace's own launcher runs its services)")
	}

	// Flag scoping: codespace-only flags need the placement; contradictions
	// and local-only knobs are rejected.
	s3 := newScenario(t, "container")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"start", "--repo", "a/b"}, "--repo/--codespace/--machine/--idle-timeout/--retention-period only apply to --runtime codespace"},
		{[]string{"start", "--machine", "basicLinux"}, "--repo/--codespace/--machine/--idle-timeout/--retention-period only apply to --runtime codespace"},
		{[]string{"start", "--runtime", "codespace", "--root", "x", "--repo", "a/b"}, "--root and --repo are contradictory"},
		{[]string{"start", "--runtime", "codespace", "--service", "worker"}, "--service does not apply to --runtime codespace (the codespace's own launcher runs its services)"},
		{[]string{"start", "--runtime", "codespace", "--no-observe"}, "--no-observe does not apply to --runtime codespace (the codespace's post-start hook decides how its own launcher starts the stack)"},
		{[]string{"start", "--runtime", "codespace", "--config", "anthropic"}, "--config does not apply to --runtime codespace"},
	} {
		_, stderr, code := s3.run(t, tc.args...)
		if code != 1 {
			t.Errorf("%v: want exit 1, got %d", tc.args, code)
		}
		mustContain(t, fmt.Sprintf("stderr for %v", tc.args), stderr, tc.want)
	}
}

func TestCodespaceDryRunAndLogs(t *testing.T) {
	// Dry-run renders the gh plan and reaches for nothing — no gh calls, no
	// record, no registry.
	s := newCodespaceScenario(t)
	s.cwd = t.TempDir()
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo, "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "dry-run stdout", stdout,
		"gh api /repos/"+csRepo+"/codespaces/machines",
		"gh codespace create --repo "+csRepo+" --machine <machine>",
		"gh codespace ports forward",
		"cat /workspaces/*/.semiont/config")
	if log, _ := os.ReadFile(s.log); strings.Contains(string(log), "gh ") {
		t.Errorf("dry-run invoked gh:\n%s", log)
	}
	if _, err := os.Stat(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Error("dry-run wrote a stack record")
	}

	// logs on a codespace record ride ssh, by wire-level container name.
	if _, _, code := s.run(t, "start", "--runtime", "codespace", "--repo", csRepo); code != 0 {
		t.Fatal("create failed")
	}
	stdout, stderr, code = s.run(t, "logs", "--service", "gateway")
	if code != 0 {
		t.Fatalf("logs: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "logs stdout", stdout, "[gateway] gateway out")
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"gh codespace ssh -c fake-cs-1 -- docker logs --follow semiont-gateway")
}

func TestMultiStackCodespaces(t *testing.T) {
	// Many codespace stacks run CONCURRENTLY, each forwarding its KB on its
	// own local port — one browser works them all via the Knowledge Bases
	// panel. Nothing switches; nothing drops.
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("foo start: exit %d\nstderr:\n%s", code, stderr)
	}
	// foo's forward stays alive; bar allocates the next KB port.
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_CS_NAME=bar-cs-1")
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", "other/bar")
	if code != 0 {
		t.Fatalf("bar start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "bar stdout", stdout, "Semiont KB         http://localhost:4001")
	if strings.Contains(stdout, "Switching") || strings.Contains(stdout, "Dropping") {
		t.Errorf("concurrent start disturbed the other stack's forward:\n%s", stdout)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b),
		"codespace:"+csRepo, "codespace:other/bar", `"name": "bar-cs-1"`,
		`"forwardPort": 4000`, `"forwardPort": 4001`)
	// BOTH KBs are reachable at once — the point of all of this.
	for _, url := range []string{"http://localhost:4000/api/health", "http://localhost:4001/api/health"} {
		resp, err := http.Get(url)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("concurrent KB %s not reachable: %v", url, err)
		}
		resp.Body.Close()
	}

	// Fleet status: overview shows both with their KB ports; with several
	// forwarded there is no single detail target — the pointer says so.
	s.extraEnv = append(s.extraEnv,
		`FAKERT_GH_CS_LIST=[{"name":"fake-cs-1","state":"Available","repository":"pingel-org/foo-kb"},{"name":"bar-cs-1","state":"Available","repository":"other/bar"}]`)
	stdout, _, code = s.run(t, "status")
	if code != 0 {
		t.Fatalf("fleet status: exit %d\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout, "KNOWLEDGE BASES", "semiont roots",
		"active: https://github.com/"+csRepo, "http://localhost:4000)",
		"active: https://github.com/other/bar", "http://localhost:4001)")
	stdout, _, code = s.run(t, "roots")
	if code != 0 {
		t.Fatalf("roots: exit %d\n%s", code, stdout)
	}
	mustContain(t, "roots stdout", stdout,
		csRepo, "codespace fake-cs-1", "http://localhost:4000",
		"other/bar", "codespace bar-cs-1", "http://localhost:4001")

	// --repo details one stack, probing ITS port.
	stdout, _, code = s.run(t, "status", "--repo", "other/bar")
	if code != 0 {
		t.Fatalf("detail status: exit %d\n%s", code, stdout)
	}
	mustContain(t, "detail stdout", stdout,
		"bar-cs-1  other/bar", "KB", "healthy", "http://localhost:4001/api/health")

	// Bare logs can't guess between two forwarded stacks; --repo can.
	_, stderr, code = s.run(t, "logs", "--service", "gateway")
	if code != 1 {
		t.Fatalf("ambiguous logs: want exit 1, got %d", code)
	}
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, code := s.run(t, "logs", "--repo", "other/bar", "--service", "gateway"); code != 0 {
		t.Fatal("targeted logs failed")
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace ssh -c bar-cs-1")

	// A bare stop refuses to guess among stacks — when the cwd says
	// nothing. (Inside a clone the origin picks; TestBareStopFollowsCwd.)
	prevCwd := s.cwd
	s.cwd = t.TempDir()
	_, stderr, code = s.run(t, "stop")
	if code != 1 {
		t.Fatalf("ambiguous stop: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "Multiple stacks are recorded",
		"semiont stop --repo "+csRepo, "semiont stop --repo other/bar")
	s.cwd = prevCwd

	// stop --repo targets exactly one; the other stack keeps its forward.
	stdout, stderr, code = s.run(t, "stop", "--repo", csRepo)
	if code != 0 {
		t.Fatalf("targeted stop: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ = os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace stop -c fake-cs-1")
	if resp, err := http.Get("http://localhost:4001/api/health"); err != nil || resp.StatusCode != 200 {
		t.Fatalf("bar's forward died with foo's stop: %v", err)
	} else {
		resp.Body.Close()
	}
	b, _ = os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), "codespace:"+csRepo, "codespace:other/bar")

	// stop --repo --delete forgets only that stack.
	if _, _, code := s.run(t, "stop", "--repo", "other/bar", "--delete"); code != 0 {
		t.Fatal("targeted delete failed")
	}
	b, _ = os.ReadFile(statePathFor(s.home))
	if strings.Contains(string(b), "other/bar") {
		t.Errorf("deleted stack still recorded:\n%s", b)
	}
	mustContain(t, "stack.json", string(b), "codespace:"+csRepo)
}

func TestBrowserPort(t *testing.T) {
	// --port moves the browser (the one flag-movable port): publish
	// <p>:3000, warn that anything holding the default origin will not
	// follow, record the moved endpoint so status and stop follow it.
	s := newScenario(t, "container")
	s.noGitRoot = true // "just the browser" needs no clone
	stdout, stderr, code := s.run(t, "start", "--service", "browser", "--port", "3001")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "--publish 3001:3000")
	mustContain(t, "stdout", stdout,
		"Browser on port 3001", "instead of 3000",
		"🚀 browser is up")
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), `"endpoint": "http://localhost:3001"`)

	// status probes the recorded endpoint, not the static 3000.
	stdout, _, code = s.run(t, "status", "--service", "browser")
	if code != 0 {
		t.Fatalf("status: exit %d\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout, "http://localhost:3001")

	// Default port stays 3000, no warning.
	s.killServes(t)
	stdout, _, code = s.run(t, "start", "--service", "browser")
	if code != 0 {
		t.Fatal("default-port browser failed")
	}
	if strings.Contains(stdout, "instead of 3000") {
		t.Errorf("default port warned:\n%s", stdout)
	}

	// Scoping: browser-only, and never with codespace placement.
	for _, tc := range []struct{ args []string }{
		{[]string{"start", "--port", "3001"}},
		{[]string{"start", "--service", "worker", "--port", "3001"}},
		{[]string{"start", "--runtime", "codespace", "--port", "3001"}},
	} {
		if _, stderr, code := s.run(t, tc.args...); code != 1 {
			t.Errorf("%v: want exit 1, got %d", tc.args, code)
		} else {
			mustContain(t, fmt.Sprintf("stderr for %v", tc.args), stderr,
				"--port only applies to --service browser")
		}
	}
	if _, stderr, code := s.run(t, "start", "--service", "browser", "--port", "notaport"); code != 1 {
		t.Error("bad port value should fail")
	} else {
		mustContain(t, "stderr", stderr, "Invalid --port")
	}
}

func TestMultiStackLocalPlusCodespace(t *testing.T) {
	// A local stack and codespace stacks coexist in the record set: verbs
	// that can't guess refuse with selectors; useradd targets the local
	// gateway; a targeted local stop leaves the codespace records alone.
	s := newCodespaceScenario(t)
	set := `{"schema":3,"stacks":{
	  "local":{"runtime":"container","services":{"gateway":{"container":"semiont-gateway","id":"fid-semiont-gateway","provided":"launcher","startedAt":"2026-07-19T00:00:00Z"}}},
	  "codespace:pingel-org/foo-kb":{"codespace":{"name":"fake-cs-1","repo":"pingel-org/foo-kb"},"ports":[3000,4000,24100,24101,24102],"services":{}}}}`
	p := statePathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(set), 0o644); err != nil {
		t.Fatal(err)
	}

	_, stderr, code := s.run(t, "stop")
	if code != 1 {
		t.Fatalf("ambiguous stop: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "Multiple stacks are recorded",
		"semiont stop --runtime container", "semiont stop --repo "+csRepo)

	// useradd will not GUESS between stacks; --runtime names the local one.
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--generate-password"); code != 1 {
		t.Fatalf("ambiguous useradd should refuse, got %d\nstderr:\n%s", code, stderr)
	}
	// --runtime names the local one. It is administered from here, so the
	// discriminator is that nothing went to the codespace — not an exec argv.
	// Read tolerantly: with the local path no longer running a container, this
	// scenario may have written no argv log at all — which is itself the point.
	before, _ := os.ReadFile(s.log)
	s.run(t, "useradd", "--runtime", "container", "--email", "a@b.co", "--generate-password")
	after, _ := os.ReadFile(s.log)
	fresh := strings.TrimPrefix(string(after), string(before))
	if strings.Contains(fresh, "gh codespace") {
		t.Errorf("useradd --runtime container reached the codespace:\n%s", fresh)
	}
	if strings.Contains(fresh, "semiont-useradd") {
		t.Errorf("the local path still execs the gateway's bin:\n%s", fresh)
	}

	// A targeted local stop consumes the local record only.
	if _, stderr, code := s.run(t, "stop", "--runtime", "container"); code != 0 {
		t.Fatalf("local stop: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	if strings.Contains(string(b), `"local"`) {
		t.Errorf("local stack survived its targeted stop:\n%s", b)
	}
	mustContain(t, "stack.json", string(b), "codespace:"+csRepo)
}

// --- config-driven boots (LAUNCHER-CONFIG-SYNC P2) ---

// writeKBConfig drops a variant semiontconfig into the scenario's KB.
func writeKBConfig(t *testing.T, s *scenario, name, body string) {
	t.Helper()
	head := "[defaults]\nenvironment = \"local\"\n\n[environments.local.gateway]\nplatform = \"posix\"\nport = 4000\npublicURL = \"http://${GATEWAY_HOST:-localhost}:4000\"\n\n" + stdIdentity + stdJobs
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", name+".toml")
	if err := os.WriteFile(p, []byte(head+body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const stdVectors = "[environments.local.vectors]\ntype = \"qdrant\"\nhost = \"${QDRANT_HOST}\"\nport = 6333\n\n"

// [identity] is MANDATORY (2026-09-21): a KB without an issuer can
// authenticate nobody, so the launcher refuses one. It rides the head rather
// than each body because it is true of EVERY knowledge base — and because a
// variant missing it reports the identity refusal instead of the one it was
// written to prove. The launcher-run Keycloak, matching the testdata configs;
// every variant already names a [database], which that shape requires.
const stdIdentity = "[environments.local.identity]\ntype = \"keycloak\"\nissuer = \"http://${KEYCLOAK_HOST}:8080/realms/semiont\"\nsubjectClaim = \"sub\"\n\n"

// [jobs] rides the head for the same reason: the dispatcher's queue is
// JetStream, every `semiont init` writes this section, and the launcher refuses
// a config without it — as it refuses one whose gateway names no publicURL,
// the address the dispatcher dials.
const stdJobs = "[environments.local.jobs]\ntype = \"jetstream\"\nservers = \"${NATS_HOST}:4222\"\n\n"

// Every config must name a vector store and an embedding provider — the
// launcher refuses one that does not, exactly as the gateway's loader does.
// So these two are as standard as stdGraph/stdDatabase, and a variant that
// wants no local Ollama reaches for stdEmbeddingVoyage rather than dropping
// the section.
const stdEmbedding = "[environments.local.embedding]\ntype = \"ollama\"\nmodel = \"nomic-embed-text\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"\n\n"
const stdEmbeddingVoyage = "[environments.local.embedding]\nplatform = \"external\"\ntype = \"voyage\"\nmodel = \"voyage-3\"\n\n"
const stdDatabase = "[environments.local.database]\nhost = \"${POSTGRES_HOST}\"\nport = 5432\nname = \"semiont\"\nuser = \"postgres\"\n\n"
const stdGraph = "[environments.local.graph]\ntype = \"neo4j\"\nuri = \"bolt://${NEO4J_HOST}:7687\"\nusername = \"neo4j\"\n\n"

func TestStartExternalGraphBoot(t *testing.T) {
	// A graph somebody else runs (platform = "external"), at the address the
	// config states: verify reachability, launch no container, claim no graph
	// ports.
	s := newScenario(t, "container")
	writeKBConfig(t, s, "external-graph",
		"[environments.local.graph]\nplatform = \"external\"\ntype = \"neo4j\"\nuri = \"bolt://127.0.0.1:7777\"\nusername = \"neo4j\"\npassword = \"remotepass\"\n\n"+
			stdVectors+stdEmbedding+stdDatabase)
	serveHealth(t, 7777)
	stdout, stderr, code := s.run(t, "start", "--config", "external-graph")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"graph — externally provided at 127.0.0.1:7777 (reachable)",
		"🚀 Semiont stack is up")
	argv := s.argv(t)
	for _, absent := range []string{"run -d --name semiont-neo4j", "NEO4J_AUTH", "lsof -ti :7474"} {
		if strings.Contains(argv, absent) {
			t.Errorf("external graph still touched %q in argv", absent)
		}
	}

	// The record knows graph is external; status shows it and probes the real
	// endpoint; stop leaves it alone.
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatal(err)
	}
	mustContain(t, "stack.json", string(b), `"provided": "external"`, "tcp:127.0.0.1:7777")

	stdout, _, code = s.run(t, "status")
	if code != 0 {
		t.Errorf("status: exit %d\n%s", code, stdout)
	}
	for _, line := range strings.Split(stdout, "\n") {
		if strings.Contains(line, "graph") && strings.Contains(line, "tcp://") {
			mustContain(t, "graph status row", line, "Neo4j", "external", "✓", "tcp://127.0.0.1:7777")
		}
	}

	preStop := s.argv(t)
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	stopArgv := strings.TrimPrefix(s.argv(t), preStop)
	if strings.Contains(stopArgv, "semiont-neo4j") {
		t.Errorf("stop touched the external graph:\n%s", stopArgv)
	}
	mustContain(t, "stop argv", stopArgv, "stop fid-semiont-gateway")
}

func TestStartMovedDBPortBoot(t *testing.T) {
	// database.port moves the HOST side of the publish; container side stays
	// the driver default, and every check/gate follows the config.
	s := newScenario(t, "container")
	writeKBConfig(t, s, "moved-db",
		stdGraph+stdVectors+stdEmbedding+
			"[environments.local.database]\nhost = \"${POSTGRES_HOST}\"\nport = 5433\nname = \"semiont\"\nuser = \"postgres\"\n\n")
	stdout, stderr, code := s.run(t, "start", "--config", "moved-db")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "database — PostgreSQL on port 5433")
	mustContain(t, "argv", s.argv(t), "-p 5433:5432", "nc -z -w 2 192.168.64.1 5433")
}

func TestStartNoInferenceBoot(t *testing.T) {
	// A config that references no ollama anywhere: nothing local is launched
	// for inference — but its Claude-bound worker means inference IS
	// configured, as an external SaaS role. "Not referenced" was the old
	// ollama/inference conflation's answer.
	s := newScenario(t, "container")
	writeKBConfig(t, s, "no-ollama",
		stdGraph+stdVectors+stdDatabase+stdEmbeddingVoyage+
			"[environments.local.inference.anthropic]\nplatform = \"external\"\nendpoint = \"https://api.anthropic.com\"\napiKey = \"${ANTHROPIC_API_KEY}\"\n\n"+
			"[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-sonnet-4-5-20250929\"\n\n")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	stdout, stderr, code := s.run(t, "start", "--config", "no-ollama")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "inference — Anthropic is remote SaaS; nothing to launch")
	if argv := s.argv(t); strings.Contains(argv, "ollama") {
		t.Errorf("no-ollama config still touched ollama:\n%s", argv)
	}

	// status: both roles read as the remote services they are, and the report
	// exits healthy with no Ollama anywhere; stop never touches an ollama
	// container either.
	stdout, _, code = s.run(t, "status")
	if code != 0 {
		t.Errorf("status: exit %d\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout,
		"inference (Anthropic)", "embedding (Voyage)", "external")
	if strings.Contains(stdout, "Ollama") {
		t.Errorf("a config referencing no Ollama still named one in status:\n%s", stdout)
	}
	preStop := s.argv(t)
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	if stopArgv := strings.TrimPrefix(s.argv(t), preStop); strings.Contains(stopArgv, "ollama") {
		t.Errorf("stop touched ollama:\n%s", stopArgv)
	}
}

func TestStartServiceExternalIsNoop(t *testing.T) {
	// P0 q5: --service on an externally-provided role warns and exits 0.
	s := newScenario(t, "container")
	writeKBConfig(t, s, "external-graph",
		"[environments.local.graph]\nplatform = \"external\"\ntype = \"neo4j\"\nuri = \"bolt://graph.example.com:7687\"\nusername = \"neo4j\"\npassword = \"remotepass\"\n\n"+
			stdVectors+stdEmbedding+stdDatabase)
	stdout, stderr, code := s.run(t, "start", "--service", "graph", "--config", "external-graph")
	if code != 0 {
		t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout+stderr", stdout+stderr, "graph is externally provided per", "graph.example.com:7687", "nothing to launch")
	if argv := s.argv(t); strings.Contains(argv, "semiont-neo4j") {
		t.Errorf("no-op still touched the container:\n%s", argv)
	}
}

func TestServiceGatewayPortFollowsConfig(t *testing.T) {
	// --service gateway port-claims the CONFIG's gateway port, not a static
	// 4000 (the last vestige of the pre-config-sync port table).
	s := newScenario(t, "container")
	writeKBConfig(t, s, "moved-gateway",
		stdGraph+stdVectors+stdEmbedding+stdDatabase)
	// writeKBConfig's header pins gateway.port = 4000; rewrite it to 4001.
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", "moved-gateway.toml")
	b, _ := os.ReadFile(p)
	if err := os.WriteFile(p, []byte(strings.Replace(string(b), "port = 4000", "port = 4001", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, _, code := s.run(t, "start", "--service", "gateway", "--config", "moved-gateway", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout,
		"require free ports: 4001",
		"wait: http://localhost:4001/api/health (120s)")
	// Against the normalized output: a temporary directory's name ends in a
	// random number, and one that contained 4000 failed this test.
	if plan := s.norm(stdout); strings.Contains(plan, "4000") {
		t.Errorf("static gateway port leaked into the plan:\n%s", plan)
	}
}

// --- SEMIONT_ROOT / KB-root discovery ---

func TestSemiontRootOverride(t *testing.T) {
	// From an unrelated directory, SEMIONT_ROOT selects the KB — GIT_DIR
	// style. The git-clone invariant then runs against the override.
	s := newScenario(t, "container")
	s.cwd = t.TempDir() // not a KB
	s.extraEnv = append(s.extraEnv, "SEMIONT_ROOT="+s.kb)
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if got := s.argv(t); got != "git -C <kb-root> rev-parse --show-toplevel\n" {
		t.Errorf("unexpected argv:\n%s", got)
	}
}

func TestSemiontRootInvalid(t *testing.T) {
	// Strict: an invalid override is an error, never silently ignored in
	// favor of discovery.
	s := newScenario(t, "container")
	for _, tc := range []struct{ root, want string }{
		{filepath.Join(t.TempDir(), "nope"), "points to non-existent directory"},
		{t.TempDir(), "does not contain a .semiont/ directory"},
	} {
		s.extraEnv = []string{"SEMIONT_ROOT=" + tc.root}
		_, stderr, code := s.run(t, "start", "--dry-run")
		if code != 1 {
			t.Errorf("SEMIONT_ROOT=%s: want exit 1, got %d", tc.root, code)
		}
		mustContain(t, "stderr", stderr, tc.want)
	}
}

func TestRootWalkUpFromSubdir(t *testing.T) {
	// Discovery walks up from cwd looking for .semiont/ — a KB subdirectory
	// resolves to the KB root (parity with the old git-rev-parse behavior).
	s := newScenario(t, "container")
	sub := filepath.Join(s.kb, "docs", "deep")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	s.cwd = sub
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
}

func TestRootNotFound(t *testing.T) {
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.noGitRoot = true
	_, stderr, code := s.run(t, "start", "--dry-run")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"no .semiont/ directory found in the current directory or any parent",
		"cd into a KB clone, or set SEMIONT_ROOT")
}

// --- roots registry + --root ---

func rootsPathFor(home string) string {
	return filepath.Join(stateHomeFor(home), "roots.json")
}

func TestRootsRegistryAndRootFlag(t *testing.T) {
	// A real start registers its root; --root then selects by basename from
	// anywhere; --dry-run reads but never writes the registry.
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start", "--service", "worker"); code != 0 {
		t.Fatalf("worker start: exit %d\nstderr:\n%s", code, stderr)
	}
	b, err := os.ReadFile(rootsPathFor(s.home))
	if err != nil {
		t.Fatalf("roots.json not written: %v", err)
	}
	var reg struct {
		Schema int `json:"schema"`
		Roots  []struct {
			Path        string `json:"path"`
			LastStarted string `json:"lastStarted"`
		} `json:"roots"`
	}
	if err := json.Unmarshal(b, &reg); err != nil {
		t.Fatalf("roots.json invalid: %v\n%s", err, b)
	}
	if len(reg.Roots) != 1 || reg.Roots[0].Path != s.kb {
		t.Fatalf("registry contents: %s", b)
	}
	mustContain(t, "roots.json", string(b),
		`"did": "did:web:example.github.io:test-kb"`,
		`"siteName": "Test Knowledge Base"`)
	if reg.Roots[0].LastStarted != "" {
		t.Error("--service start must not stamp lastStarted (full start only)")
	}

	// --root by registered basename, from an unrelated cwd.
	s.killServes(t)
	s.cwd = t.TempDir()
	stdout, stderr, code := s.run(t, "start", "--dry-run", "--root", filepath.Base(s.kb))
	if code != 0 {
		t.Fatalf("--root by name: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}

	// --root by path works without any registry.
	if _, _, code := s.run(t, "start", "--dry-run", "--root", s.kb); code != 0 {
		t.Errorf("--root by path: exit %d", code)
	}

	// Registry unchanged by the dry-runs.
	after, _ := os.ReadFile(rootsPathFor(s.home))
	var regAfter struct {
		Roots []struct{} `json:"roots"`
	}
	_ = json.Unmarshal(after, &regAfter)
	if len(regAfter.Roots) != 1 {
		t.Errorf("dry-run mutated the registry:\n%s", after)
	}

	// roots shows the registered root, with its did:web identity line.
	stdout, _, _ = s.run(t, "roots")
	mustContain(t, "roots stdout", stdout, "KNOWLEDGE BASES", s.kb, "last used ",
		"did:web:example.github.io:test-kb — Test Knowledge Base")
}

func TestRootFlagErrors(t *testing.T) {
	s := newScenario(t, "container")
	for _, tc := range []struct{ arg, want string }{
		{filepath.Join(t.TempDir(), "nope", "deep"), "--root points to non-existent directory"},
		{t.TempDir(), "--root does not contain a .semiont/ directory"},
		{"unregistered-name", "no roots are registered yet"},
	} {
		_, stderr, code := s.run(t, "start", "--dry-run", "--root", tc.arg)
		if code != 1 {
			t.Errorf("--root %s: want exit 1, got %d", tc.arg, code)
		}
		mustContain(t, "stderr for --root "+tc.arg, stderr, tc.want)
	}
	// Inapplicable service.
	_, stderr, code := s.run(t, "start", "--service", "browser", "--root", s.kb)
	if code != 1 {
		t.Errorf("--root with browser: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "--root only applies to services that read the KB config")
}

func TestConfigStickiness(t *testing.T) {
	// A successful start with an explicit --config records it per-KB in
	// roots.json; later starts without --config use it (with provenance in
	// the banner); an explicit flag always wins and re-records; failed
	// starts and dry-runs record nothing.
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")

	// Successful explicit --config records the preference.
	if _, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic"); code != 0 {
		t.Fatalf("worker start: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json", string(b), `"config": "anthropic"`)

	// A bare start now uses it, and the banner says where it came from.
	s.killServes(t)
	stdout, stderr, code := s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("sticky start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "sticky start stdout", stdout,
		"Config: anthropic", "this KB's recorded config; override with --config")

	// --dry-run reads the preference (only the anthropic config references
	// ${ANTHROPIC_API_KEY}, so its name appearing proves which config
	// drove the plan) but never writes the registry.
	before, _ := os.ReadFile(rootsPathFor(s.home))
	stdout, stderr, code = s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "dry-run stdout", stdout, "--env ANTHROPIC_API_KEY ")
	after, _ := os.ReadFile(rootsPathFor(s.home))
	if !bytes.Equal(before, after) {
		t.Errorf("dry-run mutated the registry:\n%s", after)
	}

	// An explicit flag wins over the recorded preference and re-records.
	s.killServes(t)
	stdout, stderr, code = s.run(t, "start", "--service", "worker", "--config", "ollama-gemma")
	if code != 0 {
		t.Fatalf("override start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "override stdout", stdout, "Config: ollama-gemma")
	if strings.Contains(stdout, "recorded config") {
		t.Errorf("explicit --config must not claim registry provenance:\n%s", stdout)
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json after override", string(b), `"config": "ollama-gemma"`)

	// A typo'd --config fails before launching and records nothing.
	s.killServes(t)
	if _, _, code := s.run(t, "start", "--service", "worker", "--config", "nope"); code != 1 {
		t.Fatalf("bogus config: want exit 1, got %d", code)
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json after bogus config", string(b), `"config": "ollama-gemma"`)

	// roots surfaces the sticky config on the root's identity lines.
	stdout, _, _ = s.run(t, "roots")
	mustContain(t, "roots stdout", stdout, "config: ollama-gemma (default)")

	// A recorded preference whose file has since vanished fails with the
	// provenance spelled out.
	reg := fmt.Sprintf(`{"schema":1,"roots":[{"path":%q,"config":"gone","lastUsed":"2026-07-19T00:00:00Z"}]}`, s.kb)
	if err := os.WriteFile(rootsPathFor(s.home), []byte(reg), 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code = s.run(t, "start", "--service", "worker")
	if code != 1 {
		t.Fatalf("vanished recorded config: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"Config not found: "+filepath.FromSlash(".semiont/semiontconfig/gone.toml"),
		"'gone' is this KB's recorded preference")
}

func TestLogsService(t *testing.T) {
	// --service reaches ANY role's logs — infra included (record-less stack:
	// discovery by name-scan, follow by container name).
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_STACK_RUNTIME=container")
	stdout, stderr, code := s.run(t, "logs", "--service", "graph")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Following graph —", "[graph] neo4j out", "[graph] neo4j err")
	mustContain(t, "argv", s.argv(t), "container logs --follow semiont-neo4j")
}

func TestLogsRecordAware(t *testing.T) {
	// With a record: no name-scan probes, recorded runtime + IDs drive the
	// follow; a host-provided role explains itself instead of failing weirdly.
	s := newScenario(t, "container", "docker")
	writeStackState(t, s, "container")
	stdout, _, code := s.run(t, "logs", "--service", "gateway")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout, "Using recorded stack state", "[gateway]")
	argv := s.argv(t)
	mustContain(t, "argv", argv, "container logs --follow fid-semiont-gateway")
	for _, absent := range []string{"container list", "docker ps"} {
		if strings.Contains(argv, absent) {
			t.Errorf("record-aware logs still name-scanned: %q", absent)
		}
	}

	// Host-provided inference: no container logs, pointed message.
	v2 := `{"schema":2,"runtime":"container","services":{
	  "inference":{"provided":"host","endpoint":"http://localhost:11434/api/version","startedAt":"2026-07-19T00:00:00Z"}}}`
	if err := os.WriteFile(statePathFor(s.home), []byte(v2), 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "logs", "--service", "inference")
	if code != 1 {
		t.Errorf("host-provided logs: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "inference is provided by a host process — no container logs")
}

// --- stack state record ---

// statePathFor mirrors the launcher's statePath for the scenario's fake HOME.
func statePathFor(home string) string {
	return filepath.Join(stateHomeFor(home), "stack.json")
}

// TestStackStateLifecycle drives boot → status → stop --service → stop and
// asserts the belief record steers every step: identifiers recorded at start,
// status and stop querying only the recorded runtime by ID, per-service stop
// forgetting one entry, full stop forgetting the record.
func TestStackStateLifecycle(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("boot: exit %d\nstderr:\n%s", code, stderr)
	}

	// The record: runtime + all ten services with runtime-reported IDs.
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatalf("stack.json not written: %v", err)
	}
	type recordedStack struct {
		Runtime  string `json:"runtime"`
		Services map[string]struct {
			Container string `json:"container"`
			ID        string `json:"id"`
			Image     string `json:"image"`
			Provided  string `json:"provided"`
			Endpoint  string `json:"endpoint"`
		} `json:"services"`
	}
	var set struct {
		Schema  int                      `json:"schema"`
		Stacks  map[string]recordedStack `json:"stacks"`
		Browser *struct {
			ID string `json:"id"`
		} `json:"browser"`
	}
	if err := json.Unmarshal(b, &set); err != nil {
		t.Fatalf("stack.json not valid JSON: %v\n%s", err, b)
	}
	st, ok := set.Stacks["local"]
	if !ok {
		t.Fatalf("no 'local' stack in the record set:\n%s", b)
	}
	if set.Schema != 3 || st.Runtime != "container" {
		t.Errorf("schema/runtime: got %d/%q", set.Schema, st.Runtime)
	}
	// browser is deliberately ABSENT from the stack's services: the Browser
	// is machine-level (BROWSER-LIFECYCLE.md), recorded under "browser".
	if _, ok := st.Services["browser"]; ok {
		t.Error("browser recorded as a stack service — the Browser is machine-level")
	}
	if set.Browser == nil || set.Browser.ID != "fid-semiont-browser" {
		t.Errorf("browser record missing or wrong: %+v", set.Browser)
	}
	// EXACTLY these roles, not at-least: fleet growth must fail here (a
	// census gate; main_test cannot reach the roles table to derive one).
	wantRoles := []string{"traces", "metrics", "collector", "graph", "vectors", "messaging", "identity", "inference", "embedding", "database",
		"gateway", "worker", "smelter", "weaver", "archivist", "librarian", "dispatcher"}
	if len(st.Services) != len(wantRoles) {
		got := make([]string, 0, len(st.Services))
		for role := range st.Services {
			got = append(got, role)
		}
		sort.Strings(got)
		t.Errorf("recorded roles = %v, want exactly %d roles %v — a service joined or left the fleet",
			got, len(wantRoles), wantRoles)
	}
	// inference and embedding are driver-dependent (container, host Ollama,
	// remote API — or the Ollama `inference` launched, recorded with NO
	// container: only the launching role is stamped owner, which stop keys
	// on). The invariant is ownership, not the provider string.
	driverDependent := map[string]bool{"inference": true, "embedding": true}
	for _, role := range wantRoles {
		e, ok := st.Services[role]
		if !ok {
			t.Errorf("service %q missing from record", role)
			continue
		}
		// A not-configured role (jobs, on a config with no [jobs] section)
		// is recorded as "none" and owns nothing — that IS its record.
		if e.Provided == "none" {
			if e.Container != "" || e.ID != "" || e.Image != "" || e.Endpoint != "" {
				t.Errorf("%s: recorded not-configured yet carries container %q / id %q / image %q / endpoint %q",
					role, e.Container, e.ID, e.Image, e.Endpoint)
			}
			continue
		}
		if e.Endpoint == "" {
			t.Errorf("%s: endpoint not recorded", role)
		}
		if e.Container == "" {
			if !driverDependent[role] {
				t.Errorf("%s: no container recorded — only a driver-dependent role may run without one", role)
			} else if e.ID != "" || e.Image != "" {
				t.Errorf("%s: owns no container (provided %q) yet carries id %q / image %q",
					role, e.Provided, e.ID, e.Image)
			}
			continue
		}
		if e.ID != "fid-"+e.Container {
			t.Errorf("%s: id %q not the runtime-reported identifier", role, e.ID)
		}
		if e.Image == "" {
			t.Errorf("%s: image not recorded", role)
		}
		if e.Provided != "launcher" {
			t.Errorf("%s: provided = %q, want launcher", role, e.Provided)
		}
	}

	preStatus := s.argv(t)
	statusOut, _, code := s.run(t, "status")
	if code != 0 {
		t.Errorf("status on healthy stack: exit %d", code)
	}
	mustContain(t, "status header", statusOut, "images latest")
	statusArgv := strings.TrimPrefix(s.argv(t), preStatus)
	mustContain(t, "status argv", statusArgv, "container inspect fid-semiont-gateway")
	for _, bad := range []string{"docker inspect", "podman inspect"} {
		if strings.Contains(statusArgv, bad) {
			t.Errorf("status queried a non-recorded runtime: %q", bad)
		}
	}

	// Per-service stop: weaver forgotten, record survives.
	preStop := s.argv(t)
	stdout, _, code := s.run(t, "stop", "--service", "weaver")
	if code != 0 {
		t.Fatalf("stop --service weaver: exit %d", code)
	}
	mustContain(t, "stdout", stdout, "Using recorded stack state")
	stopArgv := strings.TrimPrefix(s.argv(t), preStop)
	mustContain(t, "per-service stop argv", stopArgv, "container stop fid-semiont-weaver")
	if strings.Contains(stopArgv, "docker stop") {
		t.Error("per-service stop swept a non-recorded runtime")
	}
	b, _ = os.ReadFile(statePathFor(s.home))
	if strings.Contains(string(b), `"weaver"`) {
		t.Error("weaver entry not forgotten after stop --service")
	}
	if !strings.Contains(string(b), `"gateway"`) {
		t.Error("record lost other services on per-service stop")
	}

	// Full stop: the recorded runtime is torn down by ID; the other
	// installed runtimes get the belt-and-braces stray name-sweep (never
	// by the record's IDs — those are runtime-specific); record removed.
	preFull := s.argv(t)
	stdout, _, code = s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	mustContain(t, "stdout", stdout, "Using recorded stack state", "Semiont stack stopped.")
	fullArgv := strings.TrimPrefix(s.argv(t), preFull)
	mustContain(t, "full stop argv", fullArgv,
		"container stop fid-semiont-gateway",
		"docker stop semiont-gateway", "podman stop semiont-gateway")
	// The Browser survives a full stop — never in the sweep.
	if strings.Contains(fullArgv, "semiont-browser") {
		t.Errorf("full stop touched the Browser:\n%s", fullArgv)
	}
	for _, bad := range []string{"docker stop fid-", "podman stop fid-"} {
		if strings.Contains(fullArgv, bad) {
			t.Errorf("stray sweep used the recorded runtime's IDs: %q", bad)
		}
	}
	// stack.json now legitimately survives a full stop: the browser record
	// lives there and the Browser keeps running. The LOCAL STACK entry must
	// be gone, the browser entry present.
	b2, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatalf("stack.json should survive (browser record): %v", err)
	}
	if strings.Contains(string(b2), `"local"`) {
		t.Errorf("local stack record survived its stop:\n%s", b2)
	}
	mustContain(t, "browser record survives", string(b2), `"browser"`)
}

func TestStopTwiceIsHonest(t *testing.T) {
	// A stop with no record, no containers, and no staging says so — it
	// doesn't claim to have stopped a stack that wasn't there.
	s := newScenario(t, "container", "docker")
	removeStale, _ := filepath.Glob(s.stagingPattern())
	for _, d := range removeStale {
		os.RemoveAll(d) // suite-order leftovers from boot tests
	}
	stdout, _, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout,
		"No recorded stack",
		"sweeping all installed runtimes by name",
		"No Semiont containers found — nothing to stop.")
	if strings.Contains(stdout, "Semiont stack stopped.") {
		t.Errorf("no-op stop overstated:\n%s", stdout)
	}
}

// TestUnreadableStackRecordRefuses: a stack.json the launcher cannot read is
// a REFUSAL at every command that consults it, not an empty stack set.
//
// The record planted here is the realistic corruption rather than random
// bytes: a codespace stack recorded before its placement facts moved into a
// nested object still carries the instance name as a plain string, so the
// whole set fails to unmarshal. Read as "no stacks recorded", stop would
// report nothing to stop and status no local stack while the codespace kept
// running and billing — the silent no-op the --runtime mismatch refusal
// already exists to prevent.
func TestUnreadableStackRecordRefuses(t *testing.T) {
	s := newScenario(t, "container", "docker", "gh")
	rec := `{"schema":3,"stacks":{"codespace:owner/kb":{` +
		`"runtime":"codespace","codespace":"cs-1","repo":"owner/kb",` +
		`"forwardPort":4000,"services":{}}}}`
	p := statePathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(rec), 0o644); err != nil {
		t.Fatal(err)
	}

	// Every command that draws a conclusion from the record. A new one that
	// reads stack.json belongs in this list.
	for _, args := range [][]string{
		{"stop"},
		{"stop", "--service", "browser"},
		{"start"},
		{"start", "--dry-run"},
		{"status"},
		{"status", "--service", "browser"},
		{"logs"},
		{"clean", "--dry-run"},
		{"roots"},
		{"identity", "sync"},
		{"export", "--repo", "owner/kb"},
		{"logout"},
	} {
		stdout, stderr, code := s.run(t, args...)
		if code != 1 {
			t.Errorf("%v: want exit 1 on an unreadable record, got %d\nstdout:\n%s\nstderr:\n%s",
				args, code, stdout, stderr)
			continue
		}
		mustContain(t, strings.Join(args, " ")+" stderr", stderr,
			"Cannot read the stack record",
			"treating that as \"no stacks recorded\" would report",
			"stack.json.unreadable")
	}

	// Nothing claimed to have stopped anything, and nothing overwrote the one
	// piece of evidence about what may still be running.
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("unreadable record removed: %v", err)
	}
	if string(b) != rec {
		t.Errorf("unreadable record rewritten:\n%s", b)
	}
	if argv := s.argv(t); strings.Contains(argv, " stop ") || strings.Contains(argv, " rm ") {
		t.Errorf("a refused command still swept containers:\n%s", argv)
	}
}

// writeStackState plants a schema-2 stack.json for the scenario.
func writeStackState(t *testing.T, s *scenario, runtime string) {
	t.Helper()
	st := `{"schema":2,"runtime":"` + runtime + `","services":{
	  "gateway":{"container":"semiont-gateway","id":"fid-semiont-gateway","provided":"launcher","startedAt":"2026-07-19T00:00:00Z"}}}`
	p := statePathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(st), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestStopRuntimeMismatchKeepsRecordAndStaging(t *testing.T) {
	// stop --runtime <other> must not delete the recorded stack's staged
	// configs (live mounts!) or its record — the real stack may be running.
	s := newScenario(t, "container", "docker")
	writeStackState(t, s, "container")
	stage, err := os.MkdirTemp(s.stagingParent(), "semiont-config.")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(stage) })

	stdout, stderr, code := s.run(t, "stop", "--runtime", "docker")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout+stderr", stdout+stderr,
		"Recorded stack (under container) left untouched",
		"Swept docker only")
	if _, err := os.Stat(stage); err != nil {
		t.Error("staged configs deleted under the recorded stack's live mounts")
	}
	if _, err := os.Stat(statePathFor(s.home)); err != nil {
		t.Error("stack.json erased by a mismatched-runtime stop")
	}
	argv := s.argv(t)
	// The sweep excludes the Browser now; weaver is the first stack member.
	mustContain(t, "argv", argv, "docker stop semiont-weaver")
	if strings.Contains(argv, "container stop") {
		t.Errorf("mismatched stop touched the recorded runtime:\n%s", argv)
	}
}

func TestStartRefusesRecordedRuntimeMismatch(t *testing.T) {
	// An explicit --runtime that mismatches a live record refuses: preflight
	// would orphan the recorded stack, erase its record, and delete staging
	// under its mounts.
	s := newScenario(t, "container", "docker")
	writeStackState(t, s, "docker")
	for _, args := range [][]string{
		{"start", "--runtime", "container"},
		{"start", "--service", "worker", "--runtime", "container"},
	} {
		_, stderr, code := s.run(t, args...)
		if code != 1 {
			t.Errorf("%v: want exit 1, got %d", args, code)
		}
		mustContain(t, "stderr", stderr,
			"A recorded stack is running under docker",
			"Stop it first (semiont stop), or start with --runtime docker.")
	}
}

func TestStartPrefersRecordedRuntime(t *testing.T) {
	// Implicit runtime selection follows the record, not auto-detect order —
	// a bare restart must rejoin the stack that exists.
	s := newScenario(t, "container", "docker")
	s.extraEnv = append(s.extraEnv, "FAKERT_NSLOOKUP=ok")
	writeStackState(t, s, "docker")
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stdout", stdout,
		"docker pull ghcr.io/the-ai-alliance/semiont-gateway:latest",
		"docker run --log-opt max-size=10m --log-opt max-file=3 -d --name semiont-gateway")
	// The main flow must plan against docker; `container` may appear only in
	// the cross-runtime stray sweep, never as the launching runtime.
	if strings.Contains(stdout, "container run -d") {
		t.Errorf("dry-run planned against auto-detected runtime, not the recorded one:\n%s", stdout)
	}
}

func TestRuntimeStickiness(t *testing.T) {
	// A successful start with an explicit --runtime records it machine-wide
	// (top-level in roots.json); later bare starts use it with provenance.
	// Ambiguous auto-detect names the alternatives; implicit picks record
	// nothing; a live stack's record still outranks the preference; a
	// preference naming an uninstalled runtime falls back with a warning.
	s := newScenario(t, "container", "docker")

	// Ambiguous auto-detect is transparent, and records nothing.
	stdout, stderr, code := s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("auto start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "auto stdout", stdout,
		"Container runtime: container",
		"auto-detected; also on PATH: docker — override with --runtime")
	if b, _ := os.ReadFile(rootsPathFor(s.home)); strings.Contains(string(b), `"runtime"`) {
		t.Errorf("implicit auto-detect must not record a runtime preference:\n%s", b)
	}

	// Explicit --runtime docker on a successful start records the preference.
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	s.killServes(t)
	if _, stderr, code := s.run(t, "start", "--service", "worker", "--runtime", "docker"); code != 0 {
		t.Fatalf("docker start: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json", string(b), `"runtime": "docker"`)

	// A bare start now prefers docker, saying why.
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	s.killServes(t)
	stdout, stderr, code = s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("sticky start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "sticky stdout", stdout,
		"Container runtime: docker", "recorded from last start; override with --runtime")

	// A live stack's record outranks the preference: rejoin what exists.
	s.killServes(t)
	writeStackState(t, s, "container")
	stdout, stderr, code = s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("record-bound start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "record-bound stdout", stdout, "Using recorded stack's runtime: container")
	if strings.Contains(stdout, "recorded from last start; override with --runtime") {
		t.Errorf("banner claimed sticky provenance while the stack record chose:\n%s", stdout)
	}

	// A preference naming an uninstalled runtime warns and auto-detects.
	s.killServes(t)
	if err := os.Remove(statePathFor(s.home)); err != nil {
		t.Fatal(err)
	}
	reg := fmt.Sprintf(`{"schema":1,"runtime":"podman","roots":[{"path":%q,"lastUsed":"2026-07-19T00:00:00Z"}]}`, s.kb)
	if err := os.WriteFile(rootsPathFor(s.home), []byte(reg), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code = s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("stale-pref start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stale-pref stdout", stdout,
		"Recorded runtime preference 'podman'", "not on PATH — auto-detecting",
		"Container runtime: container")
}

func TestStartPreflightSweepsAllRuntimes(t *testing.T) {
	// The full-start preflight name-sweeps semiont-* under every OTHER
	// installed runtime too — after it, a port holder is provably foreign.
	s := newScenario(t, "container", "docker")
	s.extraEnv = append(s.extraEnv, "FAKERT_NSLOOKUP=ok")
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stdout", stdout,
		"# sweep stray Semiont containers under docker:",
		"docker stop semiont-gateway", "docker rm semiont-gateway")
}

func TestStopSweepsStrayRuntimes(t *testing.T) {
	// A bare record-driven stop also name-sweeps the other installed
	// runtimes — strays there hold ports the record knows nothing about.
	s := newScenario(t, "container", "docker")
	if _, stderr, code := s.run(t, "start", "--service", "worker"); code != 0 {
		t.Fatalf("worker start: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, stderr, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop stdout", stdout, "Using recorded stack state")
	log, err := os.ReadFile(s.log)
	if err != nil {
		t.Fatal(err)
	}
	mustContain(t, "argv log", string(log),
		"docker stop semiont-gateway", "docker rm semiont-gateway")

	// An explicit --runtime keeps its narrow meaning: no cross-runtime sweep.
	s.killServes(t)
	if _, _, code := s.run(t, "start", "--service", "worker", "--runtime", "container"); code != 0 {
		t.Fatal("restart failed")
	}
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, code := s.run(t, "stop", "--runtime", "container"); code != 0 {
		t.Fatal("narrow stop failed")
	}
	log, _ = os.ReadFile(s.log)
	if strings.Contains(string(log), "docker stop") {
		t.Errorf("explicit --runtime must not sweep other runtimes:\n%s", log)
	}
}

func TestStopVerifiesPortsReleased(t *testing.T) {
	// Stop records the stack's claimed ports at start, then verifies their
	// release after teardown: a survivor is reported with its holder (never
	// killed), and a clean release is announced.
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start", "--service", "worker"); code != 0 {
		t.Fatalf("worker start: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), `"ports"`, "24100")

	// Happy path: ports free → clean announcement.
	stdout, _, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	mustContain(t, "stop stdout", stdout, "All stack ports released")

	// A foreign holder on a claimed port is reported, not killed; stop
	// still exits 0 — its own work succeeded.
	s.killServes(t)
	if _, _, code := s.run(t, "start", "--service", "worker"); code != 0 {
		t.Fatal("restart failed")
	}
	s.extraEnv = append(s.extraEnv, "FAKERT_LSOF_24100=777", "FAKERT_PS_777=node")
	stdout, _, code = s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop with held port: exit %d", code)
	}
	mustContain(t, "stop stdout", stdout,
		"Port 24100 is still held by 777 (node)", "the next start will fail on it")
}

// --- JWT_SECRET supply ---

// A-3 (JWT-SECRET-ROTATION.md): loadOrCreateJWTSecret returned silently on all
// three paths, so the incident that motivated the whole plan — a silently
// regenerated secret invalidating every live token — was invisible in logs.
// Which path supplied the key is the one fact that makes that class
// diagnosable after the fact, and it costs one line.
func TestStartNamesWhereTheJWTSecretCameFrom(t *testing.T) {
	// 1. Freshly generated, because nothing supplied or persisted one.
	s := newScenario(t, "container")
	s.noJWTSecret = true
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "provenance", stdout, "Token-signing key", "generated")
	secret := gatewayJWTSecret(t, s)
	if strings.Contains(stdout+stderr, secret) {
		t.Error("the provenance line leaked the key itself")
	}

	// 2. A later start REUSES the persisted one, and says so. Distinguishing
	// this from "generated" is the whole point: the incident looked exactly
	// like a normal start. (--service gateway, as the sibling test does: a
	// second full start re-detects host Ollama and refuses, unrelated to this.)
	stdout, stderr, code = s.run(t, "start", "--service", "gateway")
	if code != 0 {
		t.Fatalf("restart: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "provenance", stdout, "Token-signing key", "reused")
	if strings.Contains(stdout, "generated") {
		t.Errorf("a reused key was reported as generated:\n%s", stdout)
	}

}

// The third provenance path gets its own scenario: the fake services of a
// previous one hold the stack's fixed ports until that test ends.
func TestStartNamesAnOperatorSuppliedJWTSecret(t *testing.T) {
	s := newScenario(t, "container") // the harness supplies JWT_SECRET
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("env start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "provenance", stdout, "Token-signing key", "JWT_SECRET")
}

// The gateway now reads JWT_SECRET as an ordered, comma-separated RING: the
// first value signs, every value verifies (JWT-SECRET-ROTATION.md decision D).
// The launcher only carries it — but carrying it correctly means passing a
// ring through untouched, and refusing a member the gateway would reject at
// boot, where the launcher can still say what to do about it.
func TestStartCarriesAJWTSecretRing(t *testing.T) {
	const newKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const oldKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	s := newScenario(t, "container")
	s.noJWTSecret = true
	s.extraEnv = append(s.extraEnv, "JWT_SECRET="+newKey+","+oldKey)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("a rotation ring must start: exit %d\nstderr:\n%s", code, stderr)
	}
	// Verbatim: re-joining or trimming would change what signs and what
	// verifies, and the gateway is the only component entitled to split it.
	if got := gatewayJWTSecret(t, s); got != newKey+","+oldKey {
		t.Errorf("ring was not passed through verbatim:\ngot  %q\nwant %q", got, newKey+","+oldKey)
	}
	// Rotation is a state worth naming — and the count is safe to print.
	mustContain(t, "provenance", stdout, "2 keys")
	for _, k := range []string{newKey, oldKey} {
		if strings.Contains(stdout+stderr, k) {
			t.Error("a key leaked into the output")
		}
	}

}

// A short MEMBER is the trap a whole-string length check misses — "<valid>,short"
// passes trivially. The gateway validates each key and refuses to boot, so
// catching it here, where the fix-it can be printed, beats a crash-loop.
// Its own scenario: the previous test's fake services hold the stack ports.
func TestStartRefusesAShortJWTSecretRingMember(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true
	s.extraEnv = append(s.extraEnv, "JWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,short")
	_, stderr, code := s.run(t, "start")
	if code != 1 {
		t.Fatalf("a short ring member must be refused, got exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr, "32", "JWT_SECRET", "openssl rand -hex 32")
}

// The gateway signs every token with JWT_SECRET and is the only service that
// reads it. Nothing in the image supplies it (the retired CLI's `provision`
// used to generate one), so the launcher must — and must supply the SAME one
// across restarts, because a changed secret silently invalidates every token
// already issued: the "job sits in Yielding forever" failure.
func TestStartInjectsPersistentJWTSecret(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true // exercise generate-and-persist, not the env path
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}

	argv := s.argv(t)
	first := gatewayJWTSecret(t, s)
	if len(first) < 32 {
		t.Errorf("JWT_SECRET must be >= 32 chars (the gateway rejects shorter); got %d", len(first))
	}

	// Never printed — it is a signing key, not a status field.
	if strings.Contains(stdout, first) {
		t.Error("JWT_SECRET leaked into stdout")
	}

	// Only the gateway gets it: the sidecars authenticate via the worker
	// secret + agent-token exchange and never sign anything.
	for _, svc := range []string{"worker", "smelter", "weaver", "browser"} {
		for _, line := range strings.Split(argv, "\n") {
			if strings.Contains(line, "--name semiont-"+svc) && strings.Contains(line, "JWT_SECRET") {
				t.Errorf("%s must not receive JWT_SECRET: %s", svc, line)
			}
		}
	}

	// Persisted, at 0600, under this root's state dir — so it survives the
	// stack and can be resolved again rather than re-minted.
	path := findFile(t, s.home, "jwt-secret")
	if path == "" {
		t.Fatal("JWT_SECRET was not persisted: no jwt-secret file under the state dir")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if strings.TrimSpace(string(b)) != first {
		t.Errorf("persisted secret differs from the injected one\nfile: %q\nargv: %q", strings.TrimSpace(string(b)), first)
	}
	if open := harness.OpenToOthers(t, path); open != "" {
		t.Errorf("%s %s — it is a signing key", path, open)
	}

	// Restarting just the gateway must rejoin the SAME key. This is the case
	// that matters operationally: a re-minted secret here would invalidate
	// every token the running stack's users already hold.
	out2, err2, code := s.run(t, "start", "--service", "gateway")
	if code != 0 {
		t.Fatalf("start --service gateway: exit %d\nstdout:\n%s\nstderr:\n%s", code, out2, err2)
	}
	if second := gatewayJWTSecret(t, s); second != first {
		t.Errorf("JWT_SECRET changed on restart — every previously issued token is now invalid\nfirst:  %s\nsecond: %s", first, second)
	}
}

// An explicit $JWT_SECRET is the operator's override — it wins over the
// persisted one, the same precedence a service's client secret has.
func TestStartJWTSecretEnvWins(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true // replace the harness default with our own value
	s.extraEnv = append(s.extraEnv, "JWT_SECRET=an-operator-supplied-secret-of-sufficient-length")
	if _, _, code := s.run(t, "start"); code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	if got := gatewayJWTSecret(t, s); got != "an-operator-supplied-secret-of-sufficient-length" {
		t.Errorf("env JWT_SECRET ignored; got %q", got)
	}
}

// Dry-run reaches for nothing and generates nothing: no secret file may
// appear, and the placeholder stands in for the value.
func TestStartDryRunDoesNotMintJWTSecret(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true // nothing to fall back on: a mint would be visible
	stdout, _, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	mustContain(t, "stdout", stdout, "--env JWT_SECRET ")
	if found := findFile(t, s.home, "jwt-secret"); found != "" {
		t.Errorf("--dry-run minted a secret at %s", found)
	}
}

// The secret is keyed to the KB the start RESOLVED — by did:web identity, so
// it follows a moved clone — even when the launcher was invoked from outside
// that KB via --root.
//
// This passes today for two independent reasons (the flow passes the resolved
// root, AND start Chdir()s into it), which is exactly why it is worth pinning:
// it fences the OUTCOME, so removing either mechanism shows up here as a secret
// filed under a path- hash of the caller's directory instead of the KB.
func TestStartJWTSecretKeyedToResolvedRoot(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true
	s.cwd = t.TempDir() // NOT a KB: cwd discovery would find nothing here
	if _, _, code := s.run(t, "start", "--root", s.kb); code != 0 {
		t.Fatalf("start --root: exit %d", code)
	}
	path := findFile(t, s.home, "jwt-secret")
	if path == "" {
		t.Fatal("no jwt-secret written")
	}
	if want := filepath.Join("roots", testKBKey, "jwt-secret"); !strings.HasSuffix(path, want) {
		t.Errorf("secret keyed off the wrong root\n got: %s\nwant suffix: %s", path, want)
	}
	if strings.Contains(path, "roots/path-") {
		t.Errorf("secret keyed off cwd rather than the KB's identity: %s", path)
	}
}

// keptSecrets: the secrets the filesystem store keeps for a root, by name —
// its files, less the root's own bookkeeping.
func keptSecrets(t *testing.T, dir string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading %s: %v", dir, err)
	}
	kept := map[string]string{}
	for _, e := range entries {
		if e.IsDir() || e.Name() == "meta.json" || e.Name() == "start.lock" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		kept[e.Name()] = strings.TrimSpace(string(b))
	}
	return kept
}

// Every secret-store operation is shown on the terminal before it runs: the
// operation and the secret's name, never its value (SECRETS-STORE, ruled
// 2026-09-29: "Not the secret values, but their names and the operation").
// The filesystem store is no exception.
func TestStartShowsEverySecretStoreOperation(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true
	firstOut, firstErr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("first start: exit %d\nstderr:\n%s", code, firstErr)
	}
	kept := keptSecrets(t, stateRootFor(s.home, testKBKey))
	if _, ok := kept["jwt-secret"]; !ok || len(kept) < 2 {
		t.Fatalf("the first start kept too little to test with: %d secrets", len(kept))
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	secondOut, secondErr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstderr:\n%s", code, secondErr)
	}
	for name := range kept {
		mustContain(t, "the first start", firstErr, "secrets: write "+name)
		mustContain(t, "the second start", secondErr, "secrets: read "+name)
		mustNotContain(t, "the second start", secondErr, "secrets: write "+name)
	}
	for name, value := range kept {
		for label, out := range map[string]string{
			"first start stdout": firstOut, "first start stderr": firstErr,
			"second start stdout": secondOut, "second start stderr": secondErr,
		} {
			if strings.Contains(out, value) {
				t.Errorf("%s shows the VALUE of %s", label, name)
			}
		}
	}
}

// --- the configured secrets store (SECRETS-STORE P3–P5) ---

// opItemFields: the fields of this KB's 1Password item, by label, as the fake
// CLI keeps them; nil when there is no item.
func opItemFields(t *testing.T, s *scenario) map[string]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(s.fakertDir, "op-items.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var items []struct {
		Title  string                          `json:"title"`
		Vault  struct{ Name string }           `json:"vault"`
		Fields []struct{ Label, Value string } `json:"fields"`
	}
	if err := json.Unmarshal(b, &items); err != nil {
		t.Fatal(err)
	}
	var out map[string]string
	for _, it := range items {
		if it.Title != "Semiont — "+testKBKey {
			continue
		}
		if out != nil {
			t.Fatalf("two items for one knowledge base:\n%s", b)
		}
		out = map[string]string{}
		for _, f := range it.Fields {
			if f.Label != "notesPlain" {
				out[f.Label] = f.Value
			}
		}
	}
	return out
}

// The newly started lines of the argv log, since before.
func freshLog(s *scenario, t *testing.T, before []byte) string {
	t.Helper()
	return strings.TrimPrefix(string(s.mustLog(t)), string(before))
}

func TestSecretStoreKeepsAKnowledgeBaseInOnePassword(t *testing.T) {
	s := newScenario(t, "container", "op")
	s.noJWTSecret = true
	stdout, stderr, code := s.run(t, "settings", "secret-store", "op://Semiont")
	if code != 0 {
		t.Fatalf("secret store: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "secret store", stdout, `1Password vault "Semiont"`)

	_, firstErr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("first start: exit %d\nstderr:\n%s", code, firstErr)
	}
	ref := "op://Semiont/Semiont — " + testKBKey + "/"
	mustContain(t, "first start", firstErr, "secrets: write jwt-secret ("+ref+"jwt-secret)")
	kept := opItemFields(t, s)
	if kept["jwt-secret"] == "" || kept["postgres-password"] == "" {
		t.Fatalf("the start kept its values somewhere other than the item: %d fields", len(kept))
	}
	// The configured store is the only one: nothing lands on the filesystem.
	if files := keptSecrets(t, stateRootFor(s.home, testKBKey)); len(files) != 0 {
		t.Errorf("a root on 1Password kept %d values in files too", len(files))
	}
	// Values travel on stdin: none reached any command line.
	for name, v := range kept {
		if strings.Contains(string(s.mustLog(t)), v) {
			t.Errorf("the value of %s reached a command line", name)
		}
	}

	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	before := s.mustLog(t)
	_, secondErr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstderr:\n%s", code, secondErr)
	}
	mustContain(t, "second start", secondErr, "secrets: read jwt-secret ("+ref+"jwt-secret)")
	mustNotContain(t, "second start", secondErr, "secrets: write")
	// One read of the whole item, not one call per value.
	if n := strings.Count(freshLog(s, t, before), "op item get"); n != 1 {
		t.Errorf("the second start ran `op item get` %d times, want once:\n%s", n, freshLog(s, t, before))
	}
	if got := opItemFields(t, s); got["jwt-secret"] != kept["jwt-secret"] {
		t.Error("the second start replaced the kept token-signing key")
	}

	stdout, _, _ = s.run(t, "status")
	mustContain(t, "status", stdout, `secrets: 1Password vault "Semiont", item "Semiont — `+testKBKey+`"`)
	stdout, _, code = s.run(t, "settings", "secret-store")
	if code != 0 {
		t.Fatalf("secret store (show): exit %d", code)
	}
	mustContain(t, "secret store (show)", stdout, ref+"jwt-secret", ref+"postgres-password")
}

func TestSecretStoreNeverFallsBackToTheFilesystem(t *testing.T) {
	s := newScenario(t, "container", "op")
	s.noJWTSecret = true
	if _, stderr, code := s.run(t, "settings", "secret-store", "op://Semiont"); code != 0 {
		t.Fatalf("secret store: exit %d\nstderr:\n%s", code, stderr)
	}
	if err := os.Remove(filepath.Join(s.shim, harness.Exe("op"))); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "start")
	if code == 0 {
		t.Fatal("start succeeded with its configured store unreachable")
	}
	mustContain(t, "refusal", stderr, `1Password vault "Semiont"`, "'op' is not on PATH", "never falls back")
	if files := keptSecrets(t, stateRootFor(s.home, testKBKey)); len(files) != 0 {
		t.Errorf("the refused start kept %d values on the filesystem", len(files))
	}
}

func TestSecretStoreMovesKeptValues(t *testing.T) {
	s := newScenario(t, "container", "op")
	s.noJWTSecret = true
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	dir := stateRootFor(s.home, testKBKey)
	onDisk := keptSecrets(t, dir)

	stdout, stderr, code := s.run(t, "settings", "secret-store", "op://Semiont")
	if code != 0 {
		t.Fatalf("move: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	moved := opItemFields(t, s)
	for name, v := range onDisk {
		if moved[name] != v {
			t.Errorf("%s did not arrive in 1Password intact", name)
		}
		mustContain(t, "move", stderr, "secrets: read "+name, "secrets: write "+name, "secrets: delete "+name)
		if strings.Contains(stdout+stderr, v) {
			t.Errorf("the move showed the value of %s", name)
		}
	}
	if left := keptSecrets(t, dir); len(left) != 0 {
		t.Errorf("the move left %d values in the old store", len(left))
	}
	// And back: the store it leaves is emptied the same way.
	if _, stderr, code := s.run(t, "settings", "secret-store", "file"); code != 0 {
		t.Fatalf("move back: exit %d\nstderr:\n%s", code, stderr)
	}
	if back := keptSecrets(t, dir); len(back) != len(onDisk) || back["jwt-secret"] != onDisk["jwt-secret"] {
		t.Errorf("moving back restored %d of %d values", len(back), len(onDisk))
	}
	if left := opItemFields(t, s); len(left) != 0 {
		t.Errorf("moving back left %d values in 1Password", len(left))
	}
}

func TestSecretStoreRefusesATargetThatAlreadyHoldsValues(t *testing.T) {
	s := newScenario(t, "container", "op")
	s.noJWTSecret = true
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	stale := `[{"id":"stale1","title":"Semiont — ` + testKBKey + `","category":"SECURE_NOTE","vault":{"id":"v","name":"Semiont"},` +
		`"fields":[{"id":"jwt-secret","label":"jwt-secret","type":"CONCEALED","value":"an-older-key"}]}]`
	if err := os.WriteFile(filepath.Join(s.fakertDir, "op-items.json"), []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}
	onDisk := keptSecrets(t, stateRootFor(s.home, testKBKey))
	_, stderr, code := s.run(t, "settings", "secret-store", "op://Semiont")
	if code == 0 {
		t.Fatal("a move into a store that already holds this KB's values succeeded")
	}
	mustContain(t, "refusal", stderr, "already holds", "jwt-secret")
	if got := opItemFields(t, s)["jwt-secret"]; got != "an-older-key" {
		t.Error("the refused move wrote into the target")
	}
	if left := keptSecrets(t, stateRootFor(s.home, testKBKey)); len(left) != len(onDisk) {
		t.Error("the refused move touched the source")
	}
}

func TestCleanClearsTheSecretStore(t *testing.T) {
	s := newScenario(t, "container", "op")
	s.noJWTSecret = true
	if _, stderr, code := s.run(t, "settings", "secret-store", "op://Semiont"); code != 0 {
		t.Fatalf("secret store: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	kept := opItemFields(t, s)

	stdout, stderr, code := s.run(t, "clean", "--dry-run")
	if code != 0 {
		t.Fatalf("clean --dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	for name := range kept {
		mustContain(t, "dry run", stdout, "would delete "+name)
	}
	if len(opItemFields(t, s)) != len(kept) {
		t.Error("a dry run deleted secrets")
	}

	_, stderr, code = s.run(t, "clean")
	if code != 0 {
		t.Fatalf("clean: exit %d\nstderr:\n%s", code, stderr)
	}
	for name := range kept {
		mustContain(t, "clean", stderr, "secrets: delete "+name)
	}
	if left := opItemFields(t, s); len(left) != 0 {
		t.Errorf("clean left %d values in 1Password", len(left))
	}
	// The store stays configured: the next start keeps its new values there.
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start after clean: exit %d\nstderr:\n%s", code, stderr)
	}
	if opItemFields(t, s)["jwt-secret"] == "" {
		t.Error("after a clean, the next start did not keep its values in the configured store")
	}
}

func TestCleanShowsEachSecretItDeletesFromTheFilesystem(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	kept := keptSecrets(t, stateRootFor(s.home, testKBKey))
	_, stderr, code := s.run(t, "clean")
	if code != 0 {
		t.Fatalf("clean: exit %d\nstderr:\n%s", code, stderr)
	}
	for name := range kept {
		mustContain(t, "clean", stderr, "secrets: delete "+name)
	}
}

// --- semiont settings (LAUNCHER-SETTINGS) ---

// settingRow: what `semiont settings` prints for one setting, or "": its line,
// and the line below when a wide value put its explanation there. A label may
// carry its flag: "secret-store --default".
func settingRow(out, label string) string {
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		got := f[0]
		if len(f) > 1 && strings.HasPrefix(f[1], "--") {
			got += " " + f[1]
		}
		if got != label {
			continue
		}
		if i+1 < len(lines) && strings.HasPrefix(lines[i+1], settingContinuation) {
			return line + "\n" + lines[i+1]
		}
		return line
	}
	return ""
}

// settingContinuation: the indent of an explanation printed below its value —
// the two-space margin, the 24-wide name column and the space after it.
var settingContinuation = strings.Repeat(" ", 27)

func TestSettingsListsEverySetting(t *testing.T) {
	s := newScenario(t, "container", "docker", "op")
	movableKeycloakPort(t, s)
	s.extraEnv = append(s.extraEnv, "KEYCLOAK_PORT=8181")
	if _, stderr, code := s.run(t, "start", "--runtime", "docker", "--config", "ollama-gemma"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	s.extraEnv = nil
	if _, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "settings", "secret-store", "op://Semiont"); code != 0 {
		t.Fatalf("secret store: exit %d\nstderr:\n%s", code, stderr)
	}

	before := s.mustLog(t)
	stdout, stderr, code := s.run(t, "settings")
	if code != 0 {
		t.Fatalf("settings: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	for name, wants := range map[string][]string{
		"runtime":       {"docker", "recorded"},
		"config":        {"ollama-gemma", "recorded"},
		"keycloak-port": {"8181", "recorded"},
		"secret":        {"ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"},
		"secret-store":  {`1Password vault "Semiont"`, "set"},
	} {
		row := settingRow(stdout, name)
		if row == "" {
			t.Errorf("no %s row:\n%s", name, stdout)
			continue
		}
		mustContain(t, name+" row", row, wants...)
	}
	// Showing a setting reaches for no secret: no provider, no store.
	for _, line := range strings.Split(freshLog(s, t, before), "\n") {
		if strings.HasPrefix(line, "op ") {
			t.Errorf("settings ran %q", line)
		}
	}

	// The environment wins over a recorded port, and the row says so.
	s.extraEnv = []string{"KEYCLOAK_PORT=9191"}
	stdout, _, _ = s.run(t, "settings")
	mustContain(t, "keycloak-port row", settingRow(stdout, "keycloak-port"), "9191", "KEYCLOAK_PORT")
}

func TestSettingsShowsTheDefaultsOfAFreshMachine(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "settings")
	if code != 0 {
		t.Fatalf("settings: exit %d\nstderr:\n%s", code, stderr)
	}
	for name, wants := range map[string][]string{
		"runtime":       {"auto-detect", "container"},
		"config":        {"ollama-gemma", "default"},
		"keycloak-port": {"8080", "default"},
		"secret":        {"none"},
		// Wherever the file store is named, it says it is not secure.
		"secret-store":           {"files", "default", "not secure: for development only"},
		"secret-store --default": {"files", "not secure: for development only"},
	} {
		mustContain(t, name+" row", settingRow(stdout, name), wants...)
	}
	status, _, _ := s.run(t, "settings", "--help")
	mustContain(t, "settings --help", status, "not secure: for development only")
}

func TestSettingsSetsAndClearsTheStickyOnes(t *testing.T) {
	s := newScenario(t, "container", "podman")
	movableKeycloakPort(t, s)
	run := func(args ...string) string {
		t.Helper()
		stdout, stderr, code := s.run(t, args...)
		if code != 0 {
			t.Fatalf("%v: exit %d\nstdout:\n%s\nstderr:\n%s", args, code, stdout, stderr)
		}
		return stdout
	}

	run("settings", "runtime", "podman")
	run("settings", "keycloak-port", "8282")
	run("start")
	started := s.argv(t)
	mustContain(t, "a start after the settings", started, "podman run", "8282")
	run("stop")

	run("settings", "config", "anthropic")
	mustContain(t, "config row", settingRow(run("settings", "config"), "config"), "anthropic", "recorded")

	run("settings", "runtime", "--unset")
	run("settings", "keycloak-port", "--unset")
	run("settings", "config", "--unset")
	out := run("settings")
	mustContain(t, "runtime row", settingRow(out, "runtime"), "auto-detect")
	mustContain(t, "keycloak-port row", settingRow(out, "keycloak-port"), "8080", "default")
	mustContain(t, "config row", settingRow(out, "config"), "ollama-gemma", "default")
}

// A value too wide for its column puts its explanation on the next line, under
// the value. Sharing the line left one space between them: a secret's source
// ran into "read at each start", and the file store's "for development only"
// into "the default".
func TestSettingsKeepsAWideValueApartFromItsExplanation(t *testing.T) {
	s := newScenario(t, "container", "op")
	if _, stderr, code := s.run(t, "settings", "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, stderr, code := s.run(t, "settings")
	if code != 0 {
		t.Fatalf("settings: exit %d\nstderr:\n%s", code, stderr)
	}
	lines := strings.Split(stdout, "\n")
	// explanationBelow: the row whose value starts and ends as given carries
	// its explanation alone on the next line, in the value's column.
	explanationBelow := func(valueStart, valueEnd, explanation string) {
		t.Helper()
		for i, line := range lines {
			at := strings.Index(line, valueStart)
			if at < 0 {
				continue
			}
			if !strings.HasSuffix(line, valueEnd) {
				t.Errorf("a wide value shares its line with what follows it:\n%q", line)
				return
			}
			if want := strings.Repeat(" ", at) + explanation; lines[i+1] != want {
				t.Errorf("the line after the value is\n%q, want\n%q", lines[i+1], want)
			}
			return
		}
		t.Errorf("no row holds %q:\n%s", valueStart, stdout)
	}
	explanationBelow("ANTHROPIC_API_KEY ← op://", "op://OSS/Anthropic/credential", "read at each start; the environment wins")
	explanationBelow("the files under ", "not secure: for development only", "the default")

	// A value that fits keeps its explanation beside it.
	for _, line := range lines {
		if strings.Contains(line, "auto-detect (container)") && !strings.Contains(line, "the default: the first of") {
			t.Errorf("a value that fits lost its explanation to another line:\n%q", line)
		}
	}
}

// The machine's default store applies to new knowledge bases only
// (LAUNCHER-SETTINGS D4, ruled: "I agree "new KBs only""): a KB with no
// setting and nothing kept adopts it at its first need, as its own setting,
// so changing the default later moves nothing.
func TestDefaultSecretStoreIsAdoptedByANewKnowledgeBase(t *testing.T) {
	s := newScenario(t, "container", "op")
	s.noJWTSecret = true
	if _, stderr, code := s.run(t, "settings", "secret-store", "--default", "op://Semiont"); code != 0 {
		t.Fatalf("set the default: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, _, _ := s.run(t, "settings")
	mustContain(t, "default row", settingRow(stdout, "secret-store --default"), `1Password vault "Semiont"`)

	_, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "start", stderr, "adopt", `1Password vault "Semiont"`)
	if opItemFields(t, s)["jwt-secret"] == "" {
		t.Error("the new knowledge base did not keep its secrets in the default store")
	}
	if files := keptSecrets(t, stateRootFor(s.home, testKBKey)); len(files) != 0 {
		t.Errorf("the new knowledge base kept %d values in files too", len(files))
	}
	stdout, _, _ = s.run(t, "settings")
	mustContain(t, "the KB's own row", settingRow(stdout, "secret-store"), `1Password vault "Semiont"`, "set")

	// Changing the default moves nothing: the KB keeps what it adopted.
	if _, stderr, code := s.run(t, "settings", "secret-store", "--default", "--unset"); code != 0 {
		t.Fatalf("unset the default: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	_, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "second start", stderr, "secrets: read jwt-secret (op://Semiont/")
}

func TestDefaultSecretStoreLeavesAKnowledgeBaseThatKeepsFiles(t *testing.T) {
	s := newScenario(t, "container", "op")
	s.noJWTSecret = true
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	kept := keptSecrets(t, stateRootFor(s.home, testKBKey))
	if _, stderr, code := s.run(t, "settings", "secret-store", "--default", "op://Semiont"); code != 0 {
		t.Fatalf("set the default: exit %d\nstderr:\n%s", code, stderr)
	}
	_, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustNotContain(t, "start", stderr, "adopt")
	if got := keptSecrets(t, stateRootFor(s.home, testKBKey)); got["jwt-secret"] != kept["jwt-secret"] {
		t.Error("a knowledge base that keeps files lost them to the default")
	}
	if len(opItemFields(t, s)) != 0 {
		t.Error("a knowledge base that keeps files was moved to the default store")
	}
}

// Only keeping a value adopts the default: a clean, or naming another store,
// is not a new knowledge base's first need.
func TestDefaultSecretStoreIsNotAdoptedByCleanOrAMove(t *testing.T) {
	s := newScenario(t, "container", "op")
	if _, stderr, code := s.run(t, "settings", "secret-store", "--default", "op://Semiont"); code != 0 {
		t.Fatalf("set the default: exit %d\nstderr:\n%s", code, stderr)
	}
	if err := os.MkdirAll(stateRootFor(s.home, testKBKey), 0o755); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "clean", "--dry-run")
	if code != 0 {
		t.Fatalf("clean --dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustNotContain(t, "clean", stderr, "adopt")
	stdout, _, _ := s.run(t, "settings", "secret-store")
	mustContain(t, "after clean", settingRow(stdout, "secret-store"), "files", "the default")

	_, stderr, code = s.run(t, "settings", "secret-store", "op://Other")
	if code != 0 {
		t.Fatalf("secret-store op://Other: exit %d\nstderr:\n%s", code, stderr)
	}
	mustNotContain(t, "move", stderr, "adopt", `vault "Semiont"`)
	stdout, _, _ = s.run(t, "settings", "secret-store")
	mustContain(t, "after the move", settingRow(stdout, "secret-store"), `1Password vault "Other"`)
}

// A person learns where a knowledge base keeps its secrets from the verbs
// they already run (LAUNCHER-SETTINGS D5): init's summary and the start's.
func TestInitAndStartNameTheSecretsStore(t *testing.T) {
	s := newScenario(t, "container", "op")
	if _, stderr, code := s.run(t, "settings", "secret-store", "--default", "op://Semiont"); code != 0 {
		t.Fatalf("set the default: exit %d\nstderr:\n%s", code, stderr)
	}
	born := newScenario(t, "container", "op")
	born.home = s.home
	born.cwd = t.TempDir()
	stdout, stderr, code := born.run(t, "init", "--name", "born-kb", "--domain", "example.org:born-kb", "--yes")
	if code != 0 {
		t.Fatalf("init: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "init's summary", stdout, "Secrets", "op://Semiont", "semiont settings secret-store")

	stdout, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "start's summary", stdout, "Secrets", `1Password vault "Semiont"`, "semiont settings secret-store")
}

// A setter validates as a start would, and a refused value records nothing.
func TestSettingsRefusesWhatAStartWould(t *testing.T) {
	s := newScenario(t, "container")
	before, _, _ := s.run(t, "settings")
	for _, c := range []struct {
		args  []string
		wants []string
	}{
		{[]string{"settings", "runtime", "rocket"}, []string{"rocket", "container, docker, or podman"}},
		{[]string{"settings", "runtime", "docker"}, []string{"'docker' is not on PATH"}},
		{[]string{"settings", "config", "nope"}, []string{"nope", "not found"}},
		{[]string{"settings", "keycloak-port", "70000"}, []string{"70000", "1-65535"}},
		// The fixture's configs name the issuer's port literally, so a port
		// setting would change nothing: the start's own warning, as a refusal.
		{[]string{"settings", "keycloak-port", "8282"}, []string{"names its port literally", "${KEYCLOAK_PORT}"}},
		{[]string{"settings", "nonesuch", "x"}, []string{"Unknown setting"}},
	} {
		_, stderr, code := s.run(t, c.args...)
		if code == 0 {
			t.Errorf("%v was accepted", c.args)
		}
		mustContain(t, fmt.Sprint(c.args), stderr, c.wants...)
	}
	if after, _, _ := s.run(t, "settings"); after != before {
		t.Errorf("a refused setting changed what is recorded:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// gatewayJWTSecret: the value the gateway container was given. It crosses
// through the runtime's environment, never its command line (SECRET-DELIVERY
// P6), so it is read from what the container received.
func gatewayJWTSecret(t *testing.T, s *scenario) string {
	t.Helper()
	v, ok := s.containerEnv(t, "semiont-gateway", "JWT_SECRET")
	if !ok {
		t.Fatalf("the gateway was given no JWT_SECRET:\n%s", s.argv(t))
	}
	if strings.Contains(s.argv(t), "JWT_SECRET="+v) {
		t.Errorf("the gateway's JWT_SECRET rode its command line")
	}
	return v
}

// findFile returns the first path under dir whose basename matches, else "".
func findFile(t *testing.T, dir, name string) string {
	t.Helper()
	var hit string
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() && info.Name() == name && hit == "" {
			hit = p
		}
		return nil
	})
	return hit
}

// --- start --service ---

func TestStartServiceWorker(t *testing.T) {
	// Gateway already running; Jaeger up on 16686. Restarting the worker must
	// present its OWN persisted credential, auto-enable OTel, stage a fresh
	// private config, and leave the rest of the stack untouched.
	//
	// It used to assert a secret recovered out of the gateway's env, because
	// the shared one was generated per start and never persisted. Each service
	// holds its own now, written per root, so a restart reads the same file the
	// full start wrote and no container needs inspecting.
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_gateway=running",
		// The worker is ALREADY RUNNING — this is a restart, and a restart is
		// only a restart if there is something to replace. The teardown now
		// lists before it acts, so a scenario that wants stop+rm asserted has
		// to say the container exists rather than relying on stop/rm being
		// fired blindly at a name that was never there.
		"FAKERT_STATE_worker=running",
	)
	// 24110: --service OTel keys off the collector (the export target), not
	// Jaeger's UI.
	serveHealth(t, 24110)
	stdout, stderr, code := s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"Restarting Worker Pool",
		"OTel collector detected — export enabled",
		"--env SEMIONT_OIDC_CLIENT_SECRET ",
		"🚀 worker is up",
		"semiont status",
	)
	if strings.Contains(stdout, "test-worker-client-secret") {
		t.Error("a service-account secret leaked into stdout")
	}
	argv := s.argv(t)
	mustContain(t, "argv", argv,
		"stop semiont-worker",
		"rm semiont-worker",
		"image pull ghcr.io/the-ai-alliance/semiont-worker:latest",
		"--env SEMIONT_OIDC_CLIENT_ID=semiont-worker",
		"--env OTEL_EXPORTER_OTLP_ENDPOINT=http://",
		"<config-stage>/worker.toml:/home/semiont/.semiontconfig:ro",
	)
	for _, absent := range []string{"run -d --name semiont-neo4j", "run -d --name semiont-gateway", "semiont-browser"} {
		if strings.Contains(argv, absent) {
			t.Errorf("--service worker touched the wider stack: %q in argv", absent)
		}
	}

	// A record created lazily by a --service start carries full metadata,
	// not just the runtime (regression guard: the executor refactor briefly
	// dropped these).
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatalf("stack.json not written: %v", err)
	}
	mustContain(t, "stack.json", string(b),
		`"imageVersion": "latest"`,
		`"kbRoot": "`+inJSON(s.kb)+`"`,
		`"kbDid": "did:web:example.github.io:test-kb"`)
}

func TestStartServiceGraph(t *testing.T) {
	// Infra service: no config, no secret, no host-addr probe, no pull
	// (pinned image) — just its own stop+rm, run, and health gate.
	s := newScenario(t, "container")
	// Already running, so "Restarting graph" has something to replace. The
	// teardown lists before it acts; a scenario asserting stop+rm must say the
	// container is there rather than relying on a blind fire at its name.
	s.extraEnv = append(s.extraEnv, "FAKERT_STATE_neo4j=running")
	stdout, stderr, code := s.run(t, "start", "--service", "graph")
	if code != 0 {
		t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting Graph (Neo4j)", "🚀 graph is up")
	argv := s.argv(t)
	mustContain(t, "argv", argv, "stop semiont-neo4j", "rm semiont-neo4j", "run -d --name semiont-neo4j")
	for _, absent := range []string{"image pull", "busybox", "inspect"} {
		if strings.Contains(argv, absent) {
			t.Errorf("infra --service ran needless step: %q in argv", absent)
		}
	}
}

func TestStartServiceBrowserNoClone(t *testing.T) {
	// "Just the browser": --service targets that never touch the repo run
	// without a KB clone (the main README's no-clone use case).
	s := newScenario(t, "container")
	s.noGitRoot = true
	stdout, stderr, code := s.run(t, "start", "--service", "browser")
	if code != 0 {
		t.Fatalf("want exit 0 outside a clone, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting Browser", "🚀 browser is up")
	// The git-clone invariant is scoped to /kb-mount flows: gateway still
	// requires a clone; a sidecar needs only the .semiont/ tree.
	if _, stderr, code := s.run(t, "start", "--service", "gateway"); code != 1 {
		t.Errorf("gateway without git: want exit 1, got %d", code)
	} else {
		mustContain(t, "stderr", stderr, "must be a git clone")
	}
	// The Archivist mounts /kb as the git WRITER (D4b), so it inherits the
	// same refusal — a non-clone would fail at its first `git add` instead.
	if _, stderr, code := s.run(t, "start", "--service", "archivist"); code != 1 {
		t.Errorf("archivist without git: want exit 1, got %d", code)
	} else {
		mustContain(t, "stderr", stderr, "must be a git clone")
	}
	// The Librarian mounts /kb READ-ONLY — not the git writer, so the clone
	// invariant deliberately does NOT apply (EXTRACT-LIBRARIAN handoff).
	if _, stderr, code := s.run(t, "start", "--service", "librarian"); code != 0 {
		t.Errorf("librarian without git: want exit 0 (read-only mount), got %d\nstderr:\n%s", code, stderr)
	}
}

// The Librarian restart path — the argv IS the contract: NO piece of the KB
// tree (SINGLE-KB-MOUNT P1), just the shared state mount, librarian.toml,
// 24104, and neither JWT_SECRET (it signs nothing) nor LIBRARIAN_HOST
// (nothing dials it). The staged config carries the committed [kb] name —
// the one fact the Librarian needs to find the Archivist's views.
func TestStartServiceLibrarian(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--service", "librarian")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting Librarian", "Librarian healthy (http://localhost:24104)")
	log := string(s.mustLog(t))
	mustContain(t, "argv", log,
		"--name semiont-librarian",
		"--publish 24104:24104",
		"librarian.toml:/home/semiont/.semiontconfig:ro",
		"state:/semiont-state",
		"--env SEMIONT_OIDC_CLIENT_ID=semiont-librarian")
	for _, banned := range []string{"JWT_SECRET", "LIBRARIAN_HOST", ":/kb", "anchored-text:"} {
		if strings.Contains(log, banned) {
			t.Errorf("the Librarian must not receive %s:\n%s", banned, log)
		}
	}
	// The staging wiring, asserted end to end: pull the stage dir back out of
	// the argv and read the file the container would. Boot refuses without
	// [kb] name, so a miss here is a librarian that never starts live.
	m := regexp.MustCompile(`--volume (\S+)/librarian\.toml:`).FindStringSubmatch(log)
	if m == nil {
		t.Fatalf("no staged librarian.toml in argv:\n%s", log)
	}
	staged, err := os.ReadFile(filepath.Join(m[1], "librarian.toml"))
	if err != nil {
		t.Fatalf("reading staged librarian.toml: %v", err)
	}
	mustContain(t, "staged librarian.toml", string(staged), "[kb]")
	if !regexp.MustCompile(`(?m)^name = ['"]Test Knowledge Base['"]$`).Match(staged) {
		t.Errorf("staged librarian.toml does not carry the committed [kb] name:\n%s", staged)
	}
}

// The Archivist restart path: teardown + port settle + staged config + run +
// health gate, like any sidecar — but with the gateway's mounts. The argv is
// the pin: /kb read-write, archivist.toml, the shared anchored-text store,
// and NO JWT_SECRET (it signs nothing).
func TestStartServiceArchivist(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--service", "archivist")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting Archivist", "Archivist healthy (http://localhost:24103)")
	log := string(s.mustLog(t))
	mustContain(t, "argv", log,
		"--name semiont-archivist",
		"--publish 24103:24103",
		":/kb",
		"archivist.toml:/home/semiont/.semiontconfig:ro",
		"anchored-text:/anchored-text",
		"--env SEMIONT_OIDC_CLIENT_ID=semiont-archivist")
	if strings.Contains(log, "JWT_SECRET") {
		t.Errorf("the Archivist must not receive JWT_SECRET — it signs nothing:\n%s", log)
	}
}

func TestStartServiceDryRunWorker(t *testing.T) {
	s := newScenario(t, "container")
	stdout, _, code := s.run(t, "start", "--service", "worker", "--dry-run")
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	mustContain(t, "stdout", stdout,
		"semiont start --service worker --dry-run",
		"container stop semiont-worker",
		"container image pull ghcr.io/the-ai-alliance/semiont-worker:latest",
		"<config-stage>/worker.toml",
		"wait: http://localhost:24100/health (30s)",
	)
	if strings.Contains(stdout, "semiont-neo4j") {
		t.Error("service plan leaked the wider stack")
	}
	// Dry run must execute nothing: worker needs only .semiont/ discovery
	// (pure Go), not the git-clone invariant (that's /kb-mount flows).
	if got := s.argv(t); got != "" {
		t.Errorf("dry-run executed commands:\n%s", got)
	}
}

func TestStartServiceRejections(t *testing.T) {
	s := newScenario(t, "container")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"start", "--service", "bogus"}, "Unknown --service 'bogus'"},
		{[]string{"start", "--service", "browser", "--config", "anthropic"}, "--config does not apply to --service browser"},
		{[]string{"start", "--service", "worker", "--no-observe"}, "--no-observe does not apply to --service"},
		{[]string{"start", "--service", "worker", "--ollama-cache", "host"}, "--ollama-cache only applies to --service inference."},
		{[]string{"start", "--service", "worker", "--list-configs"}, "--list-configs cannot be combined with --service."},
	} {
		_, stderr, code := s.run(t, tc.args...)
		if code != 1 {
			t.Errorf("%v: want exit 1, got %d", tc.args, code)
		}
		mustContain(t, fmt.Sprintf("stderr for %v", tc.args), stderr, tc.want)
	}
}

/*
 * TestStartServiceSecretUnreadableIsLoud stood here. Its subject was recovering
 * $SEMIONT_WORKER_SECRET out of a running container on a `--service` restart,
 * because that secret was generated per start and never persisted. Both halves
 * are gone: each service holds its own credential, persisted per root, so a
 * partial restart reads the same file the full start wrote and there is nothing
 * to recover.
 *
 * The property it protected — a restart must not silently substitute a
 * credential that breaks auth — is NOT fully re-covered. It now fails a
 * different way: deleting a per-root secret file makes the launcher generate
 * one the realm has never seen. Detecting that is `.plans/IDENTITY-PREFLIGHT.md`.
 */

// --- stop --service ---

func TestStopService(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	stage, err := os.MkdirTemp(s.stagingParent(), "semiont-config.")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(stage) })
	stdout, _, code := s.run(t, "stop", "--service", "weaver")
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	mustContain(t, "stdout", stdout,
		"Sweeping 1 container(s) across container, docker, podman",
		"weaver stopped (staged configs left in place; rest of the stack untouched).")
	if strings.Contains(stdout, "Semiont stack stopped.") {
		t.Error("--service printed the full-stack message")
	}
	if _, err := os.Stat(stage); err != nil {
		t.Errorf("--service stop removed the staged configs: %v", err)
	}
	argv := s.argv(t)
	for _, rt := range []string{"container", "docker", "podman"} {
		mustContain(t, "argv", argv, rt+" stop semiont-weaver", rt+" rm semiont-weaver")
	}
	if strings.Contains(argv, "semiont-gateway") {
		t.Error("--service weaver touched other containers")
	}
}

// --- status --service ---

func TestEmbeddingIsAnExternalRole(t *testing.T) {
	// embedding is a role, and its platform is external — so it participates
	// in status but supports no start/stop. Nothing about that is special to
	// embedding: it is what "external" means for any role.
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}

	// stop --service embedding: coherent request, nothing to stop, exit 0 —
	// and crucially NO stop/rm of an empty container name.
	before, _ := os.ReadFile(s.log)
	stdout, _, code := s.run(t, "stop", "--service", "embedding")
	if code != 0 {
		t.Fatalf("stop --service embedding: want exit 0, got %d", code)
	}
	mustContain(t, "stop stdout", stdout, "externally provided", "nothing to stop")
	after, _ := os.ReadFile(s.log)
	for _, line := range strings.Split(strings.TrimPrefix(string(after), string(before)), "\n") {
		if strings.Contains(line, "stop ") || strings.Contains(line, "rm ") {
			t.Errorf("stop --service embedding swept a container: %q", line)
		}
	}

	// The whole stack still stops, and embedding contributes no target.
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Errorf("stop: exit %d", code)
	}
	log, _ := os.ReadFile(s.log)
	if strings.Contains(string(log), "semiont-embedding") {
		t.Errorf("stop targeted a container embedding does not own:\n%s", log)
	}
}

func TestStopThenStartStaysLocal(t *testing.T) {
	// The sequence the launcher itself prescribes, from a real incident
	// (2026-07-20): stop the local stack, then start it again. `stop` forgets
	// the local record by design, and the codespace-resume convenience used
	// to key on nothing more than "no local record" — so this bare start
	// flipped to the cloud, swept the local containers in its preflight, and
	// woke a paid codespace. Standing in a KB clone must always mean local.
	s := newCodespaceScenario(t) // cwd IS a KB clone; a codespace is recorded
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("codespace start: exit %d\nstderr:\n%s", code, stderr)
	}
	// A local stack, then stop it — leaving exactly the state that misfired:
	// a codespace record present, no local record.
	if _, stderr, code := s.run(t, "start", "--runtime", "container"); code != 0 {
		t.Fatalf("local start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop", "--runtime", "container"); code != 0 {
		t.Errorf("stop --runtime container: exit %d", code)
	}

	before, _ := os.ReadFile(s.log)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("bare start after stop: exit %d\nstderr:\n%s", code, stderr)
	}
	if strings.Contains(stdout+stderr, "codespace") {
		t.Errorf("bare start inside a KB clone went to the cloud:\n%s\n%s", stdout, stderr)
	}
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	if strings.Contains(fresh, "gh codespace") {
		t.Errorf("bare start inside a KB clone reached for gh:\n%s", fresh)
	}
	if !strings.Contains(fresh, "run -d") {
		t.Errorf("bare start launched no local containers:\n%s", fresh)
	}
}

func TestBareResumeUsesRecordedRepoNotCwd(t *testing.T) {
	// Characterization, not a fix: outside any KB clone a bare start resumes
	// the RECORDED stack's repo, even when the cwd's git origin names a
	// different one. startCodespace's identity ladder already did this; the
	// 2026-07-20 incident adopted the wrong repo only because the branch fired
	// INSIDE a clone, where the ladder legitimately prefers the clone's origin
	// (see TestStopThenStartStaysLocal for the actual fix). Pinned so that
	// preference can never leak out to the no-clone case.
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("codespace start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop")
	}

	// Move outside any KB clone, into a directory whose git origin names a
	// DIFFERENT repo than the recorded stack.
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "FAKERT_GIT_ORIGIN=git@github.com:someone/unrelated.git")
	before := s.mustLog(t)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("bare resume: exit %d\nstderr:\n%s", code, stderr)
	}
	if strings.Contains(stdout+stderr, "someone/unrelated") {
		t.Errorf("bare resume targeted the cwd's repo, not the recorded stack:\n%s\n%s", stdout, stderr)
	}
	mustContain(t, "the codespace branch actually fired", stdout+stderr, "Using recorded stack's platform")
	mustContain(t, "resume names the recorded repo", stdout+stderr, csRepo)
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	if strings.Contains(fresh, "someone/unrelated") {
		t.Errorf("gh was pointed at the cwd's repo:\n%s", fresh)
	}
}

func TestStartPullsMissingOllamaModels(t *testing.T) {
	// The launcher brings Ollama up but used to leave its models to chance:
	// a configured model that was never pulled stayed invisible until a
	// worker reached for it mid-job and failed. Start now pulls what the
	// config asks Ollama to serve — and only that.
	pulls := func(s *scenario) string {
		b, _ := os.ReadFile(filepath.Join(s.fakertDir, "ollama-pulls"))
		return string(b)
	}

	// One model already present, one absent: pull exactly the absent one.
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_OLLAMA_TAGS=gemma4:26b")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	got := pulls(s)
	if !strings.Contains(got, "gemma4:e2b") || !strings.Contains(got, "nomic-embed-text") {
		t.Errorf("did not pull the missing models; pulled:\n%s", got)
	}
	if strings.Contains(got, "gemma4:26b") {
		t.Errorf("re-pulled a model Ollama already had:\n%s", got)
	}
	s.killServes(t) // else this fake Ollama looks like a HOST one to the next case

	// Ollama unlistable: we know NOTHING, so pull nothing. Blindly pulling
	// would re-download gigabytes the user already has.
	s2 := newScenario(t, "container")
	s2.extraEnv = append(s2.extraEnv, "FAKERT_OLLAMA_UNLISTABLE=1")
	if _, stderr, code := s2.run(t, "start"); code != 0 {
		t.Fatalf("start (unlistable): exit %d\nstderr:\n%s", code, stderr)
	}
	if got := pulls(s2); got != "" {
		t.Errorf("pulled while Ollama was unlistable — unknown is not missing:\n%s", got)
	}
	s2.killServes(t)

	// A failed pull warns but does not fail the stack: the rest is healthy
	// and the user may prefer to pull by hand.
	s3 := newScenario(t, "container")
	s3.extraEnv = append(s3.extraEnv, "FAKERT_OLLAMA_TAGS=", "FAKERT_OLLAMA_PULL_FAILS=1")
	stdout, stderr, code := s3.run(t, "start")
	if code != 0 {
		t.Fatalf("a failed model pull must not fail the stack: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "warning", stdout+stderr, "Could not pull", "ollama pull")
}

// A failed pull must name the ROLE that stops working, because that is what
// tells the user whether they care. inference and embedding are the roles;
// Ollama is merely the provider that happens to serve both here, so "jobs"
// (which only describes the worker pool) is wrong for the embedding model.
func TestFailedModelPullNamesTheAffectedRole(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_OLLAMA_TAGS=", "FAKERT_OLLAMA_PULL_FAILS=1")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("a failed model pull must not fail the stack: exit %d\nstderr:\n%s", code, stderr)
	}
	out := stdout + stderr

	// The default config serves gemma4:* for inference and nomic-embed-text
	// for embedding, so both roles appear and each must be named correctly.
	for _, want := range []string{
		"Could not pull nomic-embed-text — embedding will fail",
		"Could not pull gemma4:26b — inference will fail",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing role-named warning %q; got:\n%s", want, out)
		}
	}
	if strings.Contains(out, "jobs that use it") {
		t.Error("still says 'jobs that use it' — wrong for the embedding model, which the smelter needs, not the worker pool")
	}
}

func TestRemoteModelsAreNeverCheckedAgainstOllama(t *testing.T) {
	// The anthropic config runs every actor and worker on Claude while its
	// embedding runs on Ollama. The inference row's driver is therefore
	// "ollama" (that Ollama exists only to serve the embedding) but its
	// models are all remote. Checking them against Ollama reported
	// "MISSING — ollama pull claude-sonnet-4-5-…", advice that cannot work
	// (observed 2026-07-20).
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_OLLAMA_TAGS=nomic-embed-text:latest",
		"ANTHROPIC_API_KEY=test-key")
	if _, stderr, code := s.run(t, "start", "--config", "anthropic"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	// Nothing remote may be pulled.
	pulls, _ := os.ReadFile(filepath.Join(s.fakertDir, "ollama-pulls"))
	if strings.Contains(string(pulls), "claude") {
		t.Errorf("tried to pull a Claude into Ollama:\n%s", pulls)
	}

	stdout, _, _ := s.run(t, "status")
	for _, line := range strings.Split(stdout, "\n") {
		if strings.Contains(line, "claude") {
			if strings.Contains(line, "MISSING") || strings.Contains(line, "ollama pull") {
				t.Errorf("a remote model was checked against Ollama: %q", strings.TrimSpace(line))
			}
			if !strings.Contains(line, "remote") {
				t.Errorf("a remote model was not marked remote: %q", strings.TrimSpace(line))
			}
		}
	}
	// The rows say who really does what: inference is Anthropic (external —
	// Claude performs it), and the local Ollama belongs to embedding, the
	// role it exists to serve.
	mustContain(t, "inference row", stdout, "inference (Anthropic)", "external")
	mustContain(t, "embedding row", stdout, "embedding (Ollama)")
	if strings.Contains(stdout, "inference (Ollama)") {
		t.Errorf("inference row named Ollama under an all-Claude config:\n%s", stdout)
	}
	// The ollama-served embedding still gets a real install state.
	mustContain(t, "embedding model", stdout, "nomic-embed-text")

	// And stop still finds the embedding-owned Ollama container — the one
	// hazard of moving ownership off the inference role.
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ := os.ReadFile(s.log)
	if !strings.Contains(string(log), "stop fid-semiont-ollama") && !strings.Contains(string(log), "stop semiont-ollama") {
		t.Errorf("stop never targeted the embedding-owned Ollama container:\n%s", log)
	}
}

// serveAnthropicModels: a fake /v1/models on a local port, listing exactly
// the given ids. Reached via the config's [inference.anthropic] endpoint —
// the same override a proxy would use, so no launcher test-mode exists.
// serveAnthropicModels starts a fake /v1/models on an EPHEMERAL port and
// returns it. Fixed ports made these tests collide with anything else holding
// the number — observed in CI, not just locally — and the number was never
// meaningful: the launcher is told the endpoint by flag or config.
func serveAnthropicModels(t *testing.T, ids ...string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("no ephemeral port for models API simulation: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("x-api-key") == "" || r.Header.Get("anthropic-version") == "" {
			http.Error(w, "missing headers", 401)
			return
		}
		type m struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
			CreatedAt   string `json:"created_at"`
			MaxInput    int    `json:"max_input_tokens"`
		}
		var data []m
		for _, id := range ids {
			data = append(data, m{ID: id, DisplayName: "Claude " + id, CreatedAt: "2025-09-29T00:00:00Z", MaxInput: 200000})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

func TestRemoteModelMetadataAndAvailability(t *testing.T) {
	// /v1/models is the remote analog of Ollama's /api/tags: identity
	// metadata for listed models, and — the actionable part — a configured
	// model NOT listed for this key (withdrawn, or a typo) is called out at
	// start and marked in status, instead of surfacing as a failed job.
	anthPort := serveAnthropicModels(t, "claude-sonnet-4-5-20250929") // haiku deliberately absent
	s := newScenario(t, "container")
	writeKBConfig(t, s, "anthropic-meta",
		stdGraph+stdVectors+stdDatabase+stdEmbedding+
			fmt.Sprintf("[environments.local.inference.anthropic]\nplatform = \"external\"\nendpoint = \"http://localhost:%d\"\napiKey = \"${ANTHROPIC_API_KEY}\"\n\n", anthPort)+
			"[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-sonnet-4-5-20250929\"\n\n"+
			"[environments.local.workers.tag.inference]\ntype = \"anthropic\"\nmodel = \"claude-haiku-4-5-20251001\"\n\n")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	stdout, stderr, code := s.run(t, "start", "--config", "anthropic-meta")
	if code != 0 {
		t.Fatalf("start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "start warning", stdout+stderr,
		"claude-haiku-4-5-20251001 is not listed for this API key")

	// status renders recorded metadata without the key in its env…
	stdout, _, _ = s.run(t, "status")
	mustContain(t, "status", stdout,
		"Claude claude-sonnet-4-5-20250929", "200K ctx", "2025-09", "remote",
		"NOT AVAILABLE")
	// …and never fabricates an install state for a remote model.
	if strings.Contains(stdout, "ollama pull claude") {
		t.Errorf("remote model offered an ollama pull:\n%s", stdout)
	}
}

// --- semantic search is mandatory (MANDATORY-EMBEDDING P4) ---

// A config the gateway refuses to boot must be refused HERE, before a single
// container is launched. Otherwise start brings the whole stack up and the
// gateway dies seconds later on a file the launcher already had in its hands.
func TestStartRefusesAConfigWithNoSemanticSearch(t *testing.T) {
	for _, c := range []struct {
		name  string
		body  string
		wants []string
	}{
		{
			"no-vectors",
			stdGraph + stdEmbedding + stdDatabase,
			[]string{"names no vector store", "[environments.local.vectors]", "nothing is defaulted"},
		},
		{
			"no-embedding",
			stdGraph + stdVectors + stdDatabase,
			[]string{"names no embedding provider", "[environments.local.embedding]", "nothing is defaulted"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := newScenario(t, "container")
			writeKBConfig(t, s, c.name, c.body)
			stdout, stderr, code := s.run(t, "start", "--config", c.name)
			if code == 0 {
				t.Fatalf("start accepted a config the gateway refuses to boot\nstdout:\n%s", stdout)
			}
			mustContain(t, "refusal", stdout+stderr, c.wants...)
			// The refusal must precede every runtime invocation — root
			// discovery (a git rev-parse) is all that legitimately runs
			// before the config is read.
			for _, line := range strings.Split(strings.TrimSpace(s.argv(t)), "\n") {
				if line == "" || strings.HasPrefix(strings.TrimSpace(line), "git ") {
					continue
				}
				t.Errorf("a refused config reached the container runtime: %q", strings.TrimSpace(line))
			}
		})
	}
}

// --- platform-sourced inference ceilings (INFERENCE-LIMITS-EXPOSURE P4) ---

// The ceilings status prints come from the PLATFORM — the limits the services
// holding the inference credentials report over the bus (job:, gather: and
// match:limits-requested), the same requests every other client makes — never
// from a direct provider probe. mustNotContain is spelled out here because "no
// ceiling" is the whole assertion in three of these tests.
func mustNotContain(t *testing.T, label, haystack string, needles ...string) {
	t.Helper()
	for _, n := range needles {
		if strings.Contains(haystack, n) {
			t.Errorf("%s must not contain %q; full text:\n%s", label, n, haystack)
		}
	}
}

// limitsReply scripts the worker's job:limits-result payload: the pairs it
// reports, each with the limits it discovered.
func limitsReply(pairs ...string) string {
	return `FAKERT_BUS_REPLY_job_limits_requested={"limits":[` + strings.Join(pairs, ",") + `]}`
}

func reportedPair(provider, model, limits string) string {
	return fmt.Sprintf(`{"provider":"%s","model":"%s","limits":%s}`, provider, model, limits)
}

func TestStatusShowsPlatformCeilings(t *testing.T) {
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(
			reportedPair("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`),
			reportedPair("ollama", "nomic-embed-text", `{"contextTokens":8000,"maxOutputTokens":8000}`),
		))
	stdout, stderr, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// Both rows carry the ceiling the platform discovered for THAT model.
	for _, line := range strings.Split(stdout, "\n") {
		switch {
		case strings.Contains(line, "gemma4:26b"):
			mustContain(t, "inference model row", line, "128K window")
		case strings.Contains(line, "nomic-embed-text"):
			mustContain(t, "embedding model row", line, "8K window")
		}
	}
	mustContain(t, "ceilings", stdout, "128K window", "8K window")

	// Sourced over the bus, from every key holder — not by probing a
	// provider. (D5: platform data flows through the platform surface.)
	for _, op := range []string{"job:limits-requested", "gather:limits-requested", "match:limits-requested"} {
		found := false
		for _, e := range emits(t, s) {
			if strings.Contains(e, `"channel":"`+op+`"`) {
				found = true
				mustContain(t, op, e, `"correlationId"`)
			}
		}
		if !found {
			t.Errorf("status never asked %s:\n%s", op, strings.Join(emits(t, s), "\n"))
		}
	}
}

func TestStatusCeilingsNeedASession(t *testing.T) {
	// Same started stack, only the credential removed: no session means no
	// report, and a row without a ceiling is exactly today's row — no error,
	// no placeholder. (Ignorance is not a finding.)
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(reportedPair("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`)))
	if _, stderr, code := s.run(t, "logout"); code != 0 {
		t.Fatalf("logout: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, stderr, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "model row still renders", stdout, "gemma4:26b", "installed")
	mustNotContain(t, "status without a session", stdout, "window", " in / ")
}

func TestStatusCeilingsSurviveRejectedReports(t *testing.T) {
	// The key holders answering on their failure channels is the same
	// non-answer as silence: rows render as today, and status still exits on health alone.
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		"FAKERT_BUS_FAIL=directory unavailable")
	stdout, stderr, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("rejected reports must not fail status: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "model row still renders", stdout, "gemma4:26b", "installed")
	mustNotContain(t, "status with rejected reports", stdout, "window", " in / ", "directory unavailable")
}

func TestStatusCeilingsAbsentWhenNoKeyHolderReportsThem(t *testing.T) {
	// D3's absence semantics reach all the way to the terminal: a pair whose
	// discovery failed is absent from its key holder's report, and its row is
	// unchanged.
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(
			reportedPair("ollama", "nomic-embed-text", `{"contextTokens":8000,"maxOutputTokens":8000}`),
		))
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	for _, line := range strings.Split(stdout, "\n") {
		if strings.Contains(line, "gemma4:26b") {
			mustNotContain(t, "row for an entry without limits", line, "window", " in / ")
		}
	}
	// …while the sibling that DID discover still shows its ceiling.
	mustContain(t, "sibling row", stdout, "8K window")
}

// mixedStackScenario: a started, logged-in stack whose inference is Anthropic
// (against a local fake /v1/models, so nothing leaves the machine). This is
// the shape where a ceiling keyed off the row's driver rather than the model's
// own provider would be wrong.
func mixedStackScenario(t *testing.T, env ...string) *scenario {
	t.Helper()
	anthPort := serveAnthropicModels(t, "claude-sonnet-4-5-20250929")
	s := newScenario(t, "container")
	writeKBConfig(t, s, "mixed",
		stdGraph+stdVectors+stdDatabase+stdEmbedding+
			fmt.Sprintf("[environments.local.inference.anthropic]\nplatform = \"external\"\nendpoint = \"http://localhost:%d\"\napiKey = \"${ANTHROPIC_API_KEY}\"\n\n", anthPort)+
			"[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-sonnet-4-5-20250929\"\n\n")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	s.extraEnv = append(s.extraEnv, env...)
	if _, stderr, code := s.run(t, "start", "--config", "mixed"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "login"); code != 0 {
		t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
	}
	return s
}

func TestStatusNeverShowsACrossProviderCeiling(t *testing.T) {
	// A key holder reports OLLAMA serving a Claude. The row's model is Anthropic's,
	// so the keys do not meet and no ceiling is printed. A ceiling matched on
	// the model NAME alone would have printed one here — a wrong number, which
	// is worse than a missing one.
	s := mixedStackScenario(t,
		limitsReply(reportedPair("ollama", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`)))
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "model row still renders", stdout, "claude-sonnet-4-5-20250929", "remote")
	mustNotContain(t, "cross-provider report", stdout, "window", " in / ")
}

func TestStatusShowsARemoteCeilingInAnOllamaDrivenRow(t *testing.T) {
	// Workers default to Anthropic while one job type runs on Ollama, so the
	// inference row's driver is ollama and lists Claude beside gemma. Each
	// binding names its provider, so each model's ceiling is keyed by its own
	// provider, not by the row's (found live 2026-09-29: Claude's row was
	// bare although the worker reported its limits).
	anthPort := serveAnthropicModels(t, "claude-sonnet-4-5-20250929")
	s := newScenario(t, "container")
	writeKBConfig(t, s, "mixed-ollama",
		stdGraph+stdVectors+stdDatabase+stdEmbedding+
			fmt.Sprintf("[environments.local.inference.anthropic]\nplatform = \"external\"\nendpoint = \"http://localhost:%d\"\napiKey = \"${ANTHROPIC_API_KEY}\"\n\n", anthPort)+
			"[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-sonnet-4-5-20250929\"\n\n"+
			"[environments.local.workers.highlight-annotation.inference]\ntype = \"ollama\"\nmodel = \"gemma4:26b\"\n\n")
	s.extraEnv = append(s.extraEnv,
		"ANTHROPIC_API_KEY=test-key",
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(
			reportedPair("anthropic", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`),
			reportedPair("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`),
		))
	if _, stderr, code := s.run(t, "start", "--config", "mixed-ollama"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "login"); code != 0 {
		t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "inference row", stdout, "inference (Ollama)")
	for _, line := range strings.Split(stdout, "\n") {
		switch {
		case strings.Contains(line, "claude-sonnet-4-5-20250929"):
			mustContain(t, "Claude's row", line, "remote", "200K in / 64K out")
		case strings.Contains(line, "gemma4:26b"):
			mustContain(t, "gemma's row", line, "installed", "128K window")
		}
	}
}

func TestStatusPlatformCeilingReplacesTheProbedWindow(t *testing.T) {
	// The launcher's own /v1/models probe renders "200K ctx" today. Once the
	// platform publishes the ceiling, THAT is the one on the row — one context
	// figure, from the platform (D5), never two from two sources. The probe
	// keeps rendering what only it knows (identity, release, key visibility).
	s := mixedStackScenario(t,
		limitsReply(reportedPair("anthropic", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`)))
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "ceiling", stdout, "200K in / 64K out",
		"Claude claude-sonnet-4-5-20250929", "2025-09", "remote")
	mustNotContain(t, "probed context window", stdout, "200K ctx")
}

func TestBareStopFollowsCwd(t *testing.T) {
	// Standing in the clone whose stack is running, a bare stop means THAT
	// stack — demanding --runtime container restated what the prompt already
	// said (observed 2026-07-20). The rule is the start-side one: a KB clone
	// is explicit context.
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("codespace start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "start", "--runtime", "container"); code != 0 {
		t.Fatalf("local start: exit %d\nstderr:\n%s", code, stderr)
	}

	// useradd from the clone picks the LOCAL stack: no ssh, and no exec either
	// — a local realm is administered from here.
	before := s.mustLog(t)
	s.run(t, "useradd", "--email", "a@b.co", "--generate-password")
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	if strings.Contains(fresh, "gh codespace") {
		t.Errorf("bare useradd in the local clone went to the codespace:\n%s", fresh)
	}
	if strings.Contains(fresh, "semiont-useradd") {
		t.Errorf("the local path still execs the gateway's bin:\n%s", fresh)
	}

	// stop from the clone: the local stack, codespace untouched and still
	// recorded.
	before = s.mustLog(t)
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("bare stop in clone: exit %d\nstderr:\n%s", code, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	if strings.Contains(fresh, "gh codespace stop") {
		t.Errorf("bare stop in the local clone stopped the codespace:\n%s", fresh)
	}
	mustContain(t, "stop argv", fresh, "stop")
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json keeps the codespace", string(b), "codespace:"+csRepo)

	// With the local stack gone and TWO codespaces recorded, the clone's
	// origin picks — from a neutral directory it still refuses.
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_CS_NAME=bar-cs-1")
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace", "--repo", "other/bar"); code != 0 {
		t.Fatalf("second codespace: exit %d\nstderr:\n%s", code, stderr)
	}
	before = s.mustLog(t)
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("bare stop via origin: exit %d\nstderr:\n%s", code, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "origin-picked stop", fresh, "gh codespace stop -c fake-cs-1")
	if strings.Contains(fresh, "bar-cs-1") {
		t.Errorf("origin pick touched the other repo's codespace:\n%s", fresh)
	}
}

func TestFailedGateDumpsContainerLogs(t *testing.T) {
	// When a health gate fails, the crash cause is usually sitting in the
	// container's own logs — a friction log spent most of a day on an errno
	// -35 that was in `logs` for the whole 120s wait while the launcher said
	// only "did not become ready". The gate failure now shows the tail.
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_SKIP_SERVE=6333") // vectors: up but never listens
	stdout, stderr, code := s.run(t, "start")
	if code != 1 {
		t.Fatalf("start with a dead vectors should fail: exit %d", code)
	}
	all := stdout + stderr
	mustContain(t, "gate failure output", all,
		"vectors (Qdrant) did not become ready",
		"of semiont-qdrant's logs:",
		"qdrant out", // fakert's `logs` stdout — proof the tail is the container's own
		"qdrant err",
		"Full logs:  semiont logs --service vectors")
}

func TestCrashedContainerStaysInspectable(t *testing.T) {
	// The other half of the failed-gate story (friction log issue 5): a
	// container that CRASHED during the gate used to be gone — --rm took the
	// container, its console output, and its log files with it, and
	// `<rt> logs` answered "No such container". Service containers now run
	// without --rm: the crashed container remains, dumpLogs works on it, and
	// the next start's preflight (or stop) sweeps it.
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	argv := s.argv(t)
	for _, line := range strings.Split(argv, "\n") {
		if strings.Contains(line, "run -d") && strings.Contains(line, "semiont-") {
			if strings.Contains(line, "--rm") {
				t.Errorf("service container launched with --rm — a crash would destroy its logs: %q", line)
			}
		}
		// One-shot probes stay ephemeral: they produce no diagnostics worth
		// keeping and would otherwise pile up.
		if strings.Contains(line, "busybox") && !strings.Contains(line, "--rm") {
			t.Errorf("busybox probe lost its --rm: %q", line)
		}
	}
}

func TestCodespaceCostLevers(t *testing.T) {
	// Explicit flags override the launcher defaults at create; on a resume
	// they are inert and say so (settings are create-time), like --machine.
	s := newCodespaceScenario(t)
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace",
		"--idle-timeout", "15m", "--retention-period", "48h")
	if code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "argv", s.argv(t), "--idle-timeout 15m --retention-period 48h")
	mustContain(t, "announcement", stdout+stderr, "auto-stop after 15m idle", "48h", "AUTO-DELETED")

	// Resume: the flags cannot apply and must be called out, not look effective.
	stdout, stderr, _ = s.run(t, "start", "--runtime", "codespace", "--idle-timeout", "5m")
	mustContain(t, "inert warning", stdout+stderr, "--idle-timeout/--retention-period ignored")

	// And outside codespace placement they are refused, like --repo.
	if _, stderr, code := s.run(t, "start", "--runtime", "container", "--idle-timeout", "5m"); code != 1 {
		t.Fatalf("local start with codespace flag: want exit 1")
	} else {
		mustContain(t, "refusal", stderr, "only apply to --runtime codespace")
	}
}

func TestCodespaceCostFacts(t *testing.T) {
	// Tier 1 of CODESPACE-COSTS: status states the hardware burning and
	// since when — facts only, never invented dollars. Available shows
	// machine + uptime; Shutdown shows when storage billing ENDS by
	// auto-deletion; the up-summary names the machine and its auto-stop.
	s := newCodespaceScenario(t)
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "up-summary", stdout+stderr, "Machine premiumLinux 8c/32GB", "auto-stops after 60m idle")

	stdout, _, _ = s.run(t, "roots")
	mustContain(t, "catalog (Available)", stdout,
		"Available · premiumLinux 8c/32GB · up 2h")

	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatal("stop")
	}
	stdout, _, _ = s.run(t, "roots")
	mustContain(t, "catalog (Shutdown)", stdout,
		"storage still bills; auto-deletes 2026-08-19, state and all")
	if strings.Contains(stdout, "up 2h") {
		t.Errorf("a stopped codespace claimed uptime:\n%s", stdout)
	}
	// And no dollar figure is ever invented.
	if strings.Contains(stdout, "$") {
		t.Errorf("status printed a dollar figure it cannot know:\n%s", stdout)
	}
}

func TestStatusBilling(t *testing.T) {
	// Tier 2 (CODESPACE-COSTS): GitHub's OWN usage report, opt-in. Their
	// numbers verbatim — quantities, gross, quota-as-discount, net — never a
	// launcher estimate; non-codespaces products filtered out; the month
	// that actually cost money shows its net.
	s := newScenario(t, "container", "gh")
	stdout, stderr, code := s.run(t, "status", "--billing")
	if code != 0 {
		t.Fatalf("--billing: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "billing", stdout,
		"CODESPACES BILLING",
		"2026-01", "44.3 compute-hrs", "net $15.69",
		"2026-07", "net $0.00", "semiont-template-kb")
	if strings.Contains(stdout, "Copilot") || strings.Contains(stdout, "copilot") {
		t.Errorf("a non-codespaces product leaked into the codespaces report:\n%s", stdout)
	}

	// Without the scope: exactly the fix, nothing invented.
	s2 := newScenario(t, "container", "gh")
	s2.extraEnv = append(s2.extraEnv, "FAKERT_GH_BILLING_NOSCOPE=1")
	stdout, stderr, code = s2.run(t, "status", "--billing")
	if code != 1 {
		t.Fatalf("scope-less --billing: want exit 1, got %d", code)
	}
	mustContain(t, "scope fix", stdout+stderr, "gh auth refresh -h github.com -s user")
	if strings.Contains(stdout+stderr, "$") {
		t.Errorf("scope-less billing printed money:\n%s\n%s", stdout, stderr)
	}

	// Unauthenticated gh: its own guidance must reach the user, plus ours —
	// capture-stdout-only used to swallow gh's "please run gh auth login".
	s3 := newScenario(t, "container", "gh")
	s3.extraEnv = append(s3.extraEnv, "FAKERT_GH_UNAUTH=1")
	stdout, stderr, code = s3.run(t, "status", "--billing")
	if code != 1 {
		t.Fatalf("unauthenticated --billing: want exit 1, got %d", code)
	}
	mustContain(t, "unauth guidance", stdout+stderr, "gh auth login", "is gh authenticated?")

	// --billing is standalone: GitHub bills per month/repo, not per stack.
	if _, stderr, code := s.run(t, "status", "--billing", "--repo", "a/b"); code != 1 {
		t.Fatal("billing+repo should refuse")
	} else {
		mustContain(t, "refusal", stderr, "standalone")
	}
}

func TestDiscoveryFileTracksStacks(t *testing.T) {
	// BROWSER-KB-DISCOVERY lane 1: the export view rides every stack
	// mutation — local start, codespace start, delete — and is endpoints
	// only, never a secret. The Browser mounts its directory read-only.
	s := newCodespaceScenario(t)
	disc := func() string {
		b, _ := os.ReadFile(filepath.Join(stateHomeFor(s.home), "discovery", "kbs.json"))
		return string(b)
	}

	if _, stderr, code := s.run(t, "start", "--runtime", "container"); code != 0 {
		t.Fatalf("local start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "local entry", disc(),
		`"host": "localhost"`, `"port": 4000`, `"placement": "local"`,
		`"did": "did:web:example.github.io:test-kb"`, `"siteName": "Test Knowledge Base"`,
		`"managedBy": "semiont-launcher"`)
	// The Browser mounts the directory, read-only.
	mustContain(t, "browser mount", s.argv(t), asThisSystemRuns("-v <state-home>/discovery:/discovery:ro"))

	// Codespace start adds its forward (local holds 4000 → allocated 4001).
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("codespace start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "codespace entry", disc(),
		`"port": 4001`, `"placement": "codespace"`, `"repo": "pingel-org/foo-kb"`)

	// Secrets never travel: the view is endpoints and identity only.
	for _, banned := range []string{"password", "op://", "apiKey", "secret"} {
		if strings.Contains(disc(), banned) {
			t.Errorf("discovery view leaked %q:\n%s", banned, disc())
		}
	}

	// Deleting the codespace stack removes its entry; the local one remains.
	if _, _, code := s.run(t, "stop", "--repo", csRepo, "--delete"); code != 0 {
		t.Fatal("delete")
	}
	if strings.Contains(disc(), "codespace") {
		t.Errorf("deleted stack still advertised:\n%s", disc())
	}
	mustContain(t, "local survives", disc(), `"placement": "local"`)

	// Stopping the last stack leaves an EMPTY list — an absent file is
	// ambiguous; an empty list says the launcher manages nothing.
	if _, _, code := s.run(t, "stop", "--runtime", "container"); code != 0 {
		t.Fatal("local stop")
	}
	mustContain(t, "empty view", disc(), `"kbs": []`)
}

func TestDiscoveryOneEntryPerAddress(t *testing.T) {
	// KB-IDENTITY-VS-ADDRESS P1. A published entry is a promise about what
	// lives at an address, and only one process can bind a port — so two
	// entries claiming one address means at most one promise is true. Live
	// 2026-07-24: a local stack on :4000 and a codespace forward record that
	// still claimed :4000 were both published, and the Browser rendered the
	// user's own KB under the other repo's name.
	//
	// The sequence below is the one that produced it, start to finish:
	// dropCollidingForwards kills a forward the local stack needs and zeroes
	// its PID, but KEEPS ForwardPort — so the resolver itself leaves the
	// record shape the writer published as a live address.
	s := newCodespaceScenario(t)
	discPath := filepath.Join(stateHomeFor(s.home), "discovery", "kbs.json")
	entries := func(t *testing.T) []struct {
		Port      int    `json:"port"`
		Placement string `json:"placement"`
		Repo      string `json:"repo"`
	} {
		t.Helper()
		var doc struct {
			Kbs []struct {
				Port      int    `json:"port"`
				Placement string `json:"placement"`
				Repo      string `json:"repo"`
			} `json:"kbs"`
		}
		b, err := os.ReadFile(discPath)
		if err != nil {
			t.Fatalf("discovery view: %v", err)
		}
		if err := json.Unmarshal(b, &doc); err != nil {
			t.Fatalf("discovery view is not valid JSON: %v\n%s", err, b)
		}
		return doc.Kbs
	}

	// The codespace forward takes :4000 first — nothing else holds it.
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("codespace start: exit %d\nstderr:\n%s", code, stderr)
	}
	if got := entries(t); len(got) != 1 || got[0].Port != 4000 || got[0].Placement != "codespace" {
		t.Fatalf("want the forward published on :4000, got %+v", got)
	}

	// The local stack now needs :4000. The forward is dropped for it — and
	// after this, exactly one thing answers there.
	if _, stderr, code := s.run(t, "start", "--runtime", "container"); code != 0 {
		t.Fatalf("local start: exit %d\nstderr:\n%s", code, stderr)
	}
	got := entries(t)
	claims := 0
	for _, e := range got {
		if e.Port == 4000 {
			claims++
			if e.Placement != "local" {
				t.Errorf("the stack that actually holds :4000 must be the one published, got %+v", e)
			}
		}
	}
	if claims != 1 {
		t.Errorf("want exactly one entry claiming :4000, got %d:\n%+v", claims, got)
	}

	// Stopping the local stack frees the address, but the dropped forward is
	// not running either — its record still carries the port. An address
	// nothing is serving must not be advertised as reachable.
	if _, stderr, code := s.run(t, "stop", "--runtime", "container"); code != 0 {
		t.Fatalf("local stop: exit %d\nstderr:\n%s", code, stderr)
	}
	for _, e := range entries(t) {
		if e.Port == 4000 {
			t.Errorf("a dropped forward is still advertised at :4000:\n%+v", entries(t))
		}
	}
}

func TestDiscoveryPublishesOneKBInTwoPlaces(t *testing.T) {
	// A did identifies a KNOWLEDGE BASE, not a running copy of one, so two
	// entries sharing a did is normal and will be COMMON: a local clone and a
	// codespace of the same repo are one KB reachable at two addresses. The
	// address is what is unique (P1); the identity deliberately is not.
	//
	// This pins the launcher against the tempting inverse — "one entry per
	// identity" — which would silently hide whichever copy lost the tie, and
	// against a consumer assuming did is a primary key.
	s := newCodespaceScenario(t)
	// The codespace's committed identity is the SAME KB as the local clone.
	s.extraEnv = append(s.extraEnv,
		"FAKERT_GH_KBCONFIG=[site]\ndomain = \"example.github.io:test-kb\"\n")

	if _, stderr, code := s.run(t, "start", "--runtime", "container"); code != 0 {
		t.Fatalf("local start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("codespace start: exit %d\nstderr:\n%s", code, stderr)
	}

	var doc struct {
		Kbs []struct {
			Port      int    `json:"port"`
			Placement string `json:"placement"`
			Did       string `json:"did"`
		} `json:"kbs"`
	}
	b, err := os.ReadFile(filepath.Join(stateHomeFor(s.home), "discovery", "kbs.json"))
	if err != nil {
		t.Fatalf("discovery view: %v", err)
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("discovery view: %v\n%s", err, b)
	}
	const did = "did:web:example.github.io:test-kb"
	byPlacement := map[string]int{}
	for _, e := range doc.Kbs {
		if e.Did != did {
			t.Errorf("entry does not carry the shared identity: %+v", e)
		}
		byPlacement[e.Placement] = e.Port
	}
	if len(doc.Kbs) != 2 {
		t.Fatalf("one KB in two places must publish two entries, got %d:\n%s", len(doc.Kbs), b)
	}
	if byPlacement["local"] == 0 || byPlacement["codespace"] == 0 {
		t.Errorf("want both a local and a codespace entry, got %+v", doc.Kbs)
	}
	if byPlacement["local"] == byPlacement["codespace"] {
		t.Errorf("two copies of one KB must still hold distinct addresses: %+v", doc.Kbs)
	}
}

func TestBrowserOutlivesTheStack(t *testing.T) {
	// BROWSER-LIFECYCLE P2: the Browser is a machine-level viewer, not a
	// stack member. Start ensures it; a second start with a current image
	// KEEPS it; bare stop leaves it running (announced); a stale image is
	// restarted; --service browser is the explicit off-switch.
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	// The record is machine-level, not a stack service. Asserted on the
	// PARSED shape, not a substring: before the rename the two could be told
	// apart by name alone (machine-level "browser" vs the stack service
	// "frontend"), and once both are "browser" a substring check cannot say
	// WHERE it appeared — it would pass while the Browser sat in the wrong
	// place, or contradict itself.
	rec, _ := os.ReadFile(statePathFor(s.home))
	var placement struct {
		Browser *json.RawMessage `json:"browser"`
		Stacks  map[string]struct {
			Services map[string]json.RawMessage `json:"services"`
		} `json:"stacks"`
	}
	if err := json.Unmarshal(rec, &placement); err != nil {
		t.Fatalf("stack.json: %v", err)
	}
	if placement.Browser == nil {
		t.Errorf("no machine-level browser record:\n%s", rec)
	}
	if _, wrong := placement.Stacks["local"].Services["browser"]; wrong {
		t.Errorf("browser recorded as a stack service:\n%s", rec)
	}
	// The stack's port claims must NOT include the Browser's 3000 — stop
	// verifies release of stack ports, and the Browser keeps running.
	// Assert on the PARSED claims, not a raw substring: a nanosecond
	// startedAt containing "3000" flaked this in CI (run 29972367456).
	var claims struct {
		Stacks map[string]struct {
			Ports []int `json:"ports"`
		} `json:"stacks"`
	}
	if err := json.Unmarshal(rec, &claims); err != nil {
		t.Fatalf("stack.json: %v", err)
	}
	for _, p := range claims.Stacks["local"].Ports {
		if p == 3000 {
			t.Errorf("browser port recorded among the stack's claims:\n%s", rec)
		}
	}

	// Bare stop: stack down, Browser untouched and announced. Slice the
	// argv to THIS command — start's own restart branch legitimately
	// stop/rm's a stale browser earlier in the log.
	preStop := s.mustLog(t)
	stdout, stderr, code := s.run(t, "stop", "--runtime", "container")
	if code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop stdout", stdout, "Browser still running", "semiont stop --service browser")
	if stopArgv := strings.TrimPrefix(string(s.mustLog(t)), string(preStop)); strings.Contains(stopArgv, "semiont-browser") {
		t.Errorf("bare stop touched the Browser:\n%s", stopArgv)
	}
	rec, _ = os.ReadFile(statePathFor(s.home))
	mustContain(t, "browser record survives the stack record", string(rec), `"browser"`)

	// Second start with the SAME image running: keep, don't churn. The fake
	// runtime reports the reference the launcher would run.
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_browser=running",
		"FAKERT_IMAGE_browser=ghcr.io/the-ai-alliance/semiont-browser:latest")
	before := s.mustLog(t)
	stdout, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstderr:\n%s", code, stderr)
	}
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "keep message", stdout+stderr, "Browser already running")
	if strings.Contains(fresh, "run -d --name semiont-browser") {
		t.Errorf("current Browser was churned:\n%s", fresh)
	}

	// Stale image (reference differs): restart.
	for i, e := range s.extraEnv {
		if strings.HasPrefix(e, "FAKERT_IMAGE_browser=") {
			s.extraEnv[i] = "FAKERT_IMAGE_browser=ghcr.io/the-ai-alliance/semiont-browser:old"
		}
	}
	if _, _, code := s.run(t, "stop", "--runtime", "container"); code != 0 {
		t.Fatal("interim stop")
	}
	before = s.mustLog(t)
	stdout, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("stale-image start: exit %d\nstderr:\n%s", code, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	if !strings.Contains(fresh, "run -d --name semiont-browser") {
		t.Errorf("stale Browser was not restarted:\n%s", fresh)
	}

	// The explicit off-switch stops it and clears the record.
	stdout, _, code = s.run(t, "stop", "--service", "browser")
	if code != 0 {
		t.Fatalf("stop --service browser: exit %d", code)
	}
	mustContain(t, "off-switch", stdout, "Browser stopped")
	rec, _ = os.ReadFile(statePathFor(s.home))
	if strings.Contains(string(rec), `"browser"`) {
		t.Errorf("browser record survived its explicit stop:\n%s", rec)
	}
}

// --- semiont init (LAUNCHER-BIRTH P1) ---

func TestInitBirthsIdentity(t *testing.T) {
	// Flag-driven birth, prompt-free: .semiont/config carries the exact
	// identity, git init + stage happen, the root registers, and a second
	// init refuses without --force.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	stdout, stderr, code := s.run(t, "init",
		"--name", "family-kb", "--domain", "pingel-org.github.io:family-kb",
		"--site-name", "Family KB", "--yes")
	if code != 0 {
		t.Fatalf("init: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	cfg, err := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config"))
	if err != nil {
		t.Fatalf(".semiont/config not written: %v", err)
	}
	mustContain(t, ".semiont/config", string(cfg),
		`name = "family-kb"`,
		`domain = "pingel-org.github.io:family-kb"`,
		`siteName = "Family KB"`,
		`sync = true`)
	// Two fields the fleet's KBs do not carry, so a born KB must not either:
	// `version` is bumped by nothing, and `adminEmail` reaches no reader.
	for _, dead := range []string{"version =", "adminEmail"} {
		if strings.Contains(string(cfg), dead) {
			t.Errorf("init wrote %q — the fleet's committed configs carry neither:\n%s", dead, cfg)
		}
	}
	// The launcher runs git with -C <dir>; assert the subcommands.
	mustContain(t, "argv", s.argv(t), " init", " add .semiont")
	roots, _ := os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json", string(roots), "family-kb")

	// Refuse a second birth without --force — .semiont/ is not overwritable
	// by accident.
	_, stderr, code = s.run(t, "init", "--name", "x", "--domain", "d:x", "--yes")
	if code != 1 {
		t.Fatalf("re-init without --force: want exit 1, got %d", code)
	}
	mustContain(t, "refusal", stderr, "--force")
}

func TestInitIdentityLadderAndRefusals(t *testing.T) {
	// The did:web ladder: --domain wins; else derived from the git origin by
	// THE SAME RULE as template-init.yml step 6 (<owner_lc>.github.io:<name>);
	// else --yes REFUSES — permanent identity has no safe default.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "FAKERT_GIT_ORIGIN=git@github.com:Pingel-Org/family-kb.git")
	stdout, stderr, code := s.run(t, "init", "--name", "family-kb", "--yes")
	if code != 0 {
		t.Fatalf("origin-derived init: exit %d\nstderr:\n%s", code, stderr)
	}
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config"))
	// Owner lowercased (Pages hosts are lowercase); repo name kept as-is.
	mustContain(t, "derived did", string(cfg), `domain = "pingel-org.github.io:family-kb"`)
	mustContain(t, "derivation announced", stdout+stderr, "pingel-org.github.io:family-kb")

	// No --domain, no origin, --yes: refuse and say why.
	s2 := newScenario(t, "container")
	s2.cwd = t.TempDir()
	_, stderr, code = s2.run(t, "init", "--name", "x", "--yes")
	if code != 1 {
		t.Fatalf("identity-less --yes: want exit 1, got %d", code)
	}
	mustContain(t, "identity refusal", stderr, "permanent", "--domain")
}

func TestInitNoGitAndDryRun(t *testing.T) {
	// --no-git: sync=false, consequences stated, no git in the argv.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	stdout, stderr, code := s.run(t, "init", "--name", "x", "--domain", "d.io:x", "--yes", "--no-git")
	if code != 0 {
		t.Fatalf("init --no-git: exit %d\nstderr:\n%s", code, stderr)
	}
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config"))
	mustContain(t, "config", string(cfg), `sync = false`)
	mustContain(t, "consequences", stdout+stderr, "--no-git")
	for _, line := range strings.Split(s.argv(t), "\n") {
		if strings.HasPrefix(line, "git ") && (strings.Contains(line, " init") || strings.Contains(line, " add")) {
			t.Errorf("--no-git ran git: %q", line)
		}
	}

	// --dry-run: says what it would write, writes NOTHING, reaches for
	// nothing (start's plan discipline).
	s3 := newScenario(t, "container")
	s3.cwd = t.TempDir()
	stdout, stderr, code = s3.run(t, "init", "--name", "y", "--domain", "d.io:y", "--yes", "--dry-run")
	if code != 0 {
		t.Fatalf("init --dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "plan", stdout, ".semiont/config", "git init")
	if _, err := os.Stat(filepath.Join(s3.cwd, ".semiont")); !os.IsNotExist(err) {
		t.Error("--dry-run wrote .semiont/")
	}
	if got := s3.argv(t); strings.Contains(got, " init") || strings.Contains(got, " add") {
		t.Errorf("--dry-run executed git:\n%s", got)
	}
}

func TestInitInteractivePrompts(t *testing.T) {
	// The interactive path: prompts fill what flags did not — here the
	// domain (with the permanent-identity warning) and site name.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.stdin = "d.example.org:kb\nMy KB\n"
	stdout, stderr, code := s.run(t, "init", "--name", "kb")
	if code != 0 {
		t.Fatalf("interactive init: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "identity warning shown", stdout, "permanent")
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config"))
	mustContain(t, "prompted values", string(cfg),
		`domain = "d.example.org:kb"`, `siteName = "My KB"`)
}

func TestInitGeneratesStartableConfig(t *testing.T) {
	// LAUNCHER-BIRTH P2: the generative builder. The strongest possible
	// assertion is the round trip — the generated config must pass the REAL
	// deriver: `start --dry-run --config <name>` succeeds from the newborn
	// KB. Bindings are exactly the three-name roster; per-worker refinement
	// is the user's edit, not ours.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "FAKERT_GIT_ROOT="+s.cwd)
	// Seam flags at a dead port: hermetic — validation degrades to the
	// warn path, which is itself part of the P3 contract.
	_, stderr, code := s.run(t, "init",
		"--name", "kb", "--domain", "d.io:kb", "--yes",
		"--inference", "anthropic", "--model", "claude-sonnet-4-5-20250929",
		"--embedding", "ollama:nomic-embed-text", "--config-name", "anthropic",
		"--ollama-base", "http://127.0.0.1:1", "--ollama-registry", "http://127.0.0.1:1")
	if code != 0 {
		t.Fatalf("init: exit %d\nstderr:\n%s", code, stderr)
	}
	cfg, err := os.ReadFile(filepath.Join(s.cwd, ".semiont", "semiontconfig", "anthropic.toml"))
	if err != nil {
		t.Fatalf("generated config missing: %v", err)
	}
	mustContain(t, "config", string(cfg),
		"[environments.local.actors.gatherer.inference]",
		"[environments.local.actors.matcher.inference]",
		"[environments.local.workers.default.inference]",
		`model = "claude-sonnet-4-5-20250929"`,
		`model = "nomic-embed-text"`,
		"${ANTHROPIC_API_KEY}")
	if strings.Contains(string(cfg), "reference-annotation") {
		t.Errorf("generator emitted per-worker refinements — those are the user's edits:\n%s", cfg)
	}
	stdout, stderr, code := s.run(t, "start", "--config", "anthropic", "--dry-run")
	if code != 0 {
		t.Fatalf("the generated config failed the real deriver: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// The anthropic shape: external SaaS inference; the Ollama that exists
	// solely for the embedding, pulling exactly the embedding model.
	mustContain(t, "plan", stdout, "remote SaaS",
		"pull each missing one): nomic-embed-text")

	// The ollama variant round-trips too, in the local-Ollama shape.
	s2 := newScenario(t, "container")
	s2.cwd = t.TempDir()
	s2.extraEnv = append(s2.extraEnv, "FAKERT_GIT_ROOT="+s2.cwd)
	if _, stderr, code := s2.run(t, "init",
		"--name", "kb2", "--domain", "d.io:kb2", "--yes",
		"--inference", "ollama", "--model", "gemma4:26b",
		"--embedding", "ollama:nomic-embed-text",
		"--ollama-base", "http://127.0.0.1:1", "--ollama-registry", "http://127.0.0.1:1"); code != 0 {
		t.Fatalf("ollama init: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, stderr, code = s2.run(t, "start", "--config", "ollama", "--dry-run")
	if code != 0 {
		t.Fatalf("ollama config failed the deriver: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "ollama plan", stdout, "host Ollama", "gemma4:26b, nomic-embed-text")
	// A newborn names its issuer's port by ${KEYCLOAK_PORT} (CODESPACE-IDENTITY
	// B4), so the laptop that forwards it can move it.
	stdout, stderr, code = s2.run(t, "start", "--config", "ollama", "--dry-run")
	_ = stderr
	if !strings.Contains(stdout, "-p 8080:8080") {
		t.Errorf("the newborn's Keycloak is not on the default port:\n%s", stdout)
	}
	s2.extraEnv = append(s2.extraEnv, "KEYCLOAK_PORT=8081")
	if stdout, stderr, code = s2.run(t, "start", "--config", "ollama", "--dry-run"); code != 0 {
		t.Fatalf("moved issuer: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "a newborn's issuer moves with KEYCLOAK_PORT", stdout, "-p 8081:8080")

	// voyage embedding refuses: no established key variable exists, and the
	// launcher never invents environment variables.
	s3 := newScenario(t, "container")
	s3.cwd = t.TempDir()
	_, stderr, code = s3.run(t, "init", "--name", "kb3", "--domain", "d.io:kb3", "--yes",
		"--inference", "anthropic", "--model", "m", "--embedding", "voyage:voyage-3")
	if code != 1 {
		t.Fatalf("voyage: want refusal, got %d", code)
	}
	mustContain(t, "voyage refusal", stderr, "voyage", "ollama")
}

// serveOllamaFixtures: a local stand-in for BOTH the local Ollama daemon
// (/api/tags — what is installed) and the ollama registry
// (/v2/library/<m>/manifests/<t> — what exists to pull). init reaches them
// through --ollama-base / --ollama-registry, the proxy knobs that double as
// test seams.
// serveOllamaFixtures starts a fake Ollama on an EPHEMERAL port and returns
// it — same reasoning as serveAnthropicModels.
func serveOllamaFixtures(t *testing.T, installed []string, pullable []string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("no ephemeral port for the Ollama simulation: %v", err)
	}
	known := map[string]bool{}
	for _, m := range pullable {
		known[m] = true
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/tags":
			type m struct {
				Name string `json:"name"`
				Size int64  `json:"size"`
			}
			var ms []m
			for _, n := range installed {
				ms = append(ms, m{Name: n, Size: 1 << 30})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"models": ms})
		case strings.HasPrefix(r.URL.Path, "/v2/library/"):
			rest := strings.TrimPrefix(r.URL.Path, "/v2/library/")
			name, tag, _ := strings.Cut(rest, "/manifests/")
			if known[name+":"+tag] {
				w.WriteHeader(200)
				return
			}
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

func TestInitAnthropicPickerValidatesAgainstLiveList(t *testing.T) {
	// With a key in hand, the model choice is validated against /v1/models —
	// a withdrawn or typo'd id is a REFUSAL naming what exists, not a KB
	// whose jobs fail later (the claude-fable-5 lesson). Without --model,
	// the ONE editorial default picks the newest capable model and says so.
	anthPort := serveAnthropicModels(t, "claude-sonnet-4-9", "claude-haiku-4-5")
	regPort := serveOllamaFixtures(t, nil, []string{"nomic-embed-text:latest"})
	base := []string{"init", "--domain", "d.io:kb", "--yes",
		"--inference", "anthropic", "--embedding", "ollama:nomic-embed-text",
		"--anthropic-endpoint", fmt.Sprintf("http://localhost:%d", anthPort),
		"--ollama-registry", fmt.Sprintf("http://localhost:%d", regPort)}

	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	_, stderr, code := s.run(t, append(base, "--name", "kb", "--model", "claude-fable-5")...)
	if code != 1 {
		t.Fatalf("unlisted model: want refusal, got %d", code)
	}
	mustContain(t, "refusal names the live list", stderr, "claude-fable-5", "claude-sonnet-4-9")

	s2 := newScenario(t, "container")
	s2.cwd = t.TempDir()
	s2.extraEnv = append(s2.extraEnv, "ANTHROPIC_API_KEY=test-key")
	stdout, stderr, code := s2.run(t, append(base, "--name", "kb2")...)
	if code != 0 {
		t.Fatalf("default pick: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "default announced", stdout+stderr, "claude-sonnet-4-9")
	cfg, _ := os.ReadFile(filepath.Join(s2.cwd, ".semiont", "semiontconfig", "anthropic.toml"))
	mustContain(t, "config", string(cfg), `model = "claude-sonnet-4-9"`)

	// Keyless: typed model accepted, plainly marked unvalidated.
	s3 := newScenario(t, "container")
	s3.cwd = t.TempDir()
	stdout, stderr, code = s3.run(t, append(base, "--name", "kb3", "--model", "claude-anything")...)
	if code != 0 {
		t.Fatalf("keyless: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "unvalidated warning", stdout+stderr, "unvalidated")
}

func TestInitOllamaModelsValidatedByRegistry(t *testing.T) {
	// Ollama models: installed passes; not-installed-but-pullable passes
	// (start's pull machinery finishes the job); bogus is REFUSED with the
	// registry's own 404; an unreachable registry degrades to
	// accept-with-warning — unknown is not missing, init edition.
	ollPort := serveOllamaFixtures(t, []string{"gemma4:26b"}, []string{"gemma4:e2b:latest", "gemma4:e2b", "nomic-embed-text:latest"})
	ollURL := fmt.Sprintf("http://localhost:%d", ollPort)
	base := []string{"init", "--domain", "d.io:kb", "--yes", "--inference", "ollama",
		"--embedding", "ollama:nomic-embed-text",
		"--ollama-base", ollURL, "--ollama-registry", ollURL}

	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	stdout, stderr, code := s.run(t, append(base, "--name", "a", "--model", "gemma4:26b")...)
	if code != 0 {
		t.Fatalf("installed model: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "installed", stdout+stderr, "installed")

	s2 := newScenario(t, "container")
	s2.cwd = t.TempDir()
	stdout, stderr, code = s2.run(t, append(base, "--name", "b", "--model", "gemma4:e2b")...)
	if code != 0 {
		t.Fatalf("pullable model: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "pull promise", stdout+stderr, "pulled at start")

	s3 := newScenario(t, "container")
	s3.cwd = t.TempDir()
	_, stderr, code = s3.run(t, append(base, "--name", "c", "--model", "gemma9:nope")...)
	if code != 1 {
		t.Fatalf("bogus model: want refusal, got %d", code)
	}
	mustContain(t, "registry refusal", stderr, "gemma9:nope", "registry")

	// Registry unreachable AND not installed: accept, warned.
	s4 := newScenario(t, "container")
	s4.cwd = t.TempDir()
	stdout, stderr, code = s4.run(t, "init", "--domain", "d.io:kb", "--yes", "--name", "d",
		"--inference", "ollama", "--model", "gemma4:26b", "--embedding", "ollama:nomic-embed-text",
		"--ollama-base", "http://127.0.0.1:1", "--ollama-registry", "http://127.0.0.1:1")
	if code != 0 {
		t.Fatalf("offline: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "offline warning", stdout+stderr, "could not be verified")
}

// templateFixture builds a fake semiont-template-kb tree: real fixture
// configs (the same files the parser tests trust) plus a devcontainer set
// with the template's display name.
func templateFixture(t *testing.T, includeBad bool) string {
	t.Helper()
	root := t.TempDir()
	sc := filepath.Join(root, ".semiont", "semiontconfig")
	if err := os.MkdirAll(sc, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"anthropic.toml", "ollama-gemma.toml"} {
		b, err := os.ReadFile(filepath.Join("testdata", "kb", ".semiont", "semiontconfig", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sc, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if includeBad {
		bad := "[defaults]\nenvironment = \"local\"\n\n[environments.local.graph]\ntype = \"janusgraph\"\nuri = \"bolt://${NEO4J_HOST}:7687\"\n"
		if err := os.WriteFile(filepath.Join(sc, "broken.toml"), []byte(bad), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	dc := filepath.Join(root, ".devcontainer")
	if err := os.MkdirAll(dc, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"devcontainer.json": `{"name": "Semiont Template KB", "postStartCommand": ".devcontainer/post-start.sh"}`,
		"post-create.sh":    "#!/bin/sh\necho hi\n",
		"post-start.sh":     "#!/bin/sh\nsemiont start --runtime docker\n",
	}
	for n, c := range files {
		if err := os.WriteFile(filepath.Join(dc, n), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Template identity — must NEVER reach the newborn.
	if err := os.WriteFile(filepath.Join(root, ".semiont", "config"),
		[]byte("[site]\ndomain = \"the-ai-alliance.github.io:semiont-template-kb\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestInitFromTemplateCopiesAndVets(t *testing.T) {
	// LAUNCHER-BIRTH P4: the explicit template-copy path. Every fetched toml
	// passes the SAME derivePlan vet as generated ones; identity is always
	// init's own, never the template's; and the copied config round-trips
	// through the real deriver.
	tpl := templateFixture(t, false)
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "FAKERT_GIT_ROOT="+s.cwd)
	_, stderr, code := s.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes",
		"--from-template", tpl)
	if code != 0 {
		t.Fatalf("from-template: exit %d\nstderr:\n%s", code, stderr)
	}
	for _, n := range []string{"anthropic.toml", "ollama-gemma.toml"} {
		if _, err := os.Stat(filepath.Join(s.cwd, ".semiont", "semiontconfig", n)); err != nil {
			t.Errorf("%s not copied: %v", n, err)
		}
	}
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config"))
	mustContain(t, "identity is init's own", string(cfg), `domain = "d.io:kb"`)
	if strings.Contains(string(cfg), "semiont-template-kb") {
		t.Errorf("template identity leaked into the newborn:\n%s", cfg)
	}
	if _, _, code := s.run(t, "start", "--config", "anthropic", "--dry-run"); code != 0 {
		t.Fatal("copied config failed the real deriver")
	}

	// A template carrying an unstartable config: the WHOLE init refuses,
	// pre-write, with the parser's own complaint — no partial tree.
	tplBad := templateFixture(t, true)
	s2 := newScenario(t, "container")
	s2.cwd = t.TempDir()
	_, stderr, code = s2.run(t, "init", "--name", "kb2", "--domain", "d.io:kb2", "--yes",
		"--from-template", tplBad)
	if code != 1 {
		t.Fatalf("bad template: want refusal, got %d", code)
	}
	mustContain(t, "parser's own error", stderr, "janusgraph")
	if _, err := os.Stat(filepath.Join(s2.cwd, ".semiont", "semiontconfig")); !os.IsNotExist(err) {
		t.Error("refusal left a partial semiontconfig tree")
	}

	// Two config sources are contradictory.
	s3 := newScenario(t, "container")
	s3.cwd = t.TempDir()
	_, stderr, code = s3.run(t, "init", "--name", "kb3", "--domain", "d.io:kb3", "--yes",
		"--from-template", tpl, "--inference", "anthropic", "--model", "m")
	if code != 1 {
		t.Fatalf("both sources: want refusal, got %d", code)
	}
	mustContain(t, "contradiction", stderr, "--from-template", "--inference")
}

func TestInitDevcontainerCopy(t *testing.T) {
	// The separate devcontainer offer: the set copies verbatim EXCEPT the
	// display name, which becomes the newborn's (template-init.yml step 5 —
	// each KB's codespace self-identifies). This is what makes a local-born
	// KB codespace-capable.
	tpl := templateFixture(t, false)
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	_, stderr, code := s.run(t, "init", "--name", "myk", "--domain", "d.io:myk", "--yes",
		"--from-template", tpl, "--devcontainer")
	if code != 0 {
		t.Fatalf("devcontainer copy: exit %d\nstderr:\n%s", code, stderr)
	}
	dj, err := os.ReadFile(filepath.Join(s.cwd, ".devcontainer", "devcontainer.json"))
	if err != nil {
		t.Fatalf("devcontainer.json not copied: %v", err)
	}
	mustContain(t, "renamed", string(dj), `"name": "myk"`)
	if strings.Contains(string(dj), "Semiont Template KB") {
		t.Errorf("template display name survived:\n%s", dj)
	}
	for _, n := range []string{"post-create.sh", "post-start.sh"} {
		got, err := os.ReadFile(filepath.Join(s.cwd, ".devcontainer", n))
		if err != nil {
			t.Errorf("%s not copied: %v", n, err)
			continue
		}
		want, _ := os.ReadFile(filepath.Join(tpl, ".devcontainer", n))
		if string(got) != string(want) {
			t.Errorf("%s not byte-identical", n)
		}
	}
}

func TestInitFromTemplateURLClones(t *testing.T) {
	// A URL source shallow-clones via git (already a launcher requirement —
	// no gh, no listing APIs, atomic ref). fakert's clone persona materializes
	// FAKERT_TEMPLATE_DIR at the destination.
	tpl := templateFixture(t, false)
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "FAKERT_TEMPLATE_DIR="+tpl)
	_, stderr, code := s.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes",
		"--from-template", "https://github.com/The-AI-Alliance/semiont-template-kb")
	if code != 0 {
		t.Fatalf("url template: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "argv", s.argv(t), "clone --depth 1")
	if _, err := os.Stat(filepath.Join(s.cwd, ".semiont", "semiontconfig", "anthropic.toml")); err != nil {
		t.Errorf("cloned config missing: %v", err)
	}
}

func TestInitCopilotHardening(t *testing.T) {
	// The PR #1065 review fixes, pinned so they cannot silently regress.

	// (1) --config-name path traversal is refused, no file escapes.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	_, stderr, code := s.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes",
		"--inference", "anthropic", "--model", "m", "--config-name", "../escape",
		"--anthropic-endpoint", "http://127.0.0.1:1")
	if code != 1 {
		t.Fatalf("traversal config-name: want refusal, got %d", code)
	}
	mustContain(t, "traversal refused", stderr, "simple file stem")
	if _, err := os.Stat(filepath.Join(s.cwd, "..", "escape.toml")); err == nil {
		t.Error("traversal wrote outside the KB")
	}

	// (2) Transactional: a failure after .semiont/config leaves NOTHING —
	// a bogus model is rejected, and the dir is rolled back so a rerun does
	// not need --force.
	s2 := newScenario(t, "container")
	s2.cwd = t.TempDir()
	badURL := fmt.Sprintf("http://localhost:%d", serveOllamaFixtures(t, nil, nil)) // registry knows nothing
	_, _, code = s2.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes",
		"--inference", "ollama", "--model", "totally-fake:9b", "--embedding", "ollama:nomic-embed-text",
		"--ollama-base", badURL, "--ollama-registry", badURL)
	if code != 1 {
		t.Fatalf("bad model: want refusal, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(s2.cwd, ".semiont")); !os.IsNotExist(err) {
		t.Error("a failed init left a partial .semiont/ (not rolled back)")
	}

	// (3) --force removes the old tree — no stale config survives.
	s3 := newScenario(t, "container")
	s3.cwd = t.TempDir()
	scdir := filepath.Join(s3.cwd, ".semiont", "semiontconfig")
	if err := os.MkdirAll(scdir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(scdir, "stale.toml"), []byte("junk"), 0o644)
	if _, _, code := s3.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes", "--force"); code != 0 {
		t.Fatalf("--force init failed: %d", code)
	}
	if _, err := os.Stat(filepath.Join(scdir, "stale.toml")); err == nil {
		t.Error("--force left a stale config beside the new identity")
	}

	// (4) devcontainer name with a quote stays valid JSON.
	tpl := templateFixture(t, false)
	s4 := newScenario(t, "container")
	s4.cwd = t.TempDir()
	if _, _, code := s4.run(t, "init", "--name", `weird"name`, "--domain", "d.io:w", "--yes",
		"--from-template", tpl, "--devcontainer"); code != 0 {
		t.Fatalf("quoted-name init failed: %d", code)
	}
	dj, _ := os.ReadFile(filepath.Join(s4.cwd, ".devcontainer", "devcontainer.json"))
	var parsed map[string]any
	if err := json.Unmarshal(dj, &parsed); err != nil {
		t.Errorf("devcontainer.json is invalid JSON after a quoted name: %v\n%s", err, dj)
	}

	// (5) a symlinked template config is refused.
	tpl2 := templateFixture(t, false)
	if err := os.Symlink("/etc/hosts", filepath.Join(tpl2, ".semiont", "semiontconfig", "evil.toml")); err != nil {
		t.Fatalf("this test needs a symlink in the template, and making one failed: %v", err)
	}
	s5 := newScenario(t, "container")
	s5.cwd = t.TempDir()
	_, stderr, code = s5.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes", "--from-template", tpl2)
	if code != 1 {
		t.Fatalf("symlinked config: want refusal, got %d", code)
	}
	mustContain(t, "symlink refused", stderr, "symlink")

	// (6) the generated anthropic config honors --anthropic-endpoint.
	s6 := newScenario(t, "container")
	s6.cwd = t.TempDir()
	anthURL := fmt.Sprintf("http://localhost:%d", serveAnthropicModels(t, "m"))
	s6.extraEnv = append(s6.extraEnv, "ANTHROPIC_API_KEY=k")
	if _, stderr, code := s6.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes",
		"--inference", "anthropic", "--model", "m", "--embedding", "ollama:nomic-embed-text",
		"--anthropic-endpoint", anthURL,
		"--ollama-base", "http://127.0.0.1:1", "--ollama-registry", "http://127.0.0.1:1"); code != 0 {
		t.Fatalf("endpoint init: %d\n%s", code, stderr)
	}
	cfg, _ := os.ReadFile(filepath.Join(s6.cwd, ".semiont", "semiontconfig", "anthropic.toml"))
	mustContain(t, "endpoint honored", string(cfg), fmt.Sprintf(`endpoint = "%s"`, anthURL))
}

func TestStatusService(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_STATE_gateway=running")
	serveHealth(t, 4000)
	stdout, _, code := s.run(t, "status", "--service", "gateway")
	if code != 0 {
		t.Fatalf("healthy gateway: want exit 0, got %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout, "gateway", "✓ running", "http://localhost:4000/api/health")
	for _, absent := range []string{"KNOWLEDGE BASES", "worker", "traces"} {
		if strings.Contains(stdout, absent) {
			t.Errorf("filtered status leaked %q:\n%s", absent, stdout)
		}
	}

	// A down service — and non-core Jaeger when asked for explicitly — exits 1.
	if _, _, code := s.run(t, "status", "--service", "worker"); code != 1 {
		t.Errorf("down worker: want exit 1, got %d", code)
	}
	if _, _, code := s.run(t, "status", "--service", "traces"); code != 1 {
		t.Errorf("down traces (explicit): want exit 1, got %d", code)
	}
	// --service narrows to one service; --verbose must not smuggle the
	// launcher's own paths back into that answer.
	vstdout, _, _ := s.run(t, "status", "--service", "gateway", "--verbose")
	if strings.Contains(vstdout, "LAUNCHER PATHS") {
		t.Errorf("--service --verbose leaked LAUNCHER PATHS:\n%s", vstdout)
	}
}

// --- logs ---

func TestLogsDiscovery(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	s.extraEnv = append(s.extraEnv, "FAKERT_STACK_RUNTIME=docker")
	stdout, stderr, code := s.run(t, "logs")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// Discovery probes run in order; the eight follows launch concurrently, so
	// assert the probe prefix exactly and the follow set order-independently.
	lines := strings.Split(strings.TrimRight(s.argv(t), "\n"), "\n")
	if len(lines) != 10 {
		t.Fatalf("want 10 invocations (2 probes + 8 follows), got %d:\n%s", len(lines), s.argv(t))
	}
	if lines[0] != "container list" || lines[1] != "docker ps --format {{.Names}}" {
		t.Errorf("wrong discovery probes:\n%s", s.argv(t))
	}
	follows := append([]string{}, lines[2:]...)
	sort.Strings(follows)
	want := []string{
		"docker logs --follow semiont-archivist",
		"docker logs --follow semiont-browser",
		"docker logs --follow semiont-dispatcher",
		"docker logs --follow semiont-gateway",
		"docker logs --follow semiont-librarian",
		"docker logs --follow semiont-smelter",
		"docker logs --follow semiont-weaver",
		"docker logs --follow semiont-worker",
	}
	if strings.Join(follows, "\n") != strings.Join(want, "\n") {
		t.Errorf("wrong follow set:\n%s", strings.Join(follows, "\n"))
	}
	// Streams: [svc]-prefixed, stderr kept in-stream (crash traces live there).
	mustContain(t, "stdout", stdout,
		"Following gateway · worker · smelter · weaver · archivist · librarian · dispatcher · browser",
		"[gateway] gateway out",
		"[gateway] gateway err",
		"[worker] worker out",
		"[smelter] smelter err",
		"[weaver] weaver out",
		"[browser] browser err",
	)
}

func TestLogsNoStack(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	_, stderr, code := s.run(t, "logs")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "No running Semiont stack found in any runtime (container/docker/podman).")
}

func TestLogsRuntimeNotOnPath(t *testing.T) {
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "logs", "--runtime", "docker")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "--runtime docker requested, but 'docker' is not on PATH.")
}

// --- top-level dispatch ---

func TestBareFlagsHintAtStart(t *testing.T) {
	// start.sh muscle memory: flags without a subcommand get a pointed hint.
	s := newScenario(t, "container")
	_, stderr, code := s.run(t, "--config", "anthropic", "--no-observe")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"Unknown command: --config",
		"did you mean:  semiont start --config anthropic --no-observe")
}

// --- about ---

func TestAbout(t *testing.T) {
	s := newScenario(t, "container", "docker")
	stdout, _, code := s.run(t, "about")
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	if !strings.HasPrefix(stdout, "Semiont 🌐\n") {
		t.Errorf("about must begin with the Semiont title line, got:\n%s", stdout)
	}
	if !strings.HasSuffix(stdout, "✨ Make Meaning\n") {
		t.Errorf("about must sign off with Make Meaning, got:\n%s", stdout)
	}
	mustContain(t, "stdout", stdout,
		"The AI Alliance 🌎🌍",
		"semantic knowledge platform",
		"https://the-ai-alliance.github.io/semiont/",
		"https://github.com/The-AI-Alliance/semiont",
		"ghcr.io/the-ai-alliance",
		"Apache-2.0",
		"container, docker",
		"semiont start --help",
	)
}

// --- version ---

func TestVersion(t *testing.T) {
	s := newScenario(t)
	for _, arg := range []string{"version", "--version"} {
		stdout, _, code := s.run(t, arg)
		if code != 0 {
			t.Fatalf("%s: want exit 0, got %d", arg, code)
		}
		// Exactly one machine-friendly line — no header, no decoration.
		if stdout != "semiont dev (commit none, built unknown)\n" {
			t.Errorf("stdout for %s not a bare version line:\n%s", arg, stdout)
		}
	}
}

// --- bus verbs: browse, gather ---

// busScenario boots a stack, logs in, and scripts the fake bus's replies.
func busScenario(t *testing.T, env ...string) *scenario {
	t.Helper()
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, env...)
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "login"); code != 0 {
		t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
	}
	return s
}

// WIRE SMOKE TEST (browse) — SDK-GO-TRANSPORT P2. This family's logic now runs
// in process against a fake transport (internal/launcher/verbs_test.go). This
// one stays end-to-end deliberately: it is the only thing proving the BUILT
// BINARY speaks HTTP a real server understands. A family tested only against a
// double can agree with a bug in our own client.
func TestBrowseListsResources(t *testing.T) {
	s := busScenario(t, `FAKERT_BUS_REPLY_browse_resources_requested={"resources":[`+
		`{"@id":"res-1","name":"Letter","entityTypes":["Letter"]},`+
		`{"@id":"res-2","name":"Email","entityTypes":[]}],"total":2}`)
	stdout, stderr, code := s.run(t, "browse", "--limit", "5")
	if code != 0 {
		t.Fatalf("browse: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "table", stdout, "res-1", "Letter", "res-2", "Email", "2 shown, 2 total")
	// The request went out on the right operation with our filter.
	b := lastEmit(t, s)
	mustContain(t, "emit", b, `"channel":"browse:resources-requested"`, `"limit":5`, `"correlationId"`)
}

// WIRE SMOKE TEST (session refresh). The policy is specified in process
// (internal/launcher/session_test.go); this proves the BUILT BINARY renews a
// session over real HTTP for a BUS verb: fakert refuses the login-issued token
// on its second use, and browse must still succeed — under the renewed token,
// saved for the next command. Before the policy was shared, only
// `yield --upload` did this; every bus verb sent the user back to login.
func TestBrowseAutoRefreshesExpiredToken(t *testing.T) {
	s := busScenario(t, "FAKERT_STALE_TOKEN=1",
		`FAKERT_BUS_REPLY_browse_resources_requested={"resources":[],"total":0}`)
	stdout, stderr, code := s.run(t, "browse")
	if code != 0 {
		t.Fatalf("browse with refreshable token: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stderr", stderr, "Session refreshed")
	if strings.Contains(stdout+stderr, "semiont login") {
		t.Errorf("a renewed session was still sent to login:\n%s\n%s", stdout, stderr)
	}
	tb, err := os.ReadFile(tokensPathFor(s.home))
	if err != nil {
		t.Fatalf("tokens.json: %v", err)
	}
	mustContain(t, "tokens.json", string(tb), "fake-jwt-token-2")
}

func TestBrowseWithoutSessionAdvisesLogin(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: %s", stderr)
	}
	stdout, stderr, code := s.run(t, "browse")
	if code == 0 {
		t.Fatal("browse without a session must refuse")
	}
	mustContain(t, "fix-it", stdout+stderr, "semiont login")
}

// WIRE SMOKE TEST (gather) — SDK-GO-TRANSPORT P2. This family's logic now runs
// in process against a fake transport (internal/launcher/verbs_test.go). This
// one stays end-to-end deliberately: it is the only thing proving the BUILT
// BINARY speaks HTTP a real server understands. A family tested only against a
// double can agree with a bug in our own client.
func TestGatherResourceSummarizes(t *testing.T) {
	// The REAL GatheredContext shape (schema-defined): metadata +
	// inferredRelationshipSummary, not the content/summary/resources fields
	// an earlier version of this test invented.
	s := busScenario(t, `FAKERT_BUS_REPLY_gather_resource_requested=`+
		`{"inferredRelationshipSummary":"A letter about X",`+
		`"metadata":{"resourceType":"Letter","language":"en","entityTypes":["Letter","Contract"]},`+
		`"focus":{"kind":"resource"},"graph":{}}`)
	stdout, stderr, code := s.run(t, "gather", "res-1")
	if code != 0 {
		t.Fatalf("gather: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// A summary, not the payload: context is LLM input and can be huge.
	mustContain(t, "summary", stdout, "A letter about X", "Letter", "en", "2 entity type(s)", "--json")
	if strings.Contains(stdout, `"graph"`) {
		t.Errorf("gather dumped raw JSON — it could not parse the real reply:\n%s", stdout)
	}
	b := lastEmit(t, s)
	// No flags still names a traversal: the schema requires depth and
	// maxResources, and a zero-valued struct once sent maxResources 0, which
	// the librarian forwarded to Qdrant as `limit: 0` — refused with a 422.
	mustContain(t, "emit", b, `"channel":"gather:resource-requested"`, `"resourceId":"res-1"`,
		`"includeContent":true`, `"depth":2`, `"maxResources":10`)
}

// WIRE SMOKE TEST (mark) — SDK-GO-TRANSPORT P2. This family's logic now runs
// in process against a fake transport (internal/launcher/verbs_test.go). This
// one stays end-to-end deliberately: it is the only thing proving the BUILT
// BINARY speaks HTTP a real server understands. A family tested only against a
// double can agree with a bug in our own client.
func TestMarkCreatesWithSelectorAndBody(t *testing.T) {
	s := busScenario(t, `FAKERT_BUS_REPLY_mark_create_request={"annotationId":"ann-42"}`)
	stdout, stderr, code := s.run(t, "mark", "res-1",
		"--quote", "the disputed clause", "--prefix", "before ", "--body-text", "check this")
	if code != 0 {
		t.Fatalf("mark: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "ann-42", "commenting")
	b := lastEmit(t, s)
	mustContain(t, "emit", b,
		`"channel":"mark:create-request"`,
		`"TextQuoteSelector"`, `"exact":"the disputed clause"`, `"prefix":"before "`,
		`"TextualBody"`, `"value":"check this"`,
		`"motivation":"commenting"`) // inferred from the body
}

// WIRE SMOKE TEST (bind) — SDK-GO-TRANSPORT P2. This family's logic now runs
// in process against a fake transport (internal/launcher/verbs_test.go). This
// one stays end-to-end deliberately: it is the only thing proving the BUILT
// BINARY speaks HTTP a real server understands. A family tested only against a
// double can agree with a bug in our own client.
func TestBindAddsAndRemovesTarget(t *testing.T) {
	s := busScenario(t, `FAKERT_BUS_REPLY_bind_update_body={}`)
	if _, stderr, code := s.run(t, "bind", "res-1", "ann-1", "res-2"); code != 0 {
		t.Fatalf("bind: exit %d\nstderr:\n%s", code, stderr)
	}
	b := lastEmit(t, s)
	mustContain(t, "emit", b, `"channel":"bind:update-body"`, `"op":"add"`,
		`"source":"res-2"`, `"purpose":"linking"`, `"annotationId":"ann-1"`)

	if _, stderr, code := s.run(t, "bind", "res-1", "ann-1", "--unbind", "res-2"); code != 0 {
		t.Fatalf("unbind: exit %d\nstderr:\n%s", code, stderr)
	}
	b = lastEmit(t, s)
	mustContain(t, "emit", b, `"op":"remove"`)
}

// WIRE SMOKE TEST (match) — SDK-GO-TRANSPORT P2. This family's logic now runs
// in process against a fake transport (internal/launcher/verbs_test.go). This
// one stays end-to-end deliberately: it is the only thing proving the BUILT
// BINARY speaks HTTP a real server understands. A family tested only against a
// double can agree with a bug in our own client.
func TestMatchGathersThenSearches(t *testing.T) {
	// match is TWO exchanges: the search requires a context payload, so a
	// gather must precede it — not an optimization, a precondition.
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_requested={"content":"surrounding text"}`,
		// The REAL shape: MatchSearchResult.response IS the candidate list.
		// The first version of this test scripted {"candidates":[…]} — my
		// guess — so it passed against code that could not parse a real
		// reply. A fake that encodes an assumption tests the assumption.
		`FAKERT_BUS_REPLY_match_search_requested=[`+
			`{"@id":"res-7","name":"Acme MSA","score":0.91,"matchReason":"title match"},`+
			`{"@id":"res-8","name":"Side Letter","score":0.44}]`)
	stdout, stderr, code := s.run(t, "match", "res-1", "ann-1", "--limit", "5")
	if code != 0 {
		t.Fatalf("match: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "res-7", "Acme MSA", "0.910", "title match", "2 candidate(s)", "semiont bind res-1 ann-1")
	// Rendered as a table, not dumped: a raw-JSON fallback would mean the
	// parser did not understand the reply — which is how the first version of
	// this verb "passed" while guessing the payload shape.
	if strings.Contains(stdout, `"@id":"res-7"`) {
		t.Errorf("match fell back to raw JSON — it could not parse the real reply:\n%s", stdout)
	}
	// The LAST emit is the search, carrying the gathered context and our flags.
	b := lastEmit(t, s)
	mustContain(t, "search emit", b,
		`"channel":"match:search-requested"`, `"referenceId":"ann-1"`,
		`"limit":5`, `"useSemanticScoring":true`, `"context"`)
}

// RETITLED (GUIDED-TOUR P1): the verb still claims no delivery, but it no
// longer prints a bare ✓ over a signal that reached an empty room. Nothing is
// subscribed to beckon:focus in this scenario, and the gateway now says so, so
// the honest line names that — the old "no delivery confirmation" wording is
// reserved for the case where the count is genuinely unknown.
// WIRE SMOKE TEST (beckon) — SDK-GO-TRANSPORT P2. This family's logic now runs
// in process against a fake transport (internal/launcher/verbs_test.go). This
// one stays end-to-end deliberately: it is the only thing proving the BUILT
// BINARY speaks HTTP a real server understands. A family tested only against a
// double can agree with a bug in our own client.
func TestBeckonSaysWhenNobodyIsSubscribed(t *testing.T) {
	s := busScenario(t)
	stdout, stderr, code := s.run(t, "beckon", "--resource", "res-1", "--annotation", "ann-2")
	if code != 0 {
		t.Fatalf("an empty room is not a failure — beckon is fire-and-forget: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stdout", stdout, "res-1", "ann-2", "nothing is subscribed to beckon:focus")
	b := lastEmit(t, s)
	// BeckonFocusEvent carries exactly these two fields; a `message` the
	// schema does not declare must not reach the wire.
	mustContain(t, "emit", b, `"channel":"beckon:focus"`, `"resourceId":"res-1"`, `"annotationId":"ann-2"`)
	if strings.Contains(b, `"message"`) {
		t.Errorf("emitted a field BeckonFocusEvent does not declare:\n%s", b)
	}
}

// --- frame: the schema-layer flow ---

// Frame is a FAN-OUT verb: the protocol has no batch add, so N entity types
// are N `frame:add-entity-type` commands. This asserts against every emit,
// not the last one — a verb that dropped all but the final tag would pass a
// last-emit check while losing the caller's work.
// WIRE SMOKE TEST (SDK-GO-TRANSPORT P2). The verb's logic — one command per
// entity type, stop at the first rejection, refuse bad arguments — moved to
// internal/launcher/frame_test.go, where it runs in process against a fake
// transport in ~0 s. This one stays end-to-end on purpose: it is the only thing
// proving the BUILT BINARY speaks HTTP a server actually understands. Retiring
// it would leave the whole verb family tested against a double that could agree
// with a bug.
func TestFrameAddsEachEntityTypeSeparately(t *testing.T) {
	s := busScenario(t)
	stdout, stderr, code := s.run(t, "frame", "--entity-type", "Person", "--entity-type", "Organization")
	if code != 0 {
		t.Fatalf("frame: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Person", "Organization")

	all := emits(t, s)
	if len(all) != 2 {
		t.Fatalf("two entity types must produce two commands, got %d:\n%s", len(all), strings.Join(all, "\n"))
	}
	mustContain(t, "first emit", all[0], `"channel":"frame:add-entity-type"`, `"tag":"Person"`, `"correlationId"`)
	mustContain(t, "second emit", all[1], `"channel":"frame:add-entity-type"`, `"tag":"Organization"`)
	// FrameAddEntityTypeCommand declares `tag` and the SDK's correlationId;
	// `_userId` is injected by the gateway from the bearer token and must
	// never be claimed by a client.
	if strings.Contains(all[0], `"_userId"`) {
		t.Errorf("client set a field the gateway owns:\n%s", all[0])
	}
}

func TestListenRefusesWithoutSession(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: %s", stderr)
	}
	stdout, stderr, code := s.run(t, "listen")
	if code == 0 {
		t.Fatal("listen without a session must refuse")
	}
	mustContain(t, "fix-it", stdout+stderr, "semiont login")
}

func TestListenHelpNamesTheBridgingConstraint(t *testing.T) {
	s := newScenario(t)
	stdout, _, code := s.run(t, "listen", "--help")
	if code != 0 {
		t.Fatalf("listen --help: exit %d", code)
	}
	// The silent-failure trap the bus docs warn about must be stated, not
	// discovered by waiting forever on an unbridged channel.
	mustContain(t, "help", stdout, "bridges", "deliver nothing")
}

func TestYieldDelegateFollowsJobToCompletion(t *testing.T) {
	// Delegate is the ONLY verb that is not one request/reply: it gathers,
	// creates a job, then follows job:* broadcasts keyed by jobId. The
	// subscription must be open before job:create, or a fast job's
	// completion is missed.
	s := busScenario(t, `FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{},"graph":{}}`)
	stdout, stderr, code := s.run(t, "yield", "--delegate", "res-src",
		"--storage-uri", "file://generated/out.md", "--title", "Derived", "--task", "summary")
	if code != 0 {
		t.Fatalf("delegate: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Generating", "Generating resource", "res-new", "Generated")
	// The grounding gather names its traversal. Delegate has no flags for
	// these, and the zero-valued struct it once sent asked the librarian for
	// maxResources 0 — forwarded to Qdrant as `limit: 0`, a 422 that killed
	// every delegate in the gather with a bare "Unprocessable Entity".
	var gather string
	for _, e := range emits(t, s) {
		if strings.Contains(e, `"channel":"gather:resource-requested"`) {
			gather = e
		}
	}
	mustContain(t, "gather emit", gather, `"resourceId":"res-src"`, `"depth":2`, `"maxResources":10`,
		`"includeContent":true`, `"includeSummary":true`)
	b := lastEmit(t, s)
	// The job carries the gathered context and the generation params.
	mustContain(t, "job:create emit", b,
		`"channel":"job:create"`, `"jobType":"generation"`,
		`"storageUri":"file://generated/out.md"`, `"title":"Derived"`, `"task":"summary"`, `"context"`)
	// For jobType generation the dispatcher derives resourceId from
	// params.context.focus and REJECTS a caller-supplied one; referenceId left
	// the params schema entirely. Sending either is now an error, so assert
	// their ABSENCE — a payload that still carries them would be refused by a
	// real gateway while this fake accepted it.
	for _, gone := range []string{`"resourceId"`, `"referenceId"`} {
		if strings.Contains(b, gone) {
			t.Errorf("job:create still carries %s; the context's focus is authoritative now:\n%s", gone, b)
		}
	}
}

func TestYieldDelegateReportsJobFailure(t *testing.T) {
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{},"graph":{}}`,
		"FAKERT_JOB_FAIL=model refused")
	stdout, stderr, code := s.run(t, "yield", "--delegate", "res-src", "--storage-uri", "file://generated/out.md", "--title", "Derived")
	if code == 0 {
		t.Fatalf("a failed job must fail the command\nstdout:\n%s", stdout)
	}
	mustContain(t, "failure", stdout+stderr, "Generation failed", "model refused")
}

// A DECLINE completes the job — nothing went wrong, there was simply nothing
// to work with (an encrypted PDF, a scan with no text layer). No resource
// exists at the storage URI afterwards, so a ✓ here is the worst of the three
// outcomes to get wrong: the caller's next step runs against nothing.
//
// The trap this guards is specific. Every generated As*() accessor is a bare
// json.Unmarshal with no discriminant check, so a declined result decodes
// CLEANLY into JobGenerationResult with a zero-value resource id. A real
// generation always carries the id (the schema requires it), so an empty id
// here means "this is not a generation result" — which is why the decline
// must be read first, by its own discriminant.
func TestYieldDelegateReportsADecline(t *testing.T) {
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{},"graph":{}}`,
		`FAKERT_JOB_RESULT={"kind":"declined","declined":true,"reason":"encrypted","message":"this PDF is password-protected"}`)
	stdout, stderr, code := s.run(t, "yield", "--delegate", "res-src", "--storage-uri", "file://generated/out.md", "--title", "Derived")
	if code == 0 {
		t.Fatalf("a declined job produced nothing; exit 0 tells a script to carry on\nstdout:\n%s", stdout)
	}
	mustContain(t, "decline", stdout+stderr, "encrypted", "this PDF is password-protected")
	if strings.Contains(stdout, "Yielded") {
		t.Errorf("claimed a yield that never happened:\n%s", stdout)
	}
	// Reported as its own outcome, not dressed up as a crash — the schema is
	// explicit that a decline is distinct from a failure.
	if strings.Contains(stdout+stderr, "Generation failed") {
		t.Errorf("a decline is not a failure:\n%s", stdout+stderr)
	}
}

// The exit code must not depend on the output format: --json prints the raw
// payload and still reports that nothing was produced.
func TestYieldDelegateDeclineFailsUnderJSON(t *testing.T) {
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{},"graph":{}}`,
		`FAKERT_JOB_RESULT={"kind":"declined","declined":true,"reason":"no-text-layer","message":"scanned pages, no recognizable text"}`)
	stdout, _, code := s.run(t, "yield", "--delegate", "res-src", "--storage-uri", "file://generated/out.md", "--title", "Derived", "--json")
	if code == 0 {
		t.Fatalf("--json must not turn a decline into a success\nstdout:\n%s", stdout)
	}
	mustContain(t, "raw payload", stdout, `"declined":true`, `"no-text-layer"`)
}

// The other half of the format-independence rule: --json must not turn a
// SUCCESS into a failure either. Without this, "always fail under --json"
// passes the decline test above and nothing else notices.
func TestYieldDelegateJSONSucceedsOnAGeneration(t *testing.T) {
	s := busScenario(t, `FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{},"graph":{}}`)
	stdout, stderr, code := s.run(t, "yield", "--delegate", "res-src", "--storage-uri", "file://generated/out.md", "--title", "Derived", "--json")
	if code != 0 {
		t.Fatalf("a completed generation under --json must exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "raw payload", stdout, `"resourceId":"res-new"`)
}

// title joined storageUri as required when GenerationJobParams gained it
// (generation-wire-context P1). Refused HERE rather than letting the gateway
// reject the job: the caller has already paid for a gather by then.
func TestYieldDelegateNeedsTitle(t *testing.T) {
	s := busScenario(t)
	_, stderr, code := s.run(t, "yield", "--delegate", "res-src", "--storage-uri", "file://generated/out.md")
	if code == 0 {
		t.Fatal("--delegate without --title must refuse")
	}
	mustContain(t, "refusal", stderr, "--title")
}

func TestYieldDelegateNeedsStorageUri(t *testing.T) {
	s := busScenario(t)
	_, stderr, code := s.run(t, "yield", "--delegate", "res-src")
	if code == 0 {
		t.Fatal("--delegate without --storage-uri must refuse")
	}
	mustContain(t, "refusal", stderr, "--storage-uri")
}

// --- mark --delegate: annotation through the job lifecycle ---

// jobCreate: the job:create a verb emitted, decoded.
func jobCreate(t *testing.T, emit string) (jobType, resourceID string, params map[string]any) {
	t.Helper()
	var e struct {
		Channel string `json:"channel"`
		Payload struct {
			JobType    string         `json:"jobType"`
			ResourceID string         `json:"resourceId"`
			Params     map[string]any `json:"params"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(emit), &e); err != nil || e.Channel != "job:create" {
		t.Fatalf("the last emit is not a job:create (%v):\n%s", err, emit)
	}
	if e.Payload.Params == nil {
		t.Errorf("job:create carries no params object; the schema requires one:\n%s", emit)
	}
	return e.Payload.JobType, e.Payload.ResourceID, e.Payload.Params
}

// The delegated form of mark is yield --delegate's sibling: it creates a job
// of the type its motivation names, and follows it to its end. The stack's
// worker reads the resource and writes the annotations.
func TestMarkDelegateFollowsJobToCompletion(t *testing.T) {
	s := busScenario(t)

	stdout, stderr, code := s.run(t, "mark", "--delegate", "res-1", "--motivation", "highlighting",
		"--instructions", "key claims", "--density", "5")
	if code != 0 {
		t.Fatalf("mark --delegate: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Annotating res-1", "highlighting", "fake-job-1", "Analyzing text", "3 highlights", "4 found")
	jobType, resourceID, params := jobCreate(t, lastEmit(t, s))
	if jobType != "highlight-annotation" || resourceID != "res-1" {
		t.Errorf("job:create asks for a %q job on %q, want highlight-annotation on res-1", jobType, resourceID)
	}
	if params["instructions"] != "key claims" || params["density"] != float64(5) {
		t.Errorf("the job's params are %v, want the instructions and a density of 5", params)
	}
	// The dispatcher refuses a job:create whose params name the resource: the
	// resource is the command's.
	if _, named := params["resourceId"]; named {
		t.Errorf("params names the resource, which the dispatcher refuses: %v", params)
	}

	// Linking: the entity types to detect, and descriptive references.
	stdout, stderr, code = s.run(t, "mark", "--delegate", "res-1", "--motivation", "linking",
		"--entity-type", "Person", "--entity-type", "Place", "--descriptive", "--source-language", "fr")
	if code != 0 {
		t.Fatalf("mark --delegate linking: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "4 references", "5 found", "1 error")
	jobType, _, params = jobCreate(t, lastEmit(t, s))
	if jobType != "reference-annotation" {
		t.Errorf("linking asks for a %q job, want reference-annotation", jobType)
	}
	if got := fmt.Sprint(params["entityTypes"]); got != "[Person Place]" || params["includeDescriptiveReferences"] != true || params["sourceLanguage"] != "fr" {
		t.Errorf("the linking job's params are %v", params)
	}

	// Tagging: a schema and the categories of it to tag.
	stdout, stderr, code = s.run(t, "mark", "--delegate", "res-1", "--motivation", "tagging",
		"--schema", "legal-irac", "--category", "issue", "--category", "rule", "--language", "de")
	if code != 0 {
		t.Fatalf("mark --delegate tagging: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "6 tags", "issue 2", "rule 4")
	jobType, _, params = jobCreate(t, lastEmit(t, s))
	if jobType != "tag-annotation" || params["schemaId"] != "legal-irac" || fmt.Sprint(params["categories"]) != "[issue rule]" || params["language"] != "de" {
		t.Errorf("tagging asks for a %q job with params %v", jobType, params)
	}

	// --json prints the completion as the stack sent it, and still succeeds.
	stdout, stderr, code = s.run(t, "mark", "--delegate", "res-1", "--motivation", "commenting", "--tone", "scholarly", "--json")
	if code != 0 {
		t.Fatalf("mark --delegate --json: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "raw completion", stdout, `"kind":"comment-annotation"`, `"commentsCreated":2`)
	if _, _, params = jobCreate(t, lastEmit(t, s)); params["tone"] != "scholarly" {
		t.Errorf("the commenting job's params are %v, want the tone", params)
	}
}

func TestMarkDelegateReportsJobFailure(t *testing.T) {
	s := busScenario(t, "FAKERT_JOB_FAIL=model refused")
	stdout, stderr, code := s.run(t, "mark", "--delegate", "res-1", "--motivation", "assessing")
	if code == 0 {
		t.Fatalf("a failed job must fail the command\nstdout:\n%s", stdout)
	}
	mustContain(t, "failure", stdout+stderr, "Annotation failed", "model refused")
	if strings.Contains(stdout, "Marked") {
		t.Errorf("claimed a mark that never happened:\n%s", stdout)
	}
}

// An annotation job is run again after a failed attempt. That failure is an
// event of a job still running: the worker says the queue will retry it, and a
// client that stopped there would report a recovering run as a failed one.
func TestMarkDelegateGoesOnThroughARetriedAttempt(t *testing.T) {
	s := busScenario(t, "FAKERT_JOB_RETRY=provider overloaded")
	stdout, stderr, code := s.run(t, "mark", "--delegate", "res-1", "--motivation", "highlighting")
	if code != 0 {
		t.Fatalf("a job that recovered on its second attempt failed the command: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "the retried attempt", stdout+stderr, "provider overloaded", "again")
	mustContain(t, "stdout", stdout, "3 highlights")
	if strings.Contains(stdout+stderr, "Annotation failed") {
		t.Errorf("a retried attempt was reported as the job's failure:\n%s", stdout+stderr)
	}
}

// A decline completes the job: the resource had no text to read. Nothing was
// annotated, so the command fails, in either output format, and does not call
// it a crash.
func TestMarkDelegateReportsADecline(t *testing.T) {
	s := busScenario(t, `FAKERT_JOB_RESULT={"kind":"declined","declined":true,"reason":"no-text-layer"}`)
	stdout, stderr, code := s.run(t, "mark", "--delegate", "res-1", "--motivation", "highlighting")
	if code == 0 {
		t.Fatalf("a declined job annotated nothing; exit 0 tells a script to carry on\nstdout:\n%s", stdout)
	}
	mustContain(t, "decline", stdout+stderr, "no-text-layer", "could not be recognized", "Nothing was annotated")
	if strings.Contains(stdout, "Marked") || strings.Contains(stdout+stderr, "Annotation failed") {
		t.Errorf("a decline is neither a mark nor a failure:\n%s", stdout+stderr)
	}
	stdout, _, code = s.run(t, "mark", "--delegate", "res-1", "--motivation", "highlighting", "--json")
	if code == 0 {
		t.Fatalf("--json must not turn a decline into a success\nstdout:\n%s", stdout)
	}
	mustContain(t, "raw completion", stdout, `"declined":true`, `"no-text-layer"`)
}

// The roots registry had an upsert and nothing else, so a row whose
// directory vanished (a moved KB, a deleted trial root) was permanent
// listing noise with no in-product removal — the same record-outlives-its-
// subject shape as the reaped-codespace bug. forget drops exactly one row;
// it deletes no files and no stack state.
func TestForgetDropsRegistryRow(t *testing.T) {
	s := newScenario(t, "container")
	seedRootsRegistry(t, s,
		`{"path":"/gone/trial-kb","did":"did:web:example.github.io:trial-kb","lastUsed":"2026-01-01T00:00:00Z"}`,
		`{"path":"/somewhere/else-kb","did":"did:web:example.org","lastUsed":"2026-02-01T00:00:00Z"}`)

	stdout, stderr, code := s.run(t, "forget", "trial-kb")
	if code != 0 {
		t.Fatalf("forget by basename: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "forget output", stdout+stderr, "Forgot", "/gone/trial-kb")
	b, _ := os.ReadFile(rootsPathFor(s.home))
	if strings.Contains(string(b), "/gone/trial-kb") {
		t.Errorf("forgotten row still in roots.json:\n%s", b)
	}
	mustContain(t, "surviving row", string(b), "/somewhere/else-kb")

	_, stderr, code = s.run(t, "forget", "nonesuch")
	if code != 1 {
		t.Fatalf("forget of an unregistered root: want exit 1, got %d", code)
	}
	mustContain(t, "unknown-root error", stderr, "not in the registry")
}

// State is keyed by did, so a moved KB's corpse row and its live twin share
// one state dir — forgetting the corpse must NOT suggest `clean --root
// <key>`, which would name the LIVE twin's state (observed live 2026-09-13:
// the hint offered to clean the running family stack's postgres).
func TestForgetCorpseWithLiveTwinSuggestsNoClean(t *testing.T) {
	s := newScenario(t, "container")
	corpse := nowhere(t, "old", "family")
	seedRootsRegistry(t, s,
		`{"path":"`+inJSON(corpse)+`","did":"did:web:pingel.org","lastUsed":"2026-01-01T00:00:00Z"}`,
		`{"path":"`+inJSON(s.kb)+`","did":"did:web:pingel.org","lastUsed":"2026-02-01T00:00:00Z"}`)
	// The shared state dir exists — the situation where the hint would fire.
	if err := os.MkdirAll(filepath.Join(stateRootFor(s.home, "pingel.org")), 0o755); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "forget", corpse)
	if code != 0 {
		t.Fatalf("forget: exit %d\nstderr:\n%s", code, stderr)
	}
	if strings.Contains(stdout+stderr, "semiont clean") {
		t.Errorf("forgetting a corpse suggested cleaning state its live twin still owns:\n%s", stdout+stderr)
	}
}

// A basename shared by two rows is exactly the moved-KB corpse situation —
// refusing with both full paths beats guessing which one dies.
func TestForgetRefusesAmbiguityAndRunningStack(t *testing.T) {
	s := newScenario(t, "container")
	seedRootsRegistry(t, s,
		`{"path":"/old/place/family","did":"did:web:pingel.org","lastUsed":"2026-01-01T00:00:00Z"}`,
		`{"path":"/new/place/family","did":"did:web:pingel.org","lastUsed":"2026-02-01T00:00:00Z"}`)
	_, stderr, code := s.run(t, "forget", "family")
	if code != 1 {
		t.Fatalf("ambiguous basename: want exit 1, got %d", code)
	}
	mustContain(t, "ambiguity error", stderr, "/old/place/family", "/new/place/family")

	// The running stack's row is refused — the registry is how status and
	// --root find it; stop first.
	seedRootsRegistry(t, s,
		`{"path":"`+inJSON(s.kb)+`","did":"did:web:running.example","lastUsed":"2026-03-01T00:00:00Z"}`)
	body := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"` + inJSON(s.kb) + `","services":{}}}}`
	if err := os.WriteFile(statePathFor(s.home), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code = s.run(t, "forget", s.kb)
	if code != 1 {
		t.Fatalf("forget of the running stack's root: want exit 1, got %d", code)
	}
	mustContain(t, "running-stack refusal", stderr, "running stack", "semiont stop")
	b, _ := os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "row kept", string(b), inJSON(s.kb))
}

// seedRootsRegistry writes roots.json with the given row literals.
func seedRootsRegistry(t *testing.T, s *scenario, rows ...string) {
	t.Helper()
	p := rootsPathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"schema":1,"roots":[` + strings.Join(rows, ",") + `]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The KNOWLEDGE BASES catalog outgrew the screen and pushed stack health
// out of view — `semiont roots` owns it now; status keeps the section
// header, a count + pointer, and one contextual line when cwd is a
// DIFFERENT KB than the running stack's root.
func TestRootsVerbOwnsTheCatalogStatusPoints(t *testing.T) {
	s := newScenario(t, "container")
	seedRootsRegistry(t, s,
		`{"path":"`+inJSON(s.kb)+`","did":"did:web:example.github.io:test-kb","siteName":"Test Knowledge Base","config":"anthropic","lastUsed":"2026-09-01T00:00:00Z"}`,
		`{"path":"/gone/other-kb","did":"did:web:example.org:other","lastUsed":"2026-08-01T00:00:00Z"}`)

	stdout, stderr, code := s.run(t, "roots")
	if code != 0 {
		t.Fatalf("roots: exit %d\nstderr:\n%s", code, stderr)
	}
	// The prefix tree splits shared path stems across lines, so assert
	// unsplit fragments: row details and leaf names, not full paths.
	mustContain(t, "roots stdout", stdout,
		"KNOWLEDGE BASES",
		"last used 2026-09-01",
		"did:web:example.github.io:test-kb — Test Knowledge Base",
		"config: anthropic (default)",
		"other-kb", "missing")

	stdout, _, _ = s.run(t, "status")
	mustContain(t, "status pointer", stdout, "KNOWLEDGE BASES", "2 known", "semiont roots")
	for _, leak := range []string{"last used", "did:web:example.org:other"} {
		if strings.Contains(stdout, leak) {
			t.Errorf("status still renders the catalog (%q):\n%s", leak, stdout)
		}
	}
}

// The one contextual fact the old tree carried at status-reading time:
// being inside template-kb while the stack runs family is a real gotcha.
func TestStatusFlagsCwdKBDifferentFromRunningStack(t *testing.T) {
	s := newScenario(t, "container")
	other := mkKB(t)
	body := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"` + inJSON(other) + `","services":{}}}}`
	if err := os.MkdirAll(filepath.Dir(statePathFor(s.home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePathFor(s.home), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, _ := s.run(t, "status") // cwd is s.kb — a KB, but not the stack's root
	mustContain(t, "cwd mismatch", stdout+stderr, "cwd KB: "+s.kb, "not the running stack's root")
	// Active stacks stay scannable in the slim section, addressed exactly
	// as their rows in `semiont roots` — find one there in one glance.
	mustContain(t, "active line", stdout, "active: file://"+other)
}

// --- SECRET-DELIVERY P4: the passwords of the daemons the launcher runs are
// the launcher's (D1, RULED: "B for daemons the launcher runs, and A's
// resolver for ones it doesn't") ---

// stagedFile reads a file the last start staged for its containers.
func stagedFile(t *testing.T, s *scenario, name string) string {
	t.Helper()
	log, _ := os.ReadFile(s.log)
	stages := s.stageRe().FindAllString(string(log), -1)
	if len(stages) == 0 {
		t.Fatalf("no staging dir in the argv log")
	}
	b, err := os.ReadFile(filepath.Join(stages[len(stages)-1], name))
	if err != nil {
		t.Fatalf("reading staged %s: %v", name, err)
	}
	return string(b)
}

// Each launcher-run daemon and every service that dials it get the same
// generated value, kept per root so a second start presents it again.
func TestLauncherRunDaemonsGetGeneratedPasswords(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start", "--config", "ollama-gemma"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	neo, _ := s.containerEnv(t, "semiont-neo4j", "NEO4J_AUTH")
	graphPw, ok := strings.CutPrefix(neo, "neo4j/")
	if !ok || len(graphPw) < 32 {
		t.Fatalf("Neo4j was not given a generated password: NEO4J_AUTH=%q", neo)
	}
	// Where KB skills are told to read it (FLEET-P4-DAEMON-PASSWORDS): the
	// layout is a contract with them, so a move breaks this first.
	kept, err := os.ReadFile(filepath.Join(stateRootFor(s.home, testKBKey), "neo4j-password"))
	if err != nil || strings.TrimSpace(string(kept)) != graphPw {
		t.Errorf("roots/<key>/neo4j-password does not hold Neo4j's password (read %q, %v)", kept, err)
	}
	for _, svc := range []string{"archivist", "librarian", "weaver"} {
		if v, _ := s.containerEnv(t, "semiont-"+svc, "NEO4J_PASSWORD"); v != graphPw {
			t.Errorf("%s reads [graph] but was handed NEO4J_PASSWORD=%q, want Neo4j's", svc, v)
		}
	}
	if _, handed := s.containerEnv(t, "semiont-smelter", "NEO4J_PASSWORD"); handed {
		t.Error("the smelter reads no [graph] but was handed its password")
	}
	if staged := stagedFile(t, s, "archivist.toml"); !regexp.MustCompile(`password = ['"]\$\{NEO4J_PASSWORD\}['"]`).MatchString(staged) {
		t.Errorf("the archivist's staged [graph] does not read ${NEO4J_PASSWORD}:\n%s", staged)
	}
	pg, _ := s.containerEnv(t, "semiont-postgres", "POSTGRES_PASSWORD")
	if len(pg) < 32 {
		t.Fatalf("PostgreSQL was not given a generated password: %q", pg)
	}
	if v, _ := s.containerEnv(t, "semiont-keycloak", "KC_DB_PASSWORD"); v != pg {
		t.Errorf("Keycloak dials PostgreSQL with %q, want PostgreSQL's own password", v)
	}

	// Kept, not regenerated: a data directory keeps the password it was
	// initialized with, so a second start must present the same one.
	s.killServes(t)
	if _, stderr, code := s.run(t, "start", "--config", "ollama-gemma"); code != 0 {
		t.Fatalf("second start: exit %d\n%s", code, stderr)
	}
	if again, _ := s.containerEnv(t, "semiont-neo4j", "NEO4J_AUTH"); again != neo {
		t.Errorf("the Neo4j password changed across starts: %q then %q", neo, again)
	}
}

// The launcher-run broker is always authenticated, and its pair reaches the
// two clients, each through the variables its document names.
func TestLauncherRunBrokerIsAuthenticated(t *testing.T) {
	s := newScenario(t, "container")
	src := filepath.Join(s.kb, ".semiont", "semiontconfig", "ollama-gemma.toml")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, []byte("\n[environments.local.signal]\ntype = \"nats\"\nservers = \"${NATS_HOST}:4222\"\n")...)
	if err := os.WriteFile(filepath.Join(s.kb, ".semiont", "semiontconfig", "broker.toml"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := s.run(t, "start", "--config", "broker"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	pw, _ := s.containerEnv(t, "semiont-nats", "NATS_PASSWORD")
	if len(pw) < 32 {
		t.Fatalf("the broker was not given a generated password: %q", pw)
	}
	mustContain(t, "argv log", s.argv(t), "-c /etc/nats/semiont.conf")
	for _, c := range []string{"semiont-nats", "semiont-dispatcher", "semiont-gateway"} {
		if u, _ := s.containerEnv(t, c, "NATS_USER"); u != "semiont" {
			t.Errorf("%s: NATS_USER=%q, want semiont", c, u)
		}
		if v, _ := s.containerEnv(t, c, "NATS_PASSWORD"); v != pw {
			t.Errorf("%s: NATS_PASSWORD=%q, want the broker's", c, v)
		}
	}
	mustContain(t, "the dispatcher's document", stagedFile(t, s, "dispatcher.json"), `"passwordEnv": "NATS_PASSWORD"`)
	mustContain(t, "the gateway's document", stagedFile(t, s, "gateway.json"), `"passwordEnv": "NATS_PASSWORD"`)
}

// A config key naming a launcher-run daemon's credential is refused, naming
// its owner: two places deciding one password is the thing we do not do.
func TestConfigNamingALauncherRunDaemonPasswordIsRefused(t *testing.T) {
	s := newScenario(t, "container")
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", "ollama-gemma.toml")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	named := strings.Replace(string(b), "username = \"neo4j\"\n", "username = \"neo4j\"\npassword = \"localpass\"\n", 1)
	if named == string(b) {
		t.Fatal("the fixture's [graph] has no username line to anchor on")
	}
	if err := os.WriteFile(p, []byte(named), 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "start", "--config", "ollama-gemma")
	if code == 0 {
		t.Fatal("started with a config naming the password of a Neo4j the launcher runs")
	}
	mustContain(t, "stderr", stderr, "[environments.local.graph]", "password", "the launcher generates")
}

// Ruled: an exported daemon password is refused, not honoured — it would only
// disagree with the store it was meant for.
func TestExportedDaemonPasswordIsRefused(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "NEO4J_PASSWORD=mine")
	_, stderr, code := s.run(t, "start", "--config", "ollama-gemma")
	if code == 0 {
		t.Fatal("started with an exported NEO4J_PASSWORD")
	}
	mustContain(t, "stderr", stderr, "NEO4J_PASSWORD", "the launcher generates")
}

// A store that holds data but no kept password was initialized with one the
// launcher does not have (the old literal, or custody lost): refuse, naming
// the clean, rather than start a daemon that rejects every login.
func TestStoreWithoutItsPasswordRefusesNamingTheClean(t *testing.T) {
	s := newScenario(t, "container")
	data := filepath.Join(stateRootFor(s.home, testKBKey), "neo4j", "data", "databases")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "store_lock"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "start", "--config", "ollama-gemma")
	if code == 0 {
		t.Fatal("started Neo4j over a store initialized with a password the launcher does not hold")
	}
	mustContain(t, "stderr", stderr, "semiont clean --store graph")
}

// The daemon names are the launcher's: `semiont secret set` refuses them, as
// it refuses the other values custody owns.
func TestSecretSetRefusesADaemonPassword(t *testing.T) {
	s := newScenario(t, "container", "op")
	_, stderr, code := s.run(t, "settings", "secret", "set", "NEO4J_PASSWORD", "op://OSS/Neo4j/password")
	if code == 0 {
		t.Fatal("registered a source for a password the launcher generates")
	}
	mustContain(t, "stderr", stderr, "NEO4J_PASSWORD")
}

// The dispatcher's queue is JetStream: it holds no state tree for another
// driver to write, so a config whose [jobs] selects any other driver is refused
// at start, naming the driver it needs — before any container runs, where it
// used to surface as a dispatcher that exited at boot and was given up on.
func TestStartRefusesAJobsDriverTheDispatcherCannotRun(t *testing.T) {
	s := newScenario(t, "container")
	src := filepath.Join(s.kb, ".semiont", "semiontconfig", "ollama-gemma.toml")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	b = []byte(strings.Replace(string(b), "type = \"jetstream\"", "type = \"fs\"", 1))
	if err := os.WriteFile(filepath.Join(s.kb, ".semiont", "semiontconfig", "fs-jobs.toml"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "start", "--config", "fs-jobs")
	if code == 0 {
		t.Fatalf("start accepted a [jobs] driver the dispatcher cannot run")
	}
	mustContain(t, "fs-jobs refusal", stderr, "dispatcher", "jetstream")
	if strings.Contains(s.argv(t), "run -d --name semiont-dispatcher") {
		t.Errorf("the dispatcher was started before the refusal")
	}
}

// D9's same-server refusal: one role is one daemon. Two sections naming two
// different servers is a configuration error stated at plan time, naming
// both sections — never silently reconciled.
func TestStartRefusesMismatchedMessagingServers(t *testing.T) {
	s := newScenario(t, "container")
	src := filepath.Join(s.kb, ".semiont", "semiontconfig", "ollama-gemma.toml")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, []byte("\n[environments.local.signal]\ntype = \"nats\"\nservers = \"other.host:4222\"\n")...)
	if err := os.WriteFile(filepath.Join(s.kb, ".semiont", "semiontconfig", "mismatch.toml"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := s.run(t, "start", "--config", "mismatch")
	if code == 0 {
		t.Fatalf("start accepted mismatched [jobs]/[signal] servers")
	}
	mustContain(t, "mismatch refusal", stderr, "[jobs] and [signal] name different servers", "must match")
}

// EXTERNAL-IDENTITY P3 (launcher lane): a config whose [environments.*.identity]
// selects keycloak and leaves its issuer to the launcher boots Keycloak after
// PostgreSQL and before the gateway — its database created on that PostgreSQL
// if absent, the realm file staged and imported, the bootstrap admin password
// per root — and every service's staged config states the issuer. The no-identity-section case is
// proven by every other boot golden: only the preflight logs snapshot grows.
// writeKeycloakConfig REPLACES the KB config's [identity] section and returns
// the config name to select with --config.
func writeKeycloakConfig(t *testing.T, s *scenario) string {
	t.Helper()
	return writeConfigWithIdentity(t, s, "keycloak",
		"[environments.local.identity]\ntype = \"keycloak\"\nissuer = \"http://${KEYCLOAK_HOST}:8080/realms/semiont\"\nsubjectClaim = \"sub\"\n")
}

// writeConfigWithIdentity copies the KB's base config with its [identity]
// section SWAPPED for the given one. Replaced, never appended: every base
// config carries an identity now, and a second table of the same name is not
// valid TOML — the whole file is refused before any of it is read.
func writeConfigWithIdentity(t *testing.T, s *scenario, name, identity string) string {
	t.Helper()
	src := filepath.Join(s.kb, ".semiont", "semiontconfig", "ollama-gemma.toml")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	body := stripTOMLTable(string(b), "[environments.local.identity]") + "\n" + identity
	if err := os.WriteFile(filepath.Join(s.kb, ".semiont", "semiontconfig", name+".toml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return name
}

// stripTOMLTable removes one table header and the keys under it — up to the
// next header or the end of the file.
func stripTOMLTable(doc, header string) string {
	var out []string
	skipping := false
	for _, line := range strings.Split(doc, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == header:
			skipping = true
		case skipping && strings.HasPrefix(trimmed, "["):
			skipping = false
			out = append(out, line)
		case !skipping:
			out = append(out, line)
		}
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n") + "\n"
}

// The identity path in PLAN mode. Both dry-run goldens take the "no [identity]
// section" branch, so everything the launched-Keycloak path narrates — the
// realm document's clients, the database creation, and the service-account
// preflight — was covered by no golden at all. That is how the realm line came
// to describe a document six clients smaller than the one it writes.
func TestStartDryRunKeycloakIdentity(t *testing.T) {
	s := newScenario(t, "container")
	cfg := writeKeycloakConfig(t, s)
	stdout, stderr, code := s.run(t, "start", "--config", cfg, "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "start-dryrun-keycloak-identity.txt", s.norm(stdout))
	if got := s.argv(t); got != "git -C <kb-root> rev-parse --show-toplevel\n" {
		t.Errorf("dry run executed external commands:\n%s", got)
	}
}

func TestStartKeycloakIdentityBoot(t *testing.T) {
	s := newScenario(t, "container")
	// Pinned like JWT_SECRET: a generated password is random and the golden
	// compares argv verbatim.
	s.extraEnv = append(s.extraEnv, "KC_BOOTSTRAP_ADMIN_PASSWORD=test-keycloak-admin")
	cfg := writeKeycloakConfig(t, s)
	if _, stderr, code := s.run(t, "start", "--config", cfg); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "start-keycloak-identity-boot.argv", s.argv(t))
	// The database is created on stdin, where fakert records what the pipe
	// carried — idempotently, so the second start is a no-op there too.
	in, err := os.ReadFile(filepath.Join(s.fakertDir, "exec-stdin.txt"))
	if err != nil {
		t.Fatalf("no exec stdin recorded — the keycloak database was never created: %v", err)
	}
	mustContain(t, "create database", string(in), "CREATE DATABASE keycloak", "WHERE NOT EXISTS", `\gexec`)
	// Keycloak's admin was opened to this machine, and the bootstrap password
	// reached kcadm through the runtime's environment — the golden above shows
	// argv naming it without a value.
	pw, err := os.ReadFile(filepath.Join(s.fakertDir, "kc-cli-password.txt"))
	if err != nil {
		t.Fatalf("no KC_CLI_PASSWORD reached an exec — Keycloak's admin was never opened to this machine: %v", err)
	}
	if string(pw) != "test-keycloak-admin" {
		t.Errorf("kcadm received KC_CLI_PASSWORD %q, want the bootstrap admin's", pw)
	}
	// The identity preflight ran. Without this, a start that silently SKIPPED
	// the check would pass every assertion above: the preflight issues no
	// container command, so the argv golden cannot see it either way.
	cc, err := os.ReadFile(filepath.Join(s.fakertDir, "client-credentials.txt"))
	if err != nil {
		t.Fatalf("no client-credentials grant reached the issuer — the identity preflight did not run: %v", err)
	}
	if got := strings.TrimSpace(string(cc)); !strings.HasPrefix(got, "semiont-") {
		t.Errorf("preflight presented an unexpected client id: %q", got)
	}
}

// writeExternalIssuerConfig: an [identity] naming an issuer on a host the
// launcher does NOT run — `type = "oidc"`, the bring-your-own-IdP shape.
func writeExternalIssuerConfig(t *testing.T, s *scenario) string {
	t.Helper()
	return writeConfigWithIdentity(t, s, "external-oidc",
		"[environments.local.identity]\ntype = \"oidc\"\nissuer = \"https://id.example.com/realms/semiont\"\nsubjectClaim = \"sub\"\n")
}

// An issuer someone else runs gets the SAME preflight as one the launcher
// starts — and needs it more. A launcher-run realm is imported from the
// launcher's own document and is correct by construction; an external one had
// its clients created by hand.
//
// Until this, `type = "oidc"` reached NO preflight at all: the external branch
// verified TCP reachability and launched nothing, so a realm missing every
// service account — or one nobody could sign in to — started nine containers
// happily. Reachability is not configuration.
func TestStartDryRunExternalIssuerIsPreflighted(t *testing.T) {
	s := newScenario(t, "container")
	cfg := writeExternalIssuerConfig(t, s)
	stdout, stderr, code := s.run(t, "start", "--config", cfg, "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	const iss = "https://id.example.com/realms/semiont"
	mustContain(t, "plan", stdout,
		// the six machine identities, against the CONFIGURED issuer rather
		// than identityEndpoint's localhost form
		"client-credentials grant at "+iss+" as semiont-gateway",
		"client-credentials grant at "+iss+" as semiont-worker",
		// and the two clients people sign in through
		"device authorization at "+iss+" as semiont-cli",
		"authorization request at "+iss+" as semiont-browser",
		"PKCE is enforced rather than merely offered",
		"sending no credential — require both to refuse it",
	)
	// Verified, never launched.
	if strings.Contains(stdout, "--name semiont-keycloak") {
		t.Error("an external issuer was launched")
	}
}

// LAUNCHER-SERVICE-MODEL P4. `start --service <role>` used to reach a SECOND
// implementation of the per-role launch — flowOneService carried its own
// copy of the dependency-role branch that flowFullStart reaches through
// flowDepRole. Two implementations of one launch drift, and a drift here is
// a container that runs with different arguments depending on which verb
// started it.
//
// The full start's dry-run is the argv every role's launch is already pinned
// to. This requires the single-service dry-run to produce the SAME line.
func TestSingleServiceStartIssuesTheSameArgvAsAFullStart(t *testing.T) {
	runLine := func(t *testing.T, transcript, container string) string {
		t.Helper()
		for _, line := range strings.Split(transcript, "\n") {
			if _, rest, ok := strings.Cut(line, " run -d --name "); ok {
				if name, _, _ := strings.Cut(rest, " "); name == container {
					return line
				}
			}
		}
		return ""
	}

	s := newScenario(t, "container")
	full, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("full dry run: exit %d\nstderr:\n%s", code, stderr)
	}
	full = s.norm(full)

	for _, role := range []string{"traces", "metrics", "collector", "database", "identity", "graph", "vectors", "gateway", "archivist", "librarian", "dispatcher", "worker", "smelter", "weaver"} {
		t.Run(role, func(t *testing.T) {
			one, stderr, code := s.run(t, "start", "--service", role, "--dry-run")
			if code != 0 {
				t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
			}
			one = s.norm(one)
			// The container this role runs, read out of the full start so
			// the test needs no second copy of the names.
			var container string
			for _, line := range strings.Split(full, "\n") {
				if _, rest, ok := strings.Cut(line, " run -d --name "); ok {
					if name, _, _ := strings.Cut(rest, " "); strings.Contains(name, roleContainerHint(role)) {
						container = name
						break
					}
				}
			}
			if container == "" {
				t.Skipf("the full start launches no container for %s in this config", role)
			}
			// The ONE documented difference, stripped before comparing: a
			// single-service start enables OTel export iff the collector is
			// already up (`start --help`), and in a dry run it is not. Every
			// other argument must be identical.
			stripOtel := func(line string) string {
				out := []string{}
				for _, f := range strings.Fields(line) {
					if strings.HasPrefix(f, "OTEL_EXPORTER_OTLP_ENDPOINT=") {
						out = out[:len(out)-1] // drop the --env that introduced it
						continue
					}
					out = append(out, f)
				}
				return strings.Join(out, " ")
			}
			want, got := stripOtel(runLine(t, full, container)), stripOtel(runLine(t, one, container))
			if got == "" {
				t.Fatalf("--service %s launched no %s; the full start runs\n  %s", role, container, want)
			}
			if got != want {
				t.Errorf("--service %s issues different argv than the full start:\n  full    %s\n  service %s", role, want, got)
			}
		})
	}
}

// roleContainerHint: the wire-level name fragment a role's container carries.
// Read from the launcher's own vocabulary would be better, but the black-box
// suite deliberately cannot see inside the package.
func roleContainerHint(role string) string {
	switch role {
	case "traces":
		return "jaeger"
	case "metrics":
		return "prometheus"
	case "collector":
		return "otel-collector"
	case "database":
		return "postgres"
	case "identity":
		return "keycloak"
	case "graph":
		return "neo4j"
	case "vectors":
		return "qdrant"
	}
	return role
}
