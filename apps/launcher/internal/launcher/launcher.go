// Package launcher implements the semiont subcommands: the host-installed
// replacement for the fleet-synced start.sh / logs.sh / stop.sh
// (GO-LAUNCHER.md in the monorepo's .plans/ is the design record; the golden
// tests in the module root are the executable spec).
package launcher

// Set via -ldflags at release time.
var (
	BuildVersion = "dev"
	BuildCommit  = "none"
	BuildDate    = "unknown"
)
