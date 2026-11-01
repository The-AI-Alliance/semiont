package launcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

const statusUsage = `Usage: semiont status [--root <path|name>] [--repo <owner/name> [--refresh]] [--service <name>] [--runtime container|docker|podman] [--verbose] [--billing]

Reports what this machine knows about:

  BROWSER        the machine-level viewer (not a stack member) — first,
                 because it sits architecturally above everything it views
  LOCAL STACK    a stack running here, and the root it belongs to: the
                 one of the KB you stand in (or --root), else each one
  KNOWLEDGE BASES
                 every KB this machine knows — file:// clones the launcher
                 has used (roots.json), and https:// codespace-hosted repos
                 with their state and KB port

--verbose adds LAUNCHER PATHS: the launcher's own config, cache, log, state,
staging and model-cache paths on this host, plus the persistent per-root
stack state and its disk consumption — the active root's stores, and the
total across all roots (orphaned state is called out with the clean
command that removes it).

For every local service: the container state as the runtime reports it
(running / exited / absent — across all installed runtimes unless --runtime
narrows it), and a host-side application health probe (the same endpoints
semiont start gates on; a TCP dial for PostgreSQL). An Ollama serving from
the host with no container is reported as runtime "host".

Exit status: the default multi-stack report exits 0 whenever status itself
ran — with several stacks, one code cannot speak for all of them. To script
health, name ONE stack:

  semiont status --root <path|name>    && echo local-up
  semiont status --repo <owner/name>   && echo remote-up
  semiont status --service gateway     && echo gateway-up

Those forms exit 0 only when the named stack (or service) is healthy.

--billing (standalone) shows GitHub's own codespaces usage report — monthly
compute/storage quantities, gross, plan-quota discounts, and the NET you
actually pay. Their numbers, never launcher estimates. Needs the "user"
scope: grant once with  gh auth refresh -h github.com -s user

status never wakes a stopped codespace. --refresh (with --repo) re-reads that
KB's did:web identity over ssh to confirm the recorded one — it is skipped,
with a note, unless the codespace is already running.
`

// serviceCell: the SERVICE column's width, the longest cell's:
// "identity-store (PostgreSQL)".
const serviceCell = 27

// Status implements `semiont status`.
//
// Layout follows the concepts, not the machinery. BROWSER opens the report:
// the viewer sits architecturally above every stack it views (see
// printBrowser). Then LOCAL STACK — present or not — because a stack is
// transient status layered on one root. Then the durable things a user owns,
// in one KNOWLEDGE BASES section, local before remote.
// --verbose appends SESSIONS and LAUNCHER PATHS.
func Status(args []string) int {
	u := NewUI(false)
	runtime, service, repoFlag, rootFlag := "", "", "", ""
	refresh := false
	verbose := false
	billing := false
	for i := 0; i < len(args); i++ {
		need := func() (string, bool) {
			if i+1 >= len(args) {
				u.Fail("Missing value for %s", args[i])
				return "", false
			}
			return args[i+1], true
		}
		switch args[i] {
		case "--runtime":
			v, ok := need()
			if !ok {
				return 1
			}
			runtime = v
			i++
		case "--repo":
			v, ok := need()
			if !ok {
				return 1
			}
			repoFlag = v
			i++
		case "--root":
			v, ok := need()
			if !ok {
				return 1
			}
			rootFlag = v
			i++
		case "--service":
			v, ok := need()
			if !ok {
				return 1
			}
			service = v
			i++
		case "--refresh":
			refresh = true
		case "--verbose", "-v":
			verbose = true
		case "--billing":
			billing = true
		case "--help", "-h":
			fmt.Print(statusUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	if service != "" {
		if !knownRole(service) {
			u.Fail("Unknown --service '%s' (expected: %s)", service, roleList)
			return 1
		}
	}
	// --service browser asks about the Browser — machine-level, outside
	// every stack, so it bypasses the stack table entirely.
	if service == "browser" && repoFlag == "" {
		ss := LoadStackSet()
		if ss.refuseUnreadable(u) {
			return 1
		}
		healthy := printBrowser(u, ss)
		if healthy {
			return 0
		}
		return 1
	}
	if repoFlag != "" && (rootFlag != "" || service != "") {
		u.Fail("--repo names a remote stack; --root/--service name the local one.")
		return 1
	}
	if billing {
		if repoFlag != "" || rootFlag != "" || service != "" || refresh {
			u.Fail("--billing is a standalone report (GitHub bills per month and repo, not per stack).")
			return 1
		}
		return statusBilling(u)
	}
	if refresh && repoFlag == "" {
		u.Fail("--refresh re-reads ONE remote KB's identity over ssh — name it with --repo <owner/name>.")
		return 1
	}

	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return 1
	}
	cs := codespaceStacks(ss)

	// --repo: one remote stack, health-coded for scripting.
	if repoFlag != "" {
		target, ok := repoCodespaceStack(u, ss, repoFlag)
		if !ok {
			return 1
		}
		return statusCodespace(u, target, refresh)
	}

	// The local stacks reported: --root's, which must be recorded; else the
	// one of the knowledge base you stand in; else each one recorded. With
	// none, the one discovered by name — the knowledge base you stand in's,
	// else the machine's containers alone.
	var reported []*StackState
	key := ""
	if rootFlag != "" {
		st, ok := rootLocalStack(u, ss, rootFlag)
		if !ok {
			return 1
		}
		// A stack mid-start is not ready, whatever its recorded services
		// report so far: the gateway answers long before the sidecars do.
		// This is the question a laptop asks a codespace before moving its
		// issuer (askRemoteKB).
		if holder, busy := startInProgress(rootKey(st.KBDid, st.KBRoot)); busy {
			u.Fail("A semiont start is running for this KB (%s) — its stack is not ready yet.", holder)
			return 1
		}
		reported = []*StackState{st}
	} else {
		kb, err := cwdKBRoot()
		if err != nil {
			u.Fail("%v", err)
			return 1
		}
		if st := localStack(ss, kb.key()); kb.dir != "" && st != nil {
			reported = []*StackState{st}
		} else if reported = localStacks(ss); len(reported) == 0 && kb.dir != "" {
			key = kb.key()
		}
	}

	if service == "" {
		printBrowser(u, ss)
	}
	healthy := true
	if len(reported) == 0 {
		var code int
		if healthy, code = printLocalStack(u, nil, key, runtime, service); code != 0 {
			return code
		}
	}
	for _, st := range reported {
		up, code := printLocalStack(u, st, rootKey(st.KBDid, st.KBRoot), runtime, service)
		if code != 0 {
			return code
		}
		healthy = healthy && up
	}
	// ONE section: local and remote KBs are the same kind of thing, told
	// apart by the scheme on their address (file:// vs https://) rather than
	// by living under separate headings. Only the caller sees both halves,
	// so the "nothing here" line belongs here too.
	if service == "" {
		u.Section("KNOWLEDGE BASES")
		printRootsPointer(u, localStacks(ss), cs)
	}
	if service == "" && verbose {
		printSessions(u, ss)
		printLauncherPaths(u)
	}

	// Naming ONE stack makes the exit its health; the default report covers
	// several stacks at once, where a single code cannot speak for all of
	// them — there it only says that status itself ran.
	if service != "" || rootFlag != "" {
		if healthy {
			return 0
		}
		return 1
	}
	return 0
}

// BrowserProbe answers the two questions anything that wants to reach the
// Browser has to ask: WHERE is it, and is it up?
//
// Endpoint is an ORIGIN and never a path. That line is a decision — the
// launcher knows where the Browser is and none of its routes: it publishes
// the container's host port and records the endpoint, so
// `http://localhost:3000` is its own fact — `/know/resource/<id>` is the
// Browser's, and mirroring it here would drift silently the day the route
// moves. If you find yourself adding a route to a Go file, that decision was
// reopened without saying so.
type BrowserProbe struct {
	Endpoint string // origin: flag override → record; "" when neither names one
	Running  bool   // the endpoint answers — the only test of "can a human open this"
	State    string // container state; "" when no container carries either handle
}

// BrowserTarget probes the Browser, for printBrowser and for `browse
// --browser`, which needs the same three facts to explain an emit that
// reached nobody: a second implementation would be a second set of bugs
// (notably the stale-ID fallback below).
//
// override is `--browser-url`, taking precedence over the record. With
// neither there is no endpoint to probe: the launcher started no Browser it
// knows the port of.
func BrowserTarget(ss *StackSet, override string) BrowserProbe {
	name := machineContainer("browser")
	b := ss.Machine[name]
	var p BrowserProbe
	handle := name
	if b != nil {
		if b.Endpoint != "" {
			p.Endpoint = b.Endpoint
		}
		if b.ID != "" {
			handle = b.ID
		}
	}
	if override != "" {
		p.Endpoint = override
	}
	p.Running = p.Endpoint != "" && probeHealth(p.Endpoint)
	// Query only the runtime the record names — a record must narrow the
	// sweep, same rule the stack table keeps. No record: all installed.
	rts := installedRuntimes()
	if b != nil && b.Runtime != "" && onPath(b.Runtime) {
		rts = []string{b.Runtime}
	}
	p.State, _ = containerState(rts, handle)
	if p.State == "" && handle != name {
		// A stale recorded ID must not contradict a live endpoint ("absent"
		// beside ✓): the stable name is the fallback truth.
		p.State, _ = containerState(rts, name)
	}
	return p
}

// printBrowser renders the BROWSER section — FIRST, because the viewer sits
// architecturally above every stack it views (and is the least interesting
// line, fine to scroll away). Shows the image tag so browser-vs-stack skew
// is visible: a kept Browser can legitimately outlive several stacks.
func printBrowser(u *UI, ss *StackSet) (healthy bool) {
	u.Section("BROWSER")
	b := ss.Machine[machineContainer("browser")]
	p := BrowserTarget(ss, "")
	healthy = p.Running
	word := p.State
	if word == "" {
		word = "absent"
	}
	mark := u.Wrap(AnsiRed, "✗")
	if healthy {
		mark = u.Wrap(AnsiGreen, "✓")
	}
	detail := "serves every KB on this machine; discovery-synced"
	if b != nil && b.Image != "" {
		// A verified image is recorded by its digest too; the tag is before it.
		tagged, _, _ := strings.Cut(b.Image, "@")
		if i := strings.LastIndexByte(tagged, ':'); i > 0 {
			detail = "images " + tagged[i+1:] + " · " + detail
		}
	}
	if !healthy && p.State == "" {
		fmt.Printf("  %s %-12s %s\n", mark, word, u.Dim("any semiont start brings it up (or: semiont start --service browser)"))
		return healthy
	}
	where := p.Endpoint
	if where == "" {
		where = "not recorded here"
	}
	fmt.Printf("  %s %-12s %s  %s\n", mark, word, where, u.Dim("("+detail+")"))
	return healthy
}

// printLocalStack renders a LOCAL STACK section: the root it belongs to, its
// provenance, and the service table. st is the recorded stack, nil for one
// discovered by name; key, the state key of its knowledge base, names its
// containers — "" for no knowledge base, which leaves the machine's alone.
// Returns whether every counted service is healthy, plus a nonzero code if
// status itself could not run.
func printLocalStack(u *UI, st *StackState, key, runtime, service string) (healthy bool, code int) {
	if service == "" {
		u.Section("LOCAL STACK")
	}

	var runtimes []string
	switch {
	case runtime != "":
		if !onPath(runtime) {
			fmt.Fprintf(os.Stderr, "--runtime %s requested, but '%s' is not on PATH.\n", runtime, runtime)
			return false, 1
		}
		runtimes = []string{runtime}
		if st != nil && runtime != st.Runtime {
			st = nil // the record describes a different runtime's stack
		}
	case st != nil && st.Runtime != "" && onPath(st.Runtime):
		runtimes = []string{st.Runtime}
	default:
		st = nil
		runtimes = installedRuntimes()
	}
	if len(runtimes) == 0 {
		u.Fail("No container runtime found. Install Apple Container, Docker, or Podman.")
		return false, 1
	}

	// Identity first: a stack is status layered on a root, so name the root
	// (and its did:web) before the services. Provenance is dimmed detail, not
	// narration wedged between sections.
	if service == "" {
		if st != nil && st.KBRoot != "" {
			fmt.Printf("  %s\n", st.KBRoot)
			switch ident, err := readKBIdentity(st.KBRoot); {
			case err != nil:
				fmt.Printf("    %s\n", u.Wrap(AnsiYellow, "⚠ "+err.Error()))
			case ident != nil && ident.SiteName != "":
				fmt.Printf("    %s %s\n", u.Dim(ident.didWeb()), u.Dim("— "+ident.SiteName))
			}
		} else if st == nil && key != "" {
			fmt.Printf("  %s\n", u.Dim("(no recorded stack — services below are discovered by name)"))
		} else if st == nil {
			fmt.Printf("  %s\n", u.Dim("(no recorded stack — the machine's services below; cd into a KB clone, or --root, for its stack's)"))
		}
		if st != nil {
			fmt.Printf("    %s\n", u.Dim(st.Runtime+" · "+statePath()))
		}
		if st != nil && st.KBRoot != "" {
			// Named from the setting alone: status never reaches for secrets.
			key := rootKey(st.KBDid, st.KBRoot)
			if ref, configured, err := storeSettingFor(key); err != nil {
				fmt.Printf("    %s\n", u.Wrap(AnsiYellow, "secrets: "+err.Error()))
			} else {
				fmt.Printf("    %s\n", u.Dim("secrets: "+custodyStoreNamed(key, ref, configured).describe()))
			}
		}
		if st != nil && st.LanAddr != "" {
			fmt.Printf("    %s\n", u.Wrap(AnsiYellow, "network lan: the gateway and the issuer answer the network at "+st.LanAddr+", over plain HTTP"))
			reviveIssuerProxy(u, st)
			if p := st.IssuerProxy; p != nil {
				fmt.Printf("    %s\n", u.Dim(fmt.Sprintf("issuer proxy: pid %d (%s → %s)", p.PID, p.Listen, p.Upstream)))
			}
		}
		fmt.Println()
	}

	// One STATUS cell — mark + word — instead of STATE and HEALTH columns
	// that say yes twice on every healthy row. The diagnostic divergences
	// keep distinct words: "✗ running" (up but unhealthy) vs "✗ exited"
	// (crashed, kept for inspection) vs "✓ host"/"✓ reachable" (provided
	// elsewhere). The probe endpoint stays, dimmed.
	fmt.Printf("  %-*s %-10s %s\n", serviceCell, "SERVICE", "RUNTIME", "STATUS")
	healthy = true
	// Fetched once, lazily: the inference and embedding model rows both read
	// it, and a stack with no ollama-served models never asks at all.
	var facts modelFacts
	factsFetched := false
	// Same laziness for the platform's ceilings: one bus request, made only
	// once a row actually has models to decorate, and never at all for a
	// stack with none.
	var ceilings modelCeilings
	ceilingsFetched := false
	// Same laziness for the collector's readout: fetched by the first row
	// that has something to read out of it, and not at all for a stack whose
	// dispatcher and gateway are both down.
	var readout string
	readoutFetched := false
	// Where a service the record holds no endpoint for is asked: where the
	// recorded stack was published, else loopback.
	at := exposure{}
	if st != nil {
		at = st.exposure()
	}
	// The machine's containers run outside the stack: a row one serves reads
	// its state from that container's own record.
	machine := LoadStackSet().Machine
	lastGroup := ""
	for group, role := range groupedRoles() {
		if role == "browser" {
			continue // printBrowser opens the report
		}
		if service != "" && role != service {
			continue
		}
		if key == "" && !machineRole(role) {
			continue // no knowledge base names a stack container to ask of
		}
		if service == "" && lastGroup != "" && group != lastGroup {
			fmt.Println()
		}
		lastGroup = group
		handle := roleContainer(role, key)
		// No record: the descriptor's static probe, for the driver a stack
		// that has not recorded itself would be running. A record's endpoint
		// is sharper — it names the port that start actually used. A recorded
		// stack's own container with no entry (stopped alone, or not reached
		// by its start) is asked nowhere, and reads down: its port is its
		// knowledge base's, and the descriptor's is the default block's,
		// which another knowledge base's stack may hold. The machine's
		// containers, and a role that runs none, answer where the
		// descriptor says for every knowledge base.
		endpoint := ""
		if st == nil || machineRole(role) || !runsContainer(role) {
			endpoint = healthEndpoint(role, probeDriver(role), nil, at)
		}
		var rec *ServiceState
		if st != nil {
			if e, ok := st.Services[role]; ok {
				rec = &e
				if e.ID != "" {
					handle = e.ID
				}
				if e.Endpoint != "" {
					endpoint = e.Endpoint
				}
			}
		}

		// The concrete product rides in the SERVICE cell — "identity-store
		// (PostgreSQL)" — rather than a column that is an em-dash for every
		// Semiont service.
		label := role
		// No record, no driver, no product: the launcher does not name a
		// technology for a role nothing has selected one for. Every record a
		// start writes carries its driver.
		tech := ""
		if rec != nil && rec.Driver != "" {
			tech = driverDisplay(role, rec.Driver)
		}
		// The dispatcher's product is its JOB QUEUE driver, which no state
		// record carries — the queue is a config section, not a launched
		// role. The dispatcher reports the one it connected to, so the row
		// names the live driver rather than the configured intent.
		if role == "dispatcher" && endpoint != "" {
			if q, found := dispatcherQueueDriver(endpoint); found {
				tech = q
			}
		}
		if tech != "" {
			label += " (" + tech + ")"
		}

		if rec != nil && rec.Provided == providedNone {
			fmt.Printf("  %-*s %-10s %s\n", serviceCell, label, "—", u.Dim("not configured"))
			continue
		}

		state, rt := "", ""
		switch {
		case rec != nil && rec.Provided == providedExternal:
			rt = "external"
		case rec != nil && rec.Provided == providedHost:
			rt = "host"
		case rec != nil && rec.Provided == providedMachine:
			// The machine's container the stack's record names, under the
			// runtime and handle its own record names. With no record it is
			// absent: stopped alone.
			if m := machine[rec.Container]; m != nil {
				h := machineHandles(m.Runtime, rec.Container, m)[0]
				state, rt = containerState([]string{m.Runtime}, h)
			}
		case handle == "":
			// A container-less role (embedding, provided elsewhere) has
			// nothing to inspect. Never ask the runtime with an empty name:
			// Apple container answers [] and docker errors, but either could
			// just as well answer with EVERY container and be read as this
			// role running.
			rt = "external"
		default:
			state, rt = containerState(runtimes, handle)
		}
		isHealthy := endpoint != "" && roleHealthy(role, endpoint)
		if role == "inference" && rec == nil && state == "" && isHealthy {
			rt = "host"
		}
		if !isHealthy && (!contains(optionalBackends, role) || service != "") {
			healthy = false
		}

		// The STATUS word: the container state when there is a container
		// (running / exited), else what the probe can honestly say about a
		// role provided elsewhere (reachable / unreachable), else "absent".
		word := state
		if word == "" {
			switch {
			case rt == "external" || rt == "host":
				word = "unreachable"
				if isHealthy {
					word = "reachable"
				}
			default:
				word = "absent"
			}
		}
		if rt == "" {
			rt = "—"
		}
		probe := endpoint
		if rest, ok := strings.CutPrefix(probe, "tcp:"); ok {
			probe = "tcp://" + rest
		}
		mark := u.Wrap(AnsiRed, "✗")
		if isHealthy {
			mark = u.Wrap(AnsiGreen, "✓")
		}
		fmt.Printf("  %-*s %-10s %s %-12s %s\n", serviceCell, label, rt, mark, word, u.Dim(probe))

		// What this role has in flight, indented beneath it — read from the
		// collector's readout, which every start runs and which the collector
		// row above already fetched. Only for a row that is actually up: a
		// dead service's last exported numbers are worse than no numbers. And
		// only for the knowledge base the record names: without one there is
		// no telling whose numbers they are.
		if isHealthy && (role == "dispatcher" || role == "gateway") && st != nil && st.KBDid != "" {
			if !readoutFetched {
				readout, _ = httpBody("http://localhost:24110/metrics")
				readoutFetched = true
			}
			printInFlight(u, role, readout, st.KBDid)
		}

		// The models this role was started with, indented beneath it.
		if rec != nil && len(rec.Models) > 0 {
			// Only reach for Ollama when this row actually has models it
			// serves — an all-remote row must not probe it at all.
			needsFacts := len(servedBy(rec.Models, "ollama")) > 0
			if needsFacts && !factsFetched {
				facts = fetchModelFacts(ollamaBase(rec.Endpoint))
				factsFetched = true
			}
			remote := rec.RemoteModels
			// Live refresh ONLY when the key is already in this process's
			// environment — status never resolves secrets (no op reads, no
			// prompts). Availability can drift after start (a model
			// withdrawn mid-flight), so fresher is better when it is free.
			if rec.Driver == "anthropic" {
				if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
					if live, ok := fetchAnthropicModels(anthropicBase(rec.Endpoint), key); ok {
						remote = map[string]remoteModelMeta{}
						for _, m := range servedBy(rec.Models, "anthropic") {
							if meta, listed := live[m]; listed {
								remote[m] = meta
							} else {
								remote[m] = remoteModelMeta{Available: false}
							}
						}
					}
				}
			}
			if !ceilingsFetched {
				ceilings = fetchModelCeilings(u, st)
				ceilingsFetched = true
			}
			printModels(u, rec.Models, facts, remote, ceilings)
		}
	}
	return healthy, 0
}

const rootsUsage = `Usage: semiont roots

The full knowledge-base catalog: every KB this machine knows — file:// clones
the launcher has used (roots.json), and https:// codespace-hosted repos with
their state. The registry only remembers; drop an entry with semiont forget.

  --help   Show this help
`

// Roots implements `semiont roots` — the catalog, a verb of its own so that
// it cannot push stack health out of status's view.
func Roots(args []string) int {
	u := NewUI(false)
	for _, a := range args {
		switch a {
		case "--help", "-h":
			fmt.Print(rootsUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", a)
			return 1
		}
	}
	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return 1
	}
	u.Section("KNOWLEDGE BASES")
	found := printRoots(u, localStacks(ss))
	found += printRemoteKBs(u, codespaceStacks(ss))
	if found == 0 {
		fmt.Printf("  %s\n", u.Dim("(none — cd into a KB clone, set SEMIONT_ROOT, start with --root, "+
			"or --runtime codespace --repo <owner>/<name>)"))
	}
	return 0
}

// printRootsPointer is status's face of the catalog: the count, the verb
// that owns the full tree, and the one contextual fact worth a line at
// status-reading time — cwd being a KB none of the running stacks is of
// (being in template-kb while the stack runs family is a real gotcha).
func printRootsPointer(u *UI, locals, cs []*StackState) {
	reg := loadRoots().Roots
	n := len(reg) + len(cs)
	cwd, _, _, cwdErr := resolveKBRoot()
	if projectFileRefused(cwdErr) {
		fmt.Printf("  %s\n", u.Wrap(AnsiYellow, fmt.Sprintf("⚠ %v", cwdErr)))
	}
	if cwdErr == nil {
		known := false
		for _, e := range reg {
			if e.Path == cwd {
				known = true
			}
		}
		// The catalog includes a cwd-discovered KB the registry has never
		// seen, so the count does too.
		if !known {
			n++
		}
	}
	if n == 0 {
		fmt.Printf("  %s\n", u.Dim("(none — cd into a KB clone, set SEMIONT_ROOT, start with --root, "+
			"or --runtime codespace --repo <owner>/<name>)"))
	} else {
		fmt.Printf("  %d known — full catalog: %s\n", n, u.Bold("semiont roots"))
	}
	// Every ACTIVE stack stays scannable here, addressed exactly as its
	// row in `semiont roots` (file:// local, https:// codespace) so the
	// jump from pointer to catalog is one glance. Active is a local fact:
	// each running local stack per stack.json, and a codespace whose
	// forward is alive AND answering (forwardAlive) — a record whose
	// tunnel is gone is history, not activity, and no gh round-trip is
	// spent deciding.
	cwdRunning := false
	for _, st := range locals {
		fmt.Printf("  active: file://%s %s\n", st.KBRoot, u.Dim("(a running local stack)"))
		cwdRunning = cwdRunning || st.KBRoot == cwd
	}
	for _, c := range cs {
		if !forwardAlive(c.Codespace.ForwardPID, c.Codespace.ForwardPort) {
			continue
		}
		fmt.Printf("  active: https://github.com/%s %s\n", c.Codespace.Repo,
			u.Dim(fmt.Sprintf("(codespace %s → http://localhost:%d)", c.Codespace.Name, c.Codespace.ForwardPort)))
	}
	if cwdErr == nil && len(locals) > 0 && !cwdRunning {
		fmt.Printf("  %s\n", u.Wrap(AnsiYellow, "cwd KB: "+cwd+" — no running stack's root"))
	}
}

// printRoots reports the Semiont roots: every registered root (roots.json —
// the launcher's memory of roots it has actually used), merged with the one
// resolvable from here (SEMIONT_ROOT or cwd discovery) and each running
// stack's, each annotated with everything true about it. Vanished paths are
// flagged, not hidden.
// Reports how many it printed: the KNOWLEDGE BASES section is shared with
// the remote half, so only the caller can know whether it came out empty.
func printRoots(u *UI, locals []*StackState) int {
	order := []string{}
	labels := map[string][]string{}
	add := func(path, label string) {
		if _, ok := labels[path]; !ok {
			order = append(order, path)
		}
		labels[path] = append(labels[path], label)
	}

	if path, source, _, err := resolveKBRoot(); err == nil {
		label := "discovered from cwd"
		if source == "SEMIONT_ROOT" {
			label = "SEMIONT_ROOT"
		}
		add(path, label)
	} else if os.Getenv("SEMIONT_ROOT") != "" || projectFileRefused(err) {
		// Strictness without failing the report: an invalid override, or a
		// clone whose project file is refused, is surfaced, not silently
		// ignored.
		fmt.Printf("  %s\n", u.Wrap(AnsiYellow, fmt.Sprintf("⚠ %v", err)))
	}
	for _, st := range locals {
		add(st.KBRoot, "running stack")
	}
	for _, e := range loadRoots().Roots {
		if _, err := os.Stat(e.Path); err != nil {
			add(e.Path, "missing")
			continue
		}
		add(e.Path, "last used "+e.LastUsed.Format("2006-01-02"))
	}

	if len(order) == 0 {
		return 0
	}
	// Identity per root: the registry's stored did/siteName (survives the
	// path vanishing), refreshed by a live read when the root is present.
	reg := loadRoots()
	detail := func(p, indent string) {
		did, site, cfg := "", "", ""
		for _, e := range reg.Roots {
			if e.Path == p {
				did, site, cfg = e.Did, e.SiteName, e.Config
			}
		}
		// The tree's identity, where the tree has one; a row whose root is
		// gone keeps the one recorded on it.
		ident, err := readKBIdentity(p)
		if err != nil {
			fmt.Printf("%s%s\n", indent, u.Wrap(AnsiYellow, "⚠ "+err.Error()))
		}
		if ident != nil {
			did, site = ident.didWeb(), ident.SiteName
		}
		switch {
		case did != "" && site != "":
			fmt.Printf("%s%s %s\n", indent, u.Dim(did), u.Dim("— "+site))
		case did != "":
			fmt.Printf("%s%s\n", indent, u.Dim(did))
		}
		if cfg != "" {
			fmt.Printf("%s%s\n", indent, u.Dim("config: "+cfg+" (default)"))
		}
	}
	// Addressed as file:// URLs, so a local KB and a github.com one read as
	// the same kind of thing in one section — each a real address you can
	// follow. Clones of different KBs sit under the same checkout directory,
	// so a repeated stem is the half that says nothing and the leaf is the
	// half that identifies: print such a stem once and hang its KBs under
	// it, while a root sharing its stem with nobody stays on one line.
	items := make([]treeItem, 0, len(order))
	rootOf := map[string]string{}
	for _, p := range order {
		d := "file://" + p
		items = append(items, treeItem{full: d, rest: d})
		rootOf[d] = p
	}
	treePrint(u, items, 0, func(it treeItem, depth int) {
		p := rootOf[it.full]
		lead := strings.Repeat("  ", depth+1)
		fmt.Printf("%s%s %s\n", lead, it.rest, u.Dim("("+strings.Join(labels[p], "; ")+")"))
		detail(p, lead+"  ")
	})
	return len(order)
}

// printSessions reports login sessions under --verbose: each stored token
// (tokens.json) with its stack key and its email when it has one, LIVE-verified against the
// stack's /api/users/me when reachable — valid/expired is a runtime fact,
// so an unreachable stack reads "unverified", never a guess.
func printSessions(u *UI, ss *StackSet) {
	u.Section("SESSIONS")
	toks := LoadTokens()
	if len(toks) == 0 {
		fmt.Printf("  %s\n", u.Dim("(none — semiont login)"))
		return
	}
	keys := make([]string, 0, len(toks))
	for k := range toks {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		e := toks[k]
		state := "unverified (stack not reachable)"
		if base, err := reachedAt(ss, k); err == nil {
			state = storedTokenState(base, e.Token)
		}
		row := fmt.Sprintf("  %-24s", k)
		if e.Email != "" {
			row += " " + e.Email
		}
		fmt.Println(row, u.Dim("("+state+")"))
	}
}

// storedTokenState is what the gateway at base says of a stored token: asked
// once, by a transport that opens no stream and renews nothing.
func storedTokenState(base, token string) string {
	asker := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: base, Token: semiont.NewVariable(token),
		HTTP: &http.Client{Transport: launcherTransport}, Timing: semiont.DefaultTiming(),
	})
	defer asker.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := asker.GetCurrentUser(ctx)
	var refused *semiont.TransportError
	switch {
	case err == nil:
		return "valid"
	case errors.As(err, &refused) && refused.Code == semiont.TransportErrorCodeUnauthorized:
		return "expired (auto-refreshes on next use, or semiont login)"
	}
	return "unverified (stack not reachable)"
}

// printLauncherPaths reports the host-side paths the launcher keeps things
// in, under --verbose only — the everyday report leads with roots and stacks
// instead. It names only directories something is kept in:
//
//   - the state home (the stack record, the registry, sign-ins, discovery),
//     and the data home where the system keeps the two apart;
//   - the launcher's log, the live config staging, and the Ollama model cache
//     a container run may share;
//   - for the knowledge base this command was run in: its root, and the
//     directory its stores are kept in, each store by its own directory with
//     what it takes on disk;
//   - every knowledge base's directory, with the total and the orphans, each
//     named by the clean command that removes it.
func printLauncherPaths(u *UI) {
	u.Section("LAUNCHER PATHS")
	row := func(label, path, note string) {
		if note == "" {
			fmt.Printf("  %-10s %s\n", label, path)
			return
		}
		fmt.Printf("  %-10s %s %s\n", label, path, u.Dim("("+note+")"))
	}
	more := func(text string) { fmt.Printf("  %-10s %s\n", "", text) }
	exists := func(path string) string {
		if _, err := os.Stat(path); err == nil {
			return "present"
		}
		return "absent"
	}
	state, data := StateDir(), dataDir()
	if state != "" {
		row("state", state, "stack record, registry, sign-ins, discovery")
	}
	if data != "" && data != state {
		row("data", data, "each knowledge base's stores and kept secrets")
	}
	if p := logDir(); p != "" {
		log := filepath.Join(p, "launcher.log")
		row("log", log, exists(log))
	}
	staged, _ := filepath.Glob(stagingPattern())
	note := "none"
	if n := len(staged); n > 0 {
		note = fmt.Sprintf("%d present", n)
	}
	row("staging", stagingPattern(), note)
	if home := userHome(); home != "" {
		p := filepath.Join(home, ".ollama")
		row("models", p, exists(p)+"; the Ollama model cache a container may share")
	}
	if data == "" {
		return
	}

	rootsDir := filepath.Join(data, "roots")
	if root, _, ident, err := resolveKBRoot(); err == nil {
		fmt.Println()
		printKBPaths(u, row, more, kbRoot{dir: root, ident: ident}, rootsDir)
	} else if projectFileRefused(err) {
		fmt.Printf("\n  %s\n", u.Wrap(AnsiYellow, fmt.Sprintf("⚠ %v", err)))
	}

	entries, err := os.ReadDir(rootsDir)
	kbs := 0
	var total int64
	var orphanKeys []string
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			kbs++
			sz, _ := diskUse(filepath.Join(rootsDir, e.Name()))
			total += sz
			// Orphan = the stamped kb path DOES NOT EXIST — only that.
			// Permission or IO errors are unknowns, and unknown is not
			// missing; a dir without a readable stamp is counted, never
			// accused.
			if m := loadRootMeta(filepath.Join(rootsDir, e.Name())); m.KBRoot != "" {
				if _, statErr := os.Stat(m.KBRoot); errors.Is(statErr, fs.ErrNotExist) {
					orphanKeys = append(orphanKeys, e.Name())
				}
			}
		}
	}
	fmt.Println()
	if kbs == 0 {
		row("all KBs", rootsDir, "nothing is kept for any knowledge base")
		return
	}
	all := fmt.Sprintf("%d knowledge bases, %s on disk", kbs, humanBytes(total))
	if kbs == 1 {
		all = fmt.Sprintf("1 knowledge base, %s on disk", humanBytes(total))
	}
	if n := len(orphanKeys); n > 0 {
		all += fmt.Sprintf("; %d orphaned — KB root no longer exists; semiont clean --root %s",
			n, strings.Join(orphanKeys, ", "))
	}
	row("all KBs", rootsDir, all)
}

// printKBPaths: the knowledge base a command was run in — its root, which is
// the knowledge base itself, and the directory the launcher keeps its stores
// in, which is another place. Each store is shown by its own directory there.
func printKBPaths(u *UI, row func(label, path, note string), more func(string), kb kbRoot, rootsDir string) {
	root, key := kb.dir, kb.key()
	dir := filepath.Join(rootsDir, key)
	row("KB root", root, "")
	if did := kb.ident.didWeb(); did != "" {
		more(did)
	}
	row("its stores", dir, "")
	// Stores are keyed by the knowledge base's identity, so another clone of
	// it shares them; say so when the last start was from elsewhere.
	if last := loadRootMeta(dir).KBRoot; last != "" && last != root {
		more("last started from " + last)
	}
	uses, total, any := storeUse(dir)
	if !any {
		more("nothing kept yet")
	} else {
		more(humanBytes(total) + " on disk, in these directories beneath it:")
		for _, use := range uses {
			fmt.Printf("  %-10s   %-16s %10s   %s\n", "", use.dir+string(os.PathSeparator), humanBytes(use.bytes), use.holds)
		}
	}
	// Where its secrets are kept is a setting; counting the ones kept in
	// files is a look at the directory, and asking another store is not this
	// report's to do.
	ref, configured, err := storeSettingFor(key)
	switch {
	case err != nil:
	case configured:
		more("its secrets are kept in " + custodyStoreNamed(key, ref, true).describe())
	default:
		kept := 0
		for _, name := range custodyNames() {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				kept++
			}
		}
		switch {
		case kept == 1:
			more("and 1 kept secret (semiont settings secret-store lists it)")
		case kept > 1:
			more(fmt.Sprintf("and %d kept secrets (semiont settings secret-store lists them)", kept))
		}
	}
}

// storeUseRow: one directory under a knowledge base's stores, what it holds
// and what it takes on disk.
type storeUseRow struct {
	dir, holds string
	bytes      int64
}

// kbLogsDir: where the container logs a start snapshots before removing the
// containers are kept, beside the stores.
const kbLogsDir = "logs"

// storeUse: what a knowledge base's directory takes on disk, and each
// directory in it that is there, largest first — absent is absent, not 0 B.
// The total is the whole directory's, kept secrets and the stamp included.
func storeUse(dir string) (uses []storeUseRow, total int64, any bool) {
	for _, spec := range stateStores {
		if sz, ok := diskUse(filepath.Join(dir, spec.dir)); ok {
			uses = append(uses, storeUseRow{spec.dir, spec.holds, sz})
		}
	}
	if sz, ok := diskUse(filepath.Join(dir, kbLogsDir)); ok {
		uses = append(uses, storeUseRow{kbLogsDir, "container logs kept from earlier starts", sz})
	}
	sort.Slice(uses, func(i, j int) bool {
		if uses[i].bytes != uses[j].bytes {
			return uses[i].bytes > uses[j].bytes
		}
		return uses[i].dir < uses[j].dir
	})
	total, _ = diskUse(dir)
	return uses, total, len(uses) > 0
}

// containerState asks each runtime for the container's state, first hit wins.
// Apple `container inspect` emits a JSON array with a top-level "status"
// field (an empty array when no container has that name); docker/podman
// answer short state strings via inspect -f.
func containerState(runtimes []string, name string) (state, rt string) {
	for _, r := range runtimes {
		if r == "container" {
			out, err := capture(r, "inspect", name)
			if err != nil || out == "" {
				continue
			}
			var entries []map[string]any
			if json.Unmarshal([]byte(out), &entries) != nil || len(entries) == 0 {
				continue
			}
			s, _ := entries[0]["status"].(string)
			if s == "" {
				s = "unknown"
			}
			return s, r
		}
		out, err := capture(r, "inspect", "-f", "{{.State.Status}}", name)
		if err != nil || out == "" {
			continue
		}
		return strings.TrimSpace(out), r
	}
	return "", ""
}

// roleHealthy probes one role of the stack.
//
// The GATEWAY goes through the Go SDK. It is the only role in this table that
// is a semiont service with a generated client, and an application request to
// the gateway is the thing packages/go/sdk exists to own, never a hand-written
// path here — as the TypeScript side covers it (`healthCheck` on
// `IGatewayOperations`).
//
// Everything else keeps the generic prober, and that is not laziness: the
// sidecars serve `/health` with no client of their own, and the rest are
// third-party (Ollama, Qdrant, Neo4j, Jaeger) or not HTTP at all. One prober
// spanning them is the point.
func roleHealthy(role, endpoint string) bool {
	if role != "gateway" {
		return probeHealth(endpoint)
	}
	base, ok := strings.CutSuffix(endpoint, "/api/health")
	if !ok || base == "" {
		// A gateway endpoint that is not the health route is a record this
		// function cannot speak for; the generic prober still can.
		return probeHealth(endpoint)
	}
	// Asked with no token, by a transport that opens no stream without one.
	asker := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{
		BaseURL: base, Token: semiont.NewVariable(""),
		HTTP: &http.Client{Transport: launcherTransport}, Timing: semiont.DefaultTiming(),
	})
	defer asker.Close()
	// The budget matches the generic prober's, so one slow role cannot stall
	// a status report longer than any other.
	ctx, cancel := context.WithTimeout(context.Background(), healthProbeTimeout)
	defer cancel()
	_, _, err := asker.HealthCheck(ctx)
	return err == nil
}

// probeHealth runs one host-side application probe: 2xx for http endpoints,
// an accepted dial for tcp ones.
func probeHealth(endpoint string) bool {
	if rest, ok := strings.CutPrefix(endpoint, "tcp:"); ok {
		host, port, err := net.SplitHostPort(rest)
		if err != nil {
			return false
		}
		n, err := strconv.Atoi(port)
		if err != nil {
			return false
		}
		conn, err := dialTCP(host, n, time.Second)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}
	return httpOK(endpoint)
}
