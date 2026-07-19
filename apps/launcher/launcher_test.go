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
	return root
}

type scenario struct {
	shim      string
	kb        string // also FAKERT_GIT_ROOT unless gitRoot overridden
	noGitRoot bool
	home      string
	fakertDir string
	log       string
	extraEnv  []string
	stdin     string
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
		"SEMIONT_WORKER_SECRET=test-worker-secret",
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
	if got := s.argv(t); got != "git rev-parse --show-toplevel\n" {
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
		"SERVICE", "CONTAINER", "RUNTIME", "HEALTH",
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
		} `json:"services"`
	}
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("stack.json not valid JSON: %v\n%s", err, b)
	}
	if st.Schema != 1 || st.Runtime != "container" {
		t.Errorf("schema/runtime: got %d/%q", st.Schema, st.Runtime)
	}
	for _, role := range []string{"traces", "graph", "vectors", "inference", "db", "backend", "worker", "smelter", "weaver", "frontend"} {
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
	}

	preStatus := s.argv(t)
	if _, _, code := s.run(t, "status"); code != 0 {
		t.Errorf("status on healthy stack: exit %d", code)
	}
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
	// A config consumer still requires the clone.
	if _, stderr, code := s.run(t, "start", "--service", "worker"); code != 1 {
		t.Errorf("worker outside a clone: want exit 1, got %d", code)
	} else {
		mustContain(t, "stderr", stderr, "must run inside a git clone")
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
	// Dry run must execute nothing beyond KB-root resolution.
	if got := s.argv(t); got != "git rev-parse --show-toplevel\n" {
		t.Errorf("dry-run executed runtime commands:\n%s", got)
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
		{[]string{"start", "--service", "graph", "--config", "anthropic"}, "--config only applies to --service backend, worker, smelter, or weaver."},
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
	for _, absent := range []string{"LOCAL HOST DIRECTORIES", "worker", "traces"} {
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
