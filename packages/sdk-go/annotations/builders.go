package annotations

// Building the annotations a worker commits, held by
// specs/src/annotations/builder-cases.json, for this and for every other SDK.

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// pdfFragments is what a PDF's fragment conforms to.
const pdfFragments = "http://tools.ietf.org/rfc/rfc3778"

// SpanRefusedError is a span AnnotationOfSpan refused, which is not the
// text's. Code names the refusal.
type SpanRefusedError struct {
	Code    semiont.SpanRefusal
	Message string
}

var _ semiont.Error = (*SpanRefusedError)(nil)

func (e *SpanRefusedError) Error() string     { return e.Message }
func (e *SpanRefusedError) ErrorCode() string { return string(e.Code) }

// Status is never stated: a span is refused where the annotation is built.
func (e *SpanRefusedError) Status() (int, bool) { return 0, false }

func refused(code semiont.SpanRefusal, format string, args ...any) *SpanRefusedError {
	return &SpanRefusedError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// OfSpan is what AnnotationOfSpan builds from. Text is the resource's text;
// for a PDF, Anchored is its anchored text and Text is empty. Generator says
// what made the annotation, and Body, nil for none, is carried as it is given.
type OfSpan struct {
	ResourceID api.ResourceId
	Motivation api.Motivation
	Generator  api.Agent
	Span       TextSpan
	Body       *api.AnnotationBodies
	Text       string
	Anchored   *api.AnchoredText
}

// OfResource is what AnnotationOfResource builds from. Generator, nil for
// none, says what made the annotation, and Body, nil for none, is carried as
// it is given.
type OfResource struct {
	ResourceID api.ResourceId
	Motivation api.Motivation
	Generator  *api.Agent
	Body       *api.AnnotationBodies
}

// isASpanOf is whether two offsets are a span of a text of length code points:
// in order, inside the text.
func isASpanOf(length, start, end int) bool { return 0 <= start && start <= end && end <= length }

// fragments is a selector for each rectangle a span of a PDF's anchored text
// is located at, when the items it overlaps cover its words.
func fragments(anchored api.AnchoredText, text offsets, span TextSpan) ([]api.Selector, error) {
	overlapping, rectangles := locate(anchored, span.Start, span.End)
	if len(rectangles) == 0 {
		return nil, refused(semiont.SpanRefusalNothingLocated, "no item of the anchored text overlaps offsets %d to %d", span.Start, span.End)
	}
	least := slices.MinFunc(overlapping, func(a, b api.PdfTextItem) int { return cmp.Compare(a.Start, b.Start) }).Start
	greatest := slices.MaxFunc(overlapping, func(a, b api.PdfTextItem) int { return cmp.Compare(a.End, b.End) }).End
	if !strings.Contains(collapsed(text.between(least, greatest)), collapsed(span.Exact)) {
		return nil, refused(semiont.SpanRefusalExactNotCovered, "the items that overlap offsets %d to %d do not cover the span's words", span.Start, span.End)
	}
	conformsTo := pdfFragments
	selectors := make([]api.Selector, len(rectangles))
	for i, at := range rectangles {
		if err := selectors[i].FromFragmentSelector(api.FragmentSelector{
			Type: api.FragmentSelectorTypeFragmentSelector, ConformsTo: &conformsTo, Value: fragmentOf(at),
		}); err != nil {
			return nil, err
		}
	}
	return selectors, nil
}

// selectorsOf is the selectors of a span of the text the builder was given,
// once the span is held to that text: where it is, then its quote.
func selectorsOf(of OfSpan) ([]api.Selector, error) {
	whole := of.Text
	if of.Anchored != nil {
		whole = of.Anchored.Text
	}
	text := offsetsOf(whole)
	if of.Anchored != nil {
		// A PDF's anchored text is held to itself before the span is held to it. Its items are what say where
		// the text is on a page, and a rectangle is made from an item's own offsets, so one that is no stretch
		// of the text refuses every span of it, whether this span touches that item or not.
		for index, item := range of.Anchored.Items {
			if !isASpanOf(text.length(), item.Start, item.End) {
				return nil, refused(semiont.SpanRefusalItemOutOfRange,
					"item %d of the anchored text is offsets %d to %d, which is no stretch of a text of %d code points",
					index, item.Start, item.End, text.length())
			}
		}
	}
	span := of.Span
	if !isASpanOf(text.length(), span.Start, span.End) {
		return nil, refused(semiont.SpanRefusalSpanOutOfRange, "offsets %d to %d are not a span of a text of %d code points", span.Start, span.End, text.length())
	}
	var where []api.Selector
	if of.Anchored == nil {
		if text.between(span.Start, span.End) != span.Exact {
			return nil, refused(semiont.SpanRefusalExactMismatch, "the text from offset %d to offset %d is not the span's words", span.Start, span.End)
		}
		where = make([]api.Selector, 1)
		if err := where[0].FromTextPositionSelector(api.TextPositionSelector{
			Type: api.TextPositionSelectorTypeTextPositionSelector, Start: span.Start, End: span.End,
		}); err != nil {
			return nil, err
		}
	} else {
		located, err := fragments(*of.Anchored, text, span)
		if err != nil {
			return nil, err
		}
		where = located
	}
	if !strings.HasSuffix(text.between(0, span.Start), span.Prefix) {
		return nil, refused(semiont.SpanRefusalPrefixMismatch, "the span's prefix is not the text just before offset %d", span.Start)
	}
	if !strings.HasPrefix(text.between(span.End, text.length()), span.Suffix) {
		return nil, refused(semiont.SpanRefusalSuffixMismatch, "the span's suffix is not the text just after offset %d", span.End)
	}
	quote := api.TextQuoteSelector{Type: api.TextQuoteSelectorTypeTextQuoteSelector, Exact: span.Exact}
	if span.Prefix != "" {
		quote.Prefix = &span.Prefix
	}
	if span.Suffix != "" {
		quote.Suffix = &span.Suffix
	}
	var quoted api.Selector
	if err := quoted.FromTextQuoteSelector(quote); err != nil {
		return nil, err
	}
	return append(where, quoted), nil
}

// given refuses an annotation whose resource or motivation was not given:
// absent, not a value to write.
func given(resource api.ResourceId, motivation api.Motivation) error {
	if resource.IsZero() {
		return errors.New("an annotation is built of a resource, and none was given")
	}
	if !motivation.Valid() {
		return fmt.Errorf("an annotation is built with its motivation, and %q is none", motivation)
	}
	return nil
}

// built is the annotation of target, built now, with the id of what it is. It
// states what it was given and nothing else.
func built(target api.AnnotationTarget, motivation api.Motivation, anchor string, generator *api.Agent, body *api.AnnotationBodies) (api.Annotation, error) {
	var written json.RawMessage
	if body != nil {
		var err error
		if written, err = body.MarshalJSON(); err != nil {
			return api.Annotation{}, err
		}
	}
	id, err := annotationID(target.Source, motivation, anchor, written)
	if err != nil {
		return api.Annotation{}, err
	}
	annotation := api.Annotation{
		Context:    api.AnnotationContextHttpwwwW3OrgnsannoJsonld,
		Type:       api.AnnotationTypeAnnotation,
		Id:         id,
		Motivation: motivation,
		Body:       body,
		Created:    time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	}
	if err := annotation.Target.FromAnnotationTarget(target); err != nil {
		return api.Annotation{}, err
	}
	if generator != nil {
		annotation.Generator = &api.Annotation_Generator{}
		if err := annotation.Generator.FromAgent(*generator); err != nil {
			return api.Annotation{}, err
		}
	}
	return annotation, nil
}

// AnnotationOfSpan builds the annotation of a span of a resource's text.
//
// A span of a text is selected by its position and its quote. A span of a PDF
// is selected by a rectangle for each line it touches, and its quote.
//
// A span is held to the text before anything is built, and one that is not
// the text's is refused with a *SpanRefusedError, whose Code says which
// refusal it is. A span Reconcile found is the text's own. For a PDF, every
// item of the anchored text must be a stretch of that text, or no span of it
// is built (SpanRefusalItemOutOfRange).
func AnnotationOfSpan(of OfSpan) (api.Annotation, error) {
	if err := given(of.ResourceID, of.Motivation); err != nil {
		return api.Annotation{}, err
	}
	generator, err := of.Generator.MarshalJSON()
	if err != nil {
		return api.Annotation{}, err
	}
	if string(generator) == "null" {
		return api.Annotation{}, errors.New("an annotation of a span is built with what made it, and no generator was given")
	}
	if of.Anchored != nil && of.Text != "" {
		return api.Annotation{}, errors.New("a span is of a text or of a PDF's anchored text, and both were given")
	}
	selectors, err := selectorsOf(of)
	if err != nil {
		return api.Annotation{}, err
	}
	var selector api.AnnotationSelector
	if err := selector.FromAnnotationSelector1(selectors); err != nil {
		return api.Annotation{}, err
	}
	specificResource := api.AnnotationTargetTypeSpecificResource
	target := api.AnnotationTarget{Type: &specificResource, Source: of.ResourceID, Selector: &selector}
	anchor := fmt.Sprintf("%d:%d:%s", of.Span.Start, of.Span.End, of.Span.Exact)
	return built(target, of.Motivation, anchor, &of.Generator, of.Body)
}

// AnnotationOfResource builds an annotation of a resource as a whole, which
// has no selector. The link from a resource to one generated from it is such
// an annotation: its Motivation is linking, and its Body names the generated
// resource.
func AnnotationOfResource(of OfResource) (api.Annotation, error) {
	if err := given(of.ResourceID, of.Motivation); err != nil {
		return api.Annotation{}, err
	}
	return built(api.AnnotationTarget{Source: of.ResourceID}, of.Motivation, "", of.Generator, of.Body)
}
