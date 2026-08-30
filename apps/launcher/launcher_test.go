// Golden tests for the semiont launcher — the executable spec ported from
// the fleet's start.sh/logs.sh/stop.sh (GO-LAUNCHER.md §3).
//
// Everything external is faked: a private PATH holds one binary (fakert)
// symlinked as container/docker/podman/git/lsof/ps/pgrep, which records every
// invocation to an argv log and plays scripted responses. Detached `run -d`
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
	"syscall"
	"testing"
	"time"
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
	if pre, _ := filepath.Glob("/tmp/semiont-config.*"); len(pre) > 0 {
		fmt.Fprintf(os.Stderr, "refusing to run: %v exist — a live stack may mount them (run semiont stop, or test in a container)\n", pre)
		os.Exit(1)
	}
	binDir, err := os.MkdirTemp("", "launcher-bins")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(binDir)
	launcherBin = filepath.Join(binDir, "semiont")
	fakertBin = filepath.Join(binDir, "fakert")
	for target, pkg := range map[string]string{launcherBin: ".", fakertBin: "./internal/fakert"} {
		out, err := exec.Command("go", "build", "-o", target, pkg).CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr, "building %s: %v\n%s", pkg, err, out)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}

// shimDir builds a private PATH dir where fakert impersonates the given
// runtimes plus git/lsof/ps/pgrep (always present).
func shimDir(t *testing.T, runtimes ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range append([]string{"git", "lsof", "ps", "pgrep"}, runtimes...) {
		if err := os.Symlink(fakertBin, filepath.Join(dir, name)); err != nil {
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
	shim           string
	kb             string // also FAKERT_GIT_ROOT unless gitRoot overridden
	noGitRoot      bool
	noWorkerSecret bool   // drop SEMIONT_WORKER_SECRET from the env
	noJWTSecret    bool   // drop JWT_SECRET from the env (exercise generate + persist)
	cwd            string // launcher working dir; defaults to kb
	home           string
	fakertDir      string
	log            string
	extraEnv       []string
	stdin          string
}

func newScenario(t *testing.T, runtimes ...string) *scenario {
	t.Helper()
	s := &scenario{
		shim:      shimDir(t, runtimes...),
		kb:        mkKB(t),
		home:      t.TempDir(),
		fakertDir: t.TempDir(),
	}
	s.log = filepath.Join(s.fakertDir, "argv.log")
	t.Cleanup(func() { s.killServes() })
	return s
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
// waiting for each to actually die — the next test rebinds the same fixed
// ports, and a merely-signalled process can still hold them for a beat.
func (s *scenario) killServes() {
	pidfiles, _ := filepath.Glob(filepath.Join(s.fakertDir, "serve-*.pid"))
	var pids []int
	for _, pf := range pidfiles {
		b, err := os.ReadFile(pf)
		if err != nil {
			continue
		}
		// Pidfiles are "pid\n<ports>" (fakert records the ports so its own
		// stop can wait for their release) — parse the FIRST line only.
		first := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)[0]
		if pid, err := strconv.Atoi(strings.TrimSpace(first)); err == nil {
			pids = append(pids, pid)
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		}
		_ = os.Remove(pf)
	}
	deadline := time.Now().Add(3 * time.Second)
	for _, pid := range pids {
		for time.Now().Before(deadline) && syscall.Kill(pid, 0) == nil {
			time.Sleep(20 * time.Millisecond)
		}
	}
}

func (s *scenario) env() []string {
	env := []string{
		"PATH=" + s.shim,
		"HOME=" + s.home,
		"FAKERT_LOG=" + s.log,
		"FAKERT_DIR=" + s.fakertDir,
	}
	if !s.noWorkerSecret {
		env = append(env, "SEMIONT_WORKER_SECRET=test-worker-secret")
	}
	// Pinned for the same reason as the worker secret: a generated one is
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

var stageRe = regexp.MustCompile(`/tmp/semiont-config\.[A-Za-z0-9]+`)

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
	out := strings.ReplaceAll(text, s.kb, "<kb-root>")
	out = stageRe.ReplaceAllString(out, "<config-stage>")
	out = strings.ReplaceAll(out, s.home, "<home>")
	return out
}

func checkGolden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "golden", name)
	if *updateGoldens {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update-goldens after adjudicating): %v", name, err)
	}
	if string(want) != got {
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
	// The worker secret must never reach the terminal: echoed commands
	// redact secret-valued envs (the real argv, in the argv log, keeps it).
	if strings.Contains(stdout, "test-worker-secret") {
		t.Error("worker secret leaked into stdout")
	}
	mustContain(t, "stdout", stdout, "SEMIONT_WORKER_SECRET=<redacted>")
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

func TestStartRuntimeDockerBoot(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	s.extraEnv = append(s.extraEnv, "FAKERT_NSLOOKUP=ok")
	stdout, stderr, code := s.run(t, "start", "--runtime", "docker")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-docker-boot.argv", s.argv(t))
}

func TestStartNoObserveBoot(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--no-observe")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-no-observe-boot.argv", s.argv(t))
	if strings.Contains(stdout, "16686") {
		t.Errorf("--no-observe stdout mentions Jaeger:\n%s", stdout)
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
		"register a secret source once:  semiont secret set ANTHROPIC_API_KEY")
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
		"This is not a Semiont container. Stop it and re-run (e.g. kill 12345).")
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
	mustContain(t, "stderr", stderr, "Config not found: .semiont/semiontconfig/nope.toml")
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

// stateRootFor mirrors the launcher's per-root state dir (dataDir) for the
// scenario's fake HOME — GOOS-aware like statePathFor, though the suite's
// home is the linux golang container in practice.
func stateRootFor(home, key string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "semiont", "roots", key)
	}
	return filepath.Join(home, ".local", "share", "semiont", "roots", key)
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
	mustContain(t, "meta.json", string(meta), "postgres:15.18-alpine", s.kb)
	if _, err := os.Stat(filepath.Join(dir, "postgres")); err != nil {
		t.Fatalf("postgres state dir after start: %v", err)
	}
	// A second start must REUSE the same dir — that is the whole feature:
	// the mount appears in both boots' argv, same path both times.
	s.killServes()
	_, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstderr:\n%s", code, stderr)
	}
	mount := dir + "/postgres:/var/lib/postgresql/data"
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
	mount := dir + "/anchored-text:/anchored-text"
	firstBoot := strings.Count(string(s.mustLog(t)), mount)

	s.killServes()
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
	meta := `{"kbRoot":"` + s.kb + `","stores":{"database":{"image":"postgres:14.9-alpine"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
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
	meta := `{"kbRoot":"` + s.kb + `","stores":{"graph":{"image":"neo4j:5.20.0-community"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
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
	// ...while their UNMOUNTED parent is clamped owner-only, so the 0777
	// leaves nothing traversable by other local users.
	if fi, err := os.Stat(filepath.Join(dir, "neo4j")); err != nil {
		t.Fatalf("neo4j store dir: %v", err)
	} else if perm := fi.Mode().Perm(); perm != 0o700 {
		t.Errorf("neo4j store dir mode = %o, want 700 (owner-only parent clamp)", perm)
	}
}

func TestStartWarnsWhenEnvConfigOverridesIdentity(t *testing.T) {
	// KB-IDENTITY-VS-ADDRESS P4 (decision 10). A KB has ONE committed identity
	// (.semiont/config [site] domain) but the semiontconfig's environment
	// section can carry its own [site], and the TOML loader resolves the
	// agents' domain as `resolved.site ?? projectSite` — so an environment
	// [site] replaces the KB's committed identity for every agent did, while
	// the KB's own did (from the committed file) stays put. One logical KB,
	// two identity roots.
	//
	// It WARNS rather than refuses: overriding can be deliberate (decision
	// 10). What is forbidden is doing it invisibly. The launcher's own
	// generated configs never contain a [site] section, so a divergence means
	// a human hand-edited one — a small, deliberate population worth telling.
	withSite := func(t *testing.T, s *scenario, site string) {
		t.Helper()
		writeKBConfig(t, s, "sited", stdGraph+stdVectors+stdEmbedding+stdDatabase+site)
	}

	// 1. A DIFFERENT domain: legitimate, but the operator should know.
	s := newScenario(t, "container")
	withSite(t, s, "[environments.local.site]\ndomain = \"elsewhere.example:other-kb\"\n")
	stdout, stderr, code := s.run(t, "start", "--config", "sited", "--dry-run")
	if code != 0 {
		t.Fatalf("divergent site must warn, not refuse: exit %d\nstderr:\n%s", code, stderr)
	}
	// Asserted on STDOUT alone, not stdout+stderr: a warning split across two
	// streams reads fine in a terminal and falls apart the moment either is
	// piped, and a combined assertion cannot tell the difference.
	mustContain(t, "divergence warning", stdout,
		"example.github.io:test-kb", // the KB's committed identity
		"elsewhere.example:other-kb",
		"agent identities")

	// 2. A [site] section with NO domain — the shape someone gets by adding the
	// section for `oauthAllowedDomains` alone. This USED to be the one nobody
	// intends: the loader substituted the literal 'localhost' and the agents
	// collided with every other such KB on the machine. The loader no longer
	// manufactures a domain, so the gateway falls back to the KB's committed
	// identity, nothing diverges, and there is nothing to warn about.
	s2 := newScenario(t, "container")
	withSite(t, s2, "[environments.local.site]\noauthAllowedDomains = [\"example.com\"]\n")
	stdout, stderr, code = s2.run(t, "start", "--config", "sited", "--dry-run")
	if code != 0 {
		t.Fatalf("domain-less site must not refuse: exit %d\nstderr:\n%s", code, stderr)
	}
	for _, absent := range []string{"did:web:localhost", "declares no domain", "overrides the KB's declared identity"} {
		if strings.Contains(stdout, absent) {
			t.Errorf("domain-less [site] no longer diverges, so %q must not appear:\n%s", absent, stdout)
		}
	}

	// 3. No environment [site] at all — every launcher-generated config. This
	// is the case that must stay SILENT; a warning here would be pure noise
	// on the overwhelmingly common path.
	s3 := newScenario(t, "container")
	stdout, stderr, code = s3.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("plain start: exit %d\nstderr:\n%s", code, stderr)
	}
	// Assert on the warning's OWN phrases, not generic words: the scenario's
	// tmpdir carries this test's name, so "identity"/"overrid" match the paths
	// in every plan line and would fail no matter what the code did.
	for _, noisy := range []string{"agent identities", "did:web:localhost"} {
		if strings.Contains(stdout+stderr, noisy) {
			t.Errorf("a config with no [site] section must not warn (%q):\n%s", noisy, stdout+stderr)
		}
	}

	// 4. A KB with no committed domain already REFUSES (decision 8); it must
	// not also collect this warning. Two messages for one condition is worse
	// than one.
	s4 := newScenario(t, "container")
	withSite(t, s4, "[environments.local.site]\ndomain = \"elsewhere.example:other-kb\"\n")
	if err := os.WriteFile(filepath.Join(s4.kb, ".semiont", "config"),
		[]byte("[project]\nname = \"No Did KB\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code = s4.run(t, "start", "--config", "sited", "--dry-run")
	if code != 1 {
		t.Fatalf("did-less KB must still refuse: exit %d", code)
	}
	if strings.Contains(stdout+stderr, "elsewhere.example:other-kb") {
		t.Errorf("refusal must not also carry the override warning:\n%s", stdout+stderr)
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
	mustContain(t, "state key", stdout, "roots/example.github.io-no-did-kb/postgres")
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
	meta := `{"kbRoot":"` + s.kb + `","did":"did:web:example.github.io:test-kb","stores":{` +
		`"database":{"image":"postgres:15.18-alpine"},` +
		`"vectors":{"image":"qdrant/qdrant:v1.18.3"},` +
		`"graph":{"image":"neo4j:5.26.28-community"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
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
}

func TestCleanRemovesRootState(t *testing.T) {
	s := newScenario(t)
	dir := seedStateDir(t, s)
	stdout, stderr, code := s.run(t, "clean")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "clean", stdout, "Removed")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("state dir survived clean: %v", err)
	}
}

func TestCleanStoreScopes(t *testing.T) {
	s := newScenario(t)
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
}

func TestCleanRefusesRunningStack(t *testing.T) {
	s := newScenario(t)
	seedStateDir(t, s)
	// A recorded local stack on this root: clean must refuse — those dirs
	// may be mounted right now.
	stack := `{"schema":3,"stacks":{"local":{"runtime":"container","kbRoot":"` + s.kb +
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
	s := newScenario(t)
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
		"roots/"+testKBKey,
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
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "semiont", "tokens.json")
	}
	return filepath.Join(home, ".local", "state", "semiont", "tokens.json")
}

func TestLoginStoresTokenNeverPassword(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	// Password arrives on stdin — never argv (ps/history), never env.
	s.stdin = "hunter2secret\n"
	stdout, stderr, code := s.run(t, "login", "--email", "admin@example.com")
	if code != 0 {
		t.Fatalf("login: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Logged in", "admin@example.com")
	b, err := os.ReadFile(tokensPathFor(s.home))
	if err != nil {
		t.Fatalf("tokens.json after login: %v", err)
	}
	mustContain(t, "tokens.json", string(b), "fake-jwt-token", `"local"`)
	if fi, err := os.Stat(tokensPathFor(s.home)); err == nil {
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Errorf("tokens.json mode = %o, want 600 (it holds a bearer token)", perm)
		}
	}
	// The password exists NOWHERE after the command: not in any launcher
	// file, not echoed. (Same discipline as the secret tests.)
	for _, f := range []string{tokensPathFor(s.home), statePathFor(s.home), rootsPathFor(s.home)} {
		if fb, err := os.ReadFile(f); err == nil && strings.Contains(string(fb), "hunter2secret") {
			t.Errorf("password persisted in %s", f)
		}
	}
	if strings.Contains(stdout, "hunter2secret") {
		t.Error("password echoed to stdout")
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
		case "login":
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
	s.stdin = "hunter2secret\n"
	_, stderr, code := s.run(t, "login", "--email", "a@b.example")
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
		s.stdin = "hunter2secret\n"
		if _, stderr, code := s.run(t, "login", "--email", "admin@example.com"); code != 0 {
			t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
		}
		s.stdin = ""
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
	mustContain(t, "stdout", stdout, "Logged out", "local")
	if tb, err := os.ReadFile(tokensPathFor(s.home)); err == nil {
		if strings.Contains(string(tb), "fake-jwt-token") {
			t.Errorf("token survived logout:\n%s", tb)
		}
	}
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
	s.stdin = "hunter2secret\n"
	if _, stderr, code := s.run(t, "login", "--email", "admin@example.com"); code != 0 {
		t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
	}
	s.stdin = ""
	stdout, _, _ = s.run(t, "status", "--verbose")
	mustContain(t, "session row", stdout, "SESSIONS", "local", "admin@example.com", "valid")
}

// --- stop ---

func TestStopSweepsAllRuntimes(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	// Simulate leftover staging from a previous run.
	stage, err := os.MkdirTemp("/tmp", "semiont-config.")
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "stop-all-runtimes.argv", s.argv(t))
	mustContain(t, "stdout", stdout,
		"Sweeping 11 container(s) across container, docker, podman",
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
	checkGolden(t, "stop-dryrun.txt", stdout)
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
		"LOCAL STACK", "database (PostgreSQL)", // tech rides in the SERVICE cell now
		"PostgreSQL", "Neo4j", "Qdrant", "Ollama", "Jaeger",
		"LOCAL ROOTS",
		"(discovered from cwd)",
		// The merged STATUS cell: mark + word, probe dimmed after. The
		// diagnostic matrix each word pins: running-and-healthy, running-
		// but-unhealthy, crashed, absent, host-provided.
		"✓ running", "✗ running", "✗ exited", "✗ absent", "✓ reachable",
		"http://localhost:4000/api/health",
		"http://localhost:9090/health",
		"tcp://localhost:5432",
	)
	// LAUNCHER PATHS describes the launcher, not any KB — asked for, not shown.
	if strings.Contains(stdout, "LAUNCHER PATHS") {
		t.Errorf("default status printed LAUNCHER PATHS without --verbose:\n%s", stdout)
	}
	vstdout, _, vcode := s.run(t, "status", "--verbose")
	if vcode != 0 {
		t.Fatalf("status --verbose: exit %d", vcode)
	}
	mustContain(t, "verbose stdout", vstdout,
		"LAUNCHER PATHS", "config", "cache", "staging", "/tmp/semiont-config.*")

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
	serveHealth(t, 4000, 9090, 9091, 9092, 9093, 9094, 3000, 7474, 6333, 5432, 11434)
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
	return filepath.Join(home, ".local", "state", "semiont", "launcher.log")
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

	// No running gateway anywhere: pointed failure.
	s.stdin = secret + "\n"
	_, stderr, code := s.run(t, "useradd", "--email", "a@b.co")
	if code != 1 {
		t.Fatalf("no-gateway useradd: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"useradd needs a running gateway", "semiont start")

	// Name-scan fallback: the runtime whose listing shows semiont-gateway.
	s.extraEnv = append(s.extraEnv, "FAKERT_STACK_RUNTIME=docker")
	s.stdin = secret + "\n"
	stdout, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--admin")
	if code != 0 {
		t.Fatalf("useradd: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ := os.ReadFile(s.log)
	// -i so the pipe reaches the container; --password-stdin tells the gateway
	// to read it there.
	mustContain(t, "argv log", string(log),
		"docker exec -i semiont-gateway semiont-useradd --email a@b.co --admin --password-stdin")
	// The secret reached the gateway — through the PIPE, not the command line.
	stdinSeen, err := os.ReadFile(filepath.Join(s.fakertDir, "exec-stdin.txt"))
	if err != nil {
		t.Fatalf("no exec stdin captured: %v", err)
	}
	if strings.TrimSpace(string(stdinSeen)) != secret {
		t.Errorf("password did not arrive on stdin; got %q", stdinSeen)
	}
	for what, text := range map[string]string{"argv log": string(log), "stdout": stdout} {
		if strings.Contains(text, secret) {
			t.Errorf("password leaked into the %s:\n%s", what, text)
		}
	}

	// The removed --password flag is refused with the way that replaced it —
	// it is documented in enough places that a bare "unknown flag" would read
	// as a launcher bug.
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--password", secret); code != 1 {
		t.Errorf("--password should be refused, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "--password", "no longer accepted", "--generate-password")
	}

	// Record-driven: recorded runtime + container ID beat the name scan. With
	// --generate-password the gateway invents one, so nothing is read or piped.
	writeStackState(t, s, "container")
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	s.stdin = ""
	if _, stderr, code := s.run(t, "useradd", "--email", "b@c.co", "--generate-password"); code != 0 {
		t.Fatalf("record-driven useradd: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ = os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"container exec fid-semiont-gateway semiont-useradd --email b@c.co --generate-password")
	if strings.Contains(string(log), "--password-stdin") {
		t.Error("--generate-password must not also ask for a password on stdin")
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

	// --update on an existing user needs no password (the gateway only
	// requires one to CREATE), so nothing is prompted or piped.
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := s.run(t, "useradd", "--email", "b@c.co", "--update", "--admin"); code != 0 {
		t.Fatalf("update useradd: exit %d\nstderr:\n%s", code, stderr)
	}
	if log, _ = os.ReadFile(s.log); strings.Contains(string(log), "--password-stdin") {
		t.Error("--update must not demand a password")
	}

	// A create with nothing on stdin cannot proceed — say so rather than
	// hanging or sending an empty password.
	s.stdin = ""
	if _, stderr, code := s.run(t, "useradd", "--email", "d@e.co"); code != 1 {
		t.Errorf("empty stdin should fail, got exit %d", code)
	} else {
		mustContain(t, "stderr", stderr, "password")
	}

	// The in-container CLI failing surfaces as a launcher failure.
	s.extraEnv = append(s.extraEnv, "FAKERT_EXEC_FAIL=1")
	s.stdin = secret + "\n"
	if _, stderr, code := s.run(t, "useradd", "--email", "c@d.co"); code != 1 {
		t.Fatalf("exec failure: want exit 1, got %d\nstderr:\n%s", code, stderr)
	}

	// Bare useradd prints usage and fails; --help succeeds.
	if _, _, code := s.run(t, "useradd"); code != 1 {
		t.Error("bare useradd should exit 1")
	}
	stdout, _, code = s.run(t, "useradd", "--help")
	if code != 0 {
		t.Error("useradd --help should exit 0")
	}
	mustContain(t, "help", stdout, "--generate-password", "--admin", "--upsert")
	if strings.Contains(stdout, "--password <") {
		t.Error("help still advertises the removed --password flag")
	}
}

// --- secret sources ---

func TestSecretCommand(t *testing.T) {
	// `semiont secret` stores POINTERS (provider + path) in roots.json —
	// never a value. set verifies with one read (discarded); list shows
	// pointers; rm forgets.
	s := newScenario(t, "container", "op")

	stdout, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential")
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

	stdout, _, code = s.run(t, "secret", "list")
	if code != 0 {
		t.Fatalf("secret list: exit %d", code)
	}
	mustContain(t, "list stdout", stdout,
		"ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential", "the environment always wins")

	// Unknown scheme rejected; verification failure stores nothing.
	if _, stderr, code := s.run(t, "secret", "set", "X", "vault://a/b"); code != 1 {
		t.Error("unknown scheme should fail")
	} else {
		mustContain(t, "stderr", stderr, "Unknown secret provider 'vault'")
	}
	s.extraEnv = append(s.extraEnv, "FAKERT_OP_FAIL=1")
	if _, stderr, code := s.run(t, "secret", "set", "OTHER_KEY", "op://a/b/c"); code != 1 {
		t.Error("failed verification should fail set")
	} else {
		mustContain(t, "stderr", stderr, "Verification failed")
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	if strings.Contains(string(b), "a/b/c") {
		t.Errorf("failed verification still stored the source:\n%s", b)
	}

	// rm forgets; a second rm is an honest error.
	if _, _, code := s.run(t, "secret", "rm", "ANTHROPIC_API_KEY"); code != 0 {
		t.Fatal("secret rm failed")
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	if strings.Contains(string(b), "Anthropic/credential") {
		t.Errorf("rm left the source behind:\n%s", b)
	}
	if _, _, code := s.run(t, "secret", "rm", "ANTHROPIC_API_KEY"); code != 1 {
		t.Error("rm of an absent source should fail")
	}
}

func TestSecretSetInteractive(t *testing.T) {
	// `secret set <VAR>` with no source URI walks the provider registry
	// interactively: pick a provider (the lone installed one is the
	// default), then the path in the provider's own shape.
	s := newScenario(t, "container", "op")

	// Empty provider input takes the default; a pasted full URI as the
	// path is tolerated.
	s.stdin = "\nop://OSS/Anthropic/credential\n"
	stdout, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY")
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
	if _, stderr, code := s.run(t, "secret", "set", "X"); code != 1 {
		t.Error("unknown interactive provider should fail")
	} else {
		mustContain(t, "stderr", stderr, "Unknown secret provider 'vault'")
	}

	// An empty path is a clean failure.
	s.stdin = "op\n\n"
	if _, stderr, code := s.run(t, "secret", "set", "X"); code != 1 {
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
	stdout, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY")
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
	_, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/x/y")
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
	if _, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\nstderr:\n%s", code, stderr)
	}

	// Existing selection must survive: gh's --repos REPLACES the list.
	s.extraEnv = append(s.extraEnv,
		`FAKERT_GH_SECRET_REPOS={"total_count":1,"repositories":[{"full_name":"other/already-had-it"}]}`)
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "secret", "push", "ANTHROPIC_API_KEY", "--repo", "pingel-org/foo-kb")
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
	if _, _, code := s2.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatal("set failed")
	}
	s2.extraEnv = append(s2.extraEnv,
		`FAKERT_GH_SECRET_REPOS={"total_count":1,"repositories":[{"full_name":"pingel-org/foo-kb"}]}`)
	if err := os.Truncate(s2.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, code := s2.run(t, "secret", "push", "ANTHROPIC_API_KEY", "--repo", "pingel-org/foo-kb"); code != 0 {
		t.Fatal("push failed")
	}
	log, _ = os.ReadFile(s2.log)
	mustContain(t, "argv log", string(log), "--repos pingel-org/foo-kb")
	if strings.Contains(string(log), "foo-kb,pingel-org/foo-kb") {
		t.Errorf("repo duplicated in the selection:\n%s", log)
	}

	// Failure paths: no registered source, bad slug, gh rejecting the write.
	s3 := newScenario(t, "container", "op", "gh")
	if _, stderr, code := s3.run(t, "secret", "push", "NOPE_KEY", "--repo", "a/b"); code != 1 {
		t.Error("push without a source should fail")
	} else {
		mustContain(t, "stderr", stderr, "No secret source registered for NOPE_KEY",
			"semiont secret set NOPE_KEY")
	}
	if _, stderr, code := s3.run(t, "secret", "push", "ANTHROPIC_API_KEY", "--repo", "notaslug"); code != 1 {
		t.Error("bad slug should fail")
	} else {
		mustContain(t, "stderr", stderr, "--repo must be owner/name")
	}
	if _, _, code := s3.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatal("set failed")
	}
	s3.extraEnv = append(s3.extraEnv, "FAKERT_GH_SECRET_SET_FAIL=1")
	if _, stderr, code := s3.run(t, "secret", "push", "ANTHROPIC_API_KEY", "--repo", "a/b"); code != 1 {
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
	if _, _, code := s2.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
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
		"semiont secret push ANTHROPIC_API_KEY --repo "+csRepo)
}

func TestStartResolvesSecret(t *testing.T) {
	// A registered source feeds start: announced BEFORE the reach, resolved
	// fresh, injected into the container argv (redacted in echoes). Dry-run
	// reaches for nothing; the environment always wins over the source.
	s := newScenario(t, "container", "op")
	if _, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential"); code != 0 {
		t.Fatalf("secret set: exit %d\nstderr:\n%s", code, stderr)
	}

	stdout, stderr, code := s.run(t, "start", "--service", "worker", "--config", "anthropic")
	if code != 0 {
		t.Fatalf("start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"ANTHROPIC_API_KEY: reading from 1Password (op read op://OSS/Anthropic/credential)",
		"expect an authorization prompt")
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "--env ANTHROPIC_API_KEY=fake-op-secret")
	if strings.Contains(stdout, "fake-op-secret") {
		t.Errorf("resolved secret leaked into the echoed output:\n%s", stdout)
	}

	// Dry-run must not reach into the vault: with the provider failing, the
	// plan still renders, with the placeholder.
	s.killServes()
	s.extraEnv = append(s.extraEnv, "FAKERT_OP_FAIL=1")
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code = s.run(t, "start", "--dry-run", "--config", "anthropic")
	if code != 0 {
		t.Fatalf("dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "dry-run stdout", stdout, "ANTHROPIC_API_KEY=<env:ANTHROPIC_API_KEY>")
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
	log, _ = os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "--env ANTHROPIC_API_KEY=from-env")
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
		`"runtime": "codespace"`, `"codespace": "fake-cs-1"`, `"repo": "pingel-org/foo-kb"`,
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
	sshAt := strings.Index(log, "api/health")
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
	s.killServes()
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	s.cwd = t.TempDir() // rootless: nothing resembling a KB here
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("bare resume: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"Using recorded stack's runtime: codespace",
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
	s.killServes()
	stdout, stderr, code = s.run(t, "start", "--runtime", "codespace", "--repo", "other/bar")
	if code != 0 {
		t.Fatalf("second repo: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), "codespace:"+csRepo, "codespace:other/bar",
		`"forwardPort": 4001`) // foo's recorded 4000 stays reserved for its re-attach

	// With several codespace stacks and none forwarded, a bare start must
	// be told which.
	s.killServes()
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
	mustContain(t, "stdout", stdout, "Found existing codespace for "+csRepo+": old-cs", "resuming, not creating")
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
	mustContain(t, "stack.json", string(b), `"codespace": "cs-b"`)
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
	s.killServes() // free the parked forward: THIS test is about machine selection, not port laddering
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
	s2.killServes() // free the parked forward: THIS test is about machine selection, not port laddering
	s3 := newCodespaceScenario(t)
	s3.extraEnv = append(s3.extraEnv, only("standardLinux32gb", "largePremiumLinux"))
	if _, stderr, code := s3.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("largest: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	log, _ = os.ReadFile(s3.log)
	mustContain(t, "argv log", string(log), "--machine largePremiumLinux")

	// Explicit and available: used, no announcement.
	s3.killServes() // free the parked forward: THIS test is about machine selection, not port laddering
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
	s.killServes()
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
	stdout, stderr, code := s.run(t, "useradd", "--email", "alice@example.com",
		"--name", "A $NAME with spaces", "--admin")
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
		"docker exec -i semiont-gateway semiont-useradd", // -i keeps the pipe open through ssh
		"'alice@example.com'", "'--admin'", "'--password-stdin'")
	if strings.Contains(remote, "rm -rf") {
		t.Fatalf("the password reached the remote COMMAND LINE:\n%s", remote)
	}
	// Other arguments still cross a shell, so they must still be quoted: the
	// old bug was echoing RAW args, which would expand $NAME and split on
	// spaces if pasted.
	mustContain(t, "remote command", remote, "'A $NAME with spaces'")
	// The echoed command is now IDENTICAL to the one run — with no secret in
	// argv there is nothing left to redact.
	echoed := stdout[strings.Index(stdout, "$ gh"):]
	echoed = echoed[:strings.IndexByte(echoed, '\n')]
	mustContain(t, "echoed command", echoed, "'alice@example.com'", "'--admin'", "'A $NAME with spaces'")
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
		mustContain(t, "stderr", stderr, "No codespace stack recorded for no/such")
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
		`"codespace:` + csRepo + `":{"runtime":"codespace","codespace":"fake-cs-1","repo":"` + csRepo + `","forwardPort":4001,"services":{}}}}`
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
	// The overview form must also refuse to call it deleted.
	ov, _, _ := s3.run(t, "status")
	mustContain(t, "overview", ov, "state unknown — gh unavailable")
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
	body := `{"schema":3,"stacks":{"codespace:` + csRepo + `":{"runtime":"codespace",` +
		`"codespace":"fake-cs-1","repo":"` + csRepo + `","forwardPort":4001,"ports":[4001],"services":{}}}}`
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
	stdout, _, _ := s.run(t, "status")
	mustContain(t, "status", stdout, "did:web:example.github.io:test-kb")

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
	stdout, _, _ = s2.run(t, "status")
	mustContain(t, "status", stdout, "did:web:example.com:remote-kb")
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

func TestCodespaceStopKeepsRecordDeleteForgets(t *testing.T) {
	s := newCodespaceScenario(t)
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}

	// stop: gh codespace stop, forward killed, record KEPT (the codespace
	// still exists — state and credentials persist).
	stdout, stderr, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop stdout", stdout, "billing halted", "state and credentials persist", "semiont stop --delete")
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace stop -c fake-cs-1")
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatal("stop forgot a codespace record that still mirrors an existing codespace")
	}
	mustContain(t, "stack.json after stop", string(b), `"codespace": "fake-cs-1"`)
	if strings.Contains(string(b), `"forwardPid"`) {
		t.Errorf("stop left a dead forward pid recorded:\n%s", b)
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
	s.killServes() // forward dead: status must re-establish it

	// Available: identity line, healthy table through the respawned
	// forward, credentials read fresh.
	s.extraEnv = append(s.extraEnv,
		`FAKERT_GH_CS_LIST=[{"name":"fake-cs-1","state":"Available","repository":"pingel-org/foo-kb"}]`)
	// The default report LISTS remote repos; it no longer drills into one.
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout,
		"LOCAL STACK", "REMOTE KNOWLEDGE BASES", csRepo, "codespace fake-cs-1", "LOCAL ROOTS")

	// --repo names ONE stack: full detail, health-coded, credentials fresh.
	stdout, _, code = s.run(t, "status", "--repo", csRepo)
	if code != 0 {
		t.Fatalf("status --repo: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "status --repo stdout", stdout,
		"CODESPACE", "fake-cs-1", csRepo, "state: Available",
		"re-establishing",
		"KB", "healthy", "http://localhost:4000/api/health",
		"run inside the codespace via compose",
		// No credentials: status reports where to connect and how to make a
		// user, never an account it cannot vouch for.
		"connect at Host localhost, Port 4000", "semiont useradd --repo "+csRepo)

	// Stopped: honest stopped-but-existing, scriptably unhealthy.
	s.killServes()
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
	local := `{"schema":3,"stacks":{"local":{"runtime":"container","ports":[3000,4000,9090],` +
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
	s2.killServes()
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
		mustContain(t, "stderr", stderr, "--service does not apply to a codespace stack")
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
		{[]string{"start", "--runtime", "codespace", "--service", "worker"}, "--service does not apply to --runtime codespace"},
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
		"codespace:"+csRepo, "codespace:other/bar", `"codespace": "bar-cs-1"`,
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
	mustContain(t, "status stdout", stdout,
		"REMOTE KNOWLEDGE BASES",
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
	s.killServes()
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
	  "codespace:pingel-org/foo-kb":{"runtime":"codespace","codespace":"fake-cs-1","repo":"pingel-org/foo-kb","ports":[3000,4000,9090,9091,9092],"services":{}}}}`
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
	if _, stderr, code := s.run(t, "useradd", "--runtime", "container", "--email", "a@b.co", "--generate-password"); code != 0 {
		t.Fatalf("useradd --runtime: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "container exec fid-semiont-gateway semiont-useradd")

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
	head := "[defaults]\nenvironment = \"local\"\n\n[environments.local.gateway]\nplatform = \"posix\"\nport = 4000\n\n"
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", name+".toml")
	if err := os.WriteFile(p, []byte(head+body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const stdVectors = "[environments.local.vectors]\ntype = \"qdrant\"\nhost = \"${QDRANT_HOST}\"\nport = 6333\n\n"

// Every config must name a vector store and an embedding provider — the
// launcher refuses one that does not, exactly as the gateway's loader does.
// So these two are as standard as stdGraph/stdDatabase, and a variant that
// wants no local Ollama reaches for stdEmbeddingVoyage rather than dropping
// the section.
const stdEmbedding = "[environments.local.embedding]\ntype = \"ollama\"\nmodel = \"nomic-embed-text\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"\n\n"
const stdEmbeddingVoyage = "[environments.local.embedding]\nplatform = \"external\"\ntype = \"voyage\"\nmodel = \"voyage-3\"\n\n"
const stdDatabase = "[environments.local.database]\nhost = \"${POSTGRES_HOST}\"\nport = 5432\nname = \"semiont\"\nuser = \"postgres\"\npassword = \"localpass\"\n\n"
const stdGraph = "[environments.local.graph]\ntype = \"neo4j\"\nuri = \"bolt://${NEO4J_HOST}:7687\"\nusername = \"neo4j\"\npassword = \"localpass\"\n\n"

func TestStartExternalGraphBoot(t *testing.T) {
	// graph at a literal address: verify reachability, launch no container,
	// claim no graph ports.
	s := newScenario(t, "container")
	writeKBConfig(t, s, "external-graph",
		"[environments.local.graph]\ntype = \"neo4j\"\nuri = \"bolt://127.0.0.1:7777\"\nusername = \"neo4j\"\npassword = \"remotepass\"\n\n"+
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
			"[environments.local.database]\nhost = \"${POSTGRES_HOST}\"\nport = 5433\nname = \"semiont\"\nuser = \"postgres\"\npassword = \"localpass\"\n\n")
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
		"[environments.local.graph]\ntype = \"neo4j\"\nuri = \"bolt://graph.example.com:7687\"\nusername = \"neo4j\"\npassword = \"remotepass\"\n\n"+
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
	if strings.Contains(stdout, "4000") {
		t.Errorf("static gateway port leaked into the plan:\n%s", stdout)
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
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "semiont", "roots.json")
	}
	return filepath.Join(home, ".local", "state", "semiont", "roots.json")
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
	s.killServes()
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

	// status shows the registered root, with its did:web identity line.
	stdout, _, _ = s.run(t, "status")
	mustContain(t, "status stdout", stdout, "LOCAL ROOTS", s.kb, "last used ",
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
	s.killServes()
	stdout, stderr, code := s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("sticky start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "sticky start stdout", stdout,
		"Config: anthropic", "recorded from last start; override with --config")

	// --dry-run reads the preference (only the anthropic config references
	// ${ANTHROPIC_API_KEY}, so its placeholder appearing proves which config
	// drove the plan) but never writes the registry.
	before, _ := os.ReadFile(rootsPathFor(s.home))
	stdout, stderr, code = s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "dry-run stdout", stdout, "ANTHROPIC_API_KEY=<env:ANTHROPIC_API_KEY>")
	after, _ := os.ReadFile(rootsPathFor(s.home))
	if !bytes.Equal(before, after) {
		t.Errorf("dry-run mutated the registry:\n%s", after)
	}

	// An explicit flag wins over the recorded preference and re-records.
	s.killServes()
	stdout, stderr, code = s.run(t, "start", "--service", "worker", "--config", "ollama-gemma")
	if code != 0 {
		t.Fatalf("override start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "override stdout", stdout, "Config: ollama-gemma")
	if strings.Contains(stdout, "recorded from last start") {
		t.Errorf("explicit --config must not claim registry provenance:\n%s", stdout)
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json after override", string(b), `"config": "ollama-gemma"`)

	// A typo'd --config fails before launching and records nothing.
	s.killServes()
	if _, _, code := s.run(t, "start", "--service", "worker", "--config", "nope"); code != 1 {
		t.Fatalf("bogus config: want exit 1, got %d", code)
	}
	b, _ = os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json after bogus config", string(b), `"config": "ollama-gemma"`)

	// status surfaces the sticky config on the root's identity lines.
	stdout, _, _ = s.run(t, "status")
	mustContain(t, "status stdout", stdout, "config: ollama-gemma (used when --config is omitted)")

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
		"Config not found: .semiont/semiontconfig/gone.toml",
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
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "semiont", "stack.json")
	}
	return filepath.Join(home, ".local", "state", "semiont", "stack.json")
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
	for _, role := range []string{"traces", "graph", "vectors", "inference", "database", "gateway", "worker", "smelter", "weaver"} {
		e, ok := st.Services[role]
		if !ok {
			t.Errorf("service %q missing from record", role)
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
		if e.Endpoint == "" {
			t.Errorf("%s: endpoint not recorded", role)
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
	removeStale, _ := filepath.Glob("/tmp/semiont-config.*")
	for _, d := range removeStale {
		os.RemoveAll(d) // suite-order leftovers from boot tests
	}
	s := newScenario(t, "container", "docker")
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
	stage, err := os.MkdirTemp("/tmp", "semiont-config.")
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
		"docker run -d --name semiont-gateway")
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
	s.killServes()
	if _, stderr, code := s.run(t, "start", "--service", "worker", "--runtime", "docker"); code != 0 {
		t.Fatalf("docker start: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(rootsPathFor(s.home))
	mustContain(t, "roots.json", string(b), `"runtime": "docker"`)

	// A bare start now prefers docker, saying why.
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	s.killServes()
	stdout, stderr, code = s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("sticky start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "sticky stdout", stdout,
		"Container runtime: docker", "recorded from last start; override with --runtime")

	// A live stack's record outranks the preference: rejoin what exists.
	s.killServes()
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
	s.killServes()
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
	s.killServes()
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
	mustContain(t, "stack.json", string(b), `"ports"`, "9090")

	// Happy path: ports free → clean announcement.
	stdout, _, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	mustContain(t, "stop stdout", stdout, "All stack ports released")

	// A foreign holder on a claimed port is reported, not killed; stop
	// still exits 0 — its own work succeeded.
	s.killServes()
	if _, _, code := s.run(t, "start", "--service", "worker"); code != 0 {
		t.Fatal("restart failed")
	}
	s.extraEnv = append(s.extraEnv, "FAKERT_LSOF_9090=777", "FAKERT_PS_777=node")
	stdout, _, code = s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop with held port: exit %d", code)
	}
	mustContain(t, "stop stdout", stdout,
		"Port 9090 is still held by 777 (node)", "the next start will fail on it")
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
	secret := jwtSecretFromArgv(t, s.argv(t))
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
	if got := jwtSecretFromArgv(t, s.argv(t)); got != newKey+","+oldKey {
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
	first := jwtSecretFromArgv(t, argv)
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
	if info, err := os.Stat(path); err == nil && info.Mode().Perm() != 0o600 {
		t.Errorf("%s is %o, want 600 — it is a signing key", path, info.Mode().Perm())
	}

	// Restarting just the gateway must rejoin the SAME key. This is the case
	// that matters operationally: a re-minted secret here would invalidate
	// every token the running stack's users already hold.
	out2, err2, code := s.run(t, "start", "--service", "gateway")
	if code != 0 {
		t.Fatalf("start --service gateway: exit %d\nstdout:\n%s\nstderr:\n%s", code, out2, err2)
	}
	if second := jwtSecretFromArgv(t, s.argv(t)); second != first {
		t.Errorf("JWT_SECRET changed on restart — every previously issued token is now invalid\nfirst:  %s\nsecond: %s", first, second)
	}
}

// An explicit $JWT_SECRET is the operator's override — it wins over the
// persisted one, the same precedence $SEMIONT_WORKER_SECRET has.
func TestStartJWTSecretEnvWins(t *testing.T) {
	s := newScenario(t, "container")
	s.noJWTSecret = true // replace the harness default with our own value
	s.extraEnv = append(s.extraEnv, "JWT_SECRET=an-operator-supplied-secret-of-sufficient-length")
	if _, _, code := s.run(t, "start"); code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
	if got := jwtSecretFromArgv(t, s.argv(t)); got != "an-operator-supplied-secret-of-sufficient-length" {
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
	mustContain(t, "stdout", stdout, "JWT_SECRET=<jwt-secret>")
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

// jwtSecretFromArgv extracts the value the gateway container was given.
func jwtSecretFromArgv(t *testing.T, argv string) string {
	t.Helper()
	for _, line := range strings.Split(argv, "\n") {
		if !strings.Contains(line, "--name semiont-gateway") {
			continue
		}
		for _, f := range strings.Fields(line) {
			if v, ok := strings.CutPrefix(f, "JWT_SECRET="); ok {
				return v
			}
		}
		t.Fatalf("gateway run carries no JWT_SECRET:\n%s", line)
	}
	t.Fatalf("no gateway run in argv:\n%s", argv)
	return ""
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
	// Gateway already running with a secret in its env; Jaeger up on 16686.
	// Restarting the worker must rejoin the recovered secret (not the env
	// one), auto-enable OTel, stage a fresh private config, and leave the
	// rest of the stack untouched.
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_gateway=running",
		// The worker is ALREADY RUNNING — this is a restart, and a restart is
		// only a restart if there is something to replace. The teardown now
		// lists before it acts, so a scenario that wants stop+rm asserted has
		// to say the container exists rather than relying on stop/rm being
		// fired blindly at a name that was never there.
		"FAKERT_STATE_worker=running",
		"FAKERT_SECRET=recovered-secret-123",
	)
	serveHealth(t, 16686)
	stdout, stderr, code := s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"Restarting worker",
		"Jaeger detected — OTel export enabled",
		"Worker secret: (recovered from semiont-gateway)",
		"SEMIONT_WORKER_SECRET=<redacted>",
		"🚀 worker is up",
		"semiont status",
	)
	if strings.Contains(stdout, "recovered-secret-123") {
		t.Error("recovered secret leaked into stdout")
	}
	argv := s.argv(t)
	mustContain(t, "argv", argv,
		"stop semiont-worker",
		"rm semiont-worker",
		"image pull ghcr.io/the-ai-alliance/semiont-worker:latest",
		"inspect semiont-gateway",
		"--env SEMIONT_WORKER_SECRET=recovered-secret-123",
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
		`"kbRoot": "`+s.kb+`"`,
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
	mustContain(t, "stdout", stdout, "Restarting graph (Neo4j)", "🚀 graph is up")
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
	mustContain(t, "stdout", stdout, "Restarting browser", "🚀 browser is up")
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
// 9094, and neither JWT_SECRET (it signs nothing) nor LIBRARIAN_HOST
// (nothing dials it). The staged config carries the committed [kb] name —
// the one fact the Librarian needs to find the Archivist's views.
func TestStartServiceLibrarian(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--service", "librarian")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting librarian", "Librarian healthy (http://localhost:9094)")
	log := string(s.mustLog(t))
	mustContain(t, "argv", log,
		"--name semiont-librarian",
		"--publish 9094:9094",
		"librarian.toml:/home/semiont/.semiontconfig:ro",
		"state:/semiont-state",
		"--env SEMIONT_WORKER_SECRET=")
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
	mustContain(t, "staged librarian.toml", string(staged),
		"[kb]",
		`name = "Test Knowledge Base"`)
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
	mustContain(t, "stdout", stdout, "Restarting archivist", "Archivist healthy (http://localhost:9093)")
	log := string(s.mustLog(t))
	mustContain(t, "argv", log,
		"--name semiont-archivist",
		"--publish 9093:9093",
		":/kb",
		"archivist.toml:/home/semiont/.semiontconfig:ro",
		"anchored-text:/anchored-text",
		"--env SEMIONT_WORKER_SECRET=")
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
		"worker secret: recovered from a running Semiont container's env",
		"<config-stage>/worker.toml",
		"wait: http://localhost:9090/health (30s)",
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

func TestStartServiceSecretUnreadableIsLoud(t *testing.T) {
	// A Semiont container EXISTS but yields no secret (the inspect-schema
	// break case): without an explicit $SEMIONT_WORKER_SECRET the restart
	// fails with instructions — never a silently generated secret that would
	// break sidecar auth.
	s := newScenario(t, "container")
	s.noWorkerSecret = true
	s.extraEnv = append(s.extraEnv, "FAKERT_STATE_gateway=running") // no FAKERT_SECRET
	_, stderr, code := s.run(t, "start", "--service", "worker")
	if code != 1 {
		t.Fatalf("want exit 1, got %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr,
		"worker secret could not be recovered",
		"inspect schema may have changed",
		"set SEMIONT_WORKER_SECRET",
		"semiont start")

	// With an explicit env secret: proceeds, but warns about the mismatch
	// risk instead of pretending recovery worked.
	s.noWorkerSecret = false
	// NO serveHealth(9090) here: 9090 is the WORKER's own port, and the
	// launcher must find it free to start the container that then serves it
	// (the fake run -d binds it, as in TestStartServiceWorker). Pre-binding
	// it modelled a foreign process squatting the port — fiction that only
	// passed while the fake lsof lied about real listeners; now the launcher
	// correctly refuses. serveHealth is for services the launcher does NOT
	// start (an already-running gateway, Jaeger, a host Ollama).
	stdout, stderr2, code := s.run(t, "start", "--service", "worker")
	if code != 0 {
		t.Fatalf("env-secret path: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr2)
	}
	mustContain(t, "stdout+stderr", stdout+stderr2,
		"exists but its worker secret could not be read",
		"using $SEMIONT_WORKER_SECRET",
		"Worker secret: (from environment)")
}

// --- stop --service ---

func TestStopService(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	stage, err := os.MkdirTemp("/tmp", "semiont-config.")
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
	mustContain(t, "the codespace branch actually fired", stdout+stderr, "Using recorded stack's runtime")
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
	s.killServes() // else this fake Ollama looks like a HOST one to the next case

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
	s2.killServes()

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

// The ceilings status prints come from the PLATFORM — one correlated
// browse:agents-requested exchange over the bus, the same request every other
// client makes — never from a direct provider probe. mustNotContain is spelled
// out here because "no ceiling" is the whole assertion in three of these tests.
func mustNotContain(t *testing.T, label, haystack string, needles ...string) {
	t.Helper()
	for _, n := range needles {
		if strings.Contains(haystack, n) {
			t.Errorf("%s must not contain %q; full text:\n%s", label, n, haystack)
		}
	}
}

// agentsReply scripts the fake bus's browse:agents-result payload.
func agentsReply(entries ...string) string {
	return `FAKERT_BUS_REPLY_browse_agents_requested={"agents":[` + strings.Join(entries, ",") + `]}`
}

func softwareAgent(provider, model, limits string) string {
	e := fmt.Sprintf(`{"agent":{"@type":"Software","name":"%s","provider":"%s","model":"%s"}`, model, provider, model)
	if limits != "" {
		e += `,"limits":` + limits
	}
	return e + "}"
}

func TestStatusShowsPlatformCeilings(t *testing.T) {
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		agentsReply(
			softwareAgent("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`),
			softwareAgent("ollama", "nomic-embed-text", `{"contextTokens":8000,"maxOutputTokens":8000}`),
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

	// Sourced over the bus, on the generated operation — not by probing a
	// provider. (D5: platform data flows through the platform surface.)
	found := false
	for _, e := range emits(t, s) {
		if strings.Contains(e, `"channel":"browse:agents-requested"`) {
			found = true
			mustContain(t, "agents request", e, `"correlationId"`)
		}
	}
	if !found {
		t.Errorf("status never asked the platform for the roster:\n%s", strings.Join(emits(t, s), "\n"))
	}
}

func TestStatusCeilingsNeedASession(t *testing.T) {
	// Same started stack, only the credential removed: no session means no
	// roster, and a row without a ceiling is exactly today's row — no error,
	// no placeholder. (Ignorance is not a finding.)
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		agentsReply(softwareAgent("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`)))
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

func TestStatusCeilingsSurviveARejectedRoster(t *testing.T) {
	// The platform answering on the failure channel is the same non-answer as
	// silence: rows render as today, and status still exits on health alone.
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		"FAKERT_BUS_FAIL=directory unavailable")
	stdout, stderr, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("a rejected roster must not fail status: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "model row still renders", stdout, "gemma4:26b", "installed")
	mustNotContain(t, "status with a rejected roster", stdout, "window", " in / ", "directory unavailable")
}

func TestStatusCeilingsAbsentWhenTheEntryHasNone(t *testing.T) {
	// D3's absence semantics reach all the way to the terminal: an entry
	// whose discovery failed carries no limits, and its row is unchanged.
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		agentsReply(
			softwareAgent("ollama", "gemma4:26b", ""),
			softwareAgent("ollama", "nomic-embed-text", `{"contextTokens":8000,"maxOutputTokens":8000}`),
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
	s.stdin = "hunter2secret\n"
	if _, stderr, code := s.run(t, "login", "--email", "admin@example.com"); code != 0 {
		t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
	}
	s.stdin = ""
	return s
}

func TestStatusNeverShowsACrossProviderCeiling(t *testing.T) {
	// The roster claims OLLAMA serves a Claude. The row's model is Anthropic's,
	// so the keys do not meet and no ceiling is printed. A ceiling matched on
	// the model NAME alone would have printed one here — a wrong number, which
	// is worse than a missing one.
	s := mixedStackScenario(t,
		agentsReply(softwareAgent("ollama", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`)))
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "model row still renders", stdout, "claude-sonnet-4-5-20250929", "remote")
	mustNotContain(t, "cross-provider roster", stdout, "window", " in / ")
}

func TestStatusPlatformCeilingReplacesTheProbedWindow(t *testing.T) {
	// The launcher's own /v1/models probe renders "200K ctx" today. Once the
	// platform publishes the ceiling, THAT is the one on the row — one context
	// figure, from the platform (D5), never two from two sources. The probe
	// keeps rendering what only it knows (identity, release, key visibility).
	s := mixedStackScenario(t,
		agentsReply(softwareAgent("anthropic", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`)))
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

	// useradd from the clone: local gateway, no ssh, no refusal.
	before := s.mustLog(t)
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--generate-password"); code != 0 {
		t.Fatalf("bare useradd in clone: exit %d\nstderr:\n%s", code, stderr)
	}
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "useradd argv", fresh, "exec", "semiont-useradd")
	if strings.Contains(fresh, "gh codespace") {
		t.Errorf("bare useradd in the local clone went to the codespace:\n%s", fresh)
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

	stdout, _, _ = s.run(t, "status")
	mustContain(t, "overview (Available)", stdout,
		"Available · premiumLinux 8c/32GB · up 2h")

	if _, _, code := s.run(t, "stop"); code != 0 {
		t.Fatal("stop")
	}
	stdout, _, _ = s.run(t, "status")
	mustContain(t, "overview (Shutdown)", stdout,
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
		b, _ := os.ReadFile(filepath.Join(s.home, ".local", "state", "semiont", "discovery", "kbs.json"))
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
	mustContain(t, "browser mount", s.argv(t), "-v <home>/.local/state/semiont/discovery:/discovery:ro")

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
	discPath := filepath.Join(s.home, ".local", "state", "semiont", "discovery", "kbs.json")
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
	b, err := os.ReadFile(filepath.Join(s.home, ".local", "state", "semiont", "discovery", "kbs.json"))
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
		"--site-name", "Family KB", "--admin-email", "a@b.co", "--yes")
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
		`adminEmail = "a@b.co"`,
		`sync = true`)
	// The launcher runs git with -C <dir>; assert the subcommands.
	mustContain(t, "argv", s.argv(t), " init", " add .semiont")
	roots, _ := os.ReadFile(filepath.Join(s.home, ".local", "state", "semiont", "roots.json"))
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
	stdout, stderr, code := s.run(t, "init", "--name", "kb", "--admin-email", "a@b.co")
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
		"devcontainer.json":  `{"name": "Semiont Template KB", "dockerComposeFile": "docker-compose.yml"}`,
		"docker-compose.yml": "services:\n  gateway:\n    image: x\n",
		"post-create.sh":     "#!/bin/sh\necho hi\n",
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
	for _, n := range []string{"docker-compose.yml", "post-create.sh"} {
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
	_ = os.Symlink("/etc/hosts", filepath.Join(tpl2, ".semiont", "semiontconfig", "evil.toml"))
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
	for _, absent := range []string{"LOCAL ROOTS", "worker", "traces"} {
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
	// Discovery probes run in order; the seven follows launch concurrently, so
	// assert the probe prefix exactly and the follow set order-independently.
	lines := strings.Split(strings.TrimRight(s.argv(t), "\n"), "\n")
	if len(lines) != 9 {
		t.Fatalf("want 9 invocations (2 probes + 7 follows), got %d:\n%s", len(lines), s.argv(t))
	}
	if lines[0] != "container list" || lines[1] != "docker ps --format {{.Names}}" {
		t.Errorf("wrong discovery probes:\n%s", s.argv(t))
	}
	follows := append([]string{}, lines[2:]...)
	sort.Strings(follows)
	want := []string{
		"docker logs --follow semiont-archivist",
		"docker logs --follow semiont-browser",
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
		"Following gateway · worker · smelter · weaver · archivist · librarian · browser",
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
	s.stdin = "hunter2secret\n"
	if _, stderr, code := s.run(t, "login", "--email", "admin@example.com"); code != 0 {
		t.Fatalf("login: exit %d\nstderr:\n%s", code, stderr)
	}
	s.stdin = ""
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
	mustContain(t, "emit", b, `"channel":"gather:resource-requested"`, `"resourceId":"res-1"`, `"includeContent":true`)
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
