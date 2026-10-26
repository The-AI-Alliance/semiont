module github.com/The-AI-Alliance/semiont/packages/sdk-go/conformance

go 1.27

toolchain go1.27.3

require github.com/The-AI-Alliance/semiont/packages/sdk-go v0.0.0

require (
	github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/oapi-codegen/runtime v1.7.0 // indirect
)

// The SDK the drivers put through the suite is the one in this checkout.
replace github.com/The-AI-Alliance/semiont/packages/sdk-go => ../
