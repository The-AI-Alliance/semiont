package launcher

import (
	"strconv"
	"strings"
)

// netstatListeners: the PIDs listening on a TCP port, read from Windows'
// `netstat -ano -p TCP`. A listening row is
//
//	TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1234
//
// and its first address column ends in the port, for IPv4 (0.0.0.0:8080) and
// IPv6 ([::]:8080) alike. The state is matched by position, not by its word:
// netstat prints it in the system's language. A listener is the row whose
// remote address has port 0.
func netstatListeners(out string, port int) []string {
	suffix := ":" + strconv.Itoa(port)
	var pids []string
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 5 || f[0] != "TCP" || !strings.HasSuffix(f[1], suffix) || !strings.HasSuffix(f[2], ":0") {
			continue
		}
		if pid := f[4]; !seen[pid] {
			seen[pid] = true
			pids = append(pids, pid)
		}
	}
	return pids
}
