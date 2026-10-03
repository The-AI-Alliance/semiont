//go:build windows

package launcher

import (
	"fmt"
	"strings"
)

// The commands the launcher suggests are the ones this system has.

// holdersHint: what shows who holds a port.
func holdersHint(port int) string {
	return fmt.Sprintf("netstat -ano | findstr :%d", port)
}

// stopProcessesHint: what ends processes.
func stopProcessesHint(pids []string) string {
	return "taskkill /PID " + strings.Join(pids, " /PID ")
}

// setAsideHint: what moves a file out of the way, under the name it gives.
// The quotes are written plainly: %q would double every backslash.
func setAsideHint(path, aside string) string {
	return fmt.Sprintf(`move "%s" "%s"`, path, aside)
}
