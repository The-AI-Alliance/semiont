// Package semiont is the Go client for the Semiont API, generated from the
// OpenAPI authority (specs/openapi.json) — the same single source of truth
// the TypeScript SDK's types derive from. Generation is FULL-SURFACE by
// deliberate, measured choice (2026-07-24: 37 operations, ~7.7k lines,
// compiles clean): filtering machinery would solve a scale problem this
// spec does not have, and every operation is a complete typed HTTP call,
// not a stub. Regenerate after any spec change with `go generate ./...`
// (containerized — no host Go needed), then commit the result.
//
// The launcher (apps/launcher) is the first consumer, via a replace
// directive on this module's relative path. Publishing later is
// mechanical: drop the replace and push a packages/sdk-go/vX.Y.Z tag —
// the import path github.com/The-AI-Alliance/semiont/packages/sdk-go is
// already the permanent identity.
package semiont

//go:generate sh -c "cd ../.. && container run --rm -v $(pwd):/w -w /w golang:1.25 go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.6.0 -generate types,client -package semiont -o packages/sdk-go/client_gen.go specs/openapi.json"
