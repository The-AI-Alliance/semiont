# Semiont OpenAPI Specification

This directory contains the source-of-truth OpenAPI specification for the Semiont API.

## Directory Structure

```
specs/
├── README.md                   # This file
├── src/                        # Source OpenAPI files (tracked in git)
│   ├── openapi.json           # The gateway's API: root spec with $ref to all paths and schemas
│   ├── archivist/             # The Archivist's HTTP surface: a second document (see its README)
│   ├── paths/                 # Individual endpoint definitions (37 files)
│   │   ├── resources_{id}.json
│   │   ├── annotations_{id}.json
│   │   └── ...
│   └── components/
│       └── schemas/           # Schema definitions (79 files)
│           ├── Annotation.json
│           ├── CreateResourceRequest.json
│           └── ...
├── openapi.json                # Generated bundle (NOT tracked in git)
└── archivist.openapi.json      # The Archivist's, bundled (NOT tracked in git)
```

The OpenAPI specification source lives in this directory; the human-readable API and W3C compliance documentation lives in [docs/protocol/](../docs/protocol/).

## Spec-First Architecture

The OpenAPI specification is the **source of truth** for the entire API:

1. **Source**: `specs/src/openapi.json` and referenced files (tracked in git)
2. **Build**: Bundled to `specs/openapi.json` by Redocly (generated, gitignored)
3. **Types**: TypeScript types generated from bundled spec → `@semiont/core`
4. **Consumption**: `@semiont/http-transport` and gateway import types from `@semiont/core`

```
specs/src/openapi.json          (source - in git)
        ↓
   npm run openapi:bundle
        ↓
specs/openapi.json              (generated - gitignored)
        ↓
   openapi-typescript
        ↓
@semiont/core/src/types.ts      (generated types - source of truth)
        ↓
@semiont/http-transport re-exports types (for convenience)
        ↓
gateway and Browser import from core
```

## Working with the Spec

### View the Specification

**Source files** (edit these):
- Root: [src/openapi.json](src/openapi.json)
- Paths: [src/paths/](src/paths/)
- Schemas: [src/components/schemas/](src/components/schemas/)

**Bundled spec** (generated, for consumption):
- Generated: `specs/openapi.json` (create by running `npm run openapi:bundle`)
- Live endpoint: `http://localhost:4000/api/openapi.json` (when gateway is running)

### Edit the Specification

1. **Modify source files** in `specs/src/`:
   ```bash
   # Edit a schema
   vi specs/src/components/schemas/Annotation.json

   # Edit an endpoint
   vi specs/src/paths/resources_{id}.json
   ```

2. **Bundle and validate**:
   ```bash
   npm run openapi:bundle    # Bundle source → specs/openapi.json and specs/archivist.openapi.json
   npm run openapi:lint      # Lint source files
   npm run lint:spec-protocol  # The spec states the whole gateway protocol
   ```

   `lint:spec-protocol` ([scripts/spec/check-protocol.mjs](../scripts/spec/check-protocol.mjs))
   fails when the spec leaves something to be learned from the gateway's code
   instead: an operation that does not say whether it is public, a 401 with no
   challenge header, a response with no body schema, an error whose body is not
   `ErrorResponse`, an operation with no 500 (or with a request body and no
   400), an operation that takes a JSON body with no `maxBodyBytes` limit or no
   413, a stream whose event names, frame or id formats no schema names, or a
   limit in `x-semiont-limits` that is not a positive integer.

3. **Regenerate types** (happens automatically during build):
   ```bash
   npm run build:packages    # Bundles spec + generates types + builds packages
   ```

### View Statistics

```bash
npm run openapi:stats
```

Shows:
- 43 operations across 37 paths
- 79 schemas
- 15 tags
- 22 parameters

### Preview Documentation

```bash
npm run openapi:preview     # Launch interactive docs viewer
npm run openapi:build-docs  # Generate static HTML docs
```

## Schema Organization

All 79 schemas are defined in [src/components/schemas/](src/components/schemas/):

**Core W3C Types:**
- `Annotation.json` - W3C Web Annotation
- `AnnotationBody.json` - Annotation body (entity tags, links)
- `AnnotationTarget.json` - Annotation target (text selection)
- `TextPositionSelector.json` - Character offset selector
- `TextQuoteSelector.json` - Exact/prefix/suffix selector
- `SpecificResource.json` - W3C SpecificResource
- `Representation.json` - W3C content representation

**Request/Response Types:**
- `CreateResourceRequest.json`, `CreateResourceResponse.json`
- `CreateAnnotationRequest.json`
- `UpdateResourceRequest.json`, etc.

**Authentication:**
- `ProtectedResourceMetadata.json`, `UserResponse.json`

**Entity Management:**
- `AddEntityTypeRequest.json`, `GetEntityTypesResponse.json`

See [src/components/schemas/](src/components/schemas/) for complete list.

## Path Organization

All 37 path definitions in [src/paths/](src/paths/):

**Resources:**
- `resources.json` - List/create resources
- `resources_{id}.json` - CRUD single resource
- `resources_{id}_annotations.json` - Resource annotations
- `resources_{id}_llm-context.json` - Graph context for LLM

**Annotations:**
- `resources_{resourceId}_annotations_{annotationId}.json` - CRUD annotation
- `resources_{resourceId}_annotations_{annotationId}_body.json` - Update body

**Authentication:**
- `well-known_oauth-protected-resource.json` - Which issuer this gateway trusts (RFC 9728)
- `api_tokens_agent.json` - Software-agent token exchange
- `api_tokens_media.json` - Resource-scoped media token
- `api_users_me.json` - Current user profile

**Admin:**
- `api_admin_users.json` - List users
- `api_admin_users_{id}.json` - Manage user

See [src/paths/](src/paths/) for complete list.

## API Documentation

High-level guides in [docs/protocol/](../docs/protocol/):

- **[README.md](../docs/protocol/README.md)** - The protocol: the eight verbs, the bus, and what holds across them
- **[W3C-WEB-ANNOTATION.md](../docs/protocol/W3C-WEB-ANNOTATION.md)** - W3C Annotation Model details
- **[W3C-SELECTORS.md](../docs/protocol/W3C-SELECTORS.md)** - Selector specifications

For implementation details:
- [Gateway Documentation](../apps/gateway/README.md) - Gateway architecture
- [API Client Documentation](../packages/http-transport/README.md) - TypeScript SDK

## Decomposition Notes

The spec is kept as modular files, bundled with Redocly:

**Why decomposed?**
- **Maintainability**: Easier to edit individual endpoints/schemas
- **Collaboration**: Reduced merge conflicts
- **Organization**: Logical file structure mirrors API
- **Tooling**: Better IDE support for smaller files

**Important**: The `components` section in [src/openapi.json](src/openapi.json) must list ALL schemas with `$ref` entries, even if not directly referenced by paths. This ensures transitive dependencies (schemas referenced by other schemas) are included in the bundle.

## Configuration

[redocly.yaml](../redocly.yaml) states the rules `npm run openapi:lint` holds the two API documents to: Redocly's recommended set, with the changes the file gives its reasons for. The lint is one of the Lint Gates of the architecture workflow.

The forms the rules bear on:

- **An operation** has an `operationId`, the name a generated client's method takes. A path item is one operation's, so a path that answers as another does has a path item of its own.
- **A property that admits one value** states it as an `enum` of one. `const` is JSON Schema's and not OpenAPI 3.0's; the lint refuses it, and so does the Rust type generator.
- **A reference that may be null** is `{ "nullable": true, "allOf": [{ "$ref": … }] }`. The validators and every SDK's type generator read it as the reference, or null.
- **Something said of a reference** is `{ "allOf": [{ "$ref": … }], "description": … }`. OpenAPI 3.0 reads nothing beside a bare `$ref`, and the Go and Rust generators hold to that, so a description written there reaches neither. Two kinds of reference are never wrapped, and `npm run lint:spec-reference-forms` holds both: a member of a `oneOf` stays a bare `$ref`, with what would be said of it said of the `oneOf` (the Go client names a union's accessors by a wrapped member's position); and a reference to a schema that has a `discriminator` stays a bare `$ref` with its description beside it (openapi-typescript takes the discriminator's property out of a wrapped one), named in [.redocly.lint-ignore.yaml](../.redocly.lint-ignore.yaml).
- **An operation documents a refusal**, a response in the 400s. The five that take no credential and no parameter have none to document, and [.redocly.lint-ignore.yaml](../.redocly.lint-ignore.yaml) names them.

Bundling takes no configuration: a schema is kept in the bundle because `components` lists it.

## Related Documentation

- [Root README](../README.md) - Project overview
- [Architecture](../docs/architecture/README.md) - System architecture index
- [Gateway README](../apps/gateway/README.md) - Gateway implementation
- [@semiont/http-transport](../packages/http-transport/README.md) - HTTP + SSE wire adapters
- [@semiont/sdk](../packages/sdk/README.md) - The TypeScript client built over them

---

**For API usage**: Start with [docs/protocol/README.md](../docs/protocol/README.md), then [@semiont/http-transport](../packages/http-transport/docs/API-Reference.md) for the wire adapters

**For spec editing**: Edit files in [src/](src/), then run `npm run openapi:bundle`

**For type generation**: Run `npm run build:packages` (bundles + generates types + builds)
