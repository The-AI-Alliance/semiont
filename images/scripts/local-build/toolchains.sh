#!/usr/bin/env bash
# Read a toolchain only when the operation needs it.

load_go_toolchain() {
# --- Go toolchain (derived, not restated) ---
#
# The Go version is a fact apps/launcher/go.mod owns. Every workflow derives
# it (actions/setup-go's go-version-file), and so does this script: go.mod pins
# the PATCH so the scan and the build agree on one compiler, and a local build
# silently using a different one defeats exactly that.
#
# No fallback. A missing toolchain line fails here rather than quietly selecting
# some other compiler.
if ! GO_TOOLCHAIN="$("$REPO_ROOT/packages/go/scripts/go-toolchain.sh")"; then
  fail "No 'toolchain goX.Y.Z' line in apps/launcher/go.mod — cannot choose a Go image."
  exit 1
fi
GO_IMAGE="golang:${GO_TOOLCHAIN}"
}

load_rust_toolchain() {
# --- Rust toolchain (derived, not restated) ---
#
# The gateway image compiles its binary with the toolchain
# rust-toolchain.toml pins, passed to its Dockerfile as
# RUST_TOOLCHAIN. No fallback, as for Go.
if ! RUST_TOOLCHAIN="$("$REPO_ROOT/packages/rust/scripts/rust-toolchain.sh")"; then
  fail "No channel in packages/rust/rust-toolchain.toml — cannot choose a Rust image."
  exit 1
fi
}

load_python_toolchain() {
# --- Python toolchain (derived, not restated) ---
#
# The oldest Python the SDK supports is a fact packages/python/sdk/pyproject.toml
# owns (requires-python), and the SDK's generator runs on that one, here as in
# CI. No fallback, as for Go.
if ! PYTHON_FLOOR="$("$REPO_ROOT/packages/python/scripts/python-floor.sh")"; then
  fail "No 'requires-python = \">=X.Y\"' line in packages/python/sdk/pyproject.toml — cannot choose a Python image."
  exit 1
fi
PYTHON_IMAGE="python:${PYTHON_FLOOR}-alpine"
}

load_node_toolchain() {
# --- Node toolchain (derived, not restated) ---
#
# The Node that builds and tests the repository is a fact .node-version owns.
# Every workflow derives it (actions/setup-node's node-version-file), and so
# does this script, for the image the packages are built and published in.
# No fallback, as for Go.
if ! NODE_VERSION="$("$REPO_ROOT/packages/typescript/scripts/node-version.sh")"; then
  fail "No version in .node-version — cannot choose a Node image."
  exit 1
fi
NODE_IMAGE="node:${NODE_VERSION}-alpine"
}

load_jdk_toolchain() {
# --- JDK (derived, not restated) ---
#
# The JDK the Kotlin SDK is built on is a fact packages/kotlin/sdk/.java-version
# owns. CI's setup-java reads it (java-version-file), the SDK's Gradle build
# takes it as its toolchain, and this script derives the image from it. No
# fallback, as for Go. Gradle and Kotlin are the wrapper's and the version
# catalog's, which the wrapper reads itself.
if ! JDK_VERSION="$("$REPO_ROOT/packages/kotlin/scripts/jdk-version.sh")"; then
  fail "No JDK version in packages/kotlin/sdk/.java-version — cannot choose a JDK image."
  exit 1
fi
JDK_IMAGE="eclipse-temurin:${JDK_VERSION}-jdk"
}

load_swift_toolchain() {
SWIFT_VERSION="$("$REPO_ROOT/packages/swift/scripts/swift-version.sh")" || exit 1
SWIFT_IMAGE="swift:${SWIFT_VERSION}"
}

load_dotnet_toolchain() {
# The .NET SDK is pinned by global.json; its image tag drops the prerelease build stamp.
DOTNET_IMAGE="mcr.microsoft.com/dotnet/sdk:$("$REPO_ROOT/packages/csharp/scripts/dotnet-version.sh" --image-tag)"
}
