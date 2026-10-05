// Deliberately malformed, for compile-error shape.
// Typst reports: error: unclosed delimiter, with file:line:col and a caret.
// That legibility is what makes a compile-repair loop viable, and so what lets
// the model write Typst directly instead of markdown that is then converted.

#set text(hyphenate: true)

#let broken = [unclosed
A paragraph with #undefined-fn() in it.
