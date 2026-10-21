module github.com/The-AI-Alliance/semiont/packages/sdk-go

go 1.27

// Pinned to the patch, not the minor: `go 1.27` alone lets CI resolve to
// whatever 1.27.x it happens to have, and a stdlib CVE fixed in a later patch
// then fails govulncheck on a compiler nobody chose. actions/setup-go reads
// this line from go-version-file, so the scan and the build agree on one
// compiler.
toolchain go1.27.3

require (
	github.com/google/uuid v1.6.0
	github.com/oapi-codegen/runtime v1.7.0
)

require github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
