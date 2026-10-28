package annotations

// What a text offset counts, held to specs/src/text/offset-cases.json: run
// both ways, from where a search of the string found a span to its offsets,
// and from its offsets to the text there.

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestAnOffsetCountsCodePointsBothWays(t *testing.T) {
	text, err := os.ReadFile("../../../../specs/src/text/offset-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why        string `json:"why"`
			Text       string `json:"text"`
			CodePoints int    `json:"codePoints"`
			Spans      []struct {
				Exact      string `json:"exact"`
				Occurrence int    `json:"occurrence"`
				Start      int    `json:"start"`
				End        int    `json:"end"`
			} `json:"spans"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table has no case")
	}
	for _, stated := range table.Cases {
		counted := offsetsOf(stated.Text)
		if counted.length() != stated.CodePoints {
			t.Errorf("%s: the text is %d code points, and the table says %d", stated.Why, counted.length(), stated.CodePoints)
		}
		for _, span := range stated.Spans {
			// Found by a search of the string, in its own count, then given as offsets.
			found, from := -1, 0
			for range span.Occurrence {
				at := strings.Index(stated.Text[from:], span.Exact)
				if at < 0 {
					found = -1
					break
				}
				found = from + at
				from = found + 1
			}
			if found < 0 {
				t.Errorf("%s: %q occurs fewer than %d times", stated.Why, span.Exact, span.Occurrence)
				continue
			}
			start, startOK := counted.offset(found)
			end, endOK := counted.offset(found + len(span.Exact))
			if !startOK || !endOK || start != span.Start || end != span.End {
				t.Errorf("%s: %q found is %d to %d, and the table says %d to %d", stated.Why, span.Exact, start, end, span.Start, span.End)
			}
			// Given as offsets, taken in the string's own count.
			from, fromOK := counted.index(span.Start)
			to, toOK := counted.index(span.End)
			if !fromOK || !toOK || stated.Text[from:to] != span.Exact {
				t.Errorf("%s: %d to %d is not %q", stated.Why, span.Start, span.End, span.Exact)
			}
		}
	}
	if _, ok := offsetsOf("ab").index(3); ok {
		t.Error("an offset past the text was taken")
	}
	if _, ok := offsetsOf("é").offset(1); ok {
		t.Error("an index inside a character was taken as an offset")
	}
}
