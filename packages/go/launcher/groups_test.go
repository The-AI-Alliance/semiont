package launcher

import (
	"strings"
	"testing"
)

// members renders a closure as "role" for a group's own role and
// "role<because" for one it takes along.
func members(ms []groupMember) string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.role
		if m.because != "" {
			out[i] += "<" + m.because
		}
	}
	return strings.Join(out, " ")
}

func mustGroup(t *testing.T, name string) serviceGroup {
	t.Helper()
	g, ok := groupNamed(name)
	if !ok {
		t.Fatalf("no group is named %s", name)
	}
	return g
}

// What a group's stop stops, last-started first, pinned for every group: an
// edge added to the descriptors changes this test before it changes what a
// stop takes down. A knowledge base's group takes along what needs it in that
// knowledge base, and the worker only with the last stack; a shared group
// stops alone.
func TestEachGroupStopsWhatNeedsIt(t *testing.T) {
	for _, c := range []struct {
		group string
		last  bool
		want  string
	}{
		{"record", false, "weaver<gateway smelter<gateway dispatcher librarian<gateway archivist gateway messaging"},
		{"record", true, "weaver<gateway smelter<gateway worker<gateway dispatcher librarian<gateway archivist gateway messaging"},
		{"index", true, "weaver smelter librarian vectors graph"},
		{"issuer", false, "weaver<gateway smelter<gateway dispatcher<gateway librarian<gateway archivist<gateway gateway<identity identity identity-store"},
		{"issuer", true, "weaver<gateway smelter<gateway worker<gateway dispatcher<gateway librarian<gateway archivist<gateway gateway<identity identity identity-store"},
		{"knowledge-workers", true, "browser worker"},
		{"providers", true, "embedding inference"},
		{"telemetry", true, "collector metrics traces"},
	} {
		if got := members(groupStops(mustGroup(t, c.group), c.last)); got != c.want {
			t.Errorf("stop --group %s (last stack: %v) stops\n  %s\nwant\n  %s", c.group, c.last, got, c.want)
		}
	}
}
