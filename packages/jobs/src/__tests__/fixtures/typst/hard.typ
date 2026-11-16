// Forces automatic hyphenation, and carries ligature words.
// "extraordinarily" splits as "extraor" / "dinarily" with NO hyphen character
// anywhere in the text layer and no /ActualText -- so whitespace normalization
// cannot recover it and a break-aware matcher is required.
// "flagship" and "efficiency" exercise ffi/fl ligatures; both round-trip.
//
// Expected: "extraordinarily complicated" -> 2 rects,
//   y=764 x=71..523   y=749 x=71..524

#set text(hyphenate: true)
#set par(justify: true)

The organization's classification of infrastructure investments was
reclassified following an extraordinarily complicated administrative
reconsideration, and the difficulty of finding a specific phrase became
the flagship efficiency finding of the quarter.
