module github.com/The-AI-Alliance/semiont/packages/sdk-go

go 1.27

// Pinned to the patch, not the minor: `go 1.27` alone lets CI resolve to
// whatever 1.27.x it happens to have, and a stdlib CVE fixed in a later patch
// then fails govulncheck on a compiler nobody chose. actions/setup-go reads
// this line from go-version-file, so the scan and the build agree on one
// compiler.
//
// 1.25.13 -> 1.27.1 (2026-09-08): CI installs govulncheck @latest, v1.8.0
// published requiring go >= 1.26, and every Go job went red against
// GOTOOLCHAIN=local. The floor moves with the tool.
toolchain go1.27.1

require (
	github.com/google/uuid v1.6.0
	github.com/oapi-codegen/runtime v1.7.0
)

require github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
