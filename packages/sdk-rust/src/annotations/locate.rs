//! Where a span of a PDF's text is on its pages.
//!
//! An annotation of a PDF is anchored by rectangles on its pages, not by
//! offsets, so a span found in the PDF's text is located: one rectangle for
//! each line of each page it touches, each written as an RFC 3778 fragment.
//! specs/src/annotations/pdf-locate-cases.json holds the rule in its `cases`,
//! for this and for every other implementation. A span, like an item's
//! `start` and `end`, is two offsets, which count Unicode code points:
//! nothing here reads the text, so nothing is converted.

use crate::types::{AnchoredText, PdfTextItem};
use std::cmp::Ordering;

/// A rectangle on a page: `x`, `y`, `width` and `height` in PDF points,
/// measured from the bottom-left corner of the page, `y` growing upward.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub(crate) page: f64,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl Rect {
    /// The rectangle as an RFC 3778 fragment, each number written as the
    /// shortest decimal that reads back as that number.
    pub(crate) fn fragment(&self) -> String {
        format!(
            "page={}&viewrect={},{},{},{}",
            self.page, self.x, self.y, self.width, self.height
        )
    }
}

/// Where a span is: the items it overlaps, in the order the anchored text
/// has them, and one rectangle for each line of each page it touches.
pub(crate) struct Located<'a> {
    pub(crate) overlapping: Vec<&'a PdfTextItem>,
    pub(crate) rects: Vec<Rect>,
}

/// Items whose `y` is within this many points of the `y` of the first item
/// of a line are on that line.
const SAME_LINE: f64 = 2.0;

/// The order of two numbers, where they have one.
fn ascending(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// The rectangle that spans the items of one line: from their least left
/// edge to their greatest right edge, and from their least `y` to their
/// greatest top. An item the span cuts has its edge where the span does, by
/// the fraction of its code points the span leaves out.
fn spanning(page: f64, line: &[&PdfTextItem], start: u64, end: u64) -> Rect {
    let (mut left, mut right) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut bottom, mut top) = (f64::INFINITY, f64::NEG_INFINITY);
    for item in line {
        let code_points = item.end.saturating_sub(item.start);
        let cut_at =
            |offset: u64| item.x + item.width * ((offset - item.start) as f64 / code_points as f64);
        let starts_before = item.start < start && code_points > 0;
        let ends_after = item.end > end && code_points > 0;
        left = left.min(if starts_before { cut_at(start) } else { item.x });
        right = right.max(if ends_after {
            cut_at(end)
        } else {
            item.x + item.width
        });
        bottom = bottom.min(item.y);
        top = top.max(item.y + item.height);
    }
    Rect {
        page,
        x: left,
        y: bottom,
        width: right - left,
        height: top - bottom,
    }
}

/// Locate the span from the offset `start` up to but not including `end`.
/// An item overlaps it when it starts before the span ends and ends after
/// the span starts, and an empty span overlaps none, wherever it falls. A
/// span that no item overlaps has no rectangles.
pub(crate) fn locate(anchored: &AnchoredText, start: u64, end: u64) -> Located<'_> {
    let overlapping: Vec<&PdfTextItem> = anchored
        .items
        .iter()
        .filter(|item| start != end && item.start < end && item.end > start)
        .collect();

    // The overlapping items a page at a time, the pages in the order their
    // first overlapping item comes in.
    let mut pages: Vec<(f64, Vec<&PdfTextItem>)> = Vec::new();
    for &item in &overlapping {
        match pages.iter_mut().find(|(page, _)| *page == item.page) {
            Some((_, items)) => items.push(item),
            None => pages.push((item.page, vec![item])),
        }
    }

    let mut rects = Vec::new();
    for (page, mut items) in pages {
        // The greater `y` first, which is the top of the page, and among
        // items of one `y` the lesser `x` first.
        items.sort_by(|a, b| ascending(b.y, a.y).then(ascending(a.x, b.x)));
        let mut lines: Vec<Vec<&PdfTextItem>> = Vec::new();
        for item in items {
            match lines.last_mut() {
                Some(line)
                    if line
                        .first()
                        .is_some_and(|first| (item.y - first.y).abs() <= SAME_LINE) =>
                {
                    line.push(item);
                }
                _ => lines.push(vec![item]),
            }
        }
        rects.extend(lines.iter().map(|line| spanning(page, line, start, end)));
    }
    Located { overlapping, rects }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn every_span_of_the_table_is_located_where_the_table_says() {
        let table: Value = serde_json::from_str(include_str!(
            "../../specs/annotations/pdf-locate-cases.json"
        ))
        .expect("the table is JSON");
        let cases = table["cases"].as_array().expect("cases");
        assert!(!cases.is_empty());
        for case in cases {
            let why = case["why"].as_str().expect("why");
            let anchored: AnchoredText =
                serde_json::from_value(case["anchored"].clone()).expect("an anchored text");
            let offset = |member: &str| case["span"][member].as_u64().expect("an offset");
            let located = locate(&anchored, offset("start"), offset("end"));

            let overlapping: Vec<PdfTextItem> =
                serde_json::from_value(case["overlapping"].clone()).expect("items");
            assert_eq!(
                located.overlapping,
                overlapping.iter().collect::<Vec<_>>(),
                "{why}"
            );

            // The table's numbers are read as the doubles they are, and a
            // rectangle is compared for equality.
            let rects: Vec<Rect> = case["rects"]
                .as_array()
                .expect("rects")
                .iter()
                .map(|rect| {
                    let number = |member: &str| rect[member].as_f64().expect("a number");
                    Rect {
                        page: number("page"),
                        x: number("x"),
                        y: number("y"),
                        width: number("width"),
                        height: number("height"),
                    }
                })
                .collect();
            assert_eq!(located.rects, rects, "{why}");

            let fragments: Vec<String> = located.rects.iter().map(Rect::fragment).collect();
            assert_eq!(serde_json::json!(fragments), case["fragments"], "{why}");
        }
    }
}
