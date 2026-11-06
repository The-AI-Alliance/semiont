{-# LANGUAGE OverloadedStrings #-}
module HttpCases (httpCases) where

import TestProcess (python)
import Control.Concurrent (threadDelay)
import Control.Concurrent.Async (async, cancel, wait)
import Control.Concurrent.STM
import Control.Exception (bracket, finally, onException, try)
import Control.Monad (unless, void, forM_)
import Data.Aeson (Value(..), eitherDecodeStrict', eitherDecode, encode, fromJSON, toJSON, Result(..), object, (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import Data.Foldable (toList)
import Data.IORef
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (getContext, attachContext, detachContext)
import qualified OpenTelemetry.Propagator as Propagator
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Data.UUID.Types as UUID
import Data.Text.Encoding (encodeUtf8)
import Network.HTTP.Client
import Network.URI (parseURI, uriAuthority, uriPort, uriRegName)
import Text.Read (readMaybe)
import qualified Semiont.Auth as Auth
import qualified Semiont.Identity as Principal
import qualified Semiont.Registry.Identity as Identity
import qualified Semiont.Bus as Bus
import Semiont.Channels (globalChannels, channelName, Channel(FrameEntityTypeAddOk))
import qualified Semiont.Http.Routes as Routes
import qualified Semiont.Timing as Timing
import qualified Semiont.Timing.Settings as Settings
import Semiont.Transport.Facts (traceField)
import qualified Semiont.Client as Client
import qualified Semiont.Content as Content
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import qualified Semiont.Frame as Frame
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Http as Http
import qualified Semiont.Retry as Retry
import qualified Semiont.StateValue as State
import qualified Semiont.System as System
import qualified Semiont.Transport as Transport
import Semiont.Types
import System.Directory (removeFile, getTemporaryDirectory)
import System.Environment (lookupEnv, setEnv, unsetEnv)
import GHC.IO.Handle (hDuplicate, hDuplicateTo)
import System.FilePath ((</>))
import System.IO (stderr, hIsClosed, hClose, hGetLine, hPutStrLn, hFlush, openBinaryTempFile)
import System.Process
import System.Timeout (timeout)
import qualified Streaming.Prelude as Stream

withBusLogs :: IO () -> IO ()
withBusLogs work = do
  temporary <- getTemporaryDirectory
  bracket (openBinaryTempFile temporary "semiont-http-bus-log")
    (\(filename,handle) -> do closed <- hIsClosed handle; unless closed (hClose handle); removeFile filename) $ \(filename,handle) -> do
      bracket (lookupEnv "SEMIONT_BUS_LOG")
        (maybe (unsetEnv "SEMIONT_BUS_LOG") (setEnv "SEMIONT_BUS_LOG")) (\_ -> do
          setEnv "SEMIONT_BUS_LOG" "1"
          bracket (hDuplicate stderr) (\original -> hDuplicateTo original stderr >> hClose original) $ \_ -> do
            hDuplicateTo handle stderr
            work
            hFlush stderr)
        -- The peer's stderr is this file too, so a failure shows what the peer and the client said beside the bus log.
        `onException` (do
          hClose handle
          said <- filter (not . Bytes.isPrefixOf "[bus ") . Bytes.split 10 <$> Bytes.readFile filename
          hPutStrLn stderr "The HTTP peer's and client's stderr, without its bus-log lines:"
          Bytes.hPut stderr (Bytes.intercalate "\n" (drop (length said - 200) said) <> "\n"))
      hClose handle
      bytes <- Bytes.readFile filename
      let linesSeen=filter (Bytes.isPrefixOf "[bus ") (Bytes.split 10 bytes)
      forM_ ["EMIT","RECV","GET","PUT"] $ \op ->
        require "HTTP transport omitted a bus-log choke point" (any (Bytes.isPrefixOf ("[bus "<>op<>"] ")) linesSeen)
      forM_ linesSeen $ \line -> do
        let (_,payload)=Bytes.breakSubstring " {" line
        require "HTTP bus-log line has no complete JSON payload" (case eitherDecodeStrict' (Bytes.drop 1 payload) :: Either String Value of Right (Object _)->True; _->False)
      require "HTTP bus log did not exercise credential withholding" ("[withheld]" `Bytes.isInfixOf` bytes)
      require "HTTP bus log printed a credential" (not ("credential-not-for-bus-log" `Bytes.isInfixOf` bytes) && not ("proof-credential-not-for-log" `Bytes.isInfixOf` bytes))

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

httpCases :: FilePath -> Map.Map Text Value -> IO ()
httpCases root fixtures = do
  reached <- newIORef "the client's opening"
  result <- timeout 60000000 $ withBusLogs $ withPeer root fixtures reached $ \peer -> do
    exercised <- timeout 20000000 (exercise peer)
    unless (exercised == Just ()) $ readIORef reached >>= \step ->
      ioError (userError ("real HTTP integration liveness deadline expired at " ++ step))
  require "real HTTP peer start or stop deadline expired" (result == Just ())
  putStrLn "PASS real HTTP/SSE, typed client, content scopes, upload renewal and ownership"
  where
    exercise peer = do
      let origin = peerOrigin peer
      clock <- newTVarIO (0 :: Integer)
      waits <- newTVarIO Set.empty
      ids <- newTVarIO (0 :: Integer)
      supplied <- newTVarIO (Just "initial")
      renewals <- newIORef ([] :: [Text])
      hookRequests <- newIORef (0 :: Int)
      let fresh = atomically $ do
            modifyTVar' ids (+ 1)
            number <- readTVar ids
            pure (UUID.fromWords 0 0 0 (fromInteger number))
          time = Retry.RetryOptions (readTVarIO clock) (\due -> atomically (modifyTVar' waits (Set.insert due)) >> atomically (readTVar clock >>= check . (>= due))) (pure 0)
          options client = Http.HttpOptions origin client (readTVarIO supplied)
            (\refused -> modifyIORef' renewals (++ [refused]) >> pure (Just "renewed")) time Settings.protocolSettings fresh
            (Set.fromList globalChannels) (pure Map.empty) (\_ _ -> pure ())
      pool <- Http.newHttpClient noProxy defaultManagerSettings
        { managerModifyRequest = \asked -> modifyIORef' hookRequests (+ 1) >> pure asked }
      http <- Http.newHttpTransport (options pool)
      let busOptions = Bus.BusOptions (Retry.retryNow time) (Retry.retryWaitUntil time) (UUID.toText <$> fresh)
      client <- Client.newClient (Http.transport http) (Http.content http) (Just (Http.gateway http)) busOptions Settings.protocolSettings Nothing
      let contents = Client.content client
          fromFixture name = case Map.lookup name fixtures of
            Nothing -> error ("test fixture missing: " ++ Text.unpack name)
            Just value -> case fromJSON value of Error reason -> error reason; Success answer -> answer
      resource <- either (ioError . userError) pure (mkResourceId "download")
      (do
        atomically (State.current (Client.state client) >>= check . (== Transport.Open))
        reach peer "the connection proof"
        target <- case parseURI (Text.unpack origin) >>= uriAuthority of
          Just address -> case readMaybe (drop 1 (uriPort address)) of
            Just port -> pure (HttpEndpoint (Text.pack (uriRegName address)) HttpEndpointKindHttp port HttpEndpointProtocolHttp mempty)
            Nothing -> ioError (userError "HTTP peer named no port")
          Nothing -> ioError (userError "HTTP peer named no origin")
        proven <- Identity.describeConnection (options pool) target "proof-credential-not-for-log"
        let expectedDescription=fromFixture "KbDescription"
        expectedDid <- either (ioError . userError) pure (Principal.kbDid (kbDescriptionDomain expectedDescription))
        require "connection proof invented a knowledge-base identity" (connectionIdentityDescription proven==expectedDescription && connectionIdentityDid proven==expectedDid)
        require "connection proof changed the caller's credential source" . (==Just "initial") =<< readTVarIO supplied
        require "connection proof used the caller's inherited refresher" . null =<< readIORef renewals
        proofRequests <- readState peer
        require "connection proof did not send the supplied issued credential"
          (any (\value -> case field "body" value of
            Just (Object body) -> KM.lookup "channel" body==Just (String "browse:kb-requested")
              &&field "token" value==Just (String "Bearer proof-credential-not-for-log")
            _->False) (values "requests" proofRequests))
        postControl peer "/test/config" (object ["refusedOperations" .= [String "browse:kb-requested"]])
        notReported <- try (Identity.describeConnection (options pool) target "proof-credential-not-for-log") :: IO (Either Identity.IdentityUnverifiableError ConnectionIdentity)
        require "a KB which refused to describe itself was reported as unreachable" (case notReported of Left failure->Identity.identityUnverifiableReason failure==Code.KbIdentityNotReported; _->False)
        postControl peer "/test/config" (object ["refusedOperations" .= ([]::[Text]),"emitStatuses" .= ([403]::[Int])])
        unreachable <- try (Identity.describeConnection (options pool) target "proof-credential-not-for-log") :: IO (Either Identity.IdentityUnverifiableError ConnectionIdentity)
        require "an unreachable KB was reported as having refused its identity" (case unreachable of Left failure->Identity.identityUnverifiableReason failure==Code.KbIdentityUnreachable; _->False)
        void $ Frame.addEntityType (Client.frame client) "Entity"
        void $ Frame.addEntityTypes (Client.frame client) ["One", "Two"]
        void $ Frame.addTagSchema (Client.frame client) (fromFixture "TagSchema")
        reach peer "trace propagation"
        propagationKey <- Context.newKey "HTTP propagator caller"
        injectedContexts <- newIORef ([] :: [Maybe Text])
        extractions <- newIORef (0 :: Int)
        let carrier = fromFixture "TraceCarrier" :: TraceCarrier
            carrierPairs = case toJSON carrier of
              Object fields -> [(Key.toText key,value) | (key,String value) <- KM.toList fields]
              _ -> error "generated trace carrier is not an object"
            propagator = Propagator.Propagator (map fst carrierPairs)
              (\_ context -> modifyIORef' extractions (+ 1) >> pure context)
              (\context _ -> do
                modifyIORef' injectedContexts (++ [Context.lookup propagationKey context])
                pure (Propagator.textMapFromList (("other-host-field", "not a trace field") : carrierPairs)))
        callerContext <- getContext
        bracket Propagator.getGlobalTextMapPropagator Propagator.setGlobalTextMapPropagator $ \_ -> do
          Propagator.setGlobalTextMapPropagator propagator
          bracket (attachContext (Context.insert propagationKey ("caller" :: Text) callerContext)) detachContext $ \_ ->
            void $ Frame.addEntityType (Client.frame client) "Propagated"
        readIORef injectedContexts >>= require "transport injection lost the caller's context" . (== [Just "caller"])
        readIORef extractions >>= require "transport ignored the host's extractor" . (> 0)
        restoredContext <- getContext
        require "transport propagation changed the caller's context"
          (Context.lookup propagationKey restoredContext == Context.lookup propagationKey callerContext)
        propagated <- readState peer
        let traces = [trace | Object record <- values "requests" propagated,
              Just (Object body) <- [KM.lookup "body" record], Just (Object payload) <- [KM.lookup "payload" body],
              Just trace <- [KM.lookup (Key.fromText traceField) payload]]
            headers = [fields | Object record <- values "requests" propagated, Just (Object fields) <- [KM.lookup "headers" record]]
        require "transport changed the domain payload to propagate a trace" (null traces)
        require "transport did not use the host's HTTP propagation headers"
          (any (\fields -> all (\(key,value) -> KM.lookup (Key.fromText key) fields == Just (String value)) carrierPairs
            && KM.lookup "other-host-field" fields == Just (String "not a trace field")) headers)
        httpFaults peer http client resource clock waits
        reach peer "the typed namespaces and content reads"
        case Client.auth client of
          Nothing -> ioError (userError "HTTP client has no auth namespace")
          Just auth -> do
            Auth.me auth Nothing >>= require "typed current user changed" . (== fromFixture "UserResponse")
            Auth.mediaToken auth resource >>= require "typed media token changed" . (== fromFixture "MediaTokenResponse")
            Auth.protectedResourceMetadata auth >>= require "protected metadata changed" . (== fromFixture "ProtectedResourceMetadata")
        case Client.system client of
          Nothing -> ioError (userError "HTTP client has no system namespace")
          Just statusNamespace -> do
            System.healthCheck statusNamespace >>= require "typed health changed" . (== fromFixture "HealthResponse")
            System.status statusNamespace >>= require "typed status changed" . (== fromFixture "StatusResponse")
        Content.getResourceGraph contents Nothing resource >>= require "typed resource graph changed" . (== fromFixture "GetResourceResponse")
        Content.getAnnotations contents Nothing resource >>= require "typed annotation response changed" . (== fromFixture "GetAnnotationsResponse")
        Content.getAnchoredText contents Nothing resource >>= require "anchored text sum changed" . (== fromFixture "AnchoredTextAnswer")
        beforeOverrideRenewals <- readIORef renewals
        Content.getResourceGraph contents (Just "content-override") resource >>= require "explicit graph response changed" . (== fromFixture "GetResourceResponse")
        Content.getAnnotations contents (Just "content-override") resource >>= require "explicit annotations response changed" . (== fromFixture "GetAnnotationsResponse")
        Content.getAnchoredText contents (Just "content-override") resource >>= require "explicit anchored text response changed" . (== fromFixture "AnchoredTextAnswer")
        explicitBinary <- Content.getBinary contents (Just "content-override") resource
        require "explicit download changed bytes" (Content.contentBytes explicitBinary==encodeUtf8 "hello λ")
        Content.getBinaryStream contents (Just "content-override") resource (\_ chunks->Stream.effects chunks)
        overrideState <- readState peer
        let explicitReads=[value|value<-values "requests" overrideState,field "token" value==Just (String "Bearer content-override")]
        require "not every content reader sent its explicit credential" (length explicitReads==5)
        refusedOverride <- try (Content.getBinary contents (Just "refused-content-override") resource) :: IO (Either TransportError Content.BinaryContent)
        require "explicit content credential refusal was not final" (case refusedOverride of Left problem->transportErrorCode problem==Code.TransportUnauthorized; Right _->False)
        readIORef renewals >>= require "an explicit content credential renewed the held token" . (==beforeOverrideRenewals)
        contextKey <- Context.newKey "HTTP consumer context"
        beforeContext <- getContext
        bracket (attachContext (Context.insert contextKey ("consumer" :: Text) beforeContext)) detachContext $ \_ ->
          Content.getBinaryStream contents Nothing resource $ \_ chunks -> do
            actualContext <- getContext
            require "HTTP callback lost the caller's trace context" (Context.lookup contextKey actualContext == Just "consumer")
            Stream.effects chunks
        afterContext <- getContext
        require "HTTP callback leaked its context to the caller" (Context.lookup contextKey afterContext == Context.lookup contextKey beforeContext)
        binary <- Content.getBinary contents Nothing resource
        require "download did not preserve bytes/media type" (Content.contentBytes binary == encodeUtf8 "hello λ" && Content.contentType binary == "text/plain; charset=utf-8")
        escaped <- Content.getBinaryStream contents Nothing resource (\_ chunks -> pure chunks)
        outside <- try (Stream.effects escaped) :: IO (Either TransportError ())
        require "escaped content reader was usable" (either (const True) (const False) outside)
        reach peer "uploads"
        atomically (writeTVar supplied (Just "renew-upload"))
        opens <- newIORef (0 :: Int)
        progress <- newIORef []
        let metadata = (fromFixture "ResourceUploadMetadata")
              { resourceUploadMetadataName = "upload λ\".txt", resourceUploadMetadataFormat = "text/plain", resourceUploadMetadataStorageUri = "local", resourceUploadMetadataCloneToken = Just "credential-not-for-bus-log" }
            bytes = encodeUtf8 "complete upload λ"
            source = (Content.bytesBody bytes) { Content.openBody = \consume -> modifyIORef' opens (+ 1) >> Content.openBody (Content.bytesBody bytes) consume }
        uploaded <- Content.putBinary contents Nothing metadata source (\value -> modifyIORef' progress (++ [value]))
        require "upload response changed" (uploaded == createResourceResponseResourceId (fromFixture "CreateResourceResponse"))
        readIORef opens >>= require "renewal did not reopen the complete upload" . (== 2)
        readIORef renewals >>= require "renewal did not receive the refused token exactly once" . (== ["renew-upload"])
        notices <- readIORef progress
        require "upload progress decreased across replay" (and (zipWith (<=) (map Content.bytesUploaded notices) (drop 1 (map Content.bytesUploaded notices))))
        require "upload progress lost its total" (last notices == Content.UploadProgress (fromIntegral (Bytes.length bytes)) (fromIntegral (Bytes.length bytes)))
        state <- readState peer
        let uploads = values "uploads" state
        case uploads of
          [first, second] -> require "upload attempts changed the idempotency key" (field "key" first == field "key" second)
          _ -> ioError (userError "upload did not have exactly two attempts")
        require "replayed upload lost bytes" (all (\value -> case field "parts" value of Just (Object fields) -> KM.lookup "file" fields == Just (String "complete upload λ"); _ -> False) uploads)
        postControl peer "/test/config" (object ["uploadStatuses" .= ([503]::[Int])])
        retryProgress <- newIORef []
        began <- readTVarIO clock
        retriedUpload <- async (Content.putBinary contents Nothing metadata source (\value -> modifyIORef' retryProgress (++[value])))
        let retryAt=began+Timing.requestRetryPauseMs*1000000
        waitForDeadline waits retryAt
        atomically (writeTVar clock retryAt)
        wait retriedUpload >>= require "retried upload returned another resource" . (==uploaded)
        readIORef opens >>= require "a retry did not reopen the upload's byte source" . (==4)
        afterRetry <- readState peer
        let repeats=drop 2 (values "uploads" afterRetry)
        case repeats of
          [first,second] -> do
            require "an upload retry changed its idempotency key" (field "key" first==field "key" second)
            require "another upload reused an earlier upload's key" (field "key" first `notElem` map (field "key") uploads)
          _ -> ioError (userError "keyed upload did not have exactly one retry")
        retriedNotices <- readIORef retryProgress
        require "upload progress decreased across retry" (and (zipWith (<=) (map Content.bytesUploaded retriedNotices) (drop 1 (map Content.bytesUploaded retriedNotices))))
        beforeExplicitUpload <- readIORef renewals
        Content.putBinary contents (Just "content-override") metadata source (const (pure ())) >>= require "explicit upload returned another resource" . (==uploaded)
        postControl peer "/test/config" (object ["uploadStatuses" .= ([401]::[Int])])
        failedExplicitUpload <- try (Content.putBinary contents (Just "refused-content-override") metadata source (const (pure ()))) :: IO (Either TransportError ResourceId)
        require "explicit upload credential refusal was not final" (case failedExplicitUpload of Left problem->transportErrorCode problem==Code.TransportUnauthorized; Right _->False)
        readIORef renewals >>= require "explicit upload refusal renewed the held token" . (==beforeExplicitUpload)
        afterExplicitUpload <- readState peer
        let explicitUploads=drop 4 (values "uploads" afterExplicitUpload)
        require "explicit upload inherited or retried a credential" (map (field "token") explicitUploads==[Just (String "Bearer content-override"),Just (String "Bearer refused-content-override")])
        Content.getBinary contents Nothing resource >>= require "explicit refusal quarantined the held credential" . (\value->Content.contentBytes value==encodeUtf8 "hello λ")
        let invalidSource = (Content.bytesBody bytes) { Content.bodyLength = Just (-1) }
        invalidUpload <- try (Content.putBinary contents Nothing metadata invalidSource (const (pure ()))) :: IO (Either TransportError ResourceId)
        require "negative upload size was accepted" (either ((== Code.TransportBadRequest) . transportErrorCode) (const False) invalidUpload)
        malformed <- either (ioError . userError) pure (mkResourceId "malformed")
        malformedAnswer <- try (Content.getResourceGraph contents Nothing malformed) :: IO (Either TransportError GetResourceResponse)
        require "malformed HTTP JSON was accepted" (either ((== Code.TransportError) . transportErrorCode) (const False) malformedAnswer)
        refused <- either (ioError . userError) pure (mkResourceId "refused")
        Transport.errors (Client.transport client) $ \failures -> do
          answer <- try (Content.getBinary contents Nothing refused) :: IO (Either TransportError Content.BinaryContent)
          case answer of
            Right _ -> ioError (userError "HTTP refusal became content")
            Left problem -> do
              require "HTTP refusal lost the gateway's words/status" (httpStatus problem == Just 403 && transportErrorCode problem == Code.TransportForbidden && Text.isInfixOf "gateway words preserved" (transportErrorMessage problem))
              noticed <- Stream.toList_ (Stream.take 1 failures)
              require "HTTP refusal was not observed before throw" (noticed == [problem])
        readIORef hookRequests >>= require "caller HTTP hooks were not used" . (> 10)
        Content.dispose contents
        closedContent <- try (Content.getBinary contents Nothing resource) :: IO (Either BusRequestError Content.BinaryContent)
        require "disposed content still performed I/O" (either ((== Code.BusRequestClosed) . busRequestErrorCode) (const False) closedContent)
        Gateway.healthCheck (Http.gateway http) >>= require "disposing content closed the caller's HTTP pool" . (== fromFixture "HealthResponse")
        ) `finally` Client.dispose client
      reach peer "the client's disposal"
      Client.dispose client
      _ <- awaitState peer (\value -> length (values "subscriptions" value) == count "disconnected" value)
      credentialCases peer (options pool) supplied renewals clock waits
      recoveryCases peer (options pool) clock waits
      pure ()

httpFaults :: Peer -> Http.HttpTransport -> Client.Client -> ResourceId -> TVar Integer -> TVar (Set.Set Integer) -> IO ()
httpFaults peer http client resource clock waits = do
  reach peer "the stream's opening"
  baseline <- awaitState peer (\value -> length (values "subscriptions" value)-count "disconnected" value==1)
  let beforeSubscriptions=length (values "subscriptions" baseline)
      beforeDisconnected=count "disconnected" baseline
  bracket (Transport.subscribeToResource (Http.transport http) resource) id $ \_ -> do
    began <- readTVarIO clock
    waitForDeadline waits (began + Timing.reconnectDebounceMs * 1000000)
    atomically (writeTVar clock (began + Timing.reconnectDebounceMs * 1000000))
    _ <- awaitState peer ((>= beforeSubscriptions+1) . length . values "subscriptions")
    connection <- atomically (State.current (Client.state client))
    require "subscription handoff changed an open connection's state" (connection == Transport.Open)
    let channel = channelName FrameEntityTypeAddOk
        publish correlation = postControl peer "/test/publish" (object
          [ "id" .= ("e-" <> channel <> ":" <> correlation)
          , "frame" .= BusFrame channel (Just correlation) (BusFramePayload mempty) Nothing
          ])
    reach peer "overlapping streams"
    Transport.frames (Http.transport http) channel $ \frames -> do
      publish "first"
      publish "first"
      publish "second"
      seen <- Stream.toList_ (Stream.take 2 frames)
      require "overlapping streams duplicated a reply" (map Transport.carriedCorrelationId seen == [Just "first", Just "second"])
    state <- readState peer
    require "old stream was aborted before its drain window" (count "disconnected" state == beforeDisconnected)
    let retiredAt = began + (Timing.reconnectDebounceMs + Timing.lingerMs) * 1000000
    waitForDeadline waits retiredAt
    atomically (writeTVar clock retiredAt)
    _ <- awaitState peer ((>= beforeDisconnected+1) . count "disconnected")

    reach peer "a refused frame"
    Transport.errors (Http.transport http) $ \failures -> Transport.frames (Http.transport http) channel $ \frames -> do
      postControl peer "/test/publish" (object
        [ "id" .= ("e-frame-refusal" :: Text), "frame" .= object ["payload" .= object []] ])
      publish "after-refusal"
      refused <- Stream.head_ failures
      require "an unnamed malformed frame did not reach the failure report" (refused == Just
        (TransportError Code.TransportError "the stream carried what is not a frame: it has no `channel`" Nothing Nothing))
      continued <- Stream.head_ frames
      require "a malformed frame ended the stream" (fmap Transport.carriedCorrelationId continued == Just (Just "after-refusal"))

    reach peer "emit retries"
    postControl peer "/test/config" (object ["emitStatuses" .= ([429, 503] :: [Int])])
    atomically (writeTVar waits Set.empty)
    retryAt <- readTVarIO clock
    retrying <- async (Frame.addEntityType (Client.frame client) "Retried")
    let firstWait = retryAt + Timing.retryInitialDelayMs Timing.emitRetry * 1000000 `div` 2
        secondWait = firstWait + Timing.retryInitialDelayMs Timing.emitRetry * 1000000
    waitForDeadline waits firstWait
    atomically (writeTVar clock firstWait)
    waitForDeadline waits secondWait
    atomically (writeTVar clock secondWait)
    void (wait retrying)
    attempted <- readState peer
    let asks = filter (\value -> field "path" value == Just (String (Routes.routePath Routes.EmitOnBus))) (values "requests" attempted)
        lastThree = drop (length asks - 3) asks
    require "emit retries changed their idempotency key" (length lastThree == 3 && Set.size (Set.fromList (map (field "key") lastThree)) == 1)

    atomically (writeTVar waits Set.empty)
    reach peer "a request unanswered at its deadline"
    headerResource <- either (ioError . userError) pure (mkResourceId "headers")
    headerStart <- readTVarIO clock
    stalled <- async (try (Content.getBinary (Http.content http) Nothing headerResource) :: IO (Either TransportError Content.BinaryContent))
    let headerDeadline = headerStart + Timing.httpRequestTimeoutMs * 1000000
    waitForDeadline waits headerDeadline
    let headerPath = Text.replace "{id}" (resourceIdValue headerResource) (Routes.routePath Routes.GetResourceRepresentation)
    _ <- awaitState peer (any (\value -> field "path" value == Just (String headerPath)) . values "requests")
    atomically (writeTVar clock headerDeadline)
    result <- wait stalled
    require "unanswered request was not classified unavailable" (either ((== Code.TransportUnavailable) . transportErrorCode) (const False) result)
    afterHeaders <- awaitState peer ((== 1) . count "headersClosed")
    require "a request unanswered at its deadline was retried" (length (filter (\value -> field "path" value == Just (String headerPath)) (values "requests" afterHeaders)) == 1)

    reach peer "an abandoned response body"
    bodyResource <- either (ioError . userError) pure (mkResourceId "body")
    entered <- newEmptyTMVarIO
    reader <- async (Content.getBinaryStream (Http.content http) Nothing bodyResource $ \_ chunks -> do
      first <- Stream.next chunks
      case first of
        Left () -> ioError (userError "body stream ended before its first byte")
        Right (_, rest) -> atomically (putTMVar entered ()) >> Stream.effects rest)
    atomically (takeTMVar entered)
    atomically (modifyTVar' clock (+ (Timing.httpRequestTimeoutMs * 2000000)))
    stillOpen <- atomically (State.current (Client.state client))
    require "idle SSE stream inherited an HTTP response timeout" (stillOpen == Transport.Open)
    cancel reader
    _ <- awaitState peer ((== 1) . count "bodyClosed")
    pure ()

credentialCases :: Peer -> Http.HttpOptions -> TVar (Maybe Text) -> IORef [Text] -> TVar Integer -> TVar (Set.Set Integer) -> IO ()
credentialCases peer options supplied renewals clock waits = do
  reach peer "a refused stream credential"
  atomically (writeTVar supplied (Just "refused") >> writeTVar waits Set.empty)
  writeIORef renewals []
  postControl peer "/test/config" (object ["gateSubscribe" .= True, "subscribeFailures" .= ([401, 401] :: [Int])])
  bracket (Client.fromHttp options Nothing) Client.dispose $ \client -> do
    began <- readTVarIO clock
    Transport.errors (Client.transport client) $ \errors -> do
      postControl peer "/test/config" (object ["gateSubscribe" .= False])
      failures <- Stream.toList_ (Stream.take 2 errors)
      require "stream credential refusal lost status or peer words" (all (\problem -> httpStatus problem == Just 401 && Text.isInfixOf "stream credential refused" (transportErrorMessage problem)) failures)
      atomically (State.current (Client.state client) >>= check . (== Transport.Unauthenticated))
      first <- readState peer
      let attempts state = length (filter (\value -> case value of
            Object fields -> KM.lookup "path" fields == Just (String (Routes.routePath Routes.SubscribeToBus))
            _ -> False) (values "requests" state))
          firstPoll = began + Timing.reconnectMs * 1000000
          secondPoll = began + Timing.reconnectMs * 2000000
      waitForDeadline waits firstPoll
      atomically (writeTVar clock firstPoll)
      waitForDeadline waits secondPoll
      second <- readState peer
      require "a twice-refused stream credential was sent again" (attempts first == attempts second)
      readIORef renewals >>= require "stream renewed more than once in one outage" . (== ["refused"])
      atomically (writeTVar supplied (Just "fresh") >> writeTVar clock secondPoll)
      atomically (State.current (Client.state client) >>= check . (== Transport.Open))
      void $ Frame.addEntityType (Client.frame client) "Recovered"
      require "client base URL changed" (Client.baseUrl client == peerOrigin peer)

recoveryCases :: Peer -> Http.HttpOptions -> TVar Integer -> TVar (Set.Set Integer) -> IO ()
recoveryCases peer options clock waits = do
  reach peer "a refused connect's recovery"
  atomically (writeTVar waits Set.empty)
  let seconds = (Timing.degradedThresholdMs * 2 + 999) `div` 1000
  postControl peer "/test/config" (object ["gateSubscribe" .= True, "subscribeFailures" .= ([503] :: [Int]), "subscribeRetryAfter" .= show seconds])
  bracket (Client.fromHttp options Nothing) Client.dispose $ \client -> do
    began <- readTVarIO clock
    Transport.errors (Client.transport client) $ \errors -> do
      postControl peer "/test/config" (object ["gateSubscribe" .= False])
      failures <- Stream.toList_ (Stream.take 1 errors)
      require "refused connect was not reported" (map httpStatus failures == [Just 503])
      atomically (State.current (Client.state client) >>= check . (== Transport.Reconnecting))
      let degradedAt = began + Timing.degradedThresholdMs * 1000000
          reconnectAt = began + seconds * 1000000000
      waitForDeadline waits degradedAt
      atomically (writeTVar clock degradedAt)
      atomically (State.current (Client.state client) >>= check . (== Transport.Degraded))
      waitForDeadline waits reconnectAt
      atomically (writeTVar clock reconnectAt)
      atomically (State.current (Client.state client) >>= check . (== Transport.Open))

waitForDeadline :: TVar (Set.Set Integer) -> Integer -> IO ()
waitForDeadline waits due = atomically (readTVar waits >>= check . Set.member due)

postControl :: Peer -> String -> Value -> IO ()
postControl peer suffix value = do
  base <- parseRequest (Text.unpack (peerOrigin peer) ++ suffix)
  void (httpLbs base { method = "POST", requestHeaders = [("Content-Type", "application/json")], requestBody = RequestBodyLBS (encode value) } (peerControl peer))

field :: Key.Key -> Value -> Maybe Value
field key (Object fields)=KM.lookup key fields
field _ _=Nothing

values :: Key.Key -> Value -> [Value]
values key (Object fields) = case KM.lookup key fields of Just (Array items) -> toList items; _ -> error "peer state has no list"
values _ _ = error "peer state is not an object"
count :: Key.Key -> Value -> Int
count key (Object fields) = case KM.lookup key fields of Just (Number value) -> round value; _ -> error "peer state has no counter"
count _ _ = error "peer state is not an object"

readState :: Peer -> IO Value
readState peer = do
  asked <- parseRequest (Text.unpack (peerOrigin peer) ++ "/test/state")
  response <- httpLbs asked (peerControl peer)
  either (ioError . userError) pure (eitherDecode (responseBody response))

awaitState :: Peer -> (Value -> Bool) -> IO Value
awaitState peer accepts = do
  value <- readState peer
  if accepts value then pure value else threadDelay 1000 >> awaitState peer accepts

-- The test peer: its origin, one manager for the test's own control calls, and the step the exercise has reached.
data Peer = Peer { peerOrigin :: Text, peerControl :: Manager, peerReached :: IORef String }

reach :: Peer -> String -> IO ()
reach peer = writeIORef (peerReached peer)

withPeer :: FilePath -> Map.Map Text Value -> IORef String -> (Peer -> IO result) -> IO result
withPeer root fixtures reached action = bracket
  (do
    temporary <- getTemporaryDirectory
    (file, handle) <- openBinaryTempFile temporary "semiont-http-fixtures.json"
    Lazy.hPut handle (encode fixtures)
    hClose handle
    pure file)
  removeFile $ \file -> bracket
    (do
      process <- createProcess (proc python [root </> "packages/haskell/sdk/test/http-peer.py", root, file]) { std_in = CreatePipe, std_out = CreatePipe }
      case process of
        (Just input, Just output, _, peer) -> pure (input, output, peer)
        _ -> ioError (userError "HTTP peer pipes were not created"))
    (\(input, output, peer) -> hPutStrLn input "stop" >> hFlush input >> void (waitForProcess peer) >> hClose input >> hClose output)
    (\(_, output, _) -> do
      port <- hGetLine output
      control <- newManager (managerSetProxy noProxy defaultManagerSettings)
      action (Peer ("http://127.0.0.1:" <> Text.pack port) control reached))
