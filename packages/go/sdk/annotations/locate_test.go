package annotations

// Where a span of a PDF's text is on its pages, held to the `cases` of
// specs/src/annotations/pdf-locate-cases.json. The table's `claims` and
// `landing` are the first-party worker's, and no SDK's.

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

func TestASpanIsLocatedAsTheTableSays(t *testing.T) {
	text, err := os.ReadFile("../../../../specs/src/annotations/pdf-locate-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	type statedRectangle struct {
		Page   float64 `json:"page"`
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	}
	var table struct {
		Cases []struct {
			Why      string           `json:"why"`
			Anchored api.AnchoredText `json:"anchored"`
			Span     struct {
				Start int `json:"start"`
				End   int `json:"end"`
			} `json:"span"`
			Overlapping []api.PdfTextItem `json:"overlapping"`
			Rects       []statedRectangle `json:"rects"`
			Fragments   []string          `json:"fragments"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table has no case")
	}
	for _, stated := range table.Cases {
		overlapping, rectangles := locate(stated.Anchored, stated.Span.Start, stated.Span.End)
		if !slices.Equal(overlapping, stated.Overlapping) {
			t.Errorf("%s: the span overlaps %v, and the table says %v", stated.Why, overlapping, stated.Overlapping)
		}
		rects := make([]statedRectangle, len(rectangles))
		fragments := make([]string, len(rectangles))
		for i, at := range rectangles {
			rects[i] = statedRectangle{Page: at.page, X: at.x, Y: at.y, Width: at.width, Height: at.height}
			fragments[i] = fragmentOf(at)
		}
		if !slices.Equal(rects, stated.Rects) {
			t.Errorf("%s: the rectangles are %v, and the table says %v", stated.Why, rects, stated.Rects)
		}
		if !slices.Equal(fragments, stated.Fragments) {
			t.Errorf("%s: the fragments are %v, and the table says %v", stated.Why, fragments, stated.Fragments)
		}
	}
}

func TestANumberIsWrittenAsTheShortestDecimalWithNoExponent(t *testing.T) {
	hairline := rectangle{page: 1, x: 72, y: 700.25, width: 0.00005, height: 12}
	if got := fragmentOf(hairline); got != "page=1&viewrect=72,700.25,0.00005,12" {
		t.Errorf("a hairline is written %s", got)
	}
}
