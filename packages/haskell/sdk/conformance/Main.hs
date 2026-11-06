{-# LANGUAGE GADTs, OverloadedStrings, ScopedTypeVariables #-}
module Main (main) where

import Control.Concurrent (threadDelay, yield)
import Control.Concurrent.Async
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception
import Control.Monad (forM_, unless, void, when)
import Data.Aeson hiding (decode)
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
import GHC.Clock (getMonotonicTimeNSec)
import Network.HTTP.Client (defaultManagerSettings, noProxy)
import qualified OpenTelemetry.Trace as Trace
import qualified OpenTelemetry.Metric as Metric
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Content as Content
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Http as Http
import qualified Semiont.Retry as Retry
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Transport.Facts (connectionStateName)
import Semiont.Types
import System.IO
import System.Environment (lookupEnv)
import System.Random (randomRIO)
import qualified Streaming.Prelude as Stream

data Misuse = Misuse String deriving Show
instance Exception Misuse

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
  }

say :: Driver -> Value -> IO ()
say driver value = withMVar (output driver) $ \() -> Lazy.hPut stdout (encode value <> "\n") >> hFlush stdout

need :: FromJSON value => Object -> Key -> IO value
need fields key = case KM.lookup key fields of
  Nothing -> throwIO (Misuse ("Missing argument " ++ show key))
  Just value -> decode value

decode :: FromJSON value => Value -> IO value
decode value = case fromJSON value of Error reason -> throwIO (Misuse reason); Success result -> pure result

optional :: FromJSON value => Object -> Key -> IO (Maybe value)
optional fields key = traverse decode (KM.lookup key fields)

opened :: Driver -> IO Http.HttpTransport
opened driver = readTVarIO (connection driver) >>= maybe (throwIO (Misuse "No transport is open")) pure

failure :: SomeException -> Maybe Value
failure exception
  | Just problem <- fromException exception :: Maybe TransportError = Just $ object
      (["code" .= Code.transportCode (transportErrorCode problem), "detail" .= transportErrorMessage problem]
        ++ maybe [] (\status -> ["status" .= status]) (httpStatus problem))
  | Just problem <- fromException exception :: Maybe BusRequestError = Just $ object
      ["code" .= Code.busRequestCode (busRequestErrorCode problem), "detail" .= busRequestErrorMessage problem]
  | otherwise = Nothing

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

now :: IO Integer
now = toInteger <$> getMonotonicTimeNSec

waitUntil :: Integer -> IO ()
waitUntil due = do
  current <- now
  when (current < due) $ do
    threadDelay (fromInteger (min (toInteger (maxBound :: Int)) ((due - current + 999) `div` 1000)))
    waitUntil due

open :: Driver -> Object -> IO Value
open driver args = do
  previous <- readTVarIO (connection driver)
  when (maybe False (const True) previous) (throwIO (Misuse "A transport is already open"))
  address <- need args "baseUrl"
  token <- need args "token"
  channels <- need args "channels"
  overrides <- maybe (pure (Object KM.empty)) pure =<< optional args "timing"
  timings <- either (throwIO . Misuse) pure (Timing.withOverrides overrides)
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
  created <- Content.putBinary (Http.content http) metadata (Content.bytesBody bytes) notice
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
    binary <- Content.getBinary contents resource
    pure (binaryValue (Content.contentType binary) (Content.contentBytes binary))
  "get-stream" -> Just $ do
    contents <- Http.content <$> opened driver
    resource <- need args "resource"
    Content.getBinaryStream contents resource $ \media chunks -> binaryValue media . Bytes.concat <$> Stream.toList_ chunks
  "graph" -> Just $ contentRead Content.getResourceGraph
  "annotations" -> Just $ contentRead Content.getAnnotations
  "anchored-text" -> Just $ contentRead Content.getAnchoredText
  "health" -> Just $ gatewayRead Gateway.healthCheck
  "status" -> Just $ gatewayRead Gateway.getStatus
  "current-user" -> Just $ gatewayRead Gateway.getCurrentUser
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
    contentRead :: ToJSON answer => (Content.ContentTransport -> ResourceId -> IO answer) -> IO Value
    contentRead readContent = do
      contents <- Http.content <$> opened driver
      resource <- need args "resource"
      toJSON <$> readContent contents resource
    gatewayRead :: ToJSON answer => (Gateway.GatewayOperations -> IO answer) -> IO Value
    gatewayRead readGateway = opened driver >>= fmap toJSON . readGateway . Http.gateway

answer :: Driver -> Integer -> IO Value -> IO ()
answer driver identifier action = do
  outcome <- try action
  case outcome of
    Right value -> say driver (object ["id" .= identifier, "ok" .= value])
    Left problem
      | Just (Misuse reason) <- fromException problem -> say driver (object ["id" .= identifier, "misuse" .= reason])
      | Just AsyncCancelled <- fromException problem -> say driver (object ["id" .= identifier, "abandoned" .= True])
      | Just value <- failure problem -> say driver (object ["id" .= identifier, "error" .= value])
      | otherwise -> atomically (void (tryPutTMVar (fatal driver) problem))

dispatch :: Driver -> Object -> IO ()
dispatch driver args = do
  identifier <- need args "id"
  operation <- need args "op"
  if operation == "abandon" then answer driver identifier $ do
    target <- need args "request"
    active <- readTVarIO (jobs driver)
    maybe (throwIO (Misuse "No active operation to abandon")) cancel (Map.lookup target active)
    pure Null
  else case perform driver identifier operation args of
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
  hSetBuffering stdout NoBuffering
  client <- Http.newHttpClient noProxy defaultManagerSettings
  driver <- Driver <$> newTVarIO Nothing <*> newTVarIO Nothing <*> newTVarIO Map.empty
    <*> newTVarIO [] <*> newTVarIO Map.empty <*> newMVar () <*> newEmptyTMVarIO <*> pure client
    <*> pure (Retry.RetryOptions now waitUntil (randomRIO (0,1))) <*> newTVarIO Nothing
  void (race (serve driver) (atomically (readTMVar (fatal driver)) >>= throwIO)) `finally` dispose driver
