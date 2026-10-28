package launcher

import (
	"reflect"
	"testing"
)

// What `netstat -ano -p TCP` prints on Windows, with the rows the parser must
// tell apart: listeners on IPv4 and IPv6, a connection through the same local
// port, and a port that only ends in the same digits.
const netstatSample = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1136
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       4321
  TCP    0.0.0.0:18080          0.0.0.0:0              LISTENING       999
  TCP    127.0.0.1:8080         127.0.0.1:52811        ESTABLISHED     4321
  TCP    127.0.0.1:52811        127.0.0.1:8080         ESTABLISHED     7777
  TCP    [::]:8080              [::]:0                 LISTENING       4321
  TCP    [::1]:8080             [::]:0                 LISTENING       5555
`

func TestNetstatListenersNamesWhoListensOnAPort(t *testing.T) {
	for _, c := range []struct {
		port int
		want []string
	}{
		{8080, []string{"4321", "5555"}}, // both families, one PID once; never the connected client
		{18080, []string{"999"}},
		{135, []string{"1136"}},
		{80, nil}, // 8080 and 18080 end in "80" and are not port 80
		{52811, nil},
	} {
		if got := netstatListeners(netstatSample, c.port); !reflect.DeepEqual(got, c.want) {
			t.Errorf("port %d: listeners %v, want %v", c.port, got, c.want)
		}
	}
	// The state column is in the system's language; the row is still read.
	german := "  TCP    0.0.0.0:8080           0.0.0.0:0              ABHÖREN         4321\r\n"
	if got := netstatListeners(german, 8080); !reflect.DeepEqual(got, []string{"4321"}) {
		t.Errorf("a row whose state is not in English gave %v", got)
	}
}
