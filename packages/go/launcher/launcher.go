// Package launcher implements the semiont subcommands (the golden tests in the
// module root are the executable spec).
package launcher

// The build stamps a development build carries: -ldflags replaces them at
// release.
const (
	unstampedVersion = "dev"
	unstampedCommit  = "none"
	unstampedDate    = "unknown"
)

// Set via -ldflags at release time.
var (
	BuildVersion = unstampedVersion
	BuildCommit  = unstampedCommit
	BuildDate    = unstampedDate
)
