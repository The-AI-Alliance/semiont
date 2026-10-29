package launcher

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
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

// The site name is a label the shared identity table does not carry
// (specs/src/kb-identity/cases.json); this pins that the reader takes it from
// site.siteName.
func TestTheProjectFileNamesTheSite(t *testing.T) {
	committed := "project:\n  name: Example Knowledge Base\n  version: 0.1.0\ngit:\n  sync: true\nsite:\n  domain: example.org:kb\n  siteName: The Example Site\n"
	id, err := yamlKBIdentity(".semiont/config.yaml", []byte(committed))
	if err != nil {
		t.Fatal(err)
	}
	if id.SiteName != "The Example Site" {
		t.Errorf("SiteName = %q, want the committed site name", id.SiteName)
	}
}
