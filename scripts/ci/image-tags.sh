#!/bin/sh
# image-tags.sh <service> <version> <tag_latest> — the image a service publishes
# to and the tags it carries, as GITHUB_OUTPUT lines:
#
#   image  ghcr.io/the-ai-alliance/semiont-<service>
#   tags   <image>:<version>,<image>:sha-<commit>, and <image>:latest when
#          <tag_latest> is `true`
#   sha    the checkout's short commit
#
# One decider for every job of publish-service-images.yml that names a tag:
# the matrix legs, and gateway-manifest, which tags the platform images the
# gateway's legs pushed by digest.
set -eu
USAGE="usage: image-tags.sh <service> <version> <tag_latest>"
SERVICE="${1:?$USAGE}"
VERSION="${2:?$USAGE}"
TAG_LATEST="${3:?$USAGE}"
SHA=$(git rev-parse --short HEAD)
IMAGE="ghcr.io/the-ai-alliance/semiont-$SERVICE"
TAGS="$IMAGE:$VERSION,$IMAGE:sha-$SHA"
if [ "$TAG_LATEST" = true ]; then
  TAGS="$TAGS,$IMAGE:latest"
fi
echo "tags=$TAGS"
echo "image=$IMAGE"
echo "sha=$SHA"
