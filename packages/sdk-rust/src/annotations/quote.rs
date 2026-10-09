//! Finding the words a model quoted in a text.
//!
//! A text is searched for the words character for character. Where it does
//! not have them so, it is searched three looser ways in turn: without
//! regard to white space and to the forms of quotation marks and dashes,
//! without regard to letter case, and by edit distance within an allowance.
//! A place found in any of these ways is a span of the text itself, and so
//! is the context taken around it. `reconcile` is what chooses among the
//! places, and specs/src/annotations/reconcile-cases.json holds the rule
//! through it.
//!
//! Every position and every length here counts Unicode code points.

use super::MatchQuality;
use crate::text_offsets::Offsets;

/// A span of a text, as two offsets: the code points from `start` up to but
/// not including `end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Place {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// The offset of every place a text has `words`, in the text's order.
/// Places may overlap. Words of no length are in no place.
fn occurrences(offsets: &Offsets<'_>, words: &str) -> Vec<usize> {
    let text = offsets.text();
    let mut found = Vec::new();
    // Each search starts one character on from the last place, which begins
    // with the words' first character.
    let Some(step) = words.chars().next().map(char::len_utf8) else {
        return found;
    };
    let mut from = 0;
    while let Some(index) = text
        .get(from..)
        .and_then(|rest| rest.find(words))
        .map(|at| from + at)
    {
        found.extend(offsets.offset_at(index));
        from = index + step;
    }
    found
}

/// Every place a text has `words`, character for character.
pub(crate) fn places_of(offsets: &Offsets<'_>, words: &str) -> Vec<Place> {
    let length = words.chars().count();
    occurrences(offsets, words)
        .into_iter()
        .map(|start| Place {
            start,
            end: start + length,
        })
        .collect()
}

/// A text changed for a comparison, and where each code point of the change
/// came from.
struct Changed {
    text: String,
    /// For each code point of the changed text, the offset, in the text it
    /// was made from, of the character it came from.
    origins: Vec<usize>,
}

impl Changed {
    /// Every place the changed text has `words`, as the span of the text it
    /// was made from: from the character the place's first code point came
    /// from to just after the character its last came from. So a character
    /// that became several code points is in the span whole, and white space
    /// the text has after the place is not in it.
    fn places_of(&self, words: &str) -> Vec<Place> {
        let length = words.chars().count();
        occurrences(&Offsets::of(&self.text), words)
            .into_iter()
            .filter_map(|at| {
                Some(Place {
                    start: *self.origins.get(at)?,
                    end: self.origins.get((at + length).checked_sub(1)?)? + 1,
                })
            })
            .collect()
    }
}

/// A text with every run of white space made one space and none at either
/// end, the single quotation marks U+2018 and U+2019 made an apostrophe, the
/// double ones U+201C and U+201D a straight double quote, an em dash U+2014
/// two hyphens and an en dash U+2013 one.
fn normalized(text: &str) -> Changed {
    let (mut plain, mut origins) = (String::new(), Vec::new());
    // Where a run of white space began that is not yet written.
    let mut run: Option<usize> = None;
    for (offset, character) in text.chars().enumerate() {
        if character.is_whitespace() {
            run.get_or_insert(offset);
            continue;
        }
        // A run is one space, from where it began. One that begins the text
        // is nothing, and one that ends it is never reached.
        if let Some(began) = run.take()
            && !plain.is_empty()
        {
            plain.push(' ');
            origins.push(began);
        }
        let written = match character {
            '\u{2018}' | '\u{2019}' => "'",
            '\u{201C}' | '\u{201D}' => "\"",
            '\u{2014}' => "--",
            '\u{2013}' => "-",
            _ => {
                plain.push(character);
                origins.push(offset);
                continue;
            }
        };
        plain.push_str(written);
        origins.extend(std::iter::repeat_n(offset, written.len()));
    }
    Changed {
        text: plain,
        origins,
    }
}

/// A text lower-cased whole, by Unicode's rule of no particular language: a
/// capital sigma that ends a word becomes the final one, which lower-casing
/// a character at a time would miss. A character becomes as many code points
/// whole as alone (U+0130, a capital I with a dot, becomes two), which is
/// what the origins are counted from.
fn lower_cased(text: &str) -> Changed {
    let lowered = text.to_lowercase();
    let origins: Vec<usize> = text
        .chars()
        .enumerate()
        .flat_map(|(offset, character)| {
            std::iter::repeat_n(offset, character.to_lowercase().count())
        })
        .collect();
    debug_assert_eq!(origins.len(), lowered.chars().count());
    Changed {
        text: lowered,
        origins,
    }
}

/// The edit distance between `wanted` and every stretch that begins `text`:
/// the answer's `n`th is the least number of single code points inserted,
/// deleted or replaced that turns `wanted` into the first `n` of `text`.
/// `None` when no stretch is within `allowance`.
fn distances_from(wanted: &[char], text: &[char], allowance: usize) -> Option<Vec<usize>> {
    // From none of `wanted`, a stretch of `n` code points is `n` insertions
    // away.
    let mut row: Vec<usize> = (0..=text.len()).collect();
    for (taken, want) in wanted.iter().enumerate() {
        let mut next = Vec::with_capacity(row.len());
        next.push(taken + 1);
        for (n, had) in text.iter().enumerate() {
            let replaced = row[n] + usize::from(want != had);
            next.push(replaced.min(row[n + 1] + 1).min(next[n] + 1));
        }
        // The least distance of a row never falls as more of `wanted` is
        // taken.
        if next.iter().all(|distance| *distance > allowance) {
            return None;
        }
        row = next;
    }
    Some(row)
}

/// The stretch of `text` nearest `wanted` by edit distance, of whatever
/// length, provided it is within the allowance: a twentieth of the code
/// points of `wanted`, rounded down, with no minimum.
///
/// Of several at the least distance it is the first in the text; of those
/// that begin at the same place, the one nearest `wanted` in length; and of
/// two as near, the shorter. So from each start the stretch as long as
/// `wanted` is tried first, then the one a code point shorter and the one a
/// code point longer, and so on out, and only a lesser distance replaces
/// what was found.
fn nearest_stretch(text: &[char], wanted: &[char]) -> Option<Place> {
    let allowance = wanted.len() / 20;
    // A stretch at no distance is `wanted` itself, which the text does not
    // have.
    if allowance == 0 {
        return None;
    }
    // A stretch within the allowance is at most the allowance shorter or
    // longer than `wanted`.
    let shortest = wanted.len() - allowance;
    let mut nearest: Option<(Place, usize)> = None;
    for start in 0..=text.len().checked_sub(shortest)? {
        let longest = (wanted.len() + allowance).min(text.len() - start);
        let Some(distances) = distances_from(wanted, &text[start..start + longest], allowance)
        else {
            continue;
        };
        for away in 0..=allowance {
            let lengths = [
                Some(wanted.len() - away),
                (away > 0).then_some(wanted.len() + away),
            ];
            for length in lengths.into_iter().flatten() {
                let Some(distance) = distances.get(length).copied() else {
                    continue;
                };
                if distance <= allowance && nearest.is_none_or(|(_, least)| distance < least) {
                    let end = start + length;
                    nearest = Some((Place { start, end }, distance));
                }
            }
        }
    }
    nearest.map(|(place, _)| place)
}

/// The places a looser search finds `words`, which the text does not have
/// character for character, and the search that found them: the first of
/// the three that finds any, each place a span of the text itself, in the
/// text's order. `None` when none of them finds the words.
pub(crate) fn places_like(text: &str, words: &str) -> Option<(Vec<Place>, MatchQuality)> {
    let places = normalized(text).places_of(&normalized(words).text);
    if !places.is_empty() {
        return Some((places, MatchQuality::Normalized));
    }
    let places = lower_cased(text).places_of(&words.to_lowercase());
    if !places.is_empty() {
        return Some((places, MatchQuality::CaseInsensitive));
    }
    // A code point to an element, so that an edit is of one code point.
    let (text, wanted): (Vec<char>, Vec<char>) = (text.chars().collect(), words.chars().collect());
    nearest_stretch(&text, &wanted).map(|place| (vec![place], MatchQuality::Fuzzy))
}

/// How many code points of context are taken on either side of a span.
const CONTEXT: usize = 64;
/// How many more a context is lengthened by, at most, to reach a boundary.
const LENGTHENING: usize = 32;

/// What a context is not lengthened past: white space, or one of eighteen
/// marks.
fn is_boundary(character: char) -> bool {
    character.is_whitespace()
        || matches!(
            character,
            '.' | ','
                | ';'
                | ':'
                | '!'
                | '?'
                | '\''
                | '"'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '<'
                | '>'
                | '/'
                | '\\'
        )
}

/// What a text has before a place and after it: the 64 code points on each
/// side, or all there are, each lengthened a code point at a time, by at
/// most 32 more, until the character beyond it is a boundary or the text
/// runs out. `None` on a side where the text has nothing.
pub(crate) fn context_of<'t>(
    offsets: &Offsets<'t>,
    place: Place,
) -> (Option<&'t str>, Option<&'t str>) {
    let length = offsets.len();
    let boundary_at = |offset: usize| offsets.char_at(offset).is_some_and(is_boundary);
    let prefix = if place.start == 0 {
        None
    } else {
        let mut from = place.start.saturating_sub(CONTEXT);
        let least = from.saturating_sub(LENGTHENING);
        while from > least && !boundary_at(from - 1) {
            from -= 1;
        }
        offsets.between(from, place.start)
    };
    let suffix = if place.end >= length {
        None
    } else {
        let mut to = (place.end + CONTEXT).min(length);
        let most = (to + LENGTHENING).min(length);
        while to < most && !boundary_at(to) {
            to += 1;
        }
        offsets.between(place.end, to)
    };
    (prefix, suffix)
}
