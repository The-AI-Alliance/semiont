#!/bin/sh
# jdk-version.sh — the JDK every build of the Kotlin SDK runs on, printed: the
# major version packages/kotlin/sdk/.java-version states.
#
# actions/setup-java reads that file itself (java-version-file), and so does
# the SDK's Gradle build (its toolchain). What cannot, a JDK image's tag
# (eclipse-temurin:<version>-jdk), asks here, so the file is read in one place
# and one way by a script: images/local-build.sh and the Kotlin SDK's job
# of ci.yml. lint:kotlin-toolchain holds every other statement of it to none.
#
# With no version it prints nothing and fails, so a build that cannot name its
# JDK stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../../.."

version=$(sed -n '1s/^\([0-9][0-9]*\)$/\1/p' packages/kotlin/sdk/.java-version)
if [ -z "$version" ]; then
  echo "jdk-version.sh: packages/kotlin/sdk/.java-version does not state a JDK's major version on its one line" >&2
  exit 1
fi
echo "$version"
