module github.com/The-AI-Alliance/semiont/apps/launcher

go 1.25

require (
	github.com/The-AI-Alliance/semiont/packages/sdk-go v0.0.0-00010101000000-000000000000
	github.com/oapi-codegen/runtime v1.6.0
	github.com/pelletier/go-toml/v2 v2.4.3
)

require (
	github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
)

replace github.com/The-AI-Alliance/semiont/packages/sdk-go => ../../packages/sdk-go
