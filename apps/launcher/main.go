// semiont — host-installed launcher for a local Semiont stack.
//
// Drives the container runtime CLI (Apple `container`, docker, or podman)
// directly via subprocesses; see .plans/GO-LAUNCHER.md in the monorepo for
// the design and the fleet forensics this port preserves.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"
)

func usage(w *os.File) {
	fmt.Fprint(w, `Usage: semiont <command> [options]

Local Semiont stack launcher — drives your container runtime
(Apple container, Docker, or Podman) directly.

Commands:
  start     Start the local Semiont stack
  logs      Follow the running stack's service logs
  stop      Stop the stack across all installed runtimes
  version   Print the launcher version

Run 'semiont <command> --help' for command options.
`)
}

// suppressHeader: the brand header stays off the machine seams — --dry-run
// output is a consumable plan, --quiet is quiet.
func suppressHeader(args []string) bool {
	for _, a := range args {
		switch a {
		case "--quiet", "-q", "--dry-run":
			return true
		}
	}
	return false
}

func main() {
	if !suppressHeader(os.Args[1:]) {
		launcher.PrintPreamble()
	}
	if len(os.Args) < 2 {
		usage(os.Stderr)
		os.Exit(1)
	}
	cmd, rest := os.Args[1], os.Args[2:]
	code := 0
	switch cmd {
	case "start":
		code = launcher.Start(rest)
	case "logs":
		code = launcher.Logs(rest)
	case "stop":
		code = launcher.Stop(rest)
	case "version", "--version":
		code = launcher.Version(rest)
	case "--help", "-h", "help":
		usage(os.Stdout)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		// The old KB scripts took flags directly; the launcher needs the
		// subcommand first. Catch that muscle memory with a pointed hint.
		if strings.HasPrefix(cmd, "-") {
			fmt.Fprintf(os.Stderr, "Flags go after a subcommand — did you mean:  semiont start %s\n", strings.Join(os.Args[1:], " "))
		}
		fmt.Fprintln(os.Stderr)
		usage(os.Stderr)
		code = 1
	}
	os.Exit(code)
}
