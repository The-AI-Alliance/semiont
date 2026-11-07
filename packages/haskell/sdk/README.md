# Semiont Haskell SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Haskell SDK implements Semiont's client and protocol contracts with `IO`,
STM observations and scoped streams. It provides all eleven client namespaces,
live queries and durable caches, typed delegation, uploads, claims, held jobs and
durable worker commits. Device, redirect, kept-grant and service-account sign-in
share real sessions with token renewal and late-refusal handling.

The SDK also provides the knowledge-base registry, all ten state units, launcher
and HTTP discovery, annotation readers/builders, principal identity helpers and
consumer testing tools. The shared live, wire and worker conformance suites run
against its public API. It builds from source until the package is published.

[Install](#install) · [Signing in](#signing-in) · [Connect](#connect) ·
[Delegation](#delegation) · [Live queries](#live-queries) ·
[Running a worker](#running-a-worker)

## Install

Use the local Cabal package in a Semiont checkout. It is not published on
Hackage. In your application's `cabal.project`, include both packages:

```cabal
packages: ./my-app
          /path/to/semiont/packages/haskell/sdk
```

Add `semiont` to the application's `build-depends`. Use the compiler pinned in
[the development project](../probes/cabal.project). The repository's
[container runner](../run-container.sh) builds and tests the SDK without a host
Haskell installation; see [Building and verifying](#building-and-verifying).

## Signing in

`Semiont.Issuer` discovers the issuer from a knowledge base's resource metadata.
`signInWithDeviceGrant` reports the approval code to your callback and polls at
the issuer's interval. `beginAuthorization` saves PKCE/state and returns the
URL to navigate to; `completeAuthorization` consumes the callback once and
returns the pending identity and issued tokens. Both use the application's
HTTP pool and controlled clock. The client ids and scope come from the shared
OAuth registration table.

`Semiont.Session.signInDevice` opens a client/session from a device grant.
`fromIssuedSession` persists an already issued grant and installs its rotating
refresh callback. `SessionOptions` carries the knowledge base, typed kept grant, wall
clock and host callbacks; provide `sessionValidate` to confirm a person with
the supplied client and token. A service can omit that callback. `ready` waits for startup;
`token`, `user` and `streamState` are read-only observations. Refusals that arrive
together share one renewal. An issuer refusal forgets the grant; an outage
keeps it and retries with reconnect backoff. Disposing a session joins its
work and leaves its client open; `closeOpenedSession` closes both.

```haskell
module DeviceSignIn where
import Control.Exception (bracket)
import qualified Semiont.Http as Http
import qualified Semiont.Session as Session
import Semiont.Types (DeviceCode)

withDeviceSession :: Http.HttpOptions -> Session.SessionOptions
  -> (DeviceCode -> IO ()) -> (Session.Session -> IO result) -> IO result
withDeviceSession http options showCode use =
  bracket (Session.signInDevice http Nothing options showCode)
    Session.closeOpenedSession (use . Session.openedSession)
```

`Semiont.SessionStorage.newMemoryStorage` keeps one context's text values;
applications can implement `SessionStorage` for their own storage.
`Registry.Stored.keptIn storage kbId` is that knowledge base’s typed
`KeptSignIn`; `SignIn.newMemorySignIn` is one independent in-memory grant.
Its `update` transforms and returns a result atomically, so redirect completion
and refresh rotation cannot overwrite another writer. The shared
[sign-in guide](../../../docs/builder/SIGN-IN.md) describes the flows.

`Semiont.ServiceToken` performs a lazy client-credentials grant with a secret
or RSA key. It discovers the token endpoint once and keeps each opaque access
token only for the lifetime the issuer stated. Key grants carry a fresh RS256
assertion, with the shared RFC 7638 thumbprint and claims; the private key stays
in the process. `Semiont.ClientAssertion.privateKeyFromPem` reads one unencrypted
PKCS#8 RSA key and refuses other key formats without echoing their contents.

```haskell
module ServiceAccount where
import Control.Exception (bracket)
import Data.ByteString (ByteString)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Semiont.ClientAssertion as Assertion
import qualified Semiont.Issuer as Issuer
import qualified Semiont.ServiceToken as Service

withAccount :: Issuer.IssuerOptions -> Text -> Text -> ByteString
  -> IO Scientific -> (Service.ServiceToken -> IO result) -> IO result
withAccount options authority clientId pem wallNow use = do
  key <- either (ioError . userError . Text.unpack) pure
    (Assertion.privateKeyFromPem pem)
  bracket (Service.newServiceTokenKey options authority clientId key wallNow)
    Service.dispose use
```

`Session.signInAgent http Nothing options budget service` opens a session for that
account and keeps the DID the gateway actually returned. Supply its startup
`RetryBudget` explicitly: unreachable peers and boot-transient responses retry,
and a refused freshly issued credential ends the attempt. The service token
remains owned by its caller. Session renewal callbacks receive the token held;
`Auth.me auth (Just token)` validates an explicit credential in one attempt,
without renewing or quarantining the inherited token. `Auth.me auth Nothing`
uses the client's own token and retry policy.

`Semiont.SignInStore` reads the launcher's `tokens.json`, preserving unknown
members and refusing to overwrite a corrupt document. `stateDirectory` runs the
shared platform rules on directory values supplied by the application; the SDK
reads no environment. `signInFileName` is the file name below that directory.
The store keeps its directory to its owner and takes the shared native lock
for each atomic read/change/write. Its options take your clock, positive lock
retry interval and wall-clock reading. All three grant backends preserve a
concurrent renewal or sign-out; token comparison is shared.

```haskell
module KeptSignIn where
import Control.Exception (bracket)
import qualified Semiont.Http as Http
import qualified Semiont.Session as Session
import qualified Semiont.SignInStore as Store
import Semiont.Types (kbTargetId)

withKeptSession :: Http.HttpOptions -> Session.SessionOptions
  -> Store.SignInStoreOptions -> FilePath
  -> (Session.Session -> IO result) -> IO result
withKeptSession http options storeOptions filename use = do
  store <- Store.newSignInStore storeOptions filename
  let actual = options { Session.sessionKept =
        Store.entry store (kbTargetId (Session.sessionKb options)) }
  bracket (Session.fromKeptSession http Nothing actual)
    Session.closeOpenedSession (use . Session.openedSession)
```

## Connect

Build a reusable HTTP pool with `Semiont.Http.newHttpClient`, supplying an
explicit proxy policy and your `http-client` `ManagerSettings`. For example,
`newHttpClient noProxy tlsManagerSettings` uses your TLS settings without an
environment-selected proxy; `tlsManagerSettings` is supplied by
`http-client-tls`. The pool disables implicit retries and response timeouts so
Semiont owns its attempt budgets and deadlines. A transport never closes the
caller's pool. Its active requests and response scopes end on disposal.

Supply the pool through `HttpOptions`, together with the base URL, token reader,
refused-token renewal action, fresh UUID action, global channel profile, monotonic
clock/wait/jitter actions, timing settings, and replay-position load/save actions.
`Semiont.Timing.Settings.protocolSettings` supplies the protocol timings;
`withOverrides` validates explicitly supplied timing overrides. Use
`Semiont.Channels.globalChannels` for a full client. All these choices are
explicit. `Client.fromHttp` builds the bus, content and gateway adapters with
the same clock and ID source. Keep the client scoped:

```haskell
module HttpConnection (withConnection) where

import Control.Exception (bracket)
import Semiont.Client (Client, fromHttp, dispose)
import Semiont.Http (HttpOptions)

withConnection :: HttpOptions -> (Client -> IO result) -> IO result
withConnection options = bracket (fromHttp options Nothing) dispose
```

`Client.newClient` also accepts independently supplied bus/content adapters and
an optional gateway. Each client constructs and bridges its own local bus.
Disposal stops refresh and cache work, closes transport and content operations,
and completes the local bus. `Client.wire` is its typed wire bus; the namespace
getters include `Client.browse`, `Client.gather` and `Client.match`.

HTTP content supports scoped binary streams, buffered binary reads, metadata,
annotations and anchored text. Uploads take generated `ResourceUploadMetadata`
and a `ReplayableBody`; `bytesBody` builds a byte source. A source opens again
when a refused credential is renewed. Its idempotency key stays the same and
progress never decreases across replay. A stream retained beyond its callback
refuses further reads.

## Eight verbs

The Haskell client implements the
[client surface](../../../protocol/specs/src/client/surface.json), with typed
channel and operation descriptors in `Semiont.Channels`.
All 66 methods of Frame, Bind, Beckon, Browse, Gather, Match, Mark, Yield, Job,
Auth and System are available. See the
[builder guide](../../../docs/builder/README.md) for the shared model.

## Delegation

`Mark.delegate` and `Yield.delegate` create and follow typed jobs. Each returns
an opaque `Running (JobEvent completion) completion`: a mark job completes with
`MarkJobCompleteCommand`, and a yield job with `YieldJobCompleteCommand`.

```haskell
module DelegateMarks (runMarks) where

import qualified Semiont.Client as Client
import qualified Semiont.Mark as Mark
import qualified Semiont.Running as Running
import Semiont.Types (ResourceId, MarkJobParams, MarkJobCompleteCommand)

runMarks :: Client.Client -> ResourceId -> MarkJobParams -> IO MarkJobCompleteCommand
runMarks client identity params =
  Mark.delegate (Client.mark client) identity params >>= Running.await
```

The first report names the created job. Progress and retryable failures follow;
the final report carries its completion. A final failure or cancellation raises
`JobError` with the shared job code. After silence the follower asks for status;
progress restarts that interval, and a retryable failure parks polling until the
next attempt speaks. Early frames wait behind creation, and a completion of
another verb is refused. Following a job acquires no resource subscription.
A malformed lifecycle frame produces a `Refused` report with its channel, fault
path and reason. It neither completes the job nor resets silence or stall time.

Yield's silence guard derives from the requested token budget and the protocol
floor, or accepts an explicit per-call deadline. Each progress or retryable
failure restarts it. On expiry it requests cancellation of the known job and
raises `job.stalled`. `Yield.resource` returns `Running UploadEvent ResourceId`,
reporting started, byte progress and finished; abandoning its reader cancels
the upload.

Constructing an operation starts no work. `await` starts it and returns its
terminal result; `withReports` instead supplies a `Stream (Of report) IO result`
from the `streaming` package. Only one consumer may start an operation, once.
Producer failures propagate to the consumer. Leaving `withReports` cancels
and joins the producer, and a stream retained past that scope refuses reads.

## Live queries

`Semiont.Cache` provides lazy read-through queries with three outcomes:
`Pending`, `Ready value`, and `Failed exception`. `Cache.query` is pure;
`Cache.watch` starts a scoped live observation, and `Cache.fresh` forces a
one-shot read. Concurrent readers share a fetch. Invalidation keeps a stale
value visible, retries a failed background read once, and prevents an obsolete
response from overwriting a newer value.

```haskell
module CachedReads (nameCache, readName) where

import Data.Text (Text)
import qualified Semiont.Cache as Cache
import qualified Semiont.Timing.Settings as Timing

nameCache :: (Text -> IO Text) -> IO Integer -> (Integer -> IO ())
          -> IO (Cache.Cache Text Text)
nameCache reader monotonic waitUntil = Cache.newCache reader Cache.CacheOptions
  { Cache.cacheNow = monotonic
  , Cache.cacheWaitUntil = waitUntil
  , Cache.cacheSaveDebounceMs = Timing.saveDebounceMs Timing.protocolSettings
  , Cache.cachePersister = Nothing
  , Cache.cacheScope = const (pure (pure ()))
  }

readName :: Cache.Cache Text Text -> Text -> IO Text
readName cache key = Cache.fresh (Cache.query cache key)
```

The clock actions count monotonic nanoseconds and use the same coordinate
system. An optional `CachePersister` restores settled values, revalidates each
on first observation, debounces saves, and flushes on `dispose`. Failure
markers are never saved. `persistencePending` remains true while a fetch or
unsaved content could let a resumption bookmark lead its document. Dispose
cancels and joins owned work and completes readers.

`Browse.resource`, `Browse.annotations`, `Browse.annotation`, `Browse.events`,
`Browse.resources`, `Browse.entityTypes`, `Browse.tagSchemas`, `Browse.engines`,
`Gather.referencedBy` and `Match.resources` return live queries. Scoped
observations hold the resource subscription until their callback returns. The
shared event refresh table applies before request continuations run, coalesces
repeated invalidations, writes known annotation values, and refreshes the held
global queries when a dropped connection reopens. Engines retain their job
assignments and gain each inference service's limits as those arrive.

```haskell
module ResourceNames (readResourceName) where

import Data.Text (Text)
import qualified Semiont.Browse as Browse
import qualified Semiont.Cache as Cache
import qualified Semiont.Client as Client
import Semiont.Types (ResourceId, resourceDescriptorName)

readResourceName :: Client.Client -> ResourceId -> IO Text
readResourceName client identity =
  resourceDescriptorName <$> Cache.fresh (Browse.resource (Client.browse client) identity)
```

`Gather.annotation` and `Match.search` return lazy `Running` operations.
`Gather.resource` returns a complete `GatheredContext`. Buffered text reads use
the media registry, MIME charset and byte-order mark rules; PDF text is read
through `Browse.resourceAnchoredText`, and binary content through
`Browse.resourceRepresentation` or its scoped stream.

Persisted query documents and replay bookmarks share the application storage.
Query behavior follows the
[cache contract](../../../protocol/contract/CACHE-SEMANTICS.md).

## State units

`Semiont.State.Mark`, `Yield`, `Gather`, `Match` and `Beckon` coordinate the
client signals and expose read-only state. `HoverDwell` waits for a pointer to
rest; `Search` debounces typed queries and joins the search it replaces.
`SessionSignals` holds host notices beside a session. The cache and session
are state units too. Each has an idempotent `dispose` that joins its work and
ends its observations without disposing the borrowed client. See
[State units](../../../docs/builder/STATE-UNITS.md).

Mark and hover take the caller's `RetryOptions`; search takes it with an
explicit debounce and initial query. Mark uses the supplied `Timing.Settings`
for silence notices. No state unit reads an ambient timer. Job creation is
queued in invocation order within a unit; once a creation is answered, the next
can start while the earlier job remains followed.


```haskell
{-# LANGUAGE OverloadedStrings #-}
module ResourceSearch where
import Control.Exception (bracket)
import qualified Semiont.Cache as Cache
import qualified Semiont.Client as Client
import qualified Semiont.Match as Match
import Semiont.Retry (RetryOptions)
import qualified Semiont.State.Search as Search
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types (ResourceDescriptor, matchResourcesResponseResources)
import qualified Streaming.Prelude as Stream

withResourceSearch :: Client.Client -> RetryOptions
  -> (Search.SearchPipeline ResourceDescriptor -> IO result) -> IO result
withResourceSearch client clock = bracket
  (Search.newSearchPipeline clock
    (Timing.searchDebounceMs Timing.protocolSettings) "" source)
  Search.dispose
  where
    source text publish = Cache.watch
      (Match.resources (Client.match client) text Nothing)
      (Stream.mapM_ (publish . fmap matchResourcesResponseResources . Cache.readyValue))
```

Use `Search.setQuery` as input changes and observe `Search.state`. This example
also needs `streaming` in its `build-depends`.

Cache persistence is opt-in: pass `Just (Client.CachePersistence storage
"kb-id" wallMilliseconds)` to the client or session factory in place of
`Nothing`. Give each principal a separate storage. Close the old client before
switching profiles; persisted values are available before gateway revalidation.
The queries `session/stored.json` keeps (resource details, annotation lists and
details, entity types and tag schemas) rehydrate immediately, each from one
cache document that every SDK writes and reads alike. The first observation
revalidates each restored key. Each entry's stamp is the wall clock rounded to a
whole millisecond, kept while its value is unchanged; a document over the shared
UTF-8 byte cap loses its oldest entries. Where the stream was is written in the
same call as a cache document, and only while every kept view has no fetch in
flight and owes no save and no refresh window owes an invalidation. Disposal
reads that gate once, before anything is disposed: a fetch in flight or an owed
invalidation holds the places back from the final cache saves, and an owed save
does not, since those saves are it. So a reload may replay extra events and
cannot skip an unfinished update.

## Building annotations

`Semiont.Annotations` reads the generated annotation types without narrowing
single bodies, body lists, resource targets, or selector lists. Its builders
produce the same deterministic annotation IDs as the other SDKs. Reconciliation
and every span offset count Unicode code points, including characters outside
the basic multilingual plane. PDF spans use the anchored text's page rectangles.

```haskell
{-# LANGUAGE OverloadedStrings #-}
module BuiltAnnotation where
import Data.Time (UTCTime)
import Semiont.Types
import qualified Semiont.Annotations as Annotations

highlight :: IO UTCTime -> ResourceId -> Agent -> IO (Maybe Annotation)
highlight wall resource generator =
  case Annotations.reconcile "Ada Lovelace wrote the first algorithm."
    (QuotedText "Ada Lovelace" Nothing Nothing mempty) of
    Nothing -> pure Nothing
    Just found -> do
      let spanValue = TextSpan (reconciledSpanEnd found) (reconciledSpanExact found)
            (reconciledSpanPrefix found) (reconciledSpanStart found)
            (reconciledSpanSuffix found) mempty
      Just <$> Annotations.annotationOfSpan wall
        (Annotations.TextContent "Ada Lovelace wrote the first algorithm.")
        spanValue resource MotivationHighlighting generator Nothing
```

Set the existing cross-SDK `SEMIONT_BUS_LOG` switch to a nonempty value to
write HTTP transport frames and content operations to stderr. Payload credentials
are recursively replaced with `[withheld]`; the logger does not print headers.

## Running a worker

`Semiont.JobFilter.jobMatchesFilter` compares a typed `JobFilter` with a job's
JSON representation, including queued events and claimed job descriptions.
It compares every field the filter states at the same path; other fields do
not affect the match. `Semiont.Claims.willRetryAfter` takes the job's metadata
before applying a failure and its optional `FailureClass`. Its answer follows
the shared job retry cases: deterministic and withheld failures do not retry;
transient and unclassified failures retry while the record has budget left.

`Semiont.Claims.jobClaimChannels` and `jobCommitChannels` give a worker the
channels to subscribe to for claiming and committing. They are generated from
the existing SDK's worker channel declarations and the typed bus descriptors.

`Semiont.Worker` claims one job at a time. `newClaims` is lazy: the first
`next` starts claiming, and the worker claims again after settlement, a
matching announcement while idle, or a stream reopening. Bracket it with
`stop` so a job still held when the worker stops is failed for retry before
the transport closes.

```haskell
{-# LANGUAGE GADTs #-}
module WorkerExample where

import Control.Exception (bracket)
import qualified Semiont.Client as Client
import qualified Semiont.Worker as Worker
import Semiont.Types (MarkJobResult, YieldJobResult)

runWorker :: Client.Client -> Worker.WorkerOptions
  -> (Worker.HeldJob MarkJobResult -> IO MarkJobResult)
  -> (Worker.HeldJob YieldJobResult -> IO YieldJobResult)
  -> IO ()
runWorker client options mark yield =
  bracket (Worker.newClaims (Client.transport client) options) Worker.stop loop
  where
    loop claims = do
      next <- Worker.next claims
      case next of
        Nothing -> pure ()
        Just (Worker.HeldMark job) -> do
          Worker.start job
          mark job >>= Worker.complete job
          loop claims
        Just (Worker.HeldYield job) -> do
          Worker.start job
          yield job >>= Worker.complete job
          loop claims
```

`WorkerOptions` supplies a nonempty list of generated filters, `BusOptions`
for monotonic time and correlation ids, generated timing settings, and a wall
clock that returns ISO 8601 timestamps. The transport must subscribe to
`jobClaimChannels`, plus `jobCommitChannels` when the worker commits annotations.

A held job exposes the claimed record's identity, parameters, retry budget,
completed units and unit cursors. Its `cancelled` and `settled` observations
are read-only STM actions. The worker's code watches cancellation and calls
`cancel` after its work has stopped. `progress` and `checkpoint` report activity;
`complete`, `fail` and `cancel` settle once, releasing the job even if sending
the outcome fails. A mark job's completion accepts only `MarkJobResult`, and a
yield job's only `YieldJobResult`.

`commit` waits for the record's acknowledgement. If it times out, it probes
the batch's last annotation once instead of sending the batch again. Settlement
reports the weakest durability evidence observed. Supply stable annotation ids
across attempts, and count a unit completed only after its commit is established.

Use the scoped `refused` and `stalled` streams for faults the host must judge,
and `vitals` for activity snapshots. An empty queue is not a refusal. `trace`
exposes the carrier that handed over the job; a host exporting telemetry uses
that carrier as the parent of its own job span. Claims start outside the trace
of the previous job. The shared
[worker contract](../../../protocol/contract/WORKER-CONTRACT.md) states these
lifetimes and observations.

## Several knowledge bases

`Semiont.HostName.isValidHostname` checks the host names an HTTP endpoint may
use. `Semiont.Gateway.gatewayUrl` validates a typed `HttpEndpoint` and returns
its origin, with the host in lowercase and an explicit port. Invalid host
names are refused before they become part of a URL.

`Semiont.Discovery` reads a launcher's entire document and distinguishes an
absent launcher from one managing no knowledge bases. Its types and absent
reasons are derived from the protocol. Use `textDiscovery` over an application
reader, for example a launcher file:

```haskell
module Main (main) where

import qualified Data.Text.IO as Text
import Semiont.Discovery (readDiscovery, textDiscovery)

main :: IO ()
main = do
  found <- readDiscovery
    (textDiscovery (Text.readFile "/path/to/launcher-state/discovery/kbs.json"))
  print found
```

This program also needs `text` in its `build-depends`. `discoveryDiff` compares
entries by address, keeps separate copies with the same DID, and reports
duplicate address claims. `subscribeDiscovery` polls with the monotonic time,
interruptible absolute wait, and interval supplied through `DiscoveryOptions`.
Stopping consumption leaves no polling task running.

`Semiont.Http.Discovery.httpDiscovery` reads discovery over HTTP with the
caller's pool and controlled clock. Reading a discovery document does not
sign in to any of its knowledge bases.

`Semiont.Registry.newSemiontBrowser` manages registered knowledge bases,
selection, sign-in, per-KB tabs and the last viewed resource. Give it a
`SemiontBrowserConfig` with storage, a `SessionFactory`, HTTP options and an
epoch-seconds wall reader. `newHttpSessionFactory` opens real HTTP sessions
and opts their queries into per-KB durable storage. The browser closes the
previous client before opening the next, joins stale activations, and raises
identity-conflict notices when the address answers as a different KB. A
redirect sign-in proves the responding identity before adopting its grant.
Use `beginSignIn` and `completeSignIn`; navigation remains the host's job.
Removing an entry also removes its owned cache documents and replay bookmark.
The supplied storage belongs to one principal's profile, including its tokens,
tabs and caches. Close the browser and switch storage when changing profiles.


```haskell
module KnowledgeBases where
import Control.Exception (bracket)
import Data.Scientific (Scientific)
import qualified Semiont.Http as Http
import qualified Semiont.Registry as Registry
import qualified Semiont.SessionStorage as Storage

withKnowledgeBases :: Storage.SessionStorage -> Http.HttpOptions -> IO Scientific
  -> (Registry.SemiontBrowser -> IO result) -> IO result
withKnowledgeBases storage http wall = bracket
  (Registry.newSemiontBrowser (Registry.SemiontBrowserConfig storage
    (Registry.newHttpSessionFactory http wall) http wall))
  Registry.dispose
```

`wall` returns epoch seconds. This example also needs `scientific` in its
`build-depends`. Observe `Registry.kbs`, `activeKbId`, `activeSession` and
`activeSignals`, and call `setActiveKb` to select an entry.

## IDs and protocol types

Import models from `Semiont.Types`. Distinct identifier types expose checked
makers such as `mkResourceId`; their constructors are hidden. JSON decoders
apply the same protocol constraints. Optional nullable properties use
`Semiont.Types.Presence`, whose `Absent`, `Null`, and `Present` cases preserve
JSON membership. Other optional properties use `Maybe`.

`Semiont.Resources` reads a descriptor's primary representation, primary media
type and entity types. Representation order decides which is primary; media
types retain their case and parameters.

Records preserve extra members when their schema permits them. Closed enums
and unions are algebraic types. JSON numbers use `Integer` or `Scientific`,
and date and URI values retain their `Text` spelling.

`Semiont.Channels` provides GADT descriptors. Each channel has its own payload
type and scope kind; each operation fixes its request, result, and failure
types. The typed bus requires `InScope resourceId` when observing a
resource-scoped channel.

## Errors and retry

`Semiont.ErrorCodes` derives closed error vocabularies and wire/HTTP status
classifiers from the protocol. `Semiont.Timing` derives the timing constants
and retry budgets.

`Semiont.Retry` provides retry decisions, `Retry-After` parsing, and
`retryWithBackoff`. Its `RetryOptions` requires caller-supplied monotonic
nanoseconds, an interruptible wait to an absolute deadline, and non-secret
jitter. Cancellation is preserved, each retry respects the server's stated
wait, and the last failure is raised when the budget is exhausted.

## The bus and transport

Every `ContentTransport` read and upload takes `Maybe Text` immediately after
the transport. `Nothing` uses its held credential and normal renewal policy.
`Just accessToken` makes one explicit-credential attempt; refusal never renews
or quarantines the held credential. Scoped streams and replayable uploads keep
the same ownership rules in either mode.

`Semiont.Transport.newTransport` gives a carrier its input handle and the
transport its consumers use. The carrier supplies sending and teardown, feeds
received frames through `receive`, frame refusals through `receiveRefusal`, and publishes valid connection transitions
through `setState`. Its subscription snapshot contains the current resource
holds and pending correlations. `Semiont.StateValue` exposes state observations
without a public setter.

Build a `Semiont.Bus` with `newBus`, a transport, and `BusOptions`. The options
supply monotonic time, an interruptible absolute wait, and fresh correlation
IDs. Each request waits for the stream to open, tracks its reply before sending,
emits once, and ends on a reply, deadline, cancellation, or transport close.
For example, given a bus and a typed command:

```haskell
module ProtocolCalls (addEntityType) where

import qualified Semiont.Bus as Bus
import qualified Semiont.Channels as Channels
import qualified Semiont.Timing as Timing
import Semiont.Types (EmptyBusPayload, FrameAddEntityTypeCommand)

addEntityType :: Bus.Bus -> FrameAddEntityTypeCommand -> IO EmptyBusPayload
addEntityType wire command =
  Bus.request wire Channels.FrameAddEntityTypeOperation command
    Timing.busRequestTimeoutMs
```

`Bus.frames` requires `InScope resourceId` for a resource channel and holds that
scope until its reader leaves. It yields `Heard delivered` or `Refused refusal`
in order, and continues after a refusal. Deliveries retain their emitter,
envelope, and trace. A refusal keeps the channel, optional raw payload, scope,
readable correlation ID, and a `Fault`: its `member`
path and `Lacks` or `Malformed` reason. Successful HTTP answers and stream
frames are checked against the same generated rules that the other SDKs use;
a diagnostic never includes the rejected value. The trace field is lifted out
of the payload.

`Semiont.EventBus` is the client's separate local plane. A transport bridge
publishes raw replies there before request continuations can emit derived
signals. Detach a bridge through its returned release action. Closing a
transport completes its observations, ends pending requests, and joins its
callback workers; closing from one of those callbacks does not join itself.

The HTTP adapter reconnects with bounded backoff, drains the old stream during
scope handoffs, deduplicates overlap, and loads/saves per-resource replay
positions through the supplied callbacks. Credential renewal receives the
refused token; a credential refused again is quarantined until the host supplies
a usable one. Ordinary reads retry once when eligible, and an unanswered request
at its own deadline fails without another attempt.

Raw transport and local-bus readers receive `Carried`: `Arrived frame` or
`FrameRejected refusal`. `stream` and `on` expose the corresponding
`Either FrameRefusal Object`. Malformed envelopes with a usable channel and
scope reach those readers and any request identified by their correlation ID.
An invalid scope or unusable channel reaches the transport error report. A
typed reader names payload faults from the frame, such as `payload.resourceId`.
A renewed emit credential starts a fresh retry budget and backoff.

## Telemetry

The SDK uses the application's OpenTelemetry tracer/meter providers and text-map
propagator. It creates no provider or exporter. Bus sends and receives, uploads,
and content reads record the spans and counter declared by the shared telemetry
table. Outgoing HTTP requests carry the host's injected headers; incoming frames
are processed under its extracted context. Caller context also crosses request
work, operation producers and callback tasks using the standard propagation API.


## Testing applications

`Semiont.Testing.Transport` scripts answers and faults around the real native
carrier. Queue typed JSON responses by operation; requests left unscripted fail
by name. A dropped reply still consumes the peer's answer. `SharedStorage`
gives several contexts atomic access to the same values and notifies only other
contexts. `createTestSession` builds a real session over a supplied real client.
`ScriptedSessions` supplies a registry factory and records its transports,
renewals and revocations; script its users, answers and renewal results explicitly.

`Semiont.Testing.Liveness` supplies QuickCheck generators and executable L1/L2/L3
checks. Give `assertLivenessAxioms` QuickCheck arguments and a `LivenessSpec`
with the composition, timeout, retry budget, case count, fault generator,
responder and controlled clock. Outputs must reach a value or a failure;
awaited paths must settle within the bound, and retries must stay within budget.
`assertExactlyOnceDelivery` drives a supplied `DeliverySubject` through generated
writes and transitions and checks each written ID was delivered once.
Use the caller's clock for those waits; real sockets can use an actual host clock.

## Building and verifying

From the repository root, build and test in Apple `container`:

```sh
bash packages/haskell/run-container.sh
```

CI runs the same entry point with `docker` as its argument. The compiler and
Cabal pins are shared with [the design probes](../probes/README.md); exact
project dependencies are frozen. Ordinary builds use checked-in generated
files and require no npm or schema generation.

The runner builds `conformance/bin/semiont-haskell-wire-driver` and
`conformance/bin/semiont-haskell-live-driver`. The shared
[SDK conformance suite](../../../protocol/conformance/sdk/README.md) drives them
through the public SDK against the real gateway on both signal planes, including
OTLP export. Worker conformance uses the wire driver. CI transfers both tested
drivers to the corresponding conformance jobs.

Inside the development container, from this package directory:

```sh
cabal run semiont-codegen -- /work
cabal build all --enable-tests --enable-coverage -j1
python3 api.py --write
bash run.sh /work
```

Here `/work` is the repository root. The Haskell generator derives protocol
types, channel descriptors, error codes, timing, the module list, and the
package version. Refresh `public-api.json` after library source changes;
GHC supplies the reachable types, constructors, and signatures through the
public Cabal modules, including re-exports. The census checks source
freshness; the Haskell job compares actual compiled exports. All shared
client-surface sections include Haskell.

### What the checks cover

The schema suite generates samples from the schema definitions, checks JSON
round trips, absence/null behavior, closed enums, exact large numbers, and
permitted extra members. It also executes the shared identifier table and
every shared job-filter, job-retry, and gateway URL case, and checks resolved
JSON payloads from the wire, live-query, and worker corpora.
The wire driver additionally executes the transport scenarios against the real
gateway on both signal planes. The worker driver runs every worker case against
the real gateway on both planes as well. The live-query driver executes all
parity cases and table-derived refresh cases. The three layers currently total
232 cases across both planes.
All 76 shared state-unit cases execute, with separate cache and session suites.
All 15 shared clock subjects run in-process at the protocol timings, including
HTTP waits, scope handoffs, cache saves, discovery, session renewal, device
polling, delegation, invalidation windows and held-job stalls. Every shared
session startup/refusal case also runs, including recovery after an unanswered
renewal. Issuer tests use byte-level HTTP connections for discovery, PKCE,
one-shot callbacks, atomic grant rotation and revocation.
`npm run lint:haskell-complete` rejects any remaining Haskell table exemption,
missing census reader or missing parity conformance driver. CI runs it as
**Haskell SDK Completion**, separately from checks of the implemented surface.

Runtime tests also cover atomic publication of raw replies before request
continuations, channel/correlation matching, tracking cleanup on cancellation,
close waking pending requests, SSE chunk boundaries, and operation ownership.

See [the design probe results](../probes/README.md) for the measured HTTP,
resource-lifetime, telemetry, crypto, and native-lock behavior.

## License

[Apache-2.0](LICENSE).
