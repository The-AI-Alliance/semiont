# W3C Web Annotation Selectors

Which selectors a Semiont annotation carries, and why the answer depends on the
resource it points at.

A resource's media type constrains the selectors that can apply to it. Text
offers offsets into it; a PDF offers page geometry; an image offers regions.
The media-type registry records that as `AnchoringModel` — `'text-selector'` or
`'spatial'` — and every producer follows it. **How** the geometry for a spatial anchor is obtained, and
how a scanned page gets one at all, is
[ANCHORING.md](../architecture/ANCHORING.md).

**Related Documentation:**
- [Anchoring](../architecture/ANCHORING.md) - How a coordinate map is derived, stored and turned into a selector
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) - Complete annotation architecture
- [Semiont Protocol](./README.md) - The eight verbs and the bus these annotations travel on
- [OpenAPI Specification](../../specs/src/openapi.json) - Machine-readable API spec
- [Media Types](../architecture/MEDIA-TYPES.md) - What each media type declares, and what that changes
- [@semiont/core Utilities](../../packages/core/docs/Utilities.md) - Implementation aids: fuzzy anchoring, SVG selector parsing, position validation

## Text selectors

Semiont implements **W3C-compliant text selectors** using a combination of TextPositionSelector and TextQuoteSelector for robustness.

### What a text annotation carries

Every text annotation includes both selector types:

```json
{
  "target": {
    "source": "doc-123",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 100,
        "end": 120
      },
      {
        "type": "TextQuoteSelector",
        "exact": "selected text goes here",
        "prefix": "the ",
        "suffix": " is"
      }
    ]
  }
}
```

### TextPositionSelector

Specifies a span by two offsets from the start of the resource's text:

```typescript
import type { TextPositionSelector } from '@semiont/core';

const position: TextPositionSelector = {
  type: 'TextPositionSelector',
  start: 100,   // offset of the first code point selected
  end: 120,     // offset just past the last one: an offset too, not a length
};
```

An offset counts **Unicode code points** from the start of the resource's
decoded text, exactly as it was decoded: nothing is normalized first.
[The text of a resource](#the-text-of-a-resource) says what that text is. That is
the count the Web Annotation Data Model requires, and it is the same number in
every language. A character outside the Basic Multilingual Plane (an emoji, a
mathematical letter, some CJK) is one code point, where a JavaScript string
has two UTF-16 code units for it, so an offset is a string's own position only
up to the first such character. `textOffsets` in `@semiont/core` converts
between the two, and
[`specs/src/text/offset-cases.json`](../../specs/src/text/offset-cases.json)
holds the count for every implementation.

**W3C Specification:** [§4.2.1 TextPositionSelector](https://www.w3.org/TR/annotation-model/#text-position-selector)

### TextQuoteSelector

Specifies the exact text with optional context:

```typescript
import type { TextQuoteSelector } from '@semiont/core';

const quote: TextQuoteSelector = {
  type: 'TextQuoteSelector',
  exact: 'selected text goes here',   // the selected text
  prefix: 'the ',                      // text immediately before, optional
  suffix: ' is',                       // text immediately after, optional
};
```

**W3C Specification:** [§4.2.4 TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)

### Benefits of Dual Selectors

- **TextPositionSelector**: Fast, precise lookup when document unchanged
- **TextQuoteSelector**: Recovery when document content shifts
- **Prefix/Suffix**: Additional context for robust matching

### Dual Selectors Are Written to Agree

The two selectors are not independent guesses — they are reconciled at write time so they describe the same span. The LLM does **not** supply offsets; it supplies `exact` (a verbatim substring) plus optional prefix/suffix context. Our code computes `start`/`end` by searching the source for `exact`, and a no-overlap invariant rejects any annotation whose selectors disagree:

```
the text from start to end                              is exact
the text that ends at start, as long as prefix is       is prefix   // when prefix present
the text that starts at end, as long as suffix is       is suffix   // when suffix present
```

Every position and every length there is counted in code points.

This write-time reconciliation (`reconcile` in `@semiont/core`, and in every SDK) is where fuzzy matching lives — verbatim, then deterministic normalization (smart quotes, whitespace), then Levenshtein within a 5% tolerance — because the source content is in hand and the output is the authoritative record. All five annotation-detection workers converge on it. When `exact` appears more than once, prefix/suffix disambiguate; an undisambiguated multi-occurrence match is flagged `first-of-many` for audit rather than silently anchored. See [@semiont/core Utilities](../../packages/core/docs/Utilities.md#reconcile-what-a-model-quoted).

### Render-Time Anchoring (Verbatim Only)

Because the stored selectors already agree, the renderer trusts them and re-anchors only on a **verbatim** quote match. The one legitimate render-time discrepancy is *positional drift*: content shifted above the span after the annotation was written, so the `TextPositionSelector` is stale but `exact` still exists byte-identical. `anchorAnnotation` (`@semiont/core`) recovers it — uniquely, disambiguated by prefix/suffix, or (for repeated text) by closest-to-offset position — and flags anything it cannot resolve verbatim as low-confidence rather than fuzzy-matching at render time. This is the W3C-intended use of `TextQuoteSelector` for recovery; the fuzzy fallback chain stays on the write side.

### The text of a resource

An offset is counted in a text and a quote is found in one, so every reader of
a resource makes the same text of the same bytes: the Browser that renders it,
the worker that marks it, the service that gathers the context around a mark.
What that text is, is what a browser makes of the bytes: the
[MIME Sniffing Standard](https://mimesniff.spec.whatwg.org/#parsing-a-mime-type)'s
reading of the content type they come with, and the
[Encoding Standard](https://encoding.spec.whatwg.org/)'s reading of the bytes.
A reader is written from the rules below and those two standards, and from no
other reader's code. Each rule ends with *Held by* and the table whose cases
hold it, which every reader runs.

- **T1. The charset is the content type's `charset` parameter, as the MIME
  Sniffing Standard parses a MIME type.** The parameter's name is `charset`,
  whole and in any ASCII case: a name that only ends or begins with it is
  another parameter. Of several, the first is the one stated. A quoted value
  is what is between the quotation marks, where a backslash gives the
  character after it. A parameter with nothing after its equals sign is no
  parameter, and neither is one whose value has a character the standard does
  not allow there. A content type the standard does not parse, such as one
  with no subtype, has no parameters. Where no charset is stated, or the one
  stated is empty, the charset is UTF-8.
  *Held by `specs/src/text/decode-cases.json`.*
- **T2. The charset is a label of the Encoding Standard**, matched as the
  standard gets an encoding: ASCII white space around it is dropped, and its
  ASCII case is not read. The label names the encoding the standard gives it:
  `latin1`, `ascii` and `iso-8859-1` are windows-1252, and `utf-16` is
  UTF-16LE. A charset that is no label of the standard is refused, and so is
  a label of the standard's `replacement` encoding. The refusal names the
  charset, and is made whatever the bytes are: no mark decides for a charset
  the standard lacks.
  *Held by `specs/src/text/decode-cases.json`, and for every label of the standard by `specs/src/text/encoding-cases.json`.*
- **T3. A byte-order mark decides, and is not part of the text**, as in the
  standard's `decode`. Bytes that begin `EF BB BF` are UTF-8, bytes that begin
  `FE FF` are UTF-16BE, and bytes that begin `FF FE` are UTF-16LE, whatever
  charset was stated; those two or three bytes are left out. With no mark the
  encoding is the one stated, or UTF-8. A mark anywhere else is U+FEFF, a
  character of the text like any other, and so is a second mark after the
  first.
  *Held by `specs/src/text/decode-cases.json`.*
- **T4. The bytes are decoded by the standard's decoder for the encoding, in
  replacement mode.** What the encoding does not have becomes U+FFFD: as many
  as the standard's decoder emits, and no more. In UTF-8 a sequence cut short
  is one, and every byte of an overlong form, of a surrogate or of a code
  point past U+10FFFF is one. In UTF-16 an unpaired surrogate is one, and so
  is an odd last byte. In a single-byte encoding every byte is one character,
  the one the standard's index gives it, and U+FFFD only where the index
  gives it none: the bytes windows-1252 leaves unassigned are the controls of
  the same number.
  *Held by `specs/src/text/decode-cases.json` for UTF-8 and UTF-16, and by `specs/src/text/encoding-cases.json` for every byte of every single-byte encoding, x-user-defined among them.*
- **T5. A refusal is the reader's own failure, of the kind its other failures
  are**: in an SDK, a transport's failure whose code is `error`. No reader
  fails from inside a decoder, and none reads a charset it refuses as another
  one. The bytes are still there to read, as the resource's representation.
  *Held by `specs/src/text/decode-cases.json`.*
- **T6. A reader may decode fewer encodings than the standard has.** It
  refuses, as T5 says and by name, a resource whose stated charset is a label
  of an encoding it does not decode, and bytes whose mark is of one. What it
  does read, it reads as T1 to T4 say. The Rust SDK without its `charsets`
  feature decodes UTF-8 alone. The TypeScript reader decodes what the
  platform's `TextDecoder` does: every encoding of the standard in a browser,
  and in a Node built with full ICU, as Node's own distributions are.
  *Held by `packages/sdk-rust/src/namespaces/browse.rs` for the Rust SDK's reader of UTF-8 alone.*
- **T7. The bytes of the seven legacy multi-byte encodings are read by each
  reader's own decoder, and those differ.** Big5, EUC-JP, EUC-KR, gb18030, GBK, ISO-2022-JP and
  Shift_JIS are encodings of the standard: their labels are labels (T2), and a
  mark decides over them (T3). Their bytes are read by each reader's own
  decoder: `encoding_rs` in Rust, which is the standard's; ICU in TypeScript
  and Python's own codecs in Python, each of which differs from the
  standard's, in the characters of some sequences and in what it makes of a
  fault. The Python reader refuses the labels of these encodings that Python
  has no codec under.
  *Held by no case.*

## PDF selectors

A PDF anchors **spatially**. Its characters are drawn at positions rather than
held at offsets, and the extracted text is a derived artifact — re-extraction
could shift every offset — so offsets into it are not a durable anchor for
one. Page geometry is.

### FragmentSelector — RFC 3778

```json
{
  "type": "FragmentSelector",
  "conformsTo": "http://tools.ietf.org/rfc/rfc3778",
  "value": "page=1&viewrect=72,700,240,12"
}
```

`viewrect` is `left,top,width,height` in **PDF points, origin bottom-left**,
Y increasing upward. The flip to canvas pixels happens in the browser.

**One selector per line.** A span crossing three lines produces three
`FragmentSelector`s, each bounding that line's covered words — not one rectangle
swallowing the whitespace between them.

### Paired with a TextQuoteSelector

A PDF annotation carries geometry **and** the words that geometry covers:

```json
{
  "selector": [
    { "type": "FragmentSelector", "conformsTo": "http://tools.ietf.org/rfc/rfc3778",
      "value": "page=1&viewrect=72,700,240,12" },
    { "type": "TextQuoteSelector", "exact": "the passage in question" }
  ]
}
```

The quote is the annotation's only human-readable identity away from the page:
without it a panel entry is anonymous, search over annotation text misses it,
and an export has nothing to print. It is omitted — rather than stored empty —
when a rectangle covers no words, because an empty quote would assert the box
was drawn around nothing.

**No `TextPositionSelector`.** See the opening of this section: offsets into a
derived extraction are not durable.

## Image selectors

An image anchors spatially too, and has no text to quote, so a region is the
whole of the anchor.

### SvgSelector

```json
{
  "type": "SvgSelector",
  "value": "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"100\" y=\"200\" width=\"150\" height=\"80\"/></svg>"
}
```

Three shapes are written and read: a rectangle (`<rect>`), a circle
(`<circle>`) and a polygon (`<polygon>`). Coordinates are in the image's own
pixels, origin top-left, whatever size it was displayed at when the region was
drawn. A selector holding any other markup is not read as a region.

**W3C Specification:** [§4.2.8 SvgSelector](https://www.w3.org/TR/annotation-model/#svg-selector)

## References

- [W3C Web Annotation Model](https://www.w3.org/TR/annotation-model/)
- [W3C Selectors Specification](https://www.w3.org/TR/annotation-model/#selectors)
- [TextPositionSelector](https://www.w3.org/TR/annotation-model/#text-position-selector)
- [TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)
- [FragmentSelector](https://www.w3.org/TR/annotation-model/#fragment-selector)
- [SvgSelector](https://www.w3.org/TR/annotation-model/#svg-selector)
- [RFC 3778 — PDF Fragment Identifiers](https://tools.ietf.org/rfc/rfc3778)
