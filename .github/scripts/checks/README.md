# Repository checks

Repository-wide policy and workflow checks live here. `specs/` validates the
declarative specifications; `compliance/` contains architecture audits spanning owners.
Shared file, source-text, and workspace readers support these checks and checks
beside individual packages and images. The root `lint:*` commands invoke them.

Component-specific checks live beside their owner. The workflow compliance-audit
census includes those locations, so moving an audit does not remove its CI coverage.
