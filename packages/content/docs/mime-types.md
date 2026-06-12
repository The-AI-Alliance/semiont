# Media Types

**The media-type registry lives in [@semiont/core](../../core/), not here.**
`packages/core/src/media-types.ts` is the single source of truth for which
types Semiont admits (the `SupportedMediaType` enum, authored in the OpenAPI
spec), their canonical extensions, and their capabilities (render, anchoring,
text extraction, authorable, uploadable). See
`.plans/MEDIA-TYPES.md` at the repo root for the design.

What this package owns is one consumer of that registry:

## deriveStorageUri

```typescript
import { deriveStorageUri } from '@semiont/content';

deriveStorageUri('My Document', 'text/markdown');
// => 'file://my-document.md'

deriveStorageUri('Q3 Sales & Marketing', 'application/pdf');
// => 'file://q3-sales-marketing.pdf'
```

The name is lowercased, runs of non-alphanumeric characters collapse to
single hyphens, and leading/trailing hyphens are stripped. The extension is
the registry's canonical extension for the given `SupportedMediaType`. The
format is typed, not validated here — validation happens upstream at the
create/yield boundary.

## Looking for something that used to be here?

- `getExtensionForMimeType` → `extensionForMediaType` in `@semiont/core`
  (lenient, `.dat` fallback — for naming foreign/imported content)
- `hasKnownExtension` → `isSupportedMediaType` / `capabilitiesOf` in
  `@semiont/core`
- The extension table (`MIME_TO_EXTENSION`) → the `MEDIA_TYPES` registry in
  `@semiont/core`
