package launcher

import (
	"strings"
	"testing"
)

// JOB-RESTART-SAFETY P1 — the mount census.
//
// The gateway's job queue (`FsJobQueue`, `jobsDir`) lives under
// XDG_STATE_HOME, and a job must survive a gateway restart — the failure this
// plan exists to prevent (a container-local `jobsDir` dies with the container,
// so the janitor has nothing to recover). That guarantee is two facts in this
// one builder, and start.go's own comment notes nothing guards the pair:
//
//  1. the gateway container writes state to /semiont-state
//     (`gatewayArgs` sets XDG_STATE_HOME=/semiont-state), and
//  2. the "state" store mounts a HOST volume to /semiont-state
//     (`stateStores["state"]`).
//
// Break either and jobsDir silently falls back inside the container. These
// pin both, so a launcher/state refactor cannot make jobs ephemeral again
// without a red test.

func TestGatewayWritesStateToSemiontState(t *testing.T) {
	args := gatewayArgs("stage", "addr", "secret", "jwt", "v1", 4000, nil, nil)
	if !hasEnv(args, "XDG_STATE_HOME=/semiont-state") {
		t.Fatalf("gateway must set XDG_STATE_HOME=/semiont-state (jobsDir lives under it); args=%v", args)
	}
}

func TestStateStoreMountsSemiontStateOnHostVolume(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_DATA_HOME", home) // the launcher's data home backs the state store

	args := stateMountArgs("state", "some-root")
	if len(args) == 0 {
		t.Fatal("the \"state\" store must mount a host volume; got none — jobsDir would be container-ephemeral")
	}

	target, hostPath, ok := volumeMount(args, "/semiont-state")
	if !ok {
		t.Fatalf("the \"state\" store must mount to /semiont-state (the gateway's XDG_STATE_HOME); args=%v", args)
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

// hasEnv reports whether args contains a "--env" immediately followed by want.
func hasEnv(args []string, want string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--env" && args[i+1] == want {
			return true
		}
	}
	return false
}

// volumeMount finds a "-v host:target" pair whose target matches want,
// returning (target, host, true).
func volumeMount(args []string, want string) (target, host string, ok bool) {
	for i := 0; i+1 < len(args); i++ {
		if args[i] != "-v" && args[i] != "--volume" {
			continue
		}
		host, target, found := strings.Cut(args[i+1], ":")
		if found && target == want {
			return target, host, true
		}
	}
	return "", "", false
}
