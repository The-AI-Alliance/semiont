// Isolates SOFT hyphen loss from hyphen loss generally.
// Explicit hyphens survive extraction verbatim -- "well-known" and
// "state-of-the-art" both match -- so the gap is specifically the hyphen that
// automatic hyphenation inserts. This is what makes the upstream Typst report
// precise rather than vague.

#set text(hyphenate: true)
#set par(justify: true)

A well-known state-of-the-art phrase with explicit hyphens sits here, and
then an extraordinarily complicated administrative reconsideration follows
to force automatic hyphenation at the measure.
