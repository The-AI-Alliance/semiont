# MIME Types and File Extensions

How @semiont/content handles media types and file extensions.

## Overview

The package maps MIME types to file extensions so derived storage URIs and exported files carry proper extensions for filesystem browsing and external tool compatibility.

From [src/mime-extensions.ts](../src/mime-extensions.ts): The package includes mappings for 80+ common MIME types.

## File Extension Mapping

### Common Types

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
'image/png'     → '.png'
'image/jpeg'    → '.jpg'
'image/svg+xml' → '.svg'

// Programming languages
'text/javascript'   → '.js'
'text/x-typescript' → '.ts'
'text/x-python'     → '.py'
'text/x-shell'      → '.sh'
```

From [src/mime-extensions.ts](../src/mime-extensions.ts): The `MIME_TO_EXTENSION` constant defines all mappings.

### Unknown Types

Unknown MIME types default to `.dat`:

```typescript
const ext = getExtensionForMimeType('unknown/type');
// Returns: '.dat'
```

## Usage

### Getting Extensions

```typescript
import { getExtensionForMimeType } from '@semiont/content';

// Known type
getExtensionForMimeType('text/markdown');  // '.md'

// Type with parameters (parameters stripped before lookup)
getExtensionForMimeType('text/plain; charset=utf-8');  // '.txt'

// Unknown type
getExtensionForMimeType('custom/format');  // '.dat'
```

### Checking Known Types

```typescript
import { hasKnownExtension } from '@semiont/content';

hasKnownExtension('image/png');      // true
hasKnownExtension('custom/format');  // false
```

### Deriving Storage URIs

`deriveStorageUri()` combines a slugified resource name with the MIME extension to produce a `file://` URI for the working tree:

```typescript
import { deriveStorageUri } from '@semiont/content';

deriveStorageUri('My Document', 'text/markdown');
// 'file://my-document.md'

deriveStorageUri('Q3 Sales & Marketing', 'application/pdf');
// 'file://q3-sales-marketing.pdf'
```

The name is lowercased, runs of non-alphanumeric characters collapse to single hyphens, and leading/trailing hyphens are stripped.

## Case Sensitivity

MIME types are case-insensitive per RFC 2045; lookups normalize to lowercase:

```typescript
getExtensionForMimeType('TEXT/PLAIN')  // '.txt'
getExtensionForMimeType('text/plain')  // '.txt'
getExtensionForMimeType('Text/Plain')  // '.txt'
```

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

Extensions are looked up automatically wherever the mapping is used.

## References

- MIME types specification: [RFC 2045](https://datatracker.ietf.org/doc/html/rfc2045)
- Media type registry: [IANA Media Types](https://www.iana.org/assignments/media-types/media-types.xhtml)
