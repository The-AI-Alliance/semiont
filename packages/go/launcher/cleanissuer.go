package launcher

// cleanissuer.go — the shared issuer, for `semiont clean`: run for a realm's
// delete when none is recorded as running, and its PostgreSQL's store removed by
// `semiont clean --shared --store identity-store`.

import (
	"fmt"
	"os"
	"slices"
	"strings"
)

// issuerForClean runs the shared issuer for a clean that deletes a realm and
// finds no server recorded as running, as a start of the issuer group runs
// it: its PostgreSQL kept when it runs as recorded, and its Keycloak run. No
// knowledge base's stack is recorded, and the issuer answers this machine
// alone, whatever the network setting: no knowledge base runs to be reached.
// stop stops what it ran, and so does a run that fails.
func issuerForClean(u *UI) (stop func(), ok bool) {
	doc, ok := readIssuerDocument(u, false)
	if !ok {
		return nil, false
	}
	store, server, err := issuerRoles(&doc)
	if err != nil {
		u.Fail("%v", err)
		return nil, false
	}
	rt, ok := cleanRuntime(u)
	if !ok {
		return nil, false
	}
	var vars []string
	if server.ExternalDBPassword != "" {
		vars = []string{server.ExternalDBPassword}
	}
	userEnv, ok := resolveUserEnv(u, vars, false, workerServing{}, nil)
	if !ok {
		return nil, false
	}
	plan := &launchPlan{Roles: map[string]rolePlan{"identity-store": store, "identity": server}}
	x := &liveExec{u: u, rt: rt, plan: plan}
	fc, ok := withDaemonCredentials(x, flowCtx{plan: plan, userEnv: userEnv})
	if !ok {
		return nil, false
	}
	password, ok := x.identityAdminPassword()
	if !ok {
		return nil, false
	}
	addr, ok := x.resolveAddr()
	if !ok {
		return nil, false
	}
	u.Log("The shared issuer is not running: running it for the delete %s", u.Dim("(this clean stops it again)"))
	var ran []string
	stop = func() {
		ss := LoadStackSet()
		var stopped []string
		for _, name := range slices.Backward(ran) {
			if stopSharedService(u, []string{rt}, name, ss) {
				stopped = append(stopped, name)
			}
		}
		if len(stopped) > 0 {
			u.Ok("Stopped %s, which this clean ran for the delete.", strings.Join(slices.Sorted(slices.Values(stopped)), " and "))
		}
	}
	if store.Presence == presenceLauncher {
		code, restarted := runIssuerStore(x, fc, addr, false)
		if restarted {
			ran = append(ran, sharedContainer("identity-store"))
		}
		if code != 0 {
			if len(ran) > 0 {
				stop()
			}
			return nil, false
		}
	}
	ran = append(ran, sharedContainer("identity"))
	if code := flowIssuerServer(x, fc, addr, password, true); code != 0 {
		stop()
		return nil, false
	}
	return stop, true
}

// cleanShared: `semiont clean --shared --store identity-store` — the shared
// issuer's PostgreSQL store, and every knowledge base's realm in it. Refused
// while a recorded stack signs in at the shared issuer, or while a record says
// the issuer's server runs: the asymmetry a root's clean keeps (Clean). The
// issuer's passwords stay, as a --store clean keeps secrets, so its next
// boot reuses them; each knowledge base's next start creates its realm
// afresh.
func cleanShared(u *UI, store string, dryRun bool) int {
	if store != "identity-store" {
		u.Fail("--shared names the shared issuer's state, and its one store is identity-store.")
		fmt.Fprintln(os.Stderr, "  semiont clean --shared --store identity-store")
		return 1
	}
	spec := stateStores[store]
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
		if st.signsInAtSharedIssuer() {
			u.Fail("A recorded stack signs in at the shared issuer (per %s).", statePath())
			fmt.Fprintln(os.Stderr, "  Stop it first: semiont stop --root "+st.KBRoot)
			return 1
		}
	}
	for _, role := range []string{"identity", "identity-store"} {
		if name := sharedContainer(role); ss.Shared[name] != nil {
			u.Fail("The shared issuer's %s is recorded as running (per %s).", name, statePath())
			fmt.Fprintln(os.Stderr, "  Stop it first: semiont stop --group issuer")
			return 1
		}
	}
	size, exists := diskUse(sd)
	if !exists {
		u.Log("Nothing to remove: no %s state under %s", store, spec.home(""))
		return 0
	}
	if dryRun {
		u.Log("would remove %s — %s (%s: every knowledge base's realm here)", sd, humanBytes(size), store)
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
