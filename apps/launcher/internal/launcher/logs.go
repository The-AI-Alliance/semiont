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

const logsUsage = `Usage: semiont logs [--runtime container|docker|podman]

Follow the Semiont service logs, one [svc]-prefixed stream per service.
Ctrl+C stops *following* — it does not stop the stack (that's semiont stop).

Pass the same --runtime you started with; default is the runtime actually
running the stack.
`

var logServices = []string{"backend", "worker", "smelter", "weaver", "frontend"}

// Logs implements `semiont logs` — the port of the fleet's logs.sh.
func Logs(args []string) int {
	u := newUI(false)
	runtime := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--runtime":
			if i+1 >= len(args) {
				u.fail("Missing value for --runtime")
				return 1
			}
			runtime = args[i+1]
			i++
		case "--help", "-h":
			fmt.Print(logsUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	rt := ""
	if runtime != "" {
		if !onPath(runtime) {
			fmt.Fprintf(os.Stderr, "--runtime %s requested, but '%s' is not on PATH.\n", runtime, runtime)
			return 1
		}
		rt = runtime
	} else {
		rt = stackRuntime()
	}
	if rt == "" {
		fmt.Fprintln(os.Stderr, "No running Semiont stack found in any runtime (container/docker/podman).")
		fmt.Fprintln(os.Stderr, "Start one with semiont start, or pass --runtime explicitly.")
		return 1
	}

	fmt.Println("Following backend · worker · smelter · weaver · frontend — Ctrl+C stops following (semiont stop stops the stack)")

	// One follower per service; each container's stderr is kept in-stream —
	// crash traces and uncaught exceptions land there, and they're exactly
	// what a log follower exists to show.
	var mu sync.Mutex
	var wg sync.WaitGroup
	var cmds []*exec.Cmd
	for _, svc := range logServices {
		cmd := exec.Command(rt, "logs", "--follow", "semiont-"+svc)
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
