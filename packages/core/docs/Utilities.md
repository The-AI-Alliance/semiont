# Utility Functions Guide

Framework-agnostic utilities for working with W3C annotations, events, and resources. These utilities work in any JavaScript environment (Node.js, Browser, Deno, etc.) and have **zero React dependencies**.

## Table of Contents

- [Text Encoding](#text-encoding)
- [Text Context Extraction](#text-context-extraction)
- [Fuzzy Anchoring](#fuzzy-anchoring)
- [SVG Utilities](#svg-utilities)
- [Tag Schemas](#tag-schemas)
- [Annotation Utilities](#annotation-utilities)
- [Event Utilities](#event-utilities)
- [Resource Utilities](#resource-utilities)
- [Validation Utilities](#validation-utilities)

## Text Encoding

Character set utilities for consistent text encoding across the system. Critical for maintaining TextPositionSelector offset accuracy when documents use non-UTF-8 encodings.

### Extract Charset

Extract charset parameter from media type string:

```typescript
import { extractCharset } from '@semiont/api-client';

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
import { decodeWithCharset } from '@semiont/api-client';

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
// Returns: '""' (correctly decoded)
```

**Why This Matters:**

When creating annotations, the backend calculates TextPositionSelector offsets in the **original character space**. The frontend must decode content using the **same charset** to ensure offsets align correctly.

```typescript
// ❌ WRONG - Uses UTF-8 for ISO-8859-1 document
const wrongText = new TextDecoder('utf-8').decode(buffer);
const sel = reconcileSelector(wrongText, { exact: 'café' });
// Offsets will be INCORRECT because character positions don't match backend

// ✅ RIGHT - Uses charset from mediaType
const rightText = decodeWithCharset(buffer, mediaType);
const sel = reconcileSelector(rightText, { exact: 'café' });
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

### Extract Context

Extract prefix and suffix context for W3C TextQuoteSelector:

```typescript
import { extractContext } from '@semiont/api-client';

const content = "The United States Congress passed the bill.";
const start = 4;   // "United"
const end = 17;    // "States"

const { prefix, suffix } = extractContext(content, start, end);
// prefix: "The "
// suffix: " Congress passed the bill."
```

**Features:**
- Extracts up to 64 characters before and after
- Extends to word boundaries (avoids cutting words)
- Returns `undefined` for prefix/suffix at document boundaries

### Reconcile LLM-Emitted Selectors

The LLM does not supply offsets — it supplies `exact` (a verbatim substring) plus optional prefix/suffix context. `reconcileSelector` computes `start`/`end` by searching the source, producing a selector whose offsets are provably consistent with the source content:

```typescript
import { reconcileSelector } from '@semiont/core';

const content = "The quick brown fox jumps over the lazy dog.";

const result = reconcileSelector(content, {
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
- `fuzzy-match` — Exact not found verbatim; recovered via case/whitespace/Levenshtein.
- `first-of-many` — Multiple occurrences, no usable context; risky fallback flagged for audit.

Returns `null` only when the LLM emitted text that doesn't appear in source at all.

**Use Case:** Worker-side annotation construction. The selector returned by `reconcileSelector` is the only shape that passes the no-overlap invariant in `buildTextAnnotation` at write time.

## Render-Time Anchoring

`anchorAnnotation` is the renderer's counterpart to `reconcileSelector`. It is **verbatim-only**: it re-anchors on an exact `TextQuoteSelector` match and otherwise renders at the stored offset, flagged — it never fuzzy-matches at render time. The stored selectors are written to agree, so the only legitimate render-time discrepancy is *positional drift* (content shifted above the span). Position is a locality signal used to break ties among verbatim occurrences when context isn't unique.

```typescript
import { anchorAnnotation } from '@semiont/core';

const content = "Section A: the parties agree. Section B: the parties agree.";

// The stored offset is stale (off by one); the verbatim quote + prefix
// still resolve the intended occurrence.
const anchor = anchorAnnotation(content, {
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

### Verify Position

Validate that a position correctly points to expected text:

```typescript
import { verifyPosition } from '@semiont/core';

const content = "Hello World";

// Verify a known position
const isValid = verifyPosition(content, { start: 6, end: 11 }, "World");
// Returns: true

// Check for corruption
const isValid2 = verifyPosition(content, { start: 0, end: 5 }, "World");
// Returns: false (position points to "Hello", not "World")
```

## SVG Utilities

W3C-compliant SVG selector creation and parsing for image annotation.

### Create Rectangle SVG

```typescript
import { createRectangleSvg } from '@semiont/api-client';

const svg = createRectangleSvg(
  { x: 10, y: 20 },  // Top-left corner
  { x: 100, y: 80 }  // Bottom-right corner
);

console.log(svg);
// Output: <svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="90" height="60"/></svg>
```

### Create Polygon SVG

```typescript
import { createPolygonSvg } from '@semiont/api-client';

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
import { createCircleSvg } from '@semiont/api-client';

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
import { parseSvgSelector } from '@semiont/api-client';

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="90" height="60"/></svg>';

const parsed = parseSvgSelector(svg);
console.log(parsed);
// Output: { type: 'rect', data: { x: 10, y: 20, width: 90, height: 60 } }
```

### Normalize Coordinates

Convert coordinates from display space to image native resolution:

```typescript
import { normalizeCoordinates } from '@semiont/api-client';

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
import { scaleSvgToNative } from '@semiont/api-client';

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

## Tag Schemas

Structural-analysis frameworks for document classification. A `TagSchema` defines categories that passages can be classified into based on their structural role (e.g. IRAC for legal reasoning, IMRAD for scientific papers, Toulmin for argumentation).

Tag schemas are **runtime-registered per knowledge base** via `frame.addTagSchema(...)` from the SDK. The `TagSchema` and `TagCategory` *types* are exported from `@semiont/core`; the schema *data* lives with the KB that uses it (typically a `src/tag-schemas.ts` module in the KB repo). See [`docs/protocol/skills/semiont-tag/SKILL.md`](../../../docs/protocol/skills/semiont-tag/SKILL.md) for the full protocol-level story.

### Type Shape

```typescript
import type { TagSchema, TagCategory } from '@semiont/core';

interface TagSchema {
  id: string;
  name: string;
  description: string;
  domain: string;        // free-form hint ('legal', 'scientific', 'general', or whatever the KB uses)
  tags: TagCategory[];
}

interface TagCategory {
  name: string;
  description: string;
  examples: string[];
}
```

### Registering and enumerating

```typescript
import { SemiontClient, type TagSchema } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({ /* ... */ });

// Register at runtime — idempotent (same content re-registered is silent)
const SCHEMA: TagSchema = { id: 'my-schema', name: '...', /* ... */ };
await semiont.frame.addTagSchema(SCHEMA);

// Enumerate registered schemas (cached, refreshes on frame:tag-schema-added)
const all = await semiont.browse.tagSchemas();
```

**Use Case:** Tag schemas enable AI-powered structural analysis of documents — `mark.assist(rid, 'tagging', { schemaId, categories })` detects which passages serve as Issue / Rule / Application / Conclusion in a legal brief, or Introduction / Methods / Results / Discussion in a research paper.

## Annotation Utilities

See [API-Reference.md](./API-Reference.md#annotation-utilities) for annotation manipulation functions.

## Event Utilities

See [API-Reference.md](./API-Reference.md#event-utilities) for event filtering and manipulation functions.

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
  isDraft
} from '@semiont/api-client';

const resource: ResourceDescriptor = /* ... */;

// Extract ID from full URI
const id = getResourceId(resource);
// "doc-abc123" from "http://localhost:4000/resources/doc-abc123"

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
const derivedFrom = getDerivedFrom(resource); // Source resource URI

// Get application-specific fields
const archived = isArchived(resource);
const entityTypes = getResourceEntityTypes(resource); // ["legal", "contract"]
const draft = isDraft(resource);
```

### Decode Resource Content

Decode representation buffer using correct charset:

```typescript
import { decodeRepresentation, getPrimaryRepresentation, getPrimaryMediaType } from '@semiont/api-client';

const resource: ResourceDescriptor = /* ... */;
const buffer: Buffer = /* raw bytes from storage */;

// Get media type with charset
const mediaType = getPrimaryMediaType(resource) || 'text/plain';

// Decode using correct charset
const content = decodeRepresentation(buffer, mediaType);
// Handles UTF-8, ISO-8859-1, Windows-1252, etc.
```

See also [API-Reference.md](./API-Reference.md#resource-utilities) for complete documentation.

## Validation Utilities

See [API-Reference.md](./API-Reference.md#validation-utilities) for validation functions.

## Type Safety

All utilities use TypeScript interfaces for type safety:

```typescript
import type { TextPosition, Point, BoundingBox } from '@semiont/api-client';

// TextPosition interface
interface TextPosition {
  start: number;
  end: number;
}

// Point interface (for SVG)
interface Point {
  x: number;
  y: number;
}

// BoundingBox interface
interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

## Framework Independence

All utilities are **pure TypeScript functions** with zero dependencies on React, Vue, Angular, or any other framework. They work anywhere JavaScript runs:

- ✅ Node.js (CLI tools, MCP servers)
- ✅ Browser (React, Vue, vanilla JS)
- ✅ Deno
- ✅ Bun
- ✅ Edge runtimes (Cloudflare Workers, Vercel Edge)

## See Also

- [Usage Guide](./Usage.md) - API client usage examples
- [API Reference](./API-Reference.md) - Complete method documentation
- [README](../README.md) - Package overview
