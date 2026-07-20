package launcher

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const statusUsage = `Usage: semiont status [--root <path|name>] [--repo <owner/name> [--refresh]] [--service <name>] [--runtime container|docker|podman] [--verbose]

Reports what this machine knows about, in three layers:

  LOCAL STACK    the one stack running here, and the root it belongs to
  LOCAL ROOTS    every KB clone the launcher has used (roots.json)
  REMOTE KNOWLEDGE BASES
                 codespace-hosted KBs, their state, and their KB port

--verbose adds LAUNCHER PATHS: the launcher's own config, cache, log, state,
staging and model-cache paths on this host. They describe the tool, not any
KB, and change only when the launcher itself does — so they are asked for
rather than shown.

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
  semiont status --service backend     && echo backend-up

Those forms exit 0 only when the named stack (or service) is healthy.

status never wakes a stopped codespace. --refresh (with --repo) re-reads that
KB's did:web identity over ssh to confirm the recorded one — it is skipped,
with a note, unless the codespace is already running.
`

// statusServices drives the report, in user-facing-first order with each
// service beside its primary store (backend→database, worker→inference,
// weaver→graph, smelter→vectors), observability last. Deliberately unrelated
// to start/stop ordering (which is dependency order). Names are the abstract
// roles; the roles table maps them to containers. Health probes are
// host-side: the same endpoints start's health gates poll.
var statusServices = []struct {
	name     string // abstract role (keys the roles table)
	endpoint string // http(s) URL, or "tcp:<port>"
	core     bool   // counted toward the exit status
}{
	{"frontend", "http://localhost:3000", true},
	{"backend", "http://localhost:4000/api/health", true},
	{"database", "tcp:5432", true},
	{"worker", "http://localhost:9090/health", true},
	{"inference", "http://localhost:11434/api/version", true},
	{"weaver", "http://localhost:9092/health", true},
	{"graph", "http://localhost:7474", true},
	{"smelter", "http://localhost:9091/health", true},
	{"vectors", "http://localhost:6333/readyz", true},
	{"traces", "http://localhost:16686", false},
}

// Status implements `semiont status`.
//
// Layout follows the concepts, not the machinery: LOCAL ROOTS and REMOTE
// REPOS are the durable things a user owns; a stack is transient status
// layered on one of them (a local stack belongs to zero or one local root).
// So the report always opens with LOCAL STACK — present or not — then REMOTE
// REPOS, then the registries beneath both.
func Status(args []string) int {
	u := newUI(false)
	runtime, service, repoFlag, rootFlag := "", "", "", ""
	refresh := false
	verbose := false
	for i := 0; i < len(args); i++ {
		need := func() (string, bool) {
			if i+1 >= len(args) {
				u.fail("Missing value for %s", args[i])
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
		case "--help", "-h":
			fmt.Print(statusUsage)
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
	if repoFlag != "" && (rootFlag != "" || service != "") {
		u.fail("--repo names a remote stack; --root/--service name the local one.")
		return 1
	}
	if refresh && repoFlag == "" {
		u.fail("--refresh re-reads ONE remote KB's identity over ssh — name it with --repo <owner/name>.")
		return 1
	}

	ss := loadStackSet()
	cs := codespaceStacks(ss)
	st := ss.Stacks["local"]

	// --repo: one remote stack, health-coded for scripting.
	if repoFlag != "" {
		target := ss.Stacks["codespace:"+repoFlag]
		if target == nil {
			u.fail("No codespace stack recorded for %s.", repoFlag)
			for _, c := range cs {
				fmt.Fprintf(os.Stderr, "    recorded: %s\n", c.Repo)
			}
			return 1
		}
		return statusCodespace(u, target, refresh)
	}

	// --root: assert the local stack belongs to that root before reporting it.
	if rootFlag != "" {
		want, err := resolveRootArg(rootFlag)
		if err != nil {
			u.fail("%v", err)
			return 1
		}
		if st == nil {
			u.fail("No local stack is running (root %s).", want)
			return 1
		}
		if st.KBRoot != "" && st.KBRoot != want {
			u.fail("The local stack belongs to %s, not %s.", st.KBRoot, want)
			return 1
		}
	}

	healthy, code := printLocalStack(u, st, runtime, service)
	if code != 0 {
		return code
	}
	if service == "" {
		printRoots(u, st)
	}
	if service == "" && rootFlag == "" {
		printRemoteKBs(u, cs)
	}
	if service == "" && verbose {
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

// printLocalStack renders the LOCAL STACK section: the root it belongs to,
// its provenance, and the service table. Returns whether every counted
// service is healthy, plus a nonzero code if status itself could not run.
func printLocalStack(u *ui, st *stackState, runtime, service string) (healthy bool, code int) {
	if service == "" {
		fmt.Println()
		fmt.Println("  LOCAL STACK")
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
		u.fail("No container runtime found. Install Apple Container, Docker, or Podman.")
		return false, 1
	}

	// Identity first: a stack is status layered on a root, so name the root
	// (and its did:web) before the services. Provenance is dimmed detail, not
	// narration wedged between sections.
	if service == "" {
		if st != nil && st.KBRoot != "" {
			fmt.Printf("  %s\n", st.KBRoot)
			if ident := loadKBIdentity(st.KBRoot); ident != nil && ident.SiteName != "" {
				fmt.Printf("    %s %s\n", u.dim(ident.didWeb()), u.dim("— "+ident.SiteName))
			}
		} else if st == nil {
			fmt.Printf("  %s\n", u.dim("(no recorded stack — services below are discovered by name)"))
		}
		if st != nil {
			note := st.Runtime
			if st.Version != "" {
				note += " · images " + st.Version
			}
			fmt.Printf("    %s\n", u.dim(note+" · "+statePath()))
		}
		fmt.Println()
	}

	fmt.Printf("  %-22s %-10s %-10s %s\n", "SERVICE", "STATE", "RUNTIME", "HEALTH")
	healthy = true
	for _, svc := range statusServices {
		if service != "" && svc.name != service {
			continue
		}
		handle := roles[svc.name].container
		endpoint := svc.endpoint
		var rec *serviceState
		if st != nil {
			if e, ok := st.Services[svc.name]; ok {
				rec = &e
				if e.ID != "" {
					handle = e.ID
				}
				if e.Endpoint != "" {
					endpoint = e.Endpoint
				}
			}
		}

		// The concrete product rides in the SERVICE cell — "database
		// (PostgreSQL)" — rather than a column that is an em-dash for every
		// Semiont service.
		label := svc.name
		tech := roles[svc.name].product
		if rec != nil && rec.Driver != "" {
			tech = driverDisplay(svc.name, rec.Driver)
		}
		if tech != "" {
			label += " (" + tech + ")"
		}

		if rec != nil && rec.Provided == providedNone {
			fmt.Printf("  %-22s %-10s %-10s %s\n", label, "—", "—", u.dim("not configured"))
			continue
		}

		state, rt := "", ""
		switch {
		case rec != nil && rec.Provided == providedExternal:
			rt = "external"
		case rec != nil && rec.Provided == providedHost:
			rt = "host"
		default:
			state, rt = containerState(runtimes, handle)
		}
		isHealthy := probeHealth(endpoint)
		if svc.name == "inference" && rec == nil && state == "" && isHealthy {
			rt = "host"
		}
		if !isHealthy && (svc.core || service != "") {
			healthy = false
		}

		stateCol := state
		switch {
		case state == "running":
			stateCol = u.wrap(ansiGreen, state)
		case state == "":
			stateCol = u.dim("—")
		default:
			stateCol = u.wrap(ansiYellow, state)
		}
		if rt == "" {
			rt = u.dim("—")
		}
		probe := endpoint
		if rest, ok := strings.CutPrefix(probe, "tcp:"); ok {
			if strings.Contains(rest, ":") {
				probe = "tcp://" + rest
			} else {
				probe = "tcp://localhost:" + rest
			}
		}
		healthCol := u.wrap(ansiRed, "✗") + " " + u.dim(probe)
		if isHealthy {
			healthCol = u.wrap(ansiGreen, "✓") + " " + u.dim(probe)
		}
		fmt.Printf("  %-22s %-*s %-*s %s\n",
			label, 10+utf8.RuneCountInString(stateCol)-visibleLen(stateCol), stateCol,
			10+utf8.RuneCountInString(rt)-visibleLen(rt), rt, healthCol)
	}
	return healthy, 0
}

// printRoots reports the Semiont roots: every registered root (roots.json —
// the launcher's memory of roots it has actually used), merged with the one
// resolvable from here (SEMIONT_ROOT or cwd discovery) and the running
// stack's, each annotated with everything true about it. Vanished paths are
// flagged, not hidden.
func printRoots(u *ui, st *stackState) {
	fmt.Println()
	fmt.Println("  LOCAL ROOTS")
	order := []string{}
	labels := map[string][]string{}
	add := func(path, label string) {
		if _, ok := labels[path]; !ok {
			order = append(order, path)
		}
		labels[path] = append(labels[path], label)
	}

	if path, source, err := resolveKBRoot(); err == nil {
		label := "discovered from cwd"
		if source == "SEMIONT_ROOT" {
			label = "SEMIONT_ROOT"
		}
		add(path, label)
	} else if os.Getenv("SEMIONT_ROOT") != "" {
		// Strictness without failing the report: an invalid override is
		// surfaced, not silently ignored.
		fmt.Printf("  %s\n", u.wrap(ansiYellow, fmt.Sprintf("⚠ %v", err)))
	}
	if st != nil && st.KBRoot != "" {
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
		fmt.Printf("  %s\n", u.dim("(none — cd into a KB clone, set SEMIONT_ROOT, or start with --root)"))
		return
	}
	// Identity per root: the registry's stored did/siteName (survives the
	// path vanishing), refreshed by a live read when the root is present.
	reg := loadRoots()
	for _, p := range order {
		fmt.Printf("  %s %s\n", p, u.dim("("+strings.Join(labels[p], "; ")+")"))
		did, site, cfg := "", "", ""
		for _, e := range reg.Roots {
			if e.Path == p {
				did, site, cfg = e.Did, e.SiteName, e.Config
			}
		}
		if ident := loadKBIdentity(p); ident != nil {
			did, site = ident.didWeb(), ident.SiteName
		}
		// LOCAL STACK already printed this root's identity directly above;
		// repeating it here is noise.
		if st != nil && st.KBRoot == p {
			did, site = "", ""
		}
		switch {
		case did != "" && site != "":
			fmt.Printf("    %s %s\n", u.dim(did), u.dim("— "+site))
		case did != "":
			fmt.Printf("    %s\n", u.dim(did))
		}
		if cfg != "" {
			fmt.Printf("    %s\n", u.dim("config: "+cfg+" (used when --config is omitted)"))
		}
	}
}

// printLauncherPaths reports the host-side paths the stack touches, under
// --verbose only: they describe the LAUNCHER, not any KB, and change only
// when the launcher itself does — so the everyday report leads with roots
// and stacks instead. (Paths, not
// "directories" — the state entry is a file.) They are: the
// launcher's XDG-resolved config/cache homes (reserved by design — see
// GO-LAUNCHER.md host need #1; Go maps them to XDG_* on Linux and
// ~/Library/... on macOS), the live config staging under /tmp (never
// $TMPDIR — Apple container cannot sustain mounts from /var/folders), and
// the Ollama model cache a container run may share.
func printLauncherPaths(u *ui) {
	fmt.Println()
	fmt.Println("  LAUNCHER PATHS")
	row := func(label, path, note string) {
		fmt.Printf("  %-10s %s %s\n", label, path, u.dim("("+note+")"))
	}
	presence := func(path string) string {
		if _, err := os.Stat(path); err == nil {
			return "present"
		}
		return "absent"
	}
	if cfg, err := os.UserConfigDir(); err == nil {
		p := filepath.Join(cfg, "semiont")
		row("config", p, presence(p))
	}
	if cache, err := os.UserCacheDir(); err == nil {
		p := filepath.Join(cache, "semiont")
		row("cache", p, presence(p))
	}
	if p := logDir(); p != "" {
		row("logs", p, presence(p))
	}
	if p := statePath(); p != "" {
		row("state", p, presence(p))
	}
	staged, _ := filepath.Glob("/tmp/semiont-config.*")
	note := "none"
	if n := len(staged); n > 0 {
		note = fmt.Sprintf("%d present", n)
	}
	row("staging", "/tmp/semiont-config.*", note)
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".ollama")
		row("inference", p, presence(p))
	}
}

// visibleLen is the printed width of a string minus its ANSI escapes — needed
// so %-*s column padding lines up whether or not color is on.
func visibleLen(s string) int {
	n := 0
	inEsc := false
	for _, r := range s {
		switch {
		case inEsc:
			if r == 'm' {
				inEsc = false
			}
		case r == '\033':
			inEsc = true
		default:
			n++
		}
	}
	return n
}

// containerState asks each runtime for the container's state, first hit wins.
// Apple `container inspect` emits a JSON array with a top-level "status"
// field (empty array once a --rm container is gone); docker/podman answer
// short state strings via inspect -f.
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

// probeHealth runs one host-side application probe: 2xx for http endpoints,
// an accepted dial for tcp ones.
func probeHealth(endpoint string) bool {
	if rest, ok := strings.CutPrefix(endpoint, "tcp:"); ok {
		addr := rest
		if !strings.Contains(rest, ":") {
			addr = "localhost:" + rest
		}
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}
	return httpOK(endpoint)
}
