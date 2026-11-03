package launcher

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// megabytes writes a file of n megabytes of data.
func megabytes(t *testing.T, path string, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("x", n<<20)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A directory takes what its files take, give or take a filesystem's
// rounding; one that is not there is absent, and an empty one takes nothing.
func TestDiskUseIsWhatTheFilesTake(t *testing.T) {
	dir := t.TempDir()
	if n, ok := diskUse(filepath.Join(dir, "not-there")); ok || n != 0 {
		t.Errorf("a directory that is not there: %d, %v; want absent", n, ok)
	}
	if n, ok := diskUse(dir); !ok || n != 0 {
		t.Errorf("an empty directory: %d, %v; want present and nothing", n, ok)
	}
	megabytes(t, filepath.Join(dir, "a", "one"), 1)
	megabytes(t, filepath.Join(dir, "b", "two"), 2)
	n, ok := diskUse(dir)
	if !ok || n < 3<<20 || n > 3<<20+256<<10 {
		t.Errorf("three megabytes of files measure %d bytes (present: %v)", n, ok)
	}
}

// A knowledge base's directory is reported as each of its stores that is
// there, largest first, with what it holds, and its container logs; its total
// is the whole of it. The machine's directory is reported as the shared
// stores in it: the issuer's PostgreSQL, every knowledge base's realm.
func TestStoreUseListsEachDirectoryLargestFirst(t *testing.T) {
	dir := t.TempDir()
	megabytes(t, filepath.Join(dir, "neo4j", "data", "store"), 3)
	megabytes(t, filepath.Join(dir, "logs", "20260101-000000Z", "gateway.log"), 2)
	megabytes(t, filepath.Join(dir, "postgres", "pgdata", "base"), 1)
	megabytes(t, filepath.Join(dir, "something-else", "file"), 1)

	rows := func(uses []storeUseRow) []string {
		var names []string
		for _, use := range uses {
			names = append(names, use.dir+": "+use.holds)
		}
		return names
	}
	uses, total, any := storeUse(dir, false)
	if !any {
		t.Fatal("a directory with two stores in it reads as holding none")
	}
	if got, want := rows(uses), []string{"neo4j: graph", "logs: container logs kept from earlier starts"}; !slices.Equal(got, want) {
		t.Errorf("a knowledge base's rows are %q, want %q", got, want)
	}
	if total < 7<<20 {
		t.Errorf("the total is %d bytes: it leaves out what is in the directory beside the stores", total)
	}
	uses, _, _ = storeUse(dir, true)
	if got, want := rows(uses), []string{"postgres: Keycloak's realms and accounts, every knowledge base's"}; !slices.Equal(got, want) {
		t.Errorf("the machine's rows are %q, want %q", got, want)
	}
	if _, _, any := storeUse(t.TempDir(), false); any {
		t.Error("an empty directory reads as holding stores")
	}
}

// A store the report cannot describe would print a directory and a size with
// nothing beside them.
func TestEveryStoreSaysWhatItHolds(t *testing.T) {
	for role, spec := range stateStores {
		if spec.holds == "" {
			t.Errorf("the %s store (%s) does not say what it holds", role, spec.dir)
		}
	}
}
