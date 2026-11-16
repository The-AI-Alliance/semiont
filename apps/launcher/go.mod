module github.com/The-AI-Alliance/semiont/apps/launcher

go 1.25

// Pinned to the patch, not the minor: `go 1.25` let CI resolve to whatever
// 1.25.x it had (1.25.12), which govulncheck fails on — five stdlib CVEs, all
// fixed in 1.25.13. actions/setup-go reads this line from go-version-file, so
// the scan and the build agree on one compiler.
toolchain go1.25.13

require (
	github.com/The-AI-Alliance/semiont/packages/sdk-go v0.0.0-00010101000000-000000000000
	github.com/oapi-codegen/runtime v1.7.0
	github.com/pelletier/go-toml/v2 v2.4.3
)

require (
	github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
)

replace github.com/The-AI-Alliance/semiont/packages/sdk-go => ../../packages/sdk-go
