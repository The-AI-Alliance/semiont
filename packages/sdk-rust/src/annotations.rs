//! Reading an annotation.
//!
//! An annotation's `target` is a resource's id or an object; its `selector`
//! is one selector or a list; its `body` is absent, one item or a list. These
//! functions read each, so that nothing that reads an annotation narrows
//! those shapes by hand.
//!
//! Every SDK has them, and specs/src/annotations/reader-cases.json holds each
//! to one answer for one annotation: this crate's tests run it.

use crate::types::{
    Annotation, AnnotationBodies, AnnotationBody, AnnotationSelector, AnnotationTargetValue,
    BodyPurpose, Motivation, ResourceId, Selector, TextQuoteSelector,
};

/// A body's items: none when there is no body, the one when it is a single
/// item, each when it is a list.
fn items(body: Option<&AnnotationBodies>) -> &[AnnotationBody] {
    match body {
        None => &[],
        Some(AnnotationBodies::AnnotationBody(one)) => std::slice::from_ref(one),
        Some(AnnotationBodies::List(several)) => several,
    }
}

/// A selector's items: the one when it is a single selector, each when it is
/// a list.
fn selectors(selector: &AnnotationSelector) -> &[Selector] {
    match selector {
        AnnotationSelector::Selector(one) => std::slice::from_ref(one),
        AnnotationSelector::List(several) => several,
    }
}

/// The resource a body links to: the first resource it names, which is the
/// link the graph draws. `None` for a body that names none.
pub fn body_source(body: Option<&AnnotationBodies>) -> Option<&ResourceId> {
    items(body).iter().find_map(|item| match item {
        AnnotationBody::SpecificResource(resource) => Some(&resource.source),
        AnnotationBody::TextualBody(_) => None,
    })
}

/// Whether a body links to a resource.
pub fn is_body_resolved(body: Option<&AnnotationBodies>) -> bool {
    body_source(body).is_some()
}

/// The resource a target names, whether the target is that resource's id or
/// an object that states it.
pub fn target_source(target: &AnnotationTargetValue) -> &ResourceId {
    match target {
        AnnotationTargetValue::ResourceId(resource) => resource,
        AnnotationTargetValue::AnnotationTarget(target) => &target.source,
    }
}

/// A target's selector: one, or a list. `None` for a target that is only a
/// resource's id, and for one that states no selector: the whole resource.
pub fn target_selector(target: &AnnotationTargetValue) -> Option<&AnnotationSelector> {
    match target {
        AnnotationTargetValue::ResourceId(_) => None,
        AnnotationTargetValue::AnnotationTarget(target) => target.selector.as_ref(),
    }
}

/// Whether an annotation is a highlight.
pub fn is_highlight(annotation: &Annotation) -> bool {
    annotation.motivation == Motivation::Highlighting
}

/// Whether an annotation is a reference: its motivation is linking.
pub fn is_reference(annotation: &Annotation) -> bool {
    annotation.motivation == Motivation::Linking
}

/// Whether an annotation is an assessment.
pub fn is_assessment(annotation: &Annotation) -> bool {
    annotation.motivation == Motivation::Assessing
}

/// Whether an annotation is a comment.
pub fn is_comment(annotation: &Annotation) -> bool {
    annotation.motivation == Motivation::Commenting
}

/// Whether an annotation is a tag.
pub fn is_tag(annotation: &Annotation) -> bool {
    annotation.motivation == Motivation::Tagging
}

/// A comment's text: that of its body's first item. `None` for an annotation
/// that is not a comment, and for a comment whose first item is not text.
pub fn comment_text(annotation: &Annotation) -> Option<&str> {
    if !is_comment(annotation) {
        return None;
    }
    match items(annotation.body.as_ref()).first()? {
        AnnotationBody::TextualBody(text) => Some(&text.value),
        AnnotationBody::SpecificResource(_) => None,
    }
}

/// Whether an annotation is a reference that links to nothing yet.
pub fn is_stub_reference(annotation: &Annotation) -> bool {
    is_reference(annotation) && !is_body_resolved(annotation.body.as_ref())
}

/// Whether an annotation is a reference that links to a resource.
pub fn is_resolved_reference(annotation: &Annotation) -> bool {
    is_reference(annotation) && is_body_resolved(annotation.body.as_ref())
}

/// The quote selector among a selector's items: the first, wherever in a
/// list it is. `None` for a selector that quotes nothing.
pub fn text_quote_selector(selector: &AnnotationSelector) -> Option<&TextQuoteSelector> {
    selectors(selector).iter().find_map(|item| match item {
        Selector::TextQuoteSelector(quote) => Some(quote),
        _ => None,
    })
}

/// The text a selector quotes: its quote selector's exact text. Empty for a
/// selector that quotes nothing, and for no selector at all.
pub fn exact_text(selector: Option<&AnnotationSelector>) -> &str {
    selector
        .and_then(text_quote_selector)
        .map_or("", |quote| quote.exact.as_str())
}

/// The text an annotation quotes: that of its target's selector.
pub fn annotation_exact_text(annotation: &Annotation) -> &str {
    exact_text(target_selector(&annotation.target))
}

/// The text of each body item that states it for `purpose`.
fn texts_for(annotation: &Annotation, purpose: BodyPurpose) -> impl Iterator<Item = &str> {
    items(annotation.body.as_ref())
        .iter()
        .filter_map(move |item| match item {
            AnnotationBody::TextualBody(text) if text.purpose == Some(purpose) => {
                Some(text.value.as_str())
            }
            _ => None,
        })
}

/// The entity types an annotation states: the text of each body item that
/// tags, in the order its body has them. An item with no text states none.
pub fn entity_types(annotation: &Annotation) -> Vec<&str> {
    texts_for(annotation, BodyPurpose::Tagging)
        .filter(|text| !text.is_empty())
        .collect()
}

/// A tag's category: the text of its body item that tags. `None` for an
/// annotation that is not a tag.
pub fn tag_category(annotation: &Annotation) -> Option<&str> {
    if is_tag(annotation) {
        texts_for(annotation, BodyPurpose::Tagging).next()
    } else {
        None
    }
}

/// The id of the schema a tag's category is of: the text of its body item
/// that classifies. `None` for an annotation that is not a tag.
pub fn tag_schema_id(annotation: &Annotation) -> Option<&str> {
    if is_tag(annotation) {
        texts_for(annotation, BodyPurpose::Classifying).next()
    } else {
        None
    }
}
