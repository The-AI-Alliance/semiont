# Semiont Kotlin SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=kotlin-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Semiont SDK for the JVM: one artifact, written in Kotlin, which Java programs call as first-class consumers. Every program below is a file the build compiles and runs (`src/test/kotlin/semiont/readme`, `src/javaTest/java/semiont/readme`), held to this page word for word.

## Installing

The SDK is not published yet. Build its jar from source, in a container whose JDK is the one `.java-version` names (Kotlin 2.4, JDK 25), and put it on your program's classpath with its dependencies:

```bash
container run --rm -v "$PWD":/w -w /w/packages/kotlin/sdk eclipse-temurin:"$(scripts/ci/jdk-version.sh)"-jdk ./gradlew --no-daemon jar
```

## The verbs

A client's namespaces are the protocol's eight verbs, and three of its own:

| Namespace | What it does |
|---|---|
| `frame` | the vocabulary: what kinds of things exist |
| `browse` | reads, as live queries, and this viewer's own signals |
| `mark` | annotations, and annotating a resource delegated as a job |
| `bind` | linking a reference to what it refers to |
| `gather` | the context a model is given, and what refers to a resource |
| `match` | searching, for what a reference could refer to and for resources |
| `yield` | creating resources, and generating one delegated as a job |
| `beckon` | attention: driving the other participants' viewers |
| `job` | jobs: their lifecycle, their status, cancelling one, and claiming work |
| `auth`, `system` | who is signed in, and what the knowledge base says of itself |

Kotlin calls a `suspend` member and collects a `Flow`. Java calls the member's twin that returns a `CompletableFuture` (`awaitFuture`, `…Future`) and reads a stream as a `java.util.concurrent.Flow.Publisher` (`asPublisher()`). `yield` is no keyword in Kotlin; Java calls it as `getYield()`.

## Connecting

A client of a knowledge base, over HTTP, signed in with a token. In Kotlin:

<!-- readme: connect -->
```kotlin
val transport = HttpTransport(baseUrl, MutableStateFlow(token))
val client = SemiontClient(transport, HttpContentTransport(transport), transport)
```

In Java:

<!-- readme: connect-java -->
```java
HttpTransport transport = new HttpTransport(baseUrl, StateFlowKt.MutableStateFlow(token));
SemiontClient client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
```

Closing the client ends what it runs and its own bus; whoever made the transport closes it.

## Gathering, then delegating

Gather the context around an annotation, and hand it to a `yield` job that writes a summary, following the job as it goes. In Kotlin, collecting a delegation gives each event of the job, its completion the last:

<!-- readme: gather-then-delegate -->
```kotlin
val context = client.gather.annotation(resource, annotation).await().response
val params = GenerationJobParams(title = "A summary", storageUri = "file://summary.md", context = context)
client.yield.delegate(params).collect { event ->
    when (event) {
        is JobProgressed -> println("${event.data.percentage}%")
        is JobCompleted -> println("made ${event.data.result}")
        else -> {}
    }
}
```

In Java, a model is made through its builder, and awaiting a delegation gives its completion; a job that does not complete fails the future:

<!-- readme: gather-then-delegate-java -->
```java
GatheredContext context = client.getGather().annotation(resource, annotation).awaitFuture().get().getResponse();
GenerationJobParams params = GenerationJobParams.builder("A summary", "file://summary.md", context).build();
YieldJobCompleteCommand done = client.getYield().delegate(params).awaitFuture().get();
System.out.println("made " + done.getResult());
```

## Watching live

The client's reads of what changes are live queries (`Cached`): `client.browse.annotations(resource)`, `client.browse.entityTypes()` and the rest of specs/src/client/surface.json's `cache` rows. Collected, a query is its state now and each state after it, until the client is closed: `CacheState.Pending`, `CacheState.Ready` with its value, or `CacheState.Failed` with its error. A failure is a state, never a throw, and the next act on the query tries again. While a query of a resource is collected, the client holds that resource's scope, so the events that keep it true reach it. `fresh()` is the one-shot read, and `invalidate()` asks again while the value is shown.

<!-- readme: watching-live -->
```kotlin
client.browse.annotations(resource).collect { state ->
    when (state) {
        is CacheState.Pending -> {}
        is CacheState.Ready -> println("${state.value.size} annotations")
        is CacheState.Failed -> println("not read: ${state.error.message}")
    }
}
```

Java reads a query through `asPublisher()`, and a failure arrives as a value like any other state, never through `onError`. Java gets no exhaustiveness for `CacheState`: a chain that leaves one out compiles.

<!-- readme: watching-live-java -->
```java
client.getBrowse().annotations(resource).asPublisher().subscribe(new Flow.Subscriber<CacheState<List<Annotation>>>() {
    @Override
    public void onSubscribe(Flow.Subscription subscription) {
        subscription.request(Long.MAX_VALUE);
    }

    @Override
    public void onNext(CacheState<List<Annotation>> state) {
        if (state instanceof CacheState.Ready<List<Annotation>> ready) {
            System.out.println(ready.getValue().size() + " annotations");
        } else if (state instanceof CacheState.Failed failed) {
            System.out.println("not read: " + failed.getError().getMessage());
        }
    }

    @Override
    public void onError(Throwable error) {}

    @Override
    public void onComplete() {}
});
```

A client given a `CachePersistence` keeps its small queries in a `SessionStorage`, so the next client of the same knowledge base shows them at once and asks for them anew. `CoupledBookmarks` keeps the stream's place in each scope beside them, for an `HttpTransport` to resume from.

## Taking work

A worker claims jobs from a knowledge base's queue, does each one, and says what became of it. `client.job.claim(accepts)` is its side of the queue, given what the worker accepts, each a `JobFilter`: the `mark` jobs of one motivation, or the `yield` jobs. Its `Claims` hand out the jobs the worker comes to hold, one at a time: each `next()` the next, a `HeldMarkJob` or a `HeldYieldJob`.

- **A worker is an agent.** Its process signs in at its issuer as its account, `AgentToken(gateway, ServiceToken(SecretCredential(...)))`, and the gateway names it by that account: `agent.did`, once `signIn()` has returned. The account needs two roles at the issuer: `semiont-service`, which marks a service's account, and `semiont-worker`, without which every claim is refused as `bus.unauthorized`.
- **It says what it is called**, as itself: `client.wire.emit(Channels.PRINCIPAL_PROFILE, PrincipalProfileCommand(name = clientId))`, here its client id. Readers name it by the last name it said, as they name a person.
- **Its stream names `JOB_CLAIM_CHANNELS`**, and `JOB_COMMIT_CHANNELS` when it commits, and the reply channels of whatever else it awaits: `HttpTransport(gateway, agent.token, JOB_CLAIM_CHANNELS + JOB_COMMIT_CHANNELS, refresher = agent)`. The announcements that wake an idle worker reach only a stream that names them, so one whose stream does not is refused at its first claim, as `bus.unsubscribed`.
- **What it commits names its generator**: an `AgentSoftware` whose `id` is the agent's DID (`agent.did.value`), with the engine it ran (`provider`, `model`). It carries no name: readers name the agent by what it said it is called.
- **A held job settles once.** It says its own start, progress and checkpoints, commits its annotations (`commit(resourceId, annotations)` returns once the record has them), and settles with `complete`, `fail` or `cancel`. Closing one nobody settled fails it, and `stop()` fails the job held first. `fail` says whether the queue will run the job again, by the rule `willRetryAfter` states.
- **A refused claim is told**, on `claims.refused()`, with its code. A claim answered with nothing pending is no refusal, and the worker waits.

What a worker promises is docs/protocol/WORKER-CONTRACT.md, and the worker conformance suite holds this SDK to it through a driver written in Java.

## Testing

`semiont.testing` is what a program's tests are built on: `FaultyTransport`, a transport with no wire whose gateway answers what a test queued and refuses the rest by name, and whose wire delivers, drops, delays or doubles each reply as a schedule says; `InMemoryContent` and `StubGateway`; `TestClient`, a real client over the three; `createTestSession`, a real session over one; `ScriptedSessions` and `SharedStorage`, for a registry; and the liveness axioms (`assertLivenessAxioms`, `assertExactlyOnceDelivery`), which hold a composition to saying something and to delivering each event once under any behaviour of the wire. Each is usable from Java as from Kotlin.

## The protocol's types

Every component schema of the spec is a type of `semiont.types`, and each kind of id a value class of `semiont.identifiers`. The build generates them from `specs/src` (the `generate` task, run before every compile); nothing generated is committed.

- An id is made only through its kind's check: `ResourceId("res-1")` throws `InvalidIdentifier` for text the rule refuses, and `ResourceId.parse(text)` gives `null` instead. Decoding goes through the same check.
- A model is immutable, and written back as it was read: a property left out stays left out, and text the spec gives a format (a time, a URI) stays the text it was. A property that is optional and may be null is a `Stated`: `Absent`, `Null` or `Value`.
- A union is a sealed interface its members implement; a member that is text, a list or a bare object is a variant of the union's own (`Text`, `List`, `Object`).
- Kotlin makes a model by naming its arguments. Java makes one through its builder, which takes what must be stated, then a setter for each thing that may be:

  <!-- readme: a-builder-java -->
  ```java
  MarkDeleteCommand command = MarkDeleteCommand.builder(new AnnotationId("ann-1")).resourceId(new ResourceId("res-1")).build();
  ```

Java reaches the ids as their own types, not as text, through Kotlin's `@JvmExposeBoxed`, which is still experimental in Kotlin 2.4. The SDK opts in to it where it declares the ids and the models; a program that calls the SDK needs no opt-in of its own. Five functions that only return an id give Java its text, as Kotlin exposes no typed form of an id a function only returns: `bodySource` and `targetSource` of `semiont.annotations`, and `kbDid`, `personDid` and `agentDid` of `semiont.identity`.

## The wire

`semiont.http.HttpTransport` is the bus over HTTP: emits to `POST /bus/emit` and one event stream from `POST /bus/subscribe` (docs/protocol/TRANSPORT-HTTP.md). It reads its token from a `StateFlow` its owner feeds, and asks a `TokenRefresher` for another when the gateway refuses it. `HttpContentTransport` carries what never rides the bus: uploads, and a resource's bytes, description, annotations and anchored text.

`semiont.bus.Bus` is the bus typed by channel. A channel is a constant of `Channels`, typed by the payload its frames carry, and an operation a constant of `Operations`, typed by what it sends and what each reply carries: `emit`, `frames` and `request` each take one, and the compiler refuses a payload that is not its channel's.

Every suspending member a program calls has a twin for Java that returns a `CompletableFuture` (`requestFuture`), and every stream reads as a `java.util.concurrent.Flow.Publisher` (`asPublisher()`). Cancelling a future gives the work up: a request's connection is closed. A twin that takes an id is called on a class, not through an interface: Java calls `HttpTransport`'s `emitFuture`, as Kotlin exposes no typed form of an interface's member.

Five interfaces are implemented in Kotlin, not in Java, since their members suspend or take an id: `TokenRefresher`, `SignInKept`, `SessionFactory`, `DiscoveryTransport` and `Bookmarks`. A Java program uses the SDK's own: `AgentToken` and the sessions' refreshers; `SignInStore`, `MemorySignIn` and `keptIn`; `HttpSessionFactory`; `httpDiscovery` and `textDiscovery`; `CoupledBookmarks`. One that signs in its own way feeds its transport the token and gives it no refresher. Its tests build on `semiont.testing` rather than on a transport of their own.

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

## What an application enables

The SDK installs nothing and reads no setting of its own but `SEMIONT_BUS_LOG`. What it can use, the application turns on:

- **Telemetry:** the SDK tells OpenTelemetry's API what specs/src/sdk-telemetry/telemetry.json lists. Until the application installs its own OpenTelemetry as the global one, every call does nothing, and one installed after the SDK has begun is still told.
- **The sign-in store's lock** needs native access: `java --enable-native-access=ALL-UNNAMED`.
- **The JVM's network settings**, below.

## The JVM's settings

The SDK's HTTP client is the JDK's, with the JDK's default proxy selector and trust store, so it honours the system properties an application sets for them:

| For | Properties |
|---|---|
| A proxy | `https.proxyHost`, `https.proxyPort`, `http.proxyHost`, `http.proxyPort`, `http.nonProxyHosts`; or `java.net.useSystemProxies=true`, for the system's own |
| The certificates it trusts | `javax.net.ssl.trustStore`, `javax.net.ssl.trustStorePassword`, `javax.net.ssl.trustStoreType` |
| A certificate it presents | `javax.net.ssl.keyStore`, `javax.net.ssl.keyStorePassword`, `javax.net.ssl.keyStoreType` |
| The client itself | the JDK's `jdk.httpclient.*` properties |

## Android

Untested. The SDK is a JVM library, and nothing in it was built or run on Android.

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
