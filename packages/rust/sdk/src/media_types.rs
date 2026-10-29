//! The media types a knowledge base admits and what the system can do with
//! each, as specs/src/media-types/registry.json states them, and the rules
//! read from that table, which specs/src/media-types/cases.json holds in
//! every SDK: the format a clone takes, the name content is stored under,
//! and where a type's text comes from, with whether that text has places on
//! a page and whether it is derived.

/// What the system can do with one media type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaTypeCapabilities {
    pub media_type: &'static str,
    /// The extension a stored name takes, with its dot.
    pub extension: &'static str,
    /// The name a person is shown.
    pub label: &'static str,
    pub render: RenderMode,
    pub anchoring: AnchoringModel,
    pub text_source: TextSource,
    /// Offered where a person writes a resource.
    pub authorable: bool,
    pub uploadable: bool,
    /// The generation worker can produce it.
    pub generatable: bool,
}

include!(concat!(env!("OUT_DIR"), "/media_types.rs"));

/// A format without its parameters (`; charset=…`), in lower case.
pub fn base_media_type(format: &str) -> String {
    format
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

/// The registry's row for `format`, whose parameters are not read. A stored
/// type may be one the registry does not have: what was imported keeps the
/// type it came with.
pub fn capabilities_of(format: &str) -> Option<&'static MediaTypeCapabilities> {
    let base = base_media_type(format);
    MEDIA_TYPES.iter().find(|row| row.media_type == base)
}

/// Where a format's text comes from. The registry's row says. A format the
/// registry does not have is decoded when its type is `text/`, since the
/// bytes of every such type are text, and has no text otherwise.
///
/// The three answers are three things done, not more and less of one. To
/// decode is to read the bytes in their charset, which whoever holds them
/// may do (`resources::decode_representation`). To read a PDF's text layer,
/// and to recognize the characters of a page that has none, is long work
/// whose answer may change with the version of what does it: the Smelter
/// does it once, and keeps the answer as the resource's anchored text.
pub fn text_source_of(format: &str) -> TextSource {
    match capabilities_of(format) {
        Some(row) => row.text_source,
        None if base_media_type(format).starts_with("text/") => TextSource::Decode,
        None => TextSource::None,
    }
}

/// Whether a format's text has places on a page: the positioned runs an
/// anchored text is made of, where a decoded text is only its characters.
/// It says whether a resource of the format has an anchored text at all,
/// and whether an annotation of it is anchored by where it is on a page.
///
/// The answer is read from the text source and stated for every one, with
/// no arm for the rest: a source added to the registry does not build here
/// until someone says which side it is on. A format the registry does not
/// have is answered as `text_source_of` answers it, and so has none.
pub fn yields_geometry_of(format: &str) -> bool {
    match text_source_of(format) {
        TextSource::PdfTextLayer => true,
        TextSource::Decode | TextSource::None => false,
    }
}

/// Whether a format's text is derived by reading its bytes, and kept as the
/// resource's anchored text, where a decoded text is the bytes themselves in
/// their charset. A reader of text asks this to know which to read:
/// `browse.resource_anchored_text` gives a derived text, and
/// `resources::decode_representation` a decoded one, refusing every other.
///
/// It is another question than `yields_geometry_of`, though no text source
/// yet answers the two differently: a transcript of a recording would be
/// derived and have no places on a page. Like it, the answer is stated for
/// every text source, with no arm for the rest.
pub fn derives_text_of(format: &str) -> bool {
    match text_source_of(format) {
        TextSource::PdfTextLayer => true,
        TextSource::Decode | TextSource::None => false,
    }
}

/// The format a clone of a resource takes: its source's, when that is one a
/// person can author, and plain text otherwise. A clone opens where a person
/// writes.
pub fn clone_format(source: Option<&str>) -> &'static MediaTypeCapabilities {
    source
        .and_then(capabilities_of)
        .filter(|row| row.authorable)
        .unwrap_or(&PLAIN_TEXT)
}

/// The name a resource's content is stored under: its title in lower case,
/// every run of characters that are not a to z or 0 to 9 made one hyphen,
/// none at either end, and then the format's extension.
pub fn storage_file_name(name: &str, format: &MediaTypeCapabilities) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.strip_prefix('-').unwrap_or(&slug);
    let slug = slug.strip_suffix('-').unwrap_or(slug);
    format!("{slug}{}", format.extension)
}

/// The `file://` URI of `storage_file_name`: where the content is stored, at
/// the root of the working tree.
pub fn derive_storage_uri(name: &str, format: &MediaTypeCapabilities) -> String {
    format!("file://{}", storage_file_name(name, format))
}
