package launcher

import (
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
)

const stagingFixture = `[defaults]
environment = "local"

[environments.local.gateway]
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
	other := stagingFixture + "\n[environments.production.archivist]\nhost = \"archivist.example.com\"\nport = 9999\n"
	out := patchArchivistTopology([]byte(other), "local", "192.168.64.1")
	if !strings.Contains(string(out), "[environments.local.archivist]") {
		t.Fatalf("section for a different env suppressed the local append:\n%s", out)
	}
}

// SINGLE-KB-MOUNT D4: the Librarian has no /kb mount, so the launcher stages
// the KB's committed name under a TOP-LEVEL [kb] — beside [defaults], out of
// any environment section's reach, which is what "not overridable" means.
func TestPatchKBIdentityAppends(t *testing.T) {
	out := patchKBIdentity([]byte(stagingFixture), "example-kb", "example.org:kb", []string{"example.com"})
	var doc map[string]any
	if err := toml.Unmarshal(out, &doc); err != nil {
		t.Fatalf("patched config is not valid TOML: %v\n%s", err, out)
	}
	kb, ok := doc["kb"].(map[string]any)
	if !ok {
		t.Fatalf("no [kb] in patched config:\n%s", out)
	}
	if got := kb["name"]; got != "example-kb" {
		t.Fatalf("name = %v, want the committed KB name", got)
	}
	// P5: the gateway's boot refusal (KB-IDENTITY decision 8) turns on this
	// value once it stops mounting the tree that declares it.
	if got := kb["domain"]; got != "example.org:kb" {
		t.Fatalf("domain = %v, want the committed did:web identity", got)
	}
}

// The read half, pinned against the shape a real KB commits: both the identity
// and the sign-in policy live in `[site]` of `.semiont/config`, and the launcher
// is now the only thing that can carry either to the gateway.
func TestParseKBIdentityReadsSitePolicy(t *testing.T) {
	committed := `
[project]
name = "Example Knowledge Base"
version = "0.1.0"

[site]
domain = "example.org:kb"
siteName = "Example Knowledge Base"
oauthAllowedDomains = ["example.com"]
`
	id := parseKBIdentity([]byte(committed))
	if id == nil {
		t.Fatal("parseKBIdentity returned nil for a well-formed committed config")
	}
	if id.Domain != "example.org:kb" {
		t.Errorf("Domain = %q, want the committed did:web identity", id.Domain)
	}
	if len(id.OAuthAllowedDomains) != 1 || id.OAuthAllowedDomains[0] != "example.com" {
		t.Errorf("OAuthAllowedDomains = %v, want the committed sign-in policy", id.OAuthAllowedDomains)
	}
}

// The sign-in policy rides along for the same reason the domain does: it is
// committed in `.semiont/config`, the gateway REFUSES to start without it, and
// the gateway no longer mounts the tree that holds it. Staging the identity but
// not the policy is what made a well-formed KB unstartable.
func TestPatchKBIdentityStagesOAuthAllowedDomains(t *testing.T) {
	out := patchKBIdentity([]byte(stagingFixture), "example-kb", "example.org:kb",
		[]string{"example.com", "partner.example"})
	var doc map[string]any
	if err := toml.Unmarshal(out, &doc); err != nil {
		t.Fatalf("patched config is not valid TOML: %v\n%s", err, out)
	}
	kb := doc["kb"].(map[string]any)
	got, ok := kb["oauthAllowedDomains"].([]any)
	if !ok {
		t.Fatalf("no oauthAllowedDomains in [kb]:\n%s", out)
	}
	if len(got) != 2 || got[0] != "example.com" || got[1] != "partner.example" {
		t.Fatalf("oauthAllowedDomains = %v, want both committed domains in order", got)
	}
}

// A KB that declares no domain stages NONE — the consumer's refusal is the
// point, and a fabricated identity is the one outcome worse than failing. The
// same holds for the sign-in policy: inventing one would silently widen who
// may authenticate.
func TestPatchKBIdentityOmitsAnUndeclaredDomain(t *testing.T) {
	out := patchKBIdentity([]byte(stagingFixture), "example-kb", "", nil)
	var doc map[string]any
	if err := toml.Unmarshal(out, &doc); err != nil {
		t.Fatalf("patched config is not valid TOML: %v\n%s", err, out)
	}
	kb := doc["kb"].(map[string]any)
	if _, has := kb["domain"]; has {
		t.Fatalf("staged a domain the KB never declared:\n%s", out)
	}
	if _, has := kb["oauthAllowedDomains"]; has {
		t.Fatalf("staged a sign-in policy the KB never declared:\n%s", out)
	}
}

func TestPatchKBIdentityRespectsHandWrittenSection(t *testing.T) {
	// The escape hatch: an operator who moved a KB directory but keeps its
	// state tree under the old name pins [kb] by hand and the launcher
	// defers, same stance as patchArchivistTopology.
	handWritten := "[kb]\nname = \"pinned-elsewhere\"\n\n" + stagingFixture
	out := patchKBIdentity([]byte(handWritten), "example-kb", "example.org:kb", []string{"example.com"})
	if string(out) != handWritten {
		t.Fatalf("a hand-written [kb] section must pass through untouched")
	}
}

// The whole per-service staging rule in one place. This is the test that
// catches a boot break: four services REFUSE to start without an Archivist
// address (SINGLE-KB-MOUNT P4), and the two that describe a KB tree they do
// not mount need its committed identity at the same time (P5) — a patch
// structure that assigned rather than chained would silently drop one.
func TestStagedConfigPerService(t *testing.T) {
	x := &liveExec{root: t.TempDir()}

	for _, tc := range []struct {
		svc        string
		archivist  bool
		kbIdentity bool
	}{
		// The gateway joined the identity column in P5: once it stops mounting
		// /kb, staged [kb] is the ONLY way it sees the committed domain its
		// boot refusal turns on.
		{"gateway", true, true},
		{"librarian", true, true},
		{"smelter", true, false},
		{"worker", true, false},
		{"weaver", false, false},
		// The Archivist IS the record — it holds the mount and dials nobody.
		{"archivist", false, false},
	} {
		out := x.stagedConfig(tc.svc, []byte(stagingFixture), "local", "192.168.64.1")

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
