package launcher

// cleanissuer.go — the shared issuer, for `semiont clean`: run for a realm's
// delete when none is recorded as running.

import (
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
