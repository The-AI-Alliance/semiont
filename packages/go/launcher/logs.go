package launcher

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
)

var logsUsage = fmt.Sprintf(`Usage: semiont logs [--service <name>] [--root <path>] [--runtime container|docker|podman] [--repo <owner/name>]

A bare invocation follows the stack of the knowledge base you stand in, else
the lone forwarded codespace stack, else the knowledge base you stand in by
its containers' names, started or not. Standing in none, it follows the one
stack here, else the lone recorded codespace; with several, say which.
--root targets a knowledge base's stack, --repo a codespace stack; --runtime
targets a local runtime.

Follow the Semiont service logs, one [svc]-prefixed stream per service.
Ctrl+C stops *following* — it does not stop the stack (that's semiont stop).

By default follows Semiont's own services (%s). With
--service <name>, follow any ONE service including the infrastructure roles:
%s.

The runtime and container identities come from the recorded stack state when
present (--runtime overrides); otherwise the stack is discovered by
name-scan.
`, strings.Join(logServices, ", "), listWrapped(roleList, 78, ""))

// logServices: the default follow set — Semiont's own services, the ones
// whose logs are ours to read. Derived, so a new Semiont service is followed
// the day it exists rather than the day somebody remembers this list.
var logServices = func() []string {
	var out []string
	for _, d := range serviceDescriptors {
		if d.driver == driverSemiont {
			out = append(out, d.role)
		}
	}
	return out
}()

// Logs implements `semiont logs`.
func Logs(args []string) int {
	u := NewUI(false)
	runtime := ""
	service := ""
	repoFlag := ""
	rootFlag := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--runtime":
			if i+1 >= len(args) {
				u.Fail("Missing value for --runtime")
				return 1
			}
			runtime = args[i+1]
			i++
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
				return 1
			}
			repoFlag = args[i+1]
			i++
		case "--root":
			if i+1 >= len(args) {
				u.Fail("Missing value for --root")
				return 1
			}
			rootFlag = args[i+1]
			i++
		case "--service":
			if i+1 >= len(args) {
				u.Fail("Missing value for --service")
				return 1
			}
			service = args[i+1]
			i++
		case "--help", "-h":
			fmt.Print(logsUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	src, ok := logSources(u, runtime, service, repoFlag, rootFlag)
	if !ok {
		return 1
	}
	fmt.Printf("Following %s — Ctrl+C stops following (semiont stop stops the stack)\n", strings.Join(src.follow, " · "))

	// Ctrl+C: stop following, never the stack.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	followLogs(ctx, src, func(service, stream, line string) {
		fmt.Println("[" + service + "] " + line)
	})
	return 0
}

// logSource: the containers a follow reads, and where.
type logSource struct {
	// follow: the services followed, in order.
	follow []string
	// handles: each service's container handle.
	handles map[string]string
	// runtime: the runtime the containers run under; csName, for a
	// codespace's, the codespace they run in instead.
	runtime, csName string
}

// command: the process that follows service's container.
func (src logSource) command(service string) *exec.Cmd {
	if src.csName != "" {
		return exec.Command("gh", "codespace", "ssh", "-c", src.csName, "--", "docker", "logs", "--follow", src.handles[service])
	}
	return exec.Command(src.runtime, "logs", "--follow", src.handles[service])
}

// logSources: the containers a follow of service (every Semiont service the
// stack runs, when "") reads, of the stack runtime, repo and root name as
// semiont logs takes them. ok=false: refused, and said.
func logSources(u *UI, runtime, service, repoFlag, rootFlag string) (logSource, bool) {
	if service != "" {
		if !knownRole(service) {
			u.Refuse(controlCodeInvalidService, "Unknown --service '%s' (expected: %s)", service, roleList)
			return logSource{}, false
		}
	}

	// The record supplies the runtime and container identities; --runtime
	// overrides, and a record about a different runtime doesn't apply. No
	// record: the historical name-scan discovery.
	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return logSource{}, false
	}
	cs := codespaceStacks(ss)
	// key: the state key of the knowledge base whose containers are
	// followed, which names them — a codespace's own launcher names its
	// stack's as this one does.
	st, key, ok := askedLocalStack(u, "logs", ss, rootFlag, repoFlag != "")
	if !ok {
		return logSource{}, false
	}
	rt := ""
	csName := ""
	// A codespace's containers are named for its knowledge base. Logs ride
	// ssh, so one whose identity no record holds (an adopted codespace) has
	// it read there.
	codespace := func(c *StackState) bool {
		did := c.KBDid
		if did == "" {
			remote, ok := fetchRemoteDid(u, c.Codespace.Name)
			if !ok {
				u.Refuse(controlCodeUnreachable, "%s's knowledge base could not be identified, so its containers cannot be named.", c.Codespace.Repo)
				return false
			}
			did = remote
		}
		csName, key, st = c.Codespace.Name, rootKey(did, ""), nil
		return true
	}
	if repoFlag != "" {
		target, ok := repoCodespaceStack(u, ss, repoFlag)
		if !ok {
			return logSource{}, false
		}
		if !onPath("gh") {
			u.RefusePlain(controlCodeDependencyUnavailable, "'gh' is not on PATH.")
			return logSource{}, false
		}
		if !codespace(target) {
			return logSource{}, false
		}
	} else if runtime != "" {
		if !onPath(runtime) {
			u.RefusePlain(controlCodeRuntimeUnavailable, "--runtime %s requested, but '%s' is not on PATH.", runtime, runtime)
			return logSource{}, false
		}
		rt = runtime
		if st != nil && st.Runtime != runtime {
			st = nil
		}
	} else if fwd := forwardedStacks(cs); len(fwd) == 1 && st == nil && rootFlag == "" {
		// Read-only commands look at what you're looking at: the lone
		// forwarded codespace stack wins a bare invocation. Logs ride ssh,
		// by wire-level container name (the codespace's launcher names them
		// exactly as this one does).
		if !onPath("gh") {
			u.RefusePlain(controlCodeDependencyUnavailable, "A codespace stack is forwarded but 'gh' is not on PATH.")
			return logSource{}, false
		}
		if !codespace(fwd[0]) {
			return logSource{}, false
		}
		u.Log("Using the forwarded codespace stack %s", u.Dim("("+csName+" per "+statePath()+")"))
	} else if st != nil && st.Runtime != "" && onPath(st.Runtime) {
		rt = st.Runtime
		u.Log("Using recorded stack state %s", u.Dim("("+rt+" per "+statePath()+")"))
	} else if key != "" {
		st = nil
		rt = stackRuntime(key)
	} else if len(cs) == 1 {
		if !onPath("gh") {
			u.RefusePlain(controlCodeDependencyUnavailable, "A codespace stack is recorded but 'gh' is not on PATH.")
			return logSource{}, false
		}
		if !codespace(cs[0]) {
			return logSource{}, false
		}
		u.Log("Using recorded codespace stack %s", u.Dim("("+csName+" per "+statePath()+")"))
	} else if len(cs) > 1 {
		u.RefuseChoosing(controlCodeTargetRequired, stackChoices(nil, cs), "Multiple codespace stacks are recorded — say which:  semiont logs --repo <owner/name>")
		for _, c := range cs {
			fmt.Fprintf(os.Stderr, "    recorded: %s\n", c.Codespace.Repo)
		}
		return logSource{}, false
	}
	if rt == "" && csName == "" {
		u.RefusePlain(controlCodeStackNotRunning, "No running Semiont stack found in any runtime (container/docker/podman).")
		fmt.Fprintln(os.Stderr, "Start one with semiont start, or pass --runtime explicitly.")
		return logSource{}, false
	}

	// handle: recorded runtime-issued ID when we have one, container name
	// otherwise. Roles someone else provides have no container to follow.
	handleFor := func(svc string) (string, bool) {
		if st != nil {
			if e, ok := st.Services[svc]; ok {
				switch e.Provided {
				case providedHost:
					u.Refuse(controlCodeInvalidService, "%s is provided by a host process — no container logs (check the host service's own logs).", svc)
					return "", false
				case providedExternal:
					u.Refuse(controlCodeInvalidService, "%s is externally provided (%s) — no local container logs.", svc, e.Endpoint)
					return "", false
				case providedNone:
					u.Refuse(controlCodeInvalidService, "%s is not referenced by the running stack's config — nothing to follow.", svc)
					return "", false
				case providedShared:
					// The shared container the stack's record names, by
					// the handle its own record names.
					return sharedHandles(rt, e.Container, LoadStackSet().Shared[e.Container])[0], true
				}
				if e.ID != "" {
					return e.ID, true
				}
			}
		}
		return roleContainer(svc, key), true
	}

	// The default set is the services this stack runs: one its config gives
	// nothing to do has no container to follow, and is refused only when
	// asked for by name.
	src := logSource{handles: map[string]string{}, runtime: rt, csName: csName}
	if service != "" {
		src.follow = []string{service}
	} else {
		for _, svc := range logServices {
			if st != nil && st.Services[svc].Provided == providedNone {
				continue
			}
			src.follow = append(src.follow, svc)
		}
	}
	for _, svc := range src.follow {
		if csName != "" { // codespace: wire-level names, no per-service record
			src.handles[svc] = roleContainer(svc, key)
			continue
		}
		h, ok := handleFor(svc)
		if !ok {
			return logSource{}, false
		}
		src.handles[svc] = h
	}
	return src, true
}

// followLogs follows each of src's containers until each ends, or ctx is
// done, which stops following and never the stack. Each line goes to emit,
// one at a time, with the service it is of and the stream it was on: each
// container's stderr is followed too — crash traces and uncaught exceptions
// land there, and they're exactly what a log follower exists to show.
func followLogs(ctx context.Context, src logSource, emit func(service, stream, line string)) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	var cmds []*exec.Cmd
	for _, svc := range src.follow {
		cmd := src.command(svc)
		stdout, err1 := cmd.StdoutPipe()
		stderr, err2 := cmd.StderrPipe()
		if err1 != nil || err2 != nil {
			continue
		}
		if err := cmd.Start(); err != nil {
			continue
		}
		cmds = append(cmds, cmd)
		for stream, pipe := range map[string]io.Reader{"stdout": stdout, "stderr": stderr} {
			wg.Add(1)
			go func(service, stream string, r io.Reader) {
				defer wg.Done()
				sc := bufio.NewScanner(r)
				sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
				for sc.Scan() {
					mu.Lock()
					emit(service, stream, sc.Text())
					mu.Unlock()
				}
			}(svc, stream, pipe)
		}
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		for _, cmd := range cmds {
			_ = cmd.Wait()
		}
		close(done)
	}()
	select {
	case <-ctx.Done():
		for _, cmd := range cmds {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
		<-done
	case <-done:
	}
}

// askedLocalStack: the local stack verb acts on by its containers' names, and
// the state key of its knowledge base: --root's, else the one you stand in,
// else, standing in none, the one recorded. st is nil for a knowledge base
// with no stack recorded, whose containers are found by name; key is "" when
// no knowledge base answers, and a codespace may. ok=false: refused — a
// codespace was named alongside --root, or several local stacks are recorded
// and none was named.
func askedLocalStack(u *UI, verb string, ss *StackSet, root string, repo bool) (st *StackState, key string, ok bool) {
	if repo && root != "" {
		u.Refuse(controlCodeInvalidRequest, "--repo and --root are contradictory: one names a codespace stack, the other a local one.")
		return nil, "", false
	}
	if repo {
		return nil, "", true
	}
	var asked kbRoot
	if root != "" {
		dir, ident, err := resolveRootArg(root)
		if err != nil {
			refuseRoot(u, err)
			return nil, "", false
		}
		asked = kbRoot{dir: dir, ident: ident}
	} else if kb, err := cwdKBRoot(); err != nil {
		u.Refuse(controlCodeRootNotFound, "%v", err)
		return nil, "", false
	} else {
		asked = kb
	}
	if asked.dir != "" {
		// The knowledge base asked of names its own containers, recorded or
		// not. A copy of it running from another clone is still its stack,
		// under the names it has here too.
		return localStack(ss, asked.key()), asked.key(), true
	}
	switch locals := localStacks(ss); len(locals) {
	case 0:
		return nil, "", true
	case 1:
		return locals[0], rootKey(locals[0].KBDid, locals[0].KBRoot), true
	default:
		u.RefuseChoosing(controlCodeTargetRequired, stackChoices(locals, codespaceStacks(ss)), "Multiple stacks are recorded — say which:")
		printStackMenu(verb, "", locals, codespaceStacks(ss))
		return nil, "", false
	}
}

// stackRuntime finds the runtime actually running the stack of the knowledge
// base keyed key: following via the wrong one shows nothing. It anchors on
// that stack's gateway by NAME — matching any "semiont-" would false-positive
// on unrelated containers (e.g. a local verdaccio).
func stackRuntime(key string) string {
	gateway := roleContainer("gateway", key)
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
			if len(fields) > 0 && fields[0] == gateway {
				return rt
			}
		}
	}
	return ""
}
