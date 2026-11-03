package launcher

// flowissuer.go — the issuer a knowledge base names as shared: the Keycloak
// the launcher runs for every knowledge base here and the PostgreSQL it keeps
// their realms in, each kept while it runs as this start would run it, and
// the knowledge base's own realm in them.

import (
	"fmt"
	"net"
	"slices"
	"strconv"
	"strings"
)

// flowIssuer: the identity store and the identity role of a full start. A
// knowledge base that names the shared issuer gets the machine's PostgreSQL
// (flowIssuerStore) and Keycloak (flowIssuerServer), restarted together when
// the PostgreSQL is, since Keycloak holds its sessions, and its realm in them
// (flowRealm). One that trusts somebody else's issuer has no identity store,
// and its issuer is verified as any daemon somebody else runs is.
func flowIssuer(x executor, fc flowCtx, addr string) int {
	if fc.stack.KnowledgeBase.Spec.Issuer.Shared == nil {
		if code := flowDepRole(x, "identity-store", fc, addr); code != 0 {
			return code
		}
		return flowDepRole(x, "identity", fc, addr)
	}
	password, ok := x.identityAdminPassword()
	if !ok {
		return 1
	}
	code, restarted := flowIssuerStore(x, fc, addr, false)
	if code != 0 {
		return code
	}
	if code := flowIssuerServer(x, fc, addr, password, restarted); code != 0 {
		return code
	}
	return flowRealm(x, fc, addr, password)
}

// flowIssuerStore: the shared issuer's PostgreSQL, for the knowledge base's
// stack: one the launcher runs (runIssuerStore), served to the stack by it,
// or one somebody else runs, verified as any daemon somebody else runs is.
// restarted says the launcher ran it afresh.
func flowIssuerStore(x executor, fc flowCtx, addr string, restart bool) (code int, restarted bool) {
	rp := fc.plan.Roles["identity-store"]
	if rp.Presence != presenceLauncher {
		return flowDepRole(x, "identity-store", fc, addr), false
	}
	if code, restarted = runIssuerStore(x, fc, addr, restart); code != 0 {
		return code, restarted
	}
	x.servedByShared("identity-store", sharedContainer("identity-store"), healthEndpoint("identity-store", rp.Driver, fc.plan, x.exposure(addr)), rp.Driver)
	return 0, restarted
}

// runIssuerStore: the PostgreSQL the launcher runs for the shared issuer, kept
// when its record says it runs under this start's runtime, is reached where
// this start would probe it, and has the memory and the image the issuer's
// document gives it, unless restart. Otherwise it is stopped wherever its
// record says it runs and run afresh on the machine's store; restarted says
// so. Its record is the machine's, and no knowledge base's stack is touched.
func runIssuerStore(x executor, fc flowCtx, addr string, restart bool) (code int, restarted bool) {
	rp := fc.plan.Roles["identity-store"]
	disp := driverDisplay("identity-store", rp.Driver)
	x.banner(roleBanner(fc, depRoleTitles["identity-store"]+" ("+disp+")"))
	name := sharedContainer("identity-store")
	rec := x.sharedRecord(name)
	e := x.exposure(addr)
	health := healthEndpoint("identity-store", rp.Driver, fc.plan, e)
	x.note("identity-store: keep %s if its record says %s under %s with %s and it runs %s; else stop/rm it, then run it",
		name, health, x.rtName(), rp.Memory, rp.Image)
	code = x.either(func() bool {
		return !restart && rec != nil && rec.Runtime == x.rtName() && rec.Endpoint == health && rec.Memory == rp.Memory &&
			x.containerCurrent(name, rp.Image)
	},
		func() int {
			x.say(sayOK, "identity-store — %s already running %s", disp,
				x.dim("(kept: it keeps every KB's realm here; semiont stop --group issuer stops it)"))
			return 0
		},
		func() int {
			restarted = true
			needs := rolePortNeeds(fc.plan, "identity-store", e)
			if x.stopShared(name, rec) {
				x.settle(portNumbers(needs)...)
			}
			if !x.portChecks(needs) {
				return 1
			}
			extra, ok := x.stateMounts("identity-store", rp.Image, fc.kb)
			if !ok {
				return 1
			}
			creds, err := daemonLaunchEnv(fc, "identity-store", rp)
			if err != nil {
				x.say(sayFail, "%v", err)
				return 1
			}
			rp.Env = append(append([]string{}, rp.Env...), creds...)
			id, ok := x.runDetached(providedRunArgs(e, fc.plan, rp, fc.kb.key(), extra...))
			if !ok {
				x.say(sayFail, "identity-store (%s) failed to start.", disp)
				return 1
			}
			d, ok := x.waitTCP("PostgreSQL", e.probeHost("identity-store", descriptorFor("identity-store", rp.Driver).defaultPort), addr, rp.Port, 20)
			if !ok {
				x.dumpLogs(name, "identity-store")
				return 1
			}
			// The port is the runtime's; sessions are the server's.
			if !x.waitPGAccepting(30) {
				x.dumpLogs(name, "identity-store")
				return 1
			}
			x.say(sayOK, "identity-store — %s on port %d %s", disp, rp.Port, x.dim("("+took(d)+")"))
			x.recordShared(ServiceState{Container: name, ID: id, Image: rp.Image, Endpoint: health, Memory: rp.Memory, Ports: portNumbers(needs)})
			return 0
		})
	return code, restarted
}

// flowIssuerServer: the shared Keycloak. It is kept when its record says it
// runs under this start's runtime, answers where this start would ask it,
// and has the memory, the settings (issuerServerEnv) and the image this start
// would give it, unless restart. Otherwise it is stopped, with the issuer
// proxy that fronts it, and run afresh, its database created on a PostgreSQL
// the launcher runs and its admin opened to this machine. One that would move
// to another hostname or port while another knowledge base here signs in at
// it is refused instead: their gateways name it where it is.
func flowIssuerServer(x executor, fc flowCtx, addr, password string, restart bool) int {
	rp := fc.plan.Roles["identity"]
	disp := driverDisplay("identity", rp.Driver)
	x.banner(roleBanner(fc, depRoleTitles["identity"]+" ("+disp+")"))
	name := sharedContainer("identity")
	rec := x.sharedRecord(name)
	e := x.exposure(addr)
	health := keycloakBase(e, rp.Port) + keycloakHealthPath
	env := issuerServerEnv(fc, e, addr)
	x.note("identity: keep %s if PostgreSQL was kept and its record says %s under %s with %s, %s, and it runs %s; else stop/rm it, then run it",
		name, health, x.rtName(), rp.Memory, strings.Join(env, " "), rp.Image)
	return x.either(func() bool {
		return !restart && rec != nil && rec.Runtime == x.rtName() && rec.Endpoint == health && rec.Memory == rp.Memory &&
			slices.Equal(rec.Env, env) && x.containerCurrent(name, rp.Image)
	},
		func() int {
			x.say(sayOK, "identity — %s already running %s", disp,
				x.dim("(kept: it serves every KB here; semiont stop --group issuer stops it)"))
			return 0
		},
		func() int {
			if others := x.sharedIssuerRealms(); rec != nil && len(others) > 0 && envValue(rec.Env, "KC_HOSTNAME") != envValue(env, "KC_HOSTNAME") {
				x.say(sayFail, "The shared issuer is at %s for %s, and this start would move it to %s.",
					envValue(rec.Env, "KC_HOSTNAME"), strings.Join(others, ", "), envValue(env, "KC_HOSTNAME"))
				x.say(sayLog, "Their gateways name it where it is. Stop them first, then start each again after this one.")
				return 1
			}
			needs := rolePortNeeds(fc.plan, "identity", e)
			x.retireIssuerProxy()
			if x.stopShared(name, rec) {
				x.settle(portNumbers(needs)...)
			}
			if !x.portChecks(needs) {
				return 1
			}
			// Authority, not presence: an external PostgreSQL is somebody's
			// shared server, and creating a database in it is a privileged
			// persistent change the launcher is not entitled to make.
			db := fc.plan.Roles["identity-store"]
			if mayConfigure(db) {
				if !x.createDatabase(envValue(rp.Env, "KC_DB_USERNAME"), db.Database) {
					return 1
				}
			} else {
				x.say(sayLog, "identity — PostgreSQL at %s is not launcher-run; the %q database must already exist there", db.Address, db.Database)
				x.note("identity: external PostgreSQL at %s — the %q database must already exist there", db.Address, db.Database)
			}
			var extra []string
			for _, v := range env {
				extra = append(extra, "-e", v)
			}
			extra = append(extra, "--env", "KC_BOOTSTRAP_ADMIN_PASSWORD="+password)
			creds, err := daemonLaunchEnv(fc, "identity", rp)
			if err != nil {
				x.say(sayFail, "%v", err)
				return 1
			}
			rp.Env = append(append([]string{}, rp.Env...), creds...)
			id, ok := x.runDetached(providedRunArgs(e, fc.plan, rp, fc.kb.key(), extra...))
			if !ok {
				x.say(sayFail, "identity (%s) failed to start.", disp)
				return 1
			}
			// Keycloak itself, which under `network lan` is behind the proxy:
			// its master realm answers once the server is up.
			d, ok := x.waitHTTP("identity ("+disp+")", name, health, 90)
			if !ok {
				x.dumpLogs(name, "identity")
				return 1
			}
			// Before any realm: where the runtime delivers this machine's
			// connections from an address Keycloak does not count as private,
			// creating one needs the admin opened first.
			x.openAdminToThisMachine(password)
			x.say(sayOK, "identity — %s at %s %s", disp, keycloakBase(e, rp.Port), x.dim("("+took(d)+")"))
			x.recordShared(ServiceState{Container: name, ID: id, Image: rp.Image, Endpoint: health, Memory: rp.Memory, Env: env, Ports: portNumbers(needs)})
			return 0
		})
}

// issuerServerEnv: what the shared Keycloak is run with that this start
// decides and its record keeps — the database it keeps its realms in, and the
// hostname it names its endpoints under — as the assignments it is run with.
// Neither is a secret.
func issuerServerEnv(fc flowCtx, e exposure, addr string) []string {
	db := fc.plan.Roles["identity-store"]
	dbHost := db.Address
	if mayConfigure(db) {
		dbHost = addr
	}
	return []string{
		fmt.Sprintf("KC_DB_URL=jdbc:postgresql://%s:%d/%s", dbHost, db.Port, db.Database),
		"KC_HOSTNAME=" + placementOf(fc, e).keycloakHostname(),
	}
}

// flowRealm: the knowledge base's realm in the shared Keycloak, on every start
// whether the server was kept or not — created from the launcher's document
// unless Keycloak holds it, passed to the network under `network lan` by the
// issuer proxy with the realm of every other recorded stack it serves, and
// proved to honour this start's credentials before anything holds one.
func flowRealm(x executor, fc flowCtx, addr, password string) int {
	rp := fc.plan.Roles["identity"]
	e := x.exposure(addr)
	// Resolved here and kept (per root, and the worker's key shared), so the
	// container that must PRESENT each credential reads the same value out of
	// the same file rather than having it threaded through the start flow.
	accounts, ok := realmAccountsOf(x, fc.kb)
	if !ok {
		return 1
	}
	realm := keycloakRealm(issuerPath(rp.Issuer))
	if !x.createRealm(keycloakBase(e, rp.Port), realm, password, keycloakRealmJSON(realm, fc.kb.ident.resource(), fc.browser.spec.Port, rp.AccessTokenLifespan, accounts)) {
		return 1
	}
	health := healthEndpoint("identity", rp.Driver, fc.plan, e)
	if e.behindProxy("identity") {
		host, port := e.keycloakAt(rp.Port)
		listen := net.JoinHostPort(e.lan, strconv.Itoa(rp.Port))
		realms := slices.Sorted(slices.Values(append(x.sharedIssuerRealms(), realm)))
		if !x.issuerProxy(listen, net.JoinHostPort(host, strconv.Itoa(port)), realms) {
			return 1
		}
		// The issuer where everyone dials it, through the proxy.
		if _, ok := x.waitHTTP("identity (the issuer proxy)", sharedContainer("identity"), health, 15); !ok {
			return 1
		}
	}
	x.say(sayOK, "identity — realm %s at %s", realm, identityEndpoint(rp, e))
	// The realm is held; prove it honours the credentials this start is about
	// to inject, BEFORE the first process that holds one, at the issuer those
	// processes sign in at — see verifyServiceAccounts on why not where the
	// launcher reaches it.
	if !x.preflightIdentity(placementOf(fc, e).issuer(), fc.kb.ident.resource(), accounts, rp.AccessTokenLifespan, fc.browser.spec.Port, true) {
		return 1
	}
	x.servedByShared("identity", sharedContainer("identity"), health, rp.Driver)
	return 0
}
