.DEFAULT_GOAL := help

# Keep values as arguments, including command-line selectors Make would otherwise export.
unexport PACKAGE_NAMES IMAGE_NAMES FORCE FANOUT LAYER_CACHE
PACKAGE_NAMES ?=
IMAGE_NAMES ?=
FORCE ?= 0
FANOUT ?= 1
LAYER_CACHE ?=
SMOKE_TAG ?= local
unexport SMOKE_TAG

# Resolving this file's directory is the only parse-time command; no runtime is probed.
BUILD_ROOT := $(shell cd "$$(dirname "$(lastword $(MAKEFILE_LIST))")" && pwd)
quote = '$(subst ','"'"',$(1))'
build_arguments = --package $(call quote,$(PACKAGE_NAMES)) --image $(call quote,$(IMAGE_NAMES)) $(if $(filter 1,$(FORCE)),--force) $(if $(filter 0,$(FANOUT)),--no-fanout) $(if $(LAYER_CACHE),--layer-cache $(call quote,$(LAYER_CACHE)))

# A session owns mutable state, port 4873 and timing-sensitive image checks.
ifneq ($(word 2,$(MAKECMDGOALS)),)
$(error Run one public operation per invocation)
endif

.PHONY: help local-build packages images-only launcher plan npm-publish-local desktop desktop-macos desktop-linux smoke
help:
	@printf '%s\n' \
	  'make local-build              Build packages, local images and host launcher' \
	  'make packages                 Build packages only (PACKAGE_NAMES=rust or typescript/sdk)' \
	  'make images-only              Rebuild images using an existing local registry' \
	  'make plan                     Describe selection without building or publishing' \
	  'make npm-publish-local        Publish built npm artifacts to fresh local Verdaccio' \
	  'make launcher                 Build the host launcher only' \
	  'make desktop                  Build the installer for the caller OS' \
	  'make desktop-macos            Build the macOS arm64 DMG (macOS host)' \
	  'make desktop-linux            Build the Linux x64 Debian package' \
	  'make generate[-GROUP]         Regenerate output (bus, typescript, python, go,' \
	  '                              stack-go, mcp-tools-go, discovery-go, encoding-cases, model-catalogue)' \
	  'make check-generated[-GROUP]  Check generated output without repairing committed files' \
	  'make smoke                    Boot/check a real stack and run e2e (SMOKE_TAG=local)' \
	  'Selectors: PACKAGE_NAMES=language/name,... IMAGE_NAMES=browser,... FORCE=1 FANOUT=0' \
	  'Runtime: CONTAINER_RUNTIME=container|docker|podman; LAYER_CACHE=directory (Docker)' \
	  'Host: GNU Make >=3.81, Bash, Git, Python 3, container runtime and platform utilities.'

local-build packages images-only launcher plan npm-publish-local:
	@bash $(call quote,$(BUILD_ROOT)/images/scripts/build-session.sh) $@ $(build_arguments)

desktop desktop-macos desktop-linux:
	@bash $(call quote,$(BUILD_ROOT)/apps/desktop/build.sh) $@

smoke:
	@bash $(call quote,$(BUILD_ROOT)/images/tests/stack/smoke-stack.sh) $(call quote,$(SMOKE_TAG)) --e2e

.PHONY: generate check-generated
generate check-generated:
	@python3 $(call quote,$(BUILD_ROOT)/packages/codegen/run.py) $@

# The owner helper validates group names; this avoids a second roster in Make.
generate-% check-generated-%: codegen-force
	@python3 $(call quote,$(BUILD_ROOT)/packages/codegen/run.py) $@

.PHONY: codegen-force
codegen-force:
