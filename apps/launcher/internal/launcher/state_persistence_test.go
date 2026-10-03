package launcher

import (
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// The "state" store is the one host volume at /semiont-state. The Archivist
// writes its projection tree and stamp under it (archivistArgs sets
// XDG_STATE_HOME=/semiont-state), the librarian reads views from it, and the
// supervisors of the containers that mount it (these two and the gateway) keep
// their events logs there so a death record outlives the container. If the
// store stopped mounting a host volume, all of that would
// silently fall back inside the container and die with it.

func TestStateStoreMountsSemiontStateOnHostVolume(t *testing.T) {
	harness.Home(t)
	home := dataDir() // the launcher's data home backs the state store

	args := stateMountArgs("state", "some-root")
	if len(args) == 0 {
		t.Fatal("the \"state\" store must mount a host volume; got none — the projection tree would be container-ephemeral")
	}

	target, hostPath, ok := volumeMount(args, "/semiont-state")
	if !ok {
		t.Fatalf("the \"state\" store must mount to /semiont-state (the Archivist's XDG_STATE_HOME); args=%v", args)
	}
	if target != "/semiont-state" {
		t.Fatalf("mount target = %q, want /semiont-state", target)
	}
	// The host side must be a real path under the data home, not empty — an
	// empty host path is a bind to nothing, i.e. ephemeral.
	if hostPath == "" || !strings.HasPrefix(hostPath, home) {
		t.Fatalf("state host path %q must be a real dir under the data home %q", hostPath, home)
	}
}

// volumeMount finds a "-v host:target" pair whose target matches want,
// returning (target, host, true).
func volumeMount(args []string, want string) (target, host string, ok bool) {
	for i := 0; i+1 < len(args); i++ {
		if args[i] != "-v" && args[i] != "--volume" {
			continue
		}
		// The last colon: a Windows host path has one of its own, after the
		// drive letter.
		at := strings.LastIndex(args[i+1], ":")
		if at < 0 {
			continue
		}
		if host, target := args[i+1][:at], args[i+1][at+1:]; target == want {
			return target, host, true
		}
	}
	return "", "", false
}
