// Forces a cited phrase across a line break.
// "quick brown fox" straddles lines 1-2 of the first paragraph: a plain search
// of the assembled text MISSES it, because anchorRuns joins runs with " \n".
// Two paragraphs so block structure is distinguishable from inline.
//
// Expected (Typst 0.15.1 defaults): "quick brown fox" -> 2 rects,
//   y=746 x=71..521   y=731 x=71..495

= Quarterly Report

Some preceding text that fills the line and wraps naturally across the
measure, then the quick brown fox appears here in the middle of a
paragraph, and a good deal more text follows after it so the phrase is
genuinely interior rather than at a boundary.

A second paragraph exists so that block-level structure is visible and
distinguishable from inline structure in whatever the compiler emits.
