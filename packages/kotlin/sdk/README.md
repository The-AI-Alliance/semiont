# Semiont Kotlin SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=kotlin-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Semiont SDK for the JVM: one artifact, written in Kotlin, which Java programs call as first-class consumers. It is not published. What is here is the protocol's types, the wire it speaks over, signing in, the client and its live queries, its build and the gates it is held to.

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

## The wire

`semiont.http.HttpTransport` is the bus over HTTP: emits to `POST /bus/emit` and one event stream from `POST /bus/subscribe` (docs/protocol/TRANSPORT-HTTP.md). It reads its token from a `StateFlow` its owner feeds, and asks a `TokenRefresher` for another when the gateway refuses it. `HttpContentTransport` carries what never rides the bus: uploads, and a resource's bytes, description, annotations and anchored text.

`semiont.bus.Bus` is the bus typed by channel. A channel is a constant of `Channels`, typed by the payload its frames carry, and an operation a constant of `Operations`, typed by what it sends and what each reply carries:

```kotlin
val bus = Bus(transport)
bus.emit(Channels.BECKON_FOCUS, focus)
bus.frames(Channels.MARK_ADDED, resource).collect { added -> ... }   // a resource's channel, read for it
val kb = bus.request(Operations.BROWSE_KB_REQUESTED, BrowseKbRequest)
```

Every suspending member has a twin for Java that returns a `CompletableFuture` (`requestFuture`), and every stream reads as a `java.util.concurrent.Flow.Publisher` (`asPublisher()`). Cancelling a future gives the work up: a request's connection is closed.

- **Telemetry:** the SDK tells OpenTelemetry's API what specs/src/sdk-telemetry/telemetry.json lists, and nothing more. It installs no OpenTelemetry: until the application installs its own as the global one, every call does nothing, and one installed after the SDK has begun is still told.
- **The bus log:** with `SEMIONT_BUS_LOG` set to anything but nothing, a line on standard output for each frame sent or received and each read and upload, in the form every Semiont SDK writes, with every credential's value withheld.

## Signing in

- **The sign-in store** (`semiont.signin`): `SignInStore` is the launcher's `tokens.json`, so a program and `semiont login` share their sign-ins. `stateDir` says where it is from the directories the application hands in; the SDK reads no environment variable for it. `MemorySignIn` keeps a sign-in for the life of the process. `renewKept` renews a kept sign-in at its issuer against what is kept then, so another program's renewal or sign-out in between stands.
- **Its lock:** every writer of the store takes `flock` on `tokens.lock`, and on Windows `LockFileEx` on its one byte (specs/src/sign-in-store/README.md). The JDK's own file lock does not exclude `flock` on Linux, so the store calls `flock` through the foreign-function API. An application that uses the store enables native access for it, or the JVM warns when it is first taken:

  ```bash
  java --enable-native-access=ALL-UNNAMED -jar app.jar
  ```

- **A person** signs in from a process with no browser through the device grant: `signInDevice(kb, kept) { code -> ... }` shows the code, and keeps the sign-in once it is approved. `signOut(kept)` revokes it at the issuer and forgets it.
- **A service** signs in as itself with `ServiceToken(credential)`, proving itself with its client secret (`SecretCredential`) or with a key (`KeyCredential`). With a key, each grant carries an assertion signed for it alone (RFC 7523, `private_key_jwt`), which the issuer checks with the public half registered on the client, and no secret is sent. A worker signs in by key: the launcher hands it its client id in `SEMIONT_OIDC_CLIENT_ID` and its RSA key as PKCS#8 PEM in `SEMIONT_OIDC_CLIENT_KEY`, and the worker reads them itself, into `ServiceToken(KeyCredential.fromPem(issuer, clientId, pem))`. A PEM that is not an RSA key in PKCS#8 throws `IllegalArgumentException`, which never says the key.
- **An agent** is an account, as a person is: `AgentToken` signs it in with its account's token, learns the DID the gateway names it by from `GET /api/users/me`, and renews by a new grant at its issuer, when the token is due and at once when the gateway refuses it. A transport takes it as its token and its refresher. An agent whose renewal fails keeps the token it has and tries again.

## Live queries

The client's reads of what changes are live queries (`Cached`): `client.browse.annotations(resource)`, `client.browse.entityTypes()` and the rest of specs/src/client/surface.json's `cache` rows. Making one touches nothing. Collected, it is the query's state now and each state after it, until the client is closed: `CacheState.Pending`, `CacheState.Ready` with its value, or `CacheState.Failed` with its error. A failure is a state, never a throw, and the next act on the query tries again. While a query of a resource is collected, the client holds that resource's scope, so the events that keep it true reach it. `fresh()` is the one-shot read, and `invalidate()` asks again while the value is shown.

```kotlin
client.browse.annotations(resource).collect { state ->
    when (state) {
        is CacheState.Pending -> ...
        is CacheState.Ready -> show(state.value)
        is CacheState.Failed -> report(state.error)
    }
}
```

Java reads a query through `asPublisher()` and tells the states apart with `instanceof`. Java gets no exhaustiveness for `CacheState`: a chain that leaves one out compiles.

A client given a `CachePersistence` keeps its small queries in a `SessionStorage`, so the next client of the same knowledge base shows them at once and asks for them anew. `CoupledBookmarks` keeps the stream's place in each scope beside them, for an `HttpTransport` to resume from.

## The JVM's settings

The SDK reads no setting of its own but `SEMIONT_BUS_LOG`. Its HTTP client is the JDK's, with the JDK's default proxy selector and trust store, so it honours the system properties an application sets for them:

| For | Properties |
|---|---|
| A proxy | `https.proxyHost`, `https.proxyPort`, `http.proxyHost`, `http.proxyPort`, `http.nonProxyHosts`; or `java.net.useSystemProxies=true`, for the system's own |
| The certificates it trusts | `javax.net.ssl.trustStore`, `javax.net.ssl.trustStorePassword`, `javax.net.ssl.trustStoreType` |
| A certificate it presents | `javax.net.ssl.keyStore`, `javax.net.ssl.keyStorePassword`, `javax.net.ssl.keyStoreType` |
| The client itself | the JDK's `jdk.httpclient.*` properties |

## Building it

Nothing but a container runtime is needed. In the JDK image `.java-version` names:

```bash
container run --rm -v "$PWD":/w -w /w/packages/kotlin/sdk eclipse-temurin:"$(scripts/ci/jdk-version.sh)"-jdk ./gradlew --no-daemon check
```

`check` runs, beside the build and the tests:

- `checkKotlinAbi`: the public API written by hand against the committed dump, `api/sdk.api`. A change to that API is a change to the dump, made with `./gradlew updateKotlinAbi`. What the generator writes is the spec's, and is not in it.
- `javaTest`: the tests under `src/javaTest/java`, which call the SDK as a Java program does. They are Java alone.
- `refusals`: the programs under `src/refusals`, Kotlin and Java, that must not compile against the SDK. Each begins `// refused: <text>`, and the compiler must refuse it with a message holding that text.
- `census`: no source suppresses a warning (every warning is an error, so a suppression is the one way an unchecked cast gets in), and the SDK reads no environment variable but `SEMIONT_BUS_LOG`.

Every public declaration says it is public: the build runs Kotlin's explicit API mode.

## License

Apache-2.0
