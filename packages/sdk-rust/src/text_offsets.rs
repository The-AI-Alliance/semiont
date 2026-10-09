//! Where an offset into a text meets a Rust string.
//!
//! A text offset, on the wire, in the record and in every store, counts
//! Unicode code points from the start of the text: the W3C Web Annotation
//! rule, and the same count in every language. A `&str` is indexed in bytes
//! of UTF-8, where a character is one to four. The two counts agree until
//! the first character outside ASCII.
//!
//! So arithmetic is done on offsets, and a length is a difference of two of
//! them: every count a rule states is of code points. A string's own index is
//! only ever what a search of the string gave or what a slice of it takes,
//! and is converted here. specs/src/text/offset-cases.json holds the count,
//! for this and for every other implementation.

/// A text's offsets and its string's indices, each given the other.
pub(crate) struct Offsets<'t> {
    text: &'t str,
    /// The index each code point of the text starts at, in the text's order,
    /// and after them the text's length in bytes: the index of an offset.
    starts: Vec<usize>,
}

impl<'t> Offsets<'t> {
    /// The conversions for one text, made once and asked as often as the
    /// text has offsets.
    pub(crate) fn of(text: &'t str) -> Offsets<'t> {
        let mut starts: Vec<usize> = text.char_indices().map(|(index, _)| index).collect();
        starts.push(text.len());
        Offsets { text, starts }
    }

    pub(crate) fn text(&self) -> &'t str {
        self.text
    }

    /// How many code points the text is. An offset may equal it and may not
    /// exceed it.
    pub(crate) fn len(&self) -> usize {
        self.starts.len() - 1
    }

    /// The index in the string of an offset. `None` for a number that is no
    /// offset of the text.
    pub(crate) fn index_at(&self, offset: usize) -> Option<usize> {
        self.starts.get(offset).copied()
    }

    /// The offset of an index in the string: how many code points are before
    /// it. `None` for an index inside a character, which has no offset, and
    /// for one past the end.
    pub(crate) fn offset_at(&self, index: usize) -> Option<usize> {
        self.starts.binary_search(&index).ok()
    }

    /// The text from one offset up to another. `None` unless they are two
    /// offsets of the text, the first no greater than the second.
    pub(crate) fn between(&self, start: usize, end: usize) -> Option<&'t str> {
        self.text.get(self.index_at(start)?..self.index_at(end)?)
    }

    /// The character at an offset. `None` at the end of the text and past it.
    pub(crate) fn char_at(&self, offset: usize) -> Option<char> {
        self.between(offset, offset.checked_add(1)?)?.chars().next()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn count(of: &Value, member: &str) -> usize {
        of[member]
            .as_u64()
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or_else(|| panic!("no count {member} in {of}"))
    }

    #[test]
    fn every_span_of_the_table_is_found_at_its_offsets_and_read_back_from_them() {
        let table: Value = serde_json::from_str(include_str!("../specs/text/offset-cases.json"))
            .expect("the table is JSON");
        let cases = table["cases"].as_array().expect("cases");
        assert!(!cases.is_empty());
        for case in cases {
            let why = case["why"].as_str().expect("why");
            let text = case["text"].as_str().expect("text");
            let offsets = Offsets::of(text);
            assert_eq!(offsets.len(), count(case, "codePoints"), "{why}");
            for span in case["spans"].as_array().expect("spans") {
                let exact = span["exact"].as_str().expect("exact");
                let (start, end) = (count(span, "start"), count(span, "end"));
                // Found by the string's own search, which answers in bytes,
                // and converted to offsets.
                let (index, _) = text
                    .match_indices(exact)
                    .nth(count(span, "occurrence") - 1)
                    .unwrap_or_else(|| panic!("{why}: the text has no such {exact}"));
                let after = index + exact.len();
                assert_eq!(
                    (offsets.offset_at(index), offsets.offset_at(after)),
                    (Some(start), Some(end)),
                    "{why}: where {exact} was found"
                );
                // Given as offsets, and converted to the string's indices.
                assert_eq!(
                    (offsets.index_at(start), offsets.index_at(end)),
                    (Some(index), Some(after)),
                    "{why}: where {exact} is"
                );
                assert_eq!(offsets.between(start, end), Some(exact), "{why}");
            }
        }
    }

    #[test]
    fn what_is_no_offset_of_the_text_converts_to_nothing() {
        let offsets = Offsets::of("a😀b");
        assert_eq!(offsets.len(), 3);
        // An index inside a character has no offset, and neither has one
        // past the end.
        assert_eq!(offsets.offset_at(2), None);
        assert_eq!(offsets.offset_at(7), None);
        // An offset may equal the text's length and may not exceed it.
        assert_eq!(offsets.index_at(3), Some(6));
        assert_eq!(offsets.index_at(4), None);
        assert_eq!(offsets.between(2, 1), None);
        assert_eq!(offsets.between(2, 4), None);
        assert_eq!(offsets.char_at(1), Some('😀'));
        assert_eq!(offsets.char_at(3), None);
    }
}
