//go:build unix

package launcher

import (
	"fmt"
	"strings"
)

// The commands the launcher suggests are the ones this system has.

// holdersHint: what shows who holds a port.
func holdersHint(port int) string {
	return fmt.Sprintf("lsof -ti :%d", port)
}

// stopProcessesHint: what ends processes.
func stopProcessesHint(pids []string) string {
	return "kill " + strings.Join(pids, " ")
}

// setAsideHint: what moves a file out of the way, under the name it gives.
func setAsideHint(path, aside string) string {
	return fmt.Sprintf("mv %q %q", path, aside)
}
