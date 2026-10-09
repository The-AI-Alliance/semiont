# Core Utilities

The small helpers of `@semiont/core`, each with a worked example: text encoding, the context around a span of text, anchoring an annotation to its text, SVG selectors, and reading a resource's description. The larger areas of the package are in the [API tour](API.md).

All of them are plain functions in the main import, which runs in a browser as well as in Node.

## Text Encoding

Character set utilities for consistent text encoding across the system. Critical for maintaining TextPositionSelector offset accuracy when documents use non-UTF-8 encodings.

### Extract Charset

Extract charset parameter from media type string:

```typescript
import { extractCharset } from '@semiont/core';

const charset1 = extractCharset('text/plain; charset=iso-8859-1');
// Returns: 'iso-8859-1'

const charset2 = extractCharset('text/markdown');
// Returns: 'utf-8' (default)

const charset3 = extractCharset('text/html; charset=UTF-8');
// Returns: 'utf-8' (normalized to lowercase)
```

### Decode with Charset

Decode binary data using the charset from media type:

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
const sel = reconcileSelector(wrongText, textOffsets(wrongText), { exact: 'café' });
// Offsets will be INCORRECT because character positions don't match the worker

// ✅ RIGHT - Uses charset from mediaType
const rightText = decodeWithCharset(buffer, mediaType);
const sel = reconcileSelector(rightText, textOffsets(rightText), { exact: 'café' });
// Offsets will be CORRECT
```

**Supported Charsets:**

- `utf-8` (default)
- `iso-8859-1` through `iso-8859-15` (Latin-1 through Latin-9)
- `windows-1252`, `windows-1251`, etc.
- `ascii`, `us-ascii`
- `utf-16le`, `utf-16be`

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

### Reconcile LLM-Emitted Selectors

The LLM does not supply offsets — it supplies `exact` (a verbatim substring) plus optional prefix/suffix context. `reconcileSelector` computes `start`/`end` by searching the source, producing a selector whose offsets (in code points) are provably consistent with the source content. It takes the content's `textOffsets`, which a caller with several proposals over one content makes once:

```typescript
import { reconcileSelector, textOffsets } from '@semiont/core';

const content = "The quick brown fox jumps over the lazy dog.";
const offsets = textOffsets(content);

const result = reconcileSelector(content, offsets, {
  exact: "The quick",
});

if (!result) {
  // The LLM emitted text that doesn't appear in the source.
  // Caller filters; the helper doesn't decide.
}

console.log({
  start: result.start,
  end: result.end,
  exact: result.exact,        // always a substring of source
  prefix: result.prefix,      // extracted from source, never carried from LLM
  suffix: result.suffix,      // extracted from source, never carried from LLM
  anchorMethod: result.anchorMethod, // 'unique-match' | 'context-recovered' | 'fuzzy-match' | 'first-of-many'
});
```

**Anchor methods:**
- `unique-match` — Exact appears once; re-anchored unambiguously.
- `context-recovered` — Multiple occurrences; LLM-emitted prefix/suffix picked one.
- `fuzzy-match` — Exact not found verbatim; recovered by a looser search, which `matchQuality` names: `normalized` (white space, quotation marks and dashes), `case-insensitive`, or `fuzzy` (edit distance). Of several places the first two find, the LLM-emitted prefix/suffix picks one, and the first is taken when it picks none.
- `first-of-many` — Multiple occurrences, no usable context; risky fallback flagged for audit.

A prefix or suffix that is empty, or only white space, is no context.

The `fuzzy` search allows one edit (a code point inserted, deleted or replaced) for every twenty code points of `exact`, rounded down, with no minimum: an `exact` of fewer than twenty code points is found by the searches before it or not at all. The span it answers is the source's own, and may be longer or shorter than `exact`.

Returns `null` when `exact` is empty or only white space, or is text that doesn't appear in source. [`specs/src/annotations/reconcile-cases.json`](../../../specs/src/annotations/reconcile-cases.json) holds the rule, as cases.

**Use Case:** Worker-side annotation construction. The selector returned by `reconcileSelector` is the only shape that passes the no-overlap invariant in `buildTextAnnotation` at write time.

## Render-Time Anchoring

`anchorAnnotation` is the renderer's counterpart to `reconcileSelector`. It is **verbatim-only**: it re-anchors on an exact `TextQuoteSelector` match and otherwise renders at the stored offset, flagged — it never fuzzy-matches at render time. The stored selectors are written to agree, so the only legitimate render-time discrepancy is *positional drift* (content shifted above the span). Position is a locality signal used to break ties among verbatim occurrences when context isn't unique. The position given and the anchor answered are offsets, in code points. It takes the content's `textOffsets`, which a renderer with several annotations of one content makes once.

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

**Use Case:** Renderer-side anchoring. The returned `strategy` and `confidence` let the UI flag low-confidence anchors with a visual affordance. Fuzzy/normalized recovery is deliberately *not* here — it lives at write time in `reconcileSelector`.

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

### Normalize Coordinates

Convert coordinates from display space to image native resolution:

```typescript
import { normalizeCoordinates } from '@semiont/core';

// User clicked at (100, 200) on a 800x600 display
// But the actual image is 3200x2400 pixels
const nativePoint = normalizeCoordinates(
  { x: 100, y: 200 },  // Display coordinates
  800, 600,            // Display dimensions
  3200, 2400           // Native image dimensions
);

console.log(nativePoint);
// Output: { x: 400, y: 800 }
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
  getChecksum,
  getStorageUri,
  getCreator,
  getDerivedFrom,
  isArchived,
  getResourceEntityTypes,
  isDraft,
  type ResourceDescriptor
} from '@semiont/core';

const resource: ResourceDescriptor = /* ... */;

// Get the resource's id
const id = getResourceId(resource);
// "5bcd259ab1464cf68a556bbad21f513f" — the bare id, never a URI

// Get primary representation
const rep = getPrimaryRepresentation(resource);
console.log(rep?.mediaType); // "text/plain"
console.log(rep?.checksum); // "sha256:..."

// Get metadata
const mediaType = getPrimaryMediaType(resource);
const language = getLanguage(resource);
const checksum = getChecksum(resource);
const storageUri = getStorageUri(resource);

// Get provenance
const creator = getCreator(resource); // Agent who created it
const derivedFrom = getDerivedFrom(resource); // Source resource id

// Get application-specific fields
const archived = isArchived(resource);
const entityTypes = getResourceEntityTypes(resource); // ["legal", "contract"]
const draft = isDraft(resource);
```

### Decode Resource Content

Decode representation buffer using correct charset:

```typescript
import { decodeRepresentation, getPrimaryRepresentation, getPrimaryMediaType, type ResourceDescriptor } from '@semiont/core';

const resource: ResourceDescriptor = /* ... */;
const buffer: Buffer = /* raw bytes from storage */;

// Get media type with charset
const mediaType = getPrimaryMediaType(resource) || 'text/plain';

// Decode using correct charset
const content = decodeRepresentation(buffer, mediaType);
// Handles UTF-8, ISO-8859-1, Windows-1252, etc.
```
