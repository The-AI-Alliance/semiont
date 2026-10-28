package launcher

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/harness"
)

// declaredUser: the USER an image's Dockerfile switches to last — the uid its
// process writes as. "" when the file never switches (root).
func declaredUser(t *testing.T, parts ...string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(parts...))
	if err != nil {
		t.Fatalf("reading %s: %v", filepath.Join(parts...), err)
	}
	user := ""
	for _, line := range strings.Split(string(b), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "USER "); ok {
			user = strings.TrimSpace(rest)
		}
	}
	return user
}

// The Semiont images run as a non-root user (uid 1001). On a Linux Docker host
// the invoker is some other uid, so a bind-mount dir the launcher creates 0755
// is unwritable inside — the archivist died with EACCES in a codespace
// (uid 1000). macOS runtimes map ownership and hide it.
//
// Which stores this covers is read from the images: a store whose owner is a
// Semiont-built role is written by the user its Dockerfile declares. Both
// mount paths create the dirs they mount, so each is run on a fresh data home.
func TestStoresASemiontImageWritesAreWritableByItsUser(t *testing.T) {
	gated := 0
	for _, role := range slices.Sorted(maps.Keys(stateStores)) {
		spec := stateStores[role]
		if _, ok := lookupDescriptor(spec.owner, driverSemiont); !ok {
			continue // a third-party image; its entrypoint starts as root
		}
		user := declaredUser(t, serviceDockerfile(spec.owner))
		if user == "" || user == "root" || user == "0" {
			continue
		}
		gated++
		mounts := map[string]func(x *liveExec, kb kbRoot) bool{
			"owner": func(x *liveExec, kb kbRoot) bool {
				_, ok := x.stateMounts(role, semiontImage(spec.owner, "test"), kb)
				return ok
			},
			"unstamped": func(x *liveExec, kb kbRoot) bool {
				_, ok := x.stateMountsUnstamped(role, kb)
				return ok
			},
		}
		for _, first := range slices.Sorted(maps.Keys(mounts)) {
			t.Run(role+"/"+first+"-first", func(t *testing.T) {
				harness.Home(t)
				kb := kbRoot{dir: t.TempDir()}
				if !mounts[first](&liveExec{u: NewUI(true)}, kb) {
					t.Fatal("mount prep refused on a fresh data home")
				}
				for _, m := range spec.mounts {
					mp := filepath.Join(spec.storeDir(kb.key()), m.sub)
					fi, err := os.Stat(mp)
					if err != nil {
						t.Fatal(err)
					}
					if fi.Mode().Perm()&0o002 == 0 {
						t.Errorf("%s is %v: the %s image writes it as %q, which on Linux is not the invoker — EACCES inside the container",
							mp, fi.Mode().Perm(), spec.owner, user)
					}
				}
				// The mount dirs are open to every uid; what keeps other local
				// users out is the root's state dir, which no container sees.
				dir := stateRootDir(kb.key())
				if open := harness.OpenToOthers(t, dir); open != "" {
					t.Errorf("%s %s — it is the only thing between other local users and a world-writable store", dir, open)
				}
			})
		}
	}
	if gated == 0 {
		t.Fatal("no store is written by a Semiont image — the census read nothing, so the Dockerfile parse or the owner lookup broke")
	}
}
