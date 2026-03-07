# Semiont OpenAPI Specification

This directory contains the source-of-truth OpenAPI specification for the Semiont API.

## Directory Structure

```
specs/
├── README.md                   # This file
├── src/                        # Source OpenAPI files (tracked in git)
│   ├── openapi.json           # Root spec with $ref to all paths and schemas
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
└── docs/                       # API documentation
    ├── API.md                 # API overview and capabilities
    ├── W3C-WEB-ANNOTATION.md  # W3C Annotation Model implementation
    └── W3C-SELECTORS.md       # W3C selector specifications
```

## Spec-First Architecture

The OpenAPI specification is the **source of truth** for the entire API:

1. **Source**: `specs/src/openapi.json` and referenced files (tracked in git)
2. **Build**: Bundled to `specs/openapi.json` by Redocly (generated, gitignored)
3. **Types**: TypeScript types generated from bundled spec → `@semiont/core`
4. **Consumption**: `@semiont/api-client` and backend import types from `@semiont/core`

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
@semiont/api-client re-exports types (for convenience)
        ↓
backend and frontend import from core
```

## Working with the Spec

### View the Specification

**Source files** (edit these):
- Root: [src/openapi.json](src/openapi.json)
- Paths: [src/paths/](src/paths/)
- Schemas: [src/components/schemas/](src/components/schemas/)

**Bundled spec** (generated, for consumption):
- Generated: `specs/openapi.json` (create by running `npm run openapi:bundle`)
- Live endpoint: `http://localhost:4000/api/openapi.json` (when backend is running)

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
   npm run openapi:bundle    # Bundle source → specs/openapi.json
   npm run openapi:lint      # Lint source files
   npm run openapi:validate  # Validate bundled output
   ```

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

## NPM Scripts

Defined in [package.json](../package.json):

```json
{
  "openapi:bundle": "redocly bundle specs/src/openapi.json -o specs/openapi.json",
  "openapi:lint": "redocly lint specs/src/openapi.json",
  "openapi:validate": "redocly lint specs/openapi.json",
  "openapi:stats": "redocly stats specs/src/openapi.json",
  "openapi:preview": "redocly preview-docs specs/src/openapi.json"
}
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
- `CreateAnnotationRequest.json`, `CreateAnnotationResponse.json`
- `UpdateResourceRequest.json`, etc.

**Authentication:**
- `AuthResponse.json`, `TokenRefreshRequest.json`, `UserResponse.json`

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
- `api_tokens_google.json` - Google OAuth
- `api_tokens_local.json` - Local dev auth
- `api_tokens_refresh.json` - Token refresh
- `api_users_me.json` - Current user profile

**Admin:**
- `api_admin_users.json` - List users
- `api_admin_users_{id}.json` - Manage user

See [src/paths/](src/paths/) for complete list.

## API Documentation

High-level guides in [docs/](docs/):

- **[API.md](docs/API.md)** - API overview, capabilities, and quick reference
- **[W3C-WEB-ANNOTATION.md](docs/W3C-WEB-ANNOTATION.md)** - W3C Annotation Model details
- **[W3C-SELECTORS.md](docs/W3C-SELECTORS.md)** - Selector specifications

For implementation details:
- [Backend Documentation](../apps/backend/README.md) - Backend architecture
- [API Client Documentation](../packages/api-client/README.md) - TypeScript SDK

## Decomposition Notes

The spec was decomposed into modular files on 2024-11-06 using Redocly:

**Why decomposed?**
- **Maintainability**: Easier to edit individual endpoints/schemas
- **Collaboration**: Reduced merge conflicts
- **Organization**: Logical file structure mirrors API
- **Tooling**: Better IDE support for smaller files

**Migration from monolithic spec:**
```bash
# One-time split operation (already done)
npx redocly split specs/openapi.json --outDir specs/src
```

**Important**: The `components` section in [src/openapi.json](src/openapi.json) must list ALL schemas with `$ref` entries, even if not directly referenced by paths. This ensures transitive dependencies (schemas referenced by other schemas) are included in the bundle.

## Configuration

OpenAPI bundling configured in [.redocly.yaml](../.redocly.yaml):

```yaml
apis:
  semiont@v1:
    root: specs/src/openapi.json

bundle:
  output: specs/openapi.json
  dereferenceInlineSchemas: false  # Keep all schemas, even if "unused"
```

The `dereferenceInlineSchemas: false` setting is **critical** - it prevents Redocly from removing schemas that are only referenced by other schemas (not directly by paths).

## API Statistics

Generated from `npm run openapi:stats`:

- **Operations**: 43 endpoints
- **Paths**: 37 path items
- **Schemas**: 79 type definitions
- **Tags**: 15 categories
- **Parameters**: 22 reusable parameters
- **References**: 60 $ref links

## Related Documentation

- [Root README](../README.md) - Project overview
- [Architecture Documentation](../docs/ARCHITECTURE.md) - System architecture
- [Backend README](../apps/backend/README.md) - Backend implementation
- [API Client README](../packages/api-client/README.md) - TypeScript SDK
- [OpenAPI Split Plan](../OPENAPI-SPLIT-PLAN.md) - Migration details (historical)

---

**For API usage**: Start with [docs/API.md](docs/API.md)

**For spec editing**: Edit files in [src/](src/), then run `npm run openapi:bundle`

**For type generation**: Run `npm run build:packages` (bundles + generates types + builds)
