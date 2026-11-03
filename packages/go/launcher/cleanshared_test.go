package launcher

import (
	"slices"
	"testing"
)

// sharedStores restates which stores the machine can keep: the ones
// stateStores marks machine, and the ones a machine container serves. This
// gate fails when either grows a store `clean --shared` cannot remove, or
// when a shared store's mounts are no machine container's.
func TestSharedStoresAreTheStoresTheMachineKeeps(t *testing.T) {
	for name, spec := range stateStores {
		machineKept := spec.machine || contains(machineServedRoles, spec.owner)
		shared, listed := sharedStores[name]
		switch {
		case machineKept && !listed:
			t.Errorf("the machine can keep %q, but sharedStores does not list it for clean --shared", name)
		case !machineKept && listed:
			t.Errorf("sharedStores lists %q, which only a knowledge base's root keeps", name)
		case listed && !slices.Contains(shared.mountedBy, spec.owner):
			t.Errorf("sharedStores' %q is mounted by %v, which leaves out its owner %q", name, shared.mountedBy, spec.owner)
		}
		for _, role := range shared.mountedBy {
			if !contains(machineRoles, role) {
				t.Errorf("sharedStores' %q names %q, which no machine container serves", name, role)
			}
		}
	}
	for name := range sharedStores {
		if _, ok := stateStores[name]; !ok {
			t.Errorf("sharedStores lists %q, which stateStores does not", name)
		}
	}
}
