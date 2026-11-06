{-# LANGUAGE GADTs, OverloadedStrings, ScopedTypeVariables #-}
module SurfaceCases (surfaceCases) where

import Control.Concurrent.Async (async, wait)
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception (bracket, try, IOException, catch, displayException)
import Semiont.Errors (BusRequestError(..))
import Control.Monad (forM_, unless, void)
import Data.Aeson (FromJSON, ToJSON, Value(..), eitherDecodeStrict', toJSON, withObject, (.:))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (parseEither, parseJSON)
import qualified Data.ByteString as Bytes
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import qualified Data.List.NonEmpty as NE
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import qualified Semiont.Auth as Auth
import qualified Semiont.Beckon as Beckon
import qualified Semiont.Bind as Bind
import qualified Semiont.Browse as Browse
import qualified Semiont.Gather as Gather
import qualified Semiont.Match as Match
import qualified Semiont.Mark as Mark
import qualified Semiont.Yield as Yield
import qualified Semiont.Cache as Cache
import qualified Semiont.Running as Running
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Channels as Channel
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
import qualified Semiont.Types as Types
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

withAnswers :: Map.Map Text Value -> Maybe Value -> (Rig -> IO result) -> IO result
withAnswers fixtures answerOverride action = do
  calls <- newTQueueIO
  ids <- newTVarIO (0 :: Integer)
  inputCell <- newEmptyTMVarIO
  let clock = Bus.BusOptions (pure 0) (\_ -> atomically retry) (atomically $ do modifyTVar' ids (+1); T.pack . show <$> readTVar ids)
      recordContent name identity = atomically (writeTQueue calls (Called ("content:"<>name) (Object (KM.singleton "resourceId" (toJSON identity)))))
      contents = Content.ContentTransport (\_ metadata source progress -> do
          captured <- newEmptyTMVarIO
          Content.openBody source $ \popper -> do
            let readAll = do chunk <- popper; if Bytes.null chunk then pure Bytes.empty else (chunk<>) <$> readAll
            readAll >>= atomically . putTMVar captured
          bytes <- atomically (takeTMVar captured)
          let sent=case toJSON metadata of Object fields -> Object (KM.insert "content" (String (decodeUtf8 bytes)) fields); _ -> error "upload metadata is not an object"
          atomically (writeTQueue calls (Called "content:putBinary" sent))
          progress (Content.UploadProgress (fromIntegral (Bytes.length bytes)) (fromIntegral (Bytes.length bytes)))
          createResourceResponseResourceId <$> fixture fixtures "CreateResourceResponse")
        (\_ identity -> recordContent "getBinary" identity >> pure (Content.BinaryContent "text/plain" "surface"))
        (\_ identity consume -> recordContent "getBinaryStream" identity >> consume "text/plain" (Stream.yield "surface"))
        (\_ identity -> recordContent "getResourceGraph" identity >> fixture fixtures "GetResourceResponse")
        (\_ identity -> recordContent "getAnnotations" identity >> fixture fixtures "GetAnnotationsResponse")
        (\_ identity -> recordContent "getAnchoredText" identity >> fixture fixtures "AnchoredTextAnswer") (pure ())
      gatewayCall :: FromJSON result => Text -> Value -> Text -> IO result
      gatewayCall name input schema = atomically (writeTQueue calls (Called ("gateway:" <> name) input)) >> fixture fixtures schema
      gateway = Gateway.GatewayOperations
        (\_ -> gatewayCall "getCurrentUser" (Object KM.empty) "UserResponse")
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
                let completed = case (answerOverride,channelSchema answered, value) of
                      (Just Null,"EmptyBusPayload",_) -> value
                      (Just Null,_,_) -> error "surface void answer names a nonempty reply"
                      (Just output,_,_) -> Object (KM.singleton "response" output)
                      (Nothing,"JobStatusResult", Object outer) -> case KM.lookup "response" outer of
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
      bracket (Client.newClient carrier contents (Just gateway) clock Timing.protocolSettings Nothing) Client.dispose $ \client ->
        action (Rig client input clock calls)

surfaceCases :: FilePath -> Map.Map Text Value -> IO ()
surfaceCases root fixtures = do
  searchFailureCase fixtures
  result <- timeout 15000000 $ do
    rawTable <- readJSON (root </> "protocol/specs/src/client/surface.json")
    examples <- field "fixtures" rawTable :: IO (Map.Map Text Value)
    let expand value = case value of
          Object fields | KM.size fields==1, Just (String name) <- KM.lookup "$fixture" fields ->
            maybe (error "missing shared surface example") expand (Map.lookup name examples)
          Object fields -> Object (fmap expand fields)
          Array values -> Array (fmap expand values)
          _ -> value
        table=expand rawTable
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
          forM_ cases $ \row -> runCase fixtures name member via row `catch` (\(problem::IOException) ->
            ioError (userError (T.unpack name++"."++T.unpack member++": "++displayException problem++"; "++show row)))
  require "client surface liveness deadline expired" (result == Just ())
  putStrLn "PASS every shared behavior case of each compiled client namespace"
  where whenReached reached name run = if Set.member name reached then run else pure ()

runCase :: Map.Map Text Value -> Text -> Text -> Value -> Value -> IO ()
runCase fixtures namespace member via row = do
  answerOverride <- optional "answers" row
  withAnswers fixtures answerOverride $ \rigValue@(Rig client input _ calls) -> do
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
        correlation <- optional "correlationId" row
        require "local correlation escaped its envelope" (busFrameCorrelationId (Transport.wireFrame frame) == correlation)
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
        content <- optional "content" via
        prefix <- case (request,emit,gateway,content) of
          (Just channel,_,_,_) -> pure ("request:" <> channel)
          (_,Just channel,_,_) -> pure ("request:" <> channel)
          (_,_,Just name,_) -> pure ("gateway:" <> name)
          (_,_,_,Just name) -> pure ("content:" <> name)
          _ -> ioError (userError "unhandled surface operation route")
        actual <- atomically (readTQueue calls)
        require ("first effect differs for " ++ T.unpack namespace ++ "." ++ T.unpack member) (actual == Called prefix expected)
        remaining <- maybe [] id <$> optional "then" row
        forM_ remaining $ \step -> do
          continuedRequest <- optional "request" step
          continuedContent <- optional "content" step
          continuationPrefix <- case (continuedRequest,continuedContent) of
            (Just channel,Nothing) -> pure ("request:"<>channel)
            (Nothing,Just name) -> pure ("content:"<>name)
            _ -> ioError (userError "surface continuation has no single operation")
          payload <- field "sends" step
          received <- atomically (readTQueue calls)
          require "surface continuation differs" (received == Called continuationPrefix payload)
        if namespace=="browse" && member=="engines" then forM_ limitsOperations (\operation -> do
          let (channel,_,_)=operationChannels operation
          received <- atomically (readTQueue calls)
          require "engine limits lost their derived operation" (received==Called ("request:"<>channelName channel) (Object mempty))) else pure ()
        -- A claims reader may be stopped after it has received a job; its
        -- shutdown failure is checked by the worker suite, not this first-effect table.
        unless (namespace == "job" && member == "claim") (atomically (isEmptyTQueue calls) >>= require "surface method performed an unlisted extra effect")
invoke :: Rig -> Text -> Text -> Value -> IO ()
invoke (Rig client _ clock _) namespace member args = case (namespace,member) of
  ("frame","addEntityType") -> field "type" args >>= void . Frame.addEntityType (Client.frame client)
  ("frame","addEntityTypes") -> field "types" args >>= void . Frame.addEntityTypes (Client.frame client)
  ("frame","addTagSchema") -> field "schema" args >>= void . Frame.addTagSchema (Client.frame client)
  ("bind","body") -> do
    resource <- field "resourceId" args; annotation <- field "annotationId" args; operations <- field "operations" args
    void $ Bind.body (Client.bind client) resource annotation operations
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
  ("browse","resource") -> field "resourceId" args >>= void . Cache.fresh . Browse.resource (Client.browse client)
  ("browse","resources") -> optional "filters" args >>= void . Cache.fresh . Browse.resources (Client.browse client)
  ("browse","annotations") -> field "resourceId" args >>= void . Cache.fresh . Browse.annotations (Client.browse client)
  ("browse","annotation") -> do
    identity <- field "resourceId" args; mark <- field "annotationId" args
    void (Cache.fresh (Browse.annotation (Client.browse client) identity mark))
  ("browse","entityTypes") -> void (Cache.fresh (Browse.entityTypes (Client.browse client)))
  ("browse","tagSchemas") -> void (Cache.fresh (Browse.tagSchemas (Client.browse client)))
  ("browse","engines") -> void (Cache.fresh (Browse.engines (Client.browse client)))
  ("browse","events") -> field "resourceId" args >>= void . Cache.fresh . Browse.events (Client.browse client)
  ("browse","resourceContent") -> field "resourceId" args >>= void . Browse.resourceContent (Client.browse client)
  ("browse","resourceGraph") -> field "resourceId" args >>= void . Browse.resourceGraph (Client.browse client)
  ("browse","resourceAnchoredText") -> field "resourceId" args >>= void . Browse.resourceAnchoredText (Client.browse client)
  ("browse","resourceRepresentation") -> field "resourceId" args >>= void . Browse.resourceRepresentation (Client.browse client)
  ("browse","resourceRepresentationStream") -> do
    identity <- field "resourceId" args
    Browse.resourceRepresentationStream (Client.browse client) identity (\_ -> Stream.mapM_ (const (pure ())))
  ("browse","resourceEvents") -> field "resourceId" args >>= void . Browse.resourceEvents (Client.browse client)
  ("browse","annotationHistory") -> do
    identity <- field "resourceId" args; mark <- field "annotationId" args
    void (Browse.annotationHistory (Client.browse client) identity mark)
  ("browse","files") -> do
    path <- optional "dirPath" args; sort <- optional "sort" args
    void (Browse.files (Client.browse client) path sort)
  ("browse","kb") -> void (Browse.kb (Client.browse client))
  ("browse","click") -> field "annotationId" args >>= atomically . Browse.click (Client.browse client)
  ("browse","openResource") -> field "resourceId" args >>= atomically . Browse.openResource (Client.browse client)
  ("browse","resourceViewed") -> field "resourceId" args >>= Browse.resourceViewed (Client.browse client)
  ("gather","annotation") -> do
    identity <- field "resourceId" args; mark <- field "annotationId" args; options <- optional "options" args
    Gather.annotation (Client.gather client) identity mark options >>= void . Running.await
  ("gather","resource") -> do
    identity <- field "resourceId" args; options <- optional "options" args
    void (Gather.resource (Client.gather client) identity options)
  ("gather","referencedBy") -> field "resourceId" args >>= void . Cache.fresh . Gather.referencedBy (Client.gather client)
  ("match","search") -> do
    identity <- field "resourceId" args; reference <- field "referenceId" args; context <- field "context" args; options <- optional "options" args
    Match.search (Client.match client) identity reference context options >>= void . Running.await
  ("match","requestSearch") -> do
    input <- field "input" args; correlation <- field "correlationId" args
    atomically (Match.requestSearch (Client.match client) input correlation)
  ("match","resources") -> do
    text <- field "search" args; filters <- optional "filters" args
    void (Cache.fresh (Match.resources (Client.match client) text filters))
  ("mark","annotation") -> field "input" args >>= void . Mark.annotation (Client.mark client)
  ("mark","delete") -> do
    identity <- field "resourceId" args; mark <- field "annotationId" args
    void (Mark.delete (Client.mark client) identity mark)
  ("mark","archive") -> field "resourceId" args >>= void . Mark.archive (Client.mark client)
  ("mark","unarchive") -> field "resourceId" args >>= void . Mark.unarchive (Client.mark client)
  ("mark","updateEntityTypes") -> do
    identity <- field "resourceId" args; current <- field "current" args; updated <- field "updated" args
    void (Mark.updateEntityTypes (Client.mark client) identity current updated)
  ("mark","delegate") -> do
    identity <- field "resourceId" args; params <- field "params" args
    operation <- Mark.delegate (Client.mark client) identity params
    Running.withReports operation (Stream.effects . Stream.take 1)
  ("mark","request") -> do
    identity <- field "source" args; selector <- field "selector" args; motivation <- field "motivation" args
    atomically (Mark.request (Client.mark client) identity selector motivation)
  ("mark","submit") -> field "input" args >>= atomically . Mark.submit (Client.mark client)
  ("mark","reportDeleteError") -> field "input" args >>= atomically . Mark.reportDeleteError (Client.mark client)
  ("yield","resource") -> do
    input <- field "data" args
    text <- field "content" input
    metadata <- case input of Object fields -> decode (Object (KM.delete "content" fields)); _ -> ioError (userError "resource data is not an object")
    Yield.resource (Client.yield client) metadata (Content.bytesBody (encodeUtf8 text)) >>= void . Running.await
  ("yield","delegate") -> do
    params <- field "params" args; stall <- optional "stallDeadlineMs" args
    operation <- Yield.delegate (Client.yield client) params stall
    Running.withReports operation (Stream.effects . Stream.take 1)
  ("yield","cloneToken") -> field "resourceId" args >>= void . Yield.cloneToken (Client.yield client)
  ("yield","fromToken") -> field "token" args >>= void . Yield.fromToken (Client.yield client)
  ("yield","createFromToken") -> do
    options <- field "options" args
    token <- field "token" options; name <- field "name" options; text <- field "content" options; archive <- optional "archiveOriginal" options
    void (Yield.createFromToken (Client.yield client) token name text archive)
  ("yield","clone") -> atomically (Yield.clone (Client.yield client))
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
  ("auth","me") -> auth >>= \value -> void (Auth.me value Nothing)
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


searchFailureCase :: Map.Map Text Value -> IO ()
searchFailureCase fixtures = do
  inputCell <- newEmptyTMVarIO
  context <- fixture fixtures "GatheredContext"
  identity <- either (ioError . userError) pure (mkResourceId "search-resource")
  reference <- either (ioError . userError) pure (mkAnnotationId "search-annotation")
  let input=MatchSearchRequest context Nothing reference identity Nothing mempty
      send frame = do
        source <- atomically (readTMVar inputCell)
        let refusal=Types.MatchSearchFailed "the search was refused" reference mempty
        case encodePayload Channel.MatchSearchFailed refusal of
          Object fields -> Transport.receive source (BusFrame (channelName Channel.MatchSearchFailed) (busFrameCorrelationId frame) (BusFramePayload fields) Nothing)
          _ -> ioError (userError "search failure is not an object")
        pure Nothing
      options=Bus.BusOptions (pure 0) (const (atomically retry)) (pure "search-failure")
  bracket (Transport.newTransport (Transport.TransportOptions "local://search-failure" (Set.fromList channelNames) send (pure ())))
    (Transport.dispose . fst) $ \(carrier,source) -> do
      atomically (putTMVar inputCell source)
      Transport.setState source Transport.Connecting
      Transport.setState source Transport.Open
      outcome <- try (Bus.request (Bus.newBus options carrier) MatchSearchRequestedOperation input (Timing.busRequestTimeoutMs Timing.protocolSettings))
      case outcome of
        Left problem -> require "search failure lost its channel's words" (busRequestErrorMessage problem=="the search was refused")
        Right _ -> ioError (userError "refused search returned a result")
