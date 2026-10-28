// Package launcher implements the semiont subcommands (the golden tests in the
// module root are the executable spec).
package launcher

// Set via -ldflags at release time.
var (
	BuildVersion = "dev"
	BuildCommit  = "none"
	BuildDate    = "unknown"
)
