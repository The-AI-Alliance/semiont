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
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
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
	out := strings.ReplaceAll(string(b), s.kb, "<kb-root>")
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

// --- start: full boots against the fake runtime ---

func TestStartDefaultBoot(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-default-boot.argv", s.argv(t))
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
		"Config 'anthropic' references ${ANTHROPIC_API_KEY} but it is not set in the environment.")
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
		"--force-kill-ports")
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
	s := newScenario(t, "container")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"start", "--email", "a@b.co"}, "--email and --password must be provided together."},
		{[]string{"start", "--password", "longenough"}, "--email and --password must be provided together."},
		{[]string{"start", "--email", "not-an-email", "--password", "longenough"}, "Invalid --email"},
		{[]string{"start", "--email", "a@b.co", "--password", "short"}, "--password must be at least 8 characters."},
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
	checkGolden(t, "start-dryrun-default.txt", stdout)
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
	checkGolden(t, "start-dryrun-local.txt", stdout)
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
		"Sweeping 10 container(s) across container, docker, podman",
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
	// docker-only runtime; backend running+healthy, worker running but
	// unhealthy, smelter exited, everything else absent — except a host
	// Ollama answering with no container, which must report runtime "host".
	s := newScenario(t, "docker")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_backend=running",
		"FAKERT_STATE_worker=running",
		"FAKERT_STATE_smelter=exited",
	)
	serveHealth(t, 4000, 11434)
	stdout, stderr, code := s.run(t, "status")
	if code != 1 {
		t.Fatalf("want exit 1 with unhealthy core services, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout,
		"SERVICE", "TECH", "CONTAINER", "RUNTIME", "HEALTH",
		"PostgreSQL", "Neo4j", "Qdrant", "Ollama", "Jaeger",
		"SEMIONT ROOTS",
		"(discovered from cwd)",
		"LOCAL HOST DIRECTORIES",
		"config", "cache", "staging", "/tmp/semiont-config.*",
		"✓ http://localhost:4000/api/health",
		"✗ http://localhost:9090/health",
		"✗ tcp://localhost:5432",
		"exited",
		"host",
	)
	for _, line := range strings.Split(stdout, "\n") {
		if !strings.Contains(line, "localhost") {
			continue // service-table rows only, not the host-dirs block
		}
		switch {
		case strings.Contains(line, "backend"):
			mustContain(t, "backend row", line, "running", "docker", "✓")
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
	for _, svc := range []string{"backend", "worker", "smelter", "weaver", "frontend", "neo4j", "qdrant", "postgres", "ollama"} {
		s.extraEnv = append(s.extraEnv, "FAKERT_STATE_"+svc+"=running")
	}
	serveHealth(t, 4000, 9090, 9091, 9092, 3000, 7474, 6333, 5432, 11434)
	stdout, stderr, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("want exit 0 with all core healthy, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "traces")
	if strings.Contains(stdout, "✗ http://localhost:4000") {
		t.Errorf("backend reported unhealthy:\n%s", stdout)
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
	// A failing run with a password: logged with the value redacted.
	if _, _, code := s.run(t, "start", "--service", "worker", "--email", "a@b.co", "--password", "supersecretpw"); code != 1 {
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
		"invoke semiont start --service worker --email a@b.co --password <redacted>",
		"exit 1 semiont start --service worker",
	)
	if strings.Contains(log, "supersecretpw") {
		t.Error("password leaked into the invocation log")
	}
}

// --- config-driven boots (LAUNCHER-CONFIG-SYNC P2) ---

// writeKBConfig drops a variant semiontconfig into the scenario's KB.
func writeKBConfig(t *testing.T, s *scenario, name, body string) {
	t.Helper()
	head := "[defaults]\nenvironment = \"local\"\n\n[environments.local.backend]\nplatform = \"posix\"\nport = 4000\n\n"
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", name+".toml")
	if err := os.WriteFile(p, []byte(head+body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const stdVectors = "[environments.local.vectors]\ntype = \"qdrant\"\nhost = \"${QDRANT_HOST}\"\nport = 6333\n\n"
const stdEmbedding = "[environments.local.embedding]\ntype = \"ollama\"\nbaseURL = \"http://${OLLAMA_HOST}:11434\"\n\n"
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
	for _, absent := range []string{"run -d --rm --name semiont-neo4j", "NEO4J_AUTH", "lsof -ti :7474"} {
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
	mustContain(t, "stop argv", stopArgv, "stop fid-semiont-backend")
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
	// A config that references no ollama anywhere: the launcher launches no
	// inference at all — derived fact, not folklore.
	s := newScenario(t, "container")
	writeKBConfig(t, s, "no-ollama",
		stdGraph+stdVectors+stdDatabase+
			"[environments.local.inference.anthropic]\nplatform = \"external\"\nendpoint = \"https://api.anthropic.com\"\napiKey = \"${ANTHROPIC_API_KEY}\"\n\n"+
			"[environments.local.workers.default.inference]\ntype = \"anthropic\"\nmodel = \"claude-sonnet-4-5-20250929\"\n\n")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	stdout, stderr, code := s.run(t, "start", "--config", "no-ollama")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "inference — not referenced by the config; skipping")
	if argv := s.argv(t); strings.Contains(argv, "ollama") {
		t.Errorf("no-ollama config still touched ollama:\n%s", argv)
	}

	// status: inference reads "not configured", exits healthy without it;
	// stop never touches an ollama container.
	stdout, _, code = s.run(t, "status")
	if code != 0 {
		t.Errorf("status: exit %d\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout, "not configured")
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

func TestServiceBackendPortFollowsConfig(t *testing.T) {
	// --service backend port-claims the CONFIG's backend port, not a static
	// 4000 (the last vestige of the pre-config-sync port table).
	s := newScenario(t, "container")
	writeKBConfig(t, s, "moved-backend",
		stdGraph+stdVectors+stdEmbedding+stdDatabase)
	// writeKBConfig's header pins backend.port = 4000; rewrite it to 4001.
	p := filepath.Join(s.kb, ".semiont", "semiontconfig", "moved-backend.toml")
	b, _ := os.ReadFile(p)
	if err := os.WriteFile(p, []byte(strings.Replace(string(b), "port = 4000", "port = 4001", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, _, code := s.run(t, "start", "--service", "backend", "--config", "moved-backend", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout,
		"require free ports: 4001",
		"wait: http://localhost:4001/api/health (120s)")
	if strings.Contains(stdout, "4000") {
		t.Errorf("static backend port leaked into the plan:\n%s", stdout)
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
	// Strict, matching apps/cli: an invalid override is an error, never
	// silently ignored in favor of discovery.
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
	mustContain(t, "status stdout", stdout, "SEMIONT ROOTS", s.kb, "last used ",
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
	_, stderr, code := s.run(t, "start", "--service", "frontend", "--root", s.kb)
	if code != 1 {
		t.Errorf("--root with frontend: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "--root only applies to services that read the KB config")
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
	stdout, _, code := s.run(t, "logs", "--service", "backend")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout, "Using recorded stack state", "[backend]")
	argv := s.argv(t)
	mustContain(t, "argv", argv, "container logs --follow fid-semiont-backend")
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
	var st struct {
		Schema   int    `json:"schema"`
		Runtime  string `json:"runtime"`
		Services map[string]struct {
			Container string `json:"container"`
			ID        string `json:"id"`
			Image     string `json:"image"`
			Provided  string `json:"provided"`
			Endpoint  string `json:"endpoint"`
		} `json:"services"`
	}
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("stack.json not valid JSON: %v\n%s", err, b)
	}
	if st.Schema != 2 || st.Runtime != "container" {
		t.Errorf("schema/runtime: got %d/%q", st.Schema, st.Runtime)
	}
	for _, role := range []string{"traces", "graph", "vectors", "inference", "database", "backend", "worker", "smelter", "weaver", "frontend"} {
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
	mustContain(t, "status argv", statusArgv, "container inspect fid-semiont-backend")
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
	if !strings.Contains(string(b), `"backend"`) {
		t.Error("record lost other services on per-service stop")
	}

	// Full stop: recorded runtime only, by ID; record removed.
	preFull := s.argv(t)
	stdout, _, code = s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d", code)
	}
	mustContain(t, "stdout", stdout, "Using recorded stack state", "Semiont stack stopped.")
	fullArgv := strings.TrimPrefix(s.argv(t), preFull)
	mustContain(t, "full stop argv", fullArgv, "container stop fid-semiont-backend", "container rm fid-semiont-frontend")
	for _, bad := range []string{"docker stop", "podman stop"} {
		if strings.Contains(fullArgv, bad) {
			t.Errorf("state-driven stop swept a non-recorded runtime: %q", bad)
		}
	}
	if _, err := os.Stat(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Error("stack.json survived a full stop")
	}
}

func TestStopSchema1Compat(t *testing.T) {
	// A schema-1 stack.json (hostReuse flag, no provided field) still steers
	// stop: host-reused inference is skipped, launcher containers stop by ID.
	s := newScenario(t, "container", "docker")
	v1 := `{"schema":1,"runtime":"container","services":{
	  "backend":{"container":"semiont-backend","id":"fid-semiont-backend","startedAt":"2026-07-18T00:00:00Z"},
	  "inference":{"container":"semiont-ollama","hostReuse":true,"startedAt":"2026-07-18T00:00:00Z"}}}`
	p := statePathFor(s.home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(v1), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, _, code := s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d\n%s", code, stdout)
	}
	argv := s.argv(t)
	mustContain(t, "argv", argv, "container stop fid-semiont-backend")
	if strings.Contains(argv, "ollama") {
		t.Errorf("schema-1 hostReuse not honored:\n%s", argv)
	}
	if strings.Contains(argv, "docker stop") {
		t.Errorf("recorded runtime not honored:\n%s", argv)
	}
}

// writeStackState plants a schema-2 stack.json for the scenario.
func writeStackState(t *testing.T, s *scenario, runtime string) {
	t.Helper()
	st := `{"schema":2,"runtime":"` + runtime + `","services":{
	  "backend":{"container":"semiont-backend","id":"fid-semiont-backend","provided":"launcher","startedAt":"2026-07-19T00:00:00Z"}}}`
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
	mustContain(t, "argv", argv, "docker stop semiont-frontend")
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
	mustContain(t, "stdout", stdout, "docker pull ghcr.io/the-ai-alliance/semiont-backend:latest")
	if strings.Contains(stdout, "container stop semiont-") {
		t.Errorf("dry-run planned against auto-detected runtime, not the recorded one:\n%s", stdout)
	}
}

// --- start --service ---

func TestStartServiceWorker(t *testing.T) {
	// Backend already running with a secret in its env; Jaeger up on 16686.
	// Restarting the worker must rejoin the recovered secret (not the env
	// one), auto-enable OTel, stage a fresh private config, and leave the
	// rest of the stack untouched.
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_backend=running",
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
		"Worker secret: (recovered from semiont-backend)",
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
		"inspect semiont-backend",
		"--env SEMIONT_WORKER_SECRET=recovered-secret-123",
		"--env OTEL_EXPORTER_OTLP_ENDPOINT=http://",
		"<config-stage>/worker.toml:/home/semiont/.semiontconfig:ro",
	)
	for _, absent := range []string{"run -d --rm --name semiont-neo4j", "run -d --rm --name semiont-backend", "semiont-frontend"} {
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
	stdout, stderr, code := s.run(t, "start", "--service", "graph")
	if code != 0 {
		t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting graph (Neo4j)", "🚀 graph is up")
	argv := s.argv(t)
	mustContain(t, "argv", argv, "stop semiont-neo4j", "rm semiont-neo4j", "run -d --rm --name semiont-neo4j")
	for _, absent := range []string{"image pull", "busybox", "inspect"} {
		if strings.Contains(argv, absent) {
			t.Errorf("infra --service ran needless step: %q in argv", absent)
		}
	}
}

func TestStartServiceFrontendNoClone(t *testing.T) {
	// "Just the browser": --service targets that never touch the repo run
	// without a KB clone (the main README's no-clone use case).
	s := newScenario(t, "container")
	s.noGitRoot = true
	stdout, stderr, code := s.run(t, "start", "--service", "frontend")
	if code != 0 {
		t.Fatalf("want exit 0 outside a clone, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting frontend", "🚀 frontend is up")
	// The git-clone invariant is scoped to /kb-mount flows: backend still
	// requires a clone; a sidecar needs only the .semiont/ tree.
	if _, stderr, code := s.run(t, "start", "--service", "backend"); code != 1 {
		t.Errorf("backend without git: want exit 1, got %d", code)
	} else {
		mustContain(t, "stderr", stderr, "must be a git clone")
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
		{[]string{"start", "--service", "worker", "--email", "a@b.co", "--password", "password123"}, "--email/--password only apply to --service backend."},
		{[]string{"start", "--service", "frontend", "--config", "anthropic"}, "--config does not apply to --service frontend"},
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
	s.extraEnv = append(s.extraEnv, "FAKERT_STATE_backend=running") // no FAKERT_SECRET
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
	serveHealth(t, 9090)
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
	if strings.Contains(argv, "semiont-backend") {
		t.Error("--service weaver touched other containers")
	}
}

// --- status --service ---

func TestStatusService(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "FAKERT_STATE_backend=running")
	serveHealth(t, 4000)
	stdout, _, code := s.run(t, "status", "--service", "backend")
	if code != 0 {
		t.Fatalf("healthy backend: want exit 0, got %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout, "backend", "running", "✓ http://localhost:4000/api/health")
	for _, absent := range []string{"LOCAL HOST DIRECTORIES", "SEMIONT ROOTS", "worker", "traces"} {
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
}

// --- logs ---

func TestLogsDiscovery(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	s.extraEnv = append(s.extraEnv, "FAKERT_STACK_RUNTIME=docker")
	stdout, stderr, code := s.run(t, "logs")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	// Discovery probes run in order; the five follows launch concurrently, so
	// assert the probe prefix exactly and the follow set order-independently.
	lines := strings.Split(strings.TrimRight(s.argv(t), "\n"), "\n")
	if len(lines) != 7 {
		t.Fatalf("want 7 invocations (2 probes + 5 follows), got %d:\n%s", len(lines), s.argv(t))
	}
	if lines[0] != "container list" || lines[1] != "docker ps --format {{.Names}}" {
		t.Errorf("wrong discovery probes:\n%s", s.argv(t))
	}
	follows := append([]string{}, lines[2:]...)
	sort.Strings(follows)
	want := []string{
		"docker logs --follow semiont-backend",
		"docker logs --follow semiont-frontend",
		"docker logs --follow semiont-smelter",
		"docker logs --follow semiont-weaver",
		"docker logs --follow semiont-worker",
	}
	if strings.Join(follows, "\n") != strings.Join(want, "\n") {
		t.Errorf("wrong follow set:\n%s", strings.Join(follows, "\n"))
	}
	// Streams: [svc]-prefixed, stderr kept in-stream (crash traces live there).
	mustContain(t, "stdout", stdout,
		"Following backend · worker · smelter · weaver · frontend",
		"[backend] backend out",
		"[backend] backend err",
		"[worker] worker out",
		"[smelter] smelter err",
		"[weaver] weaver out",
		"[frontend] frontend err",
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
	_, stderr, code := s.run(t, "--config", "anthropic", "--force-kill-ports")
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"Unknown command: --config",
		"did you mean:  semiont start --config anthropic --force-kill-ports")
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
