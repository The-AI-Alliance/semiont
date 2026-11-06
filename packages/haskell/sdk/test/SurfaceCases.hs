{-# LANGUAGE GADTs, OverloadedStrings, ScopedTypeVariables #-}
module SurfaceCases (surfaceCases) where

import Control.Concurrent.Async (async, wait)
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception (bracket)
import Control.Monad (forM_, unless, void)
import Data.Aeson (FromJSON, ToJSON, Value(..), eitherDecodeStrict', toJSON, withObject, (.:))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (parseEither, parseJSON)
import qualified Data.ByteString as Bytes
import qualified Data.List.NonEmpty as NE
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import qualified Semiont.Auth as Auth
import qualified Semiont.Beckon as Beckon
import qualified Semiont.Bind as Bind
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Client as Client
import qualified Semiont.Content as Content
import qualified Semiont.EventBus as Local
import qualified Semiont.Frame as Frame
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Job as Job
import qualified Semiont.System as System
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified Semiont.Worker as Worker
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label value = unless value (ioError (userError label))
readJSON :: FilePath -> IO Value
readJSON path = Bytes.readFile path >>= either (ioError . userError) pure . eitherDecodeStrict'
decode :: FromJSON value => Value -> IO value
decode value = either (ioError . userError) pure (parseEither parseJSON value)
field :: FromJSON value => Key.Key -> Value -> IO value
field key value = either (ioError . userError) pure (parseEither (withObject "surface row" (.: key)) value)
optional :: FromJSON value => Key.Key -> Value -> IO (Maybe value)
optional key (Object row) = traverse decode (KM.lookup key row)
optional _ _ = ioError (userError "surface arguments are not an object")
fixture :: FromJSON value => Map.Map Text Value -> Text -> IO value
fixture fixtures name = maybe (ioError (userError ("missing surface fixture " ++ T.unpack name))) decode (Map.lookup name fixtures)

data Called = Called Text Value deriving (Eq, Show)
data Rig = Rig Client.Client Transport.TransportInput Bus.BusOptions (TQueue Called)

withRig :: Map.Map Text Value -> (Rig -> IO result) -> IO result
withRig fixtures action = do
  calls <- newTQueueIO
  ids <- newTVarIO (0 :: Integer)
  inputCell <- newEmptyTMVarIO
  let clock = Bus.BusOptions (pure 0) (\_ -> atomically retry) (atomically $ do modifyTVar' ids (+1); T.pack . show <$> readTVar ids)
      unexpected :: IO value
      unexpected = ioError (userError "unexpected content operation in surface test")
      contents = Content.ContentTransport (\_ _ _ -> unexpected) (\_ -> unexpected) (\_ _ -> unexpected)
        (\_ -> unexpected) (\_ -> unexpected) (\_ -> unexpected) (pure ())
      gatewayCall :: FromJSON result => Text -> Value -> Text -> IO result
      gatewayCall name input schema = atomically (writeTQueue calls (Called ("gateway:" <> name) input)) >> fixture fixtures schema
      gateway = Gateway.GatewayOperations
        (gatewayCall "getCurrentUser" (Object KM.empty) "UserResponse")
        (\resource -> gatewayCall "getMediaToken" (Object (KM.singleton "resourceId" (toJSON resource))) "MediaTokenResponse")
        (gatewayCall "getProtectedResourceMetadata" (Object KM.empty) "ProtectedResourceMetadata")
        (gatewayCall "healthCheck" (Object KM.empty) "HealthResponse")
        (gatewayCall "getStatus" (Object KM.empty) "StatusResponse")
      send frame = do
        atomically (writeTQueue calls (Called ("request:" <> busFrameChannel frame) (Object (busFramePayloadAdditionalProperties (busFramePayload frame)))))
        input <- atomically (readTMVar inputCell)
        let answer [] = pure ()
            answer (SomeOperation operation : rest) = do
              let (asked, answered, _) = operationChannels operation
              if channelName asked /= busFrameChannel frame then answer rest else do
                value <- maybe (ioError (userError "missing operation answer fixture")) pure (Map.lookup (channelSchema answered) fixtures)
                let completed = case (channelSchema answered, value) of
                      ("JobStatusResult", Object outer) -> case KM.lookup "response" outer of
                        Just (Object response) -> Object (KM.insert "response" (Object (KM.insert "status" (String "complete") response)) outer)
                        _ -> error "JobStatusResult fixture has no response"
                      _ -> value
                payload <- either (ioError . userError) pure (decodePayload answered completed)
                case encodePayload answered payload of
                  Object fields -> Transport.receive input (BusFrame (channelName answered) (busFrameCorrelationId frame) (BusFramePayload fields) Nothing)
                  _ -> ioError (userError "answer is not an object")
        answer allOperations
        pure (Just 37)
  bracket (Transport.newTransport (Transport.TransportOptions "local://surface" (Set.fromList channelNames) send (pure ())))
    (Transport.dispose . fst) $ \(carrier,input) -> do
      atomically (putTMVar inputCell input)
      Transport.setState input Transport.Connecting
      Transport.setState input Transport.Open
      bracket (Client.newClient carrier contents (Just gateway) clock Timing.protocolSettings) Client.dispose $ \client ->
        action (Rig client input clock calls)

surfaceCases :: FilePath -> Map.Map Text Value -> IO ()
surfaceCases root fixtures = do
  result <- timeout 15000000 $ do
    table <- readJSON (root </> "protocol/specs/src/client/surface.json")
    inventory <- readJSON (root </> "packages/haskell/sdk/public-api.json")
    modules <- field "modules" inventory
    client <- field "Semiont.Client" modules
    values <- field "values" client :: IO (Map.Map Text Text)
    let reached = Set.fromList [name | (name,signature) <- Map.toList values, T.isPrefixOf "Semiont.Client.Client -> " signature, T.isSuffixOf "Namespace" signature]
    namespaces <- field "namespaces" table :: IO [Value]
    forM_ namespaces $ \namespace -> do
      name <- field "namespace" namespace
      whenReached reached name $ do
        methods <- field "methods" namespace :: IO [Value]
        forM_ methods $ \method -> do
          member <- field "method" method
          via <- field "via" method
          cases <- field "cases" method :: IO [Value]
          forM_ cases $ \row -> runCase fixtures name member via row
  require "client surface liveness deadline expired" (result == Just ())
  putStrLn "PASS every shared behavior case of each compiled client namespace"
  where whenReached reached name run = if Set.member name reached then run else pure ()

runCase :: Map.Map Text Value -> Text -> Text -> Value -> Value -> IO ()
runCase fixtures namespace member via row = withRig fixtures $ \rigValue@(Rig client input _ calls) -> do
  args <- field "args" row
  expected <- field "sends" row
  local <- optional "local" via
  observes <- optional "observes" via
  case (local,observes) of
    (Just channel, _) -> do
      ready <- newEmptyMVar
      listener <- async $ Local.events (Client.bus client) channel $ \events -> putMVar ready () >> Stream.head_ events
      takeMVar ready
      invoke rigValue namespace member args
      frame <- wait listener >>= maybe (ioError (userError "local signal disappeared")) pure
      require "local signal differs from surface table" (Object (busFramePayloadAdditionalProperties (busFramePayload (Transport.wireFrame frame))) == expected)
      atomically (isEmptyTQueue calls) >>= require "local signal escaped to the wire"
    (_, Just channel) -> do
      ready <- newEmptyMVar
      listener <- async (readEvent client member (putMVar ready ()))
      takeMVar ready
      payload <- decode expected
      Transport.receive input (BusFrame channel Nothing (BusFramePayload payload) Nothing)
      actual <- wait listener
      require "job observation differs from surface table" (actual == expected)
    _ -> do
      invoke rigValue namespace member args
      request <- optional "request" via
      emit <- optional "emit" via
      gateway <- optional "gateway" via
      prefix <- case (request,emit,gateway) of
        (Just channel,_,_) -> pure ("request:" <> channel)
        (_,Just channel,_) -> pure ("request:" <> channel)
        (_,_,Just name) -> pure ("gateway:" <> name)
        _ -> ioError (userError "unhandled surface operation route")
      actual <- atomically (readTQueue calls)
      require ("first effect differs for " ++ T.unpack namespace ++ "." ++ T.unpack member) (actual == Called prefix expected)
      remaining <- maybe [] id <$> optional "then" row
      forM_ remaining $ \step -> do
        channel <- field "request" step
        payload <- field "sends" step
        received <- atomically (readTQueue calls)
        require "surface continuation differs" (received == Called ("request:" <> channel) payload)
      -- A claims reader may be stopped after it has received a job; its
      -- shutdown failure is checked by the worker suite, not this first-effect table.
      unless (namespace == "job" && member == "claim") (atomically (isEmptyTQueue calls) >>= require "surface method performed an unlisted extra effect")

invoke :: Rig -> Text -> Text -> Value -> IO ()
invoke (Rig client _ clock _) namespace member args = case (namespace,member) of
  ("frame","addEntityType") -> field "type" args >>= Frame.addEntityType (Client.frame client)
  ("frame","addEntityTypes") -> field "types" args >>= Frame.addEntityTypes (Client.frame client)
  ("frame","addTagSchema") -> field "schema" args >>= Frame.addTagSchema (Client.frame client)
  ("bind","body") -> do
    resource <- field "resourceId" args; annotation <- field "annotationId" args; operations <- field "operations" args
    Bind.body (Client.bind client) resource annotation operations
  ("bind","initiate") -> field "input" args >>= atomically . Bind.initiate (Client.bind client)
  ("bind","reportBodyError") -> field "input" args >>= atomically . Bind.reportBodyError (Client.bind client)
  ("beckon","attention") -> do
    resource <- field "resourceId" args; annotation <- optional "annotationId" args
    Beckon.attention (Client.beckon client) resource annotation >>= counted
  ("beckon","click") -> field "annotationId" args >>= Beckon.click (Client.beckon client) >>= counted
  ("beckon","openResource") -> field "resourceId" args >>= Beckon.openResource (Client.beckon client) >>= counted
  ("beckon","sparkleAll") -> field "annotationId" args >>= Beckon.sparkleAll (Client.beckon client) >>= counted
  ("beckon","hover") -> field "annotationId" args >>= atomically . Beckon.hover (Client.beckon client)
  ("beckon","sparkle") -> field "annotationId" args >>= atomically . Beckon.sparkle (Client.beckon client)
  ("job","status") -> field "jobId" args >>= void . Job.status (Client.job client)
  ("job","pollUntilComplete") -> do
    identity <- field "jobId" args
    void (Job.pollUntilComplete (Client.job client) identity (Job.PollOptions 1 10 (const (pure ()))))
  ("job","cancel") -> field "jobId" args >>= void . Job.cancel (Client.job client)
  ("job","claim") -> do
    config <- field "options" args
    filters <- field "accepts" config >>= maybe (ioError (userError "empty claim filter fixture")) pure . NE.nonEmpty
    bracket (Job.claim (Client.job client) (Worker.WorkerOptions filters clock Timing.protocolSettings (pure "2026-11-05T00:00:00Z"))) Worker.stop $ \claims ->
      void (Worker.next claims)
  ("auth","me") -> auth >>= void . Auth.me
  ("auth","mediaToken") -> do resource <- field "resourceId" args; auth >>= \value -> void (Auth.mediaToken value resource)
  ("auth","protectedResourceMetadata") -> auth >>= void . Auth.protectedResourceMetadata
  ("system","healthCheck") -> system >>= void . System.healthCheck
  ("system","status") -> system >>= void . System.status
  _ -> ioError (userError ("no surface behavior reader for " ++ T.unpack namespace ++ "." ++ T.unpack member))
  where
    counted result = require "wire subscriber count was lost" (result == Just 37)
    auth = maybe (ioError (userError "missing auth namespace")) pure (Client.auth client)
    system = maybe (ioError (userError "missing system namespace")) pure (Client.system client)

readEvent :: Client.Client -> Text -> IO () -> IO Value
readEvent client member ready = case member of
  "queued" -> Job.queued (Client.job client) consume
  "progress" -> Job.progress (Client.job client) consume
  "complete" -> Job.complete (Client.job client) consume
  "fail" -> Job.fail (Client.job client) consume
  _ -> ioError (userError "unhandled job event")
  where
    consume :: ToJSON payload => Stream (Of (Bus.Heard payload)) IO () -> IO Value
    consume events = do
      ready
      heard <- Stream.head_ events
      case heard of Just (Bus.Heard delivered) -> pure (toJSON (Bus.deliveredPayload delivered)); _ -> ioError (userError "valid surface event was refused")
