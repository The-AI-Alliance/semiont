# Media Types and the Flow

Every resource in Semiont travels the same path: **yield → smelt → weave →
annotate**. What differs between a Markdown note and a scanned PDF is not the
path but what each stage is *able to do* — and that is declared in one place, as
data, not scattered through the code that consumes it.

This guide explains the declaration, what each part of it changes downstream, and
then walks one media type end to end. PDF is the running example because it is
the only type that exercises every axis at its hardest setting.

## The declaration

`packages/core/src/media-types.ts` holds one row per supported type:

```ts
interface MediaTypeCapabilities {
  extension: `.${string}`;
  label: string;
  render:      'text' | 'image' | 'pdf' | 'none';
  anchoring:   'text-selector' | 'spatial' | 'none';
  extractText: 'decode' | 'pdf-text-layer' | 'none';
  authorable: boolean;
  uploadable: boolean;
}
```

The registry is `satisfies Record<SupportedMediaType, …>`, so adding a type to
the spec enum without a capabilities row — or the reverse — is a compile error.
That drift-lock is the reason this guide can describe behavior by reading one
table.

| Media type | `render` | `anchoring` | `extractText` |
|---|---|---|---|
| `text/markdown`, `text/plain`, `text/html` | `text` | `text-selector` | `decode` |
| `application/json` | `text` | `text-selector` | `decode` |
| `application/pdf` | `pdf` | `spatial` | `pdf-text-layer` |
| `image/png`, `image/jpeg` | `image` | `spatial` | `none` |
| Stored text (`text/css`, `text/csv`, …) | `none` | `none` | `decode` |
| Stored binary (archives, `audio/*`, `video/*`) | `none` | `none` | `none` |

Three axes, and they are genuinely independent. A type can be rendered but not
anchored, embedded but not rendered, or anchored spatially while yielding no text
at all.

## What each axis changes

### `render` — what the browser mounts

Selects the viewer component and nothing else. `text` renders through the
markdown/prose pipeline, `pdf` mounts the PDF canvas, `image` an image surface,
`none` shows metadata and a download affordance. A type with `render: 'none'` is
catalogued and retrievable but never displayed.

### `anchoring` — what a selector is allowed to be

The consequential one. It decides what an annotation can *point at*, and that
choice is permanent for every annotation ever created against the type.

- **`text-selector`** — characters are the anchor. An annotation carries a
  `TextPositionSelector` and a `TextQuoteSelector`. Offsets index the resource's
  own bytes, so nothing has to be derived before annotating.
- **`spatial`** — position is the anchor. Characters are drawn at coordinates
  rather than held at offsets, and the extracted text is a derived artifact that
  re-extraction could shift. So a PDF annotation carries a `FragmentSelector`
  (RFC 3778: `page=N&viewrect=…`, PDF points, origin bottom-left) and, when the
  text is known, a `TextQuoteSelector`. **Never a `TextPositionSelector`** — a
  character offset is not a durable anchor into a document whose text is
  recovered rather than stored.
- **`none`** — not annotatable.

That single distinction is why the PDF flow below has stages the Markdown flow
does not. It is not incidental complexity; it is what "position is the anchor"
costs.

Note that these three values enumerate the anchoring models in use, not the
space of possible ones. Time-based media needs a fourth, and video needs a
*combination* rather than a fourth — see
[Time-based media](#time-based-media-what-the-model-must-absorb) below before
extending this axis.

### `extractText` — how meaning is recovered, and what it costs

Feeds the Smelter's gate (`textExtractionOf`). On a registry miss, base types
under `text/*` fall back to `decode` — RFC 2046 guarantees the `text` top-level
type is textual — and everything else is `none`.

- **`decode`** — charset-aware passthrough. The text *is* the bytes. Free.
- **`pdf-text-layer`** — parse the content stream, and where a page has no
  glyphs, rasterize and OCR it. Roughly **2.9 seconds per scanned page**.
- **`none`** — no extractor. No embedding, no vector search, no AI detection.

`extractText: 'none'` is not a gap to fill. An image is annotatable
(`anchoring: 'spatial'`) and carries no text; that combination is coherent and
final.

## The running example: a PDF, end to end

A PDF declares `render: 'pdf'`, `anchoring: 'spatial'`, `extractText:
'pdf-text-layer'` — the hardest setting on every axis. Each numbered step below
exists because of one of those three declarations.

### Ingest

1. **`yield.resource`** with the bytes. The backend appends to the event log —
   the system of record — and emits **`yield:created`**.
2. **Three consumers take that event independently**, none waiting on the others:
   - **ViewMaterializer** builds the view projection. This makes the resource
     openable, and it is also the `resourceId → checksum` index that later
     stages rely on.
   - **Smelter** plans an embed.
   - **Weaver** folds it into the graph.

### Smelting — recovering the text, and the geometry that indexes it

3. **Smelter computes `calculateChecksum(bytes)`.** For a `spatial` type this is
   the identity of the derived artifact, not merely a freshness stamp: two
   resources holding identical bytes share one artifact.
4. **It calls `extract(bytes, contentType, { key: checksum, store })`.** The
   cache seam lives *inside* `extract()`, and consults the store for those exact
   bytes:
   - **Hit** → return the stored outcome. No parse, no OCR.
   - **Miss** → classify the document (native text layer, scanned, or hybrid),
     extract, and the seam writes the result.
5. **The stored artifact is an `ExtractionOutcome`** — `text`, `items`,
   `method`, `pdfClass`, `ocrConfidence`, `unreadPages`, *or* a named decline.
   Declines are cached too: "we recognized this and found nothing" costs one
   recognition pass for the lifetime of those bytes.
6. **It lands at `stateDir/anchored-text/{ab}/{cd}/{checksum}.json`**, sharded
   with the same helper the event log uses and bind-mounted per root, so it
   survives a restart and `semiont clean --store anchored-text` can reclaim it.
7. **Smelter chunks, embeds, and writes vectors.**
8. **It emits `smelt:settled { resourceId, contentChecksum, outcome }`** —
   `indexed` or `skipped`. The vector stamp is written *before* this fires, so
   anything released by the barrier is guaranteed to find it.

There is exactly one writer of that artifact: the seam inside `extract()`.

### The artifact's shape

Both directions over a PDF use one type, `AnchoredText` in `@semiont/core`:

```ts
interface AnchoredText { text: string; items: PdfTextItem[] }
interface PdfTextItem { start; end; page; x; y; width; height }
```

Text paired with the geometry that indexes it — `items[i]` says *"characters
`start`..`end` of `text` are drawn at this rectangle on this page."* Two
functions form an inverse pair over it:

```
locate(anchored, start, end) → rects     a model quoted text; find its geometry
textUnder(anchored, rect)    → string    a person drew a box; find its text
```

### Weaving

9. **Weaver folds `yield:created`** into the graph and emits `weave:applied`.
   Near-trivial for a bare resource; it earns its keep once reference
   annotations exist.

### When is it annotatable?

A `spatial` type has three readiness moments, deliberately decoupled:

- **Geometry: immediately.** Once the view exists you can drag a rectangle and it
  persists — whether or not anything knows what is under it.
- **Born-digital PDF, with quotes: immediately, with no server involvement.** The
  canvas calls `getTextContent()`, gets runs from pdf.js in the browser, and
  builds the map locally with `anchorRuns`. It never asks the backend.
- **Scanned PDF, with quotes: once smelt settles.** No runs, so the canvas calls
  `browse.resourceAnchoredText(resourceId)`. Server-side: resolve the view → take
  the primary representation's checksum → read the store → on a miss wait on
  `whenSettled(resourceId, checksum, 15_000)` → re-read if `indexed`, else
  `null`. A timeout or a decline yields no quote, and the annotation ships with
  geometry alone.

**Failure degrades; it does not break.** No map — because the document has none,
because extraction declined, or because the barrier timed out — means an
annotation with geometry and no quote. That is the behavior a `spatial` type had
before any text recovery existed, so the failure mode is "no improvement", never
"broken".

### Annotating

10. **Drag a rectangle.** `textUnder(map, rect)` returns every word whose area is
    **≥50%** covered (`RUN_COVERAGE_THRESHOLD`). Any-intersection is the obvious
    rule and it does not survive a hand-drawn box: word boxes run ~10pt tall at
    12pt line pitch, so a few points of overshoot pulls in fragments of the lines
    above and below.
11. **The canvas emits `mark:create-request`** with a `FragmentSelector`, plus a
    `TextQuoteSelector` when `textUnder` found anything. The backend replies
    `mark:create-ok` and appends **`mark:added`**.
12. **Or AI detection.** `job:create` → a worker runs `prepareDetection`, which
    calls the same cached `extract()` — so on an already-smelted document it does
    no OCR. The model returns a verbatim quote; `locate()` turns that span into
    one `FragmentSelector` per line; `buildPdfAnnotation` assembles the
    annotation.

### How annotation events feed back

13. **`mark:added` reaches both actors.** Weaver folds it into the graph. Smelter
    embeds the annotation's `exactText`, then reads `getResourceStamp` to inherit
    the resource's provenance — the source of `machineRead: true`, which marks a
    quote as recognized rather than authored.
14. **Selectors are fixed at birth.** No stored event mutates a target. An
    annotation created before its map existed keeps no quote, permanently — which
    is why recognition happens at ingest rather than after annotation. The
    alternative, annotating now and patching the quote in later, would require
    mutable annotation targets, and the event log has no vocabulary for one.

### When the artifact goes missing

15. **Reconcile plans `smelt:reanchor`** for a resource whose artifact is absent —
    the third staleness class, alongside checksum drift and entity-tag drift.
16. **A scoped rebuild command** re-anchors one resource or all, serialized, and
    **fails loudly on partial completion**. That matters because a silently
    incomplete rebuild presents as a missing quote, which is also what a document
    with genuinely no text looks like.
17. **`semiont clean --store anchored-text`** reclaims the tree. Everything in it
    is reproducible from bytes, so deleting costs recomputation and never data.

## What the other media types skip

Reading the PDF flow against a simpler row shows what each declaration bought.

**Markdown** (`text-selector`, `decode`) skips steps 3–8's derived artifact
entirely. The text is the bytes, so there is nothing to recover, nothing to
store, no barrier to wait on, and no restart hazard. An annotation carries
character offsets directly. Steps 1–2, 9, and 13–14 are identical.

**An image** (`spatial`, `none`) takes the geometry half and none of the text
half. It is annotatable the moment the view exists, and a rectangle over it is
always geometry-only — there is no map, so no quote, ever. The "three readiness
moments" collapse to one.

**Stored types** (`none`, `none`) are catalogued, named and downloadable.
`storedText` additionally decodes, so it is embedded and searchable while never
being rendered or annotated — a deliberate combination, not an oversight.

## Time-based media: what the model must absorb

`audio/*` and `video/*` are stored binaries today — catalogued, downloadable,
neither rendered nor annotated. Transcripts change that, and they are a harder
case than PDF, not an easier one. This section says which parts of the model
carry over unchanged and which parts are genuinely load-bearing decisions, so
that the first person to implement it does not discover them one at a time.

The anchoring mechanism is settled by standards rather than by us: **W3C Media
Fragments** gives `#t=start,end` for time and `#xywh=` for space, and the two
**combine** — which is what a video annotation needs, since a region on screen
exists only during an interval.

### What carries over unchanged

- **The artifact's shape.** `AnchoredText { text, items }` already says
  *"characters `start`..`end` of `text` live at this position"* and is
  deliberately indifferent to what "position" means. Character offsets, page
  rects, time intervals, and time-plus-rect are four coordinate spaces over one
  structure. The type survives; only `PdfTextItem`'s field set is PDF-specific.
- **The inverse pair.** `locate` (span → position, for a model that quoted text)
  and `textUnder` (position → span, for a human who selected a region) are the
  same two directions over a transcript. "What was said between 10s and 20s" is
  `textUnder` with a temporal region.
- **The three-way source classification.** A PDF is born-digital, scanned, or
  hybrid. Audio and video are the same shape: an embedded caption track
  (WebVTT, CEA-608) is the native text layer, ASR is the OCR, and a partially
  captioned file is the hybrid. The cost split is identical — one source is free
  and exact, the other is expensive and approximate.
- **Everything about the derived artifact.** Content-addressed by checksum,
  written once at ingest, consulted before re-deriving, stored where `clean` can
  reclaim it, re-derivable when missing. ASR on a three-hour recording makes
  this *more* necessary than OCR did, not less.
- **The settle barrier and the readiness split.** An embedded caption track is
  readable in the browser through `TextTrack`, exactly as pdf.js reads a native
  text layer — so the "three readiness moments" structure holds, with WebVTT
  playing pdf.js's role and ASR playing OCR's.
- **Selectors fixed at birth.** Unchanged, and for the same reason.

### What does not carry over

These are the real decisions. Each one is a place where the PDF model gives no
answer.

1. **`anchoring` cannot stay a flat enum.** Audio is temporal. Video is temporal
   *and* spatial at once — a rectangle on a frame during an interval. Adding
   `'temporal'` alongside `'spatial'` handles audio and fails on video. Media
   Fragments composes its two dimensions rather than enumerating their
   combinations, and this axis should follow it.

2. **"One artifact per representation" breaks.** A PDF representation has one
   text layer. An audio representation can have several transcripts that are all
   valid simultaneously: raw ASR, a human-corrected pass, translations, output
   from a second engine. The representation checksum alone cannot distinguish
   them, so the key needs a variant dimension — and "which transcript is *the*
   transcript" becomes a question the PDF path never had to ask.

3. **Speaker attribution has no PDF analogue.** Diarization attributes text to
   speakers, and overlapping speech means two segments legitimately cover the
   same interval with different text. `textUnder(rect)` on a page has one
   correct answer; "what was said between 10s and 20s" may have two, and
   flattening them into one string loses the fact that they were simultaneous.
   This is the transcript version of the multi-column reading-order problem, and
   it is worse: with columns, one linearization is defensible.

4. **Time is continuous where offsets are discrete.** A word occupies a
   real-valued interval, silence maps to no text, and music maps to no text. A
   coverage rule for "is this word inside the selection" needs a temporal
   analogue of `RUN_COVERAGE_THRESHOLD` — and that constant's history is the
   warning worth heeding: it was set wrong twice, both times from a sweep that
   looked conclusive on the corpus it had. Measure across genuinely different
   material (fast speech, overlapping speakers, long pauses) before fixing a
   value.

5. **The whole-resource record comes under real size pressure.** A ten-page
   scan's map is small enough that decoding all of it to answer a question about
   one page is acceptable. A three-hour transcript is not. The deferred option —
   group the geometry by page while keeping one `text` string — has an obvious
   temporal counterpart in windowing by time, and time-based media is the case
   that forces the decision.

## Adding a media type

Add the row; the drift-lock will tell you what else is required. Then decide
each axis knowingly:

- **`anchoring` is the irreversible one.** Every annotation created against the
  type inherits it, and selectors are fixed at birth. Choosing `spatial` commits
  you to geometry-first anchoring and to a text-recovery story if quotes are
  wanted; choosing `text-selector` commits you to the text being the bytes. If
  the type is time-based, read the section above first — the axis needs
  extending before the row can be written honestly, and a row that understates
  its anchoring model is not something later annotations can be migrated off.
- **`extractText: 'none'` is a valid destination**, not a placeholder. It means
  no embedding, no search, and no AI detection for that type.
- **Extraction that costs real time needs an artifact and a key.** Anything
  above passthrough cost should be content-addressed by checksum, written once,
  stored where `clean` can reclaim it, and re-derivable when absent. The PDF path
  is the reference implementation.
- **Row order matters** for extension lookup: `.xml`, `.yaml`, `.js`, `.ts` and
  `.webm` collide, and resolve to the first row declaring them.

## Related

- **[../system/ANCHORING.md](../system/ANCHORING.md)** — the anchoring pipeline in depth.
- **[../protocol/W3C-SELECTORS.md](../protocol/W3C-SELECTORS.md)** — the selector types, and which apply to which anchoring model.
- **[../system/PROJECTION-PATTERN.md](../system/PROJECTION-PATTERN.md)** — the read-your-writes barrier step 8 relies on.
- **[../protocol/TRANSPORT-CONTRACT.md](../protocol/TRANSPORT-CONTRACT.md)** — where the artifact crosses a process boundary.
