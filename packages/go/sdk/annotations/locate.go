package annotations

// Where a span of a PDF's text is on its pages.
//
// An annotation of a PDF is anchored by rectangles on its pages, so a span of
// the PDF's anchored text is located: one rectangle for each line it touches,
// each written as an RFC 3778 fragment.
// specs/src/annotations/pdf-locate-cases.json holds the rule, for this and for
// every other SDK.
//
// A span's offsets and an item's count code points. Coordinates are PDF points
// from the bottom-left corner of the page, y growing upward.

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strconv"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// sameLine is how many points of the first item of a line an item's y may be
// within and be on that line.
const sameLine = 2

// rectangle is a rectangle on a page: its bottom-left corner and its size, in
// PDF points.
type rectangle struct {
	page, x, y, width, height float64
}

// lines is a page's items as its lines, the top of the page first and each
// line from its left.
func lines(items []api.PdfTextItem) [][]api.PdfTextItem {
	ordered := slices.Clone(items)
	slices.SortStableFunc(ordered, func(a, b api.PdfTextItem) int {
		return cmp.Or(cmp.Compare(b.Y, a.Y), cmp.Compare(a.X, b.X))
	})
	var found [][]api.PdfTextItem
	for _, item := range ordered {
		if last := len(found) - 1; last >= 0 && math.Abs(item.Y-found[last][0].Y) <= sameLine {
			found[last] = append(found[last], item)
		} else {
			found = append(found, []api.PdfTextItem{item})
		}
	}
	return found
}

// edges is an item's left and right edges, each moved in where the span cuts
// the item: in proportion to the code points cut off.
func edges(item api.PdfTextItem, start, end int) (left, right float64) {
	count := float64(item.End - item.Start)
	left, right = item.X, item.X+item.Width
	if item.Start < start {
		left = item.X + item.Width*(float64(start-item.Start)/count)
	}
	if item.End > end {
		right = item.X + item.Width*(float64(end-item.Start)/count)
	}
	return left, right
}

// spanning is the rectangle that spans a line's items, as far as the span
// reaches into each.
func spanning(page float64, line []api.PdfTextItem, start, end int) rectangle {
	x, right := math.Inf(1), math.Inf(-1)
	y, top := math.Inf(1), math.Inf(-1)
	for _, item := range line {
		left, itemRight := edges(item, start, end)
		x, right = min(x, left), max(right, itemRight)
		y, top = min(y, item.Y), max(top, item.Y+item.Height)
	}
	return rectangle{page: page, x: x, y: y, width: right - x, height: top - y}
}

// locate is the items a span of the anchored text overlaps, in the text's
// order, and a rectangle for each line of each page it touches. Pages come in
// the order their first overlapped item has in the text. A span that no item
// overlaps has neither, and an empty span overlaps none.
func locate(anchored api.AnchoredText, start, end int) ([]api.PdfTextItem, []rectangle) {
	// An empty span has no character for an item to hold, inside one as between two.
	if start == end {
		return nil, nil
	}
	var overlapping []api.PdfTextItem
	var pages []float64
	onPage := map[float64][]api.PdfTextItem{}
	for _, item := range anchored.Items {
		if item.Start < end && item.End > start {
			overlapping = append(overlapping, item)
			if _, seen := onPage[item.Page]; !seen {
				pages = append(pages, item.Page)
			}
			onPage[item.Page] = append(onPage[item.Page], item)
		}
	}
	var rectangles []rectangle
	for _, page := range pages {
		for _, line := range lines(onPage[page]) {
			rectangles = append(rectangles, spanning(page, line, start, end))
		}
	}
	return overlapping, rectangles
}

// decimal is a number as the shortest decimal that reads back as it, with no
// exponent: a whole number has no point.
func decimal(number float64) string {
	if number == math.Trunc(number) && math.Abs(number) < 1<<53 {
		return strconv.FormatInt(int64(number), 10)
	}
	return strconv.FormatFloat(number, 'f', -1, 64)
}

// fragmentOf is a rectangle as the value of a FragmentSelector:
// page=P&viewrect=X,Y,W,H.
func fragmentOf(at rectangle) string {
	return fmt.Sprintf("page=%s&viewrect=%s,%s,%s,%s", decimal(at.page), decimal(at.x), decimal(at.y), decimal(at.width), decimal(at.height))
}
