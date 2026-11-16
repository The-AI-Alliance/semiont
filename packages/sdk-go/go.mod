module github.com/The-AI-Alliance/semiont/packages/sdk-go

go 1.25

// Pinned to the patch, not the minor: `go 1.25` let CI resolve to whatever
// 1.25.x it had (1.25.12), which govulncheck fails on — five stdlib CVEs, all
// fixed in 1.25.13. actions/setup-go reads this line from go-version-file, so
// the scan and the build agree on one compiler.
toolchain go1.25.13

require (
	github.com/google/uuid v1.6.0
	github.com/oapi-codegen/runtime v1.6.0
)

require github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
