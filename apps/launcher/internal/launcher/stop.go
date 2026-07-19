package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const stopUsage = `Usage: semiont stop [--service <name>] [--runtime container|docker|podman] [--dry-run]

Stop the whole Semiont stack — services, dependencies, and observability —
and clean up the staged config copies. Safe to run when nothing is up:
every step is a no-op then.

With no --runtime, EVERY installed runtime is swept — stopping via the wrong
runtime is a silent no-op that leaves the real stack running.

With --service <name>, stop just that one service (backend, worker, smelter,
weaver, frontend, db, graph, vectors, inference, or traces). The staged
config copies are left in place — the rest of the stack is still mounting
them.
`

// stopNames sweeps all ten container names in REVERSE start order —
// dependents before their dependencies, so nothing spends teardown alive
// with its upstream already gone (start brings up jaeger → neo4j → qdrant →
// ollama → postgres → backend → worker → smelter → weaver → frontend).
var stopNames = []string{
	"semiont-frontend", "semiont-weaver", "semiont-smelter", "semiont-worker",
	"semiont-backend", "semiont-postgres", "semiont-ollama", "semiont-qdrant",
	"semiont-neo4j", "semiont-jaeger",
}

// Stop implements `semiont stop` — the port of the fleet's stop.sh.
func Stop(args []string) int {
	u := newUI(false)
	runtime := ""
	service := ""
	dryRun := false
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

	if service != "" {
		if _, known := roles[service]; !known {
			u.fail("Unknown --service '%s' (expected: %s)", service, roleList)
			return 1
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
	st := loadState()
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
			names = []string{roles[service].container}
		}
		if !useState {
			return names
		}
		out := make([]string, 0, len(names))
		for _, c := range names {
			role := roleByContainer[c]
			if e, ok := st.Services[role]; ok {
				if e.HostReuse {
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

	if dryRun {
		fmt.Println("# semiont stop --dry-run — the exact runtime commands a real run would")
		fmt.Println("# execute, in order.")
		for _, rt := range runtimes {
			for _, c := range targets {
				fmt.Println(renderCmd(rt, "stop", c))
				fmt.Println(renderCmd(rt, "rm", c))
			}
		}
		if service == "" {
			fmt.Println("# remove staged config copies: /tmp/semiont-config.*")
		} else {
			fmt.Println("# staged config copies left in place (--service)")
		}
		return 0
	}

	// stop-then-rm: under Apple Container a stopped --rm container persists
	// (the next `run --name` would fail with "already exists"), so rm makes
	// this idempotent across all three states: running, stopped, absent.
	u.log("Sweeping %d container(s) across %s %s", len(targets),
		strings.Join(runtimes, ", "), u.dim("(stop+rm each; exact commands: semiont stop --dry-run)"))
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
		elapsed := u.dim("(" + took(time.Since(t0)) + ")")
		if removed == 0 {
			u.ok("%s: none found %s", rt, elapsed)
		} else {
			u.ok("%s: %d removed %s", rt, removed, elapsed)
		}
	}

	if service != "" {
		// The record forgets this one service; the rest of it stands.
		if useState {
			delete(st.Services, service)
			saveState(st)
		}
		fmt.Printf("%s stopped (staged configs left in place; rest of the stack untouched).\n", service)
		return 0
	}

	// Per-service config copies staged by semiont start for the bind mounts.
	staged, _ := filepath.Glob("/tmp/semiont-config.*")
	removeStagedConfigs()
	if len(staged) > 0 {
		u.ok("Removed %d staged config dir(s)", len(staged))
	}
	removeState()

	fmt.Println("Semiont stack stopped.")
	return 0
}

// Version implements `semiont version`.
func Version(args []string) int {
	fmt.Printf("semiont %s (commit %s, built %s)\n", BuildVersion, BuildCommit, BuildDate)
	return 0
}
