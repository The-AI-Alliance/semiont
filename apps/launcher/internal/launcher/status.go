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

const statusUsage = `Usage: semiont status [--service <name>] [--runtime container|docker|podman]

Report each Semiont container's runtime state and application-level health.

For every service: the container state as the runtime reports it (running /
exited / absent — across all installed runtimes unless --runtime narrows it),
and a host-side application health probe (the same endpoints semiont start
gates on; a TCP dial for PostgreSQL). An Ollama serving from the host with no
container is reported as runtime "host" — the same reuse semiont start applies.

Also reports the host directories the stack touches: the launcher's
XDG-resolved config/cache homes, the /tmp config staging, and the Ollama
model cache.

Exit status: 0 when every core service is healthy (Jaeger is observability,
not core), 1 otherwise.

With --service <name>, report just that one service (backend, worker,
smelter, weaver, frontend, database, graph, vectors, inference, or traces) — the
exit status then reflects that service alone (traces included), making it
scriptable:
  semiont status --service backend && echo up
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
func Status(args []string) int {
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

	// The recorded stack state (when present) narrows the query to the
	// runtime that actually started the stack, and supplies the identifiers
	// the runtime reported at start — the record is belief; every claim below
	// is still verified against the runtime and the health endpoints.
	st := loadState()
	var runtimes []string
	if runtime != "" {
		if !onPath(runtime) {
			fmt.Fprintf(os.Stderr, "--runtime %s requested, but '%s' is not on PATH.\n", runtime, runtime)
			return 1
		}
		runtimes = []string{runtime}
		if st != nil && runtime != st.Runtime {
			st = nil // record is about a different runtime's stack
		}
	} else if st != nil && st.Runtime != "" && onPath(st.Runtime) {
		runtimes = []string{st.Runtime}
		note := st.Runtime
		if st.Version != "" {
			note += "; images " + st.Version
		}
		u.log("Using recorded stack state %s", u.dim("("+note+"; "+statePath()+")"))
	} else {
		st = nil
		runtimes = installedRuntimes()
	}
	if len(runtimes) == 0 {
		u.fail("No container runtime found. Install Apple Container, Docker, or Podman.")
		return 1
	}

	fmt.Printf("  %-10s %-12s %-10s %-10s %s\n", "SERVICE", "TECH", "CONTAINER", "RUNTIME", "HEALTH")
	allCoreHealthy := true
	for _, svc := range statusServices {
		if service != "" && svc.name != service {
			continue
		}
		// The record supplies the identifier, the endpoint, and who provides
		// the role; the runtime and the probe stay the ground truth.
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

		// Not referenced by the config: no probe, no exit-status impact.
		if rec != nil && rec.Provided == providedNone {
			fmt.Printf("  %-10s %-12s %-10s %-10s %s\n", svc.name, "—", "—", "—", u.dim("not configured"))
			continue
		}

		// TECH: the concrete product behind an infra role — the recorded
		// driver (survives config changes since start), falling back to the
		// static product for records that predate the driver field. Semiont
		// services stay blank: the role name already says what they are, and
		// their image version is stack-level (shown once in the header line).
		tech := roles[svc.name].product
		if rec != nil && rec.Driver != "" {
			tech = driverDisplay(svc.name, rec.Driver)
		}
		if tech == "" {
			tech = "—"
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
		healthy := probeHealth(endpoint)

		// Host Ollama reuse heuristic for record-less stacks: no container,
		// but the endpoint answers — a healthy configuration, not a gap.
		if svc.name == "inference" && rec == nil && state == "" && healthy {
			rt = "host"
		}

		// Filtered to one service, its health IS the exit status — Jaeger
		// included: asking about it explicitly makes it the question.
		if !healthy && (svc.core || service != "") {
			allCoreHealthy = false
		}

		stateCol := state
		switch {
		case state == "running":
			stateCol = u.wrap(ansiGreen, state)
		case state == "":
			stateCol = u.dim("—")
		default: // exited / stopped / created / unknown
			stateCol = u.wrap(ansiYellow, state)
		}
		if rt == "" {
			rt = u.dim("—")
		}
		label := endpoint
		if rest, ok := strings.CutPrefix(label, "tcp:"); ok {
			if strings.Contains(rest, ":") {
				label = "tcp://" + rest
			} else {
				label = "tcp://localhost:" + rest
			}
		}
		healthCol := u.wrap(ansiRed, "✗") + " " + u.dim(label)
		if healthy {
			healthCol = u.wrap(ansiGreen, "✓") + " " + u.dim(label)
		}
		fmt.Printf("  %-10s %-12s %-*s %-*s %s\n",
			svc.name, tech, 10+utf8.RuneCountInString(stateCol)-visibleLen(stateCol), stateCol,
			10+utf8.RuneCountInString(rt)-visibleLen(rt), rt, healthCol)
	}
	if service == "" {
		printRoots(u, st)
		printHostDirs(u)
	}

	if allCoreHealthy {
		return 0
	}
	return 1
}

// printRoots reports the Semiont roots: every registered root (roots.json —
// the launcher's memory of roots it has actually used), merged with the one
// resolvable from here (SEMIONT_ROOT or cwd discovery) and the running
// stack's, each annotated with everything true about it. Vanished paths are
// flagged, not hidden.
func printRoots(u *ui, st *stackState) {
	fmt.Println()
	fmt.Println("  SEMIONT ROOTS")
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
		did, site := "", ""
		for _, e := range reg.Roots {
			if e.Path == p {
				did, site = e.Did, e.SiteName
			}
		}
		if ident := loadKBIdentity(p); ident != nil {
			did, site = ident.didWeb(), ident.SiteName
		}
		switch {
		case did != "" && site != "":
			fmt.Printf("    %s %s\n", u.dim(did), u.dim("— "+site))
		case did != "":
			fmt.Printf("    %s\n", u.dim(did))
		}
	}
}

// printHostDirs reports the host-side directories the stack touches: the
// launcher's XDG-resolved config/cache homes (reserved by design — see
// GO-LAUNCHER.md host need #1; Go maps them to XDG_* on Linux and
// ~/Library/... on macOS), the live config staging under /tmp (never
// $TMPDIR — Apple container cannot sustain mounts from /var/folders), and
// the Ollama model cache a container run may share.
func printHostDirs(u *ui) {
	fmt.Println()
	fmt.Println("  LOCAL HOST DIRECTORIES")
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
