//go:build scenario

package launcher

import (
	"fmt"
	"os"
	"runtime"
)

// stagingParent: the scenario suite's build (-tags scenario) stages under the
// temporary directory its environment names, on every system, and each
// scenario names one of its own. Scenarios then never find each other's
// staged configs, which a stop or a start's sweep would otherwise take for
// their own stack's. Nothing in a scenario mounts, so the Apple `container`
// rule that keeps a released launcher in /tmp (staging.go) does not apply.
//
// The variable is read, not os.TempDir(), which answers /tmp when TMPDIR is
// unset: a scenario run without one would stage among every other scenario's
// configs, and sweep a live stack's on the machine running the suite.
func stagingParent() string {
	name := "TMPDIR"
	if runtime.GOOS == "windows" {
		name = "TMP"
	}
	dir := os.Getenv(name)
	if dir == "" {
		fmt.Fprintf(os.Stderr, "the scenario build stages under $%s, and this environment names none\n", name)
		os.Exit(1)
	}
	return dir
}
