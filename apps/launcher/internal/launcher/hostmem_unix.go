//go:build unix

package launcher

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// hostMemGB reads the machine's physical memory: sysctl on darwin,
// /proc/meminfo on Linux. 0 = unknown, which silences the preflight rather
// than warning on garbage.
func hostMemGB() float64 {
	if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
		if b, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64); err == nil && b > 0 {
			return b / (1 << 30)
		}
	}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if kb, ok := strings.CutPrefix(line, "MemTotal:"); ok {
				f := strings.Fields(kb)
				if len(f) > 0 {
					if n, err := strconv.ParseFloat(f[0], 64); err == nil {
						return n / (1 << 20)
					}
				}
			}
		}
	}
	return 0
}
