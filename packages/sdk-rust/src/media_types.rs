//! The media types a knowledge base admits and what the system can do with
//! each, as specs/src/media-types/registry.json states them, and the rules
//! read from that table, which specs/src/media-types/cases.json holds in
//! every SDK: the format a clone takes, and the name content is stored under.

use crate::types::{ResourceDescriptor, ResourceDescriptorRepresentations};

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

/// The media type of a resource's first representation.
pub fn primary_media_type(resource: &ResourceDescriptor) -> Option<&str> {
    match &resource.representations {
        ResourceDescriptorRepresentations::Representation(only) => Some(&only.media_type),
        ResourceDescriptorRepresentations::List(several) => {
            several.first().map(|first| first.media_type.as_str())
        }
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
