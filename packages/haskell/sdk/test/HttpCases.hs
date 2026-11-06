{-# LANGUAGE OverloadedStrings #-}
module HttpCases (httpCases) where

import Control.Concurrent (threadDelay)
import Control.Concurrent.Async (async, cancel, wait)
import Control.Concurrent.STM
import Control.Exception (bracket, finally, try)
import Control.Monad (unless, void)
import Data.Aeson (Value(..), eitherDecode, encode, fromJSON, toJSON, Result(..), object, (.=))
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
import qualified Semiont.Auth as Auth
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
import System.Directory (removeFile)
import System.FilePath ((</>))
import System.IO (hClose, hGetLine, hPutStrLn, hFlush, openBinaryTempFile)
import System.Process
import System.Timeout (timeout)
import qualified Streaming.Prelude as Stream

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

httpCases :: FilePath -> Map.Map Text Value -> IO ()
httpCases root fixtures = do
  result <- timeout 20000000 (withPeer root fixtures exercise)
  require "real HTTP integration liveness deadline expired" (result == Just ())
  putStrLn "PASS real HTTP/SSE, typed client, content scopes, upload renewal and ownership"
  where
    exercise origin = do
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
      client <- Client.newClient (Http.transport http) (Http.content http) (Just (Http.gateway http)) busOptions Settings.protocolSettings
      let contents = Client.content client
          fromFixture name = case Map.lookup name fixtures of
            Nothing -> error ("test fixture missing: " ++ Text.unpack name)
            Just value -> case fromJSON value of Error reason -> error reason; Success answer -> answer
      resource <- either (ioError . userError) pure (mkResourceId "download")
      (do
        atomically (State.current (Client.state client) >>= check . (== Transport.Open))
        Frame.addEntityType (Client.frame client) "Entity"
        Frame.addEntityTypes (Client.frame client) ["One", "Two"]
        Frame.addTagSchema (Client.frame client) (fromFixture "TagSchema")
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
            Frame.addEntityType (Client.frame client) "Propagated"
        readIORef injectedContexts >>= require "transport injection lost the caller's context" . (== [Just "caller"])
        readIORef extractions >>= require "transport ignored the host's extractor" . (> 0)
        restoredContext <- getContext
        require "transport propagation changed the caller's context"
          (Context.lookup propagationKey restoredContext == Context.lookup propagationKey callerContext)
        propagated <- readState origin
        let traces = [trace | Object record <- values "requests" propagated,
              Just (Object body) <- [KM.lookup "body" record], Just (Object payload) <- [KM.lookup "payload" body],
              Just trace <- [KM.lookup (Key.fromText traceField) payload]]
            headers = [fields | Object record <- values "requests" propagated, Just (Object fields) <- [KM.lookup "headers" record]]
        require "transport changed the domain payload to propagate a trace" (null traces)
        require "transport did not use the host's HTTP propagation headers"
          (any (\fields -> all (\(key,value) -> KM.lookup (Key.fromText key) fields == Just (String value)) carrierPairs
            && KM.lookup "other-host-field" fields == Just (String "not a trace field")) headers)
        httpFaults origin http client resource clock waits
        case Client.auth client of
          Nothing -> ioError (userError "HTTP client has no auth namespace")
          Just auth -> do
            Auth.me auth >>= require "typed current user changed" . (== fromFixture "UserResponse")
            Auth.mediaToken auth resource >>= require "typed media token changed" . (== fromFixture "MediaTokenResponse")
            Auth.protectedResourceMetadata auth >>= require "protected metadata changed" . (== fromFixture "ProtectedResourceMetadata")
        case Client.system client of
          Nothing -> ioError (userError "HTTP client has no system namespace")
          Just statusNamespace -> do
            System.healthCheck statusNamespace >>= require "typed health changed" . (== fromFixture "HealthResponse")
            System.status statusNamespace >>= require "typed status changed" . (== fromFixture "StatusResponse")
        Content.getResourceGraph contents resource >>= require "typed resource graph changed" . (== fromFixture "GetResourceResponse")
        Content.getAnnotations contents resource >>= require "typed annotation response changed" . (== fromFixture "GetAnnotationsResponse")
        Content.getAnchoredText contents resource >>= require "anchored text sum changed" . (== fromFixture "AnchoredTextAnswer")
        contextKey <- Context.newKey "HTTP consumer context"
        beforeContext <- getContext
        bracket (attachContext (Context.insert contextKey ("consumer" :: Text) beforeContext)) detachContext $ \_ ->
          Content.getBinaryStream contents resource $ \_ chunks -> do
            actualContext <- getContext
            require "HTTP callback lost the caller's trace context" (Context.lookup contextKey actualContext == Just "consumer")
            Stream.effects chunks
        afterContext <- getContext
        require "HTTP callback leaked its context to the caller" (Context.lookup contextKey afterContext == Context.lookup contextKey beforeContext)
        binary <- Content.getBinary contents resource
        require "download did not preserve bytes/media type" (Content.contentBytes binary == encodeUtf8 "hello λ" && Content.contentType binary == "text/plain; charset=utf-8")
        escaped <- Content.getBinaryStream contents resource (\_ chunks -> pure chunks)
        outside <- try (Stream.effects escaped) :: IO (Either TransportError ())
        require "escaped content reader was usable" (either (const True) (const False) outside)
        atomically (writeTVar supplied (Just "renew-upload"))
        opens <- newIORef (0 :: Int)
        progress <- newIORef []
        let metadata = (fromFixture "ResourceUploadMetadata")
              { resourceUploadMetadataName = "upload λ\".txt", resourceUploadMetadataFormat = "text/plain", resourceUploadMetadataStorageUri = "local" }
            bytes = encodeUtf8 "complete upload λ"
            source = (Content.bytesBody bytes) { Content.openBody = \consume -> modifyIORef' opens (+ 1) >> Content.openBody (Content.bytesBody bytes) consume }
        uploaded <- Content.putBinary contents metadata source (\value -> modifyIORef' progress (++ [value]))
        require "upload response changed" (uploaded == createResourceResponseResourceId (fromFixture "CreateResourceResponse"))
        readIORef opens >>= require "renewal did not reopen the complete upload" . (== 2)
        readIORef renewals >>= require "renewal did not receive the refused token exactly once" . (== ["renew-upload"])
        notices <- readIORef progress
        require "upload progress decreased across replay" (and (zipWith (<=) (map Content.bytesUploaded notices) (drop 1 (map Content.bytesUploaded notices))))
        require "upload progress lost its total" (last notices == Content.UploadProgress (fromIntegral (Bytes.length bytes)) (fromIntegral (Bytes.length bytes)))
        state <- readState origin
        let uploads = values "uploads" state
            field key (Object fields) = KM.lookup key fields
            field _ _ = Nothing
        case uploads of
          [first, second] -> require "upload attempts changed the idempotency key" (field "key" first == field "key" second)
          _ -> ioError (userError "upload did not have exactly two attempts")
        require "replayed upload lost bytes" (all (\value -> case field "parts" value of Just (Object fields) -> KM.lookup "file" fields == Just (String "complete upload λ"); _ -> False) uploads)
        let invalidSource = (Content.bytesBody bytes) { Content.bodyLength = Just (-1) }
        invalidUpload <- try (Content.putBinary contents metadata invalidSource (const (pure ()))) :: IO (Either TransportError ResourceId)
        require "negative upload size was accepted" (either ((== Code.TransportBadRequest) . transportErrorCode) (const False) invalidUpload)
        malformed <- either (ioError . userError) pure (mkResourceId "malformed")
        malformedAnswer <- try (Content.getResourceGraph contents malformed) :: IO (Either TransportError GetResourceResponse)
        require "malformed HTTP JSON was accepted" (either ((== Code.TransportError) . transportErrorCode) (const False) malformedAnswer)
        refused <- either (ioError . userError) pure (mkResourceId "refused")
        Transport.errors (Client.transport client) $ \failures -> do
          answer <- try (Content.getBinary contents refused) :: IO (Either TransportError Content.BinaryContent)
          case answer of
            Right _ -> ioError (userError "HTTP refusal became content")
            Left problem -> do
              require "HTTP refusal lost the gateway's words/status" (httpStatus problem == Just 403 && transportErrorCode problem == Code.TransportForbidden && Text.isInfixOf "gateway words preserved" (transportErrorMessage problem))
              noticed <- Stream.toList_ (Stream.take 1 failures)
              require "HTTP refusal was not observed before throw" (noticed == [problem])
        readIORef hookRequests >>= require "caller HTTP hooks were not used" . (> 10)
        Content.dispose contents
        closedContent <- try (Content.getBinary contents resource) :: IO (Either BusRequestError Content.BinaryContent)
        require "disposed content still performed I/O" (either ((== Code.BusRequestClosed) . busRequestErrorCode) (const False) closedContent)
        Gateway.healthCheck (Http.gateway http) >>= require "disposing content closed the caller's HTTP pool" . (== fromFixture "HealthResponse")
        ) `finally` Client.dispose client
      Client.dispose client
      _ <- awaitState origin (\value -> length (values "subscriptions" value) == count "disconnected" value)
      credentialCases origin (options pool) supplied renewals clock waits
      recoveryCases origin (options pool) clock waits
      pure ()

httpFaults :: Text -> Http.HttpTransport -> Client.Client -> ResourceId -> TVar Integer -> TVar (Set.Set Integer) -> IO ()
httpFaults origin http client resource clock waits =
  bracket (Transport.subscribeToResource (Http.transport http) resource) id $ \_ -> do
    began <- readTVarIO clock
    waitForDeadline waits (began + Timing.reconnectDebounceMs * 1000000)
    atomically (writeTVar clock (began + Timing.reconnectDebounceMs * 1000000))
    _ <- awaitState origin ((>= 2) . length . values "subscriptions")
    connection <- atomically (State.current (Client.state client))
    require "subscription handoff changed an open connection's state" (connection == Transport.Open)
    let channel = channelName FrameEntityTypeAddOk
        publish correlation = postControl origin "/test/publish" (object
          [ "id" .= ("e-" <> channel <> ":" <> correlation)
          , "frame" .= BusFrame channel (Just correlation) (BusFramePayload mempty) Nothing
          ])
    Transport.frames (Http.transport http) channel $ \frames -> do
      publish "first"
      publish "first"
      publish "second"
      seen <- Stream.toList_ (Stream.take 2 frames)
      require "overlapping streams duplicated a reply" (map (busFrameCorrelationId . Transport.wireFrame) seen == [Just "first", Just "second"])
    state <- readState origin
    require "old stream was aborted before its drain window" (count "disconnected" state == 0)
    let retiredAt = began + (Timing.reconnectDebounceMs + Timing.lingerMs) * 1000000
    waitForDeadline waits retiredAt
    atomically (writeTVar clock retiredAt)
    _ <- awaitState origin ((>= 1) . count "disconnected")

    postControl origin "/test/config" (object ["emitStatuses" .= ([429, 503] :: [Int])])
    atomically (writeTVar waits Set.empty)
    retryAt <- readTVarIO clock
    retrying <- async (Frame.addEntityType (Client.frame client) "Retried")
    let firstWait = retryAt + Timing.retryInitialDelayMs Timing.emitRetry * 1000000 `div` 2
        secondWait = firstWait + Timing.retryInitialDelayMs Timing.emitRetry * 1000000
    waitForDeadline waits firstWait
    atomically (writeTVar clock firstWait)
    waitForDeadline waits secondWait
    atomically (writeTVar clock secondWait)
    wait retrying
    attempted <- readState origin
    let asks = filter (\value -> field "path" value == Just (String (Routes.routePath Routes.EmitOnBus))) (values "requests" attempted)
        lastThree = drop (length asks - 3) asks
    require "emit retries changed their idempotency key" (length lastThree == 3 && Set.size (Set.fromList (map (field "key") lastThree)) == 1)

    atomically (writeTVar waits Set.empty)
    headerResource <- either (ioError . userError) pure (mkResourceId "headers")
    headerStart <- readTVarIO clock
    stalled <- async (try (Content.getBinary (Http.content http) headerResource) :: IO (Either TransportError Content.BinaryContent))
    let headerDeadline = headerStart + Timing.httpRequestTimeoutMs * 1000000
    waitForDeadline waits headerDeadline
    atomically (writeTVar clock headerDeadline)
    result <- wait stalled
    require "unanswered request was not classified unavailable" (either ((== Code.TransportUnavailable) . transportErrorCode) (const False) result)
    afterHeaders <- awaitState origin ((== 1) . count "headersClosed")
    let headerPath = Text.replace "{id}" (resourceIdValue headerResource) (Routes.routePath Routes.GetResourceRepresentation)
    require "a request unanswered at its deadline was retried" (length (filter (\value -> field "path" value == Just (String headerPath)) (values "requests" afterHeaders)) == 1)

    bodyResource <- either (ioError . userError) pure (mkResourceId "body")
    entered <- newEmptyTMVarIO
    reader <- async (Content.getBinaryStream (Http.content http) bodyResource $ \_ chunks -> do
      first <- Stream.next chunks
      case first of
        Left () -> ioError (userError "body stream ended before its first byte")
        Right (_, rest) -> atomically (putTMVar entered ()) >> Stream.effects rest)
    atomically (takeTMVar entered)
    atomically (modifyTVar' clock (+ (Timing.httpRequestTimeoutMs * 2000000)))
    stillOpen <- atomically (State.current (Client.state client))
    require "idle SSE stream inherited an HTTP response timeout" (stillOpen == Transport.Open)
    cancel reader
    _ <- awaitState origin ((== 1) . count "bodyClosed")
    pure ()
  where
    field key (Object fields) = KM.lookup key fields
    field _ _ = Nothing

credentialCases :: Text -> Http.HttpOptions -> TVar (Maybe Text) -> IORef [Text] -> TVar Integer -> TVar (Set.Set Integer) -> IO ()
credentialCases origin options supplied renewals clock waits = do
  atomically (writeTVar supplied (Just "refused") >> writeTVar waits Set.empty)
  writeIORef renewals []
  postControl origin "/test/config" (object ["gateSubscribe" .= True, "subscribeFailures" .= ([401, 401] :: [Int])])
  bracket (Client.fromHttp options) Client.dispose $ \client -> do
    began <- readTVarIO clock
    Transport.errors (Client.transport client) $ \errors -> do
      postControl origin "/test/config" (object ["gateSubscribe" .= False])
      failures <- Stream.toList_ (Stream.take 2 errors)
      require "stream credential refusal lost status or peer words" (all (\problem -> httpStatus problem == Just 401 && Text.isInfixOf "stream credential refused" (transportErrorMessage problem)) failures)
      atomically (State.current (Client.state client) >>= check . (== Transport.Unauthenticated))
      first <- readState origin
      let attempts state = length (filter (\value -> case value of
            Object fields -> KM.lookup "path" fields == Just (String (Routes.routePath Routes.SubscribeToBus))
            _ -> False) (values "requests" state))
          firstPoll = began + Timing.reconnectMs * 1000000
          secondPoll = began + Timing.reconnectMs * 2000000
      waitForDeadline waits firstPoll
      atomically (writeTVar clock firstPoll)
      waitForDeadline waits secondPoll
      second <- readState origin
      require "a twice-refused stream credential was sent again" (attempts first == attempts second)
      readIORef renewals >>= require "stream renewed more than once in one outage" . (== ["refused"])
      atomically (writeTVar supplied (Just "fresh") >> writeTVar clock secondPoll)
      atomically (State.current (Client.state client) >>= check . (== Transport.Open))
      Frame.addEntityType (Client.frame client) "Recovered"
      require "client base URL changed" (Client.baseUrl client == origin)

recoveryCases :: Text -> Http.HttpOptions -> TVar Integer -> TVar (Set.Set Integer) -> IO ()
recoveryCases origin options clock waits = do
  atomically (writeTVar waits Set.empty)
  let seconds = (Timing.degradedThresholdMs * 2 + 999) `div` 1000
  postControl origin "/test/config" (object ["gateSubscribe" .= True, "subscribeFailures" .= ([503] :: [Int]), "subscribeRetryAfter" .= show seconds])
  bracket (Client.fromHttp options) Client.dispose $ \client -> do
    began <- readTVarIO clock
    Transport.errors (Client.transport client) $ \errors -> do
      postControl origin "/test/config" (object ["gateSubscribe" .= False])
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

postControl :: Text -> String -> Value -> IO ()
postControl origin suffix value = do
  manager <- newManager (managerSetProxy noProxy defaultManagerSettings)
  base <- parseRequest (Text.unpack origin ++ suffix)
  void (httpLbs base { method = "POST", requestHeaders = [("Content-Type", "application/json")], requestBody = RequestBodyLBS (encode value) } manager)

values :: Key.Key -> Value -> [Value]
values key (Object fields) = case KM.lookup key fields of Just (Array items) -> toList items; _ -> error "peer state has no list"
values _ _ = error "peer state is not an object"
count :: Key.Key -> Value -> Int
count key (Object fields) = case KM.lookup key fields of Just (Number value) -> round value; _ -> error "peer state has no counter"
count _ _ = error "peer state is not an object"

readState :: Text -> IO Value
readState origin = do
  manager <- newManager (managerSetProxy noProxy defaultManagerSettings)
  asked <- parseRequest (Text.unpack origin ++ "/test/state")
  response <- httpLbs asked manager
  either (ioError . userError) pure (eitherDecode (responseBody response))

awaitState :: Text -> (Value -> Bool) -> IO Value
awaitState origin accepts = do
  value <- readState origin
  if accepts value then pure value else threadDelay 1000 >> awaitState origin accepts

withPeer :: FilePath -> Map.Map Text Value -> (Text -> IO result) -> IO result
withPeer root fixtures action = bracket
  (do
    (file, handle) <- openBinaryTempFile "/tmp" "semiont-http-fixtures.json"
    Lazy.hPut handle (encode fixtures)
    hClose handle
    pure file)
  removeFile $ \file -> bracket
    (do
      process <- createProcess (proc "python3" [root </> "packages/haskell/sdk/test/http-peer.py", root, file]) { std_in = CreatePipe, std_out = CreatePipe }
      case process of
        (Just input, Just output, _, peer) -> pure (input, output, peer)
        _ -> ioError (userError "HTTP peer pipes were not created"))
    (\(input, output, peer) -> hPutStrLn input "stop" >> hFlush input >> void (waitForProcess peer) >> hClose input >> hClose output)
    (\(_, output, _) -> hGetLine output >>= action . ("http://127.0.0.1:" <>) . Text.pack)
