// Golden tests for the semiont launcher — the executable spec of its flags,
// runtime selection, required-env extraction and the rest.
//
// Everything external is faked: a private PATH holds one binary (fakert)
// under the name of each program the launcher runs — container, docker,
// podman, git, and what it asks this system about ports and processes — which
// records every invocation to an argv log and plays scripted responses. Detached `run -d`
// spawns real localhost listeners on the published ports so the launcher's
// health gates open. Tests never touch a real runtime.
//
// Run with -update-goldens to rewrite golden files after an adjudicated
// change — the goldens are the spec.
package main_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

var updateGoldens = flag.Bool("update-goldens", false, "rewrite golden files from observed output")

// launcherCoverDir: where every run of the launcher under test writes what of
// the launcher's libraries it ran, for `go tool covdata` to read. go test's
// own -coverprofile cannot hold it: go test reads only what the test binary
// it built wrote.
var launcherCoverDir = flag.String("launcher-coverdir", "", "build the launcher under test with coverage of the launcher's libraries, written to this directory")

var (
	launcherBin string
	fakertBin   string
)

// libraries: the launcher libraries' module, from this directory, and its
// import path.
var libraries = filepath.Join("..", "..", "packages", "go", "launcher")

const librariesImportPath = "github.com/The-AI-Alliance/semiont/packages/go/launcher"

// libraryTestdata: a file of the launcher libraries' testdata: the fixture
// knowledge base (kb/) and the goldens (golden/).
func libraryTestdata(elem ...string) string {
	return filepath.Join(append([]string{libraries, "testdata"}, elem...)...)
}

func TestMain(m *testing.M) {
	flag.Parse()
	binDir, err := os.MkdirTemp("", "launcher-bins")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(binDir)
	launcherBin = filepath.Join(binDir, harness.Exe("semiont"))
	fakertBin = filepath.Join(binDir, harness.Exe("fakert"))
	// The launcher under test is built with the scenario tag, and only that
	// build does three things a released one does not: it verifies images
	// against Sigstore's test authority (packages/go/launcher/provenance/fake.go), told by
	// fake-sigstore.json in its data directory what each image's attestation
	// says; it dials the fake runtime's host address and a fake network
	// address at loopback, where the fake's stand-in services listen, and binds
	// a listener asked for the network address there too
	// (packages/go/launcher/hostnet_scenario.go); and it stages the configs it
	// mounts under the temporary directory its environment names, which is
	// each scenario's own (packages/go/launcher/staging_scenario.go).
	launcherBuild := []string{"build", "-tags", "scenario", "-o", launcherBin}
	if *launcherCoverDir != "" {
		// Absolute, since each launcher runs in its own scenario's directory.
		if *launcherCoverDir, err = filepath.Abs(*launcherCoverDir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := os.MkdirAll(*launcherCoverDir, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		// -coverpkg names the libraries, a module of their own, which -cover
		// alone would leave out, and main too: the compiler adds the call that
		// writes coverage only to a main package it measures, so a launcher
		// whose main is left out writes nothing.
		launcherBuild = append(launcherBuild, "-cover", "-coverpkg", ".,"+librariesImportPath+"/...")
	}
	for _, build := range [][]string{
		append(launcherBuild, "."),
		{"build", "-o", fakertBin, librariesImportPath + "/fakert"},
	} {
		out, err := exec.Command("go", build...).CombinedOutput()
		pkg := build[len(build)-1]
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

// fixtureDocuments: the fixture knowledge base's committed files, below its
// .semiont — its project file and its stack's documents.
var fixtureDocuments = []string{
	"config.yaml",
	"stack/knowledge-base.yaml", "stack/index.yaml", "stack/issuer.yaml",
	"stack/inference/anthropic.yaml", "stack/inference/ollama-gemma.yaml",
}

// mkKB lays out a fake KB clone with the fixture's documents.
func mkKB(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, name := range fixtureDocuments {
		b, err := os.ReadFile(libraryTestdata("kb", ".semiont", filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(root, ".semiont", filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, b, 0o644); err != nil {
			t.Fatal(err)
		}
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
	if err := os.MkdirAll(s.stagingParent(), 0o755); err != nil {
		t.Fatal(err)
	}
	s.log = filepath.Join(s.fakertDir, "argv.log")
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

// stagingParent: where this scenario's launcher stages the configs it mounts:
// the temporary directory the scenario's environment names, under its own
// home, so no scenario finds another's staged configs.
func (s *scenario) stagingParent() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(s.home, "AppData", "Local", "Temp")
	}
	return filepath.Join(s.home, "tmp")
}

// stagingPattern: every staging dir under it, as the launcher prints it.
func (s *scenario) stagingPattern() string {
	return filepath.Join(s.stagingParent(), "semiont-config.*")
}

// stageRe matches one staging dir.
func (s *scenario) stageRe() *regexp.Regexp {
	return regexp.MustCompile(regexp.QuoteMeta(filepath.Join(s.stagingParent(), "semiont-config.")) + `[A-Za-z0-9]+`)
}

// withDomain makes root another knowledge base: its project file names domain
// as its site, so its DID, its stores and its realm's audience are its own.
func withDomain(t *testing.T, root, domain string) {
	t.Helper()
	path := filepath.Join(root, ".semiont", "config.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	site := regexp.MustCompile(`(?m)^  domain: .*$`)
	if !site.Match(b) {
		t.Fatalf("%s names no site.domain to replace:\n%s", path, b)
	}
	if err := os.WriteFile(path, site.ReplaceAll(b, []byte("  domain: "+domain)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// remoteProjectFile: a codespace's .semiont/config.yaml declaring domain, as
// the fake runtime answers a `cat` of it over ssh.
func remoteProjectFile(domain string) string {
	return "project:\n  name: remote-kb\ngit:\n  sync: true\nsite:\n  domain: " + domain + "\n  siteName: Remote KB\n"
}

// writeDocument writes text as the scenario's document at path, below its
// .semiont/stack ("index.yaml", "inference/broker.yaml").
func writeDocument(t *testing.T, s *scenario, path, text string) {
	t.Helper()
	target := filepath.Join(s.kb, ".semiont", "stack", filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fixtureDocument: the text of the fixture's document at path, below its
// .semiont/stack.
func fixtureDocument(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(libraryTestdata("kb", ".semiont", "stack", filepath.FromSlash(path)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// deriveDocument writes the fixture's document at from into the scenario at
// to, with each old text of edits (old, new, old, new, …) replaced by its new
// one; an old text the document does not hold fails the test, so an edit
// cannot silently miss.
func deriveDocument(t *testing.T, s *scenario, from, to string, edits ...string) {
	t.Helper()
	text := fixtureDocument(t, from)
	for i := 0; i+1 < len(edits); i += 2 {
		if !strings.Contains(text, edits[i]) {
			t.Fatalf("%s holds no %q to edit", from, edits[i])
		}
		text = strings.Replace(text, edits[i], edits[i+1], 1)
	}
	writeDocument(t, s, to, text)
}

// editDocument: deriveDocument in place.
func editDocument(t *testing.T, s *scenario, path string, edits ...string) {
	t.Helper()
	deriveDocument(t, s, path, path, edits...)
}

func (s *scenario) mustLog(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(s.log)
	if err != nil {
		t.Fatalf("argv log: %v", err)
	}
	return b
}

// errorReporter: what killServes needs of a testing.T.
type errorReporter interface {
	Helper()
	Errorf(format string, args ...any)
}

// killServes reaps the detached port listeners fakert spawned for `run -d`,
// waiting for each PORT to come free — the next test rebinds the same fixed
// ports, and a merely-signalled process can still hold one for a beat.
//
// The wait is on the ports, not on the pids, because a pid wait cannot
// succeed here: these listeners are spawned by the launcher (fakert's
// `run -d`), so the test process is not their parent and never wait()s for
// them. A killed orphan therefore stays a ZOMBIE — and a zombie still
// answers kill(pid, 0) — so a pid wait would run its full budget on every
// call. The ports are what the next test needs anyway, and the kernel frees
// those at exit, zombie or not.
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

// coverEnv: what a launcher under test is told so it writes its coverage, or
// nothing when the suite does not measure it. A launcher built with coverage
// and given no GOCOVERDIR warns of it on every run.
func coverEnv() []string {
	if *launcherCoverDir == "" {
		return nil
	}
	return []string{"GOCOVERDIR=" + *launcherCoverDir}
}

func (s *scenario) env() []string {
	env := append([]string{
		"PATH=" + s.shim,
		"HOME=" + s.home,
		"FAKERT_LOG=" + s.log,
		"FAKERT_DIR=" + s.fakertDir,
		// The repo, so a fake service can read what its own image declares
		// it serves. A PATH, not a belief: the fake reads the Dockerfile, it
		// is not told the answer.
		"FAKERT_REPO=" + repoRoot(),
	}, coverEnv()...)
	if runtime.GOOS == "windows" {
		// Windows names the home, the application-data directory and the
		// temporary directory by variables of its own.
		env = append(env,
			"USERPROFILE="+s.home,
			"LOCALAPPDATA="+filepath.Join(s.home, "AppData", "Local"),
			"TEMP="+s.stagingParent(),
			"TMP="+s.stagingParent(),
		)
	} else {
		env = append(env, "TMPDIR="+s.stagingParent())
	}
	{
		// Pinned so the boot goldens are deterministic: an unpinned run
		// generates a fresh credential per service and every golden would
		// differ from the last. The worker has none to pin: it proves itself
		// with the machine's key, whose value never reaches argv.
		//
		// Tracks `secretClients` in packages/go/launcher, which this external test
		// package cannot see. Drift is loud rather than silent: a service missing
		// from this list gets a generated credential and its boot golden differs
		// on the very next run.
		for _, svc := range []string{"archivist", "dispatcher", "gateway", "librarian", "smelter", "weaver"} {
			env = append(env, "SEMIONT_OIDC_CLIENT_SECRET_"+strings.ToUpper(svc)+"=test-"+svc+"-client-secret")
		}
	}
	// Pinned because a generated one is random, and the boot goldens compare
	// argv verbatim. Tests that need the generate-and-persist path set
	// noJWTSecret.
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
// either can never bake a tmp dir into a golden that greens on refresh and
// reds on every later run.
func (s *scenario) norm(text string) string {
	// A directory before the one it is under: the staging dir and both homes
	// are under the scenario's home.
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
	// forever after, exactly like the tmp dirs above. Plan mode renders
	// this placeholder too (executor.go), so live and dry-run goldens
	// agree on the one line that cannot be a literal.
	out = keycloakAdminPwRe.ReplaceAllString(out, "KC_BOOTSTRAP_ADMIN_PASSWORD=<keycloak-admin-password>")
	// A Semiont image runs by the digest its attestation is of. The fake
	// authority derives it from the image's name, so it is stable, but it is
	// not what a golden is about; plan mode renders the same placeholder.
	out = verifiedDigestRe.ReplaceAllString(out, "${1}@sha256:<verified>")
	return out
}

// verifiedDigestRe: the digest a verified Semiont image runs by.
var verifiedDigestRe = regexp.MustCompile(`(/semiont-[a-z]+:[A-Za-z0-9._-]+)@sha256:[0-9a-f]{64}`)

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

// setKeyExample: the help's example of setting a provider key, in this
// system's shell.
func setKeyExample() string {
	if runtime.GOOS == "windows" {
		return `$env:ANTHROPIC_API_KEY = "<your-key>"`
	}
	return "export ANTHROPIC_API_KEY=<your-key>"
}

// keyAdvice: the two lines a start prints under a JWT_SECRET key that is too
// short, in this system's shell: how to make one, and how to rotate to it.
func keyAdvice() []string {
	if runtime.GOOS == "windows" {
		const key = `$b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { '{0:x2}' -f $_ })`
		return []string{"Generate one:  " + key, `Rotate with:   $env:JWT_SECRET = "$(` + key + `),$OLD"`}
	}
	return []string{"Generate one:  openssl rand -hex 32", "Rotate with:   export JWT_SECRET=$(openssl rand -hex 32),$OLD"}
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
	path := libraryTestdata("golden", name)
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

// A knowledge base's documents say what it needs and nothing of where: each
// service is staged a document stating where everything is, as literals this
// start placed.
func TestStartStagesEveryAddressAsALiteral(t *testing.T) {
	s := newScenario(t, "container", "docker", "podman")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	librarian := stagedFile(t, s, "librarian.json")
	// The gateway and Neo4j's bolt port are a person's too, so the containers
	// dial their own side of each (containersSide).
	mustContain(t, "staged librarian.json", librarian,
		`"gatewayUrl": "http://192.168.64.1:14000"`, "bolt://192.168.64.1:17687", "http://192.168.64.1:11434", "http://192.168.64.1:8080/realms/semiont")
	if strings.Contains(librarian, "${") {
		t.Errorf("the staged librarian.json leaves an address to its environment:\n%s", librarian)
	}
	mustContain(t, "staged dispatcher.json", stagedFile(t, s, "dispatcher.json"), "192.168.64.1:4222")
	mustContain(t, "staged smelter.json", stagedFile(t, s, "smelter.json"),
		`"gatewayUrl": "http://192.168.64.1:14000"`, `"baseUrl": "http://192.168.64.1:11434"`, `"port": 6333`)
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
		"http://localhost:16686",
		// The collector's readout is the containers', at the bridge address.
		"http://192.168.64.1:24110/metrics",
		"semiont status",
		"semiont logs",
		"semiont stop",
	)
	if strings.Contains(stdout, "Qdrant Dashboard") {
		t.Errorf("the summary offers Qdrant's dashboard, which no person dials:\n%s", stdout)
	}
	// A service credential must never reach the terminal, or the command line
	// the terminal echoes: it crosses through the runtime's environment. Six
	// of them, one per service account.
	if strings.Contains(stdout, "test-gateway-client-secret") || strings.Contains(s.argv(t), "test-gateway-client-secret") {
		t.Error("a service-account secret reached stdout or a command line")
	}
	mustContain(t, "stdout", stdout, "--env SEMIONT_OIDC_CLIENT_SECRET ")
}

// The launcher half of the split supervision gate: local runs pass the
// SEMIONT_SUPERVISE opt-in (the image half, that every image can be
// supervised, is scripts/compliance/audit-supervision.sh). Published images
// run their CMD directly — supervision is a per-run opt-in, and LOCAL
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

// On a codespace resume, post-start's start runs seconds after dockerd: the
// daemon answers, but its first probe container cannot run yet, and a start
// that refused there would leave a resumed KB with no stack. An answering
// daemon gets a bounded wait; its own error is quoted if it never comes good.
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

// Two starts on one KB root at once — a codespace's post-start and the
// laptop's issuer move — would interleave: each sweeping containers the other
// is about to use, the stack ending half on each issuer port. A per-root lock
// makes the second wait for the first, then run its own whole sequence.
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

// `semiont settings network` is local unless set to lan, refuses anything
// else, and `local` returns it to the default (LOCAL-ONLY-STACK D3).
func TestNetworkSettingIsLocalOrLAN(t *testing.T) {
	s := newScenario(t, "container")
	show := func() string {
		t.Helper()
		stdout, stderr, code := s.run(t, "settings", "network")
		if code != 0 {
			t.Fatalf("settings network: exit %d\nstderr:\n%s", code, stderr)
		}
		return stdout
	}
	mustContain(t, "the default", show(), "local", "a stack answers this machine alone")
	if _, stderr, code := s.run(t, "settings", "network", "wide"); code != 1 {
		t.Errorf("settings network wide: exit %d, want 1", code)
	} else {
		mustContain(t, "stderr", stderr, "local or lan")
	}
	if _, stderr, code := s.run(t, "settings", "network", "lan"); code != 0 {
		t.Fatalf("settings network lan: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "lan", show(), "lan", "plain HTTP")
	if _, stderr, code := s.run(t, "settings", "network", "local"); code != 0 {
		t.Fatalf("settings network local: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "back to the default", show(), "a stack answers this machine alone")
}

// A `network lan` start, as a plan: the gateway on every interface beside its
// containers' side, Keycloak on the bridge address behind the issuer proxy,
// its hostname the network address, the proxy started there and the issuer
// asked through it, and the start saying what answers the network.
func TestStartDryRunNetworkLAN(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "settings", "network", "lan"); code != 0 {
		t.Fatalf("settings network lan: exit %d\nstderr:\n%s", code, stderr)
	}
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "dry run", stdout,
		"--publish 4000:4000", "--publish <host-addr>:14000:4000",
		"-p <host-addr>:18080:8080",
		"KC_HOSTNAME=http://<lan-addr>:8080",
		"issuer-proxy --listen <lan-addr>:8080 --upstream <host-addr>:18080 --realm semiont",
		"wait: http://<host-addr>:18080/realms/semiont (90s)",
		"wait: http://<lan-addr>:8080/realms/semiont (15s)",
		"network lan: the gateway answers the network at <lan-addr>:4000",
		"network lan: the issuer answers it at http://<lan-addr>:8080/realms/semiont")
	for _, absent := range []string{"127.0.0.1:4000:4000", "<host-addr>:8080:8080"} {
		if strings.Contains(stdout, absent) {
			t.Errorf("a lan start still publishes %s:\n%s", absent, stdout)
		}
	}
}

// lan is built for Apple container alone: under Docker the issuer is
// keycloak.localhost, which no other machine reaches, so a lan start there
// refuses rather than promise what it cannot do.
func TestStartNetworkLANRefusesDocker(t *testing.T) {
	s := newScenario(t, "docker")
	if _, stderr, code := s.run(t, "settings", "network", "lan"); code != 0 {
		t.Fatalf("settings network lan: exit %d\nstderr:\n%s", code, stderr)
	}
	_, stderr, code := s.run(t, "start", "--dry-run")
	if code != 1 {
		t.Fatalf("a lan start under Docker: exit %d, want 1\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr, "built for Apple container alone", "semiont settings network local")
}

// A `network lan` start, live: the issuer proxy runs (the scenario build puts
// the fake network address on loopback), passes the realm and refuses the
// admin console; every document names the issuer at the network address;
// status shows the proxy; and stop ends it.
func TestStartNetworkLANBoot(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "settings", "network", "lan"); code != 0 {
		t.Fatalf("settings network lan: exit %d\nstderr:\n%s", code, stderr)
	}
	// Every proxy this test sees is ended at its end, whatever the record says
	// by then: a proxy left running would hold 8080 for every later scenario.
	var proxies []int
	t.Cleanup(func() {
		for _, pid := range append(proxies, recordedIssuerProxyPID(t, s)) {
			if pid == 0 {
				continue
			}
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		}
	})
	claimProxy := func() int {
		t.Helper()
		pid := recordedIssuerProxyPID(t, s)
		if pid == 0 {
			t.Fatal("the record names no issuer proxy")
		}
		proxies = append(proxies, pid)
		return pid
	}
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	before := claimProxy()
	mustContain(t, "stdout", stdout,
		"Answering the network at 192.168.2.10",
		"http://192.168.2.10:4000",
		"http://192.168.2.10:8080/realms/semiont",
		"Plain HTTP")
	mustContain(t, "argv", s.argv(t), "--publish 4000:4000", "-p 192.168.64.1:18080:8080", "KC_HOSTNAME=http://192.168.2.10:8080")
	for _, staged := range []string{"librarian.json", "worker.json", "gateway.json"} {
		mustContain(t, "staged "+staged, stagedFile(t, s, staged), "http://192.168.2.10:8080/realms/semiont")
	}
	status := func(url string) int {
		t.Helper()
		resp, err := http.Get(url)
		if err != nil {
			t.Fatalf("GET %s: %v", url, err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := status("http://127.0.0.1:8080/realms/semiont"); got != http.StatusOK {
		t.Errorf("the realm through the issuer proxy answered %d", got)
	}
	if got := status("http://127.0.0.1:8080/admin/master/console/"); got != http.StatusNotFound {
		t.Errorf("the admin console through the issuer proxy answered %d, want 404", got)
	}
	sstdout, _, _ := s.run(t, "status")
	mustContain(t, "status", sstdout, "network lan", "issuer proxy: pid")
	// A proxy that died is started again by status: under `network lan`
	// nobody signs in without it. The killed proxy is reaped by init, not by
	// this test, and a status that finds it not yet gone, or its port not yet
	// free, leaves the record as it was: so status runs until the record names
	// another proxy.
	killed := before
	if p, err := os.FindProcess(killed); err == nil {
		_ = p.Kill()
	}
	reviveBy := time.Now().Add(10 * time.Second)
	var revival string
	for {
		out, errOut, _ := s.run(t, "status")
		if pid := recordedIssuerProxyPID(t, s); pid != 0 && pid != killed {
			revival = out + errOut
			break
		}
		if time.Now().After(reviveBy) {
			t.Fatalf("status did not start the killed issuer proxy %d again; the last status said:\n%s%s", killed, out, errOut)
		}
		time.Sleep(200 * time.Millisecond)
	}
	mustContain(t, "status", revival, fmt.Sprintf("The issuer proxy (pid %d) is not running; starting it again.", killed))
	before = claimProxy()
	if got := status("http://127.0.0.1:8080/realms/semiont"); got != http.StatusOK {
		t.Errorf("after status restarted the issuer proxy the realm through it answered %d", got)
	}
	// Restarting the issuer replaces its proxy: the old one leaves the
	// issuer's port before the restart checks it, and a new one serves it.
	if stdout, stderr, code := s.run(t, "start", "--service", "identity"); code != 0 {
		t.Fatalf("start --service identity: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if after := claimProxy(); after == before {
		t.Errorf("after an issuer restart the record names proxy pid %d, the one before it: want a new one", after)
	}
	if got := status("http://127.0.0.1:8080/realms/semiont"); got != http.StatusOK {
		t.Errorf("after an issuer restart the realm through the proxy answered %d", got)
	}
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		resp, err := http.Get("http://127.0.0.1:8080/realms/semiont")
		if err != nil {
			break
		}
		resp.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("the issuer proxy still answers after stop")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// recordedIssuerProxyPID: the issuer proxy s's local stack record names, or 0.
func recordedIssuerProxyPID(t *testing.T, s *scenario) int {
	t.Helper()
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		return 0
	}
	var doc struct {
		Stacks map[string]struct {
			IssuerProxy *struct {
				PID int `json:"pid"`
			} `json:"issuerProxy"`
		} `json:"stacks"`
	}
	if json.Unmarshal(b, &doc) != nil || doc.Stacks["local"].IssuerProxy == nil {
		return 0
	}
	return doc.Stacks["local"].IssuerProxy.PID
}

// The issuer's port is the launcher's to place, like its host — one Keycloak
// port per KB, the same number on both ends, so a laptop can hold a forward
// per codespace KB. KEYCLOAK_PORT follows the launcher's env shape: the
// environment wins, the root records it, and 8080 is the default. The
// codespace's post-start runs a bare start on every resume, which is why the
// port a laptop moved it to must stick. The port reaches each service as part
// of the issuer its staged config states.
func TestKeycloakPortIsPlacedAndSticky(t *testing.T) {
	s := newScenario(t, "container")
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
		if run := keycloakRun(t, argv); !strings.Contains(run, "-p 192.168.64.1:"+step.want+":8080") {
			t.Errorf("%s: Keycloak not published on %s:\n%s", step.name, step.want, run)
		}
		issuer := "http://192.168.64.1:" + step.want + "/realms/semiont"
		for _, staged := range []string{"worker.json", "smelter.json", "weaver.json", "librarian.json", "archivist.json", "gateway.json", "dispatcher.json"} {
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
				// resolve the issuer's name: a service's client id, or the
				// worker's key. A builder that forgot either half would fail
				// sign-in or its own start.
				dialers := 0
				for _, line := range strings.Split(s.argv(t), "\n") {
					if !strings.Contains(line, "SEMIONT_OIDC_CLIENT_ID=") && !strings.Contains(line, "--env SEMIONT_OIDC_CLIENT_KEY") {
						continue
					}
					dialers++
					if !strings.Contains(line, "--add-host keycloak.localhost:host-gateway") {
						t.Errorf("a container holding a realm credential cannot resolve the issuer's name:\n%s", line)
					}
				}
				if dialers == 0 {
					t.Fatal("no container carries SEMIONT_OIDC_CLIENT_ID or SEMIONT_OIDC_CLIENT_KEY — the scan matched nothing, so it proved nothing")
				}
				// The issuer is named in what each service is staged; the probe's
				// answer still places every other daemon.
				librarian := stagedFile(t, s, "librarian.json")
				if !strings.Contains(librarian, "http://keycloak.localhost:8080/realms/semiont") {
					t.Errorf("the staged issuer is not the issuer's name:\n%s", librarian)
				}
				if !strings.Contains(librarian, "bolt://"+probe.addr+":7687") {
					t.Errorf("the probe's answer %s does not place the other daemons:\n%s", probe.addr, librarian)
				}
			})
		}
	}
}

// Keycloak runs its production server, its hostname fixed at the issuer's
// origin, so every token names the issuer the services are told to trust,
// wherever it was asked for. Each runtime names the issuer differently, and
// the issuer is read back from the gateway's staged document.
func TestKeycloakRunsInProductionModeAtTheIssuerTheServicesTrust(t *testing.T) {
	for _, rt := range []string{"container", "docker", "podman"} {
		t.Run(rt, func(t *testing.T) {
			s := newScenario(t, "container", "docker", "podman")
			stdout, stderr, code := s.run(t, "start", "--runtime", rt)
			if code != 0 {
				t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
			}
			var keycloak []string
			for _, line := range strings.Split(s.argv(t), "\n") {
				if strings.Contains(line, " run ") && strings.Contains(line, "--name semiont-keycloak ") {
					keycloak = strings.Fields(line)
				}
			}
			if keycloak == nil {
				t.Fatalf("no Keycloak run in the argv log:\n%s", s.argv(t))
			}
			hostname, command := "", ""
			for i, field := range keycloak {
				if v, ok := strings.CutPrefix(field, "KC_HOSTNAME="); ok {
					hostname = v
				}
				if strings.HasPrefix(field, "quay.io/keycloak/keycloak:") && i+1 < len(keycloak) {
					command = keycloak[i+1]
				}
			}
			if command != "start" {
				t.Errorf("Keycloak runs %q, not its production server (start):\n%s", command, strings.Join(keycloak, " "))
			}
			var gateway struct {
				Identity struct {
					Issuer string `json:"issuer"`
				} `json:"identity"`
			}
			if err := json.Unmarshal([]byte(stagedFile(t, s, "gateway.json")), &gateway); err != nil {
				t.Fatal(err)
			}
			if hostname == "" || gateway.Identity.Issuer != hostname+"/realms/semiont" {
				t.Errorf("Keycloak's hostname is %q and the gateway trusts the issuer %q: its tokens would name another issuer", hostname, gateway.Identity.Issuer)
			}
		})
	}
}

// The worker's key is proved where the worker signs in: at the issuer the
// services trust. A key's assertion names the issuer it is for, and Keycloak,
// its hostname fixed at the issuer's origin, admits one only under that name,
// wherever the request reached it. Under Docker and Podman the launcher
// reaches its Keycloak at localhost, not at keycloak.localhost, so a preflight
// asked there is refused for a realm the worker signs in at, and the start
// stops. fakert's Keycloak applies the same rule.
func TestPreflightProvesTheWorkerKeyAtTheIssuerTheServicesTrust(t *testing.T) {
	for _, rt := range []string{"container", "docker", "podman"} {
		t.Run(rt, func(t *testing.T) {
			s := newScenario(t, "container", "docker", "podman")
			stdout, stderr, code := s.run(t, "start", "--runtime", rt)
			if code != 0 {
				t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
			}
			var gateway struct {
				Identity struct {
					Issuer string `json:"issuer"`
				} `json:"identity"`
			}
			if err := json.Unmarshal([]byte(stagedFile(t, s, "gateway.json")), &gateway); err != nil {
				t.Fatal(err)
			}
			aud, err := os.ReadFile(filepath.Join(s.fakertDir, "client-assertion-aud.txt"))
			if err != nil {
				t.Fatalf("no assertion reached the issuer — the preflight did not prove the worker's key: %v", err)
			}
			if got, want := strings.TrimSpace(string(aud)), gateway.Identity.Issuer+"/protocol/openid-connect/token"; got != want {
				t.Errorf("the worker's assertion is for %s, not the token endpoint of the issuer the services trust, %s", got, want)
			}
		})
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

// machineRecords: the machine's containers' records, and how the local stack
// records the roles they serve, read from the PARSED record: a machine record
// and a stack service could both say "ollama", so a substring cannot say
// where it appeared.
type machineRecords struct {
	Machine map[string]*struct {
		Container string `json:"container"`
		ID        string `json:"id"`
		Image     string `json:"image"`
		Runtime   string `json:"runtime"`
		Endpoint  string `json:"endpoint"`
		Cache     string `json:"cache"`
		Ports     []int  `json:"ports"`
	} `json:"machine"`
	Stacks map[string]struct {
		Ports    []int `json:"ports"`
		Services map[string]struct {
			Container string `json:"container"`
			ID        string `json:"id"`
			Provided  string `json:"provided"`
		} `json:"services"`
	} `json:"stacks"`
}

func readMachineRecords(t *testing.T, s *scenario) machineRecords {
	t.Helper()
	rec, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatalf("stack.json: %v", err)
	}
	var m machineRecords
	if err := json.Unmarshal(rec, &m); err != nil {
		t.Fatalf("stack.json: %v\n%s", err, rec)
	}
	return m
}

func TestTheMachinesOllamaLifecycle(t *testing.T) {
	// The machine's Ollama keeps a record of its own, apart from the stack's,
	// as the Browser does. A start keeps a current one; another cache asked
	// for, a stale image or `start --service inference` restarts it; a stop of
	// one of the stack's services leaves it; `stop --service inference` stops
	// it alone, and a bare stop with everything else.
	s := newScenario(t, "container")
	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("first start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	first := readMachineRecords(t, s)
	ollama := first.Machine["semiont-ollama"]
	if ollama == nil || ollama.Container != "semiont-ollama" || ollama.ID == "" || ollama.Runtime != "container" {
		t.Fatalf("no machine-level Ollama record naming its container, ID and runtime: %+v", ollama)
	}
	if ollama.Cache != "semiont-ollama-models" {
		t.Errorf("the record's cache is %q: want the named volume a home with no ~/.ollama gets", ollama.Cache)
	}
	if !slices.Equal(ollama.Ports, []int{11434}) {
		t.Errorf("the record's ports are %v: want the 11434 its start required free", ollama.Ports)
	}
	inference := first.Stacks["local"].Services["inference"]
	if inference.Provided != "machine" || inference.Container != "semiont-ollama" || inference.ID != "" {
		t.Errorf("the stack records inference as %+v: want provided by the machine's semiont-ollama, with no ID of its own", inference)
	}
	// Ollama's port is the machine's, not among the stack's claims.
	for _, p := range first.Stacks["local"].Ports {
		if p == 11434 {
			t.Errorf("Ollama's port recorded among the stack's claims: %v", first.Stacks["local"].Ports)
		}
	}

	// A re-run that finds it running as its record says, on the image it
	// would run, keeps it: no stop, no rm, no run, and the record unchanged.
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_ollama=running",
		"FAKERT_IMAGE_ollama="+ollama.Image)
	before := s.mustLog(t)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("keeping start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "keep message", stdout, "the machine's Ollama already running")
	if strings.Contains(stdout, "using host Ollama") {
		t.Errorf("the re-run took the machine's own semiont-ollama for a host install:\n%s", stdout)
	}
	for _, churn := range []string{"rm semiont-ollama", "--name semiont-ollama"} {
		if strings.Contains(fresh, churn) {
			t.Errorf("a current Ollama was churned (%q):\n%s", churn, fresh)
		}
	}
	if kept := readMachineRecords(t, s).Machine["semiont-ollama"]; kept == nil || kept.ID != ollama.ID {
		t.Errorf("the kept Ollama's record changed: %+v, was %+v", kept, ollama)
	}

	// The stack's inference row is the machine's Ollama: its logs are that
	// container's, by the ID its own record names.
	before = s.mustLog(t)
	if stdout, stderr, code := s.run(t, "logs", "--service", "inference"); code != 0 {
		t.Fatalf("logs --service inference: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "logs --service inference's argv", strings.TrimPrefix(string(s.mustLog(t)), string(before)), "container logs", ollama.ID)

	// A stop of one of the stack's own services leaves it.
	before = s.mustLog(t)
	if _, stderr, code := s.run(t, "stop", "--service", "gateway"); code != 0 {
		t.Fatalf("stop --service gateway: exit %d\nstderr:\n%s", code, stderr)
	}
	if fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before)); strings.Contains(fresh, "semiont-ollama") || strings.Contains(fresh, ollama.ID) {
		t.Errorf("stopping the gateway touched the machine's Ollama:\n%s", fresh)
	}
	if readMachineRecords(t, s).Machine["semiont-ollama"] == nil {
		t.Errorf("stopping the gateway forgot the machine's Ollama")
	}

	// Another cache asked for restarts it, on that cache.
	before = s.mustLog(t)
	stdout, stderr, code = s.run(t, "start", "--ollama-cache", "host")
	if code != 0 {
		t.Fatalf("start --ollama-cache host: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	hostCache := filepath.Join(s.home, ".ollama")
	mustContain(t, "another cache's argv", fresh, "container rm semiont-ollama", "--name semiont-ollama", "-v "+hostCache+":/root/.ollama")
	if moved := readMachineRecords(t, s).Machine["semiont-ollama"]; moved == nil || moved.Cache != hostCache {
		t.Errorf("the restarted Ollama's record does not name the cache asked for: %+v", moved)
	}

	// A stale image restarts it.
	for i, e := range s.extraEnv {
		if strings.HasPrefix(e, "FAKERT_IMAGE_ollama=") {
			s.extraEnv[i] = "FAKERT_IMAGE_ollama=ollama/ollama:0.0.1"
		}
	}
	before = s.mustLog(t)
	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("stale-image start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "stale image's argv", fresh, "container rm semiont-ollama", "--name semiont-ollama")

	// `start --service inference` is the explicit refresh: it restarts a
	// current one.
	for i, e := range s.extraEnv {
		if strings.HasPrefix(e, "FAKERT_IMAGE_ollama=") {
			s.extraEnv[i] = "FAKERT_IMAGE_ollama=" + ollama.Image
		}
	}
	before = s.mustLog(t)
	if stdout, stderr, code := s.run(t, "start", "--service", "inference"); code != 0 {
		t.Fatalf("start --service inference: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "--service inference's argv", fresh, "container rm semiont-ollama", "--name semiont-ollama")

	// Its dry run says so, from the record, and runs nothing.
	restarted := readMachineRecords(t, s).Machine["semiont-ollama"]
	before = s.mustLog(t)
	stdout, stderr, code = s.run(t, "stop", "--service", "inference", "--dry-run")
	if code != 0 {
		t.Fatalf("stop --service inference --dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop --service inference --dry-run", stdout, "# stop the machine's Ollama:",
		"container stop "+restarted.ID, "container stop semiont-ollama", "container rm semiont-ollama")
	mustNotContain(t, "stop --service inference --dry-run", stdout, "semiont-gateway")
	if fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before)); fresh != "" {
		t.Errorf("a dry run ran:\n%s", fresh)
	}

	// `stop --service inference` stops it alone and forgets its record; the
	// stack's record stands.
	before = s.mustLog(t)
	stdout, stderr, code = s.run(t, "stop", "--service", "inference")
	if code != 0 {
		t.Fatalf("stop --service inference: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop --service inference", stdout, "Ollama stopped")
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "stop --service inference's argv", fresh, "container stop semiont-ollama", "container rm semiont-ollama")
	if strings.Contains(fresh, "semiont-gateway") {
		t.Errorf("stop --service inference touched the stack:\n%s", fresh)
	}
	if after := readMachineRecords(t, s); after.Machine["semiont-ollama"] != nil || after.Stacks["local"].Services["gateway"].Provided == "" {
		t.Errorf("after stop --service inference: want no Ollama record and the stack's standing, got %+v", after)
	}

	// A bare stop stops it with everything else.
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start before the bare stop: exit %d\nstderr:\n%s", code, stderr)
	}
	before = s.mustLog(t)
	stdout, stderr, code = s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "bare stop", stdout, "Ollama stopped", "Browser stopped")
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "bare stop's argv", fresh, "container stop semiont-ollama", "container rm semiont-ollama")
	if left, err := os.ReadFile(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Errorf("stack.json after a bare stop: %v\n%s", err, left)
	}
}

func TestTheMachinesTelemetryLifecycle(t *testing.T) {
	// The collector, Jaeger and Prometheus run for the machine, as its Ollama
	// does: each keeps a record of its own, a start keeps a current one, and
	// its config lives beside the record, written only as it (re)starts.
	// --no-observe leaves Jaeger and Prometheus alone, and the collector's
	// traces go to Jaeger whenever Jaeger answers.
	s := newScenario(t, "container")
	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("first start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	first := readMachineRecords(t, s)
	for name, ports := range map[string][]int{
		"semiont-otel-collector": {4318, 24110}, "semiont-jaeger": {16686, 14318}, "semiont-prometheus": {9090},
	} {
		if rec := first.Machine[name]; rec == nil || rec.ID == "" || rec.Runtime != "container" || !slices.Equal(rec.Ports, ports) {
			t.Errorf("%s's machine record: %+v, want its ID, runtime container and ports %v", name, rec, ports)
		}
	}
	for role, name := range map[string]string{"collector": "semiont-otel-collector", "traces": "semiont-jaeger", "metrics": "semiont-prometheus"} {
		if svc := first.Stacks["local"].Services[role]; svc.Provided != "machine" || svc.Container != name || svc.ID != "" {
			t.Errorf("the stack records %s as %+v: want provided by the machine's %s, with no ID of its own", role, svc, name)
		}
	}
	for _, p := range first.Stacks["local"].Ports {
		if slices.Contains([]int{4318, 24110, 16686, 14318, 9090}, p) {
			t.Errorf("the telemetry's %d is among the stack's claims: %v", p, first.Stacks["local"].Ports)
		}
	}
	telemetry := filepath.Join(stateHomeFor(s.home), "telemetry")
	collectorYAML := func() string {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(telemetry, "collector.yaml"))
		if err != nil {
			t.Fatalf("the collector's config: %v", err)
		}
		return string(b)
	}
	mustContain(t, "collector.yaml with Jaeger up", collectorYAML(), "otlphttp/jaeger")
	if _, err := os.Stat(filepath.Join(telemetry, "prometheus.yml")); err != nil {
		t.Errorf("Prometheus's config: %v", err)
	}
	mustContain(t, "first start's argv", string(s.mustLog(t)),
		filepath.Join("telemetry", "collector.yaml")+":/etc/otelcol/config.yaml:ro",
		filepath.Join("telemetry", "prometheus.yml")+":/etc/prometheus/prometheus.yml:ro")

	// A re-run that finds each running as its record says, on the image it
	// would run, keeps it.
	for _, svc := range []string{"otel-collector", "jaeger", "prometheus"} {
		s.extraEnv = append(s.extraEnv, "FAKERT_STATE_"+svc+"=running",
			"FAKERT_IMAGE_"+svc+"="+first.Machine["semiont-"+svc].Image)
	}
	churned := func(label, fresh string, names ...string) {
		t.Helper()
		for _, name := range names {
			for _, churn := range []string{"rm " + name, "--name " + name} {
				if strings.Contains(fresh, churn) {
					t.Errorf("%s churned %s (%q):\n%s", label, name, churn, fresh)
				}
			}
		}
	}
	before := s.mustLog(t)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("keeping start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "keeping start", stdout, "traces — Jaeger already running", "metrics — Prometheus already running", "collector — OTel already running")
	churned("a keeping start", strings.TrimPrefix(string(s.mustLog(t)), string(before)), "semiont-otel-collector", "semiont-jaeger", "semiont-prometheus")
	kept := readMachineRecords(t, s)
	for _, name := range []string{"semiont-otel-collector", "semiont-jaeger", "semiont-prometheus"} {
		if k := kept.Machine[name]; k == nil || k.ID != first.Machine[name].ID {
			t.Errorf("the kept %s's record changed: %+v, was %+v", name, k, first.Machine[name])
		}
	}

	// --no-observe leaves Jaeger and Prometheus alone, and the collector,
	// whose traces still have a Jaeger to go to, is kept.
	before = s.mustLog(t)
	if stdout, stderr, code := s.run(t, "start", "--no-observe"); code != 0 {
		t.Fatalf("start --no-observe: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustNotContain(t, "start --no-observe's argv", fresh, "semiont-jaeger", "semiont-prometheus")
	churned("start --no-observe", fresh, "semiont-otel-collector")

	// `stop --service traces` stops Jaeger alone and forgets its record.
	before = s.mustLog(t)
	stdout, stderr, code = s.run(t, "stop", "--service", "traces")
	if code != 0 {
		t.Fatalf("stop --service traces: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop --service traces", stdout, "Jaeger stopped")
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "stop --service traces' argv", fresh, "container stop "+first.Machine["semiont-jaeger"].ID, "container rm semiont-jaeger")
	mustNotContain(t, "stop --service traces' argv", fresh, "semiont-otel-collector", "semiont-prometheus", "semiont-gateway")
	if after := readMachineRecords(t, s); after.Machine["semiont-jaeger"] != nil || after.Machine["semiont-otel-collector"] == nil {
		t.Errorf("after stop --service traces: want no Jaeger record and the collector's standing, got %+v", after.Machine)
	}

	// With no Jaeger to send them to, the collector is restarted into
	// discarding traces; --no-observe still starts no Jaeger.
	before = s.mustLog(t)
	if stdout, stderr, code := s.run(t, "start", "--no-observe"); code != 0 {
		t.Fatalf("start --no-observe without Jaeger: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "start --no-observe without Jaeger's argv", fresh, "container rm semiont-otel-collector", "--name semiont-otel-collector")
	mustNotContain(t, "start --no-observe without Jaeger's argv", fresh, "--name semiont-jaeger")
	mustNotContain(t, "collector.yaml with no Jaeger", collectorYAML(), "otlphttp/jaeger")

	// An observing start brings Jaeger back and restarts the collector into
	// sending to it; Prometheus, current, is kept.
	before = s.mustLog(t)
	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("observing start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "observing start's argv", fresh, "--name semiont-jaeger", "container rm semiont-otel-collector", "--name semiont-otel-collector")
	churned("an observing start", fresh, "semiont-prometheus")
	mustContain(t, "collector.yaml with Jaeger back", collectorYAML(), "otlphttp/jaeger")

	// A bare stop stops them after the stack: the collector, Prometheus,
	// Jaeger, then Ollama, then the Browser.
	before = s.mustLog(t)
	stdout, stderr, code = s.run(t, "stop")
	if code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "bare stop", stdout, "OTel collector stopped", "Prometheus stopped", "Jaeger stopped", "Ollama stopped", "Browser stopped")
	fresh = strings.TrimPrefix(string(s.mustLog(t)), string(before))
	order := []string{"stop fid-semiont-gateway", "stop semiont-otel-collector", "stop semiont-prometheus", "stop semiont-jaeger", "stop semiont-ollama", "stop semiont-browser"}
	at := -1
	for _, step := range order {
		i := strings.Index(fresh, step)
		if i < 0 || i < at {
			t.Errorf("a bare stop ran %q out of the order %v:\n%s", step, order, fresh)
		}
		at = i
	}
	if left, err := os.ReadFile(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Errorf("stack.json after a bare stop: %v\n%s", err, left)
	}
}

// localImages: the scenario's documents naming each of Semiont's images at
// :local, the machine's Browser's and worker's included — a developer's
// checkout.
func localImages(t *testing.T, s *scenario) {
	t.Helper()
	editDocument(t, s, "knowledge-base.yaml",
		"semiont-gateway:latest", "semiont-gateway:local",
		"semiont-dispatcher:latest", "semiont-dispatcher:local",
		"semiont-archivist:latest", "semiont-archivist:local")
	editDocument(t, s, "index.yaml",
		"semiont-librarian:latest", "semiont-librarian:local",
		"semiont-smelter:latest", "semiont-smelter:local",
		"semiont-weaver:latest", "semiont-weaver:local")
	editMachineDocument(t, s, "worker", "workers.yaml", "semiont-worker:latest", "semiont-worker:local")
	editMachineDocument(t, s, "browser", "browser.yaml", "semiont-browser:latest", "semiont-browser:local")
}

func TestStartLocalImagesBoot(t *testing.T) {
	s := newScenario(t, "container")
	localImages(t, s)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	checkGolden(t, "start-local-version-boot.argv", s.argv(t))
	if strings.Contains(s.argv(t), " pull ") {
		t.Error("an image tagged :local must not be pulled")
	}
	// No release built them, so nothing vouches for them, and every start
	// says so, naming each.
	mustContain(t, "the start's warning", stdout+stderr,
		"Unverified: ghcr.io/the-ai-alliance/semiont-gateway:local, ghcr.io/the-ai-alliance/semiont-archivist:local, ghcr.io/the-ai-alliance/semiont-librarian:local",
		"Unverified: ghcr.io/the-ai-alliance/semiont-browser:local",
		"For development only")
}

// fakeAttestations: what the scenario's Sigstore test authority attests of
// each image named. The launcher under test, built with the scenario tag, reads
// it from fake-sigstore.json in its data directory (provenance/fake.go); an
// image it does not name is attested as a release built it.
func fakeAttestations(t *testing.T, s *scenario, said map[string]map[string]any) {
	t.Helper()
	b, err := json.Marshal(said)
	if err != nil {
		t.Fatal(err)
	}
	dir := dataHomeFor(s.home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fake-sigstore.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

const servicesRelease = "https://github.com/The-AI-Alliance/semiont/.github/workflows/publish-service-images.yml@refs/tags/v0.7.0"

// An image of Semiont's runs only when a release built it, and a start that
// would run one no release built refuses before it touches anything: the
// running stack stays as it was.
func TestAnImageNoReleaseBuiltIsRefusedBeforeAnythingIsTornDown(t *testing.T) {
	const worker = "ghcr.io/the-ai-alliance/semiont-worker:latest"
	for _, c := range []struct {
		name string
		said map[string]any
		why  string
	}{
		{"built from main", map[string]any{"identity": strings.Replace(servicesRelease, "refs/tags/v0.7.0", "refs/heads/main", 1)}, "none of its 1 attestations is build provenance"},
		{"with no attestation", map[string]any{"absent": true}, "no attestation of it"},
		{"attested as another image", map[string]any{"identity": servicesRelease, "subject": "sha256:" + strings.Repeat("0", 64)}, "none of its 1 attestations is build provenance"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := newScenario(t, "container")
			fakeAttestations(t, s, map[string]map[string]any{worker: c.said})
			stdout, stderr, code := s.run(t, "start")
			if code == 0 {
				t.Fatalf("started\nstdout:\n%s", stdout)
			}
			mustContain(t, "refusal", stdout+stderr, worker+" does not run", c.why,
				"publish-service-images.yml, run at a release tag")
			argv := s.argv(t)
			for _, touched := range []string{"stop semiont-", "run -d", " pull "} {
				if strings.Contains(argv, touched) {
					t.Errorf("a refused start touched the stack (%q):\n%s", touched, argv)
				}
			}
		})
	}
}

// The Browser's image is a release's only when the Browser's own workflow
// built it: the services' workflow signing it does not make it one.
func TestTheBrowsersImageIsHeldToItsOwnWorkflow(t *testing.T) {
	const browser = "ghcr.io/the-ai-alliance/semiont-browser:latest"
	s := newScenario(t, "container")
	fakeAttestations(t, s, map[string]map[string]any{browser: {"identity": servicesRelease}})
	stdout, stderr, code := s.run(t, "start")
	if code == 0 {
		t.Fatalf("started\nstdout:\n%s", stdout)
	}
	mustContain(t, "refusal", stdout+stderr, browser+" does not run", "publish-browser.yml, run at a release tag")
	if strings.Contains(s.argv(t), "--name semiont-browser") {
		t.Errorf("the refused Browser ran:\n%s", s.argv(t))
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
		"The knowledge base's documents name the variable ANTHROPIC_API_KEY (fromEnv), and it is not set in the environment.",
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
	mustContain(t, "stdout", stdout, "--config <name>", "--dry-run", "--ollama-cache", setKeyExample())
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
	// Admin seeding is `semiont useradd`'s; start does not know these flags
	// at all.
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
	mustContain(t, "stderr", stderr, "Config not found: "+filepath.FromSlash(".semiont/stack/inference/nope.yaml"))
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

// The Issuer document's database name is the one the realm is kept in: the
// PostgreSQL the launcher runs creates it, the launcher makes sure of it, and
// Keycloak connects to it.
func TestStartKeepsTheRealmInTheDatabaseTheIssuerNames(t *testing.T) {
	s := newScenario(t, "container")
	editDocument(t, s, "issuer.yaml", "name: keycloak", "name: iam")
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stdout", stdout,
		"POSTGRES_DB=iam",
		"# create database iam on PostgreSQL if absent",
		":5432/iam ")
	mustNotContain(t, "stdout", stdout, "/keycloak ", "database keycloak")
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

func TestStartDryRunLocalImages(t *testing.T) {
	s := newScenario(t, "container")
	localImages(t, s)
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	checkGolden(t, "start-dryrun-local.txt", s.norm(stdout))
}

// --- local-stack state persistence ---

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

// testKBKey: the slug of the test KB's did:web (packages/go/launcher/testdata/kb/.semiont/config.yaml).
const testKBKey = "example.github.io-test-kb"

// Two knowledge bases of distinct DIDs, started one after the other on one
// machine: each start signs its services in at its own realm, which gives
// their tokens its own knowledge base as audience, and each keeps its stores
// under its own DID. Running them at once is the step that names and ports
// each knowledge base's own services.
func TestTwoKnowledgeBasesStartInTurn(t *testing.T) {
	s := newScenario(t, "container")
	other := asTheSystemNamesIt(t, mkKB(t))
	withDomain(t, other, "example.github.io:other-kb")

	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("the first knowledge base's start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}

	// The identity preflight asks each service's token for this knowledge
	// base's audience, so this start passes only if its realm gave its own.
	s.kb = other
	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("the second knowledge base's start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	realm, err := os.ReadFile(filepath.Join(s.fakertDir, "realm-semiont-keycloak.json"))
	if err != nil {
		t.Fatalf("the realm the second start's issuer imported: %v", err)
	}
	mustContain(t, "the second start's realm", string(realm), semiont.KbResource("example.github.io:other-kb"))
	if strings.Contains(string(realm), semiont.KbResource("example.github.io:test-kb")) {
		t.Errorf("the second knowledge base's realm names the first's audience:\n%s", realm)
	}

	for _, key := range []string{testKBKey, "example.github.io-other-kb"} {
		if _, err := os.Stat(stateRootFor(s.home, key)); err != nil {
			t.Errorf("no stores of their own for %s: %v", key, err)
		}
	}
	roots, _, _ := s.run(t, "roots")
	mustContain(t, "roots", roots, "did:web:example.github.io:test-kb", "did:web:example.github.io:other-kb")
}

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
// the Smelter's reconcile re-derives every lost map on the next start.
//
// The container path is a constant — the Archivist's document names it — so
// this mount looks like every other one: KB identity on the host side only.
func TestAnchoredTextStorePersistsAcrossStarts(t *testing.T) {
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
	// A literal count would encode how many containers mount it, which is
	// TestNoStoreIsMountedByTwoContainers' question, not this one's.
	if firstBoot == 0 {
		t.Fatalf("anchored-text mount absent from the first boot")
	}
	if total := strings.Count(string(s.mustLog(t)), mount); total != firstBoot*2 {
		t.Errorf("anchored-text mount did not survive the restart: %d on the first boot, %d across both", firstBoot, total)
	}
}

// No store is mounted by two containers. Under Apple container each container
// is its own VM, and a reader in one keeps a renamed file's old length, so a
// second mounter of a host directory is a reader that can be handed a file cut
// short. The anchored-text store and the state tree are the Archivist's
// alone: the Smelter keeps its entries on the Archivist's surface, and the
// Librarian reads the views on the bus.
func TestNoStoreIsMountedByTwoContainers(t *testing.T) {
	name := regexp.MustCompile(`--name (semiont-\S+)`)
	for _, rt := range []string{"container", "docker"} {
		t.Run(rt, func(t *testing.T) {
			s := newScenario(t, "container", "docker", "podman")
			s.extraEnv = append(s.extraEnv, "FAKERT_NSLOOKUP=ok")
			if _, stderr, code := s.run(t, "start", "--runtime", rt); code != 0 {
				t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
			}
			under := stateRootFor(s.home, testKBKey) + string(filepath.Separator)
			mounters := map[string]map[string]bool{} // store dir -> the containers that mount it
			for _, line := range strings.Split(string(s.mustLog(t)), "\n") {
				m := name.FindStringSubmatch(line)
				if m == nil {
					continue
				}
				for _, opt := range []string{"-v ", "--volume "} {
					rest := line
					for {
						at := strings.Index(rest, opt+under)
						if at < 0 {
							break
						}
						rest = rest[at+len(opt+under):]
						end := strings.IndexAny(rest, ":"+string(filepath.Separator))
						if end < 0 {
							t.Fatalf("a mount under %s names no target:\n%s", under, line)
						}
						if mounters[rest[:end]] == nil {
							mounters[rest[:end]] = map[string]bool{}
						}
						mounters[rest[:end]][m[1]] = true
					}
				}
			}
			if len(mounters) == 0 {
				t.Fatalf("no container mounts a store under %s: the census read nothing", under)
			}
			containers := func(store string) []string {
				var names []string
				for c := range mounters[store] {
					names = append(names, c)
				}
				sort.Strings(names)
				return names
			}
			for store := range mounters {
				if by := containers(store); len(by) > 1 {
					t.Errorf("the %s store is mounted by %d containers, want one: %s", store, len(by), strings.Join(by, ", "))
				}
			}
			for _, store := range []string{"anchored-text", "state"} {
				if by := containers(store); len(by) != 1 || by[0] != "semiont-archivist" {
					t.Errorf("the %s store is mounted into %v, want the Archivist alone", store, by)
				}
			}
		})
	}
}

// No image stamps the anchored-text store. Each entry carries the stamp of
// what derived it and is served only under the stamp the Smelter states, so an
// image change, the Smelter's or the Archivist's, clears nothing: what an
// older stamp derived stays until `clean --store anchored-text`.
func TestAnImageChangeClearsNothingFromTheAnchoredTextStore(t *testing.T) {
	s := newScenario(t, "container")
	dir := stateRootFor(s.home, testKBKey)
	entry := filepath.Join(dir, "anchored-text", "ab", "cd", "kept.json")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte(`{"v":3,"stamp":"reader-0+engine-0","declined":"encrypted"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := `{"kbRoot":"` + inJSON(s.kb) + `","stores":{"anchored-text":{"image":"ghcr.io/the-ai-alliance/semiont-smelter:0.0.0-old"}}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	if _, err := os.Stat(entry); err != nil {
		t.Errorf("an image change cleared the anchored-text store: %v", err)
	}
}

// The anchored-text store is a projection — every entry is reproducible from
// the resource's bytes — so `clean` may take it, and an image change clears
// rather than refuses.
func TestCleanTakesTheAnchoredTextStore(t *testing.T) {
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	dir := stateRootFor(s.home, testKBKey)
	// Sharded the way the KB's own event log is sharded, so the sweep must
	// reach through the fan-out, not just the top directory.
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
	// initialized with.
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

// A store's mismatch-clear resolves in preflight, before the boot's first
// service container runs, so no clear lands on a directory a container has
// already attached — which would orphan its virtiofs share (ls total 0, every
// write ENOENT).
func TestStoreClearResolvesBeforeFirstRun(t *testing.T) {
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
			t.Fatalf("state-store sentinel still %s at service run %d of %d — the mismatch-clear resolved mid-boot, after a container attached", l, i+1, len(lines))
		}
	}
}

// A clear removes a store's CONTENTS and keeps the mount-root directory
// itself. Delete-and-recreate orphans every share attached to the deleted
// directory (Apple container virtiofs); a contents-clear is invisible to
// attached shares. The test holds the directory open across the boot —
// exactly what an attached share does — and checks it was never unlinked: an
// open handle to a deleted directory has link count zero. (Inode-number
// comparison cannot pin this: an immediate recreate reuses the freed inode
// number.)
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
	// initialized with.
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

func TestStartRefusesKBWithoutDid(t *testing.T) {
	// A did:web is REQUIRED. The launcher publishes a discovery document in
	// which `did` is a required field, so a KB with no site.domain cannot be
	// represented — and the alternative to refusing is worse than it looks:
	// any default at all would have every such KB on a machine report one
	// fabricated, colliding identity. An address wearing a name is the
	// category error that keeping identity apart from address exists to
	// prevent. Identity is declared, never defaulted. ProjectConfig requires
	// the domain, so a KB with no project file is the one that has none.
	s := newScenario(t, "container")
	if err := os.Remove(filepath.Join(s.kb, ".semiont", "config.yaml")); err != nil {
		t.Fatal(err)
	}
	// Refused even in --dry-run: a plan for a KB that cannot be identified is
	// not a plan worth printing.
	_, stderr, code := s.run(t, "start", "--dry-run")
	if code != 1 {
		t.Fatalf("did-less start: want exit 1, got %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr, "did:web", "config.yaml", "site:", "domain")

	// And the fix-it must be actionable: adding the domain makes it start.
	if err := os.WriteFile(filepath.Join(s.kb, ".semiont", "config.yaml"),
		[]byte("project:\n  name: No Did KB\ngit:\n  sync: true\nsite:\n  domain: example.github.io:no-did-kb\n  siteName: No Did KB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("declared-domain start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "state key", s.norm(stdout), "roots/example.github.io-no-did-kb/postgres")
}

// A knowledge base whose project file is .semiont/config.yaml starts from it;
// one whose config.yaml does not hold to its schema is refused, each place
// named at its line, even in --dry-run.
func TestStartReadsTheYAMLProjectFile(t *testing.T) {
	s := newScenario(t, "container")
	semiont := filepath.Join(s.kb, ".semiont")
	project, err := os.ReadFile(filepath.Join(semiont, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("a start from config.yaml: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "state key", s.norm(stdout), "roots/example.github.io-test-kb/postgres")

	broken := strings.Replace(string(project), "  domain:", "  domian:", 1)
	if broken == string(project) {
		t.Fatal("the fixture's config.yaml states no domain to misspell")
	}
	if err := os.WriteFile(filepath.Join(semiont, "config.yaml"), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	_, stderr, code = s.run(t, "start", "--dry-run")
	if code != 1 {
		t.Fatalf("a start from a broken config.yaml: want exit 1, got %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr, "config.yaml", "line 7", "domian")
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
// and on Linux only a container's root can remove it.
func storeClear(sd string) string {
	return "container run --rm -v " + sd + ":/store busybox:1.38.0@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e find /store -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
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
	// State whose KB exists nowhere: targetable by its literal key, exactly
	// as status names it.
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
	dir := seedStateDir(t, s)
	// Whole megabytes, each store a different number of them: what a file of
	// that size takes on disk is the same on every filesystem this runs on,
	// and the order of the rows is the order of the sizes.
	megabyte := strings.Repeat("x", 1<<20)
	for file, megabytes := range map[string]int{
		"postgres/pgdata/base":              3,
		"qdrant/collections/segment":        2,
		"neo4j/data/databases/store":        1,
		"logs/20260101-000000Z/gateway.log": 0,
	} {
		p := filepath.Join(dir, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(strings.Repeat(megabyte, megabytes)+"a line of a container's log\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "jwt-secret"), []byte("kept\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A file that is long and takes little: a sparse one, as a vector store
	// keeps. The report is of disk use, so it adds nothing to speak of. (A
	// file made this way on Windows is given all its space.)
	if runtime.GOOS != "windows" {
		sparse, err := os.Create(filepath.Join(dir, "qdrant", "collections", "sparse"))
		if err != nil {
			t.Fatal(err)
		}
		if err := sparse.Truncate(64 << 20); err != nil {
			t.Fatal(err)
		}
		sparse.Close()
	}
	// A second, ORPHANED root: stamped kbRoot does not exist.
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
	// The knowledge base itself, and — another place — where its stores are.
	mustContain(t, "the knowledge base's rows", stdout,
		"KB root    "+s.kb,
		"did:web:example.github.io:test-kb",
		"its stores "+dir,
		"on disk, in these directories beneath it:",
		"and 1 kept secret (semiont settings secret-store lists it)")
	// Each store by its own directory, what it takes, and what it holds.
	sep := regexp.QuoteMeta(string(os.PathSeparator))
	at := map[string]int{}
	for _, row := range []struct{ store, size, holds string }{
		{"postgres", `3\.\d MB`, "database"},
		{"qdrant", `2\.\d MB`, "vectors"},
		{"neo4j", `1\.\d MB`, "graph"},
		{"logs", `\d+(\.\d)? K?B`, "container logs kept from earlier starts"},
	} {
		line := regexp.MustCompile(`(?m)^\s+` + row.store + sep + `\s+` + row.size + `\s+` + regexp.QuoteMeta(row.holds) + `$`)
		found := line.FindStringIndex(stdout)
		if found == nil {
			t.Errorf("no row for %s with a size like %s and %q; full text:\n%s", row.store, row.size, row.holds, stdout)
			continue
		}
		at[row.store] = found[0]
	}
	if len(at) == 4 && !(at["postgres"] < at["qdrant"] && at["qdrant"] < at["neo4j"] && at["neo4j"] < at["logs"]) {
		t.Errorf("the stores are not listed largest first:\n%s", stdout)
	}
	mustContain(t, "every knowledge base's row", stdout,
		"all KBs    "+filepath.Dir(dir),
		"2 knowledge bases", "1 orphaned", "semiont clean --root gone.example.org-old-kb")
}

// A knowledge base's stores are keyed by its identity, so another clone of it
// shares them. When the last start was from elsewhere, the report says where.
func TestStatusVerboseNamesWhereTheStoresWereLastStartedFrom(t *testing.T) {
	s := newScenario(t, "container")
	dir := seedStateDir(t, s)
	elsewhere := asTheSystemNamesIt(t, mkKB(t))
	meta := `{"kbRoot":"` + inJSON(elsewhere) + `","did":"did:web:example.github.io:test-kb","stores":{}}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, _, _ := s.run(t, "status", "--verbose")
	mustContain(t, "another clone", stdout, "KB root    "+s.kb, "last started from "+elsewhere)

	// From the root that started them, there is nothing to add.
	same := newScenario(t, "container")
	seedStateDir(t, same)
	stdout, _, _ = same.run(t, "status", "--verbose")
	mustNotContain(t, "the same clone", stdout, "last started from")
}

// Where a knowledge base's secrets are kept is a setting. The report names
// another store without asking it anything.
func TestStatusVerboseNamesAnotherSecretStoreWithoutAskingIt(t *testing.T) {
	s := newScenario(t, "container", "op")
	seedStateDir(t, s)
	if _, stderr, code := s.run(t, "settings", "secret-store", "op://Semiont"); code != 0 {
		t.Fatalf("secret store: exit %d\nstderr:\n%s", code, stderr)
	}
	asked := strings.Count(string(s.mustLog(t)), "\nop ")
	stdout, _, _ := s.run(t, "status", "--verbose")
	mustContain(t, "another store", stdout, "its secrets are kept in", "Semiont")
	mustNotContain(t, "another store", stdout, "kept secret (", "kept secrets (")
	if after := strings.Count(string(s.mustLog(t)), "\nop "); after != asked {
		t.Errorf("status ran 1Password %d more times; the report is not to ask a store anything", after-asked)
	}
}

func TestStatusVerboseNoState(t *testing.T) {
	s := newScenario(t, "container")
	stdout, _, _ := s.run(t, "status", "--verbose")
	// Nothing kept anywhere: the rows say so — absent, not a zero-byte
	// fiction.
	mustContain(t, "nothing kept", stdout,
		"KB root    "+s.kb, "its stores "+stateRootFor(s.home, testKBKey), "nothing kept yet",
		"nothing is kept for any knowledge base")
	if strings.Contains(stdout, "0 B") {
		t.Errorf("absent stores must read as absent, not zero bytes:\n%s", stdout)
	}
}

// --- login (sdk-go glue) ---

// tokensPathFor mirrors the launcher's token store path for the scenario's
// fake HOME — GOOS-aware like statePathFor.
func tokensPathFor(home string) string {
	return filepath.Join(stateHomeFor(home), "tokens.json")
}

// tokenTagged is a token fakert's gateway knows by its tag, as it knows the
// person tokens its issuer issues (fake-jwt-token at login, fake-jwt-token-2
// renewed).
func tokenTagged(tag string) string {
	claims, _ := json.Marshal(map[string]any{"tag": tag})
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".fake"
}

// tagOf is the tag of a person token fakert's issuer issued; "" for any other.
func tagOf(token string) string {
	parts := strings.Split(strings.TrimPrefix(token, "Bearer "), ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Tag string `json:"tag"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.Tag
}

// storedSignIn is the sign-in tokens.json holds under home for key.
func storedSignIn(t *testing.T, home, key string) (semiont.SignIn, bool) {
	t.Helper()
	signIn, ok, err := semiont.NewSignInStore(tokensPathFor(home)).SignIn(key)
	if err != nil {
		t.Fatalf("tokens.json: %v", err)
	}
	return signIn, ok
}

// uploadBearerTag is the tag of the bearer the upload fakert captured bore.
func uploadBearerTag(t *testing.T, fakertDir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fakertDir, "yield-upload.json"))
	if err != nil {
		t.Fatalf("upload capture: %v", err)
	}
	var captured struct {
		Authorization string `json:"authorization"`
	}
	if err := json.Unmarshal(b, &captured); err != nil {
		t.Fatalf("upload capture: %v\n%s", err, b)
	}
	return tagOf(captured.Authorization)
}

// `semiont login` is the device authorization grant (RFC 8628). The launcher
// learns the issuer from the knowledge base's resource metadata, asks it for
// a code as the launcher's own public client, and stores the tokens the
// issuer returns — no --email, no stdin, no password anywhere in this
// process.
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
	signIn, ok := storedSignIn(t, s.home, "local")
	if !ok || tagOf(signIn.Token) != "fake-jwt-token" || signIn.RefreshToken != "fake-refresh-token" ||
		signIn.Issuer != "http://localhost:4000/realms/semiont" || signIn.TokenEndpoint == "" || signIn.Email != "admin@example.com" {
		t.Errorf("tokens.json after login does not hold the issued session: %+v (%v)", signIn, ok)
	}
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
	// pair to the local stack.
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
// so per-run env set after start never reaches it.
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
		`"filecontent":"# hi\n"`)
	if tag := uploadBearerTag(t, s.fakertDir); tag != "fake-jwt-token" {
		t.Errorf("the upload bore the token tagged %q, want the login's", tag)
	}
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
	if tag := uploadBearerTag(t, s.fakertDir); tag != "fake-jwt-token-2" {
		t.Errorf("the upload bore the token tagged %q, want the renewed one", tag)
	}
	// …and the rotation was SAVED: next command starts from the new token,
	// keeping the original refresh token (the server does not rotate it).
	if signIn, _ := storedSignIn(t, s.home, "local"); tagOf(signIn.Token) != "fake-jwt-token-2" || signIn.RefreshToken != "fake-refresh-token" {
		t.Errorf("tokens.json was not rotated to the renewed token: %+v", signIn)
	}
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
	if _, still := storedSignIn(t, s.home, "local"); still {
		t.Error("the session survived logout")
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
		"Sweeping 12 container(s) across container, docker, podman",
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
	// database role has one driver, and guessing it is exactly what keying
	// the descriptor set by (role, driver) rules out. A recorded stack
	// names its products — every record carries its driver.
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
		"LAUNCHER PATHS",
		"state      "+stateHomeFor(s.home)+" (stack record, registry, sign-ins, discovery)",
		"log        "+invLogPath(s.home),
		"staging    "+s.stagingPattern(),
		"models     "+filepath.Join(s.home, ".ollama"))
	// The data home has a row of its own where the system keeps it apart.
	dataRow := "data       " + dataHomeFor(s.home) + " (each knowledge base's stores and kept secrets)"
	if apart := dataHomeFor(s.home) != stateHomeFor(s.home); apart != strings.Contains(vstdout, dataRow) {
		t.Errorf("the data home's row is there exactly when it is not the state home (apart: %v):\n%s", apart, vstdout)
	}
	// Only directories something is kept in: the launcher keeps no config
	// and no cache.
	if row := regexp.MustCompile(`(?m)^  (config|cache)\s`).FindString(vstdout); row != "" {
		t.Errorf("LAUNCHER PATHS has a %q row, a directory the launcher keeps nothing in:\n%s", strings.TrimSpace(row), vstdout)
	}

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
	// --password is refused, but a user who types it has put the secret in
	// the launcher's OWN argv — and the invocation log is a file that
	// outlives the command, so the value must never be written there.
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
	// useradd's PASSWORD never rides in argv — it is read from stdin, because
	// argv is visible in `ps` and in the caller's shell history.
	s := newScenario(t, "container", "docker")
	const secret = "password123"

	// The LOCAL path administers the realm from here — no container, and the
	// gateway need not be running. With no stack recorded there is no realm
	// to reach, and the refusal says so.
	s.stdin = secret + "\n"
	_, stderr, code := s.run(t, "useradd", "--email", "a@b.co")
	if code != 1 {
		t.Fatalf("no-stack useradd: want exit 1, got %d", code)
	}
	mustContain(t, "stderr", stderr, "semiont start")
	if strings.Contains(stderr, "gateway") {
		t.Errorf("the refusal blames the gateway, which this path does not use:\n%s", stderr)
	}

	// Whatever it does, it never runs a container for a local stack.
	log, _ := os.ReadFile(s.log)
	if strings.Contains(string(log), "semiont-useradd") {
		t.Errorf("the local path reaches for the gateway's bin:\n%s", log)
	}
	// And the password never appears anywhere it could be read back.
	if strings.Contains(string(log), secret) || strings.Contains(stderr, secret) {
		t.Error("the password leaked into the argv log or stderr")
	}

	// Flag refusals the launcher owns. They fire before any realm is reached,
	// so they need no stack at all.
	//
	// --password is refused with the way to supply one instead — it is
	// documented in enough places that a bare "unknown flag" would read as a
	// launcher bug.
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
	// An unknown flag is refused rather than ignored: this IS the far end for
	// a local stack, and `--admin` must fail, not appear to work.
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
		t.Error("help advertises --password, which is refused")
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
	// `semiont settings secret` stores POINTERS (provider + path) in
	// roots.json — never a value. set verifies with one read (discarded);
	// list shows pointers; rm forgets.
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

// `secret` lives under `settings`: there is no top-level verb, and no alias.
func TestSecretIsNotATopLevelCommand(t *testing.T) {
	s := newScenario(t, "container", "op")
	_, stderr, code := s.run(t, "secret", "set", "ANTHROPIC_API_KEY", "op://OSS/Anthropic/credential")
	if code == 0 {
		t.Fatal("`semiont secret` runs as a top-level verb")
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
// environment and still arrives. Custody values, a user's forwarded value and
// the daemons' credentials alike.
func TestSecretValuesStayOffTheCommandLine(t *testing.T) {
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key")
	if _, stderr, code := s.run(t, "start", "--config", "anthropic"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	secrets := []string{"ANTHROPIC_API_KEY", "JWT_SECRET", "SEMIONT_OIDC_CLIENT_SECRET", "SEMIONT_OIDC_CLIENT_KEY", "KC_BOOTSTRAP_ADMIN_PASSWORD", "POSTGRES_PASSWORD", "KC_DB_PASSWORD"}
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
		{"semiont-weaver", "SEMIONT_OIDC_CLIENT_SECRET", ""},
		// The PEM's first line: the record keeps a line per variable.
		{"semiont-worker", "SEMIONT_OIDC_CLIENT_KEY", "-----BEGIN PRIVATE KEY-----"},
		{"semiont-keycloak", "KC_BOOTSTRAP_ADMIN_PASSWORD", ""},
		{"semiont-keycloak", "KC_DB_PASSWORD", ""},
		{"semiont-postgres", "POSTGRES_PASSWORD", ""},
	} {
		got, _ := s.containerEnv(t, c.container, c.name)
		if got == "" || (c.want != "" && got != c.want) {
			t.Errorf("%s did not receive %s through the runtime's environment (got %q)", c.container, c.name, got)
		}
	}
	if _, handed := s.containerEnv(t, "semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET"); handed {
		t.Error("the worker was handed a secret; it proves itself with the machine's key")
	}
}

// Each service is handed only the variables its configuration document names.
// The anthropic config names ANTHROPIC_API_KEY in [inference], which the
// Librarian's document names as its engines' key and the worker's as its
// engines', and nothing else does: the Archivist lists the engines without
// it. The worker and the librarian are the only two images that get
// inference secrets.
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
			t.Errorf("%s calls the models but was not handed ANTHROPIC_API_KEY", svc)
		}
	}
	for _, svc := range []string{"archivist", "gateway", "dispatcher", "weaver", "smelter"} {
		if _, handed := s.containerEnv(t, "semiont-"+svc, "ANTHROPIC_API_KEY"); handed || strings.Contains(runLine(svc), "ANTHROPIC_API_KEY") {
			t.Errorf("the document of %s names no ANTHROPIC_API_KEY but it was handed it", svc)
		}
	}
}

// Start demands a variable only when something reads it: a service handed it,
// or the launcher itself. A key of a provider no role names reaches no one and
// is not demanded.
func TestStartDemandsOnlyTheVariablesSomethingReads(t *testing.T) {
	s := newScenario(t, "container")
	editDocument(t, s, "inference/ollama-gemma.yaml",
		"    ollama: {}\n", "    ollama: {}\n    openai: { baseURL: https://api.openai.com/v1, apiKey: { fromEnv: INERT } }\n")
	if _, stderr, code := s.run(t, "start", "--config", "ollama-gemma"); code != 0 {
		t.Fatalf("start demanded a variable nothing reads: exit %d\n%s", code, stderr)
	}
}

// externalDatabase: the fixture's Issuer document with its PostgreSQL run by
// somebody else, its password read from EXT_PG.
func externalDatabase(t *testing.T, s *scenario) {
	t.Helper()
	editDocument(t, s, "issuer.yaml",
		"    image: postgres:15.18-alpine@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f\n    resources: { limits: { memory: 1G } }\n",
		"    external: { host: db.example.com, port: 5432, password: { fromEnv: EXT_PG } }\n")
}

// A role started alone resolves what the launcher reads on its behalf:
// Keycloak's external PostgreSQL password, and the key the model check sends.
func TestStartServiceResolvesWhatTheLauncherReadsForIt(t *testing.T) {
	s := newScenario(t, "container")
	externalDatabase(t, s)
	s.extraEnv = append(s.extraEnv, "EXT_PG=pgsecret", "ANTHROPIC_API_KEY=test-key")
	for _, c := range []struct{ service, config string }{{"identity", "ollama-gemma"}, {"inference", "anthropic"}} {
		if stdout, stderr, code := s.run(t, "start", "--service", c.service, "--config", c.config); code != 0 {
			t.Errorf("start --service %s: exit %d\n%s%s", c.service, code, stdout, stderr)
		}
	}
}

// The remote-model check uses the key the Inference document's provider
// names, whatever the variable is called.
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
	deriveDocument(t, s, "inference/anthropic.yaml", "inference/own-key.yaml",
		"name: anthropic", "name: own-key",
		"baseURL: https://api.anthropic.com", "baseURL: http://"+ln.Addr().String(),
		"fromEnv: ANTHROPIC_API_KEY", "fromEnv: MY_KEY")
	s.extraEnv = append(s.extraEnv, "MY_KEY=sk-mine")
	if _, stderr, code := s.run(t, "start", "--config", "own-key"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	select {
	case got := <-keys:
		if got != "sk-mine" {
			t.Errorf("the model check sent x-api-key %q, want the value of MY_KEY", got)
		}
	default:
		t.Error("the model check never ran: it looked for ANTHROPIC_API_KEY, not the variable the document names")
	}
}

// A service started alone reaches only for the variables of the sections it
// is started from: the Smelter's document reads no [inference], so restarting
// it raises no provider prompt for ANTHROPIC_API_KEY.
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

// --- codespace placement ---

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
	// The whole manual `gh` recipe as one command, from a KB clone:
	// preflights, create, detached forward, health through it, credentials
	// displayed.
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
		// Cost levers ride every create, explicitly: 60m idle, 30-day
		// retention — GitHub's max, stated so a tighter account default
		// cannot silently shorten the KB's life.
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
	// No credentials exist to leak — the launcher neither reads nor prints
	// them. Assert the record is free of any password-shaped field so a future
	// feature cannot quietly introduce one.
	if strings.Contains(strings.ToLower(string(b)), "password") {
		t.Fatalf("a password-shaped field reached stack.json:\n%s", b)
	}
	// Placement is never sticky: no machine-wide runtime preference written.
	if rb, err := os.ReadFile(rootsPathFor(s.home)); err == nil && strings.Contains(string(rb), `"runtime": "codespace"`) {
		t.Errorf("codespace recorded as sticky runtime:\n%s", rb)
	}
}

func TestCodespaceWaitsForRemoteBeforeForwarding(t *testing.T) {
	// `gh codespace ports forward` binds locally at once but EXITS the first
	// time a local connection cannot be opened through to the remote port
	// ("ssh: rejected: connect failed"). Devcontainer hooks take minutes, so
	// on a FRESH create a bind check that DIALS the port — forwardAlive() —
	// would kill the tunnel it is checking, and the death would surface a
	// step later as "the port forward died after 1s — the stack may be fine."
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
	// On a FRESH create sshd is installed during the devcontainer build, so
	// ssh is unreachable exactly during the window the readiness gate exists
	// for. Treating the first "cannot ask" as permanent would skip the wait
	// and build the tunnel into a stack that is still coming up.
	//
	// When ssh cannot answer, the launcher probes by FORWARDING instead: a
	// tunnel that dies "connection refused" is the not-ready answer, so it
	// waits and retries. Same conclusion, no timer — and a codespace that
	// never grows an sshd is never stalled.
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
	// When the devcontainer hooks fail, the creation log says so in plain
	// text — "postStartCommand from devcontainer.json failed with exit code
	// 1" — so the launcher reads the log it renders rather than waiting out
	// its whole readiness budget. A stack whose setup failed will never come
	// up; waiting is time spent on a foregone conclusion, and the eventual
	// timeout blames the KB for a setup error.
	//
	// Failing FAST is only half of it: the marker is the announcement, not the
	// reason. The cause sits lines above it (a gateway refusing to boot), so
	// the report must carry the run-up or it is merely quick and useless.
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
	// A mid-wait forward death: the tunnel binds, then its process dies
	// while the health gate polls. Burning the full budget would blame an
	// innocent KB; a dead forward must fail FAST, name the forward, and
	// point at the rerun.
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
	// A GitHub-side incident: 503s are retried with backoff, then the
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
	// The manual recipe's silent/late failures become first-second failures
	// — each with the fix spelled out.
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
	s := newCodespaceScenario(t)
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_SSH_FAIL=1")
	stdout, stderr, code := s.run(t, "start", "--runtime", "codespace")
	if code != 0 {
		t.Fatalf("a failed ssh must not fail the start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stdout", stdout,
		"Semiont KB is up in codespace", // stack still reported up
		"First user:")                   // and the next step still told
}

func TestUseraddCodespace(t *testing.T) {
	// useradd reaches a codespace stack over ssh, running the codespace's own
	// launcher, and quotes every argument: the remote side is a SHELL, unlike
	// the local path.
	s := newCodespaceScenario(t)
	writeCodespaceState(t, s)

	// The password crosses on STDIN, so it is never shell-quoted at all. A
	// password of pure shell metacharacters must arrive intact, and must
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
		t.Errorf("the remote command carries the admin credential:\n%s", remote)
	}
	if strings.Contains(remote, "docker") || strings.Contains(remote, "semiont-gateway") {
		t.Errorf("the codespace path reaches into a container:\n%s", remote)
	}
	// Arguments cross a SHELL, so they must be quoted. The free-text value in
	// argv is the email — validated for shape, not for shell metacharacters —
	// so a `$` in one must survive as a literal rather than expand.
	mustContain(t, "remote command", remote, "'alice$NAME@example.com'")
	// The echoed command is IDENTICAL to the one run — with no secret in argv
	// there is nothing to redact.
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

// A codespace can exist with no record on this machine — start adopts one it
// finds, but writes the record only once the stack answers, so a failed setup
// leaves a billing codespace nothing else could see. Every --repo verb
// resolves it the way start does: the record, else what GitHub says the repo
// has.
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

// `export --repo` streams the codespace's KB over ssh into an archive here:
// named for the repository unless -o names it, without .git unless asked,
// never over an archive already there without --force, and none at all when
// the stream fails.
func TestExportRepoStreamsTheCodespacesKB(t *testing.T) {
	s := newCodespaceScenario(t)
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, `FAKERT_GH_CS_LIST=[{"name":"orphan-cs","state":"Available","repository":"`+csRepo+`"}]`)
	archive := filepath.Join(s.cwd, strings.ReplaceAll(csRepo, "/", "-")+".tar.gz")

	if stdout, stderr, code := s.run(t, "export", "--repo", csRepo); code != 0 {
		t.Fatalf("export: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	entries := tarGzEntries(t, archive)
	mustContain(t, "archive", entries, ".semiont/config.yaml", ".semiont/events/__system__/events-000001.jsonl")
	if strings.Contains(entries, ".git/") {
		t.Errorf("the archive carries .git without --with-git:\n%s", entries)
	}

	_, stderr, code := s.run(t, "export", "--repo", csRepo)
	if code != 1 {
		t.Fatalf("a second export over the first: exit %d, want 1\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr, "already exists", "--force")

	if stdout, stderr, code := s.run(t, "export", "--repo", csRepo, "--with-git", "--force"); code != 0 {
		t.Fatalf("export --with-git --force: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "archive --with-git", tarGzEntries(t, archive), ".git/HEAD", ".semiont/config.yaml")

	failed := filepath.Join(s.cwd, "failed.tar.gz")
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_SSH_FAIL=1")
	_, stderr, code = s.run(t, "export", "--repo", csRepo, "-o", failed)
	if code != 1 {
		t.Fatalf("export over a failing ssh: exit %d, want 1\n%s", code, stderr)
	}
	mustContain(t, "stderr", stderr, "export over ssh failed")
	if _, err := os.Stat(failed); !os.IsNotExist(err) {
		t.Errorf("%s after a failed stream: %v, want it absent", failed, err)
	}
}

// tarGzEntries: the names in the .tar.gz at path, one per line.
func tarGzEntries(t *testing.T, path string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	tr := tar.NewReader(gz)
	var names []string
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		names = append(names, h.Name)
	}
	return strings.Join(names, "\n")
}

// useradd administers the stack it selected. With a local stack running for
// one knowledge base, running it from inside another must reach the running
// stack's realm: that root's config, issuer port and admin password — not
// start over from the current directory and refuse about a knowledge base
// that has no stack at all.
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
	// The catalog form must also refuse to call it deleted (the roots verb
	// lists the remote rows).
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
	// The placement IS the platform: no runtime key, and the four codespace
	// facts travel together inside it.
	body := `{"schema":3,"stacks":{"codespace:` + csRepo + `":{` +
		`"codespace":{"name":"fake-cs-1","repo":"` + csRepo + `","forwardPort":4001},"ports":[4001],"services":{}}}}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestKBPortAllocationDodgesLiveHolders(t *testing.T) {
	// Two scenarios alive at once (separate HOMEs, so neither sees the
	// other's records) must not collide on the KB port: allocation consults
	// lsof, and the fake answers for REAL listeners — without that fidelity
	// allocation hands out an unbindable 4000.
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
	s := newCodespaceScenario(t) // cwd is a KB clone with a .semiont/config.yaml
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("create: exit %d\nstderr:\n%s", code, stderr)
	}
	b, _ := os.ReadFile(statePathFor(s.home))
	mustContain(t, "stack.json", string(b), `"kbDid": "did:web:example.github.io:test-kb"`)
	stdout, _, _ := s.run(t, "roots")
	mustContain(t, "roots", stdout, "did:web:example.github.io:test-kb")

	// A --repo-only create has no clone to read — so it learns the identity
	// from the codespace itself, over ssh. What must never happen is a did
	// matched by name.
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
	s.extraEnv = append(s.extraEnv, "FAKERT_GH_KBCONFIG="+remoteProjectFile("example.github.io:test-kb"))
	stdout, stderr, code := s.run(t, "status", "--repo", repo, "--refresh")
	if code != 0 {
		t.Fatalf("refresh: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "refresh", stdout+stderr, "KB identity confirmed", "did:web:example.github.io:test-kb")

	// Drift: the codespace now answers with a different identity.
	s.extraEnv[len(s.extraEnv)-1] = "FAKERT_GH_KBCONFIG=" + remoteProjectFile("elsewhere.org:other-kb")
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
// local stack. A second recorded stack turns a bare `semiont stop --delete`
// into a refusal, so status names the stack, and the refusal's menu keeps the
// --delete it was given: without it, following the menu would run
// `gh codespace stop` against a codespace GitHub has deleted.
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
// not auto-create (a paid VM is a cost event, never a bug-fix side effect).
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

// A codespace KB's issuer is http://keycloak.localhost:<N> — loopback on this
// machine — so the laptop forwards <N>:<N>, the same number on both ends, one
// <N> per KB so one Browser can sign in to several.
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
		// summary may print URLs.
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
// finished — not when its gateway first answers. When ssh cannot answer yet,
// readiness is proven by the forward (the gateway), and a move made then would
// have its rerun collide with post-start's start still bringing up the rest.
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
// A wake decided once, for exactly "Shutdown", would leave a resume that saw
// "ShuttingDown" waiting ten minutes on a codespace nothing would ever wake.
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
	// The codespace record is forgotten. The bare stop took the Browser
	// codespace start ensured, so its record is gone too.
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

	// The respawned forward makes it ACTIVE — bare status says so, with the
	// local port that answers.
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
	// Cross-placement: a LOCAL stack does not block a codespace start. They
	// coexist, and the codespace KB simply allocates around the local stack's
	// ports.
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
	// A codespace stack does not block a local start — they coexist (the
	// dry-run proves the local plan renders; only the lens would contend,
	// and it's dropped live).
	stdout, stderr, code = s2.run(t, "start", "--runtime", "container", "--dry-run")
	if code != 0 {
		t.Fatalf("codespace record + local dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "local plan stdout", stdout, "container run -d --name semiont-gateway")

	// useradd works against a codespace stack.
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
		"cat /workspaces/*/.semiont/config.yaml")
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

// machineDocumentFor: where the scenario's state home keeps the machine's
// document named file: browser.yaml, the Browser's, or workers.yaml, the
// worker's.
func machineDocumentFor(home, file string) string {
	return filepath.Join(stateHomeFor(home), "stack", file)
}

// editMachineDocument: the scenario's machine document named file, which
// `settings <setting> --path` names and writes where there is none, with each
// old text of edits (old, new, old, new, …) replaced by its new one; an old
// text the document does not hold fails the test.
func editMachineDocument(t *testing.T, s *scenario, setting, file string, edits ...string) {
	t.Helper()
	stdout, stderr, code := s.run(t, "settings", setting, "--path")
	if code != 0 {
		t.Fatalf("settings %s --path: exit %d\n%s", setting, code, stderr)
	}
	path := machineDocumentFor(s.home, file)
	if stdout != path+"\n" {
		t.Fatalf("settings %s --path printed %q, want the path alone, %q", setting, stdout, path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for i := 0; i+1 < len(edits); i += 2 {
		if !strings.Contains(text, edits[i]) {
			t.Fatalf("%s holds no %q to edit:\n%s", path, edits[i], text)
		}
		text = strings.Replace(text, edits[i], edits[i+1], 1)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// recordedBrowser: the Browser's record in stack.json.
func recordedBrowser(t *testing.T, s *scenario) (image, endpoint, memory string) {
	t.Helper()
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		Machine map[string]struct {
			Image    string `json:"image"`
			Endpoint string `json:"endpoint"`
			Memory   string `json:"memory"`
		} `json:"machine"`
	}
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatalf("stack.json: %v", err)
	}
	browser := rec.Machine["semiont-browser"]
	return browser.Image, browser.Endpoint, browser.Memory
}

// A start that runs a worker and finds no worker document writes the
// launcher's, says where, and runs what it says; a dry run before it writes
// nothing, and says what a start would write. The document is the machine's:
// an edit runs at the next start, its image, its memory and its log level,
// and no knowledge base's document says otherwise.
func TestTheWorkerRunsWhatTheMachinesDocumentSays(t *testing.T) {
	s := newScenario(t, "container")
	path := machineDocumentFor(s.home, "workers.yaml")

	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("dry run: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "the dry run", stdout, "# write "+path+": the worker's document, from the launcher's catalog")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("a dry run wrote %s (%v)", path, err)
	}

	stdout, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "the start's output", stdout+stderr, "wrote its document, "+path)
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no worker document was written: %v", err)
	}
	mustContain(t, path, string(text),
		"kind: WorkerPool",
		"logLevel: info",
		"image: ghcr.io/the-ai-alliance/semiont-worker:latest",
		"memory: 2G")
	mustContain(t, "argv log", s.argv(t), "run -d --name semiont-worker --memory 2G")

	editMachineDocument(t, s, "worker", "workers.yaml",
		"semiont-worker:latest", "semiont-worker:local",
		"memory: 2G", "memory: 3G",
		"logLevel: info", "logLevel: debug")
	stdout, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("start after the edit: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "argv log", s.argv(t), "run -d --name semiont-worker --memory 3G")
	mustContain(t, "argv log", s.argv(t), "ghcr.io/the-ai-alliance/semiont-worker:local")
	mustNotContain(t, "argv log", s.argv(t), "pull ghcr.io/the-ai-alliance/semiont-worker:local")
	var doc api.WorkerConfig
	if err := json.Unmarshal([]byte(stagedFile(t, s, "worker.json")), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.LogLevel != api.LogLevelDebug {
		t.Errorf("the worker logs at %q, want the document's debug", doc.LogLevel)
	}
}

// A worker document that does not hold is refused, with its file and the
// line of what it refuses, before anything is stopped or started: by a start,
// by a start of the worker alone, and by a dry run.
func TestAWorkerDocumentThatDoesNotHoldStopsNothing(t *testing.T) {
	s := newScenario(t, "container")
	editMachineDocument(t, s, "worker", "workers.yaml", "memory: 2G", "memory: 2GB")
	path := machineDocumentFor(s.home, "workers.yaml")
	for _, args := range [][]string{{"start"}, {"start", "--service", "worker"}, {"start", "--dry-run"}} {
		before := s.argv(t)
		stdout, stderr, code := s.run(t, args...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1\nstdout:\n%s\nstderr:\n%s", args, code, stdout, stderr)
		}
		mustContain(t, fmt.Sprintf("%v's refusal", args), stderr, path+" is not a WorkerPool", "line 11, /spec/worker/resources/limits/memory")
		// Finding the knowledge base's root (git rev-parse) comes first, and
		// changes nothing; no runtime command may run.
		for _, line := range strings.Split(strings.TrimSpace(strings.TrimPrefix(s.argv(t), before)), "\n") {
			if line != "" && !strings.HasPrefix(line, "git ") {
				t.Errorf("%v ran %q before refusing the worker's document", args, line)
			}
		}
	}
}

// A start that finds no Browser document writes the launcher's, says where,
// and runs what it says. A dry run before it writes nothing, and says what a
// start would write.
func TestAStartWithNoBrowserDocumentWritesOne(t *testing.T) {
	s := newScenario(t, "container")
	s.noGitRoot = true // the Browser alone needs no clone
	path := machineDocumentFor(s.home, "browser.yaml")

	stdout, stderr, code := s.run(t, "start", "--service", "browser", "--dry-run")
	if code != 0 {
		t.Fatalf("dry run: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "the dry run", stdout, "# write "+path)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("a dry run wrote %s (%v)", path, err)
	}

	stdout, stderr, code = s.run(t, "start", "--service", "browser")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "the start's output", stdout+stderr, "wrote its document, "+path)
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no Browser document was written: %v", err)
	}
	mustContain(t, path, string(text),
		"kind: Browser",
		"image: ghcr.io/the-ai-alliance/semiont-browser:latest",
		"memory: 1G",
		"port: 3000")
	mustContain(t, "argv log", s.argv(t), "run -d --name semiont-browser --memory 1G --publish 127.0.0.1:3000:3000")
	if _, endpoint, memory := recordedBrowser(t, s); endpoint != "http://localhost:3000" || memory != "1G" {
		t.Errorf("the Browser was recorded at %q with %q, want http://localhost:3000 with 1G", endpoint, memory)
	}
}

// The Browser runs the image, the memory and the port its document names.
// Its record keeps what it ran with, so status follows it, and a later start
// keeps a Browser its record and its document agree on and restarts one they
// do not.
func TestTheBrowserRunsWhatItsDocumentSays(t *testing.T) {
	s := newScenario(t, "container")
	editMachineDocument(t, s, "browser", "browser.yaml",
		"semiont-browser:latest", "semiont-browser:local",
		"memory: 1G", "memory: 2G",
		"port: 3000", "port: 3001")
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "argv log", s.argv(t),
		"run -d --name semiont-browser --memory 2G --publish 127.0.0.1:3001:3000",
		"ghcr.io/the-ai-alliance/semiont-browser:local")
	mustContain(t, "the start's summary", stdout, "Semiont Browser    http://localhost:3001")
	if image, endpoint, memory := recordedBrowser(t, s); image != "ghcr.io/the-ai-alliance/semiont-browser:local" || endpoint != "http://localhost:3001" || memory != "2G" {
		t.Errorf("the Browser was recorded as %q at %q with %q, want the document's :local at http://localhost:3001 with 2G", image, endpoint, memory)
	}
	stdout, _, _ = s.run(t, "status", "--service", "browser")
	mustContain(t, "status", stdout, "http://localhost:3001")

	// A later start keeps the Browser it finds running as its document says.
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_browser=running",
		"FAKERT_IMAGE_browser=ghcr.io/the-ai-alliance/semiont-browser:local")
	before := s.mustLog(t)
	stdout, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("second start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "the second start's output", stdout+stderr, "Browser already running on http://localhost:3001")
	if fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before)); strings.Contains(fresh, "run -d --name semiont-browser") {
		t.Errorf("a Browser running as its document says was restarted:\n%s", fresh)
	}

	// A port the document moves restarts it there; so does a memory it changes.
	for _, edit := range []struct{ from, to, publishes string }{
		{"port: 3001", "port: 3002", "--memory 2G --publish 127.0.0.1:3002:3000"},
		{"memory: 2G", "memory: 3G", "--memory 3G --publish 127.0.0.1:3002:3000"},
	} {
		editMachineDocument(t, s, "browser", "browser.yaml", edit.from, edit.to)
		before = s.mustLog(t)
		stdout, stderr, code = s.run(t, "start")
		if code != 0 {
			t.Fatalf("start after %s: exit %d\nstdout:\n%s\nstderr:\n%s", edit.to, code, stdout, stderr)
		}
		fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
		mustContain(t, "argv after "+edit.to, fresh, "run -d --name semiont-browser "+edit.publishes)
	}
	if _, endpoint, memory := recordedBrowser(t, s); endpoint != "http://localhost:3002" || memory != "3G" {
		t.Errorf("after the edits the Browser was recorded at %q with %q, want http://localhost:3002 with 3G", endpoint, memory)
	}
}

// A Browser document that does not hold is refused, with its file and the
// line of what it refuses, before anything is stopped or started: by a start,
// by a start of the Browser alone, and by a dry run.
func TestABrowserDocumentThatDoesNotHoldStopsNothing(t *testing.T) {
	s := newScenario(t, "container")
	editMachineDocument(t, s, "browser", "browser.yaml", "port: 3000", "port: 70000")
	path := machineDocumentFor(s.home, "browser.yaml")
	for _, args := range [][]string{{"start"}, {"start", "--service", "browser"}, {"start", "--dry-run"}} {
		before := s.argv(t)
		stdout, stderr, code := s.run(t, args...)
		if code != 1 {
			t.Errorf("%v: exit %d, want 1\nstdout:\n%s\nstderr:\n%s", args, code, stdout, stderr)
		}
		mustContain(t, fmt.Sprintf("%v's refusal", args), stderr, path+" is not a Browser", "line 10, /spec/port")
		if ran := strings.TrimPrefix(s.argv(t), before); ran != "" {
			t.Errorf("%v ran commands before refusing the Browser's document:\n%s", args, ran)
		}
	}
}

// `semiont settings browser` shows the Browser's document: where it is, and
// what it says. It is changed by editing it; the setting that named the
// Browser's image, and start's --port, are gone.
func TestSettingsShowsTheBrowserDocument(t *testing.T) {
	s := newScenario(t, "container")
	path := machineDocumentFor(s.home, "browser.yaml")
	stdout, stderr, code := s.run(t, "settings", "browser")
	if code != 0 {
		t.Fatalf("settings browser: exit %d\n%s", code, stderr)
	}
	mustContain(t, "settings browser", stdout, path, "ghcr.io/the-ai-alliance/semiont-browser:latest", "1G", "http://localhost:3000")
	if _, err := os.Stat(path); err != nil {
		t.Errorf("showing the Browser's document did not write it: %v", err)
	}

	if _, stderr, code := s.run(t, "settings", "browser", "ghcr.io/the-ai-alliance/semiont-browser:local"); code != 1 {
		t.Errorf("settings browser <value>: exit %d, want 1", code)
	} else {
		mustContain(t, "settings browser <value>", stderr, "edit", path)
	}
	if _, stderr, code := s.run(t, "settings", "browser-image", "ghcr.io/the-ai-alliance/semiont-browser:local"); code != 1 {
		t.Errorf("settings browser-image: exit %d, want 1", code)
	} else {
		mustContain(t, "settings browser-image", stderr, `Unknown setting "browser-image"`)
	}
	if _, stderr, code := s.run(t, "start", "--service", "browser", "--port", "3001"); code != 1 {
		t.Errorf("start --port: exit %d, want 1", code)
	} else {
		mustContain(t, "start --port", stderr, "Unknown argument: --port")
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
	// Read tolerantly: the local path runs no container, so this scenario may
	// have written no argv log at all — which is itself the point.
	before, _ := os.ReadFile(s.log)
	s.run(t, "useradd", "--runtime", "container", "--email", "a@b.co", "--generate-password")
	after, _ := os.ReadFile(s.log)
	fresh := strings.TrimPrefix(string(after), string(before))
	if strings.Contains(fresh, "gh codespace") {
		t.Errorf("useradd --runtime container reached the codespace:\n%s", fresh)
	}
	if strings.Contains(fresh, "semiont-useradd") {
		t.Errorf("the local path execs the gateway's bin:\n%s", fresh)
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

// --- document-driven boots ---

// externalGraph: the fixture's KnowledgeIndex with its Neo4j run by somebody
// else, at uri, its password read from EXT_GRAPH.
func externalGraph(t *testing.T, s *scenario, uri string) {
	t.Helper()
	editDocument(t, s, "index.yaml",
		"    image: neo4j:5.26.28-community@sha256:ff32db30b2baff97971e441b46bfd9c832c1b62c970398ef579244c06b21d357\n    resources: { limits: { memory: 2G } }\n",
		"    external: { uri: \""+uri+"\", password: { fromEnv: EXT_GRAPH } }\n")
}

func TestStartExternalGraphBoot(t *testing.T) {
	// A graph somebody else runs (`external`), at the address its document
	// states: verify reachability, launch no container, claim no graph
	// ports.
	s := newScenario(t, "container")
	externalGraph(t, s, "bolt://127.0.0.1:7777")
	s.extraEnv = append(s.extraEnv, "EXT_GRAPH=remotepass")
	serveHealth(t, 7777)
	stdout, stderr, code := s.run(t, "start")
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

// --- a stack without a worker ---

// noJobEngines: an Inference document, no-worker, that gives each actor an
// engine and no job one.
const noJobEngines = `apiVersion: semiont.the-ai-alliance.github.io/v1alpha1
kind: Inference
metadata:
  name: no-worker
spec:
  providers:
    ollama: {}
  engines:
    actors:
      gatherer: { provider: ollama, model: "gemma4:26b" }
      matcher: { provider: ollama, model: "gemma4:26b" }
    jobs: {}
`

// noJobEnginesAt: where a start names giving a job an engine, for that
// document.
var noJobEnginesAt = filepath.FromSlash(".semiont/stack/inference/no-worker.yaml") + " spec.engines.jobs"

// A worker asked for by name, when no job has an engine, is refused before
// anything is pulled or run, naming where a job is given one: the plan names
// no image for a worker it does not run.
func TestStartServiceWorkerRefusesWhenNoJobHasAnEngine(t *testing.T) {
	s := newScenario(t, "container")
	writeDocument(t, s, "inference/no-worker.yaml", noJobEngines)
	stdout, stderr, code := s.run(t, "start", "--service", "worker", "--config", "no-worker")
	if code != 1 {
		t.Fatalf("exit %d, want 1\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "output", stdout+stderr, "no job has an engine", noJobEnginesAt)
	mustNotContain(t, "argv", s.argv(t), "pull", "semiont-worker")
}

// An Inference document that gives no job an engine starts everything else
// and no worker: none is pulled, staged a document, given a port or run, and
// the start says so once, naming where a job is given one. What reads the stack
// afterwards reads it as it is: status reports the worker as not configured
// and the stack as healthy, logs follow the services that run, and stop sweeps
// no worker.
func TestStartWithoutAWorkerBoot(t *testing.T) {
	s := newScenario(t, "container")
	writeDocument(t, s, "inference/no-worker.yaml", noJobEngines)
	stdout, stderr, code := s.run(t, "start", "--config", "no-worker")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	started := s.argv(t)
	checkGolden(t, "start-no-worker-boot.argv", started)

	mustContain(t, "stdout", stdout,
		"worker — no job has an engine; skipping (give one an engine in "+noJobEnginesAt+" to run one)",
		"🚀 Semiont stack is up")
	if n := strings.Count(stdout+stderr, noJobEnginesAt); n != 1 {
		t.Errorf("the start names %s %d times, want once\nstdout:\n%s\nstderr:\n%s", noJobEnginesAt, n, stdout, stderr)
	}
	mustNotContain(t, "start argv", started, "run -d --name semiont-worker", "semiont-worker:", "24100")
	mustContain(t, "start argv", started, "run -d --name semiont-smelter", "run -d --name semiont-weaver")

	stages := s.stageRe().FindAllString(string(s.mustLog(t)), -1)
	if len(stages) == 0 {
		t.Fatal("no staging dir in the argv log")
	}
	if _, err := os.Stat(filepath.Join(stages[len(stages)-1], "worker.json")); !os.IsNotExist(err) {
		t.Errorf("a document was staged for a worker that does not run (stat: %v)", err)
	}
	var archivist struct {
		Engines struct {
			Jobs map[string]any `json:"jobs"`
		} `json:"engines"`
	}
	if err := json.Unmarshal([]byte(stagedFile(t, s, "archivist.json")), &archivist); err != nil {
		t.Fatalf("the staged archivist.json: %v", err)
	}
	if len(archivist.Engines.Jobs) != 0 {
		t.Errorf("the Archivist's engines give jobs engines the stack runs no worker for: %v", archivist.Engines.Jobs)
	}

	rec, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Stacks map[string]struct {
			Ports    []int `json:"ports"`
			Services map[string]struct {
				Provided string `json:"provided"`
			} `json:"services"`
		} `json:"stacks"`
	}
	if err := json.Unmarshal(rec, &doc); err != nil {
		t.Fatalf("stack.json: %v", err)
	}
	local := doc.Stacks["local"]
	if got := local.Services["worker"].Provided; got != "none" {
		t.Errorf("the record says the worker is provided %q, want none:\n%s", got, rec)
	}
	for _, port := range local.Ports {
		if port == 24100 {
			t.Errorf("the stack claims the port of a worker it does not run:\n%s", rec)
		}
	}

	// Naming one stack makes status's exit its health: a stack that runs no
	// worker, no job having an engine, is not short of one.
	before := s.argv(t)
	stdout, stderr, code = s.run(t, "status", "--root", s.kb)
	if code != 0 {
		t.Errorf("status --root: exit %d for a stack that runs everything its documents ask for\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	workerRows := 0
	for _, line := range strings.Split(stdout, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "worker") {
			workerRows++
			mustContain(t, "the worker's status row", line, "not configured")
		}
	}
	if workerRows != 1 {
		t.Errorf("status has %d worker rows, want one:\n%s", workerRows, stdout)
	}
	mustNotContain(t, "status stdout", stdout, "24100")
	mustNotContain(t, "status argv", strings.TrimPrefix(s.argv(t), before), "semiont-worker")

	before = s.argv(t)
	stdout, stderr, code = s.run(t, "logs")
	if code != 0 {
		t.Fatalf("logs: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "logs stdout", stdout, "Following gateway · smelter · weaver · archivist · librarian · dispatcher · browser —")
	mustNotContain(t, "logs argv", strings.TrimPrefix(s.argv(t), before), "semiont-worker")
	// Asked for by name, the worker has nothing to follow, and says why.
	_, stderr, code = s.run(t, "logs", "--service", "worker")
	if code != 1 {
		t.Errorf("logs --service worker: exit %d, want 1", code)
	}
	mustContain(t, "logs --service worker stderr", stderr, "worker is not referenced by the running stack's config — nothing to follow.")

	before = s.argv(t)
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\n%s", code, stderr)
	}
	stopped := strings.TrimPrefix(s.argv(t), before)
	mustNotContain(t, "stop argv", stopped, "semiont-worker", "24100")
	mustContain(t, "stop argv", stopped, "stop fid-semiont-gateway", "stop fid-semiont-smelter")
}

// The plan of that start is the start: no document, no pull, no port, no
// container and no health wait for a worker, and one line saying why.
func TestStartWithoutAWorkerDryRun(t *testing.T) {
	s := newScenario(t, "container")
	writeDocument(t, s, "inference/no-worker.yaml", noJobEngines)
	stdout, stderr, code := s.run(t, "start", "--config", "no-worker", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	plan := s.norm(stdout)
	mustContain(t, "plan", plan,
		"# worker: no job has an engine — nothing to launch (give one an engine in "+noJobEnginesAt+" to run one)",
		"run -d --name semiont-smelter", "wait: http://<host-addr>:24101/health (30s)")
	if n := strings.Count(plan, noJobEnginesAt); n != 1 {
		t.Errorf("the plan names %s %d times, want once:\n%s", noJobEnginesAt, n, plan)
	}
	// The preflight sweep still names semiont-worker: it removes whatever an
	// earlier start of another Inference document left, by name.
	mustNotContain(t, "plan", plan, "run -d --name semiont-worker", "semiont-worker:", "worker.json", "24100")
}

// Asked for by name, a worker with no job to do is refused, naming where a
// job is given an engine, and nothing is run.
func TestStartServiceWorkerIsRefusedWhenNoJobHasAnEngine(t *testing.T) {
	s := newScenario(t, "container")
	writeDocument(t, s, "inference/no-worker.yaml", noJobEngines)
	stdout, stderr, code := s.run(t, "start", "--service", "worker", "--config", "no-worker")
	if code != 1 {
		t.Fatalf("exit %d, want 1\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stderr", stderr, "no job has an engine", noJobEnginesAt)
	mustNotContain(t, "stdout", stdout, "nothing to launch", "is up")
	mustNotContain(t, "argv", s.argv(t), "run -d --name semiont-worker")
}

// voyageEmbedding: the fixture's KnowledgeIndex with Voyage making the
// vectors, its key read from VOYAGE_API_KEY.
func voyageEmbedding(t *testing.T, s *scenario) {
	t.Helper()
	editDocument(t, s, "index.yaml",
		"    type: ollama\n    model: nomic-embed-text\n",
		"    type: voyage\n    model: voyage-3\n    apiKey: { fromEnv: VOYAGE_API_KEY }\n")
}

func TestStartNoInferenceBoot(t *testing.T) {
	// A stack that names no ollama anywhere: nothing local is launched for
	// inference — but its jobs' Claude engines mean inference IS configured,
	// as an external SaaS role.
	s := newScenario(t, "container")
	voyageEmbedding(t, s)
	s.extraEnv = append(s.extraEnv, "ANTHROPIC_API_KEY=test-key", "VOYAGE_API_KEY=test-voyage-key")
	stdout, stderr, code := s.run(t, "start", "--config", "anthropic")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "inference — Anthropic is remote SaaS; nothing to launch")
	if argv := s.argv(t); strings.Contains(argv, "ollama") {
		t.Errorf("a stack with no Ollama still touched ollama:\n%s", argv)
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
		t.Errorf("a stack referencing no Ollama still named one in status:\n%s", stdout)
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
	// --service on an externally-provided role warns and exits 0.
	s := newScenario(t, "container")
	externalGraph(t, s, "bolt://graph.example.com:7687")
	stdout, stderr, code := s.run(t, "start", "--service", "graph")
	if code != 0 {
		t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout+stderr", stdout+stderr, "graph is externally provided per", "graph.example.com:7687", "nothing to launch")
	if argv := s.argv(t); strings.Contains(argv, "semiont-neo4j") {
		t.Errorf("no-op still touched the container:\n%s", argv)
	}
}

func TestServiceGatewayPortFollowsConfig(t *testing.T) {
	// --service gateway port-claims the KnowledgeBase's gateway port, not a
	// static 4000.
	s := newScenario(t, "container")
	editDocument(t, s, "knowledge-base.yaml", "    port: 4000\n", "    port: 4001\n")
	stdout, _, code := s.run(t, "start", "--service", "gateway", "--dry-run")
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, stdout)
	}
	mustContain(t, "stdout", stdout,
		"require free ports: 4001",
		"wait: http://localhost:4001/api/health (120s)")
	// Against the normalized output: a temporary directory's name ends in a
	// random number, and one that contains 4000 would fail this test.
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
	// resolves to the KB root.
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
		"Config not found: "+filepath.FromSlash(".semiont/stack/inference/gone.yaml"),
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
	hostProvided := `{"schema":3,"stacks":{"local":{"runtime":"container","services":{
	  "inference":{"provided":"host","endpoint":"http://localhost:11434/api/version","startedAt":"2026-07-19T00:00:00Z"}}}}}`
	if err := os.WriteFile(statePathFor(s.home), []byte(hostProvided), 0o644); err != nil {
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

	// The record: runtime + every service with runtime-reported IDs.
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatalf("stack.json not written: %v", err)
	}
	type recordedService struct {
		Container string `json:"container"`
		ID        string `json:"id"`
		Image     string `json:"image"`
		Provided  string `json:"provided"`
		Endpoint  string `json:"endpoint"`
	}
	type recordedStack struct {
		Runtime  string                     `json:"runtime"`
		Services map[string]recordedService `json:"services"`
	}
	var set struct {
		Schema  int                        `json:"schema"`
		Stacks  map[string]recordedStack   `json:"stacks"`
		Machine map[string]recordedService `json:"machine"`
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
	// is machine-level, a viewer of every KB, recorded among the machine's.
	if _, ok := st.Services["browser"]; ok {
		t.Error("browser recorded as a stack service — the Browser is machine-level")
	}
	if b := set.Machine["semiont-browser"]; b.ID != "fid-semiont-browser" {
		t.Errorf("browser record missing or wrong: %+v", set.Machine)
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
		// A role the machine's container serves names that container; the
		// machine's own record holds what runs.
		if e.Provided == "machine" {
			m, ok := set.Machine[e.Container]
			if !ok || m.ID != "fid-"+e.Container || m.Image == "" {
				t.Errorf("%s: served by the machine's %q, whose record is %+v", role, e.Container, m)
			}
			if e.ID != "" || e.Image != "" {
				t.Errorf("%s: served by the machine, yet the stack's record carries id %q / image %q", role, e.ID, e.Image)
			}
			continue
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
	// The Browser goes with the stack, by its name under every runtime the
	// stop swept.
	mustContain(t, "full stop argv", fullArgv,
		"container stop semiont-browser", "docker stop semiont-browser", "podman stop semiont-browser")
	for _, bad := range []string{"docker stop fid-", "podman stop fid-"} {
		if strings.Contains(fullArgv, bad) {
			t.Errorf("stray sweep used the recorded runtime's IDs: %q", bad)
		}
	}
	// Nothing is left running, so nothing is left recorded: the stack's
	// record and the Browser's both go, and stack.json with them.
	if b2, err := os.ReadFile(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Errorf("stack.json after a full stop: %v\n%s", err, b2)
	}
}

func TestStopTwiceIsHonest(t *testing.T) {
	// A stop with no record, no containers, and no staging says so — it
	// doesn't claim to have stopped a stack that wasn't there.
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

// TestUnreadableStackRecordRefuses: a stack.json the launcher cannot read is
// a REFUSAL at every command that consults it, not an empty stack set.
//
// The record planted here is the realistic corruption rather than random
// bytes: a codespace stack written flat, carrying the instance name as a
// plain string where the record nests a placement object, so the whole set
// fails to unmarshal. Read as "no stacks recorded", stop would report
// nothing to stop and status no local stack while the codespace kept
// running and billing — the silent no-op the --runtime mismatch refusal
// exists to prevent.
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
	// A grant reads its key before the record, so it is given one to read.
	workerKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&workerKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "worker.pem")
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644); err != nil {
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
		{"identity", "grant", "alice", "--key", keyFile},
		{"identity", "revoke", "alice"},
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

// writeStackState plants a stack.json that records a local stack for the scenario.
func writeStackState(t *testing.T, s *scenario, runtime string) {
	t.Helper()
	st := `{"schema":3,"stacks":{"local":{"runtime":"` + runtime + `","services":{
	  "gateway":{"container":"semiont-gateway","id":"fid-semiont-gateway","provided":"launcher","startedAt":"2026-07-19T00:00:00Z"}}}}}`
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
	// The sweep excludes the Browser; weaver is the first stack member.
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

// A start says which of three paths supplied the JWT secret. A silently
// regenerated secret invalidates every live token, and which path supplied
// the key is the one fact that makes that diagnosable after the fact; it
// costs one line.
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
	// this from "generated" is the whole point: a regenerated secret looks
	// exactly like a normal start. (--service gateway, as the sibling test
	// does: a second full start re-detects host Ollama and refuses, unrelated
	// to this.)
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

// The gateway reads JWT_SECRET as an ordered, comma-separated RING: the
// first value signs, every value verifies. The launcher only carries it — but
// carrying it correctly means passing a ring through untouched, and refusing
// a member the gateway would reject at boot, where the launcher can still say
// what to do about it.
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
	mustContain(t, "stderr", stderr, append([]string{"32", "JWT_SECRET"}, keyAdvice()...)...)
}

// The gateway signs every token with JWT_SECRET and is the only service that
// reads it. Nothing in the image supplies it, so the launcher must — and must
// supply the SAME one across restarts, because a changed secret silently
// invalidates every token already issued: the "job sits in Yielding forever"
// failure.
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

	// Only the gateway gets it: the sidecars authenticate as their own
	// accounts at the issuer and never sign anything.
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
// This passes for two independent reasons (the flow passes the resolved root,
// AND start Chdir()s into it), which is exactly why it is worth pinning:
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
// operation and the secret's name, never its value. The filesystem store is
// no exception.
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

// --- the configured secrets store ---

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
	// `op` leaves PATH by a fresh shim directory that never held it: Windows may
	// still hold open the `op` that `settings` just ran, and refuse its removal.
	s.shim = shimDir(t, "container")
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

// --- semiont settings ---

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
// the value. Sharing the line would leave one space between them: a secret's
// source running into "read at each start", and the file store's "for
// development only" into "the default".
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

// The machine's default store applies to new knowledge bases only: a KB with
// no setting and nothing kept adopts it at its first need, as its own setting,
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
// they already run: init's summary and the start's.
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
// through the runtime's environment, never its command line, so it is read
// from what the container received.
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
	// present the machine's key, auto-enable OTel, stage a fresh private
	// config, and leave the rest of the stack untouched.
	//
	// The key is kept for the machine, so a restart reads the same file the
	// full start wrote and no container needs inspecting.
	s := newScenario(t, "container")
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_gateway=running",
		// The worker is ALREADY RUNNING — this is a restart, and a restart is
		// only a restart if there is something to replace. The teardown lists
		// before it acts, so a scenario that wants stop+rm asserted has to say
		// the container exists rather than relying on stop/rm being fired
		// blindly at a name that was never there.
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
		"--env SEMIONT_OIDC_CLIENT_KEY ",
		"🚀 worker is up",
		"semiont status",
	)
	if strings.Contains(stdout, "PRIVATE KEY") {
		t.Error("the worker's key leaked into stdout")
	}
	argv := s.argv(t)
	mustContain(t, "argv", argv,
		"stop semiont-worker",
		"rm semiont-worker",
		"image pull ghcr.io/the-ai-alliance/semiont-worker:latest",
		"--env SEMIONT_OIDC_CLIENT_KEY",
		"--env OTEL_EXPORTER_OTLP_ENDPOINT=http://",
		"<config-stage>/worker.json:/etc/semiont/worker.json:ro",
	)
	for _, absent := range []string{"run -d --name semiont-neo4j", "run -d --name semiont-gateway", "semiont-browser"} {
		if strings.Contains(argv, absent) {
			t.Errorf("--service worker touched the wider stack: %q in argv", absent)
		}
	}

	// A record created lazily by a --service start carries the root and the
	// identity the start resolved, not just the runtime.
	b, err := os.ReadFile(statePathFor(s.home))
	if err != nil {
		t.Fatalf("stack.json not written: %v", err)
	}
	mustContain(t, "stack.json", string(b),
		`"kbRoot": "`+inJSON(s.kb)+`"`,
		`"kbDid": "did:web:example.github.io:test-kb"`)
}

// A knowledge base someone else runs, added to this machine's worker, is one
// more knowledge base the worker's document names, after the one the start
// runs, at the gateway and as the client it was added with, at the issuer that
// gateway names, and offered the same engines. One that is the knowledge base
// the start runs refuses the start before anything runs, saying how to remove
// it; removed, the worker serves the start's own alone again.
func TestTheWorkerServesTheKnowledgeBasesAddedToIt(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/oauth-protected-resource" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"resource": "https://other.example/kb", "authorization_servers": ["https://id.other.example/realms/kb"], "bearer_methods_supported": ["header"]}`)
	}))
	t.Cleanup(gateway.Close)
	s := newScenario(t, "container")
	add := func(domain string) {
		t.Helper()
		if stdout, stderr, code := s.run(t, "worker", "kb", "add", domain, "--gateway", gateway.URL, "--client-id", "semiont-worker-alice"); code != 0 {
			t.Fatalf("worker kb add %s: exit %d\nstdout:\n%s\nstderr:\n%s", domain, code, stdout, stderr)
		}
	}
	staged := func() api.WorkerConfig {
		t.Helper()
		var doc api.WorkerConfig
		if err := json.Unmarshal([]byte(stagedFile(t, s, "worker.json")), &doc); err != nil {
			t.Fatal(err)
		}
		return doc
	}

	add("other.example:kb")
	stdout, stderr, code := s.run(t, "worker", "kb", "list")
	if code != 0 {
		t.Fatalf("worker kb list: exit %d\n%s", code, stderr)
	}
	mustContain(t, "worker kb list", stdout, "other.example:kb\n", "Issuer:     https://id.other.example/realms/kb\n", "Client id:  semiont-worker-alice\n")

	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	doc := staged()
	if len(doc.KnowledgeBases) != 2 {
		t.Fatalf("the worker's document names %d knowledge bases, want the start's own and the one added: %+v", len(doc.KnowledgeBases), doc.KnowledgeBases)
	}
	own, other := doc.KnowledgeBases[0], doc.KnowledgeBases[1]
	if own.Domain != "example.github.io:test-kb" || own.Identity.ClientId != "semiont-worker-local" {
		t.Errorf("the first knowledge base is %s as %s, want the start's own as this machine's worker", own.Domain, own.Identity.ClientId)
	}
	if other.Domain != "other.example:kb" || other.GatewayUrl != gateway.URL ||
		other.Identity.Issuer != "https://id.other.example/realms/kb" || other.Identity.ClientId != "semiont-worker-alice" {
		t.Errorf("the added knowledge base is staged as %+v", other)
	}
	offered, _ := json.Marshal(other.Engines)
	if owns, _ := json.Marshal(own.Engines); string(offered) != string(owns) || len(own.Engines) == 0 {
		t.Errorf("the added knowledge base is offered %s, and the start's own %s", offered, owns)
	}

	add("example.github.io:test-kb")
	before := strings.Count(s.argv(t), "\n")
	stdout, stderr, code = s.run(t, "start")
	if code != 1 {
		t.Fatalf("a start of a knowledge base added to its own worker: exit %d, want 1\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stderr", stderr, "semiont worker kb remove example.github.io:test-kb")
	if ran := strings.Split(s.argv(t), "\n")[before:]; strings.Contains(strings.Join(ran, "\n"), " run ") || strings.Contains(strings.Join(ran, "\n"), " stop ") {
		t.Errorf("the refused start ran or stopped containers:\n%s", strings.Join(ran, "\n"))
	}

	for _, domain := range []string{"example.github.io:test-kb", "other.example:kb"} {
		if _, stderr, code := s.run(t, "worker", "kb", "remove", domain); code != 0 {
			t.Fatalf("worker kb remove %s: exit %d\n%s", domain, code, stderr)
		}
	}
	if stdout, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if doc := staged(); len(doc.KnowledgeBases) != 1 || doc.KnowledgeBases[0].Domain != "example.github.io:test-kb" {
		t.Errorf("with every added knowledge base removed, the worker's document names %+v", doc.KnowledgeBases)
	}
}

func TestStartServiceGraph(t *testing.T) {
	// Infra service: no config, no secret, no pull (pinned image) — just its
	// own stop+rm, run, and health gate. Under Docker no host-addr probe
	// either. Under Apple container the graph publishes the containers' side
	// of its bolt port on the host address, so the probe is what places it.
	for _, rt := range []string{"container", "docker"} {
		t.Run(rt, func(t *testing.T) {
			s := newScenario(t, rt)
			// Already running, so "Restarting graph" has something to replace.
			// The teardown lists before it acts; a scenario asserting stop+rm
			// must say the container is there rather than relying on a blind
			// fire at its name.
			s.extraEnv = append(s.extraEnv, "FAKERT_STATE_neo4j=running")
			stdout, stderr, code := s.run(t, "start", "--service", "graph")
			if code != 0 {
				t.Fatalf("want exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
			}
			mustContain(t, "stdout", stdout, "Restarting Graph (Neo4j)", "🚀 graph is up")
			argv := s.argv(t)
			// Docker's run carries its log options before -d.
			mustContain(t, "argv", argv, "stop semiont-neo4j", "rm semiont-neo4j", "-d --name semiont-neo4j")
			needless := []string{"image pull", "inspect"}
			if rt == "container" {
				mustContain(t, "argv", argv, "-p 192.168.64.1:17687:7687")
			} else {
				needless = append(needless, "busybox")
			}
			for _, absent := range needless {
				if strings.Contains(argv, absent) {
					t.Errorf("infra --service ran needless step: %q in argv", absent)
				}
			}
		})
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
	// The git-clone invariant covers a full start and the Archivist, which
	// mounts /kb as the git WRITER: a non-clone would fail at its first
	// `git add` instead. Every other service needs only the .semiont/ tree.
	if _, stderr, code := s.run(t, "start", "--service", "archivist"); code != 1 {
		t.Errorf("archivist without git: want exit 1, got %d", code)
	} else {
		mustContain(t, "stderr", stderr, "must be a git clone")
	}
	// The gateway and the Librarian mount no part of the KB tree, so the
	// clone invariant does not apply to them.
	for _, svc := range []string{"gateway", "librarian"} {
		if _, stderr, code := s.run(t, "start", "--service", svc); code != 0 {
			t.Errorf("%s without git: want exit 0 (it mounts no KB tree), got %d\nstderr:\n%s", svc, code, stderr)
		}
	}
}

// The Librarian restart path — the argv IS the contract: NO piece of the KB
// tree and not the Archivist's state tree, just its own store (its
// supervisor's events log), its document, 24104, and neither JWT_SECRET (it
// signs nothing) nor LIBRARIAN_HOST (nothing dials it).
func TestStartServiceLibrarian(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--service", "librarian")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting Librarian", "Librarian healthy (http://192.168.64.1:24104)")
	log := string(s.mustLog(t))
	mustContain(t, "argv", log,
		"--name semiont-librarian",
		"--publish 192.168.64.1:24104:24104",
		"librarian.json:/etc/semiont/librarian.json:ro",
		filepath.Join(testKBKey, "librarian")+":/semiont-state",
		"--env SEMIONT_OIDC_CLIENT_ID=semiont-librarian")
	for _, banned := range []string{"JWT_SECRET", "LIBRARIAN_HOST", "GATEWAY_HOST", "XDG_STATE_HOME", ":/kb", "anchored-text:", filepath.Join(testKBKey, "state") + ":"} {
		if strings.Contains(log, banned) {
			t.Errorf("the Librarian must not receive %s:\n%s", banned, log)
		}
	}
	// The staging wiring, asserted end to end: read the file the container
	// would. Boot refuses a document that is not whole, so a miss here is a
	// librarian that never starts live.
	mustContain(t, "staged librarian.json", stagedFile(t, s, "librarian.json"),
		`"passwordEnv": "NEO4J_PASSWORD"`)
	if v, _ := s.containerEnv(t, "semiont-librarian", "NEO4J_PASSWORD"); len(v) < 32 {
		t.Errorf("the Librarian's document names NEO4J_PASSWORD, and it was handed %q", v)
	}
}

// The Archivist restart path: teardown + port settle + staged config + run +
// health gate, like any sidecar — but with the record's mounts. The argv is
// the pin: /kb read-write, its configuration document, the anchored-text
// store it alone mounts, and NO JWT_SECRET (it signs nothing).
func TestStartServiceArchivist(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--service", "archivist")
	if code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Restarting Archivist", "Archivist healthy (http://192.168.64.1:24103)")
	log := string(s.mustLog(t))
	mustContain(t, "argv", log,
		"--name semiont-archivist",
		"--publish 192.168.64.1:24103:24103",
		":/kb",
		"archivist.json:/etc/semiont/archivist.json:ro",
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
		"<config-stage>/worker.json",
		"wait: http://<host-addr>:24100/health (30s)",
	)
	if strings.Contains(stdout, "semiont-neo4j") {
		t.Error("service plan leaked the wider stack")
	}
	// Dry run must execute nothing: worker needs only .semiont/ discovery
	// (pure Go), not the git-clone invariant (a full start, gateway, archivist).
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

// NOT COVERED by any test: a `--service` restart must not silently substitute
// a credential that breaks auth. Deleting a per-root secret file makes the
// launcher generate one the realm has never seen.

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
	// The sequence the launcher itself prescribes: stop the local stack, then
	// start it again. `stop` forgets the local record by design, so a
	// codespace resume keyed on nothing more than "no local record" would
	// flip this bare start to the cloud, sweep the local containers in its
	// preflight, and wake a paid codespace. Standing in a KB clone must
	// always mean local.
	s := newCodespaceScenario(t) // cwd IS a KB clone; a codespace is recorded
	if _, stderr, code := s.run(t, "start", "--runtime", "codespace"); code != 0 {
		t.Fatalf("codespace start: exit %d\nstderr:\n%s", code, stderr)
	}
	// A local stack, then stop it — leaving a codespace record present, no
	// local record.
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
	// Outside any KB clone a bare start resumes the RECORDED stack's repo,
	// even when the cwd's git origin names a different one. INSIDE a clone
	// startCodespace's identity ladder legitimately prefers the clone's
	// origin (TestStopThenStartStaysLocal); pinned so that preference can
	// never leak out to the no-clone case.
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
	// The launcher brings Ollama up and pulls what the config asks it to
	// serve — and only that. A configured model that was never pulled would
	// otherwise stay invisible until a worker reached for it mid-job and
	// failed.
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

	// A start that keeps the machine's Ollama still pulls what is missing:
	// another knowledge base's config may ask it for a model it lacks.
	if err := os.Remove(filepath.Join(s.fakertDir, "ollama-pulls")); err != nil {
		t.Fatalf("clearing the first start's pulls: %v", err)
	}
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_ollama=running",
		"FAKERT_IMAGE_ollama="+readMachineRecords(t, s).Machine["semiont-ollama"].Image)
	stdout, stderr, code := s.run(t, "start")
	if code != 0 {
		t.Fatalf("keeping start: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "keep message", stdout, "the machine's Ollama already running")
	if got := pulls(s); !strings.Contains(got, "gemma4:e2b") || !strings.Contains(got, "nomic-embed-text") {
		t.Errorf("a kept Ollama was not asked for the missing models; pulled:\n%s", got)
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
	stdout, stderr, code = s3.run(t, "start")
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
		t.Error("says 'jobs that use it' — wrong for the embedding model, which the smelter needs, not the worker pool")
	}
}

func TestRemoteModelsAreNeverCheckedAgainstOllama(t *testing.T) {
	// The anthropic config runs every actor and worker on Claude while its
	// embedding runs on Ollama. The inference row's driver is therefore
	// "ollama" (that Ollama exists only to serve the embedding) but its
	// models are all remote. Checking them against Ollama would report
	// "MISSING — ollama pull claude-sonnet-4-5-…", advice that cannot work.
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

	// The stack records embedding as served by the machine's Ollama, so
	// --service embedding is what stops that Ollama alone; --service
	// inference, which Claude performs, leaves it.
	if m := readMachineRecords(t, s); m.Machine["semiont-ollama"] == nil || m.Stacks["local"].Services["embedding"].Provided != "machine" {
		t.Errorf("want the machine's Ollama recorded and embedding provided by it, got %+v", m)
	}
	before := s.mustLog(t)
	if _, stderr, code := s.run(t, "stop", "--service", "inference"); code != 0 {
		t.Fatalf("stop --service inference: exit %d\nstderr:\n%s", code, stderr)
	}
	if fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before)); strings.Contains(fresh, "semiont-ollama") {
		t.Errorf("stop --service inference, which Claude performs, touched the embedding's Ollama:\n%s", fresh)
	}
	before = s.mustLog(t)
	stdout, stderr, code := s.run(t, "stop", "--service", "embedding")
	if code != 0 {
		t.Fatalf("stop --service embedding: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop --service embedding", stdout, "Ollama stopped")
	mustContain(t, "stop --service embedding's argv", strings.TrimPrefix(string(s.mustLog(t)), string(before)), "stop semiont-ollama")

	// And a bare stop finds the embedding-owned Ollama — the one hazard of
	// ownership sitting with a role other than inference.
	if _, stderr, code := s.run(t, "start", "--config", "anthropic"); code != 0 {
		t.Fatalf("start again: exit %d\nstderr:\n%s", code, stderr)
	}
	before = s.mustLog(t)
	if _, stderr, code := s.run(t, "stop"); code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	if fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before)); !strings.Contains(fresh, "stop semiont-ollama") {
		t.Errorf("stop never targeted the embedding-owned Ollama container:\n%s", fresh)
	}
}

// serveAnthropicModels starts a fake /v1/models on an EPHEMERAL port, listing
// exactly the given ids, and returns the port. Reached via the config's
// [inference.anthropic] endpoint — the same override a proxy would use, so no
// launcher test-mode exists. A fixed port would collide with anything else
// holding the number, and the number means nothing: the launcher is told the
// endpoint by flag or config.
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
	writeDocument(t, s, "inference/anthropic-meta.yaml", inferenceDocument("anthropic-meta", anthropicAt(anthPort), sonnet,
		map[string]string{"jobs.mark.tagging": "{ provider: anthropic, model: claude-haiku-4-5-20251001 }"}))
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

// inferenceDocument: an Inference document named name, with providers (YAML
// lines under spec.providers), engine (a flow mapping) the engine of every job
// and actor except those overrides names ("jobs.mark.tagging").
func inferenceDocument(name, providers, engine string, overrides map[string]string) string {
	at := func(path string) string {
		if given, ok := overrides[path]; ok {
			return given
		}
		return engine
	}
	var b strings.Builder
	fmt.Fprintf(&b, "apiVersion: semiont.the-ai-alliance.github.io/v1alpha1\nkind: Inference\nmetadata:\n  name: %s\nspec:\n  providers:\n%s  engines:\n    actors:\n", name, providers)
	for _, actor := range []string{"gatherer", "matcher"} {
		fmt.Fprintf(&b, "      %s: %s\n", actor, at("actors."+actor))
	}
	b.WriteString("    jobs:\n      mark:\n")
	for _, motivation := range []string{"linking", "highlighting", "assessing", "commenting", "tagging"} {
		fmt.Fprintf(&b, "        %s: %s\n", motivation, at("jobs.mark."+motivation))
	}
	fmt.Fprintf(&b, "      yield: %s\n", at("jobs.yield"))
	return b.String()
}

// sonnet: Claude Sonnet, as an engine.
const sonnet = "{ provider: anthropic, model: claude-sonnet-4-5-20250929 }"

// anthropicAt: the anthropic provider, reached at a local fake's port, its
// key read from ANTHROPIC_API_KEY.
func anthropicAt(port int) string {
	return fmt.Sprintf("    anthropic: { baseURL: \"http://localhost:%d\", apiKey: { fromEnv: ANTHROPIC_API_KEY } }\n", port)
}

// --- semantic search is mandatory ---

// A stack the gateway refuses to boot must be refused HERE, before a single
// container is launched. Otherwise start brings the whole stack up and the
// gateway dies seconds later on a file the launcher already had in its hands.
func TestStartRefusesAStackWithNoSemanticSearch(t *testing.T) {
	for _, c := range []struct {
		name, cut string
		wants     []string
	}{
		{
			"no-vectors",
			"  vectors:\n    type: qdrant\n    image: qdrant/qdrant:v1.19.1@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10\n    resources: { limits: { memory: 2G } }\n",
			[]string{"index.yaml", "/spec/vectors", "is missing"},
		},
		{
			"no-embedding",
			"  embedding:\n    type: ollama\n    model: nomic-embed-text\n    chunking: { chunkSize: 512, overlap: 64 }\n",
			[]string{"index.yaml", "/spec/embedding", "is missing"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := newScenario(t, "container")
			editDocument(t, s, "index.yaml", c.cut, "")
			stdout, stderr, code := s.run(t, "start")
			if code == 0 {
				t.Fatalf("start accepted a stack the gateway refuses to boot\nstdout:\n%s", stdout)
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

// --- platform-sourced inference ceilings ---

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

// limitsReply scripts the worker's job:limits-result payload: the engines it
// reports, each with the limits it discovered.
func limitsReply(engines ...string) string {
	return `FAKERT_BUS_REPLY_job_limits_requested={"limits":[` + strings.Join(engines, ",") + `]}`
}

func reportedEngine(provider, model, limits string) string {
	return fmt.Sprintf(`{"engine":{"provider":"%s","model":"%s"},"limits":%s}`, provider, model, limits)
}

func TestStatusShowsPlatformCeilings(t *testing.T) {
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(
			reportedEngine("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`),
			reportedEngine("ollama", "nomic-embed-text", `{"contextTokens":8000,"maxOutputTokens":8000}`),
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
	// provider. (Platform data flows through the platform surface.)
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
	// report, and a row without a ceiling is the plain row — no error, no
	// placeholder. (Ignorance is not a finding.)
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(reportedEngine("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`)))
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
	// non-answer as silence: rows render without a ceiling, and status exits
	// on health alone.
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
	// A missing ceiling is normal, never an error, all the way to the
	// terminal: a pair whose discovery failed is absent from its key holder's
	// report, and its row is unchanged.
	s := busScenario(t,
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(
			reportedEngine("ollama", "nomic-embed-text", `{"contextTokens":8000,"maxOutputTokens":8000}`),
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
	writeDocument(t, s, "inference/mixed.yaml", inferenceDocument("mixed", anthropicAt(anthPort), sonnet, nil))
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
	// the model NAME alone would print one here — a wrong number, which is
	// worse than a missing one.
	s := mixedStackScenario(t,
		limitsReply(reportedEngine("ollama", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`)))
	stdout, _, code := s.run(t, "status")
	if code != 0 {
		t.Fatalf("status: exit %d\nstdout:\n%s", code, stdout)
	}
	mustContain(t, "model row still renders", stdout, "claude-sonnet-4-5-20250929", "remote")
	mustNotContain(t, "cross-provider report", stdout, "window", " in / ")
}

func TestStatusShowsARemoteCeilingInAnOllamaDrivenRow(t *testing.T) {
	// Jobs default to Anthropic's engine while one motivation's jobs have Ollama's,
	// so the inference row's driver is ollama and lists Claude beside gemma. Each
	// engine names its provider, so each model's ceiling is keyed by its own
	// provider, not by the row's: keyed by the row's, Claude's row would be
	// bare although the worker reports its limits.
	anthPort := serveAnthropicModels(t, "claude-sonnet-4-5-20250929")
	s := newScenario(t, "container")
	writeDocument(t, s, "inference/mixed-ollama.yaml", inferenceDocument("mixed-ollama", anthropicAt(anthPort)+"    ollama: {}\n", sonnet,
		map[string]string{"jobs.mark.highlighting": `{ provider: ollama, model: "gemma4:26b" }`}))
	s.extraEnv = append(s.extraEnv,
		"ANTHROPIC_API_KEY=test-key",
		"FAKERT_OLLAMA_TAGS=gemma4:26b,nomic-embed-text:latest",
		limitsReply(
			reportedEngine("anthropic", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`),
			reportedEngine("ollama", "gemma4:26b", `{"contextTokens":128000,"maxOutputTokens":128000}`),
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
	// The launcher's own /v1/models probe renders "200K ctx". Once the
	// platform publishes the ceiling, THAT is the one on the row — one context
	// figure, from the platform, never two from two sources. The probe keeps
	// rendering what only it knows (identity, release, key visibility).
	s := mixedStackScenario(t,
		limitsReply(reportedEngine("anthropic", "claude-sonnet-4-5-20250929", `{"contextTokens":200000,"maxOutputTokens":64000}`)))
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
	// stack — demanding --runtime container would restate what the prompt
	// already says. The rule is the start-side one: a KB clone is explicit
	// context.
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
		t.Errorf("the local path execs the gateway's bin:\n%s", fresh)
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
	// container's own logs, there for the whole wait while the launcher says
	// only "did not become ready". So the gate failure shows the tail.
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
	// The other half of the failed-gate story: service containers run
	// without --rm, so one that CRASHED during the gate remains, dumpLogs
	// works on it, and the next start's preflight (or stop) sweeps it. With
	// --rm the container, its console output and its log files would go
	// with it, and `<rt> logs` would answer "No such container".
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
	// Cost facts: status states the hardware burning and since when — facts
	// only, never invented dollars. Available shows machine + uptime;
	// Shutdown shows when storage billing ENDS by auto-deletion; the
	// up-summary names the machine and its auto-stop.
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
	// GitHub's OWN usage report, opt-in. Their numbers verbatim — quantities,
	// gross, quota-as-discount, net — never a launcher estimate;
	// non-codespaces products filtered out; the month that actually cost
	// money shows its net.
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
	// capturing stdout alone would swallow gh's "please run gh auth login".
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
	// The discovery export view rides every stack mutation — local start,
	// codespace start, delete — and is endpoints only, never a secret. The
	// Browser mounts its directory read-only.
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
	// A published entry is a promise about what lives at an address, and only
	// one process can bind a port — so two entries claiming one address means
	// at most one promise is true: with a local stack on :4000 and a codespace
	// forward record that claims :4000 both published, the Browser renders
	// the user's own KB under the other repo's name.
	//
	// The sequence below produces that record shape: dropCollidingForwards
	// kills a forward the local stack needs and zeroes its PID, but KEEPS
	// ForwardPort — a record the writer must not publish as a live address.
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
	// address is what is unique; the identity deliberately is not.
	//
	// This pins the launcher against the tempting inverse — "one entry per
	// identity" — which would silently hide whichever copy lost the tie, and
	// against a consumer assuming did is a primary key.
	s := newCodespaceScenario(t)
	// The codespace's committed identity is the SAME KB as the local clone.
	s.extraEnv = append(s.extraEnv,
		"FAKERT_GH_KBCONFIG="+remoteProjectFile("example.github.io:test-kb"))

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

func TestBrowserLifecycle(t *testing.T) {
	// The Browser keeps a record of its own, apart from the stack's. Start
	// ensures it; stop takes it down with the stack; a start that finds one
	// running as its record says KEEPS it; a stale image is restarted;
	// --service browser stops it alone.
	s := newScenario(t, "container")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\nstderr:\n%s", code, stderr)
	}
	// The record is machine-level, not a stack service. Asserted on the
	// PARSED shape, not a substring: the machine-level record and a stack
	// service would both be named "browser", so a substring check cannot say
	// WHERE it appeared — it would pass while the Browser sat in the wrong
	// place, or contradict itself.
	rec, _ := os.ReadFile(statePathFor(s.home))
	var placement struct {
		Machine map[string]json.RawMessage `json:"machine"`
		Stacks  map[string]struct {
			Services map[string]json.RawMessage `json:"services"`
		} `json:"stacks"`
	}
	if err := json.Unmarshal(rec, &placement); err != nil {
		t.Fatalf("stack.json: %v", err)
	}
	if _, ok := placement.Machine["semiont-browser"]; !ok {
		t.Errorf("no machine-level browser record:\n%s", rec)
	}
	if _, wrong := placement.Stacks["local"].Services["browser"]; wrong {
		t.Errorf("browser recorded as a stack service:\n%s", rec)
	}
	// The stack's port claims must NOT include the Browser's 3000 — stop
	// verifies release of stack ports, and the Browser keeps running.
	// Assert on the PARSED claims, not a raw substring: a nanosecond
	// startedAt can contain "3000".
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

	// The first start ran the verified image, by its digest.
	var ran struct {
		Machine map[string]struct {
			Image string `json:"image"`
		} `json:"machine"`
	}
	if err := json.Unmarshal(rec, &ran); err != nil || !strings.HasPrefix(ran.Machine["semiont-browser"].Image, "ghcr.io/the-ai-alliance/semiont-browser:latest@sha256:") {
		t.Fatalf("the Browser was recorded as %q (%v): want the verified image, by its digest", ran.Machine["semiont-browser"].Image, err)
	}

	// Stop: the stack and the Browser both, and both records. Slice the
	// argv to THIS command — start's own restart branch legitimately
	// stop/rm's a stale browser earlier in the log.
	preStop := s.mustLog(t)
	stdout, stderr, code := s.run(t, "stop", "--runtime", "container")
	if code != 0 {
		t.Fatalf("stop: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "stop stdout", stdout, "Browser stopped")
	stopArgv := strings.TrimPrefix(string(s.mustLog(t)), string(preStop))
	mustContain(t, "stop argv", stopArgv, "container stop semiont-browser", "container rm semiont-browser")
	if left, err := os.ReadFile(statePathFor(s.home)); !os.IsNotExist(err) {
		t.Errorf("stack.json after a stop: %v\n%s", err, left)
	}

	// A start after the stop finds no record, so it runs the Browser afresh
	// and records it.
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start after the stop: exit %d\nstderr:\n%s", code, stderr)
	}

	// A start that finds a current Browser running as its record says KEEPS
	// it: no churn. The fake runtime reports the reference the first start
	// ran.
	s.extraEnv = append(s.extraEnv,
		"FAKERT_STATE_browser=running",
		"FAKERT_IMAGE_browser="+ran.Machine["semiont-browser"].Image)
	before := s.mustLog(t)
	stdout, stderr, code = s.run(t, "start")
	if code != 0 {
		t.Fatalf("keeping start: exit %d\nstderr:\n%s", code, stderr)
	}
	fresh := strings.TrimPrefix(string(s.mustLog(t)), string(before))
	mustContain(t, "keep message", stdout+stderr, "Browser already running")
	if strings.Contains(fresh, "run -d --name semiont-browser") {
		t.Errorf("current Browser was churned:\n%s", fresh)
	}

	// Stale image (reference differs), its record otherwise agreeing:
	// restart.
	for i, e := range s.extraEnv {
		if strings.HasPrefix(e, "FAKERT_IMAGE_browser=") {
			s.extraEnv[i] = "FAKERT_IMAGE_browser=ghcr.io/the-ai-alliance/semiont-browser:old"
		}
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

// --- semiont init ---

func TestInitBirthsIdentity(t *testing.T) {
	// Flag-driven birth, prompt-free: .semiont/config.yaml carries the exact
	// identity, and no TOML project file is written; git init + stage
	// happen, the root registers, and a second init refuses without --force.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	stdout, stderr, code := s.run(t, "init",
		"--name", "family-kb", "--domain", "pingel-org.github.io:family-kb",
		"--site-name", "Family KB", "--yes")
	if code != 0 {
		t.Fatalf("init: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	cfg, err := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config.yaml"))
	if err != nil {
		t.Fatalf(".semiont/config.yaml not written: %v", err)
	}
	mustContain(t, ".semiont/config.yaml", string(cfg),
		`name: "family-kb"`,
		`domain: "pingel-org.github.io:family-kb"`,
		`siteName: "Family KB"`,
		`sync: true`)
	if _, err := os.Stat(filepath.Join(s.cwd, ".semiont", "config")); !os.IsNotExist(err) {
		t.Errorf("init wrote the TOML project file beside config.yaml (%v)", err)
	}
	// Two fields the fleet's KBs do not carry, so a born KB must not either:
	// `version` is bumped by nothing, and `adminEmail` reaches no reader.
	for _, dead := range []string{"version:", "adminEmail"} {
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
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config.yaml"))
	// Owner lowercased (Pages hosts are lowercase); repo name kept as-is.
	mustContain(t, "derived did", string(cfg), `domain: "pingel-org.github.io:family-kb"`)
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
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config.yaml"))
	mustContain(t, "config", string(cfg), `sync: false`)
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
	mustContain(t, "plan", stdout, ".semiont/config.yaml", "git init")
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
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config.yaml"))
	mustContain(t, "prompted values", string(cfg),
		`domain: "d.example.org:kb"`, `siteName: "My KB"`)
}

func TestInitGeneratesStartableDocuments(t *testing.T) {
	// The generative document builder. The strongest possible assertion is
	// the round trip — the generated documents must pass the REAL loader and
	// deriver: `start --dry-run --config <name>` succeeds from the newborn KB.
	// Both actors and every job are given one engine, the model chosen;
	// per-job refinement is the user's edit, not ours.
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "FAKERT_GIT_ROOT="+s.cwd)
	// Seam flags at a dead port: hermetic — validation degrades to the
	// warn path, which is itself part of live model validation's contract.
	_, stderr, code := s.run(t, "init",
		"--name", "kb", "--domain", "d.io:kb", "--yes",
		"--inference", "anthropic", "--model", "claude-sonnet-4-5-20250929",
		"--embedding", "ollama:nomic-embed-text", "--config-name", "anthropic",
		"--ollama-base", "http://127.0.0.1:1", "--ollama-registry", "http://127.0.0.1:1")
	if code != 0 {
		t.Fatalf("init: exit %d\nstderr:\n%s", code, stderr)
	}
	stackDir := filepath.Join(s.cwd, ".semiont", "stack")
	inference, err := os.ReadFile(filepath.Join(stackDir, "inference", "anthropic.yaml"))
	if err != nil {
		t.Fatalf("generated Inference document missing: %v", err)
	}
	mustContain(t, "inference/anthropic.yaml", string(inference),
		"gatherer:", "matcher:", "linking:", "tagging:", "yield:",
		"model: claude-sonnet-4-5-20250929", "provider: anthropic",
		"fromEnv: ANTHROPIC_API_KEY")
	if n := strings.Count(string(inference), "model: "); n != 8 {
		t.Errorf("the document names %d engines, want both actors' and every job's (8):\n%s", n, inference)
	}
	index, err := os.ReadFile(filepath.Join(stackDir, "index.yaml"))
	if err != nil {
		t.Fatalf("generated KnowledgeIndex missing: %v", err)
	}
	mustContain(t, "index.yaml", string(index), "model: nomic-embed-text", "semiont-librarian:latest")
	for _, name := range []string{"knowledge-base.yaml", "issuer.yaml"} {
		if _, err := os.Stat(filepath.Join(stackDir, name)); err != nil {
			t.Errorf("%s not generated: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(stackDir, "workers.yaml")); !os.IsNotExist(err) {
		t.Errorf("init wrote a workers.yaml into the knowledge base (%v): the worker's document is the machine's", err)
	}
	stdout, stderr, code := s.run(t, "start", "--config", "anthropic", "--dry-run")
	if code != 0 {
		t.Fatalf("the generated documents failed the real deriver: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
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
		t.Fatalf("ollama documents failed the deriver: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "ollama plan", stdout, "host Ollama", "gemma4:26b, nomic-embed-text")
	// A newborn's issuer is the Keycloak the launcher runs, on the port the
	// launcher gives it, so the laptop that forwards it can move it.
	stdout, stderr, code = s2.run(t, "start", "--config", "ollama", "--dry-run")
	_ = stderr
	if !strings.Contains(stdout, "-p <host-addr>:8080:8080") {
		t.Errorf("the newborn's Keycloak is not on the default port:\n%s", stdout)
	}
	s2.extraEnv = append(s2.extraEnv, "KEYCLOAK_PORT=8081")
	if stdout, stderr, code = s2.run(t, "start", "--config", "ollama", "--dry-run"); code != 0 {
		t.Fatalf("moved issuer: exit %d\nstderr:\n%s", code, stderr)
	}
	mustContain(t, "a newborn's issuer moves with KEYCLOAK_PORT", stdout, "-p <host-addr>:8081:8080")

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

// serveOllamaFixtures starts, on an EPHEMERAL port it returns (same reasoning
// as serveAnthropicModels), a local stand-in for BOTH the local Ollama daemon
// (/api/tags — what is installed) and the ollama registry
// (/v2/library/<m>/manifests/<t> — what exists to pull). init reaches them
// through --ollama-base / --ollama-registry, the proxy knobs that double as
// test seams.
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
	// whose jobs fail later. Without --model, the ONE editorial default
	// picks the newest capable model and says so.
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
	inference, _ := os.ReadFile(filepath.Join(s2.cwd, ".semiont", "stack", "inference", "anthropic.yaml"))
	mustContain(t, "inference/anthropic.yaml", string(inference), "model: claude-sonnet-4-9")

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

// templateFixture builds a fake semiont-template-kb tree: the fixture's own
// documents (the same files the parser tests trust) plus a devcontainer set
// with the template's display name. includeBad names a graph store no driver
// runs, so no document of it can start.
func templateFixture(t *testing.T, includeBad bool) string {
	t.Helper()
	root := t.TempDir()
	for _, name := range fixtureDocuments {
		if name == "config.yaml" {
			continue
		}
		b, err := os.ReadFile(libraryTestdata("kb", ".semiont", filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		if includeBad && name == "stack/index.yaml" {
			b = []byte(strings.Replace(string(b), "type: neo4j", "type: janusgraph", 1))
		}
		target := filepath.Join(root, ".semiont", filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, b, 0o644); err != nil {
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
	if err := os.WriteFile(filepath.Join(root, ".semiont", "config.yaml"),
		[]byte("project:\n  name: Semiont Template KB\ngit:\n  sync: true\nsite:\n  domain: the-ai-alliance.github.io:semiont-template-kb\n  siteName: Semiont Template KB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestInitFromTemplateCopiesAndVets(t *testing.T) {
	// The explicit template-copy path. The template's documents pass the SAME
	// vet as generated ones; identity is always init's own, never the
	// template's; and the copied documents round-trip through the real
	// loader and deriver.
	tpl := templateFixture(t, false)
	s := newScenario(t, "container")
	s.cwd = t.TempDir()
	s.extraEnv = append(s.extraEnv, "FAKERT_GIT_ROOT="+s.cwd)
	_, stderr, code := s.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes",
		"--from-template", tpl)
	if code != 0 {
		t.Fatalf("from-template: exit %d\nstderr:\n%s", code, stderr)
	}
	for _, name := range fixtureDocuments {
		if name == "config.yaml" {
			continue
		}
		if _, err := os.Stat(filepath.Join(s.cwd, ".semiont", filepath.FromSlash(name))); err != nil {
			t.Errorf("%s not copied: %v", name, err)
		}
	}
	cfg, _ := os.ReadFile(filepath.Join(s.cwd, ".semiont", "config.yaml"))
	mustContain(t, "identity is init's own", string(cfg), `domain: "d.io:kb"`)
	if strings.Contains(string(cfg), "semiont-template-kb") {
		t.Errorf("template identity leaked into the newborn:\n%s", cfg)
	}
	if _, _, code := s.run(t, "start", "--config", "anthropic", "--dry-run"); code != 0 {
		t.Fatal("copied documents failed the real deriver")
	}

	// A template carrying an unstartable document: the WHOLE init refuses,
	// pre-write, with the deriver's own complaint — no partial tree.
	tplBad := templateFixture(t, true)
	s2 := newScenario(t, "container")
	s2.cwd = t.TempDir()
	_, stderr, code = s2.run(t, "init", "--name", "kb2", "--domain", "d.io:kb2", "--yes",
		"--from-template", tplBad)
	if code != 1 {
		t.Fatalf("bad template: want refusal, got %d", code)
	}
	mustContain(t, "the deriver's own refusal", stderr, "janusgraph")
	if _, err := os.Stat(filepath.Join(s2.cwd, ".semiont", "stack")); !os.IsNotExist(err) {
		t.Error("refusal left a partial .semiont/stack tree")
	}

	// Two sources of documents are contradictory.
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
	if _, err := os.Stat(filepath.Join(s.cwd, ".semiont", "stack", "inference", "anthropic.yaml")); err != nil {
		t.Errorf("cloned document missing: %v", err)
	}
}

func TestInitHardeningRules(t *testing.T) {
	// Init's hardening rules, each pinned.

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
	if _, err := os.Stat(filepath.Join(s.cwd, ".semiont", "stack", "escape.yaml")); err == nil {
		t.Error("traversal wrote outside .semiont/stack/inference")
	}

	// (2) Transactional: a failure after .semiont/config.yaml leaves NOTHING —
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

	// (3) --force removes the old tree — no stale document survives.
	s3 := newScenario(t, "container")
	s3.cwd = t.TempDir()
	stale := filepath.Join(s3.cwd, ".semiont", "stack", "inference", "stale.yaml")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, code := s3.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes", "--force"); code != 0 {
		t.Fatalf("--force init failed: %d", code)
	}
	if _, err := os.Stat(stale); err == nil {
		t.Error("--force left a stale document beside the new identity")
	}

	// (3b) --force removes nothing until every decision has held: not under
	// --dry-run, and not when init refuses before it writes.
	reborn := newScenario(t, "container")
	reborn.cwd = t.TempDir()
	events := filepath.Join(reborn.cwd, ".semiont", "events")
	if err := os.MkdirAll(events, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(events, "kept.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, code := reborn.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes", "--force", "--dry-run"); code != 0 {
		t.Fatalf("--force --dry-run failed: %d", code)
	}
	if _, err := os.Stat(filepath.Join(events, "kept.jsonl")); err != nil {
		t.Errorf("--force --dry-run removed the existing .semiont/: %v", err)
	}
	if _, _, code := reborn.run(t, "init", "--name", "kb", "--yes", "--force"); code != 1 {
		t.Fatalf("--force with no domain: want refusal, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(events, "kept.jsonl")); err != nil {
		t.Errorf("--force removed the existing .semiont/ before refusing: %v", err)
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

	// (5) a symlinked template document is refused.
	tpl2 := templateFixture(t, false)
	if err := os.Symlink("/etc/hosts", filepath.Join(tpl2, ".semiont", "stack", "inference", "evil.yaml")); err != nil {
		t.Fatalf("this test needs a symlink in the template, and making one failed: %v", err)
	}
	s5 := newScenario(t, "container")
	s5.cwd = t.TempDir()
	_, stderr, code = s5.run(t, "init", "--name", "kb", "--domain", "d.io:kb", "--yes", "--from-template", tpl2)
	if code != 1 {
		t.Fatalf("symlinked document: want refusal, got %d", code)
	}
	mustContain(t, "symlink refused", stderr, "symlink")

	// (6) the generated Inference document honors --anthropic-endpoint.
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
	inference, _ := os.ReadFile(filepath.Join(s6.cwd, ".semiont", "stack", "inference", "anthropic.yaml"))
	mustContain(t, "endpoint honored", string(inference), "baseURL: "+anthURL)
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
	// Flags without a subcommand get a pointed hint.
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

// WIRE SMOKE TEST (browse). This family's logic runs in process against a
// fake transport (packages/go/launcher/verbs/verbs_test.go). This one stays end-to-end
// deliberately: it is the only thing proving the BUILT BINARY speaks HTTP a
// real server understands. A family tested only against a double can agree with
// a bug in our own client.
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
// (packages/go/launcher/verbs/session_test.go); this proves the BUILT BINARY renews a
// session over real HTTP for a BUS verb: fakert refuses the login-issued token
// on its second use, and browse must still succeed — under the renewed token,
// saved for the next command.
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
	if signIn, _ := storedSignIn(t, s.home, "local"); tagOf(signIn.Token) != "fake-jwt-token-2" {
		t.Errorf("tokens.json was not rotated to the renewed token")
	}
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

// WIRE SMOKE TEST (gather). This family's logic runs in process against a
// fake transport (packages/go/launcher/verbs/verbs_test.go). This one stays end-to-end
// deliberately: it is the only thing proving the BUILT BINARY speaks HTTP a
// real server understands. A family tested only against a double can agree with
// a bug in our own client.
func TestGatherResourceSummarizes(t *testing.T) {
	// The REAL GatheredContext shape (schema-defined): metadata +
	// inferredRelationshipSummary, not invented content/summary/resources
	// fields.
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
	// maxResources, and a zero-valued struct would send maxResources 0, which
	// the librarian forwards to Qdrant as `limit: 0` — refused with a 422.
	mustContain(t, "emit", b, `"channel":"gather:resource-requested"`, `"resourceId":"res-1"`,
		`"includeContent":true`, `"depth":2`, `"maxResources":10`)
}

// WIRE SMOKE TEST (mark). This family's logic runs in process against a
// fake transport (packages/go/launcher/verbs/verbs_test.go). This one stays end-to-end
// deliberately: it is the only thing proving the BUILT BINARY speaks HTTP a
// real server understands. A family tested only against a double can agree with
// a bug in our own client.
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

// WIRE SMOKE TEST (bind). The family's only test, and end-to-end deliberately:
// it proves the BUILT BINARY speaks HTTP a real server understands.
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

// WIRE SMOKE TEST (match --search). The text form's logic runs in process
// (packages/go/launcher/verbs/verbs_test.go); this proves the BUILT BINARY reaches the
// resource search over HTTP and reads the reply it sends.
func TestMatchSearchFindsResources(t *testing.T) {
	s := busScenario(t, `FAKERT_BUS_REPLY_match_resources_requested={"resources":[`+
		`{"@id":"res-7","name":"Acme MSA","entityTypes":["Contract"]}],`+
		`"total":1,"offset":0,"limit":5,"matchKind":"lexical"}`)
	stdout, stderr, code := s.run(t, "match", "--search", "indemnity", "--limit", "5")
	if code != 0 {
		t.Fatalf("match --search: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "table", stdout, "res-7", "Acme MSA", "1 shown, 1 total")
	b := lastEmit(t, s)
	mustContain(t, "emit", b, `"channel":"match:resources-requested"`, `"search":"indemnity"`, `"limit":5`, `"correlationId"`)
}

// WIRE SMOKE TEST (match, annotation form). End-to-end deliberately: it
// proves the BUILT BINARY speaks HTTP a real server understands.
func TestMatchGathersThenSearches(t *testing.T) {
	// match is TWO exchanges: the search requires a context payload, so a
	// gather must precede it — not an optimization, a precondition.
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_requested={"content":"surrounding text"}`,
		// The REAL shape: MatchSearchResult.response IS the candidate list,
		// not a guessed {"candidates":[…]} wrapper. A fake that encodes an
		// assumption tests the assumption.
		`FAKERT_BUS_REPLY_match_search_requested=[`+
			`{"@id":"res-7","name":"Acme MSA","score":0.91,"matchReason":"title match"},`+
			`{"@id":"res-8","name":"Side Letter","score":0.44}]`)
	stdout, stderr, code := s.run(t, "match", "res-1", "ann-1", "--limit", "5")
	if code != 0 {
		t.Fatalf("match: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "res-7", "Acme MSA", "0.910", "title match", "2 candidate(s)", "semiont bind res-1 ann-1")
	// Rendered as a table, not dumped: a raw-JSON fallback would mean the
	// parser did not understand the reply.
	if strings.Contains(stdout, `"@id":"res-7"`) {
		t.Errorf("match fell back to raw JSON — it could not parse the real reply:\n%s", stdout)
	}
	// The LAST emit is the search, carrying the gathered context and our flags.
	b := lastEmit(t, s)
	mustContain(t, "search emit", b,
		`"channel":"match:search-requested"`, `"referenceId":"ann-1"`,
		`"limit":5`, `"useSemanticScoring":true`, `"context"`)
}

// An emit reports how many subscribers it reached: the verb claims no
// delivery, and prints no bare ✓ over a signal that reached an empty room.
// Nothing is subscribed to beckon:focus in this scenario, and the gateway
// says so, so the honest line names that — the "no delivery confirmation"
// wording is reserved for the case where the count is genuinely unknown.
// WIRE SMOKE TEST (beckon). This family's logic runs in process against a
// fake transport (packages/go/launcher/verbs/verbs_test.go). This one stays end-to-end
// deliberately: it is the only thing proving the BUILT BINARY speaks HTTP a
// real server understands. A family tested only against a double can agree with
// a bug in our own client.
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
// WIRE SMOKE TEST. The verb's logic — one command per entity type, stop at the
// first rejection, refuse bad arguments — is specified in
// packages/go/launcher/verbs/frame_test.go, where it runs in process against a fake
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
	s := busScenario(t, `FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{"kind":"resource","resource":{"@context":"https://schema.org/","@id":"res-src","name":"Source","representations":[]}},"graph":{"nodes":[],"edges":[]}}`)
	stdout, stderr, code := s.run(t, "yield", "--delegate", "res-src",
		"--storage-uri", "file://generated/out.md", "--title", "Derived", "--task", "summary")
	if code != 0 {
		t.Fatalf("delegate: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Generating", "Generating resource", "res-new", "Generated")
	// The grounding gather names its traversal. Delegate has no flags for
	// these, and a zero-valued struct would ask the librarian for
	// maxResources 0 — forwarded to Qdrant as `limit: 0`, a 422 that kills
	// the delegate in the gather with a bare "Unprocessable Entity".
	var gather string
	for _, e := range emits(t, s) {
		if strings.Contains(e, `"channel":"gather:resource-requested"`) {
			gather = e
		}
	}
	mustContain(t, "gather emit", gather, `"resourceId":"res-src"`, `"depth":2`, `"maxResources":10`,
		`"includeContent":true`, `"includeSummary":true`)
	b := lastEmit(t, s)
	// The job is a yield job: what it is asked to make, and the gathered
	// context it is made from.
	mustContain(t, "job:create emit", b,
		`"channel":"job:create"`, `"jobType":"yield"`,
		`"storageUri":"file://generated/out.md"`, `"title":"Derived"`, `"task":"summary"`, `"context"`)
	// The dispatcher derives a yield job's resource from
	// params.context.focus, and neither the command nor its params has a
	// member for one. Sending either is an error, so assert their ABSENCE — a
	// payload that carries them would be refused by a real gateway while this
	// fake accepts it.
	for _, gone := range []string{`"resourceId"`, `"referenceId"`} {
		if strings.Contains(b, gone) {
			t.Errorf("job:create carries %s; the context's focus is authoritative:\n%s", gone, b)
		}
	}
}

func TestYieldDelegateReportsJobFailure(t *testing.T) {
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{"kind":"resource","resource":{"@context":"https://schema.org/","@id":"res-src","name":"Source","representations":[]}},"graph":{"nodes":[],"edges":[]}}`,
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
// The trap this guards is specific. A yield job's result is a generation or a
// decline with no discriminant between them, and every generated As*()
// accessor is a bare json.Unmarshal, so a declined result decodes CLEANLY into
// YieldJobDone with a zero-value resource id. A result is read by the
// members it carries: a decline carries `declined` and `reason`, and none of
// what a generation requires.
func TestYieldDelegateReportsADecline(t *testing.T) {
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{"kind":"resource","resource":{"@context":"https://schema.org/","@id":"res-src","name":"Source","representations":[]}},"graph":{"nodes":[],"edges":[]}}`,
		`FAKERT_JOB_RESULT={"declined":true,"reason":"encrypted"}`)
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

// A completion is its verb's by its jobType. A yield job whose completion
// names the other verb made nothing this command can read: it says what the
// job completed as and what it created, and fails.
func TestYieldDelegateRefusesACompletionOfAnotherVerb(t *testing.T) {
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{"kind":"resource","resource":{"@context":"https://schema.org/","@id":"res-src","name":"Source","representations":[]}},"graph":{"nodes":[],"edges":[]}}`,
		"FAKERT_JOB_COMPLETES_AS=mark", `FAKERT_JOB_RESULT={"found":2,"persisted":2}`)
	stdout, stderr, code := s.run(t, "yield", "--delegate", "res-src", "--storage-uri", "file://generated/out.md", "--title", "Derived")
	if code == 0 {
		t.Fatalf("a yield job that completed as a mark job must fail the command\nstdout:\n%s", stdout)
	}
	mustContain(t, "refusal", stderr, `yield --delegate: The job:complete of job fake-job-1 is a mark job's, and the job delegated is a yield job.`, "What the job did:  semiont browse res-src")
	if strings.Contains(stdout, "Yielded") {
		t.Errorf("claimed a yield that never happened:\n%s", stdout)
	}
}

// The exit code must not depend on the output format: --json prints the raw
// payload and still reports that nothing was produced.
func TestYieldDelegateDeclineFailsUnderJSON(t *testing.T) {
	s := busScenario(t,
		`FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{"kind":"resource","resource":{"@context":"https://schema.org/","@id":"res-src","name":"Source","representations":[]}},"graph":{"nodes":[],"edges":[]}}`,
		`FAKERT_JOB_RESULT={"declined":true,"reason":"no-text-layer"}`)
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
	s := busScenario(t, `FAKERT_BUS_REPLY_gather_resource_requested={"metadata":{},"focus":{"kind":"resource","resource":{"@context":"https://schema.org/","@id":"res-src","name":"Source","representations":[]}},"graph":{"nodes":[],"edges":[]}}`)
	stdout, stderr, code := s.run(t, "yield", "--delegate", "res-src", "--storage-uri", "file://generated/out.md", "--title", "Derived", "--json")
	if code != 0 {
		t.Fatalf("a completed generation under --json must exit 0, got %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "raw payload", stdout, `"resourceId":"res-new"`)
}

// GenerationJobParams requires title, as it requires storageUri. Refused
// HERE rather than letting the gateway reject the job: the caller has
// already paid for a gather by then.
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

// The delegated form of mark is yield --delegate's sibling: it creates a mark
// job whose parameters state its motivation, and follows it to its end. The
// stack's worker reads the resource and writes the annotations.
func TestMarkDelegateFollowsJobToCompletion(t *testing.T) {
	s := busScenario(t)

	stdout, stderr, code := s.run(t, "mark", "--delegate", "res-1", "--motivation", "highlighting",
		"--instructions", "key claims", "--density", "5")
	if code != 0 {
		t.Fatalf("mark --delegate: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Annotating res-1", "highlighting", "fake-job-1", "Analyzing text", "Created 3 highlights", "Marked res-1: created 3 highlights (4 found)")
	jobType, resourceID, params := jobCreate(t, lastEmit(t, s))
	if jobType != "mark" || resourceID != "res-1" {
		t.Errorf("job:create asks for a %q job on %q, want a mark job on res-1", jobType, resourceID)
	}
	if params["motivation"] != "highlighting" || params["instructions"] != "key claims" || params["density"] != float64(5) {
		t.Errorf("the job's params are %v, want the motivation, the instructions and a density of 5", params)
	}
	// A mark job's parameters are closed, and none of them names the resource:
	// the resource is the command's.
	if _, named := params["resourceId"]; named {
		t.Errorf("params names the resource, which the gateway refuses: %v", params)
	}

	// Linking: the entity types to detect, and descriptive references.
	stdout, stderr, code = s.run(t, "mark", "--delegate", "res-1", "--motivation", "linking",
		"--entity-type", "Person", "--entity-type", "Place", "--descriptive", "--source-language", "fr")
	if code != 0 {
		t.Fatalf("mark --delegate linking: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "stdout", stdout, "Created 4 references", "Marked res-1: created 4 references (5 found, 1 error)")
	jobType, _, params = jobCreate(t, lastEmit(t, s))
	if jobType != "mark" || params["motivation"] != "linking" {
		t.Errorf("linking asks for a %q job of the motivation %v, want a mark job of linking", jobType, params["motivation"])
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
	mustContain(t, "stdout", stdout, "Created 6 tags", "Marked res-1: created 6 tags (6 found): issue 2, rule 4")
	jobType, _, params = jobCreate(t, lastEmit(t, s))
	if jobType != "mark" || params["motivation"] != "tagging" || params["schemaId"] != "legal-irac" || fmt.Sprint(params["categories"]) != "[issue rule]" || params["language"] != "de" {
		t.Errorf("tagging asks for a %q job with params %v", jobType, params)
	}

	// --json prints the completion as the stack sent it, and still succeeds.
	stdout, stderr, code = s.run(t, "mark", "--delegate", "res-1", "--motivation", "commenting", "--tone", "scholarly", "--json")
	if code != 0 {
		t.Fatalf("mark --delegate --json: exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	mustContain(t, "raw completion", stdout, `"jobType":"mark"`, `"found":2`, `"persisted":2`)
	if _, _, params = jobCreate(t, lastEmit(t, s)); params["motivation"] != "commenting" || params["tone"] != "scholarly" {
		t.Errorf("the commenting job's params are %v, want the motivation and the tone", params)
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
	mustContain(t, "stdout", stdout, "created 3 highlights")
	if strings.Contains(stdout+stderr, "Annotation failed") {
		t.Errorf("a retried attempt was reported as the job's failure:\n%s", stdout+stderr)
	}
}

// A decline completes the job: the resource had no text to read. Nothing was
// annotated, so the command fails, in either output format, and does not call
// it a crash.
func TestMarkDelegateReportsADecline(t *testing.T) {
	s := busScenario(t, `FAKERT_JOB_RESULT={"declined":true,"reason":"no-text-layer"}`)
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

// A completion is its verb's by its jobType. A mark job whose completion names
// the other verb annotated nothing this command can count: it says what the
// job completed as and what it created, and fails.
func TestMarkDelegateRefusesACompletionOfAnotherVerb(t *testing.T) {
	s := busScenario(t, "FAKERT_JOB_COMPLETES_AS=yield")
	stdout, stderr, code := s.run(t, "mark", "--delegate", "res-1", "--motivation", "highlighting")
	if code == 0 {
		t.Fatalf("a mark job that completed as a yield job must fail the command\nstdout:\n%s", stdout)
	}
	mustContain(t, "refusal", stderr, `mark --delegate: The job:complete of job fake-job-1 is a yield job's, and the job delegated is a mark job.`, "What the job did:  semiont browse res-1 --annotations")
	if strings.Contains(stdout, "Marked") {
		t.Errorf("claimed a mark that never happened:\n%s", stdout)
	}
}

// A registry row whose directory vanished (a moved KB, a deleted trial root)
// is permanent listing noise unless something removes it — the same
// record-outlives-its-subject shape as a reaped codespace. forget drops
// exactly one row; it deletes no files and no stack state.
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
// <key>`, which would name the LIVE twin's state: the running stack's
// postgres.
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

// `semiont roots` owns the KNOWLEDGE BASES catalog, which is long enough to
// push stack health out of view; status keeps the section header, a count +
// pointer, and one contextual line when cwd is a DIFFERENT KB than the
// running stack's root.
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
			t.Errorf("status renders the catalog (%q):\n%s", leak, stdout)
		}
	}
}

// The one contextual fact status states itself: being inside one KB while
// the stack runs another is a real gotcha.
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

// --- the passwords of the daemons the launcher runs are the launcher's: it
// generates and keeps them, and resolves the config's reference for a daemon
// it does not run ---

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
	// Where KB skills are told to read it, roots/<key>/<name>: the layout is
	// a contract with them, so a move breaks this first.
	kept, err := os.ReadFile(filepath.Join(stateRootFor(s.home, testKBKey), "neo4j-password"))
	if err != nil || strings.TrimSpace(string(kept)) != graphPw {
		t.Errorf("roots/<key>/neo4j-password does not hold Neo4j's password (read %q, %v)", kept, err)
	}
	for _, svc := range []string{"librarian", "weaver"} {
		if v, _ := s.containerEnv(t, "semiont-"+svc, "NEO4J_PASSWORD"); v != graphPw {
			t.Errorf("%s reaches the graph but was handed NEO4J_PASSWORD=%q, want Neo4j's", svc, v)
		}
	}
	for _, svc := range []string{"archivist", "smelter"} {
		if _, handed := s.containerEnv(t, "semiont-"+svc, "NEO4J_PASSWORD"); handed {
			t.Errorf("the %s reaches no graph but was handed its password", svc)
		}
	}
	for _, doc := range []string{"librarian.json", "weaver.json"} {
		if staged := stagedFile(t, s, doc); !strings.Contains(staged, `"passwordEnv": "NEO4J_PASSWORD"`) || strings.Contains(staged, graphPw) {
			t.Errorf("the staged %s does not name NEO4J_PASSWORD, or states the password:\n%s", doc, staged)
		}
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
// two clients, each through the variables its document names. The broker holds
// the same pair as quoted strings of its config syntax, which is how it reads
// a variable's value (natsConfString).
func TestLauncherRunBrokerIsAuthenticated(t *testing.T) {
	s := newScenario(t, "container")
	editDocument(t, s, "knowledge-base.yaml", "signal: { type: in-process }", "signal: { type: nats }")
	if _, stderr, code := s.run(t, "start"); code != 0 {
		t.Fatalf("start: exit %d\n%s", code, stderr)
	}
	pw, _ := s.containerEnv(t, "semiont-dispatcher", "NATS_PASSWORD")
	if len(pw) < 32 {
		t.Fatalf("the dispatcher was not given a generated password: %q", pw)
	}
	mustContain(t, "argv log", s.argv(t), "-c /etc/nats/semiont.conf")
	for _, c := range []string{"semiont-dispatcher", "semiont-gateway"} {
		if u, _ := s.containerEnv(t, c, "NATS_USER"); u != "semiont" {
			t.Errorf("%s: NATS_USER=%q, want semiont", c, u)
		}
		if v, _ := s.containerEnv(t, c, "NATS_PASSWORD"); v != pw {
			t.Errorf("%s: NATS_PASSWORD=%q, want the dispatcher's", c, v)
		}
	}
	if u, _ := s.containerEnv(t, "semiont-nats", "NATS_USER"); u != `"semiont"` {
		t.Errorf(`semiont-nats: NATS_USER=%s, want "semiont" in its quotes`, u)
	}
	if v, _ := s.containerEnv(t, "semiont-nats", "NATS_PASSWORD"); v != `"`+pw+`"` {
		t.Errorf("semiont-nats: NATS_PASSWORD=%s, want the clients' password in quotes", v)
	}
	mustContain(t, "the dispatcher's document", stagedFile(t, s, "dispatcher.json"), `"passwordEnv": "NATS_PASSWORD"`)
	mustContain(t, "the gateway's document", stagedFile(t, s, "gateway.json"), `"passwordEnv": "NATS_PASSWORD"`)
}

// An exported daemon password is refused, not honoured — it would only
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
// launcher does not have (a config's literal, or custody lost): refuse, naming
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

// The daemon names are the launcher's: `semiont settings secret set` refuses
// them, as it refuses the other values custody owns.
func TestSecretSetRefusesADaemonPassword(t *testing.T) {
	s := newScenario(t, "container", "op")
	_, stderr, code := s.run(t, "settings", "secret", "set", "NEO4J_PASSWORD", "op://OSS/Neo4j/password")
	if code == 0 {
		t.Fatal("registered a source for a password the launcher generates")
	}
	mustContain(t, "stderr", stderr, "NEO4J_PASSWORD")
}

// The dispatcher's queue is JetStream: it holds no state tree for another
// driver to write, so a KnowledgeBase whose jobs select any other driver is
// refused at start, naming the driver it needs — before any container runs,
// rather than surfacing as a dispatcher that exits at boot and is given up on.
func TestStartRefusesAJobsDriverTheDispatcherCannotRun(t *testing.T) {
	s := newScenario(t, "container")
	editDocument(t, s, "knowledge-base.yaml", "jobs: { type: jetstream }", "jobs: { type: fs }")
	_, stderr, code := s.run(t, "start")
	if code == 0 {
		t.Fatalf("start accepted a jobs driver the dispatcher cannot run")
	}
	mustContain(t, "fs-jobs refusal", stderr, "dispatcher", "jetstream")
	if strings.Contains(s.argv(t), "run -d --name semiont-dispatcher") {
		t.Errorf("the dispatcher was started before the refusal")
	}
}

// A KnowledgeBase whose issuer is the Issuer document the launcher runs — the
// fixture's — boots Keycloak after PostgreSQL and before the gateway: its
// database created on that PostgreSQL if absent, the realm file staged and
// imported, the bootstrap admin password per root, and every service's
// staged document states the issuer.

// The identity path in PLAN mode: a golden for everything the
// launched-Keycloak path narrates — the realm document's clients, the
// database creation, and the service-account preflight — so the realm line
// cannot describe a document other than the one it writes.
func TestStartDryRunKeycloakIdentity(t *testing.T) {
	s := newScenario(t, "container")
	stdout, stderr, code := s.run(t, "start", "--dry-run")
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
	if _, stderr, code := s.run(t, "start"); code != 0 {
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

// externalIssuer: the fixture's KnowledgeBase trusting an issuer on a host the
// launcher does NOT run — `oidc`, the bring-your-own-IdP shape — with no
// Issuer document.
func externalIssuer(t *testing.T, s *scenario) {
	t.Helper()
	editDocument(t, s, "knowledge-base.yaml",
		"    ref: issuer\n", "    external: { type: oidc, url: \"https://id.example.com/realms/semiont\" }\n")
	if err := os.Remove(filepath.Join(s.kb, ".semiont", "stack", "issuer.yaml")); err != nil {
		t.Fatal(err)
	}
}

// An issuer someone else runs gets the SAME preflight as one the launcher
// starts — and needs it more. A launcher-run realm is imported from the
// launcher's own document and is correct by construction; an external one had
// its clients created by hand.
//
// Verifying TCP reachability alone would let a realm missing every service
// account — or one nobody can sign in to — start nine containers happily.
// Reachability is not configuration.
func TestStartDryRunExternalIssuerIsPreflighted(t *testing.T) {
	s := newScenario(t, "container")
	externalIssuer(t, s)
	stdout, stderr, code := s.run(t, "start", "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run: exit %d\nstderr:\n%s", code, stderr)
	}
	const iss = "https://id.example.com/realms/semiont"
	mustContain(t, "plan", stdout,
		// the six machine identities, against the CONFIGURED issuer rather
		// than identityEndpoint's localhost form
		"client-credentials grant at "+iss+" as semiont-gateway",
		"client-credentials grant at "+iss+" as semiont-worker-local, by an assertion signed with the machine's worker key",
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

// `start --service <role>` dispatches to the same per-role flow a full start
// uses: flowOneService and flowFullStart both reach a dependency role through
// flowDepRole. Two implementations of one launch drift, and a drift here is
// a container that runs with different arguments depending on which verb
// started it.
//
// The full start's dry-run is the argv every role's launch is pinned to.
// This requires the single-service dry-run to produce the SAME line.
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
