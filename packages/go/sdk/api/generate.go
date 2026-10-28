// Package api is the Semiont API's REST client and its wire types, generated
// from the OpenAPI authority (specs/openapi.json) — the same single source of
// truth the TypeScript SDK's types derive from. Generation is FULL-SURFACE by
// deliberate choice: filtering machinery would solve a scale problem this
// spec does not have, and every operation is a complete typed HTTP call,
// not a stub. Regenerate after any spec change with `go generate ./...`
// (containerized — no host Go needed), then commit the result.
//
// The SDK's own client is the module's root package, semiont; this package is
// what it and the launcher send and receive.
package api

//go:generate sh -c "cd ../../../.. && container run --rm -v $(pwd):/w -w /w golang:$(scripts/ci/go-toolchain.sh) go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.6.0 -config packages/go/sdk/oapi-codegen.yaml -o packages/go/sdk/api/client_gen.go specs/openapi.json"
