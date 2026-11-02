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
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

const statusUsage = `Usage: semiont status [--root <path|name>] [--repo <owner/name> [--refresh]] [--service <name>] [--runtime container|docker|podman] [--verbose] [--billing]

Reports, by what each service is part of:

  KNOWLEDGE BASES
                 each knowledge base's stack — the one of the KB you stand
                 in (or --root), else each one running: its clone, where it
                 runs, and its record, index and issuer, a line each. Then
                 how many KBs are known (file:// clones the launcher has
                 used, and https:// codespace-hosted repos: semiont roots)
  KNOWLEDGE WORKERS
                 the Browser and the worker, where people and agents work
  PROVIDERS      inference and embedding, with the models each KB uses
  TELEMETRY      the collector, Jaeger and Prometheus

The services in the last three serve every knowledge base, each shown once,
naming the knowledge bases it serves when the report covers several.
--service <name> shows that service's row alone: its runtime, state and the
address it was asked at.

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
// The report follows the groups (serviceGroups): each knowledge base with its
// own services, then a section for each group of the services they all
// share. --verbose appends SESSIONS and LAUNCHER PATHS.
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
	// --service browser asks about the Browser, which belongs to no stack, so
	// it reads no stack's record.
	if service == "browser" && repoFlag == "" {
		ss := LoadStackSet()
		if ss.refuseUnreadable(u) {
			return 1
		}
		r := browserRow(ss)
		printRowHeader()
		printRow(u, r, nil)
		if r.healthy {
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
	// else none, and only the services every knowledge base shares.
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

	views := []stackView{}
	if len(reported) == 0 {
		v, code := newStackView(u, nil, key, runtime)
		if code != 0 {
			return code
		}
		views = append(views, v)
	}
	for _, st := range reported {
		v, code := newStackView(u, st, rootKey(st.KBDid, st.KBRoot), runtime)
		if code != 0 {
			return code
		}
		views = append(views, v)
	}
	nameViews(views)
	// Each knowledge base's ceilings are its own gateway's answer, asked once
	// and only for a row with models to decorate.
	ceilingsOf := map[string]modelCeilings{}
	ceilings := func(v stackView) modelCeilings {
		c, ok := ceilingsOf[v.key]
		if !ok {
			c = fetchModelCeilings(u, v.st)
			ceilingsOf[v.key] = c
		}
		return c
	}

	healthy := true
	if service != "" {
		healthy = printServiceRows(u, views, service, ss.Shared, ceilings)
	} else {
		// Each knowledge base, its own services by group; then the catalog,
		// local and remote alike, told apart by the scheme on their address
		// (file:// vs https://). Then the services they all share, a section
		// for each group.
		u.Section("KNOWLEDGE BASES")
		readout := collectorReadout()
		for i, v := range views {
			if i > 0 {
				fmt.Println()
			}
			healthy = printKnowledgeBase(u, v, ss.Shared, readout) && healthy
		}
		fmt.Println()
		printRootsPointer(u, localStacks(ss), cs)
		for _, g := range serviceGroups {
			if g.shared() {
				healthy = printSharedGroup(u, g, views, ss, ceilings) && healthy
			}
		}
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

// BrowserTarget probes the Browser, for browserRow and for `browse
// --browser`, which needs the same three facts to explain an emit that
// reached nobody: a second implementation would be a second set of bugs
// (notably the stale-ID fallback below).
//
// override is `--browser-url`, taking precedence over the record. With
// neither there is no endpoint to probe: the launcher started no Browser it
// knows the port of.
func BrowserTarget(ss *StackSet, override string) BrowserProbe {
	name := sharedContainer("browser")
	b := ss.Shared[name]
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

// stackView: one local stack as status reads it. st is its record, nil for
// one discovered by name; key names its containers, "" for no knowledge base
// (which leaves only the services every knowledge base shares to ask of).
type stackView struct {
	st       *StackState
	key      string
	runtimes []string
	at       exposure // where its services are published
	name     string   // what the report calls its knowledge base beside a shared service
}

// newStackView: the view of st (nil for none recorded) keyed key, asked of
// --runtime's runtime when one is given, else the one its record names, else
// every installed one. A nonzero code: status could not run.
func newStackView(u *UI, st *StackState, key, runtime string) (stackView, int) {
	var runtimes []string
	switch {
	case runtime != "":
		if !onPath(runtime) {
			fmt.Fprintf(os.Stderr, "--runtime %s requested, but '%s' is not on PATH.\n", runtime, runtime)
			return stackView{}, 1
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
		return stackView{}, 1
	}
	v := stackView{st: st, key: key, runtimes: runtimes}
	if st != nil {
		v.at = st.exposure()
	}
	return v, 0
}

// nameViews names each view's knowledge base by the last segment of its DID,
// or by its full DID where two would share one.
func nameViews(views []stackView) {
	short := func(v stackView) string {
		if v.st == nil || v.st.KBDid == "" {
			return v.key
		}
		return v.st.KBDid[strings.LastIndexByte(v.st.KBDid, ':')+1:]
	}
	seen := map[string]int{}
	for _, v := range views {
		seen[short(v)]++
	}
	for i, v := range views {
		v.name = short(v)
		if seen[v.name] > 1 && v.st != nil && v.st.KBDid != "" {
			v.name = v.st.KBDid
		}
		views[i] = v
	}
}

// statusRow: one role's row, as a stack's record and its runtime report it.
type statusRow struct {
	role         string
	label        string // the role, and the product its driver names
	rt           string // where it runs: a runtime, external, host, or —
	word         string // running, exited, reachable, unreachable or absent
	probe        string // the endpoint asked
	detail       string // a dimmed note after the probe
	healthy      bool
	unconfigured bool          // the stack's documents ask for no such service
	rec          *ServiceState // the stack's record of it; nil for one discovered by name
}

// counted: whether the row's health is the stack's. A service the documents
// ask for none of is not missing, and the backends --no-observe leaves out
// count only when asked about by name.
func (r statusRow) counted(service string) bool {
	return !r.unconfigured && (!contains(optionalBackends, r.role) || service != "")
}

// readRow reads role's row in v. A service every knowledge base shares reads
// its state from the shared record of its container.
func readRow(v stackView, role string, shared map[string]*ServiceState) statusRow {
	handle := roleContainer(role, v.key)
	// No record: the descriptor's static probe, for the driver a stack
	// that has not recorded itself would be running. A record's endpoint
	// is sharper — it names the port that start actually used. A recorded
	// stack's own container with no entry (stopped alone, or not reached
	// by its start) is asked nowhere, and reads down: its port is its
	// knowledge base's, and the descriptor's is the default block's,
	// which another knowledge base's stack may hold. The shared
	// containers, and a role that runs none, answer where the
	// descriptor says for every knowledge base.
	endpoint := ""
	if v.st == nil || sharedRole(role) || !runsContainer(role) {
		endpoint = healthEndpoint(role, probeDriver(role), nil, v.at)
	}
	var rec *ServiceState
	if v.st != nil {
		if e, ok := v.st.Services[role]; ok {
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
	r := statusRow{role: role, label: role, rec: rec}
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
		r.label += " (" + tech + ")"
	}
	if rec != nil && rec.Provided == providedNone {
		r.unconfigured = true
		return r
	}

	state := ""
	switch {
	case rec != nil && rec.Provided == providedExternal:
		r.rt = "external"
	case rec != nil && rec.Provided == providedHost:
		r.rt = "host"
	case rec != nil && rec.Provided == providedShared:
		// The shared container the stack's record names, under the
		// runtime and handle its own record names. With no record it is
		// absent: stopped alone.
		if m := shared[rec.Container]; m != nil {
			h := sharedHandles(m.Runtime, rec.Container, m)[0]
			state, r.rt = containerState([]string{m.Runtime}, h)
		}
	case handle == "":
		// A container-less role (embedding, provided elsewhere) has
		// nothing to inspect. Never ask the runtime with an empty name:
		// Apple container answers [] and docker errors, but either could
		// just as well answer with EVERY container and be read as this
		// role running.
		r.rt = "external"
	default:
		state, r.rt = containerState(v.runtimes, handle)
	}
	r.healthy = endpoint != "" && roleHealthy(role, endpoint)
	if role == "inference" && rec == nil && state == "" && r.healthy {
		r.rt = "host"
	}

	// The STATUS word: the container state when there is a container
	// (running / exited), else what the probe can honestly say about a
	// role provided elsewhere (reachable / unreachable), else "absent".
	r.word = state
	if r.word == "" {
		switch {
		case r.rt == "external" || r.rt == "host":
			r.word = "unreachable"
			if r.healthy {
				r.word = "reachable"
			}
		default:
			r.word = "absent"
		}
	}
	if r.rt == "" {
		r.rt = "—"
	}
	r.probe = endpoint
	if rest, ok := strings.CutPrefix(r.probe, "tcp:"); ok {
		r.probe = "tcp://" + rest
	}
	return r
}

// browserRow: the Browser's row. It belongs to no stack, so it reads its own
// record; the image tag shows browser-vs-stack skew, since a kept Browser
// can outlive several stacks.
func browserRow(ss *StackSet) statusRow {
	b := ss.Shared[sharedContainer("browser")]
	p := BrowserTarget(ss, "")
	r := statusRow{role: "browser", label: "browser", rt: "—", word: p.State, probe: p.Endpoint, healthy: p.Running}
	if b != nil && b.Runtime != "" {
		r.rt = b.Runtime
	}
	if !p.Running && p.State == "" {
		r.word, r.probe = "absent", "any semiont start brings it up (or: semiont start --service browser)"
		return r
	}
	if r.word == "" {
		r.word = "absent"
	}
	if r.probe == "" {
		r.probe = "not recorded here"
	}
	r.detail = "discovery-synced"
	if b != nil && b.Image != "" {
		// A verified image is recorded by its digest too; the tag is before it.
		tagged, _, _ := strings.Cut(b.Image, "@")
		if i := strings.LastIndexByte(tagged, ':'); i > 0 {
			r.detail = "images " + tagged[i+1:] + " · " + r.detail
		}
	}
	return r
}

// printRowHeader: the header of a table of rows. One STATUS cell — mark +
// word — instead of STATE and HEALTH columns that say yes twice on every
// healthy row. The diagnostic divergences keep distinct words: "✗ running"
// (up but unhealthy) vs "✗ exited" (crashed, kept for inspection) vs
// "✓ reachable" (provided elsewhere). The probe endpoint stays, dimmed.
func printRowHeader() {
	fmt.Printf("  %-*s %-10s %s\n", serviceCell, "SERVICE", "RUNTIME", "STATUS")
}

// printRow prints r as a table row, naming the knowledge bases it serves when
// the report covers more than one.
func printRow(u *UI, r statusRow, serves []string) {
	if r.unconfigured {
		fmt.Printf("  %-*s %-10s %s\n", serviceCell, r.label, "—", u.Dim("not configured"))
		return
	}
	tail := ""
	if r.detail != "" {
		tail += "  " + u.Dim("("+r.detail+")")
	}
	if len(serves) > 0 {
		tail += "  " + u.Dim(strings.Join(serves, ", "))
	}
	fmt.Printf("  %-*s %-10s %s %-12s %s%s\n", serviceCell, r.label, r.rt, statusMark(u, r.healthy), r.word, u.Dim(r.probe), tail)
}

func statusMark(u *UI, healthy bool) string {
	if healthy {
		return u.Wrap(AnsiGreen, "✓")
	}
	return u.Wrap(AnsiRed, "✗")
}

// compactItem: r as one item of a knowledge base's group line — its mark and
// role, where it runs when somebody else runs it, and its state when it is
// not healthy.
func compactItem(u *UI, r statusRow) string {
	if r.unconfigured {
		return u.Dim("– " + r.role + " not configured")
	}
	item := statusMark(u, r.healthy) + " " + r.role
	if r.rt == "external" || r.rt == "host" {
		item += " " + u.Dim(r.rt)
	}
	if !r.healthy {
		word := r.word
		if word == "running" {
			word = "unhealthy"
		}
		item += " " + word
	}
	return item
}

// lazyBody: an HTTP body fetched on first ask, once.
type lazyBody struct {
	url     string
	body    string
	fetched bool
}

func (l *lazyBody) get() string {
	if !l.fetched {
		l.body, _ = httpBody(l.url)
		l.fetched = true
	}
	return l.body
}

// collectorReadout: the collector's Prometheus readout, which every start
// runs and every knowledge base's work in flight is read from.
func collectorReadout() *lazyBody { return &lazyBody{url: "http://localhost:24110/metrics"} }

// printInFlightOf prints what r has in flight in v's knowledge base, read from
// the collector's readout. Only for a service that is up: a dead service's
// last exported numbers are worse than no numbers. And only for the knowledge
// base the record names: without one there is no telling whose numbers they
// are.
func printInFlightOf(u *UI, v stackView, r statusRow, readout *lazyBody) {
	if r.healthy && (r.role == "dispatcher" || r.role == "gateway") && v.st != nil && v.st.KBDid != "" {
		printInFlight(u, r.role, readout.get(), v.st.KBDid)
	}
}

// printKnowledgeBase prints v's entry: what its knowledge base is and where
// it runs, then each group of its own services on a line, then its work in
// flight. Returns whether every counted service is healthy.
func printKnowledgeBase(u *UI, v stackView, shared map[string]*ServiceState, readout *lazyBody) bool {
	field := func(label, value string) { fmt.Printf("    %-8s %s\n", label, value) }
	st := v.st
	switch {
	case st != nil && st.KBRoot != "":
		ident, err := readKBIdentity(st.KBRoot)
		switch {
		case err != nil:
			fmt.Printf("  %s\n", u.Bold(st.KBDid))
			fmt.Printf("    %s\n", u.Wrap(AnsiYellow, "⚠ "+err.Error()))
		case ident != nil && ident.SiteName != "":
			fmt.Printf("  %s   %s\n", u.Bold(ident.SiteName), u.Dim(ident.didWeb()))
		default:
			fmt.Printf("  %s\n", u.Bold(st.KBDid))
		}
		field("clone", st.KBRoot)
		runs := st.Runtime
		if base, err := GatewayBase(st); err == nil {
			runs += " · gateway " + base
		}
		field("runs", runs)
		// Named from the setting alone: status never reaches for secrets.
		key := rootKey(st.KBDid, st.KBRoot)
		if ref, configured, err := storeSettingFor(key); err != nil {
			field("secrets", u.Wrap(AnsiYellow, err.Error()))
		} else {
			field("secrets", u.Dim(custodyStoreNamed(key, ref, configured).describe()))
		}
		if st.LanAddr != "" {
			field("network", u.Wrap(AnsiYellow, "lan: the gateway and the issuer answer the network at "+st.LanAddr+", over plain HTTP"))
			reviveIssuerProxy(u, st)
			if p := st.IssuerProxy; p != nil {
				field("proxy", u.Dim(fmt.Sprintf("issuer pid %d (%s → %s)", p.PID, p.Listen, p.Upstream)))
			}
		}
	case v.key != "":
		fmt.Printf("  %s\n", u.Bold(v.key))
		fmt.Printf("    %s\n", u.Dim("(no recorded stack — its services below are discovered by name)"))
	default:
		fmt.Printf("  %s\n", u.Dim("(no recorded stack — cd into a KB clone, or --root, for its stack's)"))
		return true
	}

	healthy := true
	var rows []statusRow
	for _, g := range serviceGroups {
		if g.shared() {
			continue
		}
		var items []string
		for _, role := range g.roles {
			r := readRow(v, role, shared)
			if r.counted("") {
				healthy = healthy && r.healthy
			}
			items = append(items, compactItem(u, r))
			rows = append(rows, r)
		}
		field(g.name, strings.Join(items, "  "))
	}
	for _, r := range rows {
		printInFlightOf(u, v, r, readout)
	}
	return healthy
}

// sharedRow: one row of a service several knowledge bases share, and the
// views it serves.
type sharedRow struct {
	row   statusRow
	views []stackView
}

// printSharedGroup prints a section of the services every knowledge base
// shares: each once, naming the knowledge bases it serves when the report
// covers more than one, with the models each uses beneath it. Returns
// whether every counted one is healthy. The Browser is reported and never
// counted: a stack is healthy whether or not anyone is viewing it.
func printSharedGroup(u *UI, g serviceGroup, views []stackView, ss *StackSet, ceilings func(stackView) modelCeilings) bool {
	u.Section(strings.ToUpper(strings.ReplaceAll(g.name, "-", " ")))
	printRowHeader()
	healthy := true
	for _, role := range g.roles {
		if role == "browser" {
			printRow(u, browserRow(ss), nil)
			continue
		}
		var rows []*sharedRow
		var unconfigured *statusRow
		for _, v := range views {
			r := readRow(v, role, ss.Shared)
			if r.unconfigured {
				unconfigured = &r
				continue
			}
			i := slices.IndexFunc(rows, func(s *sharedRow) bool { return s.row.label == r.label && s.row.probe == r.probe })
			if i < 0 {
				rows = append(rows, &sharedRow{row: r})
				i = len(rows) - 1
			}
			rows[i].views = append(rows[i].views, v)
		}
		if len(rows) == 0 && unconfigured != nil {
			printRow(u, *unconfigured, nil)
			continue
		}
		for _, s := range rows {
			var serves []string
			if len(views) > 1 {
				for _, v := range s.views {
					serves = append(serves, v.name)
				}
			}
			printRow(u, s.row, serves)
			if s.row.counted("") {
				healthy = healthy && s.row.healthy
			}
			printSharedModels(u, s, len(views) > 1, ceilings)
		}
	}
	return healthy
}

// printSharedModels prints the models each knowledge base s serves was
// started with, beneath its row: a line each, and one line for a model
// several use that reads the same for each, naming them when name says to.
func printSharedModels(u *UI, s *sharedRow, name bool, ceilings func(stackView) modelCeilings) {
	type using struct {
		v   stackView
		rec ServiceState
	}
	var uses []using
	var all []servedModel
	for _, v := range s.views {
		if v.st == nil {
			continue
		}
		if rec := v.st.Services[s.row.role]; len(rec.Models) > 0 {
			uses = append(uses, using{v, rec})
			all = append(all, rec.Models...)
		}
	}
	if len(uses) == 0 {
		return
	}
	// Only reach for Ollama when this row actually has models it serves —
	// an all-remote row must not probe it at all.
	var facts modelFacts
	if len(servedBy(all, "ollama")) > 0 {
		facts = fetchModelFacts(ollamaBase(uses[0].rec.Endpoint))
	}
	w := modelWidth(all)
	var order []string
	names := map[string][]string{}
	for _, use := range uses {
		for _, l := range modelLines(u, use.rec.Models, facts, remoteModels(use.rec), ceilings(use.v), w) {
			if _, ok := names[l]; !ok {
				order = append(order, l)
			}
			names[l] = append(names[l], use.v.name)
		}
	}
	for _, l := range order {
		if name {
			l += "  " + u.Dim(strings.Join(names[l], ", "))
		}
		fmt.Println(l)
	}
}

// remoteModels: what the record says of each remote model rec serves —
// refreshed live, for Anthropic, only when its key is already in this
// process's environment: status never resolves secrets (no op reads, no
// prompts). Availability can drift after start (a model withdrawn
// mid-flight), so fresher is better when it is free.
func remoteModels(rec ServiceState) map[string]remoteModelMeta {
	remote := rec.RemoteModels
	if rec.Driver != "anthropic" {
		return remote
	}
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		return remote
	}
	live, ok := fetchAnthropicModels(anthropicBase(rec.Endpoint), key)
	if !ok {
		return remote
	}
	remote = map[string]remoteModelMeta{}
	for _, m := range servedBy(rec.Models, "anthropic") {
		if meta, listed := live[m]; listed {
			remote[m] = meta
		} else {
			remote[m] = remoteModelMeta{Available: false}
		}
	}
	return remote
}

// printServiceRows prints the row of the one service --service names, for
// each view — under its knowledge base's name when there are several — with
// what it has in flight and the models it serves beneath it. Returns whether
// every such row is healthy.
func printServiceRows(u *UI, views []stackView, service string, shared map[string]*ServiceState, ceilings func(stackView) modelCeilings) bool {
	healthy := true
	readout := collectorReadout()
	for i, v := range views {
		if len(views) > 1 {
			if i > 0 {
				fmt.Println()
			}
			fmt.Printf("  %s\n", u.Bold(v.name))
		}
		printRowHeader()
		if v.key == "" && !sharedRole(service) {
			continue // no knowledge base names a stack container to ask of
		}
		r := readRow(v, service, shared)
		printRow(u, r, nil)
		if r.counted(service) {
			healthy = healthy && r.healthy
		}
		printInFlightOf(u, v, r, readout)
		if r.rec != nil && len(r.rec.Models) > 0 {
			var facts modelFacts
			if len(servedBy(r.rec.Models, "ollama")) > 0 {
				facts = fetchModelFacts(ollamaBase(r.rec.Endpoint))
			}
			for _, l := range modelLines(u, r.rec.Models, facts, remoteModels(*r.rec), ceilings(v), modelWidth(r.rec.Models)) {
				fmt.Println(l)
			}
		}
	}
	return healthy
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
	// Each running local stack has its entry above. An active codespace
	// stack is listed here, addressed exactly as its row in `semiont roots`
	// (https://), so the jump from pointer to catalog is one glance. Active
	// is a local fact: a codespace whose forward is alive AND answering
	// (forwardAlive) — a record whose tunnel is gone is history, not
	// activity, and no gh round-trip is spent deciding.
	cwdRunning := false
	for _, st := range locals {
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
