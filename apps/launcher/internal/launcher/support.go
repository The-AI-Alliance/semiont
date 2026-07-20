package launcher

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// --- Output helpers (ported from the scripts' log/ok/warn/fail/banner) ---
//
// One deviation from bash: color only when stdout is a terminal, so piped
// output and the --dry-run seam stay machine-clean.

const (
	ansiBold    = "\033[1m"
	ansiDim     = "\033[2m"
	ansiGreen   = "\033[0;32m"
	ansiCyan    = "\033[0;36m"
	ansiYellow  = "\033[0;33m"
	ansiRed     = "\033[0;31m"
	ansiMagenta = "\033[0;35m"
	ansiReset   = "\033[0m"
)

type ui struct {
	quiet bool
	color bool
}

func newUI(quiet bool) *ui {
	fi, err := os.Stdout.Stat()
	return &ui{quiet: quiet, color: err == nil && fi.Mode()&os.ModeCharDevice != 0}
}

func (u *ui) wrap(code, s string) string {
	if !u.color {
		return s
	}
	return code + s + ansiReset
}

func (u *ui) bold(s string) string { return u.wrap(ansiBold, s) }
func (u *ui) dim(s string) string  { return u.wrap(ansiDim, s) }

func (u *ui) log(format string, a ...any) {
	if u.quiet {
		return
	}
	fmt.Printf("%s %s\n", u.wrap(ansiCyan, "▸"), fmt.Sprintf(format, a...))
}

func (u *ui) ok(format string, a ...any) {
	if u.quiet {
		return
	}
	fmt.Printf("%s %s\n", u.wrap(ansiGreen, "✓"), fmt.Sprintf(format, a...))
}

func (u *ui) warn(format string, a ...any) {
	fmt.Printf("%s  %s\n", u.wrap(ansiYellow, "⚠️"), fmt.Sprintf(format, a...))
}

func (u *ui) fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "%s %s\n", u.wrap(ansiRed, "✗"), fmt.Sprintf(format, a...))
}

func (u *ui) banner(s string) {
	if u.quiet {
		return
	}
	fmt.Printf("\n%s\n", u.bold(s))
}

func (u *ui) stamp(event string) {
	fmt.Println(u.dim(fmt.Sprintf("[%s] %s", time.Now().Format("2006-01-02 15:04:05"), event)))
}

// echoEnvAllowlist: the --env values safe to show in echoed commands. Names
// off this list — the worker secret and every user-supplied config var (API
// keys) — are redacted in the ECHO ONLY; the real argv is untouched.
// Terminal scrollback and CI logs are not places for credentials. (Infra
// `-e` values like NEO4J_AUTH=neo4j/localpass stay visible: fixed,
// well-known local-dev values the summary table prints anyway.)
var echoEnvAllowlist = map[string]bool{
	"BACKEND_HOST": true, "NEO4J_HOST": true, "QDRANT_HOST": true,
	"OLLAMA_HOST": true, "POSTGRES_HOST": true,
	"OTEL_EXPORTER_OTLP_ENDPOINT": true,
}

// redactEnvArgs also redacts the value after a bare --password flag — the
// useradd exec bridge carries one in its echoed argv.
func redactEnvArgs(args []string) []string {
	out := make([]string, len(args))
	copy(out, args)
	for i := 0; i < len(out)-1; i++ {
		if out[i] == "--password" {
			out[i+1] = "<redacted>"
			continue
		}
		if out[i] != "--env" {
			continue
		}
		if name, _, ok := strings.Cut(out[i+1], "="); ok && !echoEnvAllowlist[name] {
			out[i+1] = name + "=<redacted>"
		}
	}
	return out
}

// echoCmd mirrors the scripts' run_cmd prefix: show the exact command before
// running it (the in-terminal legibility half of the --dry-run story) —
// minus secret env values.
func (u *ui) echoCmd(name string, args ...string) {
	if u.quiet {
		return
	}
	fmt.Printf("  %s\n", u.dim("$ "+name+" "+strings.Join(redactEnvArgs(args), " ")))
}

// --- Subprocess helpers ---

// runPassthrough runs a command with stdout shown and stderr discarded,
// ignoring failure — the scripts' `cmd 2>/dev/null || true` shape used for
// idempotent stop/rm.
func runPassthrough(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, io.Discard
	_ = cmd.Run()
}

// runSilent runs a command with all output discarded, returning its error —
// the probe shape (`cmd > /dev/null 2>&1`).
func runSilent(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	return cmd.Run()
}

// runVisible runs a command with stdout and stderr shown (image pulls).
func runVisible(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

// runDetached runs a `run -d` service start: stdout — the container
// identifier the runtime prints — is captured and returned (recorded in
// stack.json); stderr stays visible so a failed start is diagnosable.
func runDetached(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, os.Stderr
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

// runWithStdin feeds input on stdin and shows stderr — for handing a secret
// value to a subprocess without it ever appearing in argv (where any process
// on the machine could read it via ps).
func runWithStdin(name, input string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(input)
	cmd.Stdout, cmd.Stderr = io.Discard, os.Stderr
	return cmd.Run()
}

// capture runs a command returning trimmed stdout, stderr discarded.
func capture(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, io.Discard
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

// --- Runtime selection ---

// runtimeOrder is the auto-detect order; on a Mac with several installed,
// Apple `container` wins. "codespace" is a placement value, never
// auto-detected and never sticky — it dispatches before selection, and its
// stacks live under their own keys in the record set.
var runtimeOrder = []string{"container", "docker", "podman"}

func onPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func installedRuntimes() []string {
	var found []string
	for _, rt := range runtimeOrder {
		if onPath(rt) {
			found = append(found, rt)
		}
	}
	return found
}

// selectRuntime validates an explicit --runtime, or auto-detects first-found.
func selectRuntime(u *ui, requested string) (string, bool) {
	if requested != "" {
		switch requested {
		case "container", "docker", "podman":
		default:
			u.fail("Unknown --runtime '%s' (expected: container, docker, or podman)", requested)
			return "", false
		}
		if !onPath(requested) {
			u.fail("--runtime %s requested, but '%s' is not on PATH.", requested, requested)
			return "", false
		}
		return requested, true
	}
	if found := installedRuntimes(); len(found) > 0 {
		return found[0], true
	}
	u.fail("No container runtime found. Install Apple Container, Docker, or Podman.")
	return "", false
}

// --- Health waits ---

var healthClient = &http.Client{Timeout: 2 * time.Second}

// netDialTimeout: one TCP reachability check (external-role verification).
func netDialTimeout(addr string) (net.Conn, error) {
	return net.DialTimeout("tcp", addr, 3*time.Second)
}

func httpOK(url string) bool {
	resp, err := healthClient.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// took renders a wait duration for the ✓ lines.
func took(d time.Duration) string {
	if d < time.Second {
		return "<1s"
	}
	return fmt.Sprintf("%ds", int(d.Round(time.Second).Seconds()))
}

// waitForHTTP polls until a URL returns 2xx, one attempt per second,
// reporting how long readiness took.
func waitForHTTP(u *ui, name, url string, tries int) (time.Duration, bool) {
	t0 := time.Now()
	for i := 0; i < tries; i++ {
		if httpOK(url) {
			return time.Since(t0), true
		}
		time.Sleep(time.Second)
	}
	u.fail("%s did not become ready at %s within %ds.", name, url, tries)
	return time.Since(t0), false
}

// waitForPG waits for Postgres in two phases. Phase 1 polls the published
// port from the host — no container spawn per attempt (the old pg_isready-in-
// a-container loop cost a fresh VM per attempt under Apple Container).
// Port-open implies ready with the official postgres image: its init-time
// temporary server listens on the unix socket only, so TCP 5432 opens only
// when the real server is up. Phase 2 is a single container-side probe
// confirming the gateway path the services actually dial.
func waitForPG(u *ui, rt, host string, port, tries int) (time.Duration, bool) {
	t0 := time.Now()
	up := false
	for i := 0; i < tries; i++ {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", port), time.Second)
		if err == nil {
			conn.Close()
			up = true
			break
		}
		time.Sleep(time.Second)
	}
	if !up {
		u.fail("PostgreSQL did not open port %d within %ds.", port, tries)
		return time.Since(t0), false
	}
	if runSilent(rt, "run", "--rm", "busybox:1.38.0", "nc", "-z", "-w", "2", host, fmt.Sprintf("%d", port)) != nil {
		u.fail("PostgreSQL is up on localhost:%d but not reachable from containers at %s:%d.", port, host, port)
		return time.Since(t0), false
	}
	return time.Since(t0), true
}
