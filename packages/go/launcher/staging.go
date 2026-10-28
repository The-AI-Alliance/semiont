//go:build !scenario

package launcher

import (
	"os"
	"runtime"
)

// stagingParent: where a start stages the configs it mounts into containers.
// /tmp on macOS and Linux, never $TMPDIR: Apple `container` cannot mount from
// /var/folders. The system's temporary directory on Windows. The scenario
// suite's build stages elsewhere (staging_scenario.go).
func stagingParent() string {
	if runtime.GOOS == "windows" {
		return os.TempDir()
	}
	return "/tmp"
}
