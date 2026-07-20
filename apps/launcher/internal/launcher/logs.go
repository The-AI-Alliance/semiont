package launcher

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
)

const logsUsage = `Usage: semiont logs [--service <name>] [--runtime container|docker|podman]

Follow the Semiont service logs, one [svc]-prefixed stream per service.
Ctrl+C stops *following* — it does not stop the stack (that's semiont stop).

By default follows the five Semiont services (backend, worker, smelter,
weaver, frontend). With --service <name>, follow any ONE service including
the infrastructure roles: backend, worker, smelter, weaver, frontend,
database, graph, vectors, inference, or traces.

The runtime and container identities come from the recorded stack state when
present (--runtime overrides); otherwise the stack is discovered by
name-scan.
`

var logServices = []string{"backend", "worker", "smelter", "weaver", "frontend"}

// Logs implements `semiont logs` — the port of the fleet's logs.sh.
func Logs(args []string) int {
	u := newUI(false)
	runtime := ""
	service := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--runtime":
			if i+1 >= len(args) {
				u.fail("Missing value for --runtime")
				return 1
			}
			runtime = args[i+1]
			i++
		case "--service":
			if i+1 >= len(args) {
				u.fail("Missing value for --service")
				return 1
			}
			service = args[i+1]
			i++
		case "--help", "-h":
			fmt.Print(logsUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	if service != "" {
		if _, known := roles[service]; !known {
			u.fail("Unknown --service '%s' (expected: %s)", service, roleList)
			return 1
		}
	}

	// The record supplies the runtime and container identities; --runtime
	// overrides, and a record about a different runtime doesn't apply. No
	// record: the historical name-scan discovery.
	st := loadState()
	rt := ""
	csName := ""
	if runtime != "" {
		if !onPath(runtime) {
			fmt.Fprintf(os.Stderr, "--runtime %s requested, but '%s' is not on PATH.\n", runtime, runtime)
			return 1
		}
		rt = runtime
		if st != nil && st.Runtime != runtime {
			st = nil
		}
	} else if st != nil && st.Runtime == "codespace" {
		// Codespace stack: logs ride ssh, by wire-level container name (the
		// shared contract with compose inside the codespace).
		if !onPath("gh") {
			fmt.Fprintln(os.Stderr, "A codespace stack is recorded but 'gh' is not on PATH.")
			return 1
		}
		csName = st.Codespace
		u.log("Using recorded codespace stack %s", u.dim("("+csName+" per "+statePath()+")"))
	} else if st != nil && st.Runtime != "" && onPath(st.Runtime) {
		rt = st.Runtime
		u.log("Using recorded stack state %s", u.dim("("+rt+" per "+statePath()+")"))
	} else {
		st = nil
		rt = stackRuntime()
	}
	if rt == "" && csName == "" {
		fmt.Fprintln(os.Stderr, "No running Semiont stack found in any runtime (container/docker/podman).")
		fmt.Fprintln(os.Stderr, "Start one with semiont start, or pass --runtime explicitly.")
		return 1
	}

	// handle: recorded runtime-issued ID when we have one, container name
	// otherwise. Roles someone else provides have no container to follow.
	handleFor := func(svc string) (string, bool) {
		if st != nil {
			if e, ok := st.Services[svc]; ok {
				switch e.Provided {
				case providedHost:
					u.fail("%s is provided by a host process — no container logs (check the host service's own logs).", svc)
					return "", false
				case providedExternal:
					u.fail("%s is externally provided (%s) — no local container logs.", svc, e.Endpoint)
					return "", false
				case providedNone:
					u.fail("%s is not referenced by the running stack's config — nothing to follow.", svc)
					return "", false
				}
				if e.ID != "" {
					return e.ID, true
				}
			}
		}
		return roles[svc].container, true
	}

	follow := logServices
	if service != "" {
		follow = []string{service}
	}
	targets := make(map[string]string, len(follow)) // svc → handle
	for _, svc := range follow {
		if csName != "" { // codespace: wire-level names, no per-service record
			targets[svc] = roles[svc].container
			continue
		}
		h, ok := handleFor(svc)
		if !ok {
			return 1
		}
		targets[svc] = h
	}

	fmt.Printf("Following %s — Ctrl+C stops following (semiont stop stops the stack)\n", strings.Join(follow, " · "))

	// One follower per service; each container's stderr is kept in-stream —
	// crash traces and uncaught exceptions land there, and they're exactly
	// what a log follower exists to show.
	var mu sync.Mutex
	var wg sync.WaitGroup
	var cmds []*exec.Cmd
	for _, svc := range follow {
		var cmd *exec.Cmd
		if csName != "" {
			cmd = exec.Command("gh", "codespace", "ssh", "-c", csName, "--", "docker", "logs", "--follow", targets[svc])
		} else {
			cmd = exec.Command(rt, "logs", "--follow", targets[svc])
		}
		stdout, err1 := cmd.StdoutPipe()
		stderr, err2 := cmd.StderrPipe()
		if err1 != nil || err2 != nil {
			continue
		}
		if err := cmd.Start(); err != nil {
			continue
		}
		cmds = append(cmds, cmd)
		prefix := "[" + svc + "] "
		for _, pipe := range []interface{ Read([]byte) (int, error) }{stdout, stderr} {
			wg.Add(1)
			go func(r interface{ Read([]byte) (int, error) }) {
				defer wg.Done()
				sc := bufio.NewScanner(r)
				sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
				for sc.Scan() {
					mu.Lock()
					fmt.Println(prefix + sc.Text())
					mu.Unlock()
				}
			}(pipe)
		}
	}

	// Ctrl+C: stop following, never the stack.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		wg.Wait()
		for _, cmd := range cmds {
			_ = cmd.Wait()
		}
		close(done)
	}()
	select {
	case <-sig:
		for _, cmd := range cmds {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	case <-done:
	}
	return 0
}

// stackRuntime finds the runtime actually running the stack: following via
// the wrong one shows nothing. It anchors on semiont-backend by NAME —
// matching any "semiont-" would false-positive on unrelated containers
// (e.g. a local verdaccio).
func stackRuntime() string {
	for _, rt := range runtimeOrder {
		if !onPath(rt) {
			continue
		}
		var out string
		var err error
		if rt == "container" {
			out, err = capture(rt, "list")
		} else {
			out, err = capture(rt, "ps", "--format", "{{.Names}}")
		}
		if err != nil {
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 && fields[0] == "semiont-backend" {
				return rt
			}
		}
	}
	return ""
}
