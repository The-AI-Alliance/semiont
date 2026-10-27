//! Reading a resource: what its description states, and its bytes as text.
//!
//! A resource's `representations` is one representation or a list, and it
//! may state no entity types. [`primary_representation`],
//! [`primary_media_type`] and [`resource_entity_types`] read each, so that
//! nothing that reads a resource's description tells one shape from the
//! other by hand. Every SDK has them, and
//! specs/src/resources/reader-cases.json holds each to one answer for one
//! resource: this crate's tests run it.
//!
//! [`decode_representation`] gives a representation's bytes as the text they
//! are, by the rule every reader of a resource's text keeps
//! (docs/protocol/W3C-SELECTORS.md, "The text of a resource"). It is what
//! `browse.resource_content` reads with, and an offset counts the code
//! points of the text it gives. It reads the bytes of a media type whose
//! text they are and refuses any other by name: a PDF's text is derived by
//! reading its bytes, and an image has none. Without the `charsets` feature
//! it decodes UTF-8 alone.

use crate::errors::{TransportError, TransportErrorCode};
use crate::media_types::{TextSource, base_media_type, derives_text_of, text_source_of};
use crate::types::{Representation, ResourceDescriptor, ResourceDescriptorRepresentations};

/// A resource's first representation: the one it has, or the first of its
/// list. `None` for a resource whose list is empty.
pub fn primary_representation(resource: &ResourceDescriptor) -> Option<&Representation> {
    match &resource.representations {
        ResourceDescriptorRepresentations::Representation(only) => Some(only),
        ResourceDescriptorRepresentations::List(several) => several.first(),
    }
}

/// The media type of a resource's first representation.
pub fn primary_media_type(resource: &ResourceDescriptor) -> Option<&str> {
    primary_representation(resource).map(|first| first.media_type.as_str())
}

/// The entity types a resource states, in its order: none for a resource
/// that states none.
pub fn resource_entity_types(resource: &ResourceDescriptor) -> &[String] {
    resource.entity_types.as_deref().unwrap_or_default()
}

/// HTTP white space: line feed, carriage return, tab and space.
const HTTP_WHITE_SPACE: [char; 4] = ['\n', '\r', '\t', ' '];

/// An HTTP token: what a type, a subtype and a parameter's name are made of.
fn is_http_token(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// What a parameter's value may hold: a tab, U+0020 to U+007E, and U+0080 to
/// U+00FF.
fn is_of_a_parameter_value(c: char) -> bool {
    c == '\t' || (' '..='~').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c)
}

/// The quoted string that opens at `start`, without its quotation marks, and
/// where it ends.
fn quoted_string(input: &[char], start: usize) -> (String, usize) {
    let mut position = start + 1;
    let mut value = String::new();
    loop {
        while position < input.len() && input[position] != '"' && input[position] != '\\' {
            value.push(input[position]);
            position += 1;
        }
        if position >= input.len() {
            break;
        }
        let mark = input[position];
        position += 1;
        if mark == '"' {
            break;
        }
        // A backslash gives the character after it, and at the very end is
        // itself.
        if position >= input.len() {
            value.push('\\');
            break;
        }
        value.push(input[position]);
        position += 1;
    }
    (value, position)
}

/// The value of a content type's `charset` parameter, as the MIME Sniffing
/// Standard parses a MIME type: the first parameter of that name that is
/// one. None where there is none, and where the content type is no MIME
/// type.
fn charset(content_type: &str) -> Option<String> {
    let input: Vec<char> = content_type
        .trim_matches(HTTP_WHITE_SPACE)
        .chars()
        .collect();
    let slash = input.iter().position(|&c| c == '/')?;
    if !is_http_token(&input[..slash].iter().collect::<String>()) {
        return None;
    }
    let mut position = input[slash..]
        .iter()
        .position(|&c| c == ';')
        .map_or(input.len(), |at| slash + at);
    let subtype: String = input[slash + 1..position].iter().collect();
    if !is_http_token(subtype.trim_end_matches(HTTP_WHITE_SPACE)) {
        return None;
    }
    while position < input.len() {
        position += 1; // past the semicolon
        while position < input.len() && HTTP_WHITE_SPACE.contains(&input[position]) {
            position += 1;
        }
        let name_start = position;
        while position < input.len() && input[position] != ';' && input[position] != '=' {
            position += 1;
        }
        let name = input[name_start..position]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        if position < input.len() {
            if input[position] == ';' {
                continue;
            }
            position += 1; // past the equals sign
        }
        if position >= input.len() {
            break;
        }
        let value = if input[position] == '"' {
            let (value, end) = quoted_string(&input, position);
            position = end;
            while position < input.len() && input[position] != ';' {
                position += 1;
            }
            value
        } else {
            let value_start = position;
            while position < input.len() && input[position] != ';' {
                position += 1;
            }
            let value: String = input[value_start..position].iter().collect();
            let value = value.trim_end_matches(HTTP_WHITE_SPACE);
            if value.is_empty() {
                continue;
            }
            value.to_owned()
        };
        if name == "charset" && value.chars().all(is_of_a_parameter_value) {
            return Some(value);
        }
    }
    None
}

/// The failure a reader of a resource's text refuses with: a transport's,
/// whose code is `error`.
fn refusal(message: String) -> TransportError {
    TransportError::without_response(message, TransportErrorCode::Error)
}

/// Whether a media type's bytes are its text, and the refusal that says so
/// where they are not. A type whose text is derived by reading its bytes (a
/// PDF) has that text as the resource's anchored text, and a type with no
/// text (an image) has none to read: decoding either gives a text the
/// resource never had. The refusal names the media type, which is the
/// content type without its parameters and in lower case. The rules are
/// `media_types`'s, so a text source added to the registry is on one side
/// here once it is on one side there.
fn bytes_are_text(media_type: &str) -> Result<(), String> {
    let source = text_source_of(media_type);
    let named = base_media_type(media_type);
    let word = source.as_str();
    if derives_text_of(media_type) {
        Err(format!(
            "The bytes of media type `{named}` are not its text, which is derived by reading them (text source `{word}`): read the resource's anchored text instead"
        ))
    } else if source == TextSource::None {
        Err(format!(
            "The bytes of media type `{named}` are not text, and the type has none (text source `{word}`): read its bytes instead"
        ))
    } else {
        Ok(())
    }
}

/// A representation's bytes as the text they are, for a media type whose
/// bytes are its text, by the rule every reader of a resource's text keeps
/// (docs/protocol/W3C-SELECTORS.md, "The text of a resource"): the MIME
/// Sniffing Standard's reading of the content type and the Encoding
/// Standard's reading of the bytes, as a browser follows the two.
/// `media_type` is the content type the bytes came with, parameters and all.
///
/// The media type is read first: the content type without its parameters,
/// in lower case. One whose text is not its bytes is refused, whatever
/// charset was stated and whatever the bytes are: a type whose text is
/// derived by reading them (a PDF), and a type with no text (an image). A
/// `text/` type the registry does not have is text.
///
/// The charset is the one the content type states, UTF-8 when it states
/// none or an empty one, and is a label of the Encoding Standard: any other
/// is refused, whatever the bytes are. Bytes that begin with the byte-order
/// mark of UTF-8, UTF-16BE or UTF-16LE are in that encoding, whatever was
/// stated, and the mark is not part of the text. What the encoding does not
/// have is U+FFFD. A refusal names the media type or the charset: nothing is
/// read as something it is not, and the bytes are there to read
/// (`browse.resource_representation`).
pub fn decode_representation(bytes: &[u8], media_type: &str) -> Result<String, TransportError> {
    bytes_are_text(media_type).map_err(refusal)?;
    let stated = charset(media_type).filter(|label| !label.is_empty());
    #[cfg(feature = "charsets")]
    let read = every_charset(stated.as_deref(), bytes);
    #[cfg(not(feature = "charsets"))]
    let read = utf8_alone(stated.as_deref(), bytes);
    read.map_err(|not_decoded| {
        refusal(format!(
            "The resource's text is {not_decoded}: read its bytes instead"
        ))
    })
}

/// Every encoding of the Encoding Standard, by `encoding_rs`. What is not
/// decoded is the error, said as the refusal says it.
#[cfg(feature = "charsets")]
fn every_charset(label: Option<&str>, bytes: &[u8]) -> Result<String, String> {
    let encoding = match label {
        None => encoding_rs::UTF_8,
        // The label is held to the standard before the bytes are looked at.
        Some(label) => encoding_rs::Encoding::for_label_no_replacement(label.as_bytes())
            .ok_or_else(|| format!("{label}, which is no charset the Encoding Standard decodes"))?,
    };
    // The standard's `decode`: a leading mark decides the encoding, and is
    // left out.
    Ok(encoding.decode(bytes).0.into_owned())
}

#[cfg(any(test, not(feature = "charsets")))]
include!(concat!(env!("OUT_DIR"), "/utf8_labels.rs"));

/// UTF-8 alone, which is what a build without the `charsets` feature
/// decodes. It reads a text as the rule says or refuses it, and reads
/// nothing otherwise: a charset that is no label of UTF-8 is refused, and
/// so are bytes that begin with UTF-16's mark.
#[cfg(any(test, not(feature = "charsets")))]
fn utf8_alone(label: Option<&str>, bytes: &[u8]) -> Result<String, String> {
    const ALONE: &str = "and only UTF-8 is decoded without the `charsets` feature";
    // What the Encoding Standard drops from around a label.
    const ASCII_WHITE_SPACE: [char; 5] = ['\t', '\n', '\u{c}', '\r', ' '];
    if let Some(label) = label {
        let name = label.trim_matches(ASCII_WHITE_SPACE).to_ascii_lowercase();
        if !UTF_8_LABELS.contains(&name.as_str()) {
            return Err(format!("{label}, {ALONE}"));
        }
    }
    if bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe]) {
        return Err(format!("UTF-16 by its byte-order mark, {ALONE}"));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

#[cfg(test)]
mod tests {
    //! What text a resource's bytes are is two tables every reader runs,
    //! specs/src/text/decode-cases.json and
    //! specs/src/text/encoding-cases.json, and tests/decode_cases.rs runs
    //! them through a client, whose reader in this crate's tests is
    //! `encoding_rs`. Here is the reader a build without the `charsets`
    //! feature has, which no client of these tests reaches: it decodes UTF-8
    //! alone, and is held to the same two tables. What it reads is what the
    //! table says, and what it does not decode it refuses. A media type whose
    //! text is not its bytes it refuses as every build does.

    use super::*;
    use serde_json::Value;

    fn table(text: &str) -> Value {
        serde_json::from_str(text).expect("the table is JSON")
    }

    fn stated<'a>(case: &'a Value, key: &str) -> &'a str {
        case[key]
            .as_str()
            .unwrap_or_else(|| panic!("a case states no {key}: {case}"))
    }

    fn bytes_of(hexadecimal: &str) -> Vec<u8> {
        hexadecimal
            .split_whitespace()
            .map(|byte| u8::from_str_radix(byte, 16).expect("a byte"))
            .collect()
    }

    /// What the reader of UTF-8 alone makes of some bytes served with a
    /// content type: `decode_representation`, as a build without the
    /// `charsets` feature has it.
    fn read(content_type: &str, bytes: &[u8]) -> Result<String, String> {
        bytes_are_text(content_type)?;
        let label = charset(content_type).filter(|label| !label.is_empty());
        utf8_alone(label.as_deref(), bytes)
    }

    #[cfg(feature = "charsets")]
    #[test]
    fn the_reader_of_utf8_alone_reads_a_case_as_the_table_has_it_or_refuses_it() {
        let table = table(include_str!("../specs/text/decode-cases.json"));
        let (mut read_as_stated, mut refused) = (0, 0);
        for case in table["cases"].as_array().expect("cases") {
            let why = stated(case, "why");
            let content_type = stated(case, "contentType");
            let bytes = bytes_of(stated(case, "bytes"));
            // What the rule makes of the case, by the standard's own
            // implementation: the encoding stated, and the one a mark says.
            let label = charset(content_type).filter(|label| !label.is_empty());
            let utf8_is_stated = label.as_deref().is_none_or(|label| {
                encoding_rs::Encoding::for_label_no_replacement(label.as_bytes())
                    == Some(encoding_rs::UTF_8)
            });
            let utf16_is_marked = encoding_rs::Encoding::for_bom(&bytes)
                .is_some_and(|(encoding, _)| encoding != encoding_rs::UTF_8);
            let answer = read(content_type, &bytes);
            match case.get("text").and_then(Value::as_str) {
                Some(text) if utf8_is_stated && !utf16_is_marked => {
                    read_as_stated += 1;
                    assert_eq!(answer.as_deref(), Ok(text), "{why}");
                }
                _ => {
                    refused += 1;
                    let refusal = answer.expect_err(why);
                    if let Some(label) = case.get("refused").and_then(Value::as_str) {
                        assert!(refusal.contains(label), "{why}: {refusal}");
                    }
                }
            }
        }
        assert!(
            read_as_stated >= 25 && refused >= 40,
            "{read_as_stated} read and {refused} refused"
        );
    }

    #[test]
    fn the_reader_of_utf8_alone_takes_every_label_of_utf8_and_refuses_every_other() {
        let table = table(include_str!("../specs/text/encoding-cases.json"));
        let (mut taken, mut refused) = (0, 0);
        let listed = table["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .map(|case| (stated(case, "encoding"), &case["labels"]));
        for (encoding, labels) in listed {
            for label in labels.as_array().expect("labels") {
                let label = label.as_str().expect("a label is text");
                let answer = read(&format!("text/plain; charset={label}"), b"\xc3\xa9");
                if encoding == "utf-8" {
                    taken += 1;
                    assert_eq!(answer.as_deref(), Ok("é"), "{label}");
                } else {
                    refused += 1;
                    let refusal = answer.expect_err(label);
                    assert!(refusal.contains(label), "{label}: {refusal}");
                }
            }
        }
        assert!(
            taken >= 6 && refused >= 200,
            "{taken} taken and {refused} refused"
        );
    }

    #[cfg(feature = "charsets")]
    #[test]
    fn the_reader_of_utf8_alone_reads_malformed_utf8_as_the_standards_decoder_does() {
        // Every sequence of up to three of the bytes at which UTF-8's rules
        // turn: the ends of each range of leading and of continuation bytes.
        const TURNS: [u8; 31] = [
            0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0,
            0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xf7, 0xf8, 0xfb, 0xfc,
            0xfd, 0xfe, 0xff,
        ];
        let mut sequences: Vec<Vec<u8>> = vec![vec![]];
        for _ in 0..3 {
            let longer: Vec<Vec<u8>> = sequences
                .iter()
                .flat_map(|sequence| {
                    TURNS.iter().map(move |&byte| {
                        let mut longer = sequence.clone();
                        longer.push(byte);
                        longer
                    })
                })
                .collect();
            sequences.extend(longer);
            sequences.sort();
            sequences.dedup();
        }
        assert!(sequences.len() > 30_000);
        for sequence in sequences {
            let answer = utf8_alone(None, &sequence);
            // What begins as UTF-16's mark does is UTF-16, which this reader
            // refuses.
            if sequence.starts_with(&[0xfe, 0xff]) || sequence.starts_with(&[0xff, 0xfe]) {
                assert!(answer.is_err(), "{sequence:02x?}");
                continue;
            }
            let standard = encoding_rs::UTF_8.decode_without_bom_handling(&sequence).0;
            assert_eq!(answer.as_deref(), Ok(&*standard), "{sequence:02x?}");
        }
    }

    #[test]
    fn the_reader_of_utf8_alone_refuses_utf16_by_its_mark_and_says_so() {
        for mark in [&b"\xff\xfeh\x00"[..], &b"\xfe\xff\x00h"[..]] {
            let refusal = read("text/plain", mark).expect_err("UTF-16 is not decoded");
            assert!(refusal.contains("UTF-16"), "{refusal}");
        }
    }
}
