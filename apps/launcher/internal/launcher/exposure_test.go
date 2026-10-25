package launcher

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The bridge address the tests place Apple container's stack at.
const bridge = "192.168.64.1"

var appleContainer = exposure{rt: "container", addr: bridge}

// Every publish the launcher writes goes through exposure: a run builder that
// spells a publish itself would publish on every interface again, under Apple
// container as anywhere. `ps -p` and `netstat -p` are not publishes.
func TestEveryPublishGoesThroughExposure(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no source read (%v): a census of nothing passes", err)
	}
	read := 0
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		read++
		for n, line := range strings.Split(string(b), "\n") {
			if !strings.Contains(line, `"-p"`) && !strings.Contains(line, `"--publish"`) {
				continue
			}
			if strings.Contains(line, ".publish(") || strings.Contains(line, `"ps"`) || strings.Contains(line, `"netstat"`) {
				continue
			}
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			t.Errorf("%s:%d publishes without exposure: %s", file, n+1, strings.TrimSpace(line))
		}
	}
	if read < 10 {
		t.Fatalf("read %d source files: the census is not reading the package", read)
	}
}

// Every connection the launcher opens goes through dialHost (httpclient.go):
// a dial of its own would reach the bridge address in production and miss
// the scenario build's redirect, so the suites could not see where it goes.
func TestEveryDialGoesThroughDialHost(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no source read (%v): a census of nothing passes", err)
	}
	read := 0
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") || file == "httpclient.go" {
			continue
		}
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		read++
		for n, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			if strings.Contains(line, "net.Dial") || strings.Contains(line, ".DialContext(") {
				t.Errorf("%s:%d dials without dialHost: %s", file, n+1, strings.TrimSpace(line))
			}
		}
	}
	if read < 10 {
		t.Fatalf("read %d source files: the census is not reading the package", read)
	}
}

// LOCAL-ONLY-STACK's table, as D1-A and D2 ruled it for Apple container: what
// a person dials on loopback, what containers dial on the bridge address, and
// both, the containers' side above the person's.
func TestAppleContainerPublishesEachPortWhereItsDialersAre(t *testing.T) {
	for _, c := range []struct {
		role            string
		hostPort, cport int
		want            []string
	}{
		{"browser", 3000, 3000, []string{"127.0.0.1:3000:3000"}},
		{"gateway", 4000, 4000, []string{"127.0.0.1:4000:4000", bridge + ":14000:4000"}},
		{"identity", 8080, 8080, []string{bridge + ":8080:8080"}},
		{"identity", 8081, 8080, []string{bridge + ":8081:8080"}},
		{"database", 5432, 5432, []string{bridge + ":5432:5432"}},
		{"messaging", 4222, 4222, []string{bridge + ":4222:4222"}},
		{"graph", 7474, 7474, []string{"127.0.0.1:7474:7474"}},
		{"graph", 7687, 7687, []string{"127.0.0.1:7687:7687", bridge + ":17687:7687"}},
		{"vectors", 6333, 6333, []string{bridge + ":6333:6333"}},
		{"inference", 11434, 11434, []string{bridge + ":11434:11434"}},
		{"collector", 4318, 4318, []string{bridge + ":4318:4318"}},
		{"collector", 24110, 24110, []string{bridge + ":24110:24110"}},
		{"metrics", 9090, 9090, []string{"127.0.0.1:9090:9090"}},
		{"traces", 16686, 16686, []string{"127.0.0.1:16686:16686"}},
		{"traces", 14318, 4318, []string{bridge + ":14318:4318"}},
		{"archivist", 24103, 24103, []string{bridge + ":24103:24103"}},
		{"worker", 24100, 24100, []string{bridge + ":24100:24100"}},
		{"librarian", 24104, 24104, []string{bridge + ":24104:24104"}},
	} {
		if got := appleContainer.publishSpecs(c.role, c.hostPort, c.cport); !slices.Equal(got, c.want) {
			t.Errorf("%s %d publishes %v, want %v", c.role, c.hostPort, got, c.want)
		}
	}
}

// The network address a `network lan` start places the issuer at.
const lanAddr = "192.168.2.10"

var appleContainerLAN = exposure{rt: "container", addr: bridge, lan: lanAddr}

// D3 as ruled: `network lan` adds the network to the gateway, on every
// interface, and to the issuer, which the filtering proxy serves while
// Keycloak itself is published on the bridge address at the containers' side.
// Nothing else changes.
func TestNetworkLANPublishesTheGatewayAndTheIssuerAlone(t *testing.T) {
	for _, c := range []struct {
		role            string
		hostPort, cport int
		want            []string
	}{
		{"gateway", 4000, 4000, []string{"4000:4000", bridge + ":14000:4000"}},
		{"identity", 8080, 8080, []string{bridge + ":18080:8080"}},
		{"identity", 8081, 8080, []string{bridge + ":18081:8080"}},
		{"browser", 3000, 3000, []string{"127.0.0.1:3000:3000"}},
		{"database", 5432, 5432, []string{bridge + ":5432:5432"}},
		{"graph", 7474, 7474, []string{"127.0.0.1:7474:7474"}},
		{"graph", 7687, 7687, []string{"127.0.0.1:7687:7687", bridge + ":17687:7687"}},
		{"metrics", 9090, 9090, []string{"127.0.0.1:9090:9090"}},
		{"archivist", 24103, 24103, []string{bridge + ":24103:24103"}},
	} {
		if got := appleContainerLAN.publishSpecs(c.role, c.hostPort, c.cport); !slices.Equal(got, c.want) {
			t.Errorf("under lan, %s %d publishes %v, want %v", c.role, c.hostPort, got, c.want)
		}
	}
}

// Under `network lan` everyone reaches the issuer at the network address,
// through the proxy, and the launcher reaches Keycloak itself behind it; a
// start claims Keycloak's port there free.
func TestNetworkLANPlacesTheIssuerAtTheNetworkAddress(t *testing.T) {
	if got := appleContainerLAN.probeHost("identity", 8080); got != lanAddr {
		t.Errorf("under lan the issuer is asked at %s, want the network address %s", got, lanAddr)
	}
	if host, port := appleContainerLAN.keycloakAt(8080); host != bridge || port != 18080 {
		t.Errorf("under lan the launcher reaches Keycloak at %s:%d, want %s:18080, behind the proxy", host, port, bridge)
	}
	if host, port := appleContainer.keycloakAt(8080); host != bridge || port != 8080 {
		t.Errorf("under local the launcher reaches Keycloak at %s:%d, want the issuer itself, %s:8080", host, port, bridge)
	}
	st := fixtureStack(t, "ollama-gemma")
	plan := mustPlan(t, st)
	p := placement{st: st, plan: plan, rt: "container", addr: bridge, lan: lanAddr}
	if got := p.issuer(); got != "http://"+lanAddr+":8080/realms/semiont" {
		t.Errorf("under lan every document names the issuer %s, want it at the network address", got)
	}
	if got := p.gatewayURL(); got != "http://"+bridge+":14000" {
		t.Errorf("under lan a container dials the gateway at %s, want its side on the bridge address", got)
	}
	claimed := portNumbers(planPortChecks(plan, false, appleContainerLAN))
	for _, port := range []int{8080, 18080, 4000, 14000} {
		if !slices.Contains(claimed, port) {
			t.Errorf("a lan start claims %v, without %d", claimed, port)
		}
	}
}

// Docker and Podman publish as before, on every interface, until D1 is ruled
// for them.
func TestDockerAndPodmanPublishAsBefore(t *testing.T) {
	for _, rt := range []string{"docker", "podman"} {
		e := exposure{rt: rt, addr: "host.docker.internal"}
		for _, role := range []string{"gateway", "graph", "database", "browser"} {
			if got := e.publishSpecs(role, 4000, 4000); !slices.Equal(got, []string{"4000:4000"}) {
				t.Errorf("%s publishes %s as %v, want 4000:4000", rt, role, got)
			}
			if got := e.probeHost(role, 4000); got != "localhost" {
				t.Errorf("%s probes %s at %s, want localhost", rt, role, got)
			}
		}
	}
}

// The launcher asks a port where something dials it (D5): loopback for a
// person's, the bridge address for the containers'.
func TestTheLaunchersProbesGoWhereTheDialersAre(t *testing.T) {
	plan := mustPlan(t, fixtureStack(t, "ollama-gemma"))
	for _, c := range []struct{ role, driver, want string }{
		{"gateway", driverSemiont, "http://localhost:4000/api/health"},
		{"graph", "neo4j", "http://localhost:7474"},
		{"metrics", "prometheus", "http://localhost:9090/-/healthy"},
		{"vectors", "qdrant", "http://" + bridge + ":6333/readyz"},
		{"database", "postgres", "tcp:" + bridge + ":5432"},
		{"messaging", "jetstream", "tcp:" + bridge + ":4222"},
		{"collector", "otel", "http://" + bridge + ":24110/metrics"},
		{"identity", "keycloak", "http://" + bridge + ":8080/realms/semiont"},
		{"archivist", driverSemiont, "http://" + bridge + ":24103/health"},
		{"worker", driverSemiont, "http://" + bridge + ":24100/health"},
	} {
		if got := healthEndpoint(c.role, c.driver, plan, appleContainer); got != c.want {
			t.Errorf("%s is asked at %s, want %s", c.role, got, c.want)
		}
	}
}

// A container dials the containers' side of a port a person dials too, and a
// start claims that side free; under Docker there is one side.
func TestTheContainersDialTheirSideOfAPortAPersonDialsToo(t *testing.T) {
	st := fixtureStack(t, "ollama-gemma")
	plan := mustPlan(t, st)
	apple := placement{st: st, plan: plan, rt: "container", addr: bridge}
	if got := apple.gatewayURL(); got != "http://"+bridge+":14000" {
		t.Errorf("a container dials the gateway at %s, want its side, :14000", got)
	}
	if got := apple.graphURI(); got != "bolt://"+bridge+":17687" {
		t.Errorf("a container dials Neo4j at %s, want its side, :17687", got)
	}
	claimed := portNumbers(planPortChecks(plan, false, appleContainer))
	for _, p := range []int{14000, 17687} {
		if !slices.Contains(claimed, p) {
			t.Errorf("a start under Apple container claims %v, without the containers' side %d", claimed, p)
		}
	}
	docker := placement{st: st, plan: plan, rt: "docker", addr: "host.docker.internal"}
	if got := docker.gatewayURL(); got != "http://host.docker.internal:4000" {
		t.Errorf("under Docker a container dials the gateway at %s, want :4000", got)
	}
	if claimed := portNumbers(planPortChecks(plan, false, exposure{rt: "docker"})); slices.Contains(claimed, 14000) || slices.Contains(claimed, 17687) {
		t.Errorf("a start under Docker claims a containers' side: %v", claimed)
	}
}
