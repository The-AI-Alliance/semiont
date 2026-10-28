// Package annotations reads an annotation, and builds one.
//
// An annotation's target is a resource's id or an object; its selector is
// one selector or a list; its body is absent, one item or a list. The
// readers read each, so that nothing that reads an annotation narrows those
// shapes by hand. A body item and a selector are told apart by their `type`,
// which the protocol requires on each and gives one value.
//
// The builders make the annotations a worker commits. Reconcile finds the
// words a model quoted in a text, AnnotationOfSpan builds the annotation of
// the span it found, and AnnotationOfResource builds one of a resource as a
// whole. An annotation built here has the id every SDK gives it, so building
// it again, in any language, writes nothing new.
//
// Every SDK has the readers and the builders. The case tables in
// specs/src/annotations hold each to one answer (reader-cases.json,
// reconcile-cases.json, builder-cases.json), and this package's tests run
// them.
package annotations

import (
	"bytes"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// listed is whether raw is a JSON array: a union of one item or a list of
// them is a list when it is one.
func listed(raw []byte) bool {
	return bytes.HasPrefix(bytes.TrimLeft(raw, " \t\r\n"), []byte("["))
}

// items is a body's items: none when there is no body, the one when it is a
// single item, each when it is a list.
func items(body *api.AnnotationBodies) []api.AnnotationBody {
	if body == nil {
		return nil
	}
	raw, err := body.MarshalJSON()
	if err != nil {
		return nil
	}
	if listed(raw) {
		list, err := body.AsAnnotationBodies1()
		if err != nil {
			return nil
		}
		return list
	}
	one, err := body.AsAnnotationBody()
	if err != nil {
		return nil
	}
	return []api.AnnotationBody{one}
}

// selectors is a selector's items: the one when it is a single selector,
// each when it is a list.
func selectors(selector api.AnnotationSelector) []api.Selector {
	raw, err := selector.MarshalJSON()
	if err != nil {
		return nil
	}
	if listed(raw) {
		list, err := selector.AsAnnotationSelector1()
		if err != nil {
			return nil
		}
		return list
	}
	one, err := selector.AsSelector()
	if err != nil {
		return nil
	}
	return []api.Selector{one}
}

// BodySource is the resource a body links to: the first resource it names,
// which is the link the graph draws. False for a body that names none.
func BodySource(body *api.AnnotationBodies) (api.ResourceId, bool) {
	for _, item := range items(body) {
		if linked, ok := valueOf(item).(api.SpecificResource); ok {
			return linked.Source, true
		}
	}
	return api.ResourceId{}, false
}

// IsBodyResolved is whether a body links to a resource.
func IsBodyResolved(body *api.AnnotationBodies) bool {
	_, ok := BodySource(body)
	return ok
}

// TargetSource is the resource a target names, whether the target is that
// resource's id or an object that states it.
func TargetSource(target api.Annotation_Target) api.ResourceId {
	if object, ok := targetObject(target); ok {
		return object.Source
	}
	id, _ := target.AsResourceId()
	return id
}

// TargetSelector is a target's selector: one, or a list. Nil for a target
// that is only a resource's id, and for one that states no selector.
func TargetSelector(target api.Annotation_Target) *api.AnnotationSelector {
	if object, ok := targetObject(target); ok {
		return object.Selector
	}
	return nil
}

// targetObject is a target that is an object, not a resource's id.
func targetObject(target api.Annotation_Target) (api.AnnotationTarget, bool) {
	raw, err := target.MarshalJSON()
	if err != nil || !bytes.HasPrefix(bytes.TrimLeft(raw, " \t\r\n"), []byte("{")) {
		return api.AnnotationTarget{}, false
	}
	object, err := target.AsAnnotationTarget()
	return object, err == nil
}

// IsHighlight is whether an annotation is a highlight.
func IsHighlight(annotation api.Annotation) bool {
	return annotation.Motivation == api.MotivationHighlighting
}

// IsReference is whether an annotation is a reference: its motivation is
// linking.
func IsReference(annotation api.Annotation) bool {
	return annotation.Motivation == api.MotivationLinking
}

// IsAssessment is whether an annotation is an assessment.
func IsAssessment(annotation api.Annotation) bool {
	return annotation.Motivation == api.MotivationAssessing
}

// IsComment is whether an annotation is a comment.
func IsComment(annotation api.Annotation) bool {
	return annotation.Motivation == api.MotivationCommenting
}

// IsTag is whether an annotation is a tag.
func IsTag(annotation api.Annotation) bool {
	return annotation.Motivation == api.MotivationTagging
}

// CommentText is a comment's text: that of its body's first item. False for
// an annotation that is not a comment, and for a comment whose first item is
// not text.
func CommentText(annotation api.Annotation) (string, bool) {
	if !IsComment(annotation) {
		return "", false
	}
	body := items(annotation.Body)
	if len(body) == 0 {
		return "", false
	}
	text, ok := valueOf(body[0]).(api.TextualBody)
	return text.Value, ok
}

// IsStubReference is whether an annotation is a reference that links to
// nothing yet.
func IsStubReference(annotation api.Annotation) bool {
	return IsReference(annotation) && !IsBodyResolved(annotation.Body)
}

// IsResolvedReference is whether an annotation is a reference that links to
// a resource.
func IsResolvedReference(annotation api.Annotation) bool {
	return IsReference(annotation) && IsBodyResolved(annotation.Body)
}

// TextQuoteSelector is the quote selector among a selector's items: the
// first, wherever in a list it is. False for a selector that quotes nothing.
func TextQuoteSelector(selector api.AnnotationSelector) (api.TextQuoteSelector, bool) {
	for _, item := range selectors(selector) {
		if kind, err := item.Discriminator(); err == nil && kind == "TextQuoteSelector" {
			quote, err := item.AsTextQuoteSelector()
			if err == nil {
				return quote, true
			}
		}
	}
	return api.TextQuoteSelector{}, false
}

// ExactText is the text a selector quotes: its quote selector's exact text.
// Empty for a selector that quotes nothing, and for no selector at all.
func ExactText(selector *api.AnnotationSelector) string {
	if selector == nil {
		return ""
	}
	quote, _ := TextQuoteSelector(*selector)
	return quote.Exact
}

// AnnotationExactText is the text an annotation quotes: that of its
// target's selector.
func AnnotationExactText(annotation api.Annotation) string {
	return ExactText(TargetSelector(annotation.Target))
}

// textsFor is the text of each body item that states it for purpose, in the
// order its body has them.
func textsFor(annotation api.Annotation, purpose api.BodyPurpose) []string {
	var texts []string
	for _, item := range items(annotation.Body) {
		if text, ok := valueOf(item).(api.TextualBody); ok && text.Purpose != nil && *text.Purpose == purpose {
			texts = append(texts, text.Value)
		}
	}
	return texts
}

// EntityTypes is the entity types an annotation states: the text of each
// body item that tags, in the order its body has them. An item with no text
// states none; an annotation that states none has an empty list.
func EntityTypes(annotation api.Annotation) []string {
	types := []string{}
	for _, text := range textsFor(annotation, api.BodyPurposeTagging) {
		if text != "" {
			types = append(types, text)
		}
	}
	return types
}

// TagCategory is a tag's category: the text of its body item that tags.
// False for an annotation that is not a tag, and for a tag with no such item.
func TagCategory(annotation api.Annotation) (string, bool) {
	return firstFor(annotation, api.BodyPurposeTagging)
}

// TagSchemaId is the id of the schema a tag's category is of: the text of
// its body item that classifies. False for an annotation that is not a tag,
// and for a tag with no such item.
func TagSchemaId(annotation api.Annotation) (string, bool) {
	return firstFor(annotation, api.BodyPurposeClassifying)
}

// firstFor is the text of a tag's first body item for purpose.
func firstFor(annotation api.Annotation, purpose api.BodyPurpose) (string, bool) {
	if !IsTag(annotation) {
		return "", false
	}
	texts := textsFor(annotation, purpose)
	if len(texts) == 0 {
		return "", false
	}
	return texts[0], true
}

// valueOf is a body item as its `type` says it is: an api.TextualBody or an
// api.SpecificResource, or nil for an item of no type the protocol names.
func valueOf(item api.AnnotationBody) any {
	value, err := item.ValueByDiscriminator()
	if err != nil {
		return nil
	}
	return value
}
