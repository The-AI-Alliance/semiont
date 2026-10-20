# Anchoring

How an annotation knows *where* it points, and how a document that has no
machine-readable text still gets annotated.

An annotation is an event over an immutable resource. It never edits the
resource, so the only thing tying it to a place in that resource is its
**selector**. What can serve as a selector depends entirely on what the resource
offers a reader: a Markdown file offers offsets into its text, counted in code
points; a scanned page offers nothing at all until something recovers it.

This doc is the pipeline that closes that gap.

## The shared vocabulary: `AnchoredText`

Everything below produces or consumes one type, in `@semiont/core`:

```ts
interface AnchoredText { text: string; items: PdfTextItem[] }
interface PdfTextItem { start; end; page; x; y; width; height }
```

Text, paired with the geometry that indexes it. `items[i]` says *"code points
`start`..`end` of `text` are drawn at this rectangle on this page"*: `start` and
`end` are offsets, which count Unicode code points from the start of `text`, as
every text offset does.

**Only the coordinate space varies by medium.** The shape does not:

| Medium | Coordinates | Producer |
|---|---|---|
| text / markdown | code-point offsets | decode |
| PDF, born-digital | page + rect | text layer |
| PDF / image, scanned | page + rect | OCR |
| PDF, Semiont-generated | page + rect | authored at generation |

Coordinates are PDF points with the origin at the **bottom-left** of the page,
Y increasing upward. The flip to canvas pixels happens in the browser; the
server has no canvas.

## Two directions over one map

`@semiont/core/pdf-anchoring` holds an inverse pair, and which one runs depends
on who is annotating.

```
locate(anchored, start, end) → rects     a model quoted text; find its geometry
textUnder(anchored, rect)    → string    a person drew a box; find its text
```

**`locate` serves AI detection.** A model returns `{ exact, start, end }` over the
extracted text, `start` and `end` being offsets in code points like the items'
own; `annotationOfSpan` turns that span into one `FragmentSelector` per line,
plus a `TextQuoteSelector` carrying the quote.

**`textUnder` serves manual annotation.** The canvas hands it the rectangle the
user dragged, and the answer becomes the `TextQuoteSelector` on an otherwise
geometry-only annotation. Without it a hand-drawn annotation is a rectangle with
no memory of what it was drawn around: the panel entry is blank, search over
annotation text misses it, and an export has nothing to print.

Both emit **selectors fixed at birth**. Nothing ever revises an annotation's
target — see *Why targets never change* below.

### `RUN_COVERAGE_THRESHOLD`

`textUnder` counts a word as covered when the rectangle overlaps **≥50% of that
word's area**, not on any intersection.

Any-intersection is the obvious rule and it does not survive a hand-drawn box.
Word boxes run ~10pt tall at 12pt line pitch, leaving roughly **2pt of headroom
between lines** — so a couple of points of overshoot, less than the height of a
comma, pulls in fragments of the lines above and below. Measured across three
real books, any-intersection is exact only while the box is machine-tight; 0.5
is the only threshold that holds on both loosely- and tightly-set typography,
from about 1pt under to 4pt over.

The same constant carries skew tolerance. Page tilt does not reach the
items — the recognizer deskews and snaps word boxes to the baseline — but if it
did, 0.5 holds to a quarter of a degree where any-intersection is already
failing most of the time.

## The pipeline

```
ingest    Smelter reads the bytes once, extracts to embed
          └─ carries geometry? → PUT /resources/{id}/anchored-text on the Archivist (checksum-keyed)
store     the Archivist's — it alone mounts it; the Smelter states the stamp
read      GET /resources/{id}/anchored-text  →  gateway  →  Archivist  →  anchored_text
          └─ miss → when_settled(resourceId, checksum) → re-read
browser   browse.resourceAnchoredText()   every PDF and every image, once per viewer; pdf.js only draws
          └─ no annotating until the text is held; not-yet or no answer → ask again after a wait
drag      textUnder(map, rect) → [FragmentSelector, TextQuoteSelector]
```

**The Smelter is the sole producer, and the store is its.** It is the only
process that reads a resource's bytes at ingest, so it is the only one
positioned to derive a map cheaply — it has already decoded the document and
run the engine in order to embed. It writes the store directly; the Archivist
mounts it read-only and serves the reads. Five detection jobs and the
browser all arrive later and would each have to redo that work.

**The browser is no exception, even on a page it could read.** pdf.js, which
draws the pages, can also report a born-digital page's text layer, and a canvas
that used it would have a quote without asking anyone. It would also be a
second producer: two readings of one page, to be kept quoting the same words
for the same rectangle forever. So the canvas asks for the Smelter's map for
every PDF, and pdf.js is never asked for a page's text.

**A viewer annotates only while it holds the text.** The quote is cut when an
annotation is made and never again, so a rectangle drawn without the text
would keep no quote. A viewer asks for the text when it opens a resource, and
nobody can draw on it until an answer gives it the text. What it does with
each answer:

| Answer | What the viewer holds | Annotating |
|---|---|---|
| `extracted` | the text, which may be empty | on |
| `no-map` | a text that is empty: this media type has none | on; a shape has no quote |
| none yet, `not-yet`, or an ask that failed | nothing | off; it says it is waiting, and asks again |
| `declined`, `unknown` | nothing, and never will | off for good; it says the text could not be read, and does not ask again |

A document just uploaded has no text until the Smelter has read it. A read
that comes sooner waits at the Archivist and is answered as soon as the
Smelter has read the content; past that wait it answers `not-yet`. The viewer
asks again once `anchoredTextReaskMs` has passed
(`specs/src/client/timing.json`), and goes on asking at that one wait. It
listens for nothing else: the held read is how it learns the text is there.

An image is asked about as a PDF is. Its answer is `no-map`, given at once,
so an image opens for annotating when that answer arrives. A text resource is
not asked about: its viewer shows the decoded text itself, so it holds the
text whenever there is anything to select.

**Reading never derives.** A read that finds nothing waits for that resource's
content generation to settle and then answers "no map". OCR in a request path is
the thing this design exists to avoid.

**Without the text, nobody annotates by hand.** A PDF the Smelter declined
cannot be drawn on, and no PDF can be drawn on while the Smelter is down or
behind: the Smelter is on the path of every hand-drawn annotation. An
annotation with geometry and no quote is made only where the text is held and
has nothing under the shape: a media type with no text, a document read and
found empty, a rectangle over a margin.

### Why the map is stored at all

OCR costs roughly **2.9 seconds per scanned page**, and six independent
consumers read the same document: five detection motivations plus the Smelter's
own embed, each its own job in its own process. Without a store, a 50-page scan
is re-recognized six times.

The store holds derived values only — every entry is reproducible from the
resource's bytes — which is what makes a version-stamp miss safe. The stamp is
read from what is installed (PDFium's and its binding's,
the `tesseract` program's, and a digest of its language data), never
hand-maintained: over-invalidating costs a recomputation, under-invalidating
serves geometry built by different code.

## Why targets never change

The obvious design for scanned pages is asynchronous enrichment: annotate now,
recognize later, patch the annotation with the quote when it finishes. That
needs mutable annotation targets, and the event log has no vocabulary for one —
the stored events are `mark:added`, `mark:removed`, `mark:body-updated`,
`mark:entity-tag-*`, `mark:archived`/`unarchived`, and none touches a target.

It is also unnecessary, because it has the order backwards. Recognition happens
at **ingest**, not after annotation, so the map already exists when a user draws
a rectangle and the quote can be computed before the annotation is created —
for a scanned page exactly as for a born-digital one.

So: no new stored event, no mutable targets, and an annotation born without a
quote keeps none. Annotations are events over an immutable
resource, not edits to it.

## Authored maps are not stored here

A PDF that Semiont *generates* knows its own layout: it does not recover
geometry, it chose it. That map is embedded **in the PDF**, as tags or a PDF/A-3
attachment, not stored alongside it. There is no authored-map directory, which
is why eviction and stamp-misses in the derived store can never destroy
authoritative data.

Writing a map into a PDF we did **not** author is not an option: it changes the
bytes, hence the checksum, which the Smelter reads as a content change.

## Where the code is

| Concern | Location |
|---|---|
| `AnchoredText`, `locate`, `textUnder`, the threshold | `@semiont/core` — `pdf-anchoring.ts` |
| Producing a map (text layer, OCR, tables, forms) | `apps/smelter` — `extraction.py`, over `pdfium.py` and `tesseract.py` |
| Storing one | `apps/smelter` — `anchored_text_store.py`, over the Archivist's `PUT /resources/{id}/anchored-text`; `apps/archivist` — `record/src/anchored_text.rs` |
| Publishing at ingest | `apps/smelter` — `smelter.py` |
| Serving one, with the barrier | `apps/archivist` — `src/anchored.rs` |
| Detection's geometry tail | `@semiont/core` — `annotationOfSpan`, in `annotation-builders.ts` |
| Holding the text for a viewer, and asking again | `@semiont/react-ui` — `hooks/useAnchoredText.ts` |
| The PDF canvas | `@semiont/react-ui` — `PdfAnnotationCanvas.tsx` |
| The image canvas | `@semiont/react-ui` — `SvgDrawingCanvas.tsx` |

`@semiont/core` holds what *reasons over* a map; the Smelter, a Python service
([apps/smelter](../../apps/smelter/)), holds what *produces* one. The split is
not cosmetic: the browser needs `textUnder` at drag time, and producing a map
takes PDFium, the `tesseract` program and a directory to write.

## Related

- **[../protocol/W3C-SELECTORS.md](../protocol/W3C-SELECTORS.md)** — the selector types an annotation may carry, and which apply to which media.
- **[KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md)** — the actors, and the storage the map sits in.
- **[../protocol/ARCHIVIST.md](../protocol/ARCHIVIST.md)** — the anchored-text store as the Archivist keeps it, and the wait for the Smelter to settle.
- **[../protocol/TRANSPORT-CONTRACT.md](../protocol/TRANSPORT-CONTRACT.md)** — `IContentTransport`, where the map crosses a process boundary.
