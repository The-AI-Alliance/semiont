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
	"fmt"
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
	fmt.Fprintf(os.Stderr, "fakert git: unscripted args %v\n", args)
	os.Exit(64)
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

func psCmd(args []string) {
	// The launcher calls `ps -p <pid> -o comm=`.
	if len(args) == 4 && args[0] == "-p" && args[2] == "-o" && args[3] == "comm=" {
		comm := os.Getenv("FAKERT_PS_" + args[1])
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
