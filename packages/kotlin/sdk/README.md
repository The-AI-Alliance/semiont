# Semiont Kotlin SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=kotlin-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Semiont SDK for the JVM: one artifact, written in Kotlin, which Java programs call as first-class consumers. It is not published, and its client is not yet written: what is here is its build and the gates it is held to.

## Building it

Nothing but a container runtime is needed. In the JDK image `.java-version` names:

```bash
container run --rm -v "$PWD":/w -w /w/packages/kotlin/sdk eclipse-temurin:"$(scripts/ci/jdk-version.sh)"-jdk ./gradlew --no-daemon check
```

`check` runs, beside the build and the tests:

- `checkKotlinAbi`: the public API against the committed dump, `api/sdk.api`. A change to the API is a change to the dump, made with `./gradlew updateKotlinAbi`.
- `javaTest`: the tests under `src/javaTest/java`, which call the SDK as a Java program does. They are Java alone.
- `refusals`: the programs under `src/refusals`, Kotlin and Java, that must not compile against the SDK. Each begins `// refused: <text>`, and the compiler must refuse it with a message holding that text.
- `census`: no source suppresses a warning (every warning is an error, so a suppression is the one way an unchecked cast gets in), and the SDK reads no environment variable but `SEMIONT_BUS_LOG`.

Every public declaration says it is public: the build runs Kotlin's explicit API mode.

## License

Apache-2.0
