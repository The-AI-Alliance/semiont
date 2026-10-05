// fakert is the hermetic test double for every external command the launcher
// runs: the container runtimes (container / docker / podman), git, gh and op,
// and what the launcher asks about ports and processes — lsof, ps and pgrep, or
// netstat and tasklist on Windows. The test harness puts this one binary
// under each of those names on a private PATH — tests never touch a real
// runtime (mutating commands are never test-run; this binary exists so that
// rule can hold).
//
// Behavior is scripted through FAKERT_* environment variables set per test:
//
//	FAKERT_LOG               append-one-line-per-invocation argv log (the golden seam)
//	FAKERT_DIR               scratch dir for serve pidfiles
//	FAKERT_GIT_ROOT          `git rev-parse --show-toplevel` output; unset = not a repo
//	FAKERT_LSOF_<port>       newline-separated PIDs "holding" the port, for lsof
//	                         and for netstat; UNSET = answer for real, because
//	                         a fake that calls a truly-held port "free" hides
//	                         real bugs
//	FAKERT_PS_<pid>          what a PID runs, for ps and for tasklist
//	                         (default "fakeproc")
//	FAKERT_NSLOOKUP          "ok" makes the host-alias probe succeed
//	FAKERT_GATEWAY           default-gateway probe output (default 192.168.64.1)
//	FAKERT_OLLAMA_REACHABLE  "1" makes the busybox wget probe of :11434 succeed
//	FAKERT_OLLAMA_TAGS       models the fake Ollama already has (comma separated)
//	FAKERT_OLLAMA_UNLISTABLE  /api/tags fails — "unknown", which must not pull
//	FAKERT_OLLAMA_PULL_FAILS  /api/pull answers with an error
//	FAKERT_SKIP_SERVE        host ports to leave unbound (crashed-after-start containers)
//	FAKERT_RUN_HOLD          a container name, whose `run -d` parks, or a codespace name, whose
//	                         `semiont start` over ssh parks, until FAKERT_DIR/release-<name> exists,
//	                         after writing FAKERT_DIR/holding-<name> — a start held mid-flight
//	FAKERT_REMOTE_STACK_READY_AFTER  the nth ssh stack-readiness probe is the first to answer READY,
//	                         while the codespace's gateway already answers through its forward
//	FAKERT_BUSYBOX_FAIL_FIRST  the first n busybox probe containers fail with a runtime error
//	                         while the daemon answers — docker-in-docker just after dockerd starts
//	FAKERT_GATEWAY_UNREACHABLE  "1" fails the busybox wget probe of :4000
//	FAKERT_NC_FAIL           "1" fails the busybox `nc -z` postgres probe
//	FAKERT_VOLUME_ABSENT     "1" makes `volume rm` fail (volume not found)
//	FAKERT_STACK_RUNTIME     which runtime's list/ps shows semiont-gateway
//	FAKERT_PULL_FAIL         substring; pulls of matching images fail
//	FAKERT_DAEMON_DOWN       "1": every runtime command fails XPC-style;
//	                         `container system status` reports the apiserver down
//
// A detached `run -d ... -p A:B` spawns this binary in __serve mode listening
// on every published host port: it answers the routes that container serves,
// 404s the rest, and satisfies plain TCP dials — that is how health gates open
// without a real stack.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/images"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "__serve" {
		serveDetached(os.Args[2], os.Args[3], os.Args[4:])
		return
	}
	// The name it was started by: on Windows a program on PATH is a file
	// ending in .exe, and the name is what comes before it.
	base := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	logArgv(base, os.Args[1:])
	switch base {
	case "git":
		git(os.Args[1:])
	case "lsof":
		lsof(os.Args[1:])
	case "ps":
		psCmd(os.Args[1:])
	case "netstat":
		netstat(os.Args[1:])
	case "tasklist":
		tasklist(os.Args[1:])
	case "pgrep":
		os.Exit(1)
	case "op":
		opCmd(os.Args[1:])
	case "gh":
		ghCmd(os.Args[1:])
	case "container", "docker", "podman":
		runtimeCmd(base, os.Args[1:])
	default:
		fmt.Fprintf(os.Stderr, "fakert: unknown persona %q\n", base)
		os.Exit(64)
	}
}

func logArgv(base string, args []string) {
	path := os.Getenv("FAKERT_LOG")
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, base+" "+strings.Join(args, " "))
}

func git(args []string) {
	// Accept the -C <dir> form; behavior is driven by FAKERT_GIT_ROOT alone.
	if len(args) >= 2 && args[0] == "-C" {
		args = args[2:]
	}
	if len(args) >= 2 && args[0] == "rev-parse" && args[1] == "--show-toplevel" {
		root := os.Getenv("FAKERT_GIT_ROOT")
		if root == "" {
			fmt.Fprintln(os.Stderr, "fatal: not a git repository (or any of the parent directories): .git")
			os.Exit(128)
		}
		fmt.Println(root)
		return
	}
	if len(args) >= 3 && args[0] == "remote" && args[1] == "get-url" && args[2] == "origin" {
		if o := os.Getenv("FAKERT_GIT_ORIGIN"); o != "" {
			fmt.Println(o)
			return
		}
		fmt.Fprintln(os.Stderr, "error: No such remote 'origin'")
		os.Exit(2)
	}
	if len(args) >= 1 && args[0] == "clone" {
		// The template-copy URL path: materialize FAKERT_TEMPLATE_DIR at the
		// destination, standing in for a shallow clone.
		dst := args[len(args)-1]
		srcDir := os.Getenv("FAKERT_TEMPLATE_DIR")
		if srcDir == "" {
			fmt.Fprintln(os.Stderr, "fakert git clone: FAKERT_TEMPLATE_DIR not set")
			os.Exit(1)
		}
		if err := copyTree(srcDir, dst); err != nil {
			fmt.Fprintln(os.Stderr, "fakert git clone:", err)
			os.Exit(1)
		}
		return
	}
	if len(args) >= 1 && (args[0] == "init" || args[0] == "add") {
		// The birth flow (semiont init): idempotent no-ops here — the argv
		// log is the observable.
		return
	}
	if len(args) >= 2 && args[0] == "status" && args[1] == "--porcelain" {
		if os.Getenv("FAKERT_GIT_DIRTY") != "" {
			fmt.Println(" M .semiont/semiontconfig/anthropic.toml")
		}
		return
	}
	fmt.Fprintf(os.Stderr, "fakert git: unscripted args %v\n", args)
	os.Exit(64)
}

// remoteDown reports whether the codespace's KB is still unreachable. With
// FAKERT_REMOTE_READY_AFTER=n the nth readiness probe is the first to succeed,
// so a test can model a stack that comes up partway through the wait.
func remoteDown() bool {
	if os.Getenv("FAKERT_REMOTE_DOWN") != "" {
		return true
	}
	after := os.Getenv("FAKERT_REMOTE_READY_AFTER")
	if after == "" {
		return false
	}
	n, err := strconv.Atoi(after)
	if err != nil {
		return false
	}
	return remoteProbeCount() < n
}

// remoteProbeCount reads the readiness-probe tally without incrementing it.
func remoteProbeCount() int {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return 0
	}
	b, err := os.ReadFile(filepath.Join(dir, "remote-probes"))
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

// bumpRemoteProbe records one readiness probe — an ssh probe or a forward
// attempt — and returns the new tally.
func bumpRemoteProbe() int {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return 0
	}
	n := remoteProbeCount() + 1
	_ = os.WriteFile(filepath.Join(dir, "remote-probes"), []byte(strconv.Itoa(n)), 0o644)
	return n
}

// sshFailFirst is how many leading ssh attempts fail: sshd arriving late on a
// fresh create.
func sshFailFirst() int {
	n, _ := strconv.Atoi(os.Getenv("FAKERT_GH_SSH_FAIL_FIRST"))
	return n
}

// bumpCounter increments a named per-test counter and returns the new value.
func bumpCounter(name string) int {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return 0
	}
	p := filepath.Join(dir, name)
	b, _ := os.ReadFile(p)
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	n++
	_ = os.WriteFile(p, []byte(strconv.Itoa(n)), 0o644)
	return n
}

// forwardLocalPort digs the LOCAL port out of `A:B` (real gh listens on B).
func forwardLocalPort(args []string) string {
	for _, a := range args {
		if pair := strings.SplitN(a, ":", 2); len(pair) == 2 {
			if _, err := strconv.Atoi(pair[1]); err == nil {
				return pair[1]
			}
		}
	}
	return "0"
}

// forwardRemotePort: A in `codespace ports forward A:B`.
func forwardRemotePort(args []string) string {
	for _, a := range args {
		if pair := strings.SplitN(a, ":", 2); len(pair) == 2 {
			if _, err := strconv.Atoi(pair[1]); err == nil {
				return pair[0]
			}
		}
	}
	return "0"
}

// codespaceArg: the -c <name> a gh codespace command targets.
func codespaceArg(args []string) string {
	for i, a := range args {
		if a == "-c" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// codespaceKeycloakPort: the port a codespace's Keycloak is on — where an ssh
// rerun moved it, else where it started.
func codespaceKeycloakPort(name string) string {
	if dir := os.Getenv("FAKERT_DIR"); dir != "" {
		if b, err := os.ReadFile(filepath.Join(dir, "cs-keycloak-port-"+name)); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	if p := os.Getenv("FAKERT_GH_CS_KEYCLOAK_PORT"); p != "" {
		return p
	}
	return "8080"
}

// ghCmd fakes the GitHub CLI for the codespace flows. Scripted via:
//
//	FAKERT_GH_SCOPES        auth-status scopes list (default "'codespace', 'repo'")
//	FAKERT_GH_AUTH_FAIL     `gh auth status` fails (not logged in)
//	FAKERT_GH_SECRET_404    the ANTHROPIC_API_KEY secret does not exist
//	FAKERT_GH_SECRET_REPOS  JSON body for …/secrets/…/repositories (default: empty selection)
//	FAKERT_GH_CS_LIST       JSON array for `codespace list` (default [])
//	FAKERT_GH_CS_NAME       name printed by `codespace create` (default "fake-cs-1")
//	FAKERT_GH_CREATE_FAILS  N leading 503 failures before create succeeds (cursor file)
//	FAKERT_GH_SSH_FAIL      ssh fails with the no-sshd error
//	FAKERT_GH_SSH_FAIL_FIRST  ssh fails for the first n attempts, then works
//	FAKERT_GH_HOOKS_FAIL    the devcontainer lifecycle command fails (stack never comes up)
//	FAKERT_GH_KBCONFIG      .semiont/config content for `ssh -- cat .semiont/config`
//	FAKERT_GH_CS_SHUTTING_DOWN_LISTS  the first n `codespace list` calls report a Shutdown
//	                        codespace as ShuttingDown — a stop GitHub has not finished
//	FAKERT_GH_CS_KEYCLOAK_PORT  the port the codespace's Keycloak starts on (default 8080;
//	                        an ssh `KEYCLOAK_PORT=<n> semiont start` moves it)
//	FAKERT_GH_CS_ISSUER     an issuer the codespace does NOT run, advertised instead
func ghCmd(args []string) {
	joined := strings.Join(args, " ")
	switch {
	case len(args) >= 2 && args[0] == "auth" && args[1] == "status":
		if os.Getenv("FAKERT_GH_AUTH_FAIL") != "" {
			fmt.Fprintln(os.Stderr, "You are not logged into any GitHub hosts.")
			os.Exit(1)
		}
		scopes := os.Getenv("FAKERT_GH_SCOPES")
		if scopes == "" {
			scopes = "'codespace', 'repo'"
		}
		fmt.Println("github.com")
		fmt.Println("  ✓ Logged in to github.com")
		fmt.Println("  - Token scopes: " + scopes)
	case len(args) >= 2 && args[0] == "api" && strings.Contains(args[1], "/codespaces/machines"):
		// Shape mirrors the real endpoint. The default is what a
		// hostRequirements-declaring KB actually offers: GitHub filters the
		// 2-core class out.
		body := os.Getenv("FAKERT_GH_MACHINES")
		switch body {
		case "ERROR":
			fmt.Fprintln(os.Stderr, "gh: Not Found (HTTP 404)")
			os.Exit(1)
		case "":
			body = `{"machines":[` +
				`{"name":"standardLinux32gb","display_name":"4 cores, 16 GB RAM, 32 GB storage","cpus":4,"memory_in_bytes":17179869184},` +
				`{"name":"premiumLinux","display_name":"8 cores, 32 GB RAM, 64 GB storage","cpus":8,"memory_in_bytes":34359738368},` +
				`{"name":"largePremiumLinux","display_name":"16 cores, 64 GB RAM, 128 GB storage","cpus":16,"memory_in_bytes":68719476736}],"total_count":3}`
		}
		fmt.Println(body)
	case len(args) >= 3 && args[0] == "api" && args[1] == "user" && args[2] == "--jq":
		if os.Getenv("FAKERT_GH_UNAUTH") != "" {
			fmt.Fprintln(os.Stderr, "gh: To get started with GitHub CLI, please run:  gh auth login")
			os.Exit(4)
		}
		fmt.Println("fakeuser")
	case len(args) >= 2 && args[0] == "api" && strings.Contains(args[1], "/settings/billing/usage"):
		// The usage report `status --billing` shows, shaped exactly like
		// the real endpoint's: month buckets, per-repo (bare name),
		// quota-as-discount, and a non-codespaces product that must be
		// filtered out.
		if os.Getenv("FAKERT_GH_BILLING_NOSCOPE") != "" {
			fmt.Fprintln(os.Stderr, "gh: This API operation needs the \"user\" scope (HTTP 403)")
			os.Exit(1)
		}
		body := os.Getenv("FAKERT_GH_BILLING")
		if body == "" {
			body = `{"usageItems":[` +
				`{"date":"2026-01-01T00:00:00Z","product":"codespaces","sku":"Codespaces compute 8-core","quantity":44.29,"unitType":"Hours","grossAmount":31.89,"discountAmount":16.2,"netAmount":15.69,"repositoryName":"semiont"},` +
				`{"date":"2026-01-01T00:00:00Z","product":"codespaces","sku":"Codespaces storage","quantity":7.71,"unitType":"GigabyteHours","grossAmount":0.54,"discountAmount":0.54,"netAmount":0.0,"repositoryName":"semiont"},` +
				`{"date":"2026-07-01T00:00:00Z","product":"codespaces","sku":"Codespaces compute 8-core","quantity":4.03,"unitType":"Hours","grossAmount":2.90,"discountAmount":2.90,"netAmount":0.0,"repositoryName":"semiont-template-kb"},` +
				`{"date":"2026-07-01T00:00:00Z","product":"copilot","sku":"Copilot Cloud Agent","quantity":18.0,"unitType":"Requests","grossAmount":0.72,"discountAmount":0.72,"netAmount":0.0,"repositoryName":""}]}`
		}
		fmt.Println(body)
	case len(args) >= 2 && args[0] == "api" && args[1] == "/user/codespaces":
		// The cost-facts endpoint, which status and the start summary
		// read: machine size, last_used_at (= when last STARTED), retention
		// expiry, idle timeout. Every fake codespace reports the same
		// premiumLinux shape; last_used_at is 2h30s before the call so
		// "up 2h" renders deterministically (the 30s absorbs test runtime).
		var entries []string
		for _, cs := range createdCodespaceNames() {
			entries = append(entries, `{"name":"`+cs+`","machine":{"name":"premiumLinux","cpus":8,"memory_in_bytes":34359738368},`+
				`"last_used_at":"`+time.Now().UTC().Add(-2*time.Hour-30*time.Second).Format(time.RFC3339)+`",`+
				`"retention_expires_at":"2026-08-19T14:59:00Z","idle_timeout_minutes":60}`)
		}
		fmt.Println(`{"codespaces":[` + strings.Join(entries, ",") + `]}`)
	case len(args) >= 2 && args[0] == "api" && strings.Contains(args[1], "/codespaces/secrets/"):
		if os.Getenv("FAKERT_GH_SECRET_404") != "" {
			fmt.Fprintln(os.Stderr, "gh: Not Found (HTTP 404)")
			os.Exit(1)
		}
		body := os.Getenv("FAKERT_GH_SECRET_REPOS")
		if body == "" {
			body = `{"total_count":0,"repositories":[]}`
		}
		fmt.Println(body)
	case len(args) >= 2 && args[0] == "secret" && args[1] == "set":
		// gh reads the value from stdin when --body is absent. Record it so
		// tests can assert the secret travelled by stdin, never argv.
		val, _ := io.ReadAll(os.Stdin)
		if dir := os.Getenv("FAKERT_DIR"); dir != "" {
			_ = os.WriteFile(filepath.Join(dir, "secret-set-stdin"), val, 0o600)
		}
		if os.Getenv("FAKERT_GH_SECRET_SET_FAIL") != "" {
			fmt.Fprintln(os.Stderr, "gh: HTTP 403 (missing scope)")
			os.Exit(1)
		}
	case args[0] == "codespace":
		ghCodespace(args[1:], joined)
	default:
		fmt.Fprintf(os.Stderr, "fakert gh: unscripted args %v\n", args)
		os.Exit(64)
	}
}

func ghCodespace(args []string, joined string) {
	switch args[0] {
	case "list":
		// Explicit scripting wins; otherwise reflect what THIS fake has
		// created, as real gh would — a created codespace must show up
		// (and reach Available) or callers that wait for it hang.
		body := os.Getenv("FAKERT_GH_CS_LIST")
		if body == "" {
			body = "[" + strings.Join(createdCodespaces(), ",") + "]"
		}
		// A stop GitHub has not finished: Shutdown reads as ShuttingDown for
		// the first n lists, the state a start right after a stop meets.
		if n, _ := strconv.Atoi(os.Getenv("FAKERT_GH_CS_SHUTTING_DOWN_LISTS")); n > 0 && bumpCounter("cs-list-count") <= n {
			body = strings.ReplaceAll(body, `"state":"Shutdown"`, `"state":"ShuttingDown"`)
		}
		fmt.Println(applyStateEvents(body))
	case "create":
		if n := os.Getenv("FAKERT_GH_CREATE_FAILS"); n != "" {
			// Countdown via cursor file: each failing attempt burns one.
			f := filepath.Join(os.Getenv("FAKERT_DIR"), "gh-create-fails")
			left, _ := strconv.Atoi(n)
			if b, err := os.ReadFile(f); err == nil {
				left, _ = strconv.Atoi(strings.TrimSpace(string(b)))
			}
			if left > 0 {
				_ = os.WriteFile(f, []byte(strconv.Itoa(left-1)), 0o644)
				fmt.Fprintln(os.Stderr, "HTTP 503: No server is currently available (https://api.github.com/user/codespaces)")
				os.Exit(1)
			}
		}
		name := os.Getenv("FAKERT_GH_CS_NAME")
		if name == "" {
			name = "fake-cs-1"
		}
		repo := ""
		for i, a := range args {
			if a == "--repo" && i+1 < len(args) {
				repo = args[i+1]
			}
		}
		recordCreated(name, repo)
		fmt.Println(name)
	case "ports":
		// forward: bind host ports, park like a dev tunnel. Pidfile so the
		// harness's killServes reaps the parked process between tests.
		// Real gh takes <codespacePort>:<localPort> and listens on the
		// LOCAL one; the fake does too, so a launcher that reverses the
		// pair fails here.
		//
		// FAKERT_GH_FORWARD_SICK: the tunnel is bound but the stack behind
		// it answers 503 (gateway still warming). FAKERT_GH_FORWARD_DIES_
		// AFTER_MS: the forward process exits after that delay — a forward
		// that dies mid-wait while the KB is healthy in the codespace.
		if ms := os.Getenv("FAKERT_GH_FORWARD_DIES_AFTER_MS"); ms != "" {
			if n, err := strconv.Atoi(ms); err == nil {
				go func() {
					time.Sleep(time.Duration(n) * time.Millisecond)
					os.Exit(1)
				}()
			}
		}
		// FAKERT_REMOTE_DOWN / FAKERT_REMOTE_READY_AFTER: the REMOTE side is
		// not listening yet. A real `gh codespace ports forward` binds locally
		// straight away, then EXITS the first time a local connection cannot
		// be opened through to the remote port —
		//
		//   ssh: rejected: connect failed (Connection refused)
		//
		// so any probe through the tunnel while the stack is still coming up
		// destroys the tunnel. A fake that bound and parked unconditionally
		// would have every test agree a forward that binds is a forward that
		// works.
		// A forward attempt is a readiness probe too — the launcher may have no
		// ssh to ask, and then this is the ONLY way it can learn the stack is
		// up. Counting only ssh probes would leave a stack that comes up "after
		// n probes" unreachable on that path, with the retry loop running
		// forever.
		bumpRemoteProbe()
		if remoteDown() {
			// The pidfile is what makes the fake `ps` report this process as
			// "gh", which forwardProcAlive requires — without it the launcher
			// calls a live tunnel dead and never dials, so the death-on-first-
			// contact this branch exists to model never happens.
			if dir := os.Getenv("FAKERT_DIR"); dir != "" {
				_ = os.WriteFile(filepath.Join(dir, "serve-gh-forward-"+forwardLocalPort(args)+".pid"),
					[]byte(strconv.Itoa(os.Getpid())+"\n"+forwardLocalPort(args)), 0o644)
			}
			go func() {
				ln, err := net.Listen("tcp", "127.0.0.1:"+forwardLocalPort(args))
				if err != nil {
					os.Exit(1)
				}
				c, err := ln.Accept() // the first probe is the fatal one
				if err == nil {
					c.Close()
				}
				fmt.Fprintln(os.Stderr, "error connecting to tunnel: connect to forwarded port failed: "+
					"error connecting to forwarded port: failed to open streaming channel: "+
					"failed to open port forward channel: failed to open channel: "+
					"ssh: rejected: connect failed (Connection refused)")
				os.Exit(1)
			}()
			select {} // park until that goroutine exits the process
		}
		if os.Getenv("FAKERT_GH_FORWARD_SICK") != "" {
			// Scoped to THIS process: __serve children of `run -d` never
			// see it, so container health fakes stay healthy.
			os.Setenv("FAKERT_SERVE_SICK", "1")
		}
		var ports []string
		for _, a := range args {
			if pair := strings.SplitN(a, ":", 2); len(pair) == 2 {
				if _, err := strconv.Atoi(pair[1]); err == nil {
					ports = append(ports, pair[1])
				}
			}
		}
		// Pidfile per forward (keyed by local port): several forwards run
		// concurrently — one per codespace stack's KB.
		if dir := os.Getenv("FAKERT_DIR"); dir != "" && len(ports) > 0 {
			// pid, then the ports it holds, as `run -d` records them, so a
			// cleanup waits for the ports as well as killing the process.
			_ = os.WriteFile(filepath.Join(dir, "serve-gh-forward-"+ports[0]+".pid"),
				[]byte(strconv.Itoa(os.Getpid())+"\n"+strings.Join(ports, " ")), 0o644)
		}
		// A codespace forward carries the KB's GATEWAY, so it serves the
		// gateway's routes — the forward is a tunnel, not a service. Any
		// other remote port is the issuer: each KB's Keycloak has a port
		// of its own, forwarded with the same number on both ends.
		if forwardRemotePort(args) != "4000" {
			serve("semiont-keycloak", ports)
			return
		}
		// The gateway advertises the issuer the codespace runs:
		// keycloak.localhost on the port its Keycloak is on — never this
		// tunnel's own origin, which is where the local fake serves its realm.
		issuer := os.Getenv("FAKERT_GH_CS_ISSUER")
		if issuer == "" {
			issuer = "http://keycloak.localhost:" + codespaceKeycloakPort(codespaceArg(args)) + "/realms/semiont"
		}
		os.Setenv("FAKERT_ADVERTISED_ISSUER", issuer)
		serve("semiont-gateway", ports)
	case "logs":
		// The creation-log follower the health wait tails. A few plausible
		// lines, then exit — a tailer that ends early is legal (the launcher
		// treats the stream as decoration, never a gate).
		fmt.Println("2026-01-01 00:00:00.000Z: Running onCreateCommand...")
		fmt.Println("2026-01-01 00:00:01.000Z: Pulling semiont-gateway:latest")
		// FAKERT_GH_HOOKS_FAIL: the devcontainer's lifecycle command failed —
		// the stack will never come up, so waiting is pointless. Shaped like
		// a real creation log: the CAUSE (a service refusing to boot)
		// several lines above the devcontainer's own announcement, which is
		// why the launcher must print the run-up and not just the marker.
		if os.Getenv("FAKERT_GH_HOOKS_FAIL") != "" {
			fmt.Println("semiont-gateway  | JWT_SECRET is not set. `semiont start` generates one per knowledge base and injects it; set JWT_SECRET explicitly to override.")
			fmt.Println("2026-01-01 00:00:02.000Z: Retry after fixing with:  bash .devcontainer/post-start.sh")
			fmt.Println("2026-01-01 00:00:02.100Z: postStartCommand from devcontainer.json failed with exit code 1. Skipping any further user-provided commands.")
			fmt.Println("2026-01-01 00:00:02.200Z: devcontainer process exited with exit code 1")
			// The stream does NOT stop at the failure. Enough trailing lines to
			// overflow the report window, so a report built from the live ring
			// would lose the cause entirely — which is the bug this models.
			for i := 0; i < 30; i++ {
				fmt.Printf("2026-01-01 00:00:03.%03dZ: Finished configuring codespace (trailing %d)\n", i, i)
			}
			return
		}
		fmt.Println("2026-01-01 00:00:02.000Z: postCreateCommand done")
	case "stop", "delete":
		// argv log is the observable, but state must follow too: a stopped
		// codespace reports Shutdown until something wakes it, exactly as
		// GitHub does. Without this the fake stays Available forever and
		// tests can't tell a wake-avoiding command from a waking one.
		//
		// And real gh 404s when the target does not exist (GitHub's 720h
		// retention reap) — the fidelity that pins stop --delete against a
		// reaped record. Membership is what `list` would print.
		for i, a := range args {
			if a == "-c" && i+1 < len(args) {
				name := args[i+1]
				body := os.Getenv("FAKERT_GH_CS_LIST")
				if body == "" {
					body = "[" + strings.Join(createdCodespaces(), ",") + "]"
				}
				if !strings.Contains(applyStateEvents(body), `"`+name+`"`) {
					fmt.Fprintln(os.Stderr, "error fetching codespace information: HTTP 404: Not Found")
					os.Exit(1)
				}
				recordState(name, "Shutdown")
			}
		}
	case "ssh":
		// FAKERT_GH_SSH_FAIL: ssh never works. FAKERT_GH_SSH_FAIL_FIRST=n: it
		// fails for the first n attempts and then works — sshd coming up
		// during a fresh create, which is the case that must NOT be mistaken
		// for a codespace that will never answer.
		if os.Getenv("FAKERT_GH_SSH_FAIL") != "" || bumpCounter("ssh-attempts") <= sshFailFirst() {
			fmt.Fprintln(os.Stderr, "failed to start SSH server")
			os.Exit(1)
		}
		switch {
		case strings.HasSuffix(strings.TrimSpace(joined), "true"):
			// The wake probe: connecting is what resumes a codespace, so
			// record it — subsequent `list` calls must report it Available,
			// exactly as GitHub does.
			for i, a := range args {
				if a == "-c" && i+1 < len(args) {
					recordState(args[i+1], "Available")
				}
			}
		case strings.Contains(joined, "SEMIONT_KB_READY"):
			// The readiness probe that does NOT go through the tunnel — the
			// only way to ask "is the stack up?" without destroying the
			// forward while it is still coming up. Each call is tallied so a
			// test can say "ready on the nth probe".
			// The launcher's probe is `semiont status … && echo READY ||
			// echo WAIT`, so the sentinel — not the exit code — is the answer.
			// A vanished sentinel is how it detects that ssh itself failed.
			bumpRemoteProbe()
			if remoteDown() {
				fmt.Println("SEMIONT_KB_WAIT")
				return
			}
			// The gateway can answer while the codespace's own start is still
			// bringing up the rest: only its launcher can say the STACK is up.
			if n, _ := strconv.Atoi(os.Getenv("FAKERT_REMOTE_STACK_READY_AFTER")); n > 0 && bumpCounter("stack-probes") < n {
				fmt.Println("SEMIONT_KB_WAIT")
				return
			}
			fmt.Println("SEMIONT_KB_READY")
		case strings.Contains(joined, ".semiont/config"):
			// The KB's committed identity card, as the codespace holds it.
			// FAKERT_GH_KBCONFIG overrides so a test can stage DRIFT — a
			// remote did that disagrees with the recorded one.
			body := os.Getenv("FAKERT_GH_KBCONFIG")
			if body == "" {
				body = "[site]\ndomain = \"example.com:remote-kb\"\n"
			}
			fmt.Println(body)
		case strings.Contains(joined, "semiont start"):
			// The codespace's own launcher, rerun with the issuer on a new
			// port: it records it, and the gateway advertises it afterwards.
			// Held, it is the window in which the laptop's allocated port can
			// be taken by something else.
			holdIfNamed(codespaceArg(args))
			if m := regexp.MustCompile(`KEYCLOAK_PORT=(\d+)`).FindStringSubmatch(joined); m != nil {
				if dir := os.Getenv("FAKERT_DIR"); dir != "" {
					_ = os.WriteFile(filepath.Join(dir, "cs-keycloak-port-"+codespaceArg(args)), []byte(m[1]), 0o644)
				}
			}
			// The real inner start ends with ITS summary — the codespace's own
			// view, whose ports are wrong from the laptop.
			fmt.Println("🚀 Semiont stack is up  (70s)")
			fmt.Println("  Semiont Browser    http://localhost:3000")
			fmt.Println("  Semiont KB         http://localhost:4000")
		case strings.Contains(joined, "semiont useradd"):
			// The remote side is a SHELL, so echo back what the shell would
			// actually receive — that is what proves quoting works.
			fmt.Println("remote-cmd: " + args[len(args)-1])
		case strings.Contains(joined, "docker logs"):
			name := strings.TrimPrefix(args[len(args)-1], "semiont-")
			fmt.Println(name + " out")
			fmt.Fprintln(os.Stderr, name+" err")
		default:
			fmt.Fprintf(os.Stderr, "fakert gh ssh: unscripted %v\n", args)
			os.Exit(64)
		}
	default:
		fmt.Fprintf(os.Stderr, "fakert gh codespace: unscripted %v\n", args)
		os.Exit(64)
	}
}

// recordContainerEnv writes FAKERT_DIR/env-<name>: the environment the
// container starts with, one NAME=value per line — what `inspect` would show.
// A bare `--env NAME` is copied from this process's own environment, as both
// real runtimes do, and absent when that is unset: the argv log alone cannot
// show a value that crossed through the runtime's environment.
func recordContainerEnv(name string, args []string) {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" || name == "" {
		return
	}
	var lines []string
	for i := 0; i+1 < len(args); i++ {
		if args[i] != "--env" && args[i] != "-e" {
			continue
		}
		if strings.Contains(args[i+1], "=") {
			lines = append(lines, args[i+1])
		} else if v, ok := os.LookupEnv(args[i+1]); ok {
			lines = append(lines, args[i+1]+"="+v)
		}
	}
	_ = os.WriteFile(filepath.Join(dir, "env-"+name), []byte(strings.Join(lines, "\n")+"\n"), 0o600)
}

// holdIfNamed parks while FAKERT_RUN_HOLD names name, until the test writes
// FAKERT_DIR/release-<name>; FAKERT_DIR/holding-<name> tells it the hold began.
func holdIfNamed(name string) {
	dir := os.Getenv("FAKERT_DIR")
	if hold := os.Getenv("FAKERT_RUN_HOLD"); hold == "" || hold != name || dir == "" {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "holding-"+name), nil, 0o644)
	for i := 0; i < 600; i++ {
		if _, err := os.Stat(filepath.Join(dir, "release-"+name)); err == nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// printLsof imitates real lsof's long form; the launcher reads the PID from
// column 2.
func printLsof(port string, pids ...string) {
	fmt.Println("COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME")
	for _, p := range pids {
		fmt.Printf("fake %8s oss   41u  IPv4 0x0  0t0  TCP *:%s (LISTEN)\n", p, port)
	}
}

func lsof(args []string) {
	// `lsof -nP -iTCP:<port> -sTCP:LISTEN` — listenersOn in start.go says why the
	// state filter is there and `-t` is not.
	if len(args) != 3 || args[0] != "-nP" || !strings.HasPrefix(args[1], "-iTCP:") || args[2] != "-sTCP:LISTEN" {
		fmt.Fprintf(os.Stderr, "fakert lsof: unscripted args %v\n", args)
		os.Exit(64)
	}
	port := strings.TrimPrefix(args[1], "-iTCP:")
	if pids := os.Getenv("FAKERT_LSOF_" + port); pids != "" {
		printLsof(port, strings.Fields(pids)...)
		return
	}
	// FIDELITY: with nothing scripted, answer for REAL. A port something is
	// actually listening on must read as BUSY — real lsof sees it, and the
	// launcher trusts lsof for both its port preflight and KB-port
	// allocation. An env-only fake reports "free" for a held port, so the
	// launcher hands out a port that cannot bind: the forward dies
	// instantly and the start fails 30s later blaming the tunnel. A fake
	// that lies about the world hides real bugs.
	// Probe by BINDING, not dialing: bindability is the question the
	// launcher is really asking, and a dial can report "free" for a port
	// that is held but not accepting (backlog exhausted, filtered).
	if ln, err := net.Listen("tcp", "127.0.0.1:"+port); err == nil {
		_ = ln.Close()
		os.Exit(1) // bindable ⇒ nothing holds it; real lsof exits 1
	}
	printLsof(port, strconv.Itoa(os.Getpid()))
}

// opCmd fakes the 1Password CLI. Resolution calls `op read op://<path>`; the
// launcher's 1Password custody store calls the `item` commands, shaped as the
// real CLI (op 2.33.1) answers them: items live in
// FAKERT_DIR/op-items.json, values arrive on stdin, never argv.
// FAKERT_OP_FAIL fails every command, as a denied authorization does;
// FAKERT_OP_VALUE overrides a read of a path no item answers; FAKERT_OP_VAULTS
// (comma-separated) names the vaults that exist, every vault when unset.
func opCmd(args []string) {
	if os.Getenv("FAKERT_OP_FAIL") != "" {
		fmt.Fprintln(os.Stderr, "[ERROR] authorization denied")
		os.Exit(1)
	}
	switch {
	case len(args) == 2 && args[0] == "read" && strings.HasPrefix(args[1], "op://"):
		if v, ok := opReadItemField(strings.TrimPrefix(args[1], "op://")); ok {
			fmt.Println(v)
			return
		}
		v := os.Getenv("FAKERT_OP_VALUE")
		if v == "" {
			v = "fake-op-secret"
		}
		fmt.Println(v)
	case len(args) >= 2 && args[0] == "item":
		opItemCmd(args[1], args[2:])
	default:
		fmt.Fprintf(os.Stderr, "fakert op: unscripted args %v\n", args)
		os.Exit(64)
	}
}

// opItem is an item as `op item get --format json --reveal` prints it, less
// what the launcher never reads.
type opItem struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Category string    `json:"category"`
	Vault    opVault   `json:"vault"`
	Fields   []opField `json:"fields"`
}

type opVault struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type opField struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Type    string `json:"type"`
	Purpose string `json:"purpose,omitempty"`
	Value   string `json:"value,omitempty"`
}

func opItemsPath() string { return filepath.Join(os.Getenv("FAKERT_DIR"), "op-items.json") }

func loadOpItems() []opItem {
	var items []opItem
	if b, err := os.ReadFile(opItemsPath()); err == nil {
		_ = json.Unmarshal(b, &items)
	}
	return items
}

func saveOpItems(items []opItem) {
	b, _ := json.MarshalIndent(items, "", "  ")
	_ = os.WriteFile(opItemsPath(), b, 0o600)
}

func opVaultExists(name string) bool {
	vaults := os.Getenv("FAKERT_OP_VAULTS")
	if vaults == "" {
		return true
	}
	for _, v := range strings.Split(vaults, ",") {
		if v == name {
			return true
		}
	}
	return false
}

// opFlag: the value of --<name> in args, and args without the flag.
func opFlag(args []string, name string) (string, []string) {
	var rest []string
	val := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--"+name && i+1 < len(args) {
			val = args[i+1]
			i++
			continue
		}
		rest = append(rest, args[i])
	}
	return val, rest
}

func opFail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[ERROR] 2026/09/30 00:00:00 "+format+"\n", a...)
	os.Exit(1)
}

func opPrint(v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}

// opFind: the items in vault matching ref by id or title.
func opFind(items []opItem, vault, ref string) []int {
	var out []int
	for i, it := range items {
		if it.Vault.Name == vault && (it.ID == ref || it.Title == ref) {
			out = append(out, i)
		}
	}
	return out
}

func opItemCmd(verb string, args []string) {
	vault, args := opFlag(args, "vault")
	_, args = opFlag(args, "format")
	var rest []string
	for _, a := range args {
		if a != "--reveal" {
			rest = append(rest, a)
		}
	}
	if vault == "" {
		opFail("fakert: a --vault is required")
	}
	if !opVaultExists(vault) {
		opFail("%q isn't a vault in this account. Specify the vault with its ID or name.", vault)
	}
	items := loadOpItems()
	one := func() int {
		if len(rest) == 0 {
			opFail("fakert: an item is required")
		}
		found := opFind(items, vault, rest[0])
		switch len(found) {
		case 0:
			opFail("%q isn't an item in the %q vault. Specify the item with its UUID, name, or domain.", rest[0], vault)
		case 1:
			return found[0]
		}
		opFail("More than one item matches %q. Try again and specify the item by its ID.", rest[0])
		return -1
	}
	switch verb {
	case "list":
		var out []opItem
		for _, it := range items {
			if it.Vault.Name == vault {
				out = append(out, opItem{ID: it.ID, Title: it.Title, Category: it.Category, Vault: it.Vault})
			}
		}
		if out == nil {
			out = []opItem{}
		}
		opPrint(out)
	case "get":
		opPrint(items[one()])
	case "create":
		var tmpl opItem
		if b, _ := io.ReadAll(os.Stdin); json.Unmarshal(b, &tmpl) != nil {
			opFail("fakert: create reads its template on stdin")
		}
		tmpl.ID = fmt.Sprintf("fakeitem%04d", len(items)+1)
		tmpl.Vault = opVault{ID: "vault-" + vault, Name: vault}
		// The real CLI adds a Secure Note's own notes field.
		tmpl.Fields = append([]opField{{ID: "notesPlain", Label: "notesPlain", Type: "STRING", Purpose: "NOTES"}}, tmpl.Fields...)
		items = append(items, tmpl)
		saveOpItems(items)
		opPrint(tmpl)
	case "edit":
		i := one()
		if len(rest) > 1 {
			// Assignments: only `<field>[delete]` is scripted — a value on
			// argv is exactly what the launcher must never do.
			for _, a := range rest[1:] {
				label, ok := strings.CutSuffix(a, "[delete]")
				if !ok {
					opFail("fakert: unscripted assignment %q (values travel on stdin)", a)
				}
				kept := items[i].Fields[:0]
				for _, f := range items[i].Fields {
					if f.Label != label {
						kept = append(kept, f)
					}
				}
				items[i].Fields = kept
			}
		} else {
			var edited opItem
			if b, _ := io.ReadAll(os.Stdin); json.Unmarshal(b, &edited) != nil {
				opFail("fakert: edit reads the item on stdin")
			}
			items[i].Fields = edited.Fields
		}
		saveOpItems(items)
		opPrint(items[i])
	case "delete":
		i := one()
		items = append(items[:i], items[i+1:]...)
		saveOpItems(items)
	default:
		opFail("fakert: unscripted item command %q", verb)
	}
}

// opReadItemField answers `op read op://<vault>/<item>/<field>` from the item
// store, as the real CLI reads a field a custody store wrote.
func opReadItemField(path string) (string, bool) {
	parts := strings.Split(path, "/")
	if len(parts) != 3 {
		return "", false
	}
	for _, it := range loadOpItems() {
		if it.Vault.Name == parts[0] && (it.Title == parts[1] || it.ID == parts[1]) {
			for _, f := range it.Fields {
				if f.Label == parts[2] {
					return f.Value, true
				}
			}
		}
	}
	return "", false
}

func psCmd(args []string) {
	// The launcher calls `ps -p <pid> -o comm=`.
	if len(args) == 4 && args[0] == "-p" && args[2] == "-o" && args[3] == "comm=" {
		fmt.Println(processName(args[1]))
		return
	}
	fmt.Fprintf(os.Stderr, "fakert ps: unscripted args %v\n", args)
	os.Exit(64)
}

// processName: what a process runs, as `ps` and `tasklist` each report it.
// FAKERT_PS_<pid> scripts one.
func processName(pid string) string {
	if comm := os.Getenv("FAKERT_PS_" + pid); comm != "" {
		return comm
	}
	// A pid matching one of our own forward pidfiles IS the fake gh forward —
	// report it as gh, the name the real forward has (the launcher's
	// forwardAlive depends on this). The pid is the file's first line; the
	// ports it holds follow.
	if dir := os.Getenv("FAKERT_DIR"); dir != "" {
		files, _ := filepath.Glob(filepath.Join(dir, "serve-gh-forward-*.pid"))
		for _, f := range files {
			if b, err := os.ReadFile(f); err == nil {
				if recorded, _, _ := strings.Cut(strings.TrimSpace(string(b)), "\n"); strings.TrimSpace(recorded) == pid {
					return "gh"
				}
			}
		}
	}
	return "fakeproc"
}

// tasklist fakes what the launcher asks Windows for a process's name:
// `tasklist /FI "PID eq <pid>" /FO CSV /NH`, one CSV row whose first field
// is the image.
func tasklist(args []string) {
	if len(args) == 5 && args[0] == "/FI" && args[2] == "/FO" && args[3] == "CSV" && args[4] == "/NH" {
		if pid, ok := strings.CutPrefix(args[1], "PID eq "); ok {
			fmt.Printf("%q,%q,\"Console\",\"1\",\"10,000 K\"\r\n", processName(pid)+".exe", pid)
			return
		}
	}
	fmt.Fprintf(os.Stderr, "fakert tasklist: unscripted args %v\n", args)
	os.Exit(64)
}

// netstat fakes what the launcher asks Windows for a port's listeners:
// `netstat -ano -p TCP`, the whole table. The scripted holders
// (FAKERT_LSOF_<port>) are rows of it, and the rest is the machine's own
// table, for the reason lsof binds the port: a port something really holds
// has to read as held.
func netstat(args []string) {
	if len(args) != 3 || args[0] != "-ano" || args[1] != "-p" || args[2] != "TCP" {
		fmt.Fprintf(os.Stderr, "fakert netstat: unscripted args %v\n", args)
		os.Exit(64)
	}
	fmt.Print("\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n")
	for _, kv := range os.Environ() {
		name, pids, _ := strings.Cut(kv, "=")
		port, ok := strings.CutPrefix(name, "FAKERT_LSOF_")
		if !ok {
			continue
		}
		for _, pid := range strings.Fields(pids) {
			fmt.Printf("  TCP    0.0.0.0:%-15s 0.0.0.0:0              LISTENING       %s\r\n", port, pid)
		}
	}
	real, err := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "netstat.exe"), args...).Output()
	if err != nil {
		return
	}
	for _, row := range strings.Split(string(real), "\n") {
		if strings.HasPrefix(strings.TrimSpace(row), "TCP") {
			fmt.Print(strings.TrimRight(row, "\r") + "\r\n")
		}
	}
}

func runtimeCmd(base string, args []string) {
	if len(args) == 0 {
		os.Exit(64)
	}
	// Daemon-down persona (Apple container 0.11.0 with the apiserver off):
	// `container system status` names the condition and exits 1; every
	// other command dies with an XPC connection error.
	if os.Getenv("FAKERT_DAEMON_DOWN") == "1" {
		if base == "container" && args[0] == "system" {
			fmt.Fprintln(os.Stderr, "apiserver is not running and not registered with launchd")
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, `Error: internalError: (cause: "interrupted: "XPC connection error: Connection invalid"")`)
		os.Exit(1)
	}
	switch args[0] {
	case "system", "info":
		// Only the exact liveness probes are scripted — anything else under
		// system/info is an unexpected launcher change and must fail loudly,
		// not vanish into a blanket exit 0.
		switch base + " " + strings.Join(args, " ") {
		case "container system status", "docker info", "podman info":
			return
		}
		fmt.Fprintf(os.Stderr, "fakert: unscripted probe %q\n", base+" "+strings.Join(args, " "))
		os.Exit(64)
	case "stop":
		// Exit like real runtimes: 0 only when the container "exists" — a
		// serve pidfile (run-created) or a scripted FAKERT_STATE container
		// that hasn't been rm'd.
		name := handleName(args[len(args)-1])
		existed := killServe(name)
		if scriptedAlive(name) {
			existed = true
		}
		if !existed {
			fmt.Fprintln(os.Stderr, "Error: no such container")
			os.Exit(1)
		}
	case "rm":
		// rm releases the NAME: record the removal marker so a later
		// `run --name` stops conflicting (see the name-holding check in run).
		name := handleName(args[len(args)-1])
		existed := killServe(name) || scriptedAlive(name)
		markRemoved(name)
		if !existed {
			fmt.Fprintln(os.Stderr, "Error: no such container")
			os.Exit(1)
		}
	case "pull":
		pull(args[len(args)-1])
	case "image":
		if len(args) >= 3 && args[1] == "pull" {
			pull(args[len(args)-1])
			return
		}
		os.Exit(64)
	case "volume":
		if os.Getenv("FAKERT_VOLUME_ABSENT") != "" {
			fmt.Fprintln(os.Stderr, "Error: no such volume")
			os.Exit(1)
		}
	case "list", "ps":
		// Two callers, two questions:
		//
		//   list / ps            "which runtime is the stack on?" — answered by
		//                        FAKERT_STACK_RUNTIME.
		//   list -a / ps -a      "which semiont containers EXIST here?" — the
		//                        teardown's question. Answered from
		//                        FAKERT_STATE_<svc>, the same source `inspect`
		//                        uses, so the fake cannot tell the launcher a
		//                        container exists and then deny it on inspect.
		all := false
		for _, a := range args {
			if a == "-a" || a == "--all" {
				all = true
			}
		}
		header := base == "container" // Apple container prints a header row
		if all {
			names := existingContainers()
			if header && len(names) > 0 {
				fmt.Println("ID              IMAGE                       STATE")
			}
			for _, n := range names {
				if header {
					fmt.Printf("%s ghcr.io/x/%s  running\n", n, strings.TrimPrefix(n, "semiont-"))
				} else {
					fmt.Println(n)
				}
			}
			return
		}
		if os.Getenv("FAKERT_STACK_RUNTIME") == base {
			if header {
				fmt.Println("ID              IMAGE                       STATE")
				fmt.Println("semiont-gateway ghcr.io/x/semiont-gateway  running")
			} else {
				fmt.Println("semiont-gateway")
			}
		}
	case "logs":
		name := strings.TrimPrefix(handleName(args[len(args)-1]), "semiont-")
		fmt.Println(name + " out")
		fmt.Fprintln(os.Stderr, name+" err")
	case "exec":
		// The launcher's useradd bridge: exec <handle> semiont useradd <args…>.
		// Drain stdin and record it: the password crosses THERE, never in argv,
		// so a test can only prove the secret arrived by reading what the pipe
		// carried. Draining also keeps the writer from seeing EPIPE.
		if in, err := io.ReadAll(os.Stdin); err == nil && len(in) > 0 {
			if dir := os.Getenv("FAKERT_DIR"); dir != "" {
				_ = os.WriteFile(filepath.Join(dir, "exec-stdin.txt"), in, 0o600)
			}
		}
		// A secret named `--env NAME`, with no value, crosses through the
		// runtime's own environment: record what arrived, so a test proves it
		// did without argv ever holding it.
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "--env" && args[i+1] == "KC_CLI_PASSWORD" {
				if dir := os.Getenv("FAKERT_DIR"); dir != "" {
					_ = os.WriteFile(filepath.Join(dir, "kc-cli-password.txt"), []byte(os.Getenv("KC_CLI_PASSWORD")), 0o600)
				}
			}
		}
		// FAKERT_EXEC_FAIL models the in-container CLI failing.
		if os.Getenv("FAKERT_EXEC_FAIL") != "" {
			fmt.Fprintln(os.Stderr, "Error: useradd failed")
			os.Exit(1)
		}
		fmt.Println("fakert exec ok")
	case "inspect":
		// Scripted via FAKERT_STATE_<svc> (svc = name minus "semiont-"),
		// e.g. FAKERT_STATE_gateway=running. Unset = container not found.
		// The env list stays in the shape because a real inspect carries one;
		// the launcher reads no variable out of it.
		svc := strings.TrimPrefix(handleName(args[len(args)-1]), "semiont-")
		state := os.Getenv("FAKERT_STATE_" + svc)
		if state == "" {
			fmt.Fprintln(os.Stderr, "Error: no such container")
			os.Exit(1)
		}
		switch {
		case len(args) > 1 && args[1] == "-f":
			// docker/podman status form: inspect -f {{.State.Status}} <name>
			fmt.Println(state)
		case base == "container":
			// FAKERT_IMAGE_<svc> scripts the image reference the container
			// reports (the Browser's keep-if-current check reads it).
			img := os.Getenv("FAKERT_IMAGE_" + svc)
			fmt.Printf(`[{"configuration":{"initProcess":{"environment":[]},"image":{"reference":%q}},"status":%q}]`+"\n", img, state)
		default:
			// docker/podman full form: inspect <name>
			fmt.Printf(`[{"Config":{"Env":[]},"State":{"Status":%q}}]`+"\n", state)
		}
	case "run":
		run(args)
	default:
		fmt.Fprintf(os.Stderr, "fakert %s: unscripted subcommand %v\n", base, args)
		os.Exit(64)
	}
}

func pull(image string) {
	if s := os.Getenv("FAKERT_PULL_FAIL"); s != "" && strings.Contains(image, s) {
		fmt.Fprintf(os.Stderr, "Error: pull failed for %s\n", image)
		os.Exit(1)
	}
	fmt.Printf("Pulled %s\n", image)
}

// statProbe records whether FAKERT_STAT_PATH exists at the moment a service
// `run` arrives — one line per run, "present" or "absent", appended to
// FAKERT_STAT_LOG. This is how a test pins host-side ordering (a store
// clear) against the boot's container starts: fakert executes at exactly
// the instant the real runtime would attach the mount.
func statProbe() {
	p, out := os.Getenv("FAKERT_STAT_PATH"), os.Getenv("FAKERT_STAT_LOG")
	if p == "" || out == "" {
		return
	}
	state := "absent"
	if _, err := os.Stat(p); err == nil {
		state = "present"
	}
	f, err := os.OpenFile(out, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, state)
}

// run handles both probe containers (busybox) and detached service starts.
func run(args []string) {
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "busybox:1.38.0") {
		busybox(args, joined)
		return
	}
	statProbe()
	detached := false
	var ports []string
	name := ""
	for i, a := range args {
		switch a {
		case "-d":
			detached = true
		case "-p", "--publish":
			if i+1 < len(args) {
				hp := strings.SplitN(args[i+1], ":", 2)[0]
				ports = append(ports, hp)
			}
		case "--name":
			if i+1 < len(args) {
				name = args[i+1]
			}
		}
	}
	if !detached {
		fmt.Fprintf(os.Stderr, "fakert run: unscripted foreground run %v\n", args)
		os.Exit(64)
	}
	if len(ports) > 0 && name == "" {
		fmt.Fprintf(os.Stderr, "fakert run: a published port needs --name: the name is how this fake knows what its image serves (%v)\n", args)
		os.Exit(64)
	}
	recordContainerEnv(name, args)
	// A start held mid-flight: this container's run parks until the test
	// releases it, so a second start can be begun while the first is busy.
	holdIfNamed(name)
	// NAME-HOLDING: real runtimes refuse `run --name X` while a container
	// named X exists IN ANY STATE — stopped included (no --rm keeps them).
	// A scripted container (FAKERT_STATE_<svc>) holds its name until an
	// explicit `rm` records a removal marker. Without that, a
	// stop-without-rm restart path passes hermetically and fails against a
	// real runtime.
	if name != "" && scriptedAlive(name) {
		fmt.Fprintf(os.Stderr, "Error: the container name %q is already in use\n", name)
		os.Exit(125)
	}
	// FAKERT_SKIP_SERVE: comma-separated host ports to leave unbound even
	// though the container "runs" — models a container that came up but whose
	// process crashed before listening, so health gates fail while `logs`
	// still answers.
	if skip := os.Getenv("FAKERT_SKIP_SERVE"); skip != "" {
		skipped := map[string]bool{}
		for _, p := range strings.Split(skip, ",") {
			skipped[strings.TrimSpace(p)] = true
		}
		kept := ports[:0]
		for _, p := range ports {
			if !skipped[p] {
				kept = append(kept, p)
			}
		}
		ports = kept
	}
	if len(ports) > 0 {
		self, err := os.Executable()
		if err != nil {
			os.Exit(64)
		}
		// The container NAME rides along: a fake service answers the route
		// its image declares and 404s the rest, and the name is how it
		// knows which image it is.
		// Where the child reports whether it is serving: a loopback
		// listener, which every system can hand a child the address of. An
		// inherited pipe would do on two of the three.
		reports, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(64)
		}
		cmd := exec.Command(self, append([]string{"__serve", reports.Addr().String(), name}, ports...)...)
		cmd.Stdout, cmd.Stderr = nil, nil
		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "fakert run: serve spawn: %v\n", err)
			os.Exit(1)
		}
		pidfile := ""
		if dir := os.Getenv("FAKERT_DIR"); dir != "" {
			// pid, then the ports it holds — `stop` waits for THOSE to be
			// released, which is what a real stop guarantees (killServe).
			pidfile = filepath.Join(dir, "serve-"+name+".pid")
			_ = os.WriteFile(pidfile, []byte(strconv.Itoa(cmd.Process.Pid)+"\n"+strings.Join(ports, " ")), 0o644)
		}
		// Return only once the child says every port is bound, or fail the
		// way a runtime does. A real `run -d` returns when the container
		// exists; modelling the service's own startup latency is not this
		// fake's job, and the launcher's not-ready-yet paths have their own
		// scripted tests.
		_ = reports.(*net.TCPListener).SetDeadline(time.Now().Add(10 * time.Second))
		line := ""
		if report, err := reports.Accept(); err == nil {
			_ = report.SetReadDeadline(time.Now().Add(10 * time.Second))
			line, _ = bufio.NewReader(report).ReadString('\n')
			report.Close()
		}
		reports.Close()
		line = strings.TrimSpace(line)
		if line != "bound" {
			_ = cmd.Process.Kill()
			if pidfile != "" {
				_ = os.Remove(pidfile)
			}
			if port, ok := strings.CutPrefix(line, "unbound "); ok {
				port, _, _ = strings.Cut(port, " ")
				fmt.Fprintf(os.Stderr, "Error response from daemon: driver failed programming external connectivity on endpoint %s: Bind for 127.0.0.1:%s failed: port is already allocated\n", name, port)
				os.Exit(125)
			}
			why := strings.TrimPrefix(line, "error ")
			if why == "" {
				why = "its listener exited without reporting"
			}
			fmt.Fprintf(os.Stderr, "fakert run: %s did not start: %s\n", name, why)
			os.Exit(64)
		}
	}
	// The container identifier the runtime reports — name-derived so tests
	// can assert id-based stop/status flows ("fid-semiont-gateway").
	if name != "" {
		fmt.Println("fid-" + name)
	} else {
		fmt.Println("0123456789ab")
	}
}

// createdCodespaces: JSON objects for every codespace this fake created,
// reported Available (the real API reaches Available on its own).
func createdCodespaces() []string {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(dir, "created-codespaces"))
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		nameRepo := strings.SplitN(line, " ", 2)
		if len(nameRepo) != 2 {
			continue
		}
		out = append(out, fmt.Sprintf(`{"name":%q,"state":"Available","repository":%q}`, nameRepo[0], nameRepo[1]))
	}
	return out
}

// removed / markRemoved / scriptedAlive: name-holding bookkeeping for the
// scripted (FAKERT_STATE_*) containers — env can't be mutated per-invocation,
// so removal lives in a marker file.
func removed(name string) bool {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, "removed-"+name))
	return err == nil
}

func markRemoved(name string) {
	if dir := os.Getenv("FAKERT_DIR"); dir != "" {
		_ = os.WriteFile(filepath.Join(dir, "removed-"+name), nil, 0o644)
	}
}

func scriptedAlive(name string) bool {
	svc := strings.TrimPrefix(name, "semiont-")
	return os.Getenv("FAKERT_STATE_"+svc) != "" && !removed(name)
}

// createdCodespaceNames: just the names, for the /user/codespaces facts.
func createdCodespaceNames() []string {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(dir, "created-codespaces"))
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if f := strings.Fields(line); len(f) >= 1 {
			out = append(out, f[0])
		}
	}
	return out
}

// recordState appends a state transition for a codespace. The file is an
// ordered log, not a set: stop-then-wake and wake-then-stop must differ.
func recordState(name, state string) {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "cs-states"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	fmt.Fprintf(f, "%s %s\n", name, state)
	f.Close()
}

// applyStateEvents replays that log over a listing, last write winning, so a
// woken codespace lists as Available whatever state the test scripted: a fake
// that never transitions would let the launcher wait forever.
func applyStateEvents(body string) string {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return body
	}
	b, err := os.ReadFile(filepath.Join(dir, "cs-states"))
	if err != nil {
		return body
	}
	var entries []map[string]any
	if json.Unmarshal([]byte(body), &entries) != nil {
		return body
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		for _, e := range entries {
			if e["name"] == f[0] {
				e["state"] = f[1]
			}
		}
	}
	out, err := json.Marshal(entries)
	if err != nil {
		return body
	}
	return string(out)
}

func recordCreated(name, repo string) {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "created-codespaces"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", name, repo)
}

// handleName resolves a launcher-supplied handle (container name or the
// fid-<name> identifier run -d reported) back to the container name.
func handleName(arg string) string {
	return strings.TrimPrefix(arg, "fid-")
}

func busybox(args []string, joined string) {
	// A daemon that answers but cannot run a container yet: dockerd a few
	// seconds old on a codespace resume.
	if n, _ := strconv.Atoi(os.Getenv("FAKERT_BUSYBOX_FAIL_FIRST")); n > 0 && bumpCounter("busybox-runs") <= n {
		fmt.Fprintln(os.Stderr, "docker: Error response from daemon: failed to set up container networking: network bridge not found")
		os.Exit(125)
	}
	switch {
	case strings.Contains(joined, "find /store"):
		// The store clear: empty the host dir mounted at /store, keeping the
		// dir itself, as the real `find … -exec rm -rf {} +` does.
		host := ""
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "-v" && strings.HasSuffix(args[i+1], ":/store") {
				host = strings.TrimSuffix(args[i+1], ":/store")
			}
		}
		entries, err := os.ReadDir(host)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fakert busybox: store clear: %v\n", err)
			os.Exit(1)
		}
		for _, e := range entries {
			if err := os.RemoveAll(filepath.Join(host, e.Name())); err != nil {
				fmt.Fprintf(os.Stderr, "fakert busybox: store clear: %v\n", err)
				os.Exit(1)
			}
		}
	case strings.Contains(joined, "nslookup"):
		if os.Getenv("FAKERT_NSLOOKUP") == "ok" {
			return
		}
		os.Exit(1)
	case strings.Contains(joined, "ip route"):
		gw := os.Getenv("FAKERT_GATEWAY")
		if gw == "" {
			gw = "192.168.64.1"
		}
		fmt.Println(gw)
	case strings.Contains(joined, "nc -z"):
		if os.Getenv("FAKERT_NC_FAIL") != "" {
			os.Exit(1)
		}
	case strings.Contains(joined, "wget"):
		switch {
		case strings.Contains(joined, ":11434"):
			if os.Getenv("FAKERT_OLLAMA_REACHABLE") == "" {
				os.Exit(1)
			}
		case strings.Contains(joined, ":4000"):
			if os.Getenv("FAKERT_GATEWAY_UNREACHABLE") != "" {
				os.Exit(1)
			}
		default:
			os.Exit(64)
		}
	default:
		fmt.Fprintf(os.Stderr, "fakert busybox: unscripted %v\n", args)
		os.Exit(64)
	}
}

// The fake bus is a BROADCAST, like the real one: every open subscription
// receives every event on a channel it subscribed to. Handing each emitted
// request to exactly one stream would make a flow with two concurrent
// subscriptions (yield --delegate: one for job:* lifecycle, one inside the
// request/reply helper) lose its reply to the wrong stream and time out. A
// fake with different delivery semantics than the real bus tests a protocol
// nobody implements.
type busSub struct {
	channels map[string]bool
	out      chan busFrame
}

type busFrame struct {
	channel string
	corrID  string // ENVELOPE, never inside the payload — see busPublish
	payload map[string]any
}

var (
	busMu   sync.Mutex
	busSubs []*busSub
)

func busSubscribe(channels []string) *busSub {
	sub := &busSub{channels: map[string]bool{}, out: make(chan busFrame, 64)}
	for _, c := range channels {
		sub.channels[c] = true
	}
	busMu.Lock()
	busSubs = append(busSubs, sub)
	busMu.Unlock()
	return sub
}

func busUnsubscribe(target *busSub) {
	busMu.Lock()
	defer busMu.Unlock()
	for i, s := range busSubs {
		if s == target {
			busSubs = append(busSubs[:i], busSubs[i+1:]...)
			return
		}
	}
}

// busSubscriberCount reports how many live subscriptions cover a channel —
// the fake's answer to the real gateway's observer count.
func busSubscriberCount(channel string) int {
	busMu.Lock()
	defer busMu.Unlock()
	n := 0
	for _, s := range busSubs {
		if s.channels[channel] {
			n++
		}
	}
	return n
}

// fakeJobResults: what a job of each type completes with when a test scripts
// no result — the member of the JobResult union that type reports.
var fakeJobResults = map[string]map[string]any{
	"generation":            {"kind": "generation", "resourceId": "res-new", "resourceName": "Generated", "truncated": false},
	"highlight-annotation":  {"kind": "highlight-annotation", "highlightsFound": 4, "highlightsCreated": 3},
	"comment-annotation":    {"kind": "comment-annotation", "commentsFound": 2, "commentsCreated": 2},
	"assessment-annotation": {"kind": "assessment-annotation", "assessmentsFound": 1, "assessmentsCreated": 1},
	"reference-annotation":  {"kind": "reference-annotation", "totalFound": 5, "totalEmitted": 4, "errors": 1},
	"tag-annotation":        {"kind": "tag-annotation", "tagsFound": 6, "tagsCreated": 6, "byCategory": map[string]any{"rule": 4, "issue": 2}},
}

// busPublish fans one frame out to every subscriber listening on its channel.
// corrID rides the ENVELOPE beside the channel, which is where the real
// gateway puts it (apps/gateway/src/routes/stream.rs writes
// `{channel, correlationId, payload}`) and where the Go client reads it.
// Job lifecycle events pass "" — they are keyed by jobId, not by the
// correlation key of the request that created the job.
func busPublish(channel, corrID string, payload map[string]any) {
	busMu.Lock()
	subs := append([]*busSub(nil), busSubs...)
	busMu.Unlock()
	for _, s := range subs {
		if !s.channels[channel] {
			continue
		}
		select {
		case s.out <- busFrame{channel: channel, corrID: corrID, payload: payload}:
		default: // a stalled reader must not wedge the emitter
		}
	}
}

// busReplyFor maps a request channel to its scripted reply. The channel PAIR
// comes from the generated operations registry, so the fake can never invent a
// pair the real bus does not have — a fake that agrees with the code under
// test about a wrong channel is how a verb passes while broken.
func busReplyFor(request string) (string, map[string]any) {
	if !busScripted[request] {
		return "", nil
	}
	op, ok := bus.Operations[bus.Channel(request)]
	if !ok {
		return "", nil
	}
	if msg := os.Getenv("FAKERT_BUS_FAIL"); msg != "" {
		return string(op.Failure), map[string]any{"message": msg}
	}
	env := "FAKERT_BUS_REPLY_" + strings.NewReplacer(":", "_", "-", "_").Replace(request)
	raw := os.Getenv(env)
	if raw == "" {
		raw = "{}"
		if request == "job:create" {
			raw = `{"jobId":"fake-job-1"}`
		}
	}
	var response any
	if json.Unmarshal([]byte(raw), &response) != nil {
		response = map[string]any{}
	}
	return string(op.Result), map[string]any{"response": response}
}

// The handful of operations the launcher's verbs use — an ALLOWLIST of request
// channels, not a channel-pair table (the pair is derived above). Kept minimal
// on purpose: an unscripted request produces no reply, so a verb wired to the
// wrong channel times out loudly in tests instead of passing by accident.
var busScripted = map[string]bool{
	"browse:resources-requested":    true,
	"browse:resource-requested":     true,
	"browse:annotations-requested":  true,
	"browse:entity-types-requested": true,
	"frame:add-entity-type":         true,
	"gather:resource-requested":     true,
	"gather:requested":              true,
	"mark:create-request":           true,
	"mark:delete":                   true,
	"bind:update-body":              true,
	"match:search-requested":        true,
	"job:create":                    true,
	"job:limits-requested":          true,
	"gather:limits-requested":       true,
	"match:limits-requested":        true,
}

// existingContainers is every semiont-* container that exists here, from BOTH
// sources — and it must be both, or the fake lies to a teardown:
//
//	FAKERT_STATE_<svc>   containers the TEST scripted as pre-existing
//	serve-<name>.pid     containers THIS RUN started (`run -d --name`), which
//	                     no env var knows about
//
// The second source is the one a restart depends on: a launcher that starts a
// stack and then starts it again must find its own containers to tear them
// down. The teardown asks what exists rather than firing stop/rm blindly, so
// an incomplete answer becomes a name collision.
//
// Sorted, so the argv goldens are stable.
func existingContainers() []string {
	seen := map[string]bool{}
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || v == "" || !strings.HasPrefix(k, "FAKERT_STATE_") {
			continue
		}
		seen["semiont-"+strings.TrimPrefix(k, "FAKERT_STATE_")] = true
	}
	if dir := os.Getenv("FAKERT_DIR"); dir != "" {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			n := e.Name()
			if strings.HasPrefix(n, "serve-") && strings.HasSuffix(n, ".pid") {
				seen[strings.TrimSuffix(strings.TrimPrefix(n, "serve-"), ".pid")] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for n := range seen {
		if strings.HasPrefix(n, "semiont-") {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

// killServe reaps the port listener for a named container, reporting whether
// one existed.
func killServe(name string) bool {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return false
	}
	pidfile := filepath.Join(dir, "serve-"+name+".pid")
	b, err := os.ReadFile(pidfile)
	if err != nil {
		return false
	}
	lines := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)
	// pid <= 1 is never one of ours, and kill(-1) would signal every process.
	if pid, err := strconv.Atoi(strings.TrimSpace(lines[0])); err == nil && pid > 1 {
		if p, err := os.FindProcess(pid); err == nil {
			_ = p.Kill()
		}
	}
	// FIDELITY: a real `stop` does not return until the container is stopped
	// and its published ports are RELEASED. Returning early would let the
	// launcher's very next port check see the dying listener, because the
	// fake lsof answers for real. Waiting on the PORTS (not the pid) avoids
	// depending on who reaps an orphaned serve.
	if len(lines) > 1 {
		for _, p := range strings.Fields(lines[1]) {
			deadline := time.Now().Add(3 * time.Second)
			freed := false
			for time.Now().Before(deadline) {
				if ln, err := net.Listen("tcp", "127.0.0.1:"+p); err == nil {
					_ = ln.Close()
					freed = true
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !freed {
				// Never silently give up: an unreleased port here becomes
				// an unexplained failure in a LATER test. Say so where it
				// happened. (Loud on stderr, not a nonzero exit — the exit
				// code of `stop` means "did the container exist", which the
				// launcher acts on.)
				fmt.Fprintf(os.Stderr, "fakert stop: port %s still held 3s after killing %s — harness bug, later tests may fail\n", p, name)
			}
		}
	}
	_ = os.Remove(pidfile)
	return true
}

// devicePolls counts token-endpoint polls of the device grant, so the first
// FAKERT_DEVICE_PENDING of them can answer authorization_pending; bearerUses
// counts presentations of each bearer, so a token can be accepted once (at
// login) and stale afterwards. Handlers run concurrently — `status` asks three
// limits operations at once — and Go kills a process on concurrent map writes,
// so both counters are only touched through countDevicePoll and countBearerUse.
var (
	sessionMu   sync.Mutex
	devicePolls int
	bearerUses  = map[string]int{}
)

// countDevicePoll records one device-grant poll and returns the tally.
func countDevicePoll() int {
	sessionMu.Lock()
	defer sessionMu.Unlock()
	devicePolls++
	return devicePolls
}

// countBearerUse records one presentation of a bearer and returns its tally.
func countBearerUse(authorization string) int {
	sessionMu.Lock()
	defer sessionMu.Unlock()
	bearerUses[authorization]++
	return bearerUses[authorization]
}

// unsignedJWT renders claims as a JWT with `alg: none` and a stub signature.
// Nothing that reads these tokens verifies them — the launcher's preflight
// decodes without trusting, because verification is the gateway's job against
// the issuer's published keys — so a fake issuer needs no key.
func unsignedJWT(claims map[string]any) string {
	b, _ := json.Marshal(claims)
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + enc(b) + ".fake"
}

// servedRoutes: does this container answer that path? Everything else 404s.
//
// TWO SOURCES, and neither of them is the launcher. A fake taught by the
// code under test agrees with it about a wrong route as happily as a right
// one.
//
//   - Semiont's own services: read from the IMAGE, which declares its health
//     route as its HEALTHCHECK and its entrypoint's probe. That is the thing
//     that actually runs.
//   - Third-party servers: their own facts, which no file in this repo owns.
//     Each is a belief about an upstream, to be re-checked when the pinned
//     version moves, not a convention we may change.
//
// Paths the handler already models explicitly (the issuer's realm endpoints,
// the gateway's bus and token routes, Ollama's API) are reached before this
// and are not repeated here.
//
// KNOWN GAP: this predicate is per-CONTAINER, but the handler above it is
// not — the issuer's realm routes answer on every port, so a request to the
// gateway's port for a Keycloak path succeeds. Real stacks put those on
// different origins, and a sign-in crosses them: the realm must list the
// Browser's origin or the token exchange fails CORS. Closing it belongs with
// a fake issuer that reads the realm document the launcher stages (its
// clients, their redirect URIs and web origins).
func servedRoutes(container string) (func(string) bool, error) {
	// Third-party health routes, as served by the versions pinned in the
	// launcher's descriptor set.
	exact := func(paths ...string) func(string) bool {
		set := map[string]bool{}
		for _, p := range paths {
			set[p] = true
		}
		return func(p string) bool { return set[p] }
	}
	switch container {
	case "semiont-otel-collector": // otel/opentelemetry-collector 0.137.0, prometheus exporter
		return exact("/metrics"), nil
	case "semiont-prometheus": // prom/prometheus v3.9.1
		return exact("/-/healthy"), nil
	case "semiont-jaeger": // jaegertracing/all-in-one 1.76.0, the UI root
		return exact("/"), nil
	case "semiont-qdrant": // qdrant v1.19.1
		return exact("/readyz", "/"), nil
	case "semiont-neo4j": // neo4j 5.26.28-community, the browser on 7474
		return exact("/"), nil
	case "semiont-ollama": // the rest of Ollama's API is modelled above
		return exact("/api/version"), nil
	case "semiont-keycloak":
		// Keycloak serves a root document for EVERY realm it holds, which is
		// what the launcher's readiness wait reads — it does not know which
		// realm a config named, and must not ask the launcher. Whether the
		// realm the launcher staged is the one that exists is another
		// question, and needs the staged document.
		return func(p string) bool {
			rest, ok := strings.CutPrefix(p, "/realms/")
			return ok && rest != "" && !strings.Contains(rest, "/")
		}, nil
	case "semiont-postgres", "semiont-nats": // TCP only: a dial, no HTTP
		return exact(), nil
	}
	// One of ours: ask the image.
	svc := strings.TrimPrefix(container, "semiont-")
	root := os.Getenv("FAKERT_REPO")
	if root == "" {
		return nil, fmt.Errorf("FAKERT_REPO is unset, so %s cannot read what its image serves", container)
	}
	p, err := images.HealthPath(root, svc)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", container, err)
	}
	return exact(p), nil
}

// serve listens on every given port and answers as container does until the
// process is killed: the paths serveOn models, the routes servedRoutes names,
// and 404 for the rest.
func serve(container string, ports []string) {
	routes, err := servedRoutes(container)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakert serve: %v\n", err)
		os.Exit(64)
	}
	listeners, port, err := listenAll(ports)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakert serve: port %s: %v\n", port, err)
		os.Exit(1)
	}
	serveOn(container, routes, listeners)
}

// serveDetached is the `__serve` child of `run -d`. It tells its parent, at
// the address the parent listens on for it, whether it is serving: "bound"
// once every port listens, "unbound <port>" when one is taken, "error <why>"
// when it cannot start at all. The parent returns only for a container that
// is really serving, as a runtime does; were it to dial the ports instead, a
// port another process holds would answer for a listener that has exited.
func serveDetached(reportTo, container string, ports []string) {
	ready, err := net.DialTimeout("tcp", reportTo, 10*time.Second)
	if err != nil {
		os.Exit(64)
	}
	routes, err := servedRoutes(container)
	if err != nil {
		fmt.Fprintf(ready, "error %v\n", err)
		os.Exit(64)
	}
	listeners, port, err := listenAll(ports)
	if err != nil {
		fmt.Fprintf(ready, "unbound %s %v\n", port, err)
		os.Exit(1)
	}
	fmt.Fprintln(ready, "bound")
	ready.Close()
	serveOn(container, routes, listeners)
}

// listenAll binds every port, or none: on failure it closes what it bound
// and names the port that failed.
func listenAll(ports []string) ([]net.Listener, string, error) {
	var listeners []net.Listener
	for _, p := range ports {
		ln, err := net.Listen("tcp", "127.0.0.1:"+p)
		if err != nil {
			for _, l := range listeners {
				l.Close()
			}
			return nil, p, err
		}
		listeners = append(listeners, ln)
	}
	return listeners, "", nil
}

// serveOn answers on every listener until the process is killed.
func serveOn(container string, routes func(string) bool, listeners []net.Listener) {
	done := make(chan struct{})
	for _, ln := range listeners {
		go func() {
			_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// A sick serve answers but is never ready (see the forward
				// case) — bound ≠ healthy, exactly like a warming gateway.
				if os.Getenv("FAKERT_SERVE_SICK") != "" {
					http.Error(w, "warming", http.StatusServiceUnavailable)
					return
				}
				// The knowledge base's issuer, served on the same port under
				// /realms/semiont: the resource metadata names it, discovery
				// names its endpoints, and the device + token endpoints run
				// the grant — every JSON-bodied, Content-Type explicit (the
				// generated Go client parses JSON200 only when the header
				// says json, exactly like the real gateway).
				//   FAKERT_DEVICE_PENDING=n   polls answered authorization_pending first (default 1)
				//   FAKERT_DEVICE_DENY=1      the user denies at the issuer
				//   FAKERT_MISSING_CLIENT=id  the realm has no such client (401 invalid_client)
				//   FAKERT_NO_DEVICE_GRANT=id that client may not use the device grant
				//   FAKERT_PIN_REDIRECT_PORT=1 the realm pins loopback redirects to :3000,
				//                             refusing the any-port loopback of RFC 8252 §7.3
				origin := "http://" + r.Host
				issuer := origin + "/realms/semiont"
				advertised := issuer
				if a := os.Getenv("FAKERT_ADVERTISED_ISSUER"); a != "" {
					advertised = a
				}
				jsonOut := func(status int, body any) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(status)
					_ = json.NewEncoder(w).Encode(body)
				}
				if r.URL.Path == "/.well-known/oauth-protected-resource" {
					jsonOut(200, map[string]any{
						"resource":                 origin,
						"authorization_servers":    []string{advertised},
						"bearer_methods_supported": []string{"header"},
						"resource_name":            "fake-kb",
					})
					return
				}
				if r.URL.Path == "/realms/semiont/.well-known/openid-configuration" {
					jsonOut(200, map[string]any{
						"issuer":                        issuer,
						"authorization_endpoint":        issuer + "/protocol/openid-connect/auth",
						"device_authorization_endpoint": issuer + "/protocol/openid-connect/auth/device",
						"token_endpoint":                issuer + "/protocol/openid-connect/token",
						"revocation_endpoint":           issuer + "/protocol/openid-connect/revoke",
					})
					return
				}
				// The authorization endpoint, as far as the identity preflight
				// needs it: 200 is the login page — the client resolved and the
				// redirect URI is registered. Keycloak renders an HTML error for
				// either failure, which is why existence is decided at the device
				// endpoint instead.
				if r.URL.Path == "/realms/semiont/protocol/openid-connect/auth" {
					q := r.URL.Query()
					if m := os.Getenv("FAKERT_MISSING_CLIENT"); m != "" && q.Get("client_id") == m {
						http.Error(w, "Client not found.", 400)
						return
					}
					// A realm that registers the loopback host WITHOUT a port
					// accepts any port (RFC 8252 §7.3); one that pinned :3000
					// does not. This models the pinned kind.
					if os.Getenv("FAKERT_PIN_REDIRECT_PORT") != "" && !strings.Contains(q.Get("redirect_uri"), ":3000/") {
						http.Error(w, "Invalid parameter: redirect_uri", 400)
						return
					}
					// The realm the launcher provisions has the IMPLICIT flow
					// disabled, and a realm with it disabled refuses
					// response_type=token rather than serving the login page.
					// Answering 200 to every response_type would describe a
					// realm that leaks bearer tokens in redirect fragments —
					// which the identity preflight correctly refuses to
					// start. The insecure realm has unit coverage
					// (stubPublicIssuer{implicitOn: true}); this fake models
					// the one the launcher actually creates.
					if q.Get("response_type") == "token" {
						http.Redirect(w, r, q.Get("redirect_uri")+"?error=unsupported_response_type", http.StatusFound)
						return
					}
					w.Header().Set("Content-Type", "text/html")
					w.WriteHeader(200)
					_, _ = w.Write([]byte("<html><body>Sign in to semiont</body></html>"))
					return
				}
				if r.URL.Path == "/realms/semiont/protocol/openid-connect/auth/device" {
					_ = r.ParseForm()
					// Only a real device-authorization request is recorded. The
					// identity preflight also probes this endpoint, sending
					// `client_id` alone — recording that too would overwrite what
					// `semiont login` wrote and the login assertions would read
					// the probe instead of the grant.
					if dir := os.Getenv("FAKERT_DIR"); dir != "" && r.PostForm.Get("scope") != "" {
						_ = os.WriteFile(filepath.Join(dir, "device-auth.txt"), []byte(r.PostForm.Encode()+"\n"), 0o644)
					}
					if m := os.Getenv("FAKERT_MISSING_CLIENT"); m != "" && r.PostForm.Get("client_id") == m {
						jsonOut(401, map[string]any{"error": "invalid_client"})
						return
					}
					if n := os.Getenv("FAKERT_NO_DEVICE_GRANT"); n != "" && r.PostForm.Get("client_id") == n {
						jsonOut(400, map[string]any{"error": "unauthorized_client"})
						return
					}
					jsonOut(200, map[string]any{
						"device_code":               "fake-device-code",
						"user_code":                 "FAKE-CODE",
						"verification_uri":          issuer + "/device",
						"verification_uri_complete": issuer + "/device?user_code=FAKE-CODE",
						"expires_in":                600,
						"interval":                  0,
					})
					return
				}
				if r.URL.Path == "/realms/semiont/protocol/openid-connect/token" {
					_ = r.ParseForm()
					// A realm whose browser client names the Browser's real
					// origin echoes it back; Keycloak matches web origins
					// EXACTLY, and one that derives them from the portless
					// loopback redirects answers 403 with no header at all.
					// The preflight's origin probe reads this and nothing else,
					// so a fake realm that omitted it would refuse every start.
					// FAKERT_ORIGIN_DENY models the realm that has the defect.
					if origin := r.Header.Get("Origin"); origin != "" {
						if os.Getenv("FAKERT_ORIGIN_DENY") != "" {
							jsonOut(403, map[string]any{"error": "Invalid origin"})
							return
						}
						w.Header().Set("Access-Control-Allow-Origin", origin)
					}
					switch r.PostForm.Get("grant_type") {
					case "urn:ietf:params:oauth:grant-type:device_code":
						if os.Getenv("FAKERT_DEVICE_DENY") != "" {
							jsonOut(400, map[string]any{"error": "access_denied"})
							return
						}
						pending := 1
						if n, err := strconv.Atoi(os.Getenv("FAKERT_DEVICE_PENDING")); err == nil {
							pending = n
						}
						if countDevicePoll() <= pending {
							jsonOut(400, map[string]any{"error": "authorization_pending"})
							return
						}
						jsonOut(200, map[string]any{
							"access_token": "fake-jwt-token", "refresh_token": "fake-refresh-token",
							"token_type": "Bearer", "expires_in": 300,
						})
					case "client_credentials":
						// A service account proving who it is, for the start's
						// identity preflight. The claims are the two the
						// launcher checks — a FLAT `roles` array and an `aud`
						// carrying the knowledge base's resource identity —
						// in the array form a real Keycloak emits, "account"
						// included.
						//
						// The audience comes from kb-resource.txt in
						// FAKERT_DIR, written by the test beside the KB
						// fixture it derives from, so the expected value is
						// stated once on that side rather than restated here.
						if dir := os.Getenv("FAKERT_DIR"); dir != "" {
							_ = os.WriteFile(filepath.Join(dir, "client-credentials.txt"),
								[]byte(r.PostForm.Get("client_id")+"\n"), 0o644)
						}
						aud := origin
						if dir := os.Getenv("FAKERT_DIR"); dir != "" {
							if b, err := os.ReadFile(filepath.Join(dir, "kb-resource.txt")); err == nil {
								if s := strings.TrimSpace(string(b)); s != "" {
									aud = s
								}
							}
						}
						// Every service client carries the service role; the worker
						// client ALSO carries the worker role, mirroring the realm's
						// grant so a worker's agent-token mint gets the capability
						// to claim jobs. Held to the same literal by
						// lint:service-role.
						roles := []string{"semiont-service"}
						if r.PostForm.Get("client_id") == "semiont-worker" {
							roles = append(roles, "semiont-worker")
						}
						jsonOut(200, map[string]any{
							"access_token": unsignedJWT(map[string]any{
								"roles": roles,
								"aud":   []string{aud, "account"},
								"azp":   r.PostForm.Get("client_id"),
							}),
							"token_type": "Bearer", "expires_in": 300,
						})
					case "refresh_token":
						if r.PostForm.Get("refresh_token") != "fake-refresh-token" {
							jsonOut(400, map[string]any{"error": "invalid_grant"})
							return
						}
						jsonOut(200, map[string]any{
							"access_token": "fake-jwt-token-2", "refresh_token": "fake-refresh-token",
							"token_type": "Bearer", "expires_in": 300,
						})
					default:
						jsonOut(400, map[string]any{"error": "unsupported_grant_type"})
					}
					return
				}
				if r.URL.Path == "/realms/semiont/protocol/openid-connect/revoke" {
					_ = r.ParseForm()
					if dir := os.Getenv("FAKERT_DIR"); dir != "" {
						_ = os.WriteFile(filepath.Join(dir, "revoked.txt"), []byte(r.PostForm.Encode()+"\n"), 0o644)
					}
					w.WriteHeader(200)
					return
				}
				// Session lifecycle. Login verifies its fresh token with the
				// gateway once, so "stale" means stale AFTER that first use —
				// an access token that expired between login and the verb.
				// FAKERT_STALE_TOKEN=1: the login-issued token is accepted
				// once, then reads as expired; the refresh grant above mints
				// fake-jwt-token-2, which every bearer endpoint accepts.
				// FAKERT_ALL_TOKENS_STALE=1: the login-issued token is accepted
				// once and NO bearer ever again, though refresh still succeeds
				// — the "refreshed but still rejected" scenario (account
				// disabled right after login).
				bearerOK := func() bool {
					a := r.Header.Get("Authorization")
					uses := countBearerUse(a)
					if os.Getenv("FAKERT_ALL_TOKENS_STALE") != "" {
						return a == "Bearer fake-jwt-token" && uses == 1
					}
					if a == "Bearer fake-jwt-token-2" {
						return true
					}
					if a != "Bearer fake-jwt-token" {
						return false
					}
					return os.Getenv("FAKERT_STALE_TOKEN") == "" || uses == 1
				}
				if r.URL.Path == "/api/users/me" {
					w.Header().Set("Content-Type", "application/json")
					if !bearerOK() {
						w.WriteHeader(401)
						_ = json.NewEncoder(w).Encode(map[string]any{"error": "token expired"})
						return
					}
					// The real UserResponse: a DID and the facts the token
					// carried. No row id, no provider, no role flags — the
					// gateway answers with none of those.
					_ = json.NewEncoder(w).Encode(map[string]any{
						"did":   "did:web:example.com:users:admin@example.com",
						"email": "admin@example.com", "name": nil, "image": nil,
						"domain": "example.com",
					})
					return
				}
				// The event bus. /bus/subscribe holds an SSE stream open and
				// replies to whatever /bus/emit receives, echoing the
				// caller's correlationId — the same contract the real
				// gateway keeps, so the launcher's subscribe-before-emit
				// ordering is exercised for real.
				// FAKERT_BUS_REPLY_<channel-with-colons-as-underscores>:
				// JSON `response` object for that operation's result.
				// FAKERT_BUS_FAIL=<message>: reply on the failure channel.
				if r.URL.Path == "/bus/emit" && r.Method == http.MethodPost {
					// Bearer-gated like the real route: the session refresh
					// a bus verb owes the user is only observable if an
					// expired token is actually refused here.
					if !bearerOK() {
						w.WriteHeader(401)
						return
					}
					var body struct {
						Channel       string         `json:"channel"`
						CorrelationID string         `json:"correlationId,omitempty"`
						Payload       map[string]any `json:"payload"`
					}
					_ = json.NewDecoder(r.Body).Decode(&body)
					// EVERY emit is appended, one JSON object per line. A
					// single last-emit file cannot tell a verb that sent two
					// commands from one that dropped the first — which is
					// exactly what a fan-out verb like `frame` must prove.
					if dir := os.Getenv("FAKERT_DIR"); dir != "" {
						b, _ := json.Marshal(body)
						if f, err := os.OpenFile(filepath.Join(dir, "bus-emit.jsonl"),
							os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
							_, _ = f.Write(append(b, '\n'))
							_ = f.Close()
						}
					}
					cid := body.CorrelationID
					if ch, payload := busReplyFor(body.Channel); ch != "" {
						busPublish(ch, cid, payload)
						// A created job then runs: progress, then a terminal
						// event, both keyed by jobId — never the correlationId
						// the request used.
						if body.Channel == "job:create" {
							jobID := "fake-job-1"
							// The job is the one that was asked for: its type and
							// its resource are the request's. A generation names no
							// resource (its context's focus does), so the fake's
							// stands in.
							jobType, _ := body.Payload["jobType"].(string)
							resourceID, _ := body.Payload["resourceId"].(string)
							if resourceID == "" {
								resourceID = "res-src"
							}
							job := func(more map[string]any) map[string]any {
								frame := map[string]any{"jobId": jobID, "resourceId": resourceID, "jobType": jobType}
								for k, v := range more {
									frame[k] = v
								}
								return frame
							}
							code := "analyzing"
							if jobType == "generation" {
								code = "generating-resource"
							}
							busPublish("job:report-progress", "", job(map[string]any{
								"progress": map[string]any{"message": map[string]any{"code": code}}}))
							// FAKERT_JOB_RETRY=<message>: the first attempt fails and
							// the queue runs the job again. That failure is an event
							// of a job still running, and the terminal event follows.
							if msg := os.Getenv("FAKERT_JOB_RETRY"); msg != "" {
								busPublish("job:fail", "", job(map[string]any{"error": msg, "attempt": 1, "willRetry": true}))
								busPublish("job:report-progress", "", job(map[string]any{
									"attempt": 2, "progress": map[string]any{"message": map[string]any{"code": code}}}))
							}
							if msg := os.Getenv("FAKERT_JOB_FAIL"); msg != "" {
								busPublish("job:fail", "", job(map[string]any{"error": msg}))
							} else {
								// FAKERT_JOB_RESULT=<json>: which member of the
								// JobResult union this job completes with. A
								// DECLINE is one of them — a job that ran fine
								// and deliberately produced nothing. Left unset,
								// the job completes as its type does.
								var result any = fakeJobResults[jobType]
								if raw := os.Getenv("FAKERT_JOB_RESULT"); raw != "" {
									var custom any
									if json.Unmarshal([]byte(raw), &custom) != nil {
										custom = map[string]any{}
									}
									result = custom
								}
								busPublish("job:complete", "", job(map[string]any{"result": result}))
							}
						}
					}
					// FIDELITY: the real gateway answers 202 with the number
					// of subscribers its target subject had at dispatch, and
					// the launcher's output turns on that number. Count the
					// fake's own live subscribers for that channel rather than
					// inventing one — a fake that always says "1" would let a
					// verb claim an audience it never had.
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusAccepted)
					_ = json.NewEncoder(w).Encode(map[string]any{"subscribers": busSubscriberCount(body.Channel)})
					return
				}
				if r.URL.Path == "/bus/subscribe" {
					if !bearerOK() {
						w.WriteHeader(401)
						return
					}
					// POST subscription matrix — one connection subscribing
					// to any number of resource scopes. Delivery here is flat
					// by channel — this fake never scope-gates.
					// ClientID is REQUIRED on the real route — it is the
					// address a correlated reply is routed to — and this fake
					// is the SERVER half of the pair, so it PARSES the field
					// rather than minting one. It stays contract-true by
					// refusing a subscribe without it, exactly as the gateway
					// does — otherwise a client that omits it passes the launcher
					// tests and surfaces only against a real gateway.
					var matrix struct {
						Global   []string `json:"global"`
						ClientID string   `json:"clientId"`
						Scoped   []struct {
							Scope    string   `json:"scope"`
							Channels []string `json:"channels"`
						} `json:"scoped"`
					}
					_ = json.NewDecoder(r.Body).Decode(&matrix)
					if matrix.ClientID == "" {
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					chans := append([]string{}, matrix.Global...)
					for _, e := range matrix.Scoped {
						chans = append(chans, e.Channels...)
					}
					sub := busSubscribe(chans)
					defer busUnsubscribe(sub)
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(http.StatusOK)
					if f, ok := w.(http.Flusher); ok {
						f.Flush() // headers = subscribed
					}
					for {
						select {
						case <-r.Context().Done():
							return
						case fr := <-sub.out:
							frame := map[string]any{"channel": fr.channel, "payload": fr.payload}
							if fr.corrID != "" {
								frame["correlationId"] = fr.corrID
							}
							data, _ := json.Marshal(frame)
							fmt.Fprintf(w, "event: bus-event\ndata: %s\n\n", data)
							if f, ok := w.(http.Flusher); ok {
								f.Flush()
							}
						}
					}
				}
				// The yield upload (sdk-go glue): capture the multipart —
				// fields, file bytes, auth header — for test assertions,
				// then answer 202 {resourceId} like the real create route.
				if r.URL.Path == "/resources" && r.Method == http.MethodPost {
					if !bearerOK() {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(401)
						_ = json.NewEncoder(w).Encode(map[string]any{"error": "token expired"})
						return
					}
					_ = r.ParseMultipartForm(16 << 20)
					capture := map[string]string{"authorization": r.Header.Get("Authorization")}
					if r.MultipartForm != nil {
						for k, v := range r.MultipartForm.Value {
							if len(v) > 0 {
								capture[k] = v[0]
							}
						}
					}
					if f, hdr, err := r.FormFile("file"); err == nil {
						b, _ := io.ReadAll(f)
						capture["filecontent"] = string(b)
						capture["filename"] = hdr.Filename
						_ = f.Close()
					}
					if dir := os.Getenv("FAKERT_DIR"); dir != "" {
						jb, _ := json.Marshal(capture)
						_ = os.WriteFile(filepath.Join(dir, "yield-upload.json"), jb, 0o644)
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusAccepted)
					_ = json.NewEncoder(w).Encode(map[string]any{"resourceId": "fake-resource-id"})
					return
				}
				// A fake Ollama, so model checks and pulls are exercisable.
				// FAKERT_OLLAMA_TAGS lists the models it already has (comma
				// separated); every pull is appended to a log the test reads.
				switch r.URL.Path {
				case "/api/tags":
					if os.Getenv("FAKERT_OLLAMA_UNLISTABLE") != "" {
						http.Error(w, "nope", 500)
						return
					}
					var ms []map[string]any
					for _, n := range strings.Split(os.Getenv("FAKERT_OLLAMA_TAGS"), ",") {
						if n = strings.TrimSpace(n); n != "" {
							ms = append(ms, map[string]any{"name": n, "size": 1 << 30})
						}
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"models": ms})
				case "/api/ps":
					_ = json.NewEncoder(w).Encode(map[string]any{"models": []any{}})
				case "/api/pull":
					body, _ := io.ReadAll(r.Body)
					var req struct {
						Model string `json:"model"`
					}
					_ = json.Unmarshal(body, &req)
					if dir := os.Getenv("FAKERT_DIR"); dir != "" {
						if f, err := os.OpenFile(filepath.Join(dir, "ollama-pulls"),
							os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
							fmt.Fprintln(f, req.Model)
							f.Close()
						}
					}
					if os.Getenv("FAKERT_OLLAMA_PULL_FAILS") != "" {
						_ = json.NewEncoder(w).Encode(map[string]any{"error": "no such model"})
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "success"})
				default:
					// No catch-all. A path this service does not serve
					// is a 404, which is what a wrong probe deserves and
					// what makes it indistinguishable from a service that is
					// down — because that is what it is.
					if !routes(r.URL.Path) {
						http.Error(w, "no such route on "+container, http.StatusNotFound)
						return
					}
					fmt.Fprintln(w, "ok")
				}
			}))
			close(done)
		}()
	}
	<-done // parked until killed
}

// copyTree: minimal recursive copy for the fake clone.
func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, info.Mode())
	})
}
