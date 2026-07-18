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

With --service <name>, report just that one service — the exit status then
reflects that service alone (Jaeger included), making it scriptable:
  semiont status --service backend && echo up
`

// statusServices drives the report, in user-facing-first order with each
// service beside its primary store (backend→PostgreSQL, worker→Ollama
// inference, weaver→Neo4j graph, smelter→Qdrant vectors), observability
// last. Deliberately unrelated to start/stop ordering (which is dependency
// order). Health probes are host-side: the same endpoints start's health
// gates poll.
var statusServices = []struct {
	name     string // display + container-name suffix
	endpoint string // http(s) URL, or "tcp:<port>"
	core     bool   // counted toward the exit status
}{
	{"frontend", "http://localhost:3000", true},
	{"backend", "http://localhost:4000/api/health", true},
	{"postgres", "tcp:5432", true},
	{"worker", "http://localhost:9090/health", true},
	{"ollama", "http://localhost:11434/api/version", true},
	{"weaver", "http://localhost:9092/health", true},
	{"neo4j", "http://localhost:7474", true},
	{"smelter", "http://localhost:9091/health", true},
	{"qdrant", "http://localhost:6333/readyz", true},
	{"jaeger", "http://localhost:16686", false},
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
		if _, known := startableServices[service]; !known {
			u.fail("Unknown --service '%s' (expected: jaeger, neo4j, qdrant, ollama, postgres, backend, worker, smelter, weaver, or frontend)", service)
			return 1
		}
	}

	var runtimes []string
	if runtime != "" {
		if !onPath(runtime) {
			fmt.Fprintf(os.Stderr, "--runtime %s requested, but '%s' is not on PATH.\n", runtime, runtime)
			return 1
		}
		runtimes = []string{runtime}
	} else {
		runtimes = installedRuntimes()
	}
	if len(runtimes) == 0 {
		u.fail("No container runtime found. Install Apple Container, Docker, or Podman.")
		return 1
	}

	fmt.Printf("  %-10s %-10s %-10s %s\n", "SERVICE", "CONTAINER", "RUNTIME", "HEALTH")
	allCoreHealthy := true
	for _, svc := range statusServices {
		if service != "" && svc.name != service {
			continue
		}
		state, rt := containerState(runtimes, "semiont-"+svc.name)
		healthy := probeHealth(svc.endpoint)

		// Host Ollama reuse: no container, but the endpoint answers — that is
		// a healthy configuration, not a gap.
		if svc.name == "ollama" && state == "" && healthy {
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
		label := svc.endpoint
		if port, ok := strings.CutPrefix(label, "tcp:"); ok {
			label = "tcp://localhost:" + port
		}
		healthCol := u.wrap(ansiRed, "✗") + " " + u.dim(label)
		if healthy {
			healthCol = u.wrap(ansiGreen, "✓") + " " + u.dim(label)
		}
		fmt.Printf("  %-10s %-*s %-*s %s\n",
			svc.name, 10+utf8.RuneCountInString(stateCol)-visibleLen(stateCol), stateCol,
			10+utf8.RuneCountInString(rt)-visibleLen(rt), rt, healthCol)
	}
	if service == "" {
		printHostDirs(u)
	}

	if allCoreHealthy {
		return 0
	}
	return 1
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
	staged, _ := filepath.Glob("/tmp/semiont-config.*")
	note := "none"
	if n := len(staged); n > 0 {
		note = fmt.Sprintf("%d present", n)
	}
	row("staging", "/tmp/semiont-config.*", note)
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".ollama")
		row("ollama", p, presence(p))
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
	if port, ok := strings.CutPrefix(endpoint, "tcp:"); ok {
		conn, err := net.DialTimeout("tcp", "localhost:"+port, time.Second)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}
	return httpOK(endpoint)
}
