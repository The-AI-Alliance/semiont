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
const position = findTextWithContext(wrongText, 'café', ...);
// Offsets will be INCORRECT because character positions don't match backend

// ✅ RIGHT - Uses charset from mediaType
const rightText = decodeWithCharset(buffer, mediaType);
const position = findTextWithContext(rightText, 'café', ...);
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

### Validate and Correct AI Offsets

Validate AI-provided annotation offsets with fuzzy matching tolerance:

```typescript
import { validateAndCorrectOffsets } from '@semiont/api-client';

const content = "The quick brown fox jumps over the lazy dog.";

// AI said start=0, end=9, exact="The quick"
const result = validateAndCorrectOffsets(content, 0, 9, "The quick");

if (result.corrected) {
  console.log(`AI offset was wrong. Corrected to ${result.start}-${result.end}`);
  console.log(`Match quality: ${result.matchQuality}`); // 'exact' | 'case-insensitive' | 'fuzzy'
}

console.log({
  start: result.start,
  end: result.end,
  exact: result.exact,
  prefix: result.prefix,
  suffix: result.suffix
});
```

**Multi-Strategy Matching:**
1. Check if AI's offsets are exactly correct
2. Try exact case-sensitive search
3. Try case-insensitive search
4. Try fuzzy matching with Levenshtein distance (5% tolerance)

**Use Case:** AI models sometimes return offsets that don't match the actual text position, or provide text with minor variations (case differences, whitespace, typos). This function ensures maximum tolerance while maintaining annotation quality.

## Fuzzy Anchoring

W3C Web Annotation TextQuoteSelector implementation with fuzzy matching. Uses prefix/suffix context to disambiguate when the same text appears multiple times.

### Find Text with Context

Find text in content using exact match with optional prefix/suffix:

```typescript
import { findTextWithContext } from '@semiont/api-client';

const content = "The cat sat. The cat ran. The cat slept.";

// Find first occurrence (no context needed)
const pos1 = findTextWithContext(content, "The cat");
// Returns: { start: 0, end: 7 }

// Find second occurrence using prefix context
const pos2 = findTextWithContext(content, "The cat", "sat. ", null);
// Returns: { start: 13, end: 20 }

// Find third occurrence using both prefix and suffix
const pos3 = findTextWithContext(content, "The cat", "ran. ", " slept");
// Returns: { start: 26, end: 33 }
```

**How It Works:**

1. **Find all occurrences** of exact text
2. **If only one match** → Return immediately (no disambiguation needed)
3. **If multiple matches** → Use prefix/suffix to find the correct one:
   - First try **exact** prefix/suffix match
   - Then try **fuzzy** match (handles whitespace variations)
   - Finally **fallback** to first occurrence (with warning)

**Fuzzy Matching:**

When exact prefix/suffix don't match, fuzzy matching handles whitespace variations:

```typescript
const content = "Hello  World"; // Two spaces

// Exact match would fail due to whitespace difference
findTextWithContext(content, "World", "Hello ", null);
// Uses fuzzy match, returns: { start: 7, end: 12 }
```

**Error Handling:**

```typescript
// Text not found
const pos = findTextWithContext(content, "nonexistent");
// Returns: null
// Console warning: "[FuzzyAnchor] Text not found: ..."

// Multiple matches but no context match
const pos = findTextWithContext(content, "the", "wrong prefix", null);
// Returns: first occurrence (fallback)
// Console warning: "[FuzzyAnchor] Multiple matches but no context match..."
```

### Verify Position

Validate that a position correctly points to expected text:

```typescript
import { verifyPosition, findTextWithContext } from '@semiont/api-client';

const content = "Hello World";
const position = findTextWithContext(content, "World");

// Verify position is correct
const isValid = verifyPosition(content, position, "World");
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

Structural analysis frameworks for document classification. Tag schemas define categories that passages can be classified into based on their structural role.

### Available Schemas

```typescript
import {
  getAllTagSchemas,
  getTagSchema,
  getTagSchemasByDomain,
  getSchemaCategory,
  isValidCategory
} from '@semiont/api-client';

// Get all available schemas
const schemas = getAllTagSchemas();
// Returns: [{ id: 'legal-irac', name: 'Legal Analysis (IRAC)', ... }, ...]

// Get schemas by domain
const legalSchemas = getTagSchemasByDomain('legal');
const scientificSchemas = getTagSchemasByDomain('scientific');
const generalSchemas = getTagSchemasByDomain('general');
```

### Built-in Schemas

**Legal Domain:**
- **IRAC** (`legal-irac`) - Issue, Rule, Application, Conclusion

**Scientific Domain:**
- **IMRAD** (`scientific-imrad`) - Introduction, Methods, Results, Discussion

**General Domain:**
- **Toulmin** (`argument-toulmin`) - Claim, Evidence, Warrant, Counterargument, Rebuttal

### Working with Schemas

```typescript
import { getTagSchema, getSchemaCategory, isValidCategory } from '@semiont/api-client';

// Get a specific schema
const schema = getTagSchema('legal-irac');
console.log(schema?.name); // "Legal Analysis (IRAC)"
console.log(schema?.tags); // [{ name: 'Issue', description: '...', examples: [...] }, ...]

// Get a specific category from a schema
const category = getSchemaCategory('legal-irac', 'Rule');
console.log(category?.description); // "The relevant law, statute, or legal principle"
console.log(category?.examples); // ["What law applies?", "What is the legal standard?", ...]

// Validate category name
if (isValidCategory('legal-irac', 'Rule')) {
  console.log('Valid category!');
}
```

### Tag Schema Structure

```typescript
interface TagSchema {
  id: string;
  name: string;
  description: string;
  domain: 'legal' | 'scientific' | 'general';
  tags: TagCategory[];
}

interface TagCategory {
  name: string;
  description: string;
  examples: string[];
}
```

**Use Case:** Tag schemas enable AI-powered structural analysis of documents. For example, detecting which passages in a legal brief serve as "Issue", "Rule", "Application", or "Conclusion" sections.

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
