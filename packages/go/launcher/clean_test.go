package launcher

import (
	"strings"
	"testing"
)

// The --store option list in cleanUsage is hand-written prose (each store
// carries a tradeoff note), so it cannot be derived from stateStores — this
// gate fails when the table grows a store the help does not mention. The
// unknown-store error needs no gate: it joins the table's keys directly.
func TestCleanUsageNamesEveryStore(t *testing.T) {
	start := strings.Index(cleanUsage, "Remove one store only:")
	end := strings.Index(cleanUsage, "--root")
	if start < 0 || end < start {
		t.Fatalf("cleanUsage no longer has the --store option list this test anchors on")
	}
	list := cleanUsage[start:end]
	for name := range stateStores {
		if !strings.Contains(list, name) {
			t.Errorf("stateStores has %q but cleanUsage's --store list does not mention it", name)
		}
	}
}

// The usage names both of a realm's cleans: a root's, which deletes its realm
// through a running issuer or one it runs for the delete, and the shared one,
// which removes the store every realm here is kept in.
func TestCleanUsageNamesTheSharedIssuersCleans(t *testing.T) {
	for _, want := range []string{
		"one this clean runs for the delete and stops again",
		"semiont clean --shared --store identity-store removes the shared issuer's",
		"--shared         The machine's shared state instead of a root's",
	} {
		if !strings.Contains(cleanUsage, want) {
			t.Errorf("cleanUsage does not say %q", want)
		}
	}
}
