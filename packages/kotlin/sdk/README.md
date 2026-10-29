# Semiont Kotlin SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=kotlin-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Semiont SDK for the JVM: one artifact, written in Kotlin, which Java programs call as first-class consumers. It is not published, and its client is not yet written: what is here is the protocol's types, its build and the gates it is held to.

## The protocol's types

Every component schema of the spec is a type of `semiont.types`, and each kind of id a value class of `semiont.identifiers`. The build generates them from `specs/src` (the `generate` task, run before every compile); nothing generated is committed.

- An id is made only through its kind's check: `ResourceId("res-1")` throws `InvalidIdentifier` for text the rule refuses, and `ResourceId.parse(text)` gives `null` instead. Decoding goes through the same check.
- A model is immutable, and written back as it was read: a property left out stays left out, and text the spec gives a format (a time, a URI) stays the text it was. A property that is optional and may be null is a `Stated`: `Absent`, `Null` or `Value`.
- A union is a sealed interface its members implement; a member that is text, a list or a bare object is a variant of the union's own (`Text`, `List`, `Object`).
- Kotlin makes a model by naming its arguments. Java makes one through its builder, which takes what must be stated, then a setter for each thing that may be:

  ```java
  MarkDeleteCommand command = MarkDeleteCommand.builder(new AnnotationId("ann-1")).resourceId(new ResourceId("res-1")).build();
  ```

Java reaches the ids as their own types, not as text, through Kotlin's `@JvmExposeBoxed`, which is still experimental in Kotlin 2.4. The SDK opts in to it where it declares the ids and the models; a program that calls the SDK needs no opt-in of its own.

## Building it

Nothing but a container runtime is needed. In the JDK image `.java-version` names:

```bash
container run --rm -v "$PWD":/w -w /w/packages/kotlin/sdk eclipse-temurin:"$(scripts/ci/jdk-version.sh)"-jdk ./gradlew --no-daemon check
```

`check` runs, beside the build and the tests:

- `checkKotlinAbi`: the public API written by hand against the committed dump, `api/sdk.api`. A change to that API is a change to the dump, made with `./gradlew updateKotlinAbi`. The generated types are the spec's, and are not in it.
- `javaTest`: the tests under `src/javaTest/java`, which call the SDK as a Java program does. They are Java alone.
- `refusals`: the programs under `src/refusals`, Kotlin and Java, that must not compile against the SDK. Each begins `// refused: <text>`, and the compiler must refuse it with a message holding that text.
- `census`: no source suppresses a warning (every warning is an error, so a suppression is the one way an unchecked cast gets in), and the SDK reads no environment variable but `SEMIONT_BUS_LOG`.

Every public declaration says it is public: the build runs Kotlin's explicit API mode.

## License

Apache-2.0
