package annotations_test

// The annotation a worker commits, held to
// specs/src/annotations/builder-cases.json: the table every SDK's builders
// run. AnnotationOfSpan runs its `cases`, and AnnotationOfResource its
// `resources`.

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strconv"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/annotations"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// createdLayout is an RFC 3339 date-time in UTC to the millisecond.
const createdLayout = "2006-01-02T15:04:05.000Z"

// builderCase is what every case of the table states: what to build, and the
// annotation built or the refusal.
type builderCase struct {
	Why        string                `json:"why"`
	ResourceID api.ResourceId        `json:"resourceId"`
	Motivation api.Motivation        `json:"motivation"`
	Generator  *api.Agent            `json:"generator"`
	Body       *api.AnnotationBodies `json:"body"`
	Annotation json.RawMessage       `json:"annotation"`
	Refused    semiont.SpanRefusal   `json:"refused"`
}

// builderTable is the table, with a span's offsets as the table writes them.
type builderTable struct {
	Unstated struct {
		Cases     []string `json:"cases"`
		Resources []string `json:"resources"`
	} `json:"unstated"`
	Cases []struct {
		builderCase
		Text     *string           `json:"text"`
		Anchored *api.AnchoredText `json:"anchored"`
		Span     struct {
			Start  json.Number `json:"start"`
			End    json.Number `json:"end"`
			Exact  string      `json:"exact"`
			Prefix string      `json:"prefix"`
			Suffix string      `json:"suffix"`
		} `json:"span"`
	} `json:"cases"`
	Resources []builderCase `json:"resources"`
}

// offset is a span's offset as Go states it, an int; false for a number the
// table states that no int is.
func offset(stated json.Number) (int, bool) {
	whole, err := strconv.Atoi(stated.String())
	return whole, err == nil
}

// asBuilt is what the case built, checked against what the table says: the
// annotation less what no case can state, which is checked here to be the
// moment it was built, or the refusal.
func asBuilt(t *testing.T, unstated []string, stated builderCase, build func() (api.Annotation, error)) {
	t.Helper()
	before := time.Now().UTC().Truncate(time.Millisecond)
	annotation, err := build()
	after := time.Now().UTC()
	if stated.Refused != "" {
		var refusal *annotations.SpanRefusedError
		if !errors.As(err, &refusal) || refusal.Code != stated.Refused {
			t.Errorf("%s: built with %v, and the table says it is refused, %s", stated.Why, err, stated.Refused)
		}
		return
	}
	if err != nil {
		t.Errorf("%s: %v", stated.Why, err)
		return
	}
	written, ok := asJSON(t, annotation).(map[string]any)
	if !ok {
		t.Fatalf("%s: an annotation is not written as an object", stated.Why)
	}
	if !slices.Equal(unstated, []string{"created"}) {
		t.Fatalf("the table says no case states %v, and this runner checks created alone", unstated)
	}
	created, isText := written["created"].(string)
	at, err := time.Parse(createdLayout, created)
	if !isText || err != nil || at.Before(before) || at.After(after) {
		t.Errorf("%s: created %v, which is not the moment it was built in UTC to the millisecond", stated.Why, written["created"])
	}
	delete(written, "created")
	var want any
	if err := json.Unmarshal(stated.Annotation, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(any(written), want) {
		t.Errorf("%s: built %v, and the table says %v", stated.Why, written, want)
	}
}

func readBuilderTable(t *testing.T) builderTable {
	t.Helper()
	var table builderTable
	if err := json.Unmarshal(readSpec(t, "annotations/builder-cases.json"), &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 || len(table.Resources) == 0 {
		t.Fatal("the table was not read")
	}
	return table
}

func TestAnnotationOfSpanBuildsOrRefusesAsTheTableSays(t *testing.T) {
	table := readBuilderTable(t)
	for _, stated := range table.Cases {
		if (stated.Text == nil) == (stated.Anchored == nil) {
			t.Fatalf("%s: a case gives a text or an anchored text", stated.Why)
		}
		if stated.Generator == nil {
			t.Fatalf("%s: a case of a span gives what made it", stated.Why)
		}
		start, startOK := offset(stated.Span.Start)
		end, endOK := offset(stated.Span.End)
		if !startOK || !endOK {
			// A span here holds two ints, so an offset that is no whole number is refused where the span is made.
			if stated.Refused != semiont.SpanRefusalSpanOutOfRange {
				t.Errorf("%s: offsets %s to %s are no ints, and the table says %q", stated.Why, stated.Span.Start, stated.Span.End, stated.Refused)
			}
			continue
		}
		of := annotations.OfSpan{
			ResourceID: stated.ResourceID,
			Motivation: stated.Motivation,
			Generator:  *stated.Generator,
			Span: annotations.TextSpan{
				Start: start, End: end, Exact: stated.Span.Exact, Prefix: stated.Span.Prefix, Suffix: stated.Span.Suffix,
			},
			Body:     stated.Body,
			Anchored: stated.Anchored,
		}
		if stated.Text != nil {
			of.Text = *stated.Text
		}
		asBuilt(t, table.Unstated.Cases, stated.builderCase, func() (api.Annotation, error) { return annotations.AnnotationOfSpan(of) })
	}
}

func TestAnnotationOfResourceBuildsAsTheTableSays(t *testing.T) {
	table := readBuilderTable(t)
	for _, stated := range table.Resources {
		of := annotations.OfResource{ResourceID: stated.ResourceID, Motivation: stated.Motivation, Generator: stated.Generator, Body: stated.Body}
		asBuilt(t, table.Unstated.Resources, stated, func() (api.Annotation, error) { return annotations.AnnotationOfResource(of) })
	}
}

func TestABuilderRefusesWhatItWasNotGiven(t *testing.T) {
	resource, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	var generator api.Agent
	if err := generator.UnmarshalJSON([]byte(`{"@type":"Software","@id":"did:web:kb.example:agents:a","name":"a"}`)); err != nil {
		t.Fatal(err)
	}
	span := annotations.TextSpan{Start: 0, End: 3, Exact: "Ada"}
	whole := annotations.OfSpan{ResourceID: resource, Motivation: api.MotivationHighlighting, Generator: generator, Span: span, Text: "Ada"}
	if _, err := annotations.AnnotationOfSpan(whole); err != nil {
		t.Fatalf("the span every check below takes one thing from is refused: %v", err)
	}
	for why, of := range map[string]annotations.OfSpan{
		"no resource":             {Motivation: whole.Motivation, Generator: whole.Generator, Span: span, Text: whole.Text},
		"no motivation":           {ResourceID: resource, Generator: whole.Generator, Span: span, Text: whole.Text},
		"no generator":            {ResourceID: resource, Motivation: whole.Motivation, Span: span, Text: whole.Text},
		"a text and a PDF's both": {ResourceID: resource, Motivation: whole.Motivation, Generator: whole.Generator, Span: span, Text: whole.Text, Anchored: &api.AnchoredText{Text: "Ada"}},
	} {
		if _, err := annotations.AnnotationOfSpan(of); err == nil {
			t.Errorf("an annotation of a span was built with %s", why)
		}
	}
	for why, of := range map[string]annotations.OfResource{
		"no resource":   {Motivation: api.MotivationLinking},
		"no motivation": {ResourceID: resource},
	} {
		if _, err := annotations.AnnotationOfResource(of); err == nil {
			t.Errorf("an annotation of a resource was built with %s", why)
		}
	}
}
