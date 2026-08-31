# Anchoring

How an annotation knows *where* it points, and how a document that has no
machine-readable text still gets annotated.

An annotation is an event over an immutable resource. It never edits the
resource, so the only thing tying it to a place in that resource is its
**selector**. What can serve as a selector depends entirely on what the resource
offers a reader: a Markdown file offers character offsets; a scanned page offers
nothing at all until something recovers it.

This doc is the pipeline that closes that gap.

## The shared vocabulary: `AnchoredText`

Everything below produces or consumes one type, in `@semiont/core`:

```ts
interface AnchoredText { text: string; items: PdfTextItem[] }
interface PdfTextItem { start; end; page; x; y; width; height }
```

Text, paired with the geometry that indexes it. `items[i]` says *"characters
`start`..`end` of `text` are drawn at this rectangle on this page"*.

**Only the coordinate space varies by medium.** The shape does not:

| Medium | Coordinates | Producer |
|---|---|---|
| text / markdown | character offsets | decode |
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
extracted text; `buildPdfAnnotation` turns that span into one `FragmentSelector`
per line, plus a `TextQuoteSelector` carrying the quote.

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

The same constant carries skew tolerance. Page tilt does not currently reach the
items — the recognizer deskews and snaps word boxes to the baseline — but if it
ever did, 0.5 holds to a quarter of a degree where any-intersection is already
failing most of the time.

## The pipeline

```
ingest    Smelter reads the bytes once, extracts to embed
          └─ carries geometry? → writes its anchored-text store (checksum-keyed)
store     the Smelter's — it owns the stamp; the Archivist holds a read-only mount
read      browse:anchored-text-requested  →  bus  →  Archivist's Browser  →  readAnchoredText
          └─ miss → whenSettled(resourceId, checksum) → re-read
browser   getTextContent() has runs?  yes → anchorRuns(...)      (born-digital)
                                      no  → browse.resourceAnchoredText()  (scanned)
drag      textUnder(map, rect) → [FragmentSelector, TextQuoteSelector]
```

**The Smelter is the sole producer, and the store is its.** It is the only
process that reads a resource's bytes at ingest, so it is the only one
positioned to derive a map cheaply — it has already decoded the document and
run the engine in order to embed. It writes the store directly; the Archivist
mounts it read-only and answers the bus reads. Five detection jobs and the
browser all arrive later and would each have to redo that work.

**Reading never derives.** A read that finds nothing waits for that resource's
content generation to settle and then answers "no map". OCR in a request path is
the thing this design exists to avoid.

**Failure degrades, it does not break.** No map — because the document has none,
because extraction declined, or because the barrier timed out — means the
annotation ships with geometry and no quote. That is exactly the behaviour that
predates any of this, so the failure mode is "no improvement", never "broken".

### Why the map is stored at all

OCR costs roughly **2.9 seconds per scanned page**, and six independent
consumers read the same document: five detection motivations plus the Smelter's
own embed, each its own job in its own process. Without a store, a 50-page scan
is re-recognized six times.

The store holds derived values only — every entry is reproducible from the
resource's bytes — which is what makes a version-stamp miss safe. The stamp is
derived from package versions (this package, the engine, its traineddata), never
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
exactly as the born-digital path always worked.

So: no new stored event, no mutable targets, and annotations created before this
existed simply keep no quote. That is the same principle `PDF-DETECTION.md`
states as a non-goal — annotations are events over an immutable resource, not
edits to it.

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
| `AnchoredText`, `locate`, `textUnder`, `anchorRuns`, the threshold | `@semiont/core` — `pdf-anchoring.ts` |
| Producing a map (text layer, OCR, tables, forms) | `@semiont/content` — `pdf-extractor.ts` |
| Storing one | `@semiont/content` — `anchored-text-store.ts` |
| Publishing at ingest | `@semiont/make-meaning` — `smelter.ts` |
| Serving one, with the barrier | `@semiont/make-meaning` — `read-anchored-text.ts` |
| Detection's geometry tail | `@semiont/jobs` — `buildPdfAnnotation` |
| The canvas | `@semiont/react-ui` — `PdfAnnotationCanvas.tsx` |

`@semiont/core` holds what *reasons over* a map; `@semiont/content` holds what
*produces* one. The split is not cosmetic: the browser needs `textUnder` at drag
time, and `@semiont/content` carries pdf.js, Tesseract and `node:fs`.

## Related

- **[../protocol/W3C-SELECTORS.md](../protocol/W3C-SELECTORS.md)** — the selector types an annotation may carry, and which apply to which media.
- **[KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md)** — the actors, and the storage the map sits in.
- **[PROJECTION-PATTERN.md](PROJECTION-PATTERN.md)** — the read-your-writes barrier this read path reuses.
- **[../protocol/TRANSPORT-CONTRACT.md](../protocol/TRANSPORT-CONTRACT.md)** — `IContentTransport`, where the map crosses a process boundary.
