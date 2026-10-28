package annotations_test

// Finding the words a model quoted, held to
// specs/src/annotations/reconcile-cases.json: the table every SDK's Reconcile
// runs.

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/annotations"
)

// asTheTableWritesIt is a reconciled span as the table writes one: each of
// its context and its match quality left out where there is none.
func asTheTableWritesIt(span annotations.ReconciledSpan) map[string]any {
	written := map[string]any{
		"start":        span.Start,
		"end":          span.End,
		"exact":        span.Exact,
		"anchorMethod": string(span.AnchorMethod),
	}
	if span.Prefix != "" {
		written["prefix"] = span.Prefix
	}
	if span.Suffix != "" {
		written["suffix"] = span.Suffix
	}
	if span.MatchQuality != "" {
		written["matchQuality"] = string(span.MatchQuality)
	}
	return written
}

func TestReconcileFindsWhatTheTableSaysOfEveryQuote(t *testing.T) {
	var table struct {
		Cases []struct {
			Why    string `json:"why"`
			Text   string `json:"text"`
			Quoted struct {
				Exact  string `json:"exact"`
				Prefix string `json:"prefix"`
				Suffix string `json:"suffix"`
			} `json:"quoted"`
			Reconciled json.RawMessage `json:"reconciled"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readSpec(t, "annotations/reconcile-cases.json"), &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table has no case")
	}
	for _, stated := range table.Cases {
		var want any
		if err := json.Unmarshal(stated.Reconciled, &want); err != nil {
			t.Fatal(err)
		}
		span, found := annotations.Reconcile(stated.Text, annotations.QuotedText(stated.Quoted))
		var got any
		if found {
			got = asJSON(t, asTheTableWritesIt(span))
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: reconciled %v, and the table says %v", stated.Why, got, want)
		}
	}
}
