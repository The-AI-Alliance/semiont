package launcher

import (
	"os"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// What keeps a stack's staged documents from other users is the directory
// they are staged in, not the files' own mode (see stageDir).
func TestTheStagingDirIsReachableOnlyByItsOwner(t *testing.T) {
	x := &liveExec{u: NewUI(true)}
	dir, ok := x.stageDir()
	if !ok {
		t.Fatal("stageDir failed")
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if open := harness.OpenToOthers(t, dir); open != "" {
		t.Fatalf("documents are staged in %s, which %s: other users can reach them", dir, open)
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
