# Kotlin

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=kotlin)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Kotlin SDK, which Java programs call too.

| Package | Published | Coverage | What it is |
|---|---|---|---|
| [kotlin/sdk](./sdk/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=kotlin-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | The Kotlin SDK, one artifact for Kotlin and Java programs: the protocol's types, generated from the spec at build time, its build and the gates it is held to |

## Where things are

- The SDK is a Gradle build of its own, run by its wrapper (`./gradlew`). The JDK it is built on is its `.java-version`, Gradle is the distribution its wrapper names, and Kotlin and every dependency are its version catalog's, `gradle/libs.versions.toml`. Gradle's lockfiles pin what the catalog resolves to.
- CI builds and tests it in the JDK image `.java-version` names, as `scripts/ci/local-build.sh` does, measures it with JaCoCo, and uploads its coverage under the flag `kotlin-sdk`.

The other languages, and which SDK a program installs, are in [packages/](../README.md).
