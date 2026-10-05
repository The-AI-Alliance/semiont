# archivist — the Archivist's HTTP surface

A second OpenAPI document, beside the gateway's `../openapi.json`: the routes
the Archivist serves over HTTP, which the gateway calls and a gateway in any
language must call the same way.

## Why it is its own document

Its routes are not the gateway's. Were they in `../openapi.json`, every
consumer of the gateway's API would believe the gateway serves them, and the
gateway, which refuses to start unless its routes are exactly its document's,
would have to. So the paths live here, and so does the one piece of protocol
that differs: the 401 (`responses/Unauthorized.json`), whose challenge names no
resource metadata, because the Archivist publishes none.

The shapes do not differ, so they are not repeated. Bodies `$ref` the shared
`../components/schemas/`, where they are also registered in the gateway's
document so that `@semiont/core` generates their types and validators. The
upload body (`ResourceUpload`) is one schema that both documents' `POST
/resources` name, because the gateway forwards it untouched.

## What holds each side to it

- `npm run lint:spec-protocol` holds this document to the same rules as the
  gateway's: every operation says whether it is public, every response has a
  body schema, every error is an `ErrorResponse`, every 401 carries its
  challenge, every operation declares a 500.
- The Archivist (`packages/make-meaning/src/archivist/archivist-read-path.ts`): its
  tests check every reply against this document, and fail when an operation
  here is not exercised.
- The gateway conformance suite's stand-in Archivist
  (`tests/conformance/harness/archivist.ts`): every request the gateway
  sends it must be an operation declared here, and every reply the stand-in
  gives must match its declaration.
