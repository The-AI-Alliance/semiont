package launcher

// cleanshared.go — `semiont clean --shared`: a store the machine keeps for
// every knowledge base here, removed with all they keep in it.

import (
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
)

// sharedStore: a store the machine keeps — what it keeps of every knowledge
// base, whether a recorded stack uses it and how that is said, and the roles
// whose machine containers mount it, with the stop that stops them.
type sharedStore struct {
	keeps     string
	uses      func(*StackState) bool
	users     string
	mountedBy []string
	stop      string
}

// sharedStores: the stores the machine keeps, by name.
var sharedStores = map[string]sharedStore{
	"identity-store": {
		keeps:     "every knowledge base's realm here",
		uses:      func(st *StackState) bool { return st.signsInAtSharedIssuer() },
		users:     "signs in at the shared issuer",
		mountedBy: []string{"identity", "identity-store"},
		stop:      "semiont stop --group issuer",
	},
	"vectors": {
		keeps:     "the index of every knowledge base naming the shared Qdrant",
		uses:      func(st *StackState) bool { return machineServes(st, "vectors") },
		users:     "keeps its index in the shared Qdrant",
		mountedBy: []string{"vectors"},
		stop:      "semiont stop --service vectors",
	},
}

// cleanShared: `semiont clean --shared --store <store>` — a store the
// machine keeps (sharedStores), and what every knowledge base keeps in it.
// Refused while a recorded stack uses the store, or while a record says a
// container that mounts it runs: the asymmetry a root's clean keeps (Clean).
// The issuer's passwords stay, as a --store clean keeps secrets, so its next
// boot reuses them; each knowledge base's next start creates its realm, or
// its index, afresh.
func cleanShared(u *UI, store string, dryRun bool) int {
	shared, ok := sharedStores[store]
	if !ok {
		u.Fail("--shared names a store the machine keeps: %s.", strings.Join(slices.Sorted(maps.Keys(sharedStores)), " or "))
		for _, name := range slices.Sorted(maps.Keys(sharedStores)) {
			fmt.Fprintln(os.Stderr, "  semiont clean --shared --store "+name)
		}
		return 1
	}
	spec := machineStore(store)
	sd := spec.storeDir("")
	if sd == "" {
		u.Fail("No home directory resolvable; nowhere for state to live.")
		return 1
	}
	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return 1
	}
	for _, st := range localStacks(ss) {
		if shared.uses(st) {
			u.Fail("A recorded stack %s (per %s).", shared.users, statePath())
			fmt.Fprintln(os.Stderr, "  Stop it first: semiont stop --root "+st.KBRoot)
			return 1
		}
	}
	for _, role := range shared.mountedBy {
		if name := sharedContainer(role); ss.Shared[name] != nil {
			u.Fail("%s is recorded as running (per %s).", name, statePath())
			fmt.Fprintln(os.Stderr, "  Stop it first: "+shared.stop)
			return 1
		}
	}
	size, exists := diskUse(sd)
	if !exists {
		u.Log("Nothing to remove: no %s state under %s", store, spec.home(""))
		return 0
	}
	if dryRun {
		u.Log("would remove %s — %s (%s: %s)", sd, humanBytes(size), store, shared.keeps)
		u.Log("Total: %s %s", humanBytes(size), u.Dim("(dry-run; nothing removed)"))
		return 0
	}
	// The store's contents were written by its container, so a container
	// empties them, as a root's clean empties its stores.
	rt, ok := cleanRuntime(u)
	if !ok {
		return 1
	}
	if err := clearStoreContents(rt, sd); err != nil {
		u.Fail("cannot empty %s: %v", sd, err)
		return 1
	}
	if err := os.RemoveAll(sd); err != nil {
		u.Fail("cannot remove %s: %v", sd, err)
		return 1
	}
	u.Ok("Removed %s — %s freed.", sd, humanBytes(size))
	// Its stamp goes too, so the next start sees first use.
	meta := loadRootMeta(spec.home(""))
	delete(meta.Stores, store)
	saveRootMeta(spec.home(""), meta)
	return 0
}
