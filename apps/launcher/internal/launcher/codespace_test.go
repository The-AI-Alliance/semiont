package launcher

import (
	"bufio"
	"errors"
	"strings"
	"testing"
)

// The creation-log window renders compose output, which is full of
// box-drawing runes and CR-rewritten progress lines. These pin the two
// display bugs the first live run surfaced (LAUNCHER session 2026-07-23):
// byte-sliced truncation broke a rune in half (─────? …), and \n-only
// splitting stitched CR fragments into mega-lines.

func TestTruncateLineRuneSafe(t *testing.T) {
	rule := strings.Repeat("─", 60) // 3 bytes per rune: byte-slicing would cut mid-rune
	got := truncateLine(rule, 40)
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncated line missing ellipsis: %q", got)
	}
	if strings.ContainsRune(got, '�') || !strings.HasPrefix(got, "───") {
		t.Errorf("truncation broke a rune: %q", got)
	}
	if n := len([]rune(got)); n != 41 { // 40 kept + ellipsis
		t.Errorf("rune count = %d, want 41: %q", n, got)
	}
	if short := truncateLine("abc", 40); short != "abc" {
		t.Errorf("short line altered: %q", short)
	}
}

func TestSplitCRLines(t *testing.T) {
	// Compose progress: CR-rewritten fragments, then a real newline.
	in := "pulling 1%\rpulling 50%\rpulling 100%\n ✔ gateway Pulled\r\n"
	sc := bufio.NewScanner(strings.NewReader(in))
	sc.Split(splitCRLines)
	var lines []string
	for sc.Scan() {
		if tok := sc.Text(); tok != "" {
			lines = append(lines, tok)
		}
	}
	want := []string{"pulling 1%", "pulling 50%", "pulling 100%", " ✔ gateway Pulled"}
	if strings.Join(lines, "|") != strings.Join(want, "|") {
		t.Errorf("split = %v, want %v", lines, want)
	}
}

// SHARED classifier for "what state is this codespace in", extracted because
// three call sites decided it independently and only status got it right
// (#1058 fixed status alone; ensure/wait/stop kept the old confusion —
// .plans/bugs/codespace-record-outlives-github-retention.md). Absence from a
// SUCCESSFUL list is a state ("deleted"); only a failed or impossible query
// is "unqueryable". The distinction is the whole point: one justifies
// forgetting a record, the other never does.
func TestClassifyCodespaceState(t *testing.T) {
	live := []codespaceInstance{
		{Name: "other-one", State: "Shutdown", Repository: "o/r"},
		{Name: "mine", State: "Provisioning", Repository: "o/r"},
	}
	cases := []struct {
		name      string
		instances []codespaceInstance
		listErr   error
		ghPresent bool
		lookup    string
		want      string
	}{
		{"absent from a successful list is DELETED", live, nil, true, "reaped-by-retention", "deleted"},
		{"empty successful list is DELETED, not unqueryable", nil, nil, true, "mine", "deleted"},
		{"list error is unqueryable", live, errIsUnqueryable, true, "mine", "unqueryable"},
		{"no gh on PATH is unqueryable", live, nil, false, "mine", "unqueryable"},
		{"present: GitHub's state verbatim", live, nil, true, "mine", "Provisioning"},
		{"present: verbatim even when the state is odd", []codespaceInstance{{Name: "mine", State: "Rebuilding"}}, nil, true, "mine", "Rebuilding"},
	}
	for _, tc := range cases {
		if got := classifyCodespaceState(tc.instances, tc.listErr, tc.ghPresent, tc.lookup); got != tc.want {
			t.Errorf("%s: classifyCodespaceState = %q, want %q", tc.name, got, tc.want)
		}
	}
}

var errIsUnqueryable = errors.New("gh exploded")
