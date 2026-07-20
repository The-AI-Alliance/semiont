// fakert is the hermetic test double for every external command the launcher
// runs: the container runtimes (container / docker / podman) plus git, lsof,
// ps, and pgrep. The test harness symlinks this one binary under each of
// those names on a private PATH — tests never touch a real runtime (mutating
// commands are never test-run; this binary exists so that rule can hold).
//
// Behavior is scripted through FAKERT_* environment variables set per test:
//
//	FAKERT_LOG               append-one-line-per-invocation argv log (the golden seam)
//	FAKERT_DIR               scratch dir for serve pidfiles
//	FAKERT_GIT_ROOT          `git rev-parse --show-toplevel` output; unset = not a repo
//	FAKERT_LSOF_<port>       newline-separated PIDs "holding" the port; unset = free
//	FAKERT_PS_<pid>          comm= output for a PID (default "fakeproc")
//	FAKERT_NSLOOKUP          "ok" makes the host-alias probe succeed
//	FAKERT_GATEWAY           default-gateway probe output (default 192.168.64.1)
//	FAKERT_OLLAMA_REACHABLE  "1" makes the busybox wget probe of :11434 succeed
//	FAKERT_BACKEND_UNREACHABLE  "1" fails the busybox wget probe of :4000
//	FAKERT_NC_FAIL           "1" fails the busybox `nc -z` postgres probe
//	FAKERT_VOLUME_ABSENT     "1" makes `volume rm` fail (volume not found)
//	FAKERT_STACK_RUNTIME     which runtime's list/ps shows semiont-backend
//	FAKERT_PULL_FAIL         substring; pulls of matching images fail
//
// A detached `run -d ... -p A:B` spawns this binary in __serve mode listening
// on every published host port (HTTP 200 to any path, which also satisfies
// plain TCP dials) — that is how health gates open without a real stack.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "__serve" {
		serve(os.Args[2:])
		return
	}
	base := filepath.Base(os.Args[0])
	logArgv(base, os.Args[1:])
	switch base {
	case "git":
		git(os.Args[1:])
	case "lsof":
		lsof(os.Args[1:])
	case "ps":
		psCmd(os.Args[1:])
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
	if len(args) >= 2 && args[0] == "status" && args[1] == "--porcelain" {
		if os.Getenv("FAKERT_GIT_DIRTY") != "" {
			fmt.Println(" M .semiont/semiontconfig/anthropic.toml")
		}
		return
	}
	fmt.Fprintf(os.Stderr, "fakert git: unscripted args %v\n", args)
	os.Exit(64)
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
//	FAKERT_GH_ADMIN         admin.json content for `ssh -- cat .devcontainer/admin.json`
//
// `codespace ports forward A:B …` binds every host port and parks (the fake
// dev tunnel), writing a serve pidfile so killServes reaps it.
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
		// Shape mirrors the real endpoint (captured 2026-07-20). The default
		// is what a hostRequirements-declaring KB actually offers: GitHub
		// filters the 2-core class out.
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
		fmt.Println(applyWakes(body))
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
		// LOCAL one. Modelling this correctly is what would have caught the
		// reversed-argument bug found live on 2026-07-20.
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
			_ = os.WriteFile(filepath.Join(dir, "serve-gh-forward-"+ports[0]+".pid"),
				[]byte(strconv.Itoa(os.Getpid())), 0o644)
		}
		serve(ports)
	case "stop", "delete":
		// ok — argv log is the observable
	case "ssh":
		if os.Getenv("FAKERT_GH_SSH_FAIL") != "" {
			fmt.Fprintln(os.Stderr, "failed to start SSH server")
			os.Exit(1)
		}
		switch {
		case strings.HasSuffix(strings.TrimSpace(joined), "true"):
			// The wake probe: connecting is what resumes a codespace, so
			// record it — subsequent `list` calls must report it Available,
			// exactly as GitHub does.
			if dir := os.Getenv("FAKERT_DIR"); dir != "" {
				f, err := os.OpenFile(filepath.Join(dir, "woken"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
				if err == nil {
					for i, a := range args {
						if a == "-c" && i+1 < len(args) {
							fmt.Fprintln(f, args[i+1])
						}
					}
					f.Close()
				}
			}
		case strings.Contains(joined, "admin.json"):
			body := os.Getenv("FAKERT_GH_ADMIN")
			if body == "" {
				body = `{"email":"admin@example.com","password":"fake-admin-pw"}`
			}
			fmt.Println(body)
		case strings.Contains(joined, "docker exec"):
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

func lsof(args []string) {
	// The launcher calls `lsof -ti :<port>`.
	if len(args) != 2 || args[0] != "-ti" || !strings.HasPrefix(args[1], ":") {
		fmt.Fprintf(os.Stderr, "fakert lsof: unscripted args %v\n", args)
		os.Exit(64)
	}
	pids := os.Getenv("FAKERT_LSOF_" + strings.TrimPrefix(args[1], ":"))
	if pids == "" {
		os.Exit(1) // real lsof exits 1 when nothing matches
	}
	for _, p := range strings.Fields(pids) {
		fmt.Println(p)
	}
}

// opCmd fakes the 1Password CLI: the launcher calls `op read op://<path>`.
// FAKERT_OP_FAIL fails the read; FAKERT_OP_VALUE overrides the output.
func opCmd(args []string) {
	if len(args) != 2 || args[0] != "read" || !strings.HasPrefix(args[1], "op://") {
		fmt.Fprintf(os.Stderr, "fakert op: unscripted args %v\n", args)
		os.Exit(64)
	}
	if os.Getenv("FAKERT_OP_FAIL") != "" {
		fmt.Fprintln(os.Stderr, "[ERROR] authorization denied")
		os.Exit(1)
	}
	v := os.Getenv("FAKERT_OP_VALUE")
	if v == "" {
		v = "fake-op-secret"
	}
	fmt.Println(v)
}

func psCmd(args []string) {
	// The launcher calls `ps -p <pid> -o comm=`.
	if len(args) == 4 && args[0] == "-p" && args[2] == "-o" && args[3] == "comm=" {
		comm := os.Getenv("FAKERT_PS_" + args[1])
		if comm == "" {
			// A pid matching one of our own serve pidfiles IS the fake gh
			// forward — report it as gh, the comm the real forward has
			// (the launcher's forwardAlive depends on this).
			if dir := os.Getenv("FAKERT_DIR"); dir != "" {
				files, _ := filepath.Glob(filepath.Join(dir, "serve-*.pid"))
				for _, f := range files {
					if b, err := os.ReadFile(f); err == nil && strings.TrimSpace(string(b)) == args[1] {
						comm = "gh"
					}
				}
			}
		}
		if comm == "" {
			comm = "fakeproc"
		}
		fmt.Println(comm)
		return
	}
	fmt.Fprintf(os.Stderr, "fakert ps: unscripted args %v\n", args)
	os.Exit(64)
}

func runtimeCmd(base string, args []string) {
	if len(args) == 0 {
		os.Exit(64)
	}
	switch args[0] {
	case "stop":
		// Exit like real runtimes: 0 only when the container "exists" (a
		// serve pidfile is our existence marker), else nonzero — the
		// launcher's preflight counts prior containers from these codes.
		if !killServe(handleName(args[len(args)-1])) {
			fmt.Fprintln(os.Stderr, "Error: no such container")
			os.Exit(1)
		}
	case "rm":
		fmt.Fprintln(os.Stderr, "Error: no such container")
		os.Exit(1)
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
	case "list":
		// Apple container format: name in column 1.
		if os.Getenv("FAKERT_STACK_RUNTIME") == base {
			fmt.Println("ID              IMAGE                       STATE")
			fmt.Println("semiont-backend ghcr.io/x/semiont-backend  running")
		}
	case "ps":
		// docker/podman `ps --format {{.Names}}`: bare names.
		if os.Getenv("FAKERT_STACK_RUNTIME") == base {
			fmt.Println("semiont-backend")
		}
	case "logs":
		name := strings.TrimPrefix(handleName(args[len(args)-1]), "semiont-")
		fmt.Println(name + " out")
		fmt.Fprintln(os.Stderr, name+" err")
	case "exec":
		// The launcher's useradd bridge: exec <handle> semiont useradd <args…>.
		// FAKERT_EXEC_FAIL models the in-container CLI failing.
		if os.Getenv("FAKERT_EXEC_FAIL") != "" {
			fmt.Fprintln(os.Stderr, "Error: useradd failed")
			os.Exit(1)
		}
		fmt.Println("fakert exec ok")
	case "inspect":
		// Scripted via FAKERT_STATE_<svc> (svc = name minus "semiont-"),
		// e.g. FAKERT_STATE_backend=running. Unset = container not found.
		// With FAKERT_SECRET set, the env list carries the worker secret —
		// exercising the launcher's --service secret recovery.
		svc := strings.TrimPrefix(handleName(args[len(args)-1]), "semiont-")
		state := os.Getenv("FAKERT_STATE_" + svc)
		if state == "" {
			fmt.Fprintln(os.Stderr, "Error: no such container")
			os.Exit(1)
		}
		env := "[]"
		if s := os.Getenv("FAKERT_SECRET"); s != "" {
			env = fmt.Sprintf(`["PATH=/usr/bin","SEMIONT_WORKER_SECRET=%s"]`, s)
		}
		switch {
		case len(args) > 1 && args[1] == "-f":
			// docker/podman status form: inspect -f {{.State.Status}} <name>
			fmt.Println(state)
		case base == "container":
			fmt.Printf(`[{"configuration":{"initProcess":{"environment":%s}},"status":%q}]`+"\n", env, state)
		default:
			// docker/podman full form: inspect <name>
			fmt.Printf(`[{"Config":{"Env":%s},"State":{"Status":%q}}]`+"\n", env, state)
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

// run handles both probe containers (busybox) and detached service starts.
func run(args []string) {
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "busybox:1.38.0") {
		busybox(args, joined)
		return
	}
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
	if len(ports) > 0 {
		self, err := os.Executable()
		if err != nil {
			os.Exit(64)
		}
		cmd := exec.Command(self, append([]string{"__serve"}, ports...)...)
		cmd.Stdout, cmd.Stderr = nil, nil
		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "fakert run: serve spawn: %v\n", err)
			os.Exit(1)
		}
		if dir := os.Getenv("FAKERT_DIR"); dir != "" && name != "" {
			_ = os.WriteFile(filepath.Join(dir, "serve-"+name+".pid"),
				[]byte(strconv.Itoa(cmd.Process.Pid)), 0o644)
		}
	}
	// The container identifier the runtime reports — name-derived so tests
	// can assert id-based stop/status flows ("fid-semiont-backend").
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

// applyWakes reports a woken codespace as Available regardless of the
// scripted initial state — a stopped codespace that something connected to
// really does come back, and a fake that never transitions would let the
// launcher wait forever (it did, until this was added).
func applyWakes(body string) string {
	dir := os.Getenv("FAKERT_DIR")
	if dir == "" {
		return body
	}
	b, err := os.ReadFile(filepath.Join(dir, "woken"))
	if err != nil {
		return body
	}
	var entries []map[string]any
	if json.Unmarshal([]byte(body), &entries) != nil {
		return body
	}
	for _, name := range strings.Fields(string(b)) {
		for _, e := range entries {
			if e["name"] == name {
				e["state"] = "Available"
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
	switch {
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
			if os.Getenv("FAKERT_BACKEND_UNREACHABLE") != "" {
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
	if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
		if p, err := os.FindProcess(pid); err == nil {
			_ = p.Kill()
		}
	}
	_ = os.Remove(pidfile)
	return true
}

// serve listens on every given port, answering 200 to any HTTP request; the
// open listener also satisfies the launcher's raw TCP dial (postgres phase 1).
func serve(ports []string) {
	done := make(chan struct{})
	for _, p := range ports {
		ln, err := net.Listen("tcp", "127.0.0.1:"+p)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fakert serve: %v\n", err)
			os.Exit(1)
		}
		go func() {
			_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintln(w, "ok")
			}))
			close(done)
		}()
	}
	<-done // parked until killed
}
