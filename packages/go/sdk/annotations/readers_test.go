package annotations_test

// The annotation readers, held to specs/src/annotations/reader-cases.json:
// the table every SDK's readers run.

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/annotations"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// readSpec is a file of specs/src.
func readSpec(t *testing.T, path string) []byte {
	t.Helper()
	text, err := os.ReadFile("../../../../specs/src/" + path)
	if err != nil {
		t.Fatal(err)
	}
	return text
}

// optional is a reader's answer as the table writes it: the value, or null
// for none.
func optional[T any](value T, ok bool) any {
	if !ok {
		return nil
	}
	return value
}

// read is what one reader answers of an annotation, as the table writes it;
// false for a reader this runner does not know.
func read(t *testing.T, reader string, annotation api.Annotation) (any, bool) {
	t.Helper()
	selector := annotations.TargetSelector(annotation.Target)
	switch reader {
	case "bodySource":
		id, ok := annotations.BodySource(annotation.Body)
		return optional(id.String(), ok), true
	case "isBodyResolved":
		return annotations.IsBodyResolved(annotation.Body), true
	case "targetSource":
		return annotations.TargetSource(annotation.Target).String(), true
	case "targetSelector":
		if selector == nil {
			return nil, true
		}
		return *selector, true
	case "isHighlight":
		return annotations.IsHighlight(annotation), true
	case "isReference":
		return annotations.IsReference(annotation), true
	case "isAssessment":
		return annotations.IsAssessment(annotation), true
	case "isComment":
		return annotations.IsComment(annotation), true
	case "isTag":
		return annotations.IsTag(annotation), true
	case "commentText":
		return optional(annotations.CommentText(annotation)), true
	case "isStubReference":
		return annotations.IsStubReference(annotation), true
	case "isResolvedReference":
		return annotations.IsResolvedReference(annotation), true
	case "exactText":
		return annotations.ExactText(selector), true
	case "annotationExactText":
		return annotations.AnnotationExactText(annotation), true
	case "textQuoteSelector":
		if selector == nil {
			t.Fatal("the table gives textQuoteSelector no selector to read")
		}
		return optional(annotations.TextQuoteSelector(*selector)), true
	case "entityTypes":
		return annotations.EntityTypes(annotation), true
	case "tagCategory":
		return optional(annotations.TagCategory(annotation)), true
	case "tagSchemaId":
		return optional(annotations.TagSchemaId(annotation)), true
	}
	return nil, false
}

// asJSON is a value as JSON reads it back, so two values compare as the wire
// writes them.
func asJSON(t *testing.T, value any) any {
	t.Helper()
	written, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var back any
	if err := json.Unmarshal(written, &back); err != nil {
		t.Fatal(err)
	}
	return back
}

func TestEveryReaderGivesWhatTheTableSaysOfEveryAnnotation(t *testing.T) {
	var table struct {
		Readers []string `json:"readers"`
		Cases   []struct {
			Why        string                     `json:"why"`
			Annotation json.RawMessage            `json:"annotation"`
			Reads      map[string]json.RawMessage `json:"reads"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(readSpec(t, "annotations/reader-cases.json"), &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 || len(table.Readers) == 0 {
		t.Fatal("the table was not read")
	}
	var empty api.Annotation
	for _, reader := range table.Readers {
		// A reader of a selector is given one, and an annotation with none has none to give it.
		if reader == "textQuoteSelector" {
			continue
		}
		if _, known := read(t, reader, empty); !known {
			t.Errorf("the table names the reader %s, which this runner does not run", reader)
		}
	}
	for _, stated := range table.Cases {
		var annotation api.Annotation
		if err := json.Unmarshal(stated.Annotation, &annotation); err != nil {
			t.Fatalf("%s: the annotation does not decode: %v", stated.Why, err)
		}
		for reader := range stated.Reads {
			if !slices.Contains(table.Readers, reader) {
				t.Errorf("%s: the case states %s, which the table names as no reader", stated.Why, reader)
			}
		}
		for _, reader := range table.Readers {
			expected, said := stated.Reads[reader]
			if !said {
				if reader == "textQuoteSelector" && annotations.TargetSelector(annotation.Target) == nil {
					continue
				}
				t.Errorf("%s: the case does not state %s", stated.Why, reader)
				continue
			}
			answer, _ := read(t, reader, annotation)
			var want any
			if err := json.Unmarshal(expected, &want); err != nil {
				t.Fatal(err)
			}
			if got := asJSON(t, answer); !reflect.DeepEqual(got, want) {
				t.Errorf("%s: %s gives %v, and the table says %v", stated.Why, reader, got, want)
			}
		}
	}
}
