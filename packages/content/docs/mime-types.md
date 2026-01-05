# MIME Types and File Extensions

How @semiont/content handles media types and file extensions.

## Overview

The package maps MIME types to file extensions to ensure stored content has proper extensions for filesystem browsing and external tool compatibility.

From [src/mime-extensions.ts](../src/mime-extensions.ts): The package includes mappings for 80+ common MIME types.

## Media Type Structure

### Base Type vs Full Type

MIME types can include parameters:

```typescript
// Full media type with charset
"text/plain; charset=utf-8"

// Base media type (used for paths)
"text/plain"
```

From [src/representation-store.ts](../src/representation-store.ts): Lines 114 and 154 strip charset parameters using `split(';')[0].trim()`.

### Path vs Metadata

**For directory structure**: Only base type is used
```
representations/text~1plain/5a/aa/rep-{checksum}.txt
```

**For metadata**: Full type with parameters is preserved
```typescript
{
  mediaType: "text/plain; charset=iso-8859-1",  // Full type preserved
  checksum: "5aaa...",
  // ...
}
```

From [src/representation-store.ts](../src/representation-store.ts): The `store()` method preserves full mediaType in metadata (line 144) while using baseMediaType for paths.

## File Extension Mapping

### Common Types

The package includes mappings for common content types:

```typescript
// Text formats
'text/plain'     → '.txt'
'text/markdown'  → '.md'
'text/html'      → '.html'
'text/css'       → '.css'

// Application formats
'application/json' → '.json'
'application/pdf'  → '.pdf'
'application/zip'  → '.zip'

// Image formats
'image/png'  → '.png'
'image/jpeg' → '.jpg'
'image/svg+xml' → '.svg'

// Programming languages
'text/javascript'      → '.js'
'text/x-typescript'    → '.ts'
'text/x-python'        → '.py'
'application/x-sh'     → '.sh'
```

From [src/mime-extensions.ts](../src/mime-extensions.ts): The `MIME_TO_EXTENSION` constant defines all mappings.

### Unknown Types

Unknown MIME types default to `.dat`:

```typescript
const ext = getExtensionForMimeType('unknown/type');
// Returns: '.dat'
```

From [src/mime-extensions.ts](../src/mime-extensions.ts): Line 115 returns `.dat` for unmapped types.

## Usage

### Getting Extensions

```typescript
import { getExtensionForMimeType } from '@semiont/content';

// Known type
const mdExt = getExtensionForMimeType('text/markdown');
console.log(mdExt);  // '.md'

// Type with parameters (parameters ignored)
const txtExt = getExtensionForMimeType('text/plain; charset=utf-8');
console.log(txtExt);  // '.txt'

// Unknown type
const unknownExt = getExtensionForMimeType('custom/format');
console.log(unknownExt);  // '.dat'
```

From [src/mime-extensions.ts](../src/mime-extensions.ts): The `getExtensionForMimeType()` function (lines 107-116) handles all three cases.

### Checking Known Types

```typescript
import { hasKnownExtension } from '@semiont/content';

const isKnown = hasKnownExtension('image/png');
console.log(isKnown);  // true

const isUnknown = hasKnownExtension('custom/format');
console.log(isUnknown);  // false
```

From [src/mime-extensions.ts](../src/mime-extensions.ts): The `hasKnownExtension()` function (lines 124-127) checks if a type has a known mapping.

## Encoding Media Types for Paths

### Forward Slash Encoding

MIME types contain forward slashes which are directory separators on Unix systems. These are encoded:

```
text/markdown     → text~1markdown
application/json  → application~1json
image/svg+xml     → image~1svg+xml
```

The encoding scheme:
- `/` → `~1` (JSON Pointer encoding)
- Other characters unchanged

From [src/representation-store.ts](../src/representation-store.ts): The `encodeMediaType()` method (line 193) performs this encoding.

### Why JSON Pointer Encoding?

The `~1` encoding follows [RFC 6901 (JSON Pointer)](https://datatracker.ietf.org/doc/html/rfc6901):
- `~0` represents `~`
- `~1` represents `/`

Benefits:
- Standard encoding scheme
- Reversible if needed
- Filesystem-safe on all platforms

From [src/representation-store.ts](../src/representation-store.ts): Uses simple `replace(/\//g, '~1')` for encoding.

## Complete Example

### Storage Path Construction

For content with media type `text/markdown; charset=utf-8` and checksum `5aaa0b72...`:

```typescript
// 1. Extract base type
const fullType = "text/markdown; charset=utf-8";
const baseType = fullType.split(';')[0].trim();  // "text/markdown"

// 2. Encode for path
const encoded = baseType.replace(/\//g, '~1');    // "text~1markdown"

// 3. Get extension
const ext = getExtensionForMimeType(baseType);    // ".md"

// 4. Build path
const path = `representations/text~1markdown/5a/aa/rep-5aaa0b72....md`;
```

From [src/representation-store.ts](../src/representation-store.ts): Lines 113-133 implement this logic in the `store()` method.

## Character Encoding Preservation

### Charset in Metadata

Character set parameters are preserved in the stored metadata:

```typescript
const content = Buffer.from('Héllo', 'latin1');

const stored = await store.store(content, {
  mediaType: 'text/plain; charset=iso-8859-1'
});

console.log(stored.mediaType);
// "text/plain; charset=iso-8859-1" - full type preserved
```

From [src/representation-store.ts](../src/representation-store.ts): Line 144 spreads the original metadata including full mediaType.

### Storage Path

Only the base type affects the storage path:

```typescript
// These both store to the same directory:
'text/plain; charset=utf-8'       → .../text~1plain/.../
'text/plain; charset=iso-8859-1'  → .../text~1plain/.../

// But metadata preserves the full type
```

This allows:
- Consistent directory structure
- Preserved encoding information for decoding
- Proper handling of different encodings for same base type

## Supported Media Types

### Text Formats (6 types)

```
text/plain, text/markdown, text/html, text/css, text/csv, text/xml
```

### Application - Data (4 types)

```
application/json, application/xml, application/yaml, application/x-yaml
```

### Application - Documents (7 types)

```
application/pdf
application/msword, application/vnd.openxmlformats-officedocument.wordprocessingml.document
application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
application/vnd.ms-powerpoint, application/vnd.openxmlformats-officedocument.presentationml.presentation
```

### Application - Archives (4 types)

```
application/zip, application/gzip, application/x-tar, application/x-7z-compressed
```

### Application - Executables (2 types)

```
application/octet-stream, application/wasm
```

### Image Formats (8 types)

```
image/png, image/jpeg, image/gif, image/webp, image/svg+xml,
image/bmp, image/tiff, image/x-icon
```

### Audio Formats (6 types)

```
audio/mpeg, audio/wav, audio/ogg, audio/webm, audio/aac, audio/flac
```

### Video Formats (6 types)

```
video/mp4, video/mpeg, video/webm, video/ogg, video/quicktime, video/x-msvideo
```

### Programming Languages (16 types)

```
text/javascript, application/javascript
text/x-typescript, application/typescript
text/x-python, text/x-java, text/x-c, text/x-c++, text/x-csharp
text/x-go, text/x-rust, text/x-ruby, text/x-php
text/x-swift, text/x-kotlin, text/x-shell
```

### Font Formats (4 types)

```
font/woff, font/woff2, font/ttf, font/otf
```

From [src/mime-extensions.ts](../src/mime-extensions.ts): Complete mapping defined in `MIME_TO_EXTENSION` constant.

## Adding New MIME Types

To add support for new MIME types, update the mapping:

```typescript
// In mime-extensions.ts
const MIME_TO_EXTENSION: Record<string, string> = {
  // ... existing mappings ...

  // Add new type
  'application/custom': '.custom',
};
```

No changes needed to storage logic - extensions are looked up automatically.

## Case Sensitivity

MIME types are case-insensitive per RFC 2045:

```typescript
getExtensionForMimeType('TEXT/PLAIN')     // '.txt'
getExtensionForMimeType('text/plain')     // '.txt'
getExtensionForMimeType('Text/Plain')     // '.txt'
```

From [src/mime-extensions.ts](../src/mime-extensions.ts): Line 109 normalizes to lowercase before lookup.

## References

- MIME types specification: [RFC 2045](https://datatracker.ietf.org/doc/html/rfc2045)
- Media type registry: [IANA Media Types](https://www.iana.org/assignments/media-types/media-types.xhtml)
- JSON Pointer: [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)
- From [src/mime-extensions.ts](../src/mime-extensions.ts): Comprehensive MIME type to extension mapping
- From [src/representation-store.ts](../src/representation-store.ts): Media type handling in storage operations
