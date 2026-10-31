package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

var stopUsage = fmt.Sprintf(`Usage: semiont stop [--service <name>] [--root <path>] [--runtime container|docker|podman] [--repo <owner/name>] [--delete] [--dry-run]

Stop a knowledge base's Semiont stack — its services and dependencies — and
clean up its staged configs. The machine's containers (the worker, the
telemetry, the machine's Ollama and the Browser) serve every knowledge base
here, so they stop with the last local stack, and a stop that leaves another
recorded leaves them. Safe to run when nothing is up: every step is a no-op
then. Persistent stack state (PostgreSQL, Qdrant, Neo4j data) is deliberately
LEFT: the next start reuses it. Removing it is its own explicit command:
semiont clean.

Which stack: --root <path> names a knowledge base's, --repo <owner/name> a
codespace's. Without either, the stack of the knowledge base you stand in;
else the one stack recorded; else, with no local stack, the codespace this
clone's git origin names. With several and none of these, stop refuses and
lists the choices. --runtime keeps to the local stacks. With no stack
recorded, stop sweeps by name: the knowledge base you stand in's containers,
or else every known knowledge base's, and the machine's.

With no --runtime, EVERY installed runtime is swept — stopping via the wrong
runtime is a silent no-op that leaves the real stack running.

With --service <name>, stop just that one service:

%s.

--service browser stops the Browser alone. --service collector, traces or
metrics stops the machine's collector, Jaeger or Prometheus alone, and
--service inference the machine's Ollama, as --service embedding does where
the stack runs it for the embeddings alone: each serves every KB here, so a
stop of any other one service leaves it.

The staged configs are left in place — the rest of the stack is still
mounting them.

A CODESPACE stack (started with --runtime codespace) stops with
'gh codespace stop': billing halts, state and credentials persist, and the
record is kept — resume with semiont start. --delete destroys the codespace
(state and all) and forgets the record; it applies only to codespace stacks.
A stop named with --repo stops that codespace stack alone, and leaves the
Browser.
`, roleListWrapped(78, ""))

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

// stopMachineService stops and removes the machine's container name under
// each of runtimes, from its record, and forgets the record. True when there
// was a container to stop.
func stopMachineService(runtimes []string, name string, ss *StackSet) bool {
	stopped := stopMachineContainer(runtimes, name, ss.Machine[name])
	forgetMachine(name)
	return stopped
}

// machineStopped: what stopMachineServices stopped, and the ports they
// held, for the release check.
type machineStopped struct {
	any   bool
	ports []int
}

// machineSwept: whether a stop sweeps the machine's container name. Every
// start runs a Browser, so its name is swept with no record of one; the
// others run only for some starts — Ollama only for engines that name it,
// Jaeger and Prometheus not under --no-observe — so with no record of one, a
// name is swept only by a blind stop, one with no stack record to go by.
func machineSwept(name string, ss *StackSet, blind bool) bool {
	return name == machineContainer("browser") || ss.Machine[name] != nil || blind
}

// stopMachineServices stops the machine's containers under each of runtimes,
// in machineRoles' order. A bare stop stops everything, so it ends with
// these; a stop of one service leaves them.
func stopMachineServices(u *UI, runtimes []string, ss *StackSet, blind bool) machineStopped {
	var out machineStopped
	for _, role := range machineRoles {
		name := machineContainer(role)
		rec := ss.Machine[name]
		if machineSwept(name, ss, blind) && stopMachineService(runtimes, name, ss) {
			u.Ok("%s stopped", machineNoun(role))
			out.any = true
			if rec != nil {
				out.ports = append(out.ports, rec.Ports...)
			}
		}
	}
	return out
}

// printMachineServicesStop prints what stopMachineServices would run.
func printMachineServicesStop(runtimes []string, ss *StackSet, blind bool) {
	for _, role := range machineRoles {
		if name := machineContainer(role); machineSwept(name, ss, blind) {
			printMachineStop("the machine's "+machineNoun(role), runtimes, name, ss.Machine[name])
		}
	}
}

// machineNoun: what the machine's container for role is called when it is
// stopped.
func machineNoun(role string) string {
	switch role {
	case "browser":
		return "Browser"
	case "collector":
		return "OTel collector"
	}
	return descriptorFor(role, probeDriver(role)).display
}

// machineServing: the machine's container that `stop --service role` stops,
// and whether one does: the one `start --service role` would start. st, the
// local stack a stop run here means (unaskedStack), names the container
// serving the role in its record, and the role runs it when it is the first
// the start walk reaches that names it — a later one shares it (embedding, on
// the Ollama inference runs). With no record of the role, the roles table's
// container for a machine role. The worker is the machine's whatever a stack
// records of it: one whose jobs have no engine is not on its list, and it
// goes on serving the rest.
func machineServing(st *StackState, role string) (string, bool) {
	if st != nil && role != "worker" {
		if rec, ok := st.Services[role]; ok {
			if rec.Provided != providedMachine {
				return "", false
			}
			for _, r := range startOrder {
				if e := st.Services[r]; e.Provided == providedMachine && e.Container == rec.Container {
					return rec.Container, r == role
				}
			}
		}
	}
	if !machineRole(role) {
		return "", false
	}
	return machineContainer(role), true
}

// unaskedStack: the local stack a command run here means without being told —
// the one of the knowledge base you stand in, else the one recorded; nil when
// neither answers.
func unaskedStack(ss *StackSet) *StackState {
	locals := localStacks(ss)
	if root, err := CwdKBRoot(); err == nil && root != "" {
		for _, st := range locals {
			if st.KBRoot == root {
				return st
			}
		}
	}
	if len(locals) == 1 {
		return locals[0]
	}
	return nil
}

// stopCodespaceAndMachine: a bare stop that resolved to a codespace stack.
// Bare, a stop stops everything, so the machine's containers go too, as they
// do with a local stack; a stop of one service leaves them.
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
	root := ""
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
		case "--root":
			if i+1 >= len(args) {
				u.Fail("Missing value for --root")
				return 1
			}
			root = args[i+1]
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
	browser := machineContainer("browser")
	if service == "browser" && repo == "" {
		ss := LoadStackSet()
		if ss.Machine[browser] == nil {
			u.Log("No Browser is recorded — sweeping the container name to be sure.")
		}
		if dryRun {
			printMachineStop("the machine's Browser", installedRuntimes(), browser, ss.Machine[browser])
			return 0
		}
		if stopMachineService(installedRuntimes(), browser, ss) {
			u.Ok("Browser stopped %s", u.Dim("(stacks untouched; any start brings it back)"))
		} else {
			u.Log("Browser was not running.")
		}
		return 0
	}

	// --service on a role the machine's container serves stops that
	// container alone, from its own record, under every installed runtime.
	// A stack's record goes on naming the provider of its roles: the next
	// start that runs it brings it back.
	if service != "" && repo == "" {
		ss := LoadStackSet()
		if name, ok := machineServing(unaskedStack(ss), service); ok {
			noun := machineNoun(machineRoleByContainer[name])
			if dryRun {
				printMachineStop("the machine's "+noun, installedRuntimes(), name, ss.Machine[name])
				return 0
			}
			if stopMachineService(installedRuntimes(), name, ss) {
				u.Ok("%s stopped %s", noun, u.Dim("(every KB it served goes without; a start that runs it brings it back)"))
			} else {
				u.Log("%s was not running.", noun)
			}
			return 0
		}
	}
	if service != "" && !knownRole(service) {
		u.Fail("Unknown --service '%s' (expected: %s)", service, roleList)
		return 1
	}

	// Codespace stacks: --repo targets one; a bare stop resolves only when
	// unambiguous (destructive commands don't guess among stacks). An
	// explicit --runtime keeps its narrow local meaning. --delete means
	// nothing for local stacks (stop+rm already destroys them).
	ss := LoadStackSet()
	if repo != "" {
		if root != "" {
			u.Fail("--repo and --root are contradictory: one names a codespace stack, the other a local one.")
			return 1
		}
		target, ok := repoCodespaceStack(u, ss, repo)
		if !ok {
			return 1
		}
		return stopCodespace(u, target, service, del, dryRun)
	}
	scope, codespace, ok := resolveStop(u, ss, root, runtime, del)
	if !ok {
		return 1
	}
	if codespace != nil {
		return stopCodespaceAndMachine(u, codespace, service, del, dryRun)
	}
	if del {
		u.Fail("--delete only applies to a codespace stack (a local stop already removes the containers).")
		return 1
	}
	st := scope.st

	// The containers --service targets: the roles table's, for each knowledge
	// base swept. A container-less role (embedding) has nothing to stop.
	if service != "" && !runsContainer(service) {
		u.Log("%s is externally provided — nothing to stop.", service)
		fmt.Fprintf(os.Stdout, "  %s\n", u.Dim("(external roles participate in status; start and stop belong to whatever provides them)"))
		return 0
	}

	// Which runtimes to sweep: the requested one, or EVERY installed runtime.
	// Stopping is idempotent (stop/rm of absent names are no-ops), so sweeping
	// all runtimes structurally kills the classic trap: a bare `semiont stop`
	// after `semiont start --runtime docker` picking a different runtime,
	// reporting success, and leaving the real stack running.
	// The recorded stack state (when present) says which runtime started the
	// stack and what identifiers it reported — stop computes its work from
	// those instead of a blind every-runtime name sweep. An explicit
	// --runtime overrides; no record falls back to that sweep.
	//
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
		if st == nil && !dryRun {
			u.Log("No recorded stack %s — sweeping all installed runtimes by name.", u.Dim("("+scope.swept()+")"))
		}
		st = nil // an unusable record; sweep by name, and forget it after
		runtimes = installedRuntimes()
	}
	if len(runtimes) == 0 {
		u.Fail("No container runtime found. Install Apple Container, Docker, or Podman.")
		return 1
	}
	// Identifiers come from the record only when sweeping exactly the
	// recorded runtime — IDs are runtime-specific.
	useState := st != nil && (runtime == "" || runtime == st.Runtime)

	// The names swept: one service's, or each stack's (reverse-start order),
	// for every knowledge base in scope. With a record: a host-reuse
	// inference entry means no container exists — skip it; a recorded ID is
	// the sharper handle than the name.
	var names []string
	for _, key := range scope.keys {
		if service != "" {
			names = append(names, containersForRole(service, key)...)
		} else {
			names = append(names, stackContainers(key)...)
		}
	}
	targets := names
	if useState {
		targets = recordedHandles(st, service)
	}

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

	// Where a log snapshot would land: the state of the one knowledge base
	// swept. A blind sweep of every known one keeps none: there is no one
	// root to keep it under.
	snapKey := ""
	if len(scope.keys) == 1 {
		snapKey = scope.keys[0]
	}

	// The machine's containers go with the last local stack: the stop that
	// leaves no other recorded.
	others := 0
	for _, o := range localStacks(ss) {
		if scope.st == nil || StackKey(o) != StackKey(scope.st) {
			others++
		}
	}
	machineToo := service == "" && others == 0
	staged := scope.staged()

	if dryRun {
		fmt.Println("# semiont stop --dry-run — the exact runtime commands a real run would")
		fmt.Println("# execute, in order.")
		// Placeholder, not the resolved path: goldens and users both read
		// this, and the concrete dir is printed by a real run's snapshot.
		if snapKey != "" {
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
			for _, c := range names {
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
			fmt.Println("# remove staged configs: " + scope.stagingPattern())
			if machineToo {
				printMachineServicesStop(slices.Concat(runtimes, strayRuntimes), ss, !useState)
			} else {
				fmt.Println("# the machine's containers left running: another local stack is recorded")
			}
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
		if snapKey != "" {
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
		for _, c := range names {
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
	removeStaged(staged)
	if len(staged) > 0 {
		u.Ok("Removed %d staged config dir(s)", len(staged))
	}
	if st != nil {
		endIssuerProxy(u, st)
	}
	if scope.st != nil {
		forgetStack(StackKey(scope.st))
	}

	// The machine's containers go with the last local stack, wherever this
	// stop swept.
	var machine machineStopped
	if machineToo {
		machine = stopMachineServices(u, slices.Concat(runtimes, strayRuntimes), ss, !useState)
	} else {
		u.Log("The machine's containers stay up %s", u.Dim("(another local stack is recorded)"))
	}

	// Say what actually happened: a stop that found nothing anywhere (the
	// second stop in a row) is a no-op, not a teardown.
	if totalRemoved == 0 && len(staged) == 0 && !machine.any {
		fmt.Println("No Semiont containers found — nothing to stop.")
		return 0
	}
	ports := recordedPorts
	if len(ports) == 0 {
		ports = fiatPorts(scope.keys, machineToo)
	}
	verifyPortsReleased(u, slices.Concat(ports, machine.ports))
	fmt.Println("Semiont stack stopped.")
	return 0
}

// stopScope: what a local stop acts on — a knowledge base's recorded stack,
// or, with none recorded, the knowledge bases whose container names it sweeps
// blind: the one it was asked of, or else every one this machine knows.
type stopScope struct {
	st   *StackState // the recorded stack; nil for a blind sweep
	dir  string      // the root of the one knowledge base swept; "" for every known one
	keys []string    // the state key of each knowledge base swept
}

// swept: what a blind sweep is of, for its banner.
func (sc stopScope) swept() string {
	if sc.dir != "" {
		return "of " + sc.dir
	}
	return "of every known knowledge base"
}

// staged: the staging dirs this stop removes — its knowledge base's, or, swept
// blind of every known one, every one's.
func (sc stopScope) staged() []string {
	if len(sc.keys) == 1 {
		return stagedConfigs(sc.keys[0])
	}
	dirs, _ := filepath.Glob(stagingPattern())
	return dirs
}

// stagingPattern: what staged() matches, as a dry run says it.
func (sc stopScope) stagingPattern() string {
	if len(sc.keys) == 1 {
		return keyStagingPattern(sc.keys[0])
	}
	return stagingPattern()
}

// resolveStop: the stack a local stop acts on, or the codespace stack a bare
// stop means instead (codespace non-nil). The ladder is SelectVerbStack's,
// with one difference: with no stack recorded for it, the knowledge base
// asked of — by --root, or by standing in it — is still swept by name, and
// with none asked of and none recorded, every known one is. ok=false:
// refused, the choices listed.
func resolveStop(u *UI, ss *StackSet, root, runtime string, del bool) (scope stopScope, codespace *StackState, ok bool) {
	var asked kbRoot
	if root != "" {
		dir, ident, err := resolveRootArg(root)
		if err != nil {
			u.Fail("%v", err)
			return stopScope{}, nil, false
		}
		asked = kbRoot{dir: dir, ident: ident}
	} else {
		kb, err := cwdKBRoot()
		if err != nil {
			u.Fail("%v", err)
			return stopScope{}, nil, false
		}
		asked = kb
	}
	if asked.dir != "" {
		st := localStack(ss, asked.key())
		if st != nil && st.KBRoot != asked.dir {
			u.Fail("%s's stack runs from %s, not %s (per %s).", asked.ident.didWeb(), st.KBRoot, asked.dir, statePath())
			fmt.Fprintln(os.Stderr, "  Stop it there:  semiont stop --root "+st.KBRoot)
			return stopScope{}, nil, false
		}
		if st != nil || root != "" {
			return stopScope{st: st, dir: asked.dir, keys: []string{asked.key()}}, nil, true
		}
	}
	locals, cs := localStacks(ss), codespaceStacks(ss)
	if runtime != "" {
		cs = nil
	}
	switch {
	case len(locals) == 1 && len(cs) == 0:
		st := locals[0]
		return stopScope{st: st, dir: st.KBRoot, keys: []string{rootKey(st.KBDid, st.KBRoot)}}, nil, true
	case len(locals) == 0 && len(cs) == 0:
		if asked.dir != "" {
			return stopScope{dir: asked.dir, keys: []string{asked.key()}}, nil, true
		}
		return stopScope{keys: knownKeys()}, nil, true
	case len(locals) == 0 && len(cs) == 1:
		return stopScope{}, cs[0], true
	case len(locals) == 0:
		if c := originCodespace(cs, asked.dir); c != nil {
			u.Log("Stopping %s %s", u.Bold(c.Codespace.Repo), u.Dim("(this clone's origin; per "+statePath()+")"))
			return stopScope{}, c, true
		}
	}
	// The menu repeats what was asked: a --delete menu that drops the flag
	// sends people to a plain stop of a codespace GitHub has already reaped.
	// A local stack is no --delete target at all.
	u.Fail("Multiple stacks are recorded — say which:")
	flag := ""
	if del {
		flag, locals = " --delete", nil
	}
	printStackMenu("stop", flag, locals, cs)
	return stopScope{}, nil, false
}

// knownKeys: the state key of every knowledge base this machine knows (each
// row of roots.json), for a stop with no stack recorded and no knowledge base
// asked of, which sweeps them all.
func knownKeys() []string {
	var keys []string
	for _, e := range loadRoots().Roots {
		if k := rootKey(e.Did, e.Path); !contains(keys, k) {
			keys = append(keys, k)
		}
	}
	return keys
}

// recordedHandles: what a stop of st sweeps, from its record — one service's
// container, or each of the stack's in teardown order. Only containers this
// launcher started for the stack are ours to stop here: the machine's
// containers, host processes, external endpoints, and unreferenced roles
// have nothing to sweep. A recorded ID is the sharper handle than the name.
func recordedHandles(st *StackState, service string) []string {
	key := rootKey(st.KBDid, st.KBRoot)
	var out []string
	for _, role := range teardownOrder {
		if machineRole(role) || service != "" && role != service {
			continue
		}
		for _, c := range containersForRole(role, key) {
			if e, ok := st.Services[role]; ok {
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
	}
	return out
}

// fiatPorts: the launcher-owned ports a stack can claim whatever its config
// says — the release-verification fallback when no record captured the
// stack's exact claims (the name-sweep path): every launcher-fiat role's and
// the broker's, on the port block each knowledge base swept keeps, since a
// stop with no record cannot know which of them the stack ran; then, when the
// machine's containers were swept, the worker's and the telemetry's, which a
// blind stop sweeps with no record of their ports. 3000 is absent: the
// Browser's port is its document's, not the stack's to verify.
func fiatPorts(keys []string, machine bool) []int {
	var needs []portNeed
	for _, e := range loadRoots().Roots {
		if e.PortBlock == nil || !contains(keys, rootKey(e.Did, e.Path)) {
			continue
		}
		onBlock := &launchPlan{Block: *e.PortBlock}
		for _, role := range append(fiatRoles(), "messaging") {
			needs = append(needs, onBlock.portNeeds(role)...)
		}
	}
	if machine {
		for _, role := range slices.Concat([]string{"worker"}, telemetryRoles) {
			needs = append(needs, stackPortNeeds(role)...)
		}
	}
	return portNumbers(needs)
}

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
