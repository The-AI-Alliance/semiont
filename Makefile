.DEFAULT_GOAL := help

# `make help` prints the `##` lines below, in order (images/scripts/make-help.awk).
##@ Usage: make <target> [VARIABLE=value ...], one target per run

# Keep values as arguments, including command-line selectors Make would otherwise export.
unexport PACKAGE_NAMES IMAGE_NAMES FORCE FANOUT LAYER_CACHE
##@ Variables
## PACKAGE_NAMES=list: language[/name],..., e.g. rust,typescript/sdk
PACKAGE_NAMES ?=
## IMAGE_NAMES=list: Images, e.g. browser,worker
IMAGE_NAMES ?=
## FORCE=1: Rebuild what is selected even when it is unchanged
FORCE ?= 0
## FANOUT=0: Leave images only in the runtime that built them
FANOUT ?= 1
## LAYER_CACHE=dir: Docker's Rust layer cache
LAYER_CACHE ?=
## SMOKE_TAG=tag: The images smoke boots (local)
SMOKE_TAG ?= local
unexport SMOKE_TAG
## CONTAINER_RUNTIME=name: container|docker|podman; else the first to respond

# Resolving this file's directory is the only parse-time command; no runtime is probed.
BUILD_ROOT := $(shell cd "$$(dirname "$(lastword $(MAKEFILE_LIST))")" && pwd)
quote = '$(subst ','"'"',$(1))'
build_arguments = --package $(call quote,$(PACKAGE_NAMES)) --image $(call quote,$(IMAGE_NAMES)) $(if $(filter 1,$(FORCE)),--force) $(if $(filter 0,$(FANOUT)),--no-fanout) $(if $(LAYER_CACHE),--layer-cache $(call quote,$(LAYER_CACHE)))

# A session owns mutable state, port 4873 and timing-sensitive image checks.
ifneq ($(word 2,$(MAKECMDGOALS)),)
$(error Run one public operation per invocation)
endif

.PHONY: help local-build packages images-only launcher plan npm-publish-local desktop desktop-macos desktop-linux smoke clean
help:
	@awk -v groups=$(call quote,$(BUILD_ROOT)/packages/codegen/groups.txt) -f $(call quote,$(BUILD_ROOT)/images/scripts/make-help.awk) $(call quote,$(BUILD_ROOT)/Makefile) $(call quote,$(BUILD_ROOT)/Makefile)

##@ Build
## local-build: Packages, local images and the host launcher
## packages: Packages only
## images-only: Images, from an existing local registry
## launcher: The host launcher only
## plan: What would build, building nothing
##@ Publish
## npm-publish-local: Built npm packages, to a fresh local Verdaccio
local-build packages images-only launcher plan npm-publish-local:
	@bash $(call quote,$(BUILD_ROOT)/images/scripts/build-session.sh) $@ $(build_arguments)

##@ Desktop installers
## desktop: For this OS
## desktop-macos: macOS arm64 DMG, on a macOS host
## desktop-linux: Linux x64 Debian package
desktop desktop-macos desktop-linux:
	@bash $(call quote,$(BUILD_ROOT)/apps/desktop/build.sh) $@

##@ Generated code
## generate[-GROUP]: Regenerate
## check-generated[-GROUP]: Check, repairing nothing
## GROUP: <codegen groups>
.PHONY: generate check-generated
generate check-generated:
	@bash $(call quote,$(BUILD_ROOT)/packages/codegen/run.sh) $@

# The owner helper validates group names; this avoids a second roster in Make.
generate-% check-generated-%: codegen-force
	@bash $(call quote,$(BUILD_ROOT)/packages/codegen/run.sh) $@

.PHONY: codegen-force
codegen-force:

##@ Verify and clean
## smoke: Boot a real stack and run e2e
smoke:
	@bash $(call quote,$(BUILD_ROOT)/images/tests/stack/smoke-stack.sh) $(call quote,$(SMOKE_TAG)) --e2e

## clean: Remove build output; keep installs, caches and images
clean:
	@bash $(call quote,$(BUILD_ROOT)/images/scripts/clean.sh)

##@ Host needs: GNU Make 3.81+, Bash, Git, curl, a container runtime, platform tools
