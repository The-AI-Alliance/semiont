{-# LANGUAGE GADTs, OverloadedStrings, ScopedTypeVariables, RankNTypes #-}
module Main (main) where

import Control.Concurrent (yield)
import DriverProtocol
import Control.Concurrent.Async
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception
import qualified Data.HashMap.Strict as HashMap
import Data.List.NonEmpty (nonEmpty)
import Data.Time (getCurrentTime, formatTime, defaultTimeLocale)
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (getContext, attachContext, detachContext)
import qualified OpenTelemetry.Propagator as Propagator
import OpenTelemetry.Attributes (toAttribute)
import qualified Semiont.Worker as Worker
import Semiont.Worker.Types
import Semiont.Claims (jobClaimChannels, jobCommitChannels)
import Control.Monad (forM_, unless, void, when)
import Data.Aeson hiding (decode)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Char8 as Char8
import qualified Data.ByteString.Base64 as Base64
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import qualified Data.UUID.V4 as UUID
import qualified Data.UUID.Types as UUID
import Network.HTTP.Client (defaultManagerSettings, noProxy)
import qualified OpenTelemetry.Trace.Core as TraceCore
import qualified OpenTelemetry.Trace as Trace
import qualified OpenTelemetry.Metric as Metric
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Content as Content
import qualified Semiont.ErrorCodes as Code
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Http as Http
import qualified Semiont.Retry as Retry
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Transport.Facts (connectionStateName)
import Semiont.Types
import System.IO
import System.Environment (lookupEnv, getArgs)
import System.Random (randomRIO)
import qualified Streaming.Prelude as Stream

data ActiveJob = ActiveJob Worker.SomeHeldJob Context.Context

data Driver = Driver
  { connection :: TVar (Maybe Http.HttpTransport)
  , credential :: TVar (Maybe Text)
  , holds :: TVar (Map.Map ResourceId [IO ()])
  , reporters :: TVar [Async ()]
  , jobs :: TVar (Map.Map Integer (Async ()))
  , output :: MVar ()
  , fatal :: TMVar SomeException
  , pool :: Http.HttpClient
  , time :: Retry.RetryOptions
  , reported :: TVar (Maybe Transport.ConnectionState)
  , workerMode :: Bool
  , claims :: TVar (Maybe Worker.Claims)
  , currentJob :: TVar (Maybe ActiveJob)
  , workerTimings :: TVar Timing.Settings
  }

say :: Driver -> Value -> IO ()
say driver value = withMVar (output driver) $ \() -> Lazy.hPut stdout (encode value <> "\n") >> hFlush stdout

opened :: Driver -> IO Http.HttpTransport
opened driver = readTVarIO (connection driver) >>= maybe (throwIO (Misuse "No transport is open")) pure

reportState :: Driver -> Transport.ConnectionState -> IO ()
reportState driver state = withMVar (output driver) $ \() -> do
  changed <- atomically $ do
    before <- readTVar (reported driver)
    writeTVar (reported driver) (Just state)
    pure (before /= Just state)
  when changed (Lazy.hPut stdout (encode (object ["state" .= connectionStateName state]) <> "\n") >> hFlush stdout)

-- Registration completes inside each public scoped subscription, before its
-- operation is acknowledged and the harness can publish the first event.
reporter :: Driver -> (IO () -> IO ()) -> IO ()
reporter driver action = mask $ \restore -> do
  ready <- newEmptyMVar
  worker <- async $ restore (action (putMVar ready ())) `catch` \(problem :: SomeException) -> do
    case fromException problem :: Maybe SomeAsyncException of
      Just _ -> pure ()
      Nothing -> atomically (void (tryPutTMVar (fatal driver) problem))
    throwIO problem
  atomically (modifyTVar' (reporters driver) (worker :))
  result <- restore (race (takeMVar ready) (wait worker)) `onException` cancel worker
  case result of Left () -> pure (); Right () -> throwIO (Misuse "Reporter ended before registering")

open :: Driver -> Object -> IO Value
open driver args = do
  previous <- readTVarIO (connection driver)
  when (maybe False (const True) previous) (throwIO (Misuse "A transport is already open"))
  address <- need args "baseUrl"
  token <- need args "token"
  channels <- if workerMode driver then do
    commits <- maybe False id <$> optional args "commits"
    pure (jobClaimChannels ++ if commits then jobCommitChannels else [])
    else need args "channels"
  overrides <- maybe (pure (Object KM.empty)) pure =<< optional args "timing"
  timings <- either (throwIO . Misuse) pure (Timing.withOverrides overrides)
  atomically (writeTVar (workerTimings driver) timings)
  remaining <- newTVarIO =<< (maybe (pure []) pure =<< optional args "renewals")
  atomically (writeTVar (credential driver) (Just token))
  let renew _ = atomically $ do
        tokens <- readTVar remaining
        case tokens of
          [] -> pure Nothing
          next : rest -> writeTVar remaining rest >> writeTVar (credential driver) (Just next) >> pure (Just next)
      options = Http.HttpOptions address (pool driver) (readTVarIO (credential driver)) renew (time driver) timings UUID.nextRandom
        (Set.fromList channels) (pure Map.empty) (\_ _ -> pure ())
  http <- Http.newHttpTransport options
  atomically (writeTVar (connection driver) (Just http))
  let transport = Http.transport http
  reporter driver $ \ready -> State.watch (Transport.state transport) $ \states -> ready >> Stream.mapM_ (reportState driver) states
  reporter driver $ \ready -> Transport.errors transport $ \errors -> ready >> Stream.mapM_ (\problem ->
    case failure (toException problem) of Just value -> say driver (object ["error" .= value]); Nothing -> throwIO problem) errors
  pure Null

request :: Driver -> Object -> IO Value
request driver args = do
  http <- opened driver
  name <- need args "operation"
  payload <- need args "payload"
  timeoutMs <- need args "timeoutMs"
  let bus = Bus.newBus (Bus.BusOptions now waitUntil (UUID.toText <$> UUID.nextRandom)) (Http.transport http)
      find [] = throwIO (Misuse ("Unknown bus operation " ++ Text.unpack name))
      find (SomeOperation operation : rest) =
        let (asked, answered, _) = operationChannels operation in
        if channelName asked /= name then find rest else do
          input <- either (throwIO . Misuse) pure (decodePayload asked payload)
          response <- encodePayload answered <$> Bus.request bus operation input timeoutMs
          case response of
            Object fields -> pure (object (maybe [] (\value -> ["response" .= value]) (KM.lookup "response" fields)))
            _ -> throwIO (Misuse "Operation answered without an object")
  find allOperations

upload :: Driver -> Integer -> Bool -> Object -> IO Value
upload driver identifier progress args = do
  http <- opened driver
  encoded <- need args "bytes"
  bytes <- either (throwIO . Misuse) pure (Base64.decode (encodeUtf8 encoded))
  let fields = foldr KM.delete args ["id", "op", "bytes"]
      formValue key value = if key `elem` ["entityTypes", "isDraft"] then String (decodeUtf8 (Lazy.toStrict (encode value))) else value
  metadata <- decode (Object (KM.mapWithKey formValue fields))
  let notice value = when progress $ say driver $ object ["progress" .= object
        ["upload" .= identifier, "bytesUploaded" .= Content.bytesUploaded value, "totalBytes" .= Content.totalBytes value]]
  created <- Content.putBinary (Http.content http) Nothing metadata (Content.bytesBody bytes) notice
  pure (object ["resourceId" .= created])

perform :: Driver -> Integer -> Text -> Object -> Maybe (IO Value)
perform driver identifier operation args = case operation of
  "open" -> Just $ open driver args
  "close" -> Just $ opened driver >>= Http.dispose >> pure Null
  "set-token" -> Just $ do
    _ <- opened driver
    token <- need args "token"
    atomically (writeTVar (credential driver) (Just token))
    pure Null
  "listen" -> Just $ do
    transport <- Http.transport <$> opened driver
    channel <- need args "channel"
    reporter driver $ \ready -> Transport.frames transport channel $ \frames -> ready >> Stream.mapM_ (\frame ->
      say driver (object ["frame" .= Transport.wireFrame frame])) frames
    pure Null
  "subscribe-resource" -> Just $ do
    transport <- Http.transport <$> opened driver
    resource <- need args "resource"
    release <- Transport.subscribeToResource transport resource
    atomically (modifyTVar' (holds driver) (Map.insertWith (++) resource [release]))
    pure Null
  "release-resource" -> Just $ do
    resource <- need args "resource"
    release <- atomically $ do
      active <- readTVar (holds driver)
      case Map.lookup resource active of
        Just (release : rest) -> writeTVar (holds driver) (if null rest then Map.delete resource active else Map.insert resource rest active) >> pure release
        _ -> throwSTM (Misuse "No hold on that resource")
    release
    pure Null
  "emit" -> Just $ do
    transport <- Http.transport <$> opened driver
    channel <- need args "channel"
    payload <- BusFramePayload <$> need args "payload"
    scope <- optional args "scope"
    correlation <- optional args "correlationId"
    count <- Transport.emit transport (BusFrame channel correlation payload scope)
    pure (object (maybe [] (\value -> ["subscribers" .= value]) count))
  "request" -> Just $ request driver args
  "put" -> Just $ upload driver identifier False args
  "upload" -> Just $ upload driver identifier True args
  "get" -> Just $ do
    contents <- Http.content <$> opened driver
    resource <- need args "resource"
    binary <- Content.getBinary contents Nothing resource
    pure (binaryValue (Content.contentType binary) (Content.contentBytes binary))
  "get-stream" -> Just $ do
    contents <- Http.content <$> opened driver
    resource <- need args "resource"
    Content.getBinaryStream contents Nothing resource $ \media chunks -> binaryValue media . Bytes.concat <$> Stream.toList_ chunks
  "graph" -> Just $ contentRead Content.getResourceGraph
  "annotations" -> Just $ contentRead Content.getAnnotations
  "anchored-text" -> Just $ contentRead Content.getAnchoredText
  "health" -> Just $ gatewayRead Gateway.healthCheck
  "status" -> Just $ gatewayRead Gateway.getStatus
  "current-user" -> Just $ gatewayRead (\operations -> Gateway.getCurrentUser operations Nothing)
  "protected-resource-metadata" -> Just $ gatewayRead Gateway.getProtectedResourceMetadata
  "media-token" -> Just $ do
    gateway <- Http.gateway <$> opened driver
    resource <- need args "resource"
    toJSON <$> Gateway.getMediaToken gateway resource
  "sync" -> Just $ do
    yield
    current <- readTVarIO (connection driver)
    forM_ current (\http -> atomically (State.current (Transport.state (Http.transport http))) >>= reportState driver)
    pure Null
  _ -> Nothing
  where
    binaryValue media bytes = object ["contentType" .= media, "bytes" .= decodeUtf8 (Base64.encode bytes)]
    contentRead :: ToJSON answer => (Content.ContentTransport -> Maybe Text -> ResourceId -> IO answer) -> IO Value
    contentRead readContent = do
      contents <- Http.content <$> opened driver
      resource <- need args "resource"
      toJSON <$> readContent contents Nothing resource
    gatewayRead :: ToJSON answer => (Gateway.GatewayOperations -> IO answer) -> IO Value
    gatewayRead readGateway = opened driver >>= fmap toJSON . readGateway . Http.gateway

withJob :: Driver -> (forall result. Worker.HeldJob result -> IO Value) -> IO Value
withJob driver action = do
  value <- readTVarIO (currentJob driver) >>= maybe (throwIO (Misuse "No job is held")) pure
  case value of
    ActiveJob some context -> bracket (attachContext context) detachContext $ \_ ->
      case some of Worker.HeldMark job -> action job; Worker.HeldYield job -> action job

reportJobs :: Driver -> Worker.Claims -> IO ()
reportJobs driver worker = do
  item <- Worker.next worker
  forM_ item $ \some -> do
    let runJob :: Worker.HeldJob result -> IO ()
        runJob job = do
          propagator <- Propagator.getGlobalTextMapPropagator
          let carrier = case toJSON (Worker.trace job) of
                Object fields -> Propagator.textMapFromList [(Key.toText key,value) | (key,String value) <- KM.toList fields]
                _ -> Propagator.emptyTextMap
          parent <- Propagator.extract propagator carrier Context.empty
          bracket (attachContext parent) detachContext $ \_ -> do
            provider <- Trace.getGlobalTracerProvider
            tracer <- Trace.getTracer provider (TraceCore.instrumentationLibrary "semiont-conformance" "1") Trace.tracerOptions
            Trace.inSpan'' tracer ("job:" <> (case Worker.jobType job of JobTypeMark -> "mark"; JobTypeYield -> "yield"))
              Trace.defaultSpanArguments { Trace.attributes = HashMap.singleton "job.id" (toAttribute (jobIdValue (Worker.jobId job))) } $ \_ -> do
                context <- getContext
                atomically (writeTVar (currentJob driver) (Just (ActiveJob some context)))
                say driver (object ["claimed" .= object
                  ["jobId" .= Worker.jobId job, "jobType" .= Worker.jobType job, "resourceId" .= Worker.resourceId job,
                   "params" .= Worker.params job, "completedUnits" .= Worker.completedUnits job, "unitCursors" .= Worker.unitCursors job,
                   "retryCount" .= Worker.retryCount job, "maxRetries" .= Worker.maxRetries job]])
                let waitSettled = atomically (Worker.settled job >>= check)
                    cancellation = do
                      signalled <- atomically ((Worker.cancelled job >>= check >> pure True) `orElse` (Worker.settled job >>= check >> pure False))
                      when signalled (say driver (object ["signalled" .= Worker.jobId job]))
                withAsync cancellation (const waitSettled)
                atomically (writeTVar (currentJob driver) Nothing)
    case some of Worker.HeldMark job -> runJob job; Worker.HeldYield job -> runJob job
    reportJobs driver worker

workerPerform :: Driver -> Integer -> Text -> Object -> Maybe (IO Value)
workerPerform driver identifier operation args = case operation of
  "close" -> Just $ do
    readTVarIO (claims driver) >>= mapM_ Worker.stop
    opened driver >>= Http.dispose
    pure Null
  "claim" -> Just $ do
    previous <- readTVarIO (claims driver)
    when (maybe False (const True) previous) (throwIO (Misuse "Worker is already claiming"))
    filters <- need args "accepts" >>= maybe (throwIO (Misuse "No filters")) pure . nonEmpty
    http <- opened driver
    timing <- readTVarIO (workerTimings driver)
    let clock = Bus.BusOptions now waitUntil (UUID.toText <$> UUID.nextRandom)
        timestamp = Text.pack . formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%S%QZ" <$> getCurrentTime
    worker <- Worker.newClaims (Http.transport http) (Worker.WorkerOptions filters clock timing timestamp)
    atomically (writeTVar (claims driver) (Just worker))
    reporter driver $ \ready -> Worker.refused worker $ \events -> ready >> Stream.mapM_ (\refusal -> say driver (object ["refused" .= object
      (["detail" .= claimRefusalMessage refusal] ++ maybe [] (\code -> ["code" .= Code.busRequestCode code]) (claimRefusalCode refusal))])) events
    reporter driver $ \ready -> Worker.stalled worker $ \events -> ready >> Stream.mapM_ (\event -> say driver (object ["stalled" .= heldJobStallJobId event])) events
    reporter driver $ \ready -> ready >> reportJobs driver worker
    pure Null
  "start" -> Just $ withJob driver (\job -> Worker.start job >> pure Null)
  "progress" -> Just $ withJob driver $ \job -> do
    value <- decode (Object (foldr KM.delete args ["id","op"]))
    Worker.progress job value
    pure Null
  "checkpoint" -> Just $ withJob driver $ \job -> do
    value <- decode (Object (foldr KM.delete args ["id","op"]))
    Worker.checkpoint job value
    pure Null
  "commit" -> Just $ withJob driver $ \job -> do
    resource <- need args "resourceId"
    annotations <- need args "annotations"
    Worker.commit job resource annotations
    pure Null
  "complete" -> Just $ do
    value <- readTVarIO (currentJob driver) >>= maybe (throwIO (Misuse "No job is held")) pure
    case value of
      ActiveJob some context -> bracket (attachContext context) detachContext $ \_ -> case some of
        Worker.HeldMark job -> need args "result" >>= Worker.complete job
        Worker.HeldYield job -> need args "result" >>= Worker.complete job
    pure Null
  "fail" -> Just $ withJob driver $ \job -> do
    message <- need args "error"
    failureValue <- decode (Object (foldr KM.delete args ["id","op","error"]))
    Worker.fail job message (Just failureValue)
    pure Null
  "cancel" -> Just $ withJob driver $ \job -> do
    reached <- decode (Object (foldr KM.delete args ["id","op"]))
    Worker.cancel job (Just reached)
    pure Null
  "vitals" -> Just $ do
    worker <- readTVarIO (claims driver) >>= maybe (throwIO (Misuse "No claims")) pure
    toJSON <$> Worker.vitals worker
  _ -> perform driver identifier operation args

answer :: Driver -> Integer -> IO Value -> IO ()
answer driver identifier action = do
  outcome <- try action
  case answerValue identifier outcome of
    Right value -> say driver value
    Left problem -> atomically (void (tryPutTMVar (fatal driver) problem))

dispatch :: Driver -> Object -> IO ()
dispatch driver args = do
  identifier <- need args "id"
  operation <- need args "op"
  if operation == "abandon" then answer driver identifier $ do
    target <- need args "request"
    active <- readTVarIO (jobs driver)
    maybe (throwIO (Misuse "No active operation to abandon")) cancel (Map.lookup target active)
    pure Null
  else case (if workerMode driver then workerPerform driver identifier operation args else perform driver identifier operation args) of
    Nothing -> say driver (object ["id" .= identifier, "unsupported" .= True])
    Just action -> if operation `elem` ["open", "close", "set-token", "listen", "subscribe-resource", "release-resource", "sync"]
        then answer driver identifier action
        else mask $ \restore -> do
          go <- newEmptyMVar
          worker <- async $ (takeMVar go >> restore (answer driver identifier action))
            `finally` atomically (modifyTVar' (jobs driver) (Map.delete identifier))
          (atomically $ do
            active <- readTVar (jobs driver)
            when (Map.member identifier active) (throwSTM (Misuse "Operation id is already active"))
            writeTVar (jobs driver) (Map.insert identifier worker active)) `onException` cancel worker
          putMVar go ()

serve :: Driver -> IO ()
serve driver = do
  say driver (object ["ready" .= True])
  let loop = do
        ended <- hIsEOF stdin
        unless ended $ do
          line <- Char8.hGetLine stdin
          fields <- either (throwIO . Misuse) decode (eitherDecodeStrict' line)
          dispatch driver fields
          loop
  loop

dispose :: Driver -> IO ()
dispose driver = do
  current <- readTVarIO (connection driver)
  forM_ current Http.dispose
  readTVarIO (jobs driver) >>= mapM_ cancel
  readTVarIO (reporters driver) >>= mapM_ cancel

main :: IO ()
main = do
  endpoint <- lookupEnv "OTEL_EXPORTER_OTLP_ENDPOINT"
  case endpoint of
    Nothing -> run
    Just _ -> bracket Trace.initializeGlobalTracerProvider (\provider -> void (Trace.shutdownTracerProvider provider Nothing)) $ \_ ->
      bracket Metric.initializeGlobalMeterProvider (\provider -> void (Metric.shutdownMeterProvider provider Nothing)) (const run)

run :: IO ()
run = do
  arguments <- getArgs
  mode <- case arguments of [] -> pure False; ["--worker"] -> pure True; _ -> throwIO (Misuse "Unknown driver arguments")
  hSetBuffering stdout NoBuffering
  client <- Http.newHttpClient noProxy defaultManagerSettings
  driver <- Driver <$> newTVarIO Nothing <*> newTVarIO Nothing <*> newTVarIO Map.empty
    <*> newTVarIO [] <*> newTVarIO Map.empty <*> newMVar () <*> newEmptyTMVarIO <*> pure client
    <*> pure (Retry.RetryOptions now waitUntil (randomRIO (0,1))) <*> newTVarIO Nothing <*> pure mode <*> newTVarIO Nothing <*> newTVarIO Nothing <*> newTVarIO Timing.protocolSettings
  void (race (serve driver) (atomically (readTMVar (fatal driver)) >>= throwIO)) `finally` dispose driver
