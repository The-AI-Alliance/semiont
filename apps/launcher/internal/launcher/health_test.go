package launcher

import "testing"

// The health endpoint had three homes that disagreed: `statusServices` (17
// literals with hardcoded ports), `serviceEndpoint` (15 cases, missing the
// archivist, librarian and dispatcher entirely), and literals inside the
// sidecar flows. Status probed NATS on 4222 whatever the config said.
//
// The literals below are what each of those homes said, frozen. They are the
// evidence that one derivation reproduces all three — not a fourth home.

// What `statusServices` said, for a report with no record to read a driver
// from. This is the static half: no plan, so no config-owned port.
func TestHealthEndpointReproducesTheStatusRoster(t *testing.T) {
	for _, c := range []struct{ role, want string }{
		{"worker", "http://localhost:24100/health"},
		{"gateway", "http://localhost:4000/api/health"},
		{"archivist", "http://localhost:24103/health"},
		{"librarian", "http://localhost:24104/health"},
		{"dispatcher", "http://localhost:24105/health"},
		{"weaver", "http://localhost:24102/health"},
		{"smelter", "http://localhost:24101/health"},
		{"database", "tcp:localhost:5432"},
		{"messaging", "tcp:localhost:4222"},
		{"identity", "http://localhost:8080/realms/master"},
		{"graph", "http://localhost:7474"},
		{"vectors", "http://localhost:6333/readyz"},
		{"collector", "http://localhost:24110/metrics"},
		{"inference", "http://localhost:11434/api/version"},
		{"embedding", "http://localhost:11434/api/version"},
		{"traces", "http://localhost:16686"},
		{"metrics", "http://localhost:9090/-/healthy"},
	} {
		if got := healthEndpoint(c.role, probeDriver(c.role), nil); got != c.want {
			t.Errorf("%s: %q, want %q", c.role, got, c.want)
		}
	}
}

// What `serviceEndpoint` said, for a stack whose config is known. The ports
// here are the defaults, so the two homes agreed — until a config moved one.
func TestHealthEndpointReproducesTheStartGates(t *testing.T) {
	plan := &launchPlan{
		GatewayPort: 4000,
		Roles: map[string]rolePlan{
			"database":  {Role: "database", Driver: "postgres", Port: 5432},
			"messaging": {Role: "messaging", Driver: "jetstream", Port: 4222},
			"graph":     {Role: "graph", Driver: "neo4j", Port: 7687},
			"vectors":   {Role: "vectors", Driver: "qdrant", Port: 6333},
			"inference": {Role: "inference", Driver: "ollama", Port: 11434},
			"identity":  {Role: "identity", Driver: "keycloak", Port: 8080, Issuer: "http://localhost:8080/realms/semiont"},
		},
	}
	for _, c := range []struct{ role, driver, want string }{
		{"traces", "jaeger", "http://localhost:16686"},
		{"collector", "otel", "http://localhost:24110/metrics"},
		{"messaging", "jetstream", "tcp:localhost:4222"},
		{"metrics", "prometheus", "http://localhost:9090/-/healthy"},
		{"browser", driverSemiont, "http://localhost:3000"},
		{"gateway", driverSemiont, "http://localhost:4000/api/health"},
		{"worker", driverSemiont, "http://localhost:24100/health"},
		{"smelter", driverSemiont, "http://localhost:24101/health"},
		{"weaver", driverSemiont, "http://localhost:24102/health"},
		{"graph", "neo4j", "http://localhost:7474"},
		{"vectors", "qdrant", "http://localhost:6333/readyz"},
		{"inference", "ollama", "http://localhost:11434/api/version"},
		{"database", "postgres", "tcp:localhost:5432"},
		// The three `serviceEndpoint` never had a case for: it returned ""
		// for them, and each flow carried its own literal instead.
		{"archivist", driverSemiont, "http://localhost:24103/health"},
		{"librarian", driverSemiont, "http://localhost:24104/health"},
		{"dispatcher", driverSemiont, "http://localhost:24105/health"},
		// The configured realm, not master: the import is what makes it
		// answer, so that is what a start waits for.
		{"identity", "keycloak", "http://localhost:8080/realms/semiont"},
	} {
		if got := healthEndpoint(c.role, c.driver, plan); got != c.want {
			t.Errorf("%s/%s: %q, want %q", c.role, c.driver, got, c.want)
		}
	}
}

// The defect the collapse fixes, and the reason it is worth doing: a config
// that moves a port must be probed at the port it moved to. Every one of
// these was hardcoded in `statusServices`.
func TestHealthEndpointFollowsAConfigThatMovesAPort(t *testing.T) {
	plan := &launchPlan{
		GatewayPort: 4400,
		Roles: map[string]rolePlan{
			"database":  {Role: "database", Driver: "postgres", Port: 5433},
			"messaging": {Role: "messaging", Driver: "nats", Port: 4333},
			"vectors":   {Role: "vectors", Driver: "qdrant", Port: 6444},
			"inference": {Role: "inference", Driver: "ollama", Port: 11555},
		},
	}
	for _, c := range []struct{ role, driver, want string }{
		{"database", "postgres", "tcp:localhost:5433"},
		{"messaging", "nats", "tcp:localhost:4333"},
		{"vectors", "qdrant", "http://localhost:6444/readyz"},
		{"inference", "ollama", "http://localhost:11555/api/version"},
		{"gateway", driverSemiont, "http://localhost:4400/api/health"},
	} {
		if got := healthEndpoint(c.role, c.driver, plan); got != c.want {
			t.Errorf("%s moved its port: %q, want %q — this is what three hardcoded copies could not do", c.role, got, c.want)
		}
	}
}

// Every role must have a probe. A role with none is a row in the status
// report that can never say anything.
func TestEveryRoleHasAHealthEndpoint(t *testing.T) {
	for _, role := range roleOrder {
		if got := healthEndpoint(role, probeDriver(role), nil); got == "" {
			t.Errorf("role %q has no health endpoint — status could report nothing about it", role)
		}
	}
}
