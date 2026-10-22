# Core API Tour

What `@semiont/core` exports, area by area, with an example of each. The small utilities have a guide of their own: [Utilities](Utilities.md).

## OpenAPI Types (Generated)

TypeScript types generated from the OpenAPI specification - the **source of truth** for all API schemas:

```typescript
import type { components, paths, operations } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];
type Resource = components['schemas']['ResourceDescriptor'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
```

These types are generated during the build process:
```bash
npm run generate:openapi  # Bundles spec → generates types.ts
```

The spec's validators and limits come from the same bundle, on the
`@semiont/core/openapi` subpath:

```typescript
import { validators, operationLimits, itemLimits } from '@semiont/core/openapi';

validators.BusEmitRequest(body);                          // Ajv, compiled at build
operationLimits['POST /bus/emit'].claimSeconds;           // an operation's x-semiont-limits
itemLimits['BusSubscribeRequest.pendingReplies'];         // a property's maxItems
```

## Branded Types

Compile-time type safety for tokens and identifiers:

```typescript
import { accessToken, entityType } from '@semiont/core';

const token = accessToken('eyJhbGc...');
const eType = entityType('Person');
```

The four kinds of id are types of their own, generated from the spec ([`specs/src/identifiers/kinds.json`](../../../specs/src/identifiers/kinds.json) and each kind's schema): `ResourceId`, `AnnotationId`, `JobId`, `UserId`. The spec's types carry them, so a property that holds an id is of its kind and one kind is not assignable to another. Each is made by its constructor (`resourceId`, `annotationId`, `jobId`, `userId`), which holds text to the kind's rule and throws a `TypeError` for text the rule refuses:

```typescript
import { resourceId, annotationId } from '@semiont/core';

const resource = resourceId('5bcd259ab1464cf68a556bbad21f513f');
resourceId('https://kb.example/resources/5bcd259ab1464cf68a556bbad21f513f'); // throws: a URI is not an id
const annotation = annotationId('a-1');
// client.mark.delete(annotation, resource) does not compile
```

Each kind also has a guard (`isResourceId`, `isAnnotationId`, `isJobId`, `isUserId`) that asks the same rule without throwing and narrows the text to the kind. Use it where text that is not an id is an ordinary answer, such as an address typed into a browser:

```typescript
import { isResourceId } from '@semiont/core';

if (!isResourceId(params.id)) return notFound();
const descriptor = await client.browse.resource(params.id).fresh();
```

A resource is named by its `ResourceId` wherever it is named: an annotation target's `source`, a reference body's `source`, a bus frame's `scope`, and a description's `wasDerivedFrom`.

## Event Sourcing Types

The persisted event catalog — every event type written to the JSONL event log, discriminated on `type` and namespaced by concern (`yield:*` resource lifecycle, `mark:*` annotations and tags, `frame:*` schema registration, `person:*` display names, `job:*` job lifecycle):

```typescript
import type {
  PersistedEvent,
  PersistedEventType,
  EventOfType,
  EventInput,
  StoredEvent,
  EventMetadata,
  BodyOperation,
} from '@semiont/core';
import { PERSISTED_EVENT_TYPES } from '@semiont/core';

function handle(event: PersistedEvent) {
  if (event.type === 'mark:added') {
    // payload is narrowed to the AnnotationAdded payload
  }
}
```

`PERSISTED_EVENT_TYPES` is the runtime list of every persisted event type, generated with the catalog from the bus registry's `storedEvent` channels.

## EventBus

The RxJS-based event bus, with a typed channel protocol:

```typescript
import { EventBus, ScopedEventBus } from '@semiont/core';
import type { EventMap, EventName } from '@semiont/core';
```

- **`EventBus` / `ScopedEventBus`** — framework-agnostic pub/sub over the unified `EventMap`
- **`CHANNEL_SCHEMAS`** — maps each channel to its OpenAPI payload schema
- **`busLog` / `setBusLogTraceIdProvider`** — cross-wire bus observability

## Transport Contract

The interfaces every concrete transport must satisfy, plus the channel set transports bridge into a client's bus:

```typescript
import type { ITransport, IContentTransport, IGatewayOperations, ConnectionState } from '@semiont/core';
import { BRIDGED_CHANNELS } from '@semiont/core';
```

`@semiont/http-transport` implements these over HTTP + SSE.

## W3C Web Annotation Utilities

Pure functions for building and reading W3C Annotations:

```typescript
import {
  reconcile,
  annotationOfSpan,
  annotationOfResource,
  getBodySource,
  getTargetSelector,
  getExactText,
  isHighlight,
  isReference,
  isComment,
} from '@semiont/core';
```

Selector helpers cover text position, text quote, SVG, and PDF-viewrect fragment selectors (`getTextPositionSelector`, `getSvgSelector`, `createFragmentSelector`, `parseSvgSelector`, …).

## Anchoring

Re-anchor annotations after content edits — fuzzy text matching plus a render-time strategy that combines position and quote selectors with confidence scoring:

```typescript
import {
  anchorAnnotation,
  textOffsets,
} from '@semiont/core';
```

Every position these take or answer is an **offset**: it counts Unicode code
points from the start of the text, as a `TextPositionSelector` does. A
JavaScript string is indexed in UTF-16 code units, where a character outside
the Basic Multilingual Plane is two, so a caller that slices a string or hands
a position to something that indexes one converts with `textOffsets(text)`:
`indexAt(offset)` going in, `offsetAt(index)` coming out.

## PDF anchoring

Text paired with the geometry that indexes it, and the inverse pair that reads
it in either direction. Pure arithmetic over plain data — this is what *reasons
over* a coordinate map; producing one (text layer, OCR, tables, forms) is the
[Smelter](../../../docs/protocol/SMELTER.md)'s.

```typescript
import { locate, textUnder, type AnchoredText } from '@semiont/core';

// A model quoted text; find its geometry. One rect per line. The span is two
// offsets into anchored.text, in code points, as each item's start and end are.
const { rects } = locate(anchored, match.start, match.end);

// A person drew a box; find its text. '' when it covers no words.
const quote = textUnder(anchored, pdfCoordinate);
```

Coordinates are PDF points, origin bottom-left, Y increasing upward; the flip to
canvas pixels happens in the browser. `textUnder` counts a word as covered at
`RUN_COVERAGE_THRESHOLD` (50%) of its area rather than on any intersection —
with ~2pt of headroom between lines, a hand-drawn box that overshoots by less
than the height of a comma would otherwise pull in its neighbours.

See **[ANCHORING.md](../../../docs/architecture/ANCHORING.md)** for how a map is derived,
stored, served, and turned into a selector.

## DID Utilities

Generate and parse W3C Decentralized Identifiers for humans and software peers:

```typescript
import { userToDid, agentToDid, softwareToAgent, didToAgent } from '@semiont/core';

// A person is named by the issuer claim the knowledge base's `subjectClaim`
// selects, under its `site.domain`.
userToDid({ subject: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', domain: 'example.com' });
// => 'did:web:example.com:users:f47ac10b-58cc-4372-a567-0e02b2c3d479'

didToAgent('did:web:example.com:agents:ollama:gemma2%3A27b');
// => { '@type': 'Software', '@id': ..., name: 'ollama gemma2:27b', provider: 'ollama', model: 'gemma2:27b' }
```

## Error Classes

`SemiontError` is the base of every Semiont error: `BusRequestError` here, `APIError` in `@semiont/http-transport`, `SemiontSessionError` in `@semiont/sdk`. Each carries a `code` and optional `details`:

```typescript
import { SemiontError, BusRequestError } from '@semiont/core';

try {
  await request();
} catch (error) {
  if (error instanceof BusRequestError && error.code === 'bus.timeout') retry();
  else if (error instanceof SemiontError) report(error.code, error.details);
}
```

## Type Guards & Validation

```typescript
import { isString, isObject, isArray, isNumber, validateData, isValidEmail } from '@semiont/core';

if (isObject(value) && isString(value.name)) {
  // TypeScript knows value is a record, and value.name a string
}
```

## Resource & Misc Utilities

- **ResourceDescriptor accessors** — `getResourceId`, `getPrimaryRepresentation`, `getPrimaryMediaType`, `getResourceEntityTypes`, `isArchived`, `decodeRepresentation`, …
- **Locales** — `LOCALES`, `LOCALE_CODES`, `formatLocaleDisplay`
- **Media types** — `MEDIA_TYPES` capability registry keyed by the spec's `SupportedMediaType` enum (render / anchoring / text source / authorable per type), generated from `specs/src/media-types/registry.json`, with `capabilitiesOf`, `textSourceOf`, `yieldsGeometryOf`, `derivesTextOf`, `mediaTypeForExtension`, `baseMediaType`, …
- **Text encoding** — `decodeWithCharset`
- **Text context** — `extractContext`
- **SVG** — `createRectangleSvg`, `parseSvgSelector`, `scaleSvgToNative`, …
- **IDs** — `uuidV4`
