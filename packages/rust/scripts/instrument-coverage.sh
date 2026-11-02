#!/bin/sh
# instrument-coverage.sh — cargo's RUSTC_WORKSPACE_WRAPPER for build-rust in
# .github/workflows/ci.yml: the workspace's own crates are compiled instrumented
# for coverage, and their dependencies as they are. cargo calls it with rustc
# and its arguments, for workspace members only.
#
# Instrumenting the dependencies too (RUSTFLAGS) slowed the binaries enough that
# the conformance suites' timing cases failed: JSON, schema validation and HTTP
# are dependencies' code, and Rust Coverage leaves their lines out of its report
# anyway.
exec "$@" -C instrument-coverage
