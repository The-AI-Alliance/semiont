package launcher

import (
	"fmt"
	"os"
)

const stopUsage = `Usage: semiont stop [--runtime container|docker|podman] [--dry-run]

Stop the whole Semiont stack — services, dependencies, and observability —
and clean up the staged config copies. Safe to run when nothing is up:
every step is a no-op then.

With no --runtime, EVERY installed runtime is swept — stopping via the wrong
runtime is a silent no-op that leaves the real stack running.
`

// stopNames sweeps all ten container names — services first, then
// dependencies, then observability.
var stopNames = []string{
	"semiont-backend", "semiont-worker", "semiont-smelter", "semiont-weaver",
	"semiont-frontend", "semiont-neo4j", "semiont-qdrant", "semiont-postgres",
	"semiont-ollama", "semiont-jaeger",
}

// Stop implements `semiont stop` — the port of the fleet's stop.sh.
func Stop(args []string) int {
	u := newUI(false)
	runtime := ""
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

	// Which runtimes to sweep: the requested one, or EVERY installed runtime.
	// Stopping is idempotent (stop/rm of absent names are no-ops), so sweeping
	// all runtimes structurally kills the classic trap: a bare `semiont stop`
	// after `semiont start --runtime docker` picking a different runtime,
	// reporting success, and leaving the real stack running.
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

	if dryRun {
		fmt.Println("# semiont stop --dry-run — the exact runtime commands a real run would")
		fmt.Println("# execute, in order.")
		for _, rt := range runtimes {
			for _, c := range stopNames {
				fmt.Println(renderCmd(rt, "stop", c))
				fmt.Println(renderCmd(rt, "rm", c))
			}
		}
		fmt.Println("# remove staged config copies: /tmp/semiont-config.*")
		return 0
	}

	// stop-then-rm: under Apple Container a stopped --rm container persists
	// (the next `run --name` would fail with "already exists"), so rm makes
	// this idempotent across all three states: running, stopped, absent.
	for _, rt := range runtimes {
		for _, c := range stopNames {
			_ = runSilent(rt, "stop", c)
			_ = runSilent(rt, "rm", c)
		}
	}

	// Per-service config copies staged by semiont start for the bind mounts.
	removeStagedConfigs()

	fmt.Println("Semiont stack stopped.")
	return 0
}

// Version implements `semiont version`.
func Version(args []string) int {
	fmt.Printf("semiont %s (commit %s, built %s)\n", BuildVersion, BuildCommit, BuildDate)
	return 0
}
