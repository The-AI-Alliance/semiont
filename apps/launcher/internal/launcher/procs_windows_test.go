//go:build windows

package launcher

import (
	"net"
	"os"
	"slices"
	"strconv"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// A port this process listens on is reported with this process as its holder.
func TestListenersOnFindsAListenerThisProcessHolds(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	if pids := listenersOn(port); !slices.Contains(pids, strconv.Itoa(os.Getpid())) {
		t.Errorf("this process (pid %d) listens on %d, and listenersOn reports %v", os.Getpid(), port, pids)
	}
}

// The machine's memory is read as a size, not as unknown, and as gigabytes:
// a machine that runs this has more than half of one and less than a
// terabyte.
func TestHostMemoryIsRead(t *testing.T) {
	if gb := hostMemGB(); gb < 0.5 || gb > 1024 {
		t.Errorf("hostMemGB reports %.2f GB", gb)
	}
}

// The launcher's homes follow LOCALAPPDATA to wherever it points — here, not
// under the home, where ignoring the variable would land.
func TestTheLaunchersHomesFollowLocalAppData(t *testing.T) {
	harness.Home(t)
	elsewhere := t.TempDir()
	t.Setenv("LOCALAPPDATA", elsewhere)
	for what, got := range map[string]string{
		"the state home": StateDir(),
		"the data home":  dataDir(),
	} {
		if want := elsewhere + `\semiont`; got != want {
			t.Errorf("%s = %q, want %q", what, got, want)
		}
	}
	if got, want := logDir(), elsewhere+`\semiont\logs`; got != want {
		t.Errorf("the log dir = %q, want %q", got, want)
	}
}
