//! Reading an annotation, and building one.
//!
//! An annotation's `target` is a resource's id or an object; its `selector`
//! is one selector or a list; its `body` is absent, one item or a list. The
//! readers read each, so that nothing that reads an annotation narrows those
//! shapes by hand.
//!
//! Every SDK has them, and specs/src/annotations/reader-cases.json holds each
//! to one answer for one annotation: this crate's tests run it.
//!
//! A worker turns what a model said into annotations and commits them. Three
//! functions build one: [`reconcile`] finds the words a model quoted in a
//! text, [`annotation_of_span`] builds the annotation of the span it found,
//! and [`annotation_of_resource`] builds an annotation of a resource as a
//! whole. An offset counts Unicode code points from the start of a text, and
//! a text is given as the `&str` it is: no caller converts one.
//!
//! ```
//! use semiont::annotations::{QuotedText, annotation_of_span, reconcile};
//! use semiont::types::{Agent, AgentSoftware, Motivation, ResourceId};
//!
//! let text = "Ada Lovelace wrote the first algorithm.";
//! let resource_id: ResourceId = "res-1".parse()?;
//! let generator: Agent = AgentSoftware::new("gemma3").into();
//!
//! // The model wrote the name without its capitals. The span is the text's.
//! let found = reconcile(text, &QuotedText::new("ada lovelace")).ok_or("not in the text")?;
//! assert_eq!((found.span.start, found.span.end), (0, 12));
//! assert_eq!(found.span.exact, "Ada Lovelace");
//!
//! let highlight = |span| {
//!     annotation_of_span(
//!         text,
//!         span,
//!         &resource_id,
//!         Motivation::Highlighting,
//!         &generator,
//!         None,
//!     )
//! };
//! // Built again, it has the same id: committing it twice changes nothing.
//! assert_eq!(highlight(&found.span)?.id, highlight(&found.span)?.id);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! Every SDK has the three, and the tables under specs/src/annotations hold
//! each to one answer: reconcile-cases.json where a quote is, and
//! builder-cases.json the annotation built, with id-cases.json for its id
//! and pdf-locate-cases.json for where a span of a PDF is on its pages.

mod id;
mod locate;
mod quote;

use crate::errors::SpanRefusal;
use crate::rfc3339;
use crate::text_offsets::Offsets;
use crate::types::{
    Agent, AnchoredText, Annotation, AnnotationBodies, AnnotationBody, AnnotationGenerator,
    AnnotationSelector, AnnotationTarget, AnnotationTargetType, AnnotationTargetValue, BodyPurpose,
    FragmentSelector, Motivation, PdfTextItem, ResourceId, Selector, TextPositionSelector,
    TextQuoteSelector,
};
use quote::Place;
use std::time::SystemTime;

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

/// What a model quoted of a text: the words, and maybe what it says stands
/// just before and just after them. None of it is trusted. [`reconcile`]
/// finds the words in the text, and the prefix and the suffix only help it
/// choose among several places.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotedText {
    pub exact: String,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
}

impl QuotedText {
    /// The words, with nothing said of what stands around them.
    pub fn new(exact: impl Into<String>) -> Self {
        Self {
            exact: exact.into(),
            prefix: None,
            suffix: None,
        }
    }
}

/// A span of a text: the code points from the offset `start` up to but not
/// including `end`, the words there, and what the text has just before and
/// just after them. An offset counts Unicode code points from the start of
/// the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextSpan {
    pub start: u64,
    pub end: u64,
    pub exact: String,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
}

impl TextSpan {
    /// The span of these words, with nothing said of what stands around
    /// them.
    pub fn new(start: u64, end: u64, exact: impl Into<String>) -> Self {
        Self {
            start,
            end,
            exact: exact.into(),
            prefix: None,
            suffix: None,
        }
    }
}

/// Which looser search found words a text does not have character for
/// character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MatchQuality {
    /// Without regard to white space, or to the forms of quotation marks and
    /// dashes.
    Normalized,
    /// Without regard to letter case.
    CaseInsensitive,
    /// Within a twentieth of the words' length in edits.
    Fuzzy,
}

impl MatchQuality {
    /// The value as the tables spell it.
    pub const fn as_str(&self) -> &'static str {
        match self {
            MatchQuality::Normalized => "normalized",
            MatchQuality::CaseInsensitive => "case-insensitive",
            MatchQuality::Fuzzy => "fuzzy",
        }
    }
}

/// How a quoted span was found in a text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnchorMethod {
    /// The text has the words in exactly one place.
    UniqueMatch,
    /// The text has them in several, and what the model said stands around
    /// them chose this one.
    ContextRecovered,
    /// The text has them in several and nothing chose among them: this is
    /// the first, and may not be the one the model meant.
    FirstOfMany,
    /// The text does not have them character for character, and a looser
    /// search found them.
    FuzzyMatch(MatchQuality),
}

impl AnchorMethod {
    /// The value as the tables spell it.
    pub const fn as_str(&self) -> &'static str {
        match self {
            AnchorMethod::UniqueMatch => "unique-match",
            AnchorMethod::ContextRecovered => "context-recovered",
            AnchorMethod::FirstOfMany => "first-of-many",
            AnchorMethod::FuzzyMatch(_) => "fuzzy-match",
        }
    }
}

/// Where the words a model quoted are in a text, and how they were found.
/// The span is the text's own: its `exact` is what the text has there, never
/// the model's spelling of it, and its `prefix` and `suffix` are what the
/// text has on either side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciledSpan {
    pub span: TextSpan,
    pub anchor_method: AnchorMethod,
}

/// What a prefix or a suffix a model gave says of where its words are: a
/// hint, unless it is empty or only white space.
fn hint(given: Option<&str>) -> Option<&str> {
    given.filter(|given| !given.trim().is_empty())
}

/// How many code points on one side of a place a hint is looked for in: as
/// many as the hint has, and at least 32.
fn window(hint: &str) -> usize {
    hint.chars().count().max(32)
}

/// Finds the words a model quoted in a text. `None` when the text does not
/// have them, however they are looked for, and when `exact` is empty or only
/// white space.
///
/// The text is searched for `exact` character for character. In exactly one
/// place, that is the span. In several, the span is the first place that
/// fits every hint given: one whose text just before ends with the prefix,
/// or has the prefix, trimmed, among the code points before it, and the same
/// of the suffix after it. With no hint, or no place that fits, it is the
/// first place. In no place at all, three looser searches are tried in turn
/// ([`MatchQuality`]), and the hints choose among what the first to find
/// anything finds.
pub fn reconcile(text: &str, quoted: &QuotedText) -> Option<ReconciledSpan> {
    // Nothing, or only white space, is no words to find.
    if quoted.exact.trim().is_empty() {
        return None;
    }
    let offsets = Offsets::of(text);
    let (prefix, suffix) = (
        hint(quoted.prefix.as_deref()),
        hint(quoted.suffix.as_deref()),
    );

    let fits = |place: &Place| {
        let before =
            |prefix: &str| offsets.between(place.start.saturating_sub(window(prefix)), place.start);
        let after = |suffix: &str| {
            offsets.between(place.end, (place.end + window(suffix)).min(offsets.len()))
        };
        prefix.is_none_or(|prefix| {
            before(prefix)
                .is_some_and(|before| before.ends_with(prefix) || before.contains(prefix.trim()))
        }) && suffix.is_none_or(|suffix| {
            after(suffix)
                .is_some_and(|after| after.starts_with(suffix) || after.contains(suffix.trim()))
        })
    };
    // The first of several places that the hints pick: none when no hint was
    // given, or no place fits.
    let hinted = |places: &[Place]| {
        places
            .iter()
            .find(|&place| (prefix.is_some() || suffix.is_some()) && fits(place))
            .copied()
    };

    let places = quote::places_of(&offsets, &quoted.exact);
    let (place, anchor_method) = match places.as_slice() {
        [only] => (*only, AnchorMethod::UniqueMatch),
        [first, ..] => match hinted(&places) {
            Some(chosen) => (chosen, AnchorMethod::ContextRecovered),
            None => (*first, AnchorMethod::FirstOfMany),
        },
        [] => {
            let (places, quality) = quote::places_like(text, &quoted.exact)?;
            let place = hinted(&places).or_else(|| places.first().copied())?;
            (place, AnchorMethod::FuzzyMatch(quality))
        }
    };

    let (prefix, suffix) = quote::context_of(&offsets, place);
    Some(ReconciledSpan {
        span: TextSpan {
            start: place.start as u64,
            end: place.end as u64,
            exact: offsets.between(place.start, place.end)?.to_owned(),
            prefix: prefix.map(str::to_owned),
            suffix: suffix.map(str::to_owned),
        },
        anchor_method,
    })
}

/// What a span is a span of: a text, or a PDF's anchored text. A `&str` and
/// an `&AnchoredText` each convert into it, so a caller of
/// [`annotation_of_span`] hands over the one it has.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Spanned<'a> {
    /// A resource that is a text. Its annotation states the span's offsets.
    Text(&'a str),
    /// A PDF, as the text read from it and where each run of that text is on
    /// its pages. Its annotation states a rectangle for each line the span
    /// touches, and no offsets.
    Pdf(&'a AnchoredText),
}

impl<'a> From<&'a str> for Spanned<'a> {
    fn from(text: &'a str) -> Self {
        Spanned::Text(text)
    }
}

impl<'a> From<&'a String> for Spanned<'a> {
    fn from(text: &'a String) -> Self {
        Spanned::Text(text)
    }
}

impl<'a> From<&'a AnchoredText> for Spanned<'a> {
    fn from(anchored: &'a AnchoredText) -> Self {
        Spanned::Pdf(anchored)
    }
}

/// The fragment syntax a PDF's rectangles are written in.
const RFC_3778: &str = "http://tools.ietf.org/rfc/rfc3778";

/// A text with every run of white space made one space, and none at either
/// end.
fn spaced_once(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The selectors that say where on a PDF's pages a span is: a fragment for
/// each rectangle, in their order. The span must be somewhere on a page, and
/// its `exact` must be in the covered text: the anchored text from the least
/// `start` to the greatest `end` of the items the span overlaps, each with
/// every run of white space made one space.
fn fragments(
    anchored: &AnchoredText,
    offsets: &Offsets<'_>,
    span: &TextSpan,
) -> Result<Vec<Selector>, SpanRefusal> {
    let located = locate::locate(anchored, span.start, span.end);
    if located.rects.is_empty() {
        return Err(SpanRefusal::NothingLocated);
    }
    let from = located.overlapping.iter().map(|item| item.start).min();
    let to = located.overlapping.iter().map(|item| item.end).max();
    let covered = from.zip(to).and_then(|(from, to)| {
        offsets.between(usize::try_from(from).ok()?, usize::try_from(to).ok()?)
    });
    if !covered.is_some_and(|covered| spaced_once(covered).contains(&spaced_once(&span.exact))) {
        return Err(SpanRefusal::ExactNotCovered);
    }
    Ok(located
        .rects
        .iter()
        .map(|rect| {
            Selector::from(FragmentSelector {
                conforms_to: Some(RFC_3778.to_owned()),
                ..FragmentSelector::new(rect.fragment())
            })
        })
        .collect())
}

/// An annotation of `motivation` on a resource, built now: its id derived
/// from what it is, and its body and generator as given.
fn annotation(
    target: AnnotationTarget,
    motivation: Motivation,
    anchor: &str,
    generator: Option<&Agent>,
    body: Option<AnnotationBodies>,
) -> Annotation {
    let id = id::annotation_id(&target.source, motivation, anchor, body.as_ref());
    Annotation {
        body,
        generator: generator.cloned().map(AnnotationGenerator::Agent),
        ..Annotation::new(
            id,
            motivation,
            target.into(),
            rfc3339::to_the_millisecond(SystemTime::now()),
        )
    }
}

/// Builds the annotation of a span of a text, or of a PDF's anchored text:
/// its selectors, its id, and the body and the generator as given. What is
/// spanned is handed over as it is: the text as a `&str`, or a PDF's
/// `&AnchoredText`.
///
/// A span that is not the text's is refused, and the first check that fails
/// is the refusal: a [`SpanRefusal`], whose codes are the spec's
/// (specs/src/errors/codes.json). For a PDF, every item of the anchored text
/// must be a stretch of that text, or no span of it is built. The span's
/// offsets must be a span of the text.
/// For a text, the text between them must be the span's `exact`. For a PDF,
/// the span must be somewhere on a page, and its `exact` in the text of the
/// items it overlaps. Then a prefix given must be the text just before the
/// span, as many code points of it as the prefix has or all there are if
/// fewer, and a suffix the text just after it.
///
/// The selectors of a text's span are its position and its quote, and those
/// of a PDF's are a fragment for each line of each page it touches and its
/// quote. The id is derived from the resource, the motivation, the body and
/// the span's offsets and words, so the same span built again has the same
/// id. `created` is the moment it is built.
pub fn annotation_of_span<'a>(
    spanned: impl Into<Spanned<'a>>,
    span: &TextSpan,
    resource_id: &ResourceId,
    motivation: Motivation,
    generator: &Agent,
    body: Option<AnnotationBodies>,
) -> Result<Annotation, SpanRefusal> {
    let spanned = spanned.into();
    let text = match spanned {
        Spanned::Text(text) => text,
        Spanned::Pdf(anchored) => anchored.text.as_str(),
    };
    let offsets = Offsets::of(text);
    // A PDF's anchored text is held to itself before the span is held to it.
    // Its items are what say where the text is on a page, and a rectangle is
    // made from an item's own offsets, so one that is no stretch of the text
    // refuses every span of it, whether this span touches that item or not.
    if let Spanned::Pdf(anchored) = spanned {
        let is_a_stretch = |item: &PdfTextItem| {
            item.start <= item.end
                && usize::try_from(item.end).is_ok_and(|end| end <= offsets.len())
        };
        if !anchored.items.iter().all(is_a_stretch) {
            return Err(SpanRefusal::ItemOutOfRange);
        }
    }
    let (start, end) = match (usize::try_from(span.start), usize::try_from(span.end)) {
        (Ok(start), Ok(end)) if start <= end && end <= offsets.len() => (start, end),
        _ => return Err(SpanRefusal::SpanOutOfRange),
    };

    let mut selectors = match spanned {
        Spanned::Text(_) => {
            if offsets.between(start, end) != Some(span.exact.as_str()) {
                return Err(SpanRefusal::ExactMismatch);
            }
            vec![Selector::from(TextPositionSelector::new(
                span.start, span.end,
            ))]
        }
        Spanned::Pdf(anchored) => fragments(anchored, &offsets, span)?,
    };
    if let Some(prefix) = &span.prefix {
        let from = start.saturating_sub(prefix.chars().count());
        if offsets.between(from, start) != Some(prefix.as_str()) {
            return Err(SpanRefusal::PrefixMismatch);
        }
    }
    if let Some(suffix) = &span.suffix {
        let to = (end + suffix.chars().count()).min(offsets.len());
        if offsets.between(end, to) != Some(suffix.as_str()) {
            return Err(SpanRefusal::SuffixMismatch);
        }
    }

    // The quote is the last selector, with the span's context where it has
    // any.
    let stated = |context: &Option<String>| context.clone().filter(|context| !context.is_empty());
    selectors.push(Selector::from(TextQuoteSelector {
        prefix: stated(&span.prefix),
        suffix: stated(&span.suffix),
        ..TextQuoteSelector::new(span.exact.as_str())
    }));
    // The target of a span says that it is a part of its source.
    let target = AnnotationTarget {
        r#type: Some(AnnotationTargetType::SpecificResource),
        selector: Some(AnnotationSelector::List(selectors)),
        ..AnnotationTarget::new(resource_id.clone())
    };
    // Where on the resource the annotation is, as its id has it.
    let anchor = format!("{}:{}:{}", span.start, span.end, span.exact);
    Ok(annotation(
        target,
        motivation,
        &anchor,
        Some(generator),
        body,
    ))
}

/// Builds an annotation of a resource as a whole, with no selector: the link
/// from a source to what was generated from it is one. Its target names the
/// resource and states nothing else, and its id is derived from the
/// resource, the motivation and the body. `created` is the moment it is
/// built.
pub fn annotation_of_resource(
    resource_id: &ResourceId,
    motivation: Motivation,
    generator: Option<&Agent>,
    body: Option<AnnotationBodies>,
) -> Annotation {
    // An annotation of a resource as a whole is nowhere on it.
    annotation(
        AnnotationTarget::new(resource_id.clone()),
        motivation,
        "",
        generator,
        body,
    )
}
