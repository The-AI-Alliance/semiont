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
func renderStartPlan(rt, version string, opts startOptions, userEnv []string) {
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
	ports := make([]string, 0, len(portChecks))
	for _, pc := range portChecks {
		if pc.observe && !opts.observe {
			continue
		}
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
		p(jaegerArgs()...)
		c("wait: http://localhost:16686 (30s)")
		otel = otelArgs(addr)
	}
	p(neo4jArgs()...)
	c("wait: http://localhost:7474 (30s)")
	p(qdrantArgs()...)
	c("wait: http://localhost:6333/readyz (15s)")

	c("probe: host Ollama at http://localhost:11434/api/version")
	c(`if present — probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://<host-addr>:11434/api/version" — and use it`, rt)
	c("else:")
	p("stop", "semiont-ollama")
	c("require free port: 11434")
	volume := "<ollama-volume>"
	switch opts.ollamaCache {
	case "host":
		if home, err := os.UserHomeDir(); err == nil {
			volume = filepath.Join(home, ".ollama")
		}
	case "volume":
		volume = "semiont-ollama-models"
	}
	p(ollamaArgs(volume)...)
	c("wait: http://localhost:11434/api/version (30s)")

	p(postgresArgs()...)
	c("wait: tcp localhost:5432 (20s)")
	c("probe: %s run --rm busybox:1.38.0 nc -z -w 2 <host-addr> 5432", rt)

	var admin []string
	if opts.adminEmail != "" {
		admin = []string{"--env", "ADMIN_EMAIL=" + opts.adminEmail, "--env", "ADMIN_PASSWORD=<admin-password>"}
	}
	p(backendArgs("<kb-root>", stage, addr, "<worker-secret>", version, userEnv, otel, admin)...)
	c("wait: http://localhost:4000/api/health (120s)")
	c(`probe: %s run --rm busybox:1.38.0 sh -c "wget -q -O- http://<host-addr>:4000/api/health" (up to 20 tries)`, rt)

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
