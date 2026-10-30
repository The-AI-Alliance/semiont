# Core Utilities

The small helpers of `@semiont/core`, each with a worked example: text encoding, the context around a span of text, anchoring an annotation to its text, SVG selectors, and reading a resource's description. The larger areas of the package are in the [API tour](API.md).

All of them are plain functions in the main import, which runs in a browser as well as in Node.

## Text Encoding

What text a resource's bytes are. The rule is protocol: [the text of a resource](../../../../docs/protocol/W3C-SELECTORS.md#the-text-of-a-resource) states it, as the MIME Sniffing Standard reads a content type and the Encoding Standard reads the bytes, and every reader of a resource keeps it. A TextPositionSelector's offsets are counted in that text, so a reader that made another text of the same bytes would count into the wrong place.

### Decode with Charset

A text's bytes as the text they are. This is the one place TypeScript makes a text of bytes: [`decodeRepresentation`](#decode-resource-content) reads with it, and so the SDK's `browse.resourceContent` does, and the Browser calls it itself. It reads whatever bytes it is handed: which media types have bytes that are a text is `decodeRepresentation`'s to say.

```typescript
import { decodeWithCharset } from '@semiont/core';

// UTF-8 document (default)
const buffer1 = new Uint8Array([72, 101, 108, 108, 111]);
const text1 = decodeWithCharset(buffer1.buffer, 'text/plain');
// Returns: 'Hello'

// ISO-8859-1 legacy document
const buffer2 = new Uint8Array([0xE9, 0xE0]); // é à in ISO-8859-1
const text2 = decodeWithCharset(buffer2.buffer, 'text/plain; charset=iso-8859-1');
// Returns: 'éà' (correctly decoded)

// Windows-1252 document
const buffer3 = new Uint8Array([0x93, 0x94]); // Smart quotes in Windows-1252
const text3 = decodeWithCharset(buffer3.buffer, 'text/plain; charset=windows-1252');
// Returns: '“”' (correctly decoded)
```

**Why This Matters:**

A TextPositionSelector offset counts the Unicode code points of the text as it was decoded, in the **original character space**. The Browser must decode content using the **same charset** as the worker that calculated the offsets, or they count into another text.

```typescript
// ❌ WRONG - Uses UTF-8 for ISO-8859-1 document
const wrongText = new TextDecoder('utf-8').decode(buffer);
const span = reconcile(wrongText, { exact: 'café' });
// Offsets will be INCORRECT because character positions don't match the worker

// ✅ RIGHT - Uses charset from mediaType
const rightText = decodeWithCharset(buffer, mediaType);
const span = reconcile(rightText, { exact: 'café' });
// Offsets will be CORRECT
```

**What it reads:**

- The charset is a label of the [Encoding Standard](https://encoding.spec.whatwg.org/), and names the encoding the standard gives it: `iso-8859-1`, `latin1` and `ascii` are windows-1252.
- With no charset stated, UTF-8.
- Bytes that begin with the byte-order mark of UTF-8, UTF-16BE or UTF-16LE are in that encoding, whatever charset was stated, and the mark is not part of the text.
- What the encoding does not have is U+FFFD.
- A charset that is no label of the standard, or that the platform's `TextDecoder` does not decode, throws a `SemiontError` whose `code` is `error` and whose message names the charset. Nothing is read as UTF-8 in its place.

The cases are [`specs/src/text/decode-cases.json`](../../../../specs/src/text/decode-cases.json) and [`specs/src/text/encoding-cases.json`](../../../../specs/src/text/encoding-cases.json), which the Rust, Python and Go SDKs' readers run too.

## Text Context Extraction

Utilities for extracting prefix/suffix context around text selections and validating AI-generated annotation offsets.

Every `start` and `end` here is an **offset**: it counts Unicode code points from the start of the text, as a W3C TextPositionSelector does. A JavaScript string is indexed in UTF-16 code units, where a character outside the Basic Multilingual Plane (an emoji, a mathematical letter, some CJK) is two, so the two counts differ after the first such character. `textOffsets` converts, once for a text:

```typescript
import { textOffsets } from '@semiont/core';

const content = "a😀 brown fox";
const offsets = textOffsets(content);

offsets.offsetAt(content.indexOf("brown")); // 3: the offset of a position in the string
content.slice(offsets.indexAt(3), offsets.indexAt(8)); // "brown": the positions of two offsets
offsets.length; // 12: the text's length in code points
```

### Extract Context

Extract prefix and suffix context for W3C TextQuoteSelector:

```typescript
import { extractContext } from '@semiont/core';

const content = "The United States Congress passed the bill.";
const start = 4;   // the offset of "United"
const end = 17;    // the offset just after "States"

const { prefix, suffix } = extractContext(content, start, end);
// prefix: "The "
// suffix: " Congress passed the bill."
```

**Features:**
- Extracts up to 64 code points before and after
- Extends to word boundaries (avoids cutting words)
- Returns `undefined` for prefix/suffix at document boundaries

### Reconcile What a Model Quoted

The LLM does not supply offsets — it supplies `exact` (a verbatim substring) plus optional prefix/suffix context. `reconcile` computes `start`/`end` by searching the source, producing a span whose offsets (in code points) are provably consistent with the source content. The content is a plain string:

```typescript
import { reconcile } from '@semiont/core';

const content = "The quick brown fox jumps over the lazy dog.";

const span = reconcile(content, {
  exact: "The quick",
});

if (span) {
  console.log({
    start: span.start,
    end: span.end,
    exact: span.exact,        // always a substring of source
    prefix: span.prefix,      // extracted from source, never carried from LLM
    suffix: span.suffix,      // extracted from source, never carried from LLM
    anchorMethod: span.anchorMethod, // 'unique-match' | 'context-recovered' | 'fuzzy-match' | 'first-of-many'
  });
} else {
  // The LLM emitted text that doesn't appear in the source.
  // Caller filters; `reconcile` doesn't decide.
}
```

**Anchor methods:**
- `unique-match` — Exact appears once; re-anchored unambiguously.
- `context-recovered` — Multiple occurrences; LLM-emitted prefix/suffix picked one.
- `fuzzy-match` — Exact not found verbatim; recovered by a looser search, which `matchQuality` names: `normalized` (white space, quotation marks and dashes), `case-insensitive`, or `fuzzy` (edit distance). Of several places the first two find, the LLM-emitted prefix/suffix picks one, and the first is taken when it picks none.
- `first-of-many` — Multiple occurrences, no usable context; risky fallback flagged for audit.

A prefix or suffix that is empty, or only white space, is no context.

The `fuzzy` search allows one edit (a code point inserted, deleted or replaced) for every twenty code points of `exact`, rounded down, with no minimum: an `exact` of fewer than twenty code points is found by the searches before it or not at all. The span it answers is the source's own, and may be longer or shorter than `exact`.

Returns `null` when `exact` is empty or only white space, or is text that doesn't appear in source. [`specs/src/annotations/reconcile-cases.json`](../../../../specs/src/annotations/reconcile-cases.json) holds the rule, as cases.

**Use Case:** Worker-side annotation construction. The span `reconcile` returns is what `annotationOfSpan` takes.

### Build the Annotation

`annotationOfSpan` builds the annotation of a span: its selectors, its `id`, and the body and `generator` as given. `annotationOfResource` builds an annotation of a resource as a whole, with no selector. Each annotation's `id` is derived from what it is (the resource, the motivation, the body and where the span is), so building it again builds the same id.

```typescript
import { annotationOfResource, annotationOfSpan, reconcile, resourceId, SpanRefusedError, type components } from '@semiont/core';

const content = "The quick brown fox jumps over the lazy dog.";
// The agent the worker signed in as, by the DID the gateway named it with, and the engine it ran.
const generator: components['schemas']['Agent'] = {
  '@type': 'Software',
  '@id': 'did:web:kb.example:agents:semiont-worker',
  name: 'ollama gemma3',
  provider: 'ollama',
  model: 'gemma3',
};

const span = reconcile(content, { exact: "brown fox" });
if (span) {
  const highlight = annotationOfSpan({
    text: content,
    resourceId: resourceId('doc-123'),
    generator,
    motivation: 'highlighting',
    span,
  });
}

// A span that is not the text's is refused, and the error's `code` names the refusal.
try {
  annotationOfSpan({
    text: content,
    resourceId: resourceId('doc-123'),
    generator,
    motivation: 'highlighting',
    span: { start: 4, end: 9, exact: 'brown' },
  });
} catch (error) {
  if (error instanceof SpanRefusedError) console.log(error.code); // 'exact-mismatch'
}

// The link from a resource to one generated from it: an annotation of the whole resource.
const link = annotationOfResource({
  resourceId: resourceId('doc-123'),
  motivation: 'linking',
  generator,
  body: { type: 'SpecificResource', source: resourceId('doc-456'), purpose: 'linking' },
});
```

For a PDF, give `annotationOfSpan` the PDF's `anchored` text in place of `text`: the annotation has one `FragmentSelector` for each line the span is on, and no `TextPositionSelector`.

**Refusals** (`SpanRefusal`): `span-out-of-range`, `exact-mismatch`, `prefix-mismatch`, `suffix-mismatch`, and for a PDF `nothing-located`, `exact-not-covered` and `item-out-of-range`. The last is said of the PDF's anchored text and not of the span: one of its items is no stretch of its text, so no span of it is built. [`specs/src/annotations/builder-cases.json`](../../../../specs/src/annotations/builder-cases.json) holds the rule, as cases.

## Render-Time Anchoring

`anchorAnnotation` is the renderer's counterpart to `reconcile`. It is **verbatim-only**: it re-anchors on an exact `TextQuoteSelector` match and otherwise renders at the stored offset, flagged — it never fuzzy-matches at render time. The stored selectors are written to agree, so the only legitimate render-time discrepancy is *positional drift* (content shifted above the span). Position is a locality signal used to break ties among verbatim occurrences when context isn't unique. The position given and the anchor answered are offsets, in code points. It takes the content's `textOffsets`, which a renderer with several annotations of one content makes once.

```typescript
import { anchorAnnotation, textOffsets } from '@semiont/core';

const content = "Section A: the parties agree. Section B: the parties agree.";
const offsets = textOffsets(content);

// The stored offset is stale (off by one); the verbatim quote + prefix
// still resolve the intended occurrence.
const anchor = anchorAnnotation(content, offsets, {
  position: { start: 40, end: 57 },
  quote: {
    exact: "the parties agree",
    prefix: "Section B: ",
  },
});

console.log(anchor);
// {
//   start: 41, end: 58,
//   strategy: 'context-disambiguated',
//   confidence: 'high',
// }
```

**Strategies:**
- `fast-path` — stored offset already lands on the exact text (high confidence).
- `unique-occurrence` — exact appears once verbatim in content (high).
- `context-disambiguated` — multiple verbatim occurrences; prefix/suffix identified one.
- `position-tiebreaker` — multiple verbatim candidates; position chose closest.
- `position-fallback` — exact not found verbatim (or no quote); raw stored offset used, flagged low-confidence for upstream correction.

**Use Case:** Renderer-side anchoring. The returned `strategy` and `confidence` let the UI flag low-confidence anchors with a visual affordance. Fuzzy/normalized recovery is deliberately *not* here — it lives at write time in `reconcile`.

## SVG Utilities

W3C-compliant SVG selector creation and parsing for image annotation.

### Create Rectangle SVG

```typescript
import { createRectangleSvg } from '@semiont/core';

const svg = createRectangleSvg(
  { x: 10, y: 20 },  // Top-left corner
  { x: 100, y: 80 }  // Bottom-right corner
);

console.log(svg);
// Output: <svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="90" height="60"/></svg>
```

### Create Polygon SVG

```typescript
import { createPolygonSvg } from '@semiont/core';

const svg = createPolygonSvg([
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 50, y: 100 }
]);

console.log(svg);
// Output: <svg xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 100,0 50,100"/></svg>
```

### Create Circle SVG

```typescript
import { createCircleSvg } from '@semiont/core';

const svg = createCircleSvg(
  { x: 50, y: 50 },  // Center
  30                 // Radius
);

console.log(svg);
// Output: <svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="30"/></svg>
```

### Parse SVG Selector

Extract shape type and data from SVG string:

```typescript
import { parseSvgSelector } from '@semiont/core';

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="90" height="60"/></svg>';

const parsed = parseSvgSelector(svg);
console.log(parsed);
// Output: { type: 'rect', data: { x: 10, y: 20, width: 90, height: 60 } }
```

### Scale SVG to Native Resolution

Scale entire SVG selector from display dimensions to image native resolution:

```typescript
import { scaleSvgToNative } from '@semiont/core';

// SVG created on 800x600 display
const displaySvg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="90" height="60"/></svg>';

// Scale to 3200x2400 native image
const nativeSvg = scaleSvgToNative(
  displaySvg,
  800, 600,    // Display dimensions
  3200, 2400   // Native image dimensions
);

console.log(nativeSvg);
// Output: <svg xmlns="http://www.w3.org/2000/svg"><rect x="40" y="80" width="360" height="240"/></svg>
```

**Why This Matters:**

Image annotations must be stored using **native image coordinates**, not display coordinates. Otherwise, annotations will break when the image is displayed at different sizes.

## Resource Utilities

Helper functions for working with W3C ResourceDescriptor objects.

### Get Resource Properties

```typescript
import {
  getResourceId,
  getPrimaryRepresentation,
  getPrimaryMediaType,
  getLanguage,
  getStorageUri,
  isArchived,
  getResourceEntityTypes,
  isDraft,
  type ResourceDescriptor
} from '@semiont/core';

const resource: ResourceDescriptor = /* ... */;

// Get the resource's id
const id = getResourceId(resource);
// "5bcd259ab1464cf68a556bbad21f513f" — the bare id, never a URI

// Get primary representation: the only one, or the first of the list;
// undefined for an empty list. A resource whose `representations` is neither
// one representation nor a list of them is no ResourceDescriptor, and is
// refused with a SemiontError whose code is 'error'.
const rep = getPrimaryRepresentation(resource);
console.log(rep?.mediaType); // "text/plain"
console.log(rep?.checksum); // "sha256:..."

// Get metadata
const mediaType = getPrimaryMediaType(resource);
const language = getLanguage(resource);
const storageUri = getStorageUri(resource);

// Get application-specific fields
const archived = isArchived(resource);
const entityTypes = getResourceEntityTypes(resource); // ["legal", "contract"]
const draft = isDraft(resource);
```

### Decode Resource Content

Read a representation's bytes as the text they are, for a media type whose bytes are its text. The reading is `decodeWithCharset`'s, above: the one every reader of a resource's text keeps.

A media type whose text is derived from its bytes (a PDF), or that has no text (an image), is refused, and the refusal names the media type. A `text/` type the registry does not list is read. [`specs/src/text/decode-cases.json`](../../../../specs/src/text/decode-cases.json) holds that too: its cases are run through this function, as the Rust, Python and Go SDKs run them through theirs.

```typescript
import { decodeRepresentation, getPrimaryRepresentation, getPrimaryMediaType, type ResourceDescriptor } from '@semiont/core';

const resource: ResourceDescriptor = /* ... */;
const buffer: Buffer = /* raw bytes from storage */;

// Get media type with charset
const mediaType = getPrimaryMediaType(resource) || 'text/plain';

// Throws a SemiontError whose code is 'error' for a media type whose bytes
// are not its text (a PDF, an image), and for a charset that is not decoded
const content = decodeRepresentation(buffer, mediaType);
```
