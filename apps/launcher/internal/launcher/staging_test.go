package launcher

import (
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
)

const stagingFixture = `[defaults]
environment = "local"

[environments.local.backend]
platform = "container"
port = 4000
`

func TestPatchArchivistTopologyAppends(t *testing.T) {
	out := patchArchivistTopology([]byte(stagingFixture), "local", "192.168.64.1")

	var doc map[string]any
	if err := toml.Unmarshal(out, &doc); err != nil {
		t.Fatalf("patched config is not valid TOML: %v\n%s", err, out)
	}
	arch, ok := doc["environments"].(map[string]any)["local"].(map[string]any)["archivist"].(map[string]any)
	if !ok {
		t.Fatalf("no [environments.local.archivist] in patched config:\n%s", out)
	}
	if got := arch["host"]; got != "192.168.64.1" {
		t.Fatalf("host = %v, want the literal launcher address", got)
	}
	if got := arch["port"]; got != int64(roles["archivist"].ports[0].port) {
		t.Fatalf("port = %v, want the roles table's %d (one home for the port)", got, roles["archivist"].ports[0].port)
	}
}

func TestPatchArchivistTopologyRespectsHandWrittenSection(t *testing.T) {
	handWritten := stagingFixture + "\n[environments.local.archivist]\nhost = \"archivist.internal\"\nport = 9999\n"
	out := patchArchivistTopology([]byte(handWritten), "local", "192.168.64.1")
	if string(out) != handWritten {
		t.Fatalf("a hand-written archivist section must pass through untouched")
	}
}

func TestPatchArchivistTopologyOtherEnvSectionDoesNotBlock(t *testing.T) {
	// A remote env's hand-written section must not suppress the local append.
	other := stagingFixture + "\n[environments.production.archivist]\nhost = \"archivist.example.com\"\nport = 9093\n"
	out := patchArchivistTopology([]byte(other), "local", "192.168.64.1")
	if !strings.Contains(string(out), "[environments.local.archivist]") {
		t.Fatalf("section for a different env suppressed the local append:\n%s", out)
	}
}
