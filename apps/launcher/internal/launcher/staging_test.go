package launcher

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
	toml "github.com/pelletier/go-toml/v2"
)

const stagingFixture = `[defaults]
environment = "local"

[environments.local.gateway]
platform = "container"
port = 4000
`

// The staged realm carries every service's client secret. What keeps it from
// other users is the directory it is staged in, not the file's own mode (see
// stageDir).
func TestStagedRealmIsReachableOnlyByItsOwner(t *testing.T) {
	x := &liveExec{u: NewUI(true)}
	p, ok := x.stageRealm("probe", []byte(`{"clients":[{"secret":"probe"}]}`))
	if !ok {
		t.Fatal("stageRealm failed")
	}
	dir := filepath.Dir(p)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if open := harness.OpenToOthers(t, dir); open != "" {
		t.Fatalf("the realm is staged in %s, which %s: other users can reach the client secrets in it", dir, open)
	}
}

// The read half, pinned against the shape a real KB commits: the identity
// lives in `[site]` of `.semiont/config`, and the launcher is now the only
// thing that can carry it to the gateway.
func TestParseKBIdentityReadsSiteIdentity(t *testing.T) {
	committed := `
[project]
name = "Example Knowledge Base"
version = "0.1.0"

[site]
domain = "example.org:kb"
siteName = "Example Knowledge Base"
`
	id := parseKBIdentity([]byte(committed))
	if id == nil {
		t.Fatal("parseKBIdentity returned nil for a well-formed committed config")
	}
	if id.Domain != "example.org:kb" {
		t.Errorf("Domain = %q, want the committed did:web identity", id.Domain)
	}
	if id.SiteName != "Example Knowledge Base" {
		t.Errorf("SiteName = %q, want the committed site name", id.SiteName)
	}
}

// The whole per-service staging rule in one place. This is the test that
// catches a boot break: three services REFUSE to start without an Archivist
// address (SINGLE-KB-MOUNT P4), and the one that describes a KB tree it does
// not mount needs its committed identity at the same time (P5) — a patch
// structure that assigned rather than chained would silently drop one.
func TestStagedConfigPerService(t *testing.T) {
	x := &liveExec{root: t.TempDir()}

	for _, tc := range []struct {
		svc        string
		archivist  bool
		kbIdentity bool
	}{
		// The gateway is absent: it takes a configuration document, not a
		// patched copy (gatewaydoc_test.go).
		{"librarian", true, true},
		{"smelter", true, false},
		{"worker", true, false},
		{"weaver", false, false},
		// The Archivist IS the record — it holds the mount and dials nobody.
		{"archivist", false, false},
	} {
		out := x.stagedConfig(tc.svc, []byte(stagingFixture), &launchPlan{EnvName: "local"}, "192.168.64.1")

		var doc map[string]any
		if err := toml.Unmarshal(out, &doc); err != nil {
			t.Fatalf("%s: staged config is not valid TOML: %v\n%s", tc.svc, err, out)
		}

		env, _ := doc["environments"].(map[string]any)["local"].(map[string]any)
		_, hasArchivist := env["archivist"]
		if hasArchivist != tc.archivist {
			t.Errorf("%s: [environments.local.archivist] present = %v, want %v", tc.svc, hasArchivist, tc.archivist)
		}

		_, hasKB := doc["kb"]
		if hasKB != tc.kbIdentity {
			t.Errorf("%s: [kb] present = %v, want %v", tc.svc, hasKB, tc.kbIdentity)
		}
	}
}
