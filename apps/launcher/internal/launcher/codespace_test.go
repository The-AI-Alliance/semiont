package launcher

import (
	"bufio"
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
	in := "pulling 1%\rpulling 50%\rpulling 100%\n ✔ backend Pulled\r\n"
	sc := bufio.NewScanner(strings.NewReader(in))
	sc.Split(splitCRLines)
	var lines []string
	for sc.Scan() {
		if tok := sc.Text(); tok != "" {
			lines = append(lines, tok)
		}
	}
	want := []string{"pulling 1%", "pulling 50%", "pulling 100%", " ✔ backend Pulled"}
	if strings.Join(lines, "|") != strings.Join(want, "|") {
		t.Errorf("split = %v, want %v", lines, want)
	}
}
