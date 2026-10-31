package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

var stopUsage = fmt.Sprintf(`Usage: semiont stop [--service <name>] [--runtime container|docker|podman] [--repo <owner/name>] [--delete] [--dry-run]

Stop the whole Semiont stack — services, dependencies, and observability —
and the machine's Ollama and the Browser, and clean up the staged configs.
Safe to run when nothing is up: every step is a no-op then. Persistent stack
state (PostgreSQL, Qdrant, Neo4j data) is deliberately LEFT: the next start
reuses it. Removing it is its own explicit command: semiont clean.

With no --runtime, EVERY installed runtime is swept — stopping via the wrong
runtime is a silent no-op that leaves the real stack running.

With --service <name>, stop just that one service:

%s.

--service browser stops the Browser alone. --service inference stops the
machine's Ollama alone, as --service embedding does where the stack runs it
for the embeddings alone: it serves every KB whose engines name Ollama, so a
stop of any other one service leaves it.

The staged configs are left in place — the rest of the stack is still
mounting them.

A CODESPACE stack (started with --runtime codespace) stops with
'gh codespace stop': billing halts, state and credentials persist, and the
record is kept — resume with semiont start. --delete destroys the codespace
(state and all) and forgets the record; it applies only to codespace stacks.
With several stacks recorded (local + codespaces), the working directory
disambiguates: from inside the clone whose LOCAL stack is running, a bare
stop means that stack; from a clone whose git origin names a recorded
codespace stack (and no local stack exists), it means that one. Anywhere
less certain, stop refuses and lists the choices: --repo <owner/name>
targets a codespace stack, --runtime targets the local one. A stop named
with --repo stops that codespace stack alone, and leaves the Browser.
`, roleListWrapped(78, ""))

// stopNames: every stack container `semiont stop` tears down, in teardown
// order — the start walk reversed, so nothing spends teardown alive with its
// upstream already gone.
//
// The machine-level containers are not among them: the Browser and the
// machine's Ollama each have a record of their own, and may run under another
// runtime than the stack, so stopMachineServices stops them after the stack,
// from those records. The exemptions are gated by descriptor_census_test.go.
var stopNames = sweepNames("browser", "inference")

// machineHandles: what names the machine-level container `name` under rt:
// its name, and its recorded ID where rt is the runtime its record names, an
// ID being that runtime's own. Both are swept: a stale ID (the container
// recreated outside the record) would no-op while the name still runs.
func machineHandles(rt, name string, rec *ServiceState) []string {
	if rec != nil && rec.ID != "" && rec.Runtime == rt {
		return []string{rec.ID, name}
	}
	return []string{name}
}

// stopMachineContainer stops and removes the machine-level container `name`
// under each of runtimes. True when there was one to stop.
func stopMachineContainer(runtimes []string, name string, rec *ServiceState) bool {
	stopped := false
	for _, rt := range runtimes {
		for _, h := range machineHandles(rt, name, rec) {
			s1 := runSilent(rt, "stop", h) == nil
			s2 := runSilent(rt, "rm", h) == nil
			stopped = stopped || s1 || s2
		}
	}
	return stopped
}

// printMachineStop prints what stopMachineContainer would run, for a dry run.
func printMachineStop(noun string, runtimes []string, name string, rec *ServiceState) {
	fmt.Println("# stop " + noun + ":")
	for _, rt := range runtimes {
		for _, h := range machineHandles(rt, name, rec) {
			fmt.Println(renderCmd(rt, "stop", h))
			fmt.Println(renderCmd(rt, "rm", h))
		}
	}
}

// stopBrowser stops and removes the Browser under each of runtimes, and
// forgets its record b. True when there was a container to stop.
func stopBrowser(runtimes []string, b *ServiceState) bool {
	stopped := stopMachineContainer(runtimes, "semiont-browser", b)
	clearBrowser()
	return stopped
}

// stopOllama stops and removes the machine's Ollama under each of runtimes,
// and forgets its record o. True when there was a container to stop.
func stopOllama(runtimes []string, o *ServiceState) bool {
	stopped := stopMachineContainer(runtimes, "semiont-ollama", o)
	clearOllama()
	return stopped
}

// machineStopped: what stopMachineServices stopped, and the ports they
// held, for the release check.
type machineStopped struct {
	any   bool
	ports []int
}

// stopMachineServices stops the machine-level containers under each of
// runtimes: Ollama first, then the Browser. A bare stop stops everything, so
// it ends with these; a stop of one service leaves them. Every start runs a
// Browser, so its name is swept with no record of one; Ollama runs only for
// engines that name it, so with no record of one its name is swept only by a
// blind stop, one with no stack record to go by.
func stopMachineServices(u *UI, runtimes []string, ss *StackSet, blind bool) machineStopped {
	var out machineStopped
	held := func(rec *ServiceState) {
		if rec == nil {
			return
		}
		if _, p := parseHostPort(rec.Endpoint); p != 0 {
			out.ports = append(out.ports, p)
		}
	}
	if (ss.Ollama != nil || blind) && stopOllama(runtimes, ss.Ollama) {
		u.Ok("Ollama stopped")
		out.any = true
		held(ss.Ollama)
	}
	if stopBrowser(runtimes, ss.Browser) {
		u.Ok("Browser stopped")
		out.any = true
		held(ss.Browser)
	}
	return out
}

// printMachineServicesStop prints what stopMachineServices would run.
func printMachineServicesStop(runtimes []string, ss *StackSet, blind bool) {
	if ss.Ollama != nil || blind {
		printMachineStop("the machine's Ollama", runtimes, "semiont-ollama", ss.Ollama)
	}
	printMachineStop("the Browser", runtimes, "semiont-browser", ss.Browser)
}

// ollamaRole: the role the local stack runs the machine's Ollama under, the
// one `start --service` names to start it: inference where the engines run on
// it, else embedding where it serves the embeddings alone; "" where the stack
// runs it under neither. With no stack record, inference, the role the roles
// table runs it under.
func ollamaRole(ss *StackSet) string {
	st := ss.Stacks["local"]
	if st == nil {
		return "inference"
	}
	for _, role := range []string{"inference", "embedding"} {
		if st.Services[role].Provided == providedMachine {
			return role
		}
	}
	return ""
}

// stopCodespaceAndMachine: a bare stop that resolved to a codespace stack.
// Bare, a stop stops everything, so the machine's Ollama and the Browser go
// too, as they do with a local stack; a stop of one service leaves them.
func stopCodespaceAndMachine(u *UI, st *StackState, service string, del, dryRun bool) int {
	code := stopCodespace(u, st, service, del, dryRun)
	if code != 0 || service != "" {
		return code
	}
	runtimes := installedRuntimes()
	ss := LoadStackSet()
	if dryRun {
		printMachineServicesStop(runtimes, ss, false)
		return 0
	}
	stopMachineServices(u, runtimes, ss, false)
	return 0
}

// Stop implements `semiont stop`.
func Stop(args []string) int {
	u := NewUI(false)
	runtime := ""
	service := ""
	repo := ""
	dryRun := false
	del := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--runtime":
			if i+1 >= len(args) {
				u.Fail("Missing value for --runtime")
				return 1
			}
			runtime = args[i+1]
			i++
		case "--service":
			if i+1 >= len(args) {
				u.Fail("Missing value for --service")
				return 1
			}
			service = args[i+1]
			i++
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
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
			u.Fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	// Every branch below either reads the record or rewrites it, and the
	// no-record fallbacks (the all-runtimes name sweep, "nothing to stop")
	// are only honest when there genuinely is no record.
	if LoadStackSet().refuseUnreadable(u) {
		return 1
	}

	// --service browser stops the Browser alone, under every installed
	// runtime, and never touches stack state.
	if service == "browser" && repo == "" {
		b := LoadStackSet().Browser
		if b == nil {
			u.Log("No Browser is recorded — sweeping the container name to be sure.")
		}
		if dryRun {
			printMachineStop("the Browser", installedRuntimes(), "semiont-browser", b)
			return 0
		}
		if stopBrowser(installedRuntimes(), b) {
			u.Ok("Browser stopped %s", u.Dim("(stacks untouched; any start brings it back)"))
		} else {
			u.Log("Browser was not running.")
		}
		return 0
	}

	// --service on the role the stack runs the machine's Ollama under stops
	// that Ollama alone, from its own record, under every installed runtime.
	// A stack's record goes on naming the provider of its roles: the next
	// start whose engines name Ollama brings it back.
	if service != "" && repo == "" {
		if ss := LoadStackSet(); service == ollamaRole(ss) {
			if dryRun {
				printMachineStop("the machine's Ollama", installedRuntimes(), "semiont-ollama", ss.Ollama)
				return 0
			}
			if stopOllama(installedRuntimes(), ss.Ollama) {
				u.Ok("Ollama stopped %s", u.Dim("(every KB it served goes without; a start whose engines name Ollama brings it back)"))
			} else {
				u.Log("Ollama was not running.")
			}
			return 0
		}
	}

	// serviceContainer: the container --service targets, the roles table's.
	// A container-less role (embedding) has nothing to stop.
	serviceContainer := ""
	if service != "" {
		if !knownRole(service) {
			u.Fail("Unknown --service '%s' (expected: %s)", service, roleList)
			return 1
		}
		serviceContainer = roleContainer(service)
		if serviceContainer == "" {
			u.Log("%s is externally provided — nothing to stop.", service)
			fmt.Fprintf(os.Stdout, "  %s\n", u.Dim("(external roles participate in status; start and stop belong to whatever provides them)"))
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
	// back to that sweep.
	ss := LoadStackSet()
	cs := codespaceStacks(ss)
	st := ss.Stacks["local"]

	// Codespace stacks: --repo targets one; a bare stop resolves only when
	// unambiguous (destructive commands don't guess among stacks). An
	// explicit --runtime keeps its narrow local meaning. --delete means
	// nothing for local stacks (stop+rm already destroys them).
	if repo != "" {
		target, ok := repoCodespaceStack(u, ss, repo)
		if !ok {
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
		// the exact clone whose stack is up.
		root, err := CwdKBRoot()
		if err != nil {
			u.Fail("%v", err)
			return 1
		}
		localHere := st != nil && st.KBRoot != "" && st.KBRoot == root
		if !localHere {
			if st == nil {
				if len(cs) == 1 {
					return stopCodespaceAndMachine(u, cs[0], service, del, dryRun)
				}
				if c := originCodespace(cs, root); c != nil {
					u.Log("Stopping %s %s", u.Bold(c.Codespace.Repo), u.Dim("(this clone's origin; per "+statePath()+")"))
					return stopCodespaceAndMachine(u, c, service, del, dryRun)
				}
			}
			// The menu repeats what was asked: a --delete menu that drops the
			// flag sends people to a plain stop of a codespace GitHub has
			// already reaped. The local stack is no --delete target at all.
			u.Fail("Multiple stacks are recorded — say which:")
			if st != nil && !del {
				fmt.Fprintf(os.Stderr, "    semiont stop --runtime %s   (the local stack)\n", st.Runtime)
			}
			flag := ""
			if del {
				flag = " --delete"
			}
			for _, c := range cs {
				fmt.Fprintf(os.Stderr, "    semiont stop --repo %s%s\n", c.Codespace.Repo, flag)
			}
			return 1
		}
	}
	if del {
		u.Fail("--delete only applies to a codespace stack (a local stop already removes the containers).")
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
		u.Log("Using recorded stack state %s", u.Dim("("+st.Runtime+" per "+statePath()+")"))
	} else {
		if st == nil && runtime == "" && !dryRun {
			u.Log("No recorded stack %s — sweeping all installed runtimes by name.", u.Dim("(stack.json absent)"))
		}
		st = nil // ignore an unusable record; sweep by name
		runtimes = installedRuntimes()
	}
	if len(runtimes) == 0 {
		u.Fail("No container runtime found. Install Apple Container, Docker, or Podman.")
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
				// Only containers this launcher started for the stack are
				// ours to stop here: the machine's Ollama, host processes,
				// external endpoints, and unreferenced roles have nothing to
				// sweep.
				if e.Provided != "" && e.Provided != providedLauncher {
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

	// Where a log snapshot would land: the recorded root when the record is
	// in use, else the KB clone we're standing in. "" (neither) skips the
	// snapshot — evidence capture is best-effort and never blocks a stop,
	// so a clone whose project file is refused is named and skipped.
	snapRoot, snapKey := "", ""
	if useState && st != nil && st.KBRoot != "" {
		snapRoot, snapKey = st.KBRoot, rootKey(st.KBDid, st.KBRoot)
	} else if kb, err := cwdKBRoot(); err != nil {
		u.Warn("No log snapshot: %v", err)
	} else if kb.dir != "" {
		snapRoot, snapKey = kb.dir, kb.key()
	}

	if dryRun {
		fmt.Println("# semiont stop --dry-run — the exact runtime commands a real run would")
		fmt.Println("# execute, in order.")
		// Placeholder, not the resolved path: goldens and users both read
		// this, and the concrete dir is printed by a real run's snapshot.
		if snapRoot != "" {
			fmt.Println("# snapshot container logs into <state-root>/logs/<timestamp>/ before removal")
		}
		for _, rt := range runtimes {
			for _, c := range targets {
				fmt.Println(renderCmd(rt, "stop", c))
				fmt.Println(renderCmd(rt, "rm", c))
			}
		}
		if useState && st.IssuerProxy != nil && (service == "" || service == "identity") {
			fmt.Printf("# end the issuer proxy (pid %d)\n", st.IssuerProxy.PID)
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
			fmt.Println("# staged configs left in place (--service)")
		case st != nil && !useState:
			fmt.Println("# staged configs and stack.json left in place (recorded stack is under " + st.Runtime + ")")
		default:
			fmt.Println("# remove staged configs: " + stagingPattern())
			printMachineServicesStop(slices.Concat(runtimes, strayRuntimes), ss, !useState)
			fmt.Println("# wait until the stack's ports are released; report any still-held holder")
		}
		return 0
	}

	// stop-then-rm: the containers run without --rm, so a stopped one keeps its
	// name (the next `run --name` would fail with "already exists"); rm makes
	// this idempotent across all three states: running, stopped, absent.
	u.Log("Sweeping %d container(s) across %s %s", len(targets),
		strings.Join(runtimes, ", "), u.Dim("(stop+rm each; exact commands: semiont stop --dry-run)"))
	totalRemoved := 0
	for _, rt := range runtimes {
		t0 := time.Now()
		// stop all → snapshot → rm all: the snapshot sits between so it
		// captures shutdown lines but still precedes the deletion of the
		// runtime's log store.
		stopped := make(map[string]bool, len(targets))
		for _, c := range targets {
			stopped[c] = runSilent(rt, "stop", c) == nil
		}
		if snapRoot != "" {
			if dir, n := writeLogSnapshot(rt, snapKey, targets); n > 0 {
				u.Log("Snapshotted %d container log(s) %s", n, u.Dim("("+dir+")"))
			}
		}
		removed := 0
		for _, c := range targets {
			rmed := runSilent(rt, "rm", c) == nil
			if stopped[c] || rmed {
				removed++
			}
		}
		totalRemoved += removed
		elapsed := u.Dim("(" + took(time.Since(t0)) + ")")
		if removed == 0 {
			u.Ok("%s: none found %s", rt, elapsed)
		} else {
			u.Ok("%s: %d removed %s", rt, removed, elapsed)
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
			u.Warn("%s: %d stray container(s) removed (not in the record).", rt, removed)
		}
	}

	if service != "" {
		// The record forgets this one service; the rest of it stands. The
		// issuer proxy goes with the issuer it serves.
		if useState {
			if service == "identity" {
				endIssuerProxy(u, st)
			}
			delete(st.Services, service)
			saveStack(st)
		}
		fmt.Printf("%s stopped (staged configs left in place; rest of the stack untouched).\n", service)
		return 0
	}

	// Shared-artifact cleanup is safe only when this sweep actually covered
	// the recorded stack (or no record exists): with an explicit --runtime
	// that mismatches the record, the REAL stack may still be running — its
	// staged configs are live mounts (deleting them under a running gateway
	// is the Apple-container failure this staging exists to prevent), and
	// its record still describes reality.
	if st != nil && !useState {
		u.Warn("Recorded stack (under %s) left untouched — staged configs and stack.json kept.", st.Runtime)
		fmt.Printf("Swept %s only. Run semiont stop (without --runtime) to tear down the recorded stack.\n", strings.Join(runtimes, ", "))
		return 0
	}

	// The documents semiont start staged for the bind mounts.
	staged, _ := filepath.Glob(stagingPattern())
	removeStagedConfigs()
	if len(staged) > 0 {
		u.Ok("Removed %d staged config dir(s)", len(staged))
	}
	if st != nil {
		endIssuerProxy(u, st)
	}
	forgetStack("local")

	// The machine's Ollama and the Browser go with the stack, wherever this
	// stop swept.
	machine := stopMachineServices(u, slices.Concat(runtimes, strayRuntimes), ss, !useState)

	// Say what actually happened: a stop that found nothing anywhere (the
	// second stop in a row) is a no-op, not a teardown.
	if totalRemoved == 0 && len(staged) == 0 && !machine.any {
		fmt.Println("No Semiont containers found — nothing to stop.")
		return 0
	}
	ports := recordedPorts
	if len(ports) == 0 {
		ports = fiatPorts
	}
	verifyPortsReleased(u, slices.Concat(ports, machine.ports))
	fmt.Println("Semiont stack stopped.")
	return 0
}

// fiatPorts: the launcher-owned ports a stack can claim whatever its config
// says — the release-verification fallback when no record captured the
// stack's exact claims (older launcher's record, name-sweep path): every
// launcher-fiat role's, since a stop with no record cannot know which of them
// the stack ran, then the broker's. 3000 is absent: the Browser is not a
// stack member and its port is not the stack's to verify.
var fiatPorts = func() []int {
	var needs []portNeed
	for _, role := range append(fiatRoles(true), "messaging") {
		needs = append(needs, stackPortNeeds(role)...)
	}
	return portNumbers(needs)
}()

// verifyPortsReleased: stop's job isn't done until the ports are actually
// free — runtimes release published ports asynchronously (Apple container's
// forwarders especially), and a start right after a stop must not trip over
// them. Poll briefly to absorb lazy teardown, then REPORT any survivor with
// its holder. Never kills: after the sweeps above, a holder is provably not
// a Semiont container.
func verifyPortsReleased(u *UI, ports []int) {
	deadline := time.Now().Add(3 * time.Second)
	var held []int
	for {
		held = held[:0]
		for _, p := range ports {
			if len(listenersOn(p)) > 0 {
				held = append(held, p)
			}
		}
		if len(held) == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if len(held) == 0 {
		u.Ok("All stack ports released")
		return
	}
	for _, p := range held {
		u.Warn("Port %d is still held by %s — not a Semiont container; the next start will fail on it.",
			p, describeProcs(listenersOn(p)))
	}
}

// Version implements `semiont version`.
func Version(args []string) int {
	fmt.Printf("semiont %s (commit %s, built %s)\n", BuildVersion, BuildCommit, BuildDate)
	return 0
}
