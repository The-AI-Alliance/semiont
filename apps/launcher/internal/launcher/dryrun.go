package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// renderCmd prints one runtime invocation the way a shell would take it,
// quoting args that contain whitespace (the sh -c scripts).
func renderCmd(rt string, args ...string) string {
	parts := []string{rt}
	for _, a := range args {
		if strings.ContainsAny(a, " \t") {
			a = `"` + a + `"`
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

// renderStartPlan is the --dry-run output: the exact runtime argv sequence a
// real `semiont start` would execute, with probe-derived values as
// placeholders. This is the legibility replacement for reading the old bash —
// and the extraction seam for the stack-parity gate.
func renderStartPlan(rt, version string, opts startOptions, userEnv []string, plan *launchPlan) {
	const addr = "<host-addr>"
	const stage = "<config-stage>"
	p := func(args ...string) { fmt.Println(renderCmd(rt, args...)) }
	c := func(format string, a ...any) { fmt.Printf("# "+format+"\n", a...) }

	c("semiont start --dry-run — the exact runtime commands a real run would")
	c("execute, in order. Values known only at runtime appear as <placeholders>.")
	switch rt {
	case "container":
		c(`probe: container run --rm busybox:1.38.0 sh -c "ip route | awk '/default/{print $3}'" → <host-addr>`)
	case "docker":
		c("probe: docker run --rm busybox:1.38.0 nslookup host.docker.internal (fallback: default-gateway probe) → <host-addr>")
	case "podman":
		c("probe: podman run --rm busybox:1.38.0 nslookup host.containers.internal (fallback: default-gateway probe) → <host-addr>")
	}
	for _, name := range preflightNames {
		p("stop", name)
		p("rm", name)
	}
	c("remove staged config copies: /tmp/semiont-config.*")
	checks := planPortChecks(plan, opts.observe)
	ports := make([]string, 0, len(checks))
	for _, pc := range checks {
		ports = append(ports, fmt.Sprintf("%d", pc.port))
	}
	c("require free ports: %s", strings.Join(ports, " "))
	c("stage per-service config copies under <config-stage>: backend.toml worker.toml smelter.toml weaver.toml")

	if version == "local" {
		c("SEMIONT_VERSION=local — using locally-built :local images (no pull)")
	} else {
		for _, svc := range semiontServices {
			p(pullArgs(rt, image(svc, version))...)
		}
	}

	var otel []string
	if opts.observe {
		p(tracesArgs()...)
		c("wait: http://localhost:16686 (30s)")
		otel = otelArgs(addr)
	}
	renderRolePlan(rt, "graph", plan, opts, c, p)
	renderRolePlan(rt, "vectors", plan, opts, c, p)
	renderRolePlan(rt, "inference", plan, opts, c, p)
	renderRolePlan(rt, "database", plan, opts, c, p)

	var admin []string
	if opts.adminEmail != "" {
		admin = []string{"--env", "ADMIN_EMAIL=" + opts.adminEmail, "--env", "ADMIN_PASSWORD=<admin-password>"}
	}
	p(backendArgs("<kb-root>", stage, addr, "<worker-secret>", version, plan.BackendPort, userEnv, otel, admin)...)
	c("wait: http://localhost:%d/api/health (120s)", plan.BackendPort)
	c(`probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://<host-addr>:%d/api/health" (up to 20 tries)`, rt, plan.BackendPort)

	for _, sc := range []struct {
		svc, mem string
		port     int
	}{{"worker", "2G", 9090}, {"smelter", "2G", 9091}, {"weaver", "3G", 9092}} {
		p(sidecarArgs(sc.svc, sc.mem, sc.port, stage, addr, "<worker-secret>", version, userEnv, otel)...)
		c("wait: http://localhost:%d/health (30s)", sc.port)
	}
	p(frontendArgs(version)...)
	c("wait: http://localhost:3000 (30s)")
}

// renderRolePlan renders one dependency role's slice of the plan, obligations
// as comments (matching the plan style: conditionals stay legible).
func renderRolePlan(rt, role string, plan *launchPlan, opts startOptions, c func(string, ...any), p func(...string)) {
	rp := plan.Roles[role]
	switch rp.Obligation {
	case obligationAbsent:
		c("%s: not referenced by the config — nothing to launch", role)
	case obligationExternal:
		c("%s: externally provided at %s:%d — verify reachability, launch nothing", role, rp.Address, rp.Port)
	case obligationHostProcess:
		if role != "inference" {
			c("%s: host process at localhost:%d — verify reachability, launch nothing", role, rp.Port)
			return
		}
		c("probe: host Ollama at http://localhost:%d/api/version", rp.Port)
		c(`if present — probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://<host-addr>:%d/api/version" — and use it`, rt, rp.Port)
		c("else:")
		p("stop", "semiont-ollama")
		c("require free port: %d", rp.Port)
		volume := "<ollama-volume>"
		switch opts.ollamaCache {
		case "host":
			if home, err := os.UserHomeDir(); err == nil {
				volume = filepath.Join(home, ".ollama")
			}
		case "volume":
			volume = "semiont-ollama-models"
		}
		p(providedRunArgs("inference", rp, "-m", "24G", "-v", volume+":/root/.ollama")...)
		c("wait: http://localhost:%d/api/version (30s)", rp.Port)
	case obligationProvided:
		p(providedRunArgs(role, rp)...)
		switch role {
		case "graph":
			c("wait: http://localhost:%d (30s)", plan.AuxPorts("graph")[0].port)
		case "vectors":
			c("wait: http://localhost:%d/readyz (15s)", rp.Port)
		case "database":
			c("wait: tcp localhost:%d (20s)", rp.Port)
			c("probe: %s run --rm busybox:1.38.0 nc -z -w 2 <host-addr> %d", rt, rp.Port)
		}
	}
}
