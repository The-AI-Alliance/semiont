package launcher

// sidebyside_test.go — several knowledge bases on one machine: which stack a
// command acts on, whose staged documents a stop sweeps, and the machine-wide
// locks that keep two starts from losing each other's changes.

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// kbNamed: a knowledge base root whose project file declares domain, by the
// one name the working directory reports for it.
func kbNamed(t *testing.T, domain string) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, ".semiont")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	project := "project:\n  name: kb\ngit:\n  sync: false\nsite:\n  domain: " + domain + "\n  siteName: KB\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(project), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// recordedAt records a local stack of the knowledge base at root, as its
// start records one.
func recordedAt(t *testing.T, root string) {
	t.Helper()
	ident, err := readKBIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	saveStack(&StackState{Runtime: "container", KBRoot: root, KBDid: ident.didWeb(), Services: map[string]ServiceState{}})
}

// selected: the stack SelectVerbStack chooses for gather, and what it said.
func selected(t *testing.T, root string) (*StackState, bool, string) {
	t.Helper()
	var st *StackState
	var ok bool
	_, said := harness.CaptureOutput(t, func() {
		st, ok = SelectVerbStack(&UI{}, "gather", LoadStackSet(), "", root, false)
	})
	return st, ok, said
}

// With two knowledge bases' stacks running, a verb acts on the one whose
// clone it stands in, or the one --root names from anywhere; standing in
// neither, it refuses and names the command for each.
func TestAVerbActsOnTheStackOfTheKnowledgeBaseItStandsIn(t *testing.T) {
	harness.Home(t)
	a, b := kbNamed(t, "example.org:a"), kbNamed(t, "example.org:b")
	recordedAt(t, a)
	recordedAt(t, b)

	t.Chdir(b)
	if st, ok, said := selected(t, ""); !ok || st == nil || st.KBRoot != b {
		t.Errorf("standing in %s, gather chose %+v (ok %v):\n%s", b, st, ok, said)
	}
	if st, ok, said := selected(t, a); !ok || st == nil || st.KBRoot != a {
		t.Errorf("--root %s, standing in %s, chose %+v (ok %v):\n%s", a, b, st, ok, said)
	}
	t.Chdir(t.TempDir())
	st, ok, said := selected(t, "")
	if ok || st != nil {
		t.Errorf("standing in neither, gather chose %+v", st)
	}
	for _, root := range []string{a, b} {
		if !strings.Contains(said, "semiont gather --root "+root) {
			t.Errorf("the refusal names no command for %s:\n%s", root, said)
		}
	}
}

// --root names a clone. A machine runs one copy of a knowledge base, so
// another clone of a running one names no stack of its own, and is refused
// rather than taken for the copy that runs; so is a knowledge base nothing
// started.
func TestRootNamesTheCloneItsStackRunsFrom(t *testing.T) {
	harness.Home(t)
	running, twin := kbNamed(t, "example.org:a"), kbNamed(t, "example.org:a")
	recordedAt(t, running)
	if st, ok, said := selected(t, twin); ok || st != nil || !strings.Contains(said, "runs from "+running) {
		t.Errorf("--root of a twin clone chose %+v (ok %v), want a refusal naming %s:\n%s", st, ok, running, said)
	}
	idle := kbNamed(t, "example.org:c")
	if st, ok, said := selected(t, idle); ok || st != nil || !strings.Contains(said, "semiont start --root "+idle) {
		t.Errorf("--root of a knowledge base nothing started chose %+v (ok %v):\n%s", st, ok, said)
	}
}

// Standing in a knowledge base nothing started names that knowledge base, as
// --root would: a verb is refused, naming its start, rather than handed the
// lone stack of another. Standing in no clone, the lone stack answers.
func TestAKnowledgeBaseNothingStartedIsHandedNoOtherStack(t *testing.T) {
	harness.Home(t)
	running, idle := kbNamed(t, "example.org:a"), kbNamed(t, "example.org:c")
	recordedAt(t, running)
	t.Chdir(idle)
	if st, ok, said := selected(t, ""); ok || st != nil || !strings.Contains(said, "semiont start --root "+idle) {
		t.Errorf("standing in %s, which nothing started, gather chose %+v (ok %v):\n%s", idle, st, ok, said)
	}
	t.Chdir(t.TempDir())
	if st, ok, said := selected(t, ""); !ok || st == nil || st.KBRoot != running {
		t.Errorf("standing in no clone, gather chose %+v (ok %v), want the lone stack of %s:\n%s", st, ok, running, said)
	}
}

// A stop sweeps the staged documents of the knowledge base it stops alone.
// Another's are live mounts of its running stack, and a key may begin
// another's, so a staging dir is a knowledge base's only when MkdirTemp's
// digits alone follow its prefix.
func TestAKnowledgeBaseSweepsOnlyItsOwnStagedDocuments(t *testing.T) {
	key := "example.org-staging-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	made := func(prefix string) string {
		t.Helper()
		dir, err := os.MkdirTemp(stagingParent(), prefix)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		return dir
	}
	own := made(stagingPrefix(key))
	made(stagingPrefix(key + ".uk"))
	made(stagingPrefix(key + "-b"))
	if got := stagedConfigs(key); !slices.Equal(got, []string{own}) {
		t.Errorf("%s's staged documents are %v, want %s alone", key, got, own)
	}
}

// Every change to the registry and to the record is a read, a change and a
// write under the machine's lock on that file: two starts changing either at
// once each keep their change.
func TestChangesMadeAtOnceEachLand(t *testing.T) {
	harness.Home(t)
	const starts = 16
	var wg sync.WaitGroup
	for i := range starts {
		wg.Go(func() {
			if err := changeRoots(func(reg *rootsRegistry) error {
				reg.Roots = append(reg.Roots, rootEntry{Path: fmt.Sprintf("/kb/%d", i)})
				return nil
			}); err != nil {
				t.Error(err)
			}
		})
		wg.Go(func() {
			saveStack(&StackState{Runtime: "container", KBRoot: fmt.Sprintf("/kb/%d", i),
				KBDid: fmt.Sprintf("did:web:example.org:kb-%d", i), Services: map[string]ServiceState{}})
		})
	}
	wg.Wait()
	if got := len(loadRoots().Roots); got != starts {
		t.Errorf("the registry holds %d rows of %d changes", got, starts)
	}
	if got := len(localStacks(LoadStackSet())); got != starts {
		t.Errorf("the record holds %d stacks of %d starts", got, starts)
	}
}

// A codespace's forward skips every port any local stack claims, not one
// stack's alone.
func TestACodespaceForwardSkipsEveryLocalStacksPorts(t *testing.T) {
	ss := &StackSet{Stacks: map[string]*StackState{
		"local:a": {KBRoot: "/kb/a", KBDid: "did:web:a", Ports: []int{4000}},
		"local:b": {KBRoot: "/kb/b", KBDid: "did:web:b", Ports: []int{4001}},
	}}
	if got := allocatePort(ss, "o/n", 4000); got <= 4001 {
		t.Errorf("a codespace forward was given %d, which a local stack claims", got)
	}
}
