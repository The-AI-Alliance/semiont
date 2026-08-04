// Deliberately malformed, for compile-error shape.
// Typst reports: error: unclosed delimiter, with file:line:col and a caret.
// That legibility is the load-bearing input to whether a compile-repair loop
// is viable (PDF-GENERATION open question 1).

#set text(hyphenate: true)

#let broken = [unclosed
A paragraph with #undefined-fn() in it.
