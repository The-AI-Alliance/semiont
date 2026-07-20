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
	// A failing run with a password: logged with the value redacted
	// (useradd with no running backend fails, and is the launcher's one
	// password-carrying command).
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
	// backend handle, execs the in-container CLI's useradd, and passes every
	// flag through verbatim.
	s := newScenario(t, "container", "docker")

	// No running backend anywhere: pointed failure.
	_, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--password", "password123")
	if code != 1 {
		t.Fatalf("no-backend useradd: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr,
		"useradd needs a running backend", "semiont start")

	// Name-scan fallback: the runtime whose listing shows semiont-backend.
	s.extraEnv = append(s.extraEnv, "FAKERT_STACK_RUNTIME=docker")
	stdout, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--password", "password123", "--admin")
	if code != 0 {
		t.Fatalf("useradd: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"docker exec semiont-backend semiont useradd --email a@b.co --password password123 --admin")
	// The echoed command redacts the password; the real argv (above) is intact.
	mustContain(t, "stdout", stdout, "--password <redacted>")
	if strings.Contains(stdout, "password123") {
		t.Errorf("password leaked into the echoed command:\n%s", stdout)
	}

	// Record-driven: recorded runtime + container ID beat the name scan.
	writeStackState(t, s, "container")
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := s.run(t, "useradd", "--email", "b@c.co", "--generate-password"); code != 0 {
		t.Fatalf("record-driven useradd: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ = os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"container exec fid-semiont-backend semiont useradd --email b@c.co --generate-password")

	// The in-container CLI failing surfaces as a launcher failure.
	s.extraEnv = append(s.extraEnv, "FAKERT_EXEC_FAIL=1")
	if _, stderr, code := s.run(t, "useradd", "--email", "c@d.co", "--password", "password123"); code != 1 {
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
		"gh codespace create --repo "+csRepo+" --machine premiumLinux",
		"gh codespace ports forward 4000:4000 -c fake-cs-1",
		"gh codespace ssh -c fake-cs-1 -- cat .devcontainer/admin.json")
	mustContain(t, "stdout", stdout,
		"KB repo: "+csRepo,
		"uncommitted changes", "as PUSHED",
		"Creating codespace for "+csRepo,
		"Reading admin credentials",
		"Semiont KB is up in codespace fake-cs-1",
		"Semiont KB         http://localhost:4000",
		"admin@example.com", "fake-admin-pw",
		"local uncommitted changes don't travel",
		"Halt billing:")
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b),
		`"runtime": "codespace"`, `"codespace": "fake-cs-1"`, `"repo": "pingel-org/foo-kb"`,
		`"forwardPid"`, `"forwardPort": 4000`)
	if strings.Contains(string(b), "fake-admin-pw") {
		t.Fatalf("credentials persisted to stack.json:\n%s", b)
	}
	// Placement is never sticky: no machine-wide runtime preference written.
	if rb, err := os.ReadFile(rootsPathFor(s.home)); err == nil && strings.Contains(string(rb), `"runtime": "codespace"`) {
		t.Errorf("codespace recorded as sticky runtime:\n%s", rb)
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
		"Resuming recorded codespace fake-cs-1")
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
	if _, err := os.Stat(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Error("stack.json survived stop --delete")
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
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout,
		"STACKS",
		"CODESPACE", "fake-cs-1", csRepo, "(state: Available)",
		"re-establishing",
		"KB", "healthy", "http://localhost:4000/api/health",
		"run inside the codespace via compose",
		"admin@example.com", "fake-admin-pw",
		"SEMIONT ROOTS")

	// Stopped: honest stopped-but-existing, scriptably unhealthy.
	s.killServes()
	s.extraEnv = append(s.extraEnv[:len(s.extraEnv)-1],
		`FAKERT_GH_CS_LIST=[{"name":"fake-cs-1","state":"Shutdown","repository":"pingel-org/foo-kb"}]`)
	stdout, _, code = s.run(t, "status")
	if code != 1 {
		t.Fatalf("stopped status: want exit 1, got %d\n%s", code, stdout)
	}
	mustContain(t, "stopped status stdout", stdout,
		"(state: Shutdown)", "stopped — state and credentials persist", "semiont start")
}

func TestCodespaceGuardsAndScoping(t *testing.T) {
	// Cross-placement guards: a recorded stack of either kind binds.
	s := newCodespaceScenario(t)
	writeStackState(t, s, "container")
	_, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 1 {
		t.Fatalf("local record + codespace start: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "The local stack is running under container")

	s2 := newCodespaceScenario(t)
	if _, _, code := s2.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatal("create failed")
	}
	s2.killServes()
	// A codespace stack no longer blocks a local start — they coexist (the
	// dry-run proves the local plan renders; only the lens would contend,
	// and it's dropped live).
	stdout, stderr, code := s2.run(t, "start", "--runtime", "container", "--dry-run")
	if code != 0 {
		t.Fatalf("codespace record + local dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "local plan stdout", stdout, "container run -d --rm --name semiont-backend")

	// useradd refuses: the admin was generated at creation.
	_, stderr, code = s2.run(t, "useradd", "--email", "a@b.co", "--password", "password123")
	if code != 1 {
		t.Fatalf("useradd on codespace: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "generated at creation", "semiont status")

	// status --service and stop --service don't apply.
	if _, stderr, code := s2.run(t, "status", "--service", "backend"); code != 1 {
		t.Error("status --service on codespace should fail")
	} else {
		mustContain(t, "stderr", stderr, "--service does not apply to a codespace stack")
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
		{[]string{"start", "--repo", "a/b"}, "--repo/--codespace/--machine only apply to --runtime codespace"},
		{[]string{"start", "--machine", "basicLinux"}, "--repo/--codespace/--machine only apply to --runtime codespace"},
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
		"gh codespace create --repo "+csRepo+" --machine premiumLinux",
		"gh codespace ports forward",
		"cat .devcontainer/admin.json")
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
	stdout, stderr, code = s.run(t, "logs", "--service", "backend")
	if code != 0 {
		t.Fatalf("logs: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "logs stdout", stdout, "[backend] backend out")
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log),
		"gh codespace ssh -c fake-cs-1 -- docker logs --follow semiont-backend")
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
		"STACKS",
		"codespace  "+csRepo+"  fake-cs-1", "KB localhost:4000",
		"codespace  other/bar  bar-cs-1", "KB localhost:4001",
		"semiont status --repo <owner/name>")

	// --repo details one stack, probing ITS port.
	stdout, _, code = s.run(t, "status", "--repo", "other/bar")
	if code != 0 {
		t.Fatalf("detail status: exit %d\n%s", code, stdout)
	}
	mustContain(t, "detail stdout", stdout,
		"bar-cs-1  other/bar", "KB", "healthy", "http://localhost:4001/api/health")

	// Bare logs can't guess between two forwarded stacks; --repo can.
	_, stderr, code = s.run(t, "logs", "--service", "backend")
	if code != 1 {
		t.Fatalf("ambiguous logs: want exit 1, got %d", code)
	}
	if err := os.Truncate(s.log, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, code := s.run(t, "logs", "--repo", "other/bar", "--service", "backend"); code != 0 {
		t.Fatal("targeted logs failed")
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "gh codespace ssh -c bar-cs-1")

	// A bare stop refuses to guess among stacks.
	_, stderr, code = s.run(t, "stop")
	if code != 1 {
		t.Fatalf("ambiguous stop: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "Multiple stacks are recorded",
		"semiont stop --repo "+csRepo, "semiont stop --repo other/bar")

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

func TestFrontendPort(t *testing.T) {
	// --port moves the browser (the one flag-movable port): publish
	// <p>:3000, warn about frontendURL-configured backends, record the
	// moved endpoint so status and stop follow it.
	s := newScenario(t, "container")
	s.noGitRoot = true // "just the browser" needs no clone
	stdout, stderr, code := s.run(t, "start", "--service", "frontend", "--port", "3001")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "--publish 3001:3000")
	mustContain(t, "stdout", stdout,
		"Browser on port 3001", "may reject this origin",
		"🚀 frontend is up")
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), `"endpoint": "http://localhost:3001"`)

	// status probes the recorded endpoint, not the static 3000.
	stdout, _, code = s.run(t, "status", "--service", "frontend")
	if code != 0 {
		t.Fatalf("status: exit %d\n%s", code, stdout)
	}
	mustContain(t, "status stdout", stdout, "http://localhost:3001")

	// Default port stays 3000, no warning.
	s.killServes()
	stdout, _, code = s.run(t, "start", "--service", "frontend")
	if code != 0 {
		t.Fatal("default-port frontend failed")
	}
	if strings.Contains(stdout, "may reject this origin") {
		t.Errorf("default port warned:\n%s", stdout)
	}

	// Scoping: frontend-only, and never with codespace placement.
	for _, tc := range []struct{ args []string }{
		{[]string{"start", "--port", "3001"}},
		{[]string{"start", "--service", "worker", "--port", "3001"}},
		{[]string{"start", "--runtime", "codespace", "--port", "3001"}},
	} {
		if _, stderr, code := s.run(t, tc.args...); code != 1 {
			t.Errorf("%v: want exit 1, got %d", tc.args, code)
		} else {
			mustContain(t, fmt.Sprintf("stderr for %v", tc.args), stderr,
				"--port only applies to --service frontend")
		}
	}
	if _, stderr, code := s.run(t, "start", "--service", "frontend", "--port", "notaport"); code != 1 {
		t.Error("bad port value should fail")
	} else {
		mustContain(t, "stderr", stderr, "Invalid --port")
	}
}

func TestMultiStackLocalPlusCodespace(t *testing.T) {
	// A local stack and codespace stacks coexist in the record set: verbs
	// that can't guess refuse with selectors; useradd targets the local
	// backend; a targeted local stop leaves the codespace records alone.
	s := newCodespaceScenario(t)
	set := `{"schema":3,"stacks":{
	  "local":{"runtime":"container","services":{"backend":{"container":"semiont-backend","id":"fid-semiont-backend","provided":"launcher","startedAt":"2026-07-19T00:00:00Z"}}},
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

	// useradd targets the LOCAL backend when one exists.
	if _, stderr, code := s.run(t, "useradd", "--email", "a@b.co", "--password", "password123"); code != 0 {
		t.Fatalf("useradd: exit %d\nstderr:\n%s", code, stderr)
	}
	log, _ := os.ReadFile(s.log)
	mustContain(t, "argv log", string(log), "container exec fid-semiont-backend semiont useradd")

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
		Schema int                      `json:"schema"`
		Stacks map[string]recordedStack `json:"stacks"`
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
		"container stop fid-semiont-backend", "container rm fid-semiont-frontend",
		"docker stop semiont-backend", "podman stop semiont-backend")
	for _, bad := range []string{"docker stop fid-", "podman stop fid-"} {
		if strings.Contains(fullArgv, bad) {
			t.Errorf("stray sweep used the recorded runtime's IDs: %q", bad)
		}
	}
	if _, err := os.Stat(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Error("stack.json survived a full stop")
	}
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
	// hostReuse steers the RECORDED runtime's targeted teardown: the host
	// process is never stopped there. The stray name-sweep under docker
	// legitimately includes semiont-ollama — a stray container there is not
	// the host process — but must never use the record's runtime-specific IDs.
	if strings.Contains(argv, "container stop semiont-ollama") {
		t.Errorf("schema-1 hostReuse not honored:\n%s", argv)
	}
	if strings.Contains(argv, "docker stop fid-") {
		t.Errorf("stray sweep used the recorded runtime's IDs:\n%s", argv)
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
	mustContain(t, "stdout", stdout,
		"docker pull ghcr.io/the-ai-alliance/semiont-backend:latest",
		"docker run -d --rm --name semiont-backend")
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
		"docker stop semiont-backend", "docker rm semiont-backend")
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
		"docker stop semiont-backend", "docker rm semiont-backend")

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
