# Media Types

**The media-type registry lives in [@semiont/core](../../core/), not here.**
`packages/core/src/media-types.ts` is where TypeScript reads which types
Semiont admits (the `SupportedMediaType` enum, authored in the OpenAPI spec),
their canonical extensions, and their capabilities (render, anchoring, text
source, authorable, uploadable, generatable). Its table is generated from
`specs/src/media-types/registry.json`, the single source of truth.

The store in this package takes `file://` URIs; the function that builds one
from a name and a media type lives in `@semiont/core` beside the registry it
reads:

## deriveStorageUri

```typescript
import { deriveStorageUri } from '@semiont/core';

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

## Other lookups in `@semiont/core`

- `extensionForMediaType` — the extension for any media-type string
  (lenient, `.dat` fallback — for naming foreign/imported content)
- `isSupportedMediaType` / `capabilitiesOf` — whether a type is admitted, and
  what the system can do with it
- `MEDIA_TYPES` — the registry itself, extensions included
