package launcher

// flowvectors.go — the vector store a knowledge base names: the Qdrant the
// launcher runs for every knowledge base here that names it shared, kept
// while it runs as this start would run it, or the knowledge base's own or
// somebody else's, as any of its daemons is.

import "strings"

// flowVectors: the vector store of a start. One a knowledge base names shared
// is the machine's (flowSharedVectors), restarted when the start names it
// (restart); its own, or somebody else's, is a dependency role's.
func flowVectors(x executor, fc flowCtx, addr string, restart bool) int {
	if fc.plan.Roles["vectors"].Presence != presenceShared {
		return flowDepRole(x, "vectors", fc, addr)
	}
	return flowSharedVectors(x, fc, addr, restart)
}

// flowSharedVectors: the machine's Qdrant (runSharedVectors), and the
// knowledge base's stack recording that the machine's serves it.
func flowSharedVectors(x executor, fc flowCtx, addr string, restart bool) int {
	health, code := runSharedVectors(x, fc, addr, restart)
	if code != 0 {
		return code
	}
	rp := fc.plan.Roles["vectors"]
	x.servedByShared("vectors", rp.container(fc.kb.key()), health, rp.Driver)
	return 0
}

// runSharedVectors: the machine's Qdrant, each knowledge base's index in
// collections of its own. It is kept when its record says it runs under this
// start's runtime, is reached where this start would probe it, and has the
// memory and the image the vector store's document gives it, unless restart.
// Otherwise it is stopped wherever its record says it runs and run afresh on
// the machine's store, with the machine's key (withDaemonCredentials). Its
// record is the machine's. health is where it is probed.
//
// One kept must answer the machine's key, which this start signs the
// services' tokens with. One that does not runs under a key the machine no
// longer keeps: it is run afresh under the machine's, unless another
// knowledge base's stack keeps its index there, whose services hold tokens
// signed with the key it runs under. Then the start is refused, naming them.
func runSharedVectors(x executor, fc flowCtx, addr string, restart bool) (health string, code int) {
	rp := fc.plan.Roles["vectors"]
	disp := driverDisplay("vectors", rp.Driver)
	x.banner(roleBanner(fc, depRoleTitles["vectors"]+" ("+disp+")"))
	name := rp.container(fc.kb.key())
	rec := x.sharedRecord(name)
	e := x.exposure(addr)
	health = healthEndpoint("vectors", rp.Driver, fc.plan, e)
	x.note("vectors: keep %s if its record says %s under %s with %s, it runs %s and it answers the machine's API key; else stop/rm it, then run it",
		name, health, x.rtName(), rp.Memory, rp.Image)
	run := func() int {
		needs := rolePortNeeds(fc.plan, "vectors", e)
		if x.stopShared(name, rec) {
			x.settle(portNumbers(needs)...)
		}
		if !x.portChecks(needs) {
			return 1
		}
		extra, ok := x.stateMounts("vectors", storeAt("vectors", fc.plan), rp.Image, fc.kb)
		if !ok {
			return 1
		}
		creds, err := daemonLaunchEnv(fc, "vectors", rp)
		if err != nil {
			x.say(sayFail, "%v", err)
			return 1
		}
		rp.Env = append(append([]string{}, rp.Env...), creds...)
		id, ok := x.runDetached(providedRunArgs(e, fc.plan, rp, fc.kb.key(), extra...))
		if !ok {
			x.say(sayFail, "vectors (%s) failed to start.", disp)
			return 1
		}
		d, ok := x.waitHTTP("vectors ("+disp+")", name, health, 15)
		if !ok {
			x.dumpLogs(name, "vectors")
			return 1
		}
		x.say(sayOK, "vectors — %s on port %d %s", disp, rp.Port, x.dim("("+took(d)+")"))
		x.recordShared(ServiceState{Container: name, ID: id, Image: rp.Image, Endpoint: health, Memory: rp.Memory, Ports: portNumbers(needs)})
		return 0
	}
	return health, x.either(func() bool {
		return !restart && rec != nil && rec.Runtime == x.rtName() && rec.Endpoint == health && rec.Memory == rp.Memory &&
			x.containerCurrent(name, rp.Image)
	},
		func() int {
			// The machine's key is kept by now, generated when none was.
			base := qdrantBase(health)
			err := x.qdrantTakes(base, userEnvVars(fc.userEnv)[daemonCredentials["vectors"].env])
			if err == nil {
				x.say(sayOK, "vectors — %s already running %s", disp,
					x.dim("(kept: it keeps every KB's index here; semiont stop --service vectors stops it)"))
				return 0
			}
			if others := x.sharedVectorsRoots(); len(others) > 0 {
				x.say(sayFail, "The shared Qdrant at %s did not answer the machine's API key, which this start signs its services' tokens with, and it keeps the index of %s: %v",
					base, strings.Join(others, ", "), err)
				x.say(sayLog, "Their services hold tokens signed with the key it runs under. Stop them first (semiont stop --root <its path>), then start each again after this one.")
				return 1
			}
			x.say(sayWarn, "The shared Qdrant at %s did not answer the machine's API key (%v); it keeps no other knowledge base's index, so it runs afresh under the machine's.", base, err)
			return run()
		},
		run)
}
