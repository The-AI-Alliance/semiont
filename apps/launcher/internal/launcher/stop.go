package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const stopUsage = `Usage: semiont stop [--service <name>] [--runtime container|docker|podman] [--repo <owner/name>] [--delete] [--dry-run]

Stop the whole Semiont stack — services, dependencies, and observability —
and clean up the staged config copies. Safe to run when nothing is up:
every step is a no-op then. Persistent stack state (PostgreSQL, Qdrant,
Neo4j data) is deliberately LEFT: the next start reuses it. Removing it is
its own explicit command: semiont clean.

With no --runtime, EVERY installed runtime is swept — stopping via the wrong
runtime is a silent no-op that leaves the real stack running.

With --service <name>, stop just that one service (backend, worker, smelter,
weaver, frontend, database, graph, vectors, inference, or traces). The staged
config copies are left in place — the rest of the stack is still mounting
them.

A CODESPACE stack (started with --runtime codespace) stops with
'gh codespace stop': billing halts, state and credentials persist, and the
record is kept — resume with semiont start. --delete destroys the codespace
(state and all) and forgets the record; it applies only to codespace stacks.
With several stacks recorded (local + codespaces), the working directory
disambiguates: from inside the clone whose LOCAL stack is running, a bare
stop means that stack; from a clone whose git origin names a recorded
codespace stack (and no local stack exists), it means that one. Anywhere
less certain, stop refuses and lists the choices: --repo <owner/name>
targets a codespace stack, --runtime targets the local one.
`

// stopNames sweeps all ten container names in REVERSE start order —
// dependents before their dependencies, so nothing spends teardown alive
// with its upstream already gone (start brings up jaeger → neo4j → qdrant →
// ollama → postgres → backend → worker → smelter → weaver → frontend).
// semiont-frontend is deliberately ABSENT: the Browser is not a stack
// member (BROWSER-LIFECYCLE.md) — a bare stop leaves the viewer running
// (announced), and `stop --service frontend` is its explicit off-switch.
var stopNames = []string{
	"semiont-weaver", "semiont-smelter", "semiont-worker",
	"semiont-backend", "semiont-postgres", "semiont-ollama", "semiont-qdrant",
	"semiont-neo4j", "semiont-jaeger",
}

// Stop implements `semiont stop` — the port of the fleet's stop.sh.
func Stop(args []string) int {
	u := newUI(false)
	runtime := ""
	service := ""
	repo := ""
	dryRun := false
	del := false
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
		case "--repo":
			if i+1 >= len(args) {
				u.fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
		case "--delete":
			del = true
		case "--dry-run":
			dryRun = true
		case "--help", "-h":
			fmt.Print(stopUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	// --service frontend targets the machine-level Browser, not a stack
	// member: stop its container (record ID preferred), clear its record,
	// and never touch stack state.
	if service == "frontend" && repo == "" {
		ssPre := loadStackSet()
		b := ssPre.Browser
		if b == nil {
			u.log("No Browser is recorded — sweeping the container name to be sure.")
		}
		// Sweep BOTH the recorded ID and the stable name: a stale ID
		// (container recreated outside this record) would no-op while the
		// name still runs — an off-switch that doesn't switch off (Copilot
		// review, PR #1064). Idempotent; the name pass is free when the ID
		// already got it.
		handles := []string{"semiont-frontend"}
		if b != nil && b.ID != "" {
			handles = []string{b.ID, "semiont-frontend"}
		}
		if dryRun {
			fmt.Println("# stop the Browser (machine-level; stacks untouched):")
			for _, h := range handles {
				fmt.Printf("<rt> stop %s\n<rt> rm %s\n", h, h)
			}
			return 0
		}
		stopped := false
		for _, rt := range installedRuntimes() {
			for _, h := range handles {
				s1 := runSilent(rt, "stop", h) == nil
				s2 := runSilent(rt, "rm", h) == nil
				stopped = stopped || s1 || s2
			}
		}
		clearBrowser()
		if stopped {
			u.ok("Browser stopped %s", u.dim("(stacks untouched; any start brings it back)"))
		} else {
			u.log("Browser was not running.")
		}
		return 0
	}

	// serviceContainer: the container --service targets. Usually the roles
	// table's; a container-less role (embedding) normally has nothing to
	// stop — UNLESS it launched the shared Ollama itself (all-remote
	// bindings), in which case the record names the container it ran.
	serviceContainer := ""
	if service != "" {
		if _, known := roles[service]; !known {
			u.fail("Unknown --service '%s' (expected: %s)", service, roleList)
			return 1
		}
		serviceContainer = roles[service].container
		if serviceContainer == "" {
			if st := loadLocalState(); st != nil {
				if e, ok := st.Services[service]; ok && e.Provided == providedLauncher && e.Container != "" {
					serviceContainer = e.Container
				}
			}
		}
		if serviceContainer == "" {
			u.log("%s is externally provided — nothing to stop.", service)
			fmt.Fprintf(os.Stdout, "  %s\n", u.dim("(external roles participate in status; start and stop belong to whatever provides them)"))
			return 0
		}
	}

	// Which runtimes to sweep: the requested one, or EVERY installed runtime.
	// Stopping is idempotent (stop/rm of absent names are no-ops), so sweeping
	// all runtimes structurally kills the classic trap: a bare `semiont stop`
	// after `semiont start --runtime docker` picking a different runtime,
	// reporting success, and leaving the real stack running.
	// The recorded stack state (when present) says which runtime started the
	// stack and what identifiers it reported — stop computes its work from
	// those instead of a blind every-runtime name sweep. An explicit
	// --runtime overrides; no record (older launcher, other machine) falls
	// back to the historical sweep.
	ss := loadStackSet()
	cs := codespaceStacks(ss)
	st := ss.Stacks["local"]

	// Codespace stacks: --repo targets one; a bare stop resolves only when
	// unambiguous (destructive commands don't guess among stacks). An
	// explicit --runtime keeps its narrow local meaning. --delete means
	// nothing for local stacks (stop+rm already destroys them).
	if repo != "" {
		target := ss.Stacks["codespace:"+repo]
		if target == nil {
			u.fail("No codespace stack recorded for %s.", repo)
			for _, c := range cs {
				fmt.Fprintf(os.Stderr, "    recorded: %s\n", c.Repo)
			}
			return 1
		}
		return stopCodespace(u, target, service, del, dryRun)
	}
	if runtime == "" && len(cs) > 0 {
		// The cwd disambiguates before anyone is asked to — the same rule
		// start keeps (standing in a KB clone is explicit context). The
		// LOCAL stack when this very root is the one it runs; the codespace
		// stack this clone's origin names when no local stack exists.
		// Anything less certain still refuses: stop doesn't guess, but it
		// also must not demand --runtime container from a user standing in
		// the exact clone whose stack is up (observed 2026-07-20).
		root := cwdKBRoot()
		localHere := st != nil && st.KBRoot != "" && st.KBRoot == root
		if !localHere {
			if st == nil {
				if len(cs) == 1 {
					return stopCodespace(u, cs[0], service, del, dryRun)
				}
				if c := originCodespace(cs, root); c != nil {
					u.log("Stopping %s %s", u.bold(c.Repo), u.dim("(this clone's origin; per "+statePath()+")"))
					return stopCodespace(u, c, service, del, dryRun)
				}
			}
			u.fail("Multiple stacks are recorded — say which:")
			if st != nil {
				fmt.Fprintf(os.Stderr, "    semiont stop --runtime %s   (the local stack)\n", st.Runtime)
			}
			for _, c := range cs {
				fmt.Fprintf(os.Stderr, "    semiont stop --repo %s\n", c.Repo)
			}
			return 1
		}
	}
	if del {
		u.fail("--delete only applies to a codespace stack (a local stop already removes the containers).")
		return 1
	}

	// The ports this stack claimed, captured before the record may be
	// discarded below — release verification reads them after the sweep.
	recordedPorts := []int(nil)
	if st != nil {
		recordedPorts = st.Ports
	}
	var runtimes []string
	if runtime != "" {
		if !onPath(runtime) {
			fmt.Fprintf(os.Stderr, "--runtime %s requested, but '%s' is not on PATH.\n", runtime, runtime)
			return 1
		}
		runtimes = []string{runtime}
	} else if st != nil && st.Runtime != "" && onPath(st.Runtime) {
		runtimes = []string{st.Runtime}
		u.log("Using recorded stack state %s", u.dim("("+st.Runtime+" per "+statePath()+")"))
	} else {
		if st == nil && runtime == "" && !dryRun {
			u.log("No recorded stack %s — sweeping all installed runtimes by name.", u.dim("(stack.json absent)"))
		}
		st = nil // ignore an unusable record; sweep by name
		runtimes = installedRuntimes()
	}
	if len(runtimes) == 0 {
		u.fail("No container runtime found. Install Apple Container, Docker, or Podman.")
		return 1
	}
	// Identifiers come from the record only when sweeping exactly the
	// recorded runtime — IDs are runtime-specific.
	useState := st != nil && (runtime == "" || runtime == st.Runtime)

	// One service, or the whole stack (reverse-start order). With a record: a
	// host-reuse inference entry means no container exists — skip it; a
	// recorded ID is the sharper handle than the name.
	targets := func() []string {
		names := stopNames
		if service != "" {
			names = []string{serviceContainer}
		}
		if !useState {
			return names
		}
		out := make([]string, 0, len(names))
		for _, c := range names {
			role := roleByContainer[c]
			if e, ok := st.Services[role]; ok {
				// Only containers this launcher started are ours to stop:
				// host processes, external endpoints, and unreferenced roles
				// have nothing to sweep.
				if e.Provided != "" && e.Provided != providedLauncher {
					// …unless a container-less role launched this very
					// container under its own account: an embedding-owned
					// semiont-ollama while inference is external Anthropic.
					// Skipping here would leak a running Ollama past stop.
					for _, e2 := range st.Services {
						if e2.Container == c && e2.Provided == providedLauncher {
							if e2.ID != "" {
								out = append(out, e2.ID)
							} else {
								out = append(out, c)
							}
							break
						}
					}
					continue
				}
				if e.ID != "" {
					out = append(out, e.ID)
					continue
				}
			}
			out = append(out, c)
		}
		return out
	}()

	// A bare full stop that used the record ALSO name-sweeps every other
	// installed runtime: strays there (an older launcher, a hand-erased
	// record) hold ports the record knows nothing about. Idempotent no-ops
	// when clean; explicit --runtime keeps its narrow meaning.
	strayRuntimes := []string(nil)
	if runtime == "" && useState && service == "" {
		for _, rt := range installedRuntimes() {
			if rt != runtimes[0] {
				strayRuntimes = append(strayRuntimes, rt)
			}
		}
	}

	if dryRun {
		fmt.Println("# semiont stop --dry-run — the exact runtime commands a real run would")
		fmt.Println("# execute, in order.")
		for _, rt := range runtimes {
			for _, c := range targets {
				fmt.Println(renderCmd(rt, "stop", c))
				fmt.Println(renderCmd(rt, "rm", c))
			}
		}
		for _, rt := range strayRuntimes {
			fmt.Println("# sweep stray Semiont containers under " + rt + ":")
			for _, c := range stopNames {
				fmt.Println(renderCmd(rt, "stop", c))
				fmt.Println(renderCmd(rt, "rm", c))
			}
		}
		switch {
		case service != "":
			fmt.Println("# staged config copies left in place (--service)")
		case st != nil && !useState:
			fmt.Println("# staged config copies and stack.json left in place (recorded stack is under " + st.Runtime + ")")
		default:
			fmt.Println("# remove staged config copies: /tmp/semiont-config.*")
			fmt.Println("# wait until the stack's ports are released; report any still-held holder")
		}
		return 0
	}

	// stop-then-rm: under Apple Container a stopped --rm container persists
	// (the next `run --name` would fail with "already exists"), so rm makes
	// this idempotent across all three states: running, stopped, absent.
	u.log("Sweeping %d container(s) across %s %s", len(targets),
		strings.Join(runtimes, ", "), u.dim("(stop+rm each; exact commands: semiont stop --dry-run)"))
	totalRemoved := 0
	for _, rt := range runtimes {
		t0 := time.Now()
		removed := 0
		for _, c := range targets {
			stopped := runSilent(rt, "stop", c) == nil
			rmed := runSilent(rt, "rm", c) == nil
			if stopped || rmed {
				removed++
			}
		}
		totalRemoved += removed
		elapsed := u.dim("(" + took(time.Since(t0)) + ")")
		if removed == 0 {
			u.ok("%s: none found %s", rt, elapsed)
		} else {
			u.ok("%s: %d removed %s", rt, removed, elapsed)
		}
	}
	for _, rt := range strayRuntimes {
		removed := 0
		for _, c := range stopNames {
			stopped := runSilent(rt, "stop", c) == nil
			rmed := runSilent(rt, "rm", c) == nil
			if stopped || rmed {
				removed++
			}
		}
		totalRemoved += removed
		if removed > 0 {
			u.warn("%s: %d stray container(s) removed (not in the record).", rt, removed)
		}
	}

	if service != "" {
		// The record forgets this one service; the rest of it stands.
		if useState {
			delete(st.Services, service)
			saveStack(st)
		}
		fmt.Printf("%s stopped (staged configs left in place; rest of the stack untouched).\n", service)
		return 0
	}

	// Shared-artifact cleanup is safe only when this sweep actually covered
	// the recorded stack (or no record exists): with an explicit --runtime
	// that mismatches the record, the REAL stack may still be running — its
	// staged configs are live mounts (deleting them under a running backend
	// is the measured Apple-container failure this staging exists to
	// prevent), and its record still describes reality.
	if st != nil && !useState {
		u.warn("Recorded stack (under %s) left untouched — staged configs and stack.json kept.", st.Runtime)
		fmt.Printf("Swept %s only. Run semiont stop (without --runtime) to tear down the recorded stack.\n", strings.Join(runtimes, ", "))
		return 0
	}

	// Per-service config copies staged by semiont start for the bind mounts.
	staged, _ := filepath.Glob("/tmp/semiont-config.*")
	removeStagedConfigs()
	if len(staged) > 0 {
		u.ok("Removed %d staged config dir(s)", len(staged))
	}
	forgetStack("local")

	// Say what actually happened: a stop that found nothing anywhere (the
	// second stop in a row) is a no-op, not a teardown.
	if totalRemoved == 0 && len(staged) == 0 {
		fmt.Println("No Semiont containers found — nothing to stop.")
		return 0
	}
	ports := recordedPorts
	if len(ports) == 0 {
		ports = fiatPorts
	}
	verifyPortsReleased(u, ports)
	fmt.Println("Semiont stack stopped.")
	// The Browser deliberately survives a stack stop — it is the machine's
	// viewer, not a stack member. Say so, with the off-switch: silence here
	// would read as a leak.
	if b := loadStackSet().Browser; b != nil && b.Endpoint != "" && httpOK(b.Endpoint) {
		fmt.Printf("Browser still running on %s %s\n", b.Endpoint, u.dim("(not a stack member; stop it with: semiont stop --service frontend)"))
	}
	return 0
}

// fiatPorts: the launcher-owned ports every stack claims regardless of
// config — the release-verification fallback when no record captured the
// stack's exact claims (older launcher's record, name-sweep path). 3000 is
// absent: the Browser is not a stack member and its port is not the
// stack's to verify.
var fiatPorts = []int{9090, 9091, 9092, 16686, 4318}

// verifyPortsReleased: stop's job isn't done until the ports are actually
// free — runtimes release published ports asynchronously (Apple container's
// forwarders especially), and a start right after a stop must not trip over
// them. Poll briefly to absorb lazy teardown, then REPORT any survivor with
// its holder. Never kills: after the sweeps above, a holder is provably not
// a Semiont container.
func verifyPortsReleased(u *ui, ports []int) {
	deadline := time.Now().Add(3 * time.Second)
	var held []int
	for {
		held = held[:0]
		for _, p := range ports {
			if out, err := capture("lsof", "-ti", fmt.Sprintf(":%d", p)); err == nil && out != "" {
				held = append(held, p)
			}
		}
		if len(held) == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if len(held) == 0 {
		u.ok("All stack ports released")
		return
	}
	for _, p := range held {
		out, _ := capture("lsof", "-ti", fmt.Sprintf(":%d", p))
		u.warn("Port %d is still held by %s — not a Semiont container; the next start will fail on it.",
			p, describeProcs(strings.Fields(out)))
	}
}

// Version implements `semiont version`.
func Version(args []string) int {
	fmt.Printf("semiont %s (commit %s, built %s)\n", BuildVersion, BuildCommit, BuildDate)
	return 0
}
