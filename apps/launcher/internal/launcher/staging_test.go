package launcher

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

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
// lives in `[site]` of `.semiont/config`, and the launcher is the only thing
// that can carry it to the gateway.
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
