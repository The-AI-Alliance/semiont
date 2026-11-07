{-# LANGUAGE OverloadedStrings, ScopedTypeVariables, GADTs #-}
module PersistenceCases (persistenceCases) where

import Control.Concurrent.Async (async, cancel)
import Control.Concurrent.STM
import Control.Exception (bracket)
import Control.Monad (unless, forM_)
import Data.Aeson (Value(..), FromJSON, fromJSON, Result(..), encode, toJSON, eitherDecodeStrict', parseJSON)
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.List (find)
import qualified Semiont.Client as Client
import qualified Semiont.Browse as Browse
import qualified Semiont.Content as Content
import qualified Semiont.Bus as Bus
import qualified Semiont.Transport as Transport
import qualified Semiont.Channels as Channel
import qualified Semiont.Timing.Settings as Timing
import qualified Streaming.Prelude as Stream
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import qualified Semiont.Cache as Cache
import qualified Semiont.StoragePersister as Stored
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Internal.Coupled as Coupled
import Semiont.Internal.Generated.CachePersistence
import qualified Semiont.Internal.Generated.Stored as Keys
import Semiont.Types
import qualified ControlledTime as Time

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
readDocument :: Storage.SessionStorage -> Text -> IO StoredDocument
readDocument storage key = do
  raw <- Storage.get storage key >>= maybe (ioError (userError "No persisted cache document")) pure
  either (ioError . userError) pure (eitherDecodeStrict' (encodeUtf8 raw))

persistenceCases :: Map.Map Text Value -> IO ()
persistenceCases fixtures = do
  storage <- Storage.newMemoryStorage
  wall <- newTVarIO (10::Scientific)
  let unicode=Text.replicate 80 "λ"
      desired=StoredDocument 1 30 [(String "b",String "new",20),(String "c",String unicode,30)]
      limit=toInteger (Lazy.length (encode desired))
      config=Stored.StoragePersister storage "case" 1 limit (readTVarIO wall)
      make options=Stored.newStoragePersister options (\key (_::Text) -> parseJSON key) :: IO (Cache.CachePersister Text Text)
  persister <- make config
  Cache.save persister [("a","old"),("b","old")]
  atomically (writeTVar wall 20)
  Cache.save persister [("a","old"),("b","new")]
  before <- readDocument storage "case"
  require "an unchanged persisted entry lost its original write time" (storedEntries before==[(String "a",String "old",10),(String "b",String "new",20)])
  atomically (writeTVar wall 30)
  Cache.save persister [("a","old"),("b","new"),("c",unicode)]
  document <- readDocument storage "case"
  require "byte eviction lost write recency or measured characters instead of UTF-8 bytes" (document==desired)
  restored <- make config
  require "durable entries did not rehydrate" . (==[("b","new"),("c",unicode)]) =<< Cache.load restored
  Cache.save restored [("b","new"),("c",unicode)]
  require "rehydrated unchanged entries lost their stamps" . (==desired) =<< readDocument storage "case"
  forM_ ["{", "null", "[]", "{}", "{\"version\":1,\"writtenAt\":1,\"entries\":[[\"a\",7,1]]}",
    decodeUtf8 (Lazy.toStrict (encode desired { storedVersion=2 }))] $ \bad -> do
      Storage.set storage "case" bad
      reader <- make config
      require "a corrupt, wrong-version or ill-typed persisted document reached a cache" . null =<< Cache.load reader
  coupledCases
  clientCases fixtures
  putStrLn "PASS versioned cache documents, UTF-8 byte eviction, stable write stamps and quiescent bookmark coupling"

coupledCases :: IO ()
coupledCases = do
  underlying <- Storage.newMemoryStorage
  quiet <- newTVarIO False
  resource <- either (ioError . userError) pure (mkResourceId "res-1")
  other <- either (ioError . userError) pure (mkResourceId "res-2")
  let key=Keys.lastEventIdKeyPrefix<>"kb"
      document=Keys.cacheKeyPrefix<>"kb.resource"
      expect expected=do actual<-Storage.get underlying key
                         require "bookmark persisted ahead of its quiet cache documents" (actual==expected)
  bracket (Coupled.newCoupled underlying "kb") Coupled.dispose $ \coupled -> do
    Coupled.start coupled (readTVar quiet)
    Coupled.savePosition coupled resource "p-res-1-1"
    atomically (writeTVar quiet True)
    Time.settle
    expect Nothing
    Storage.set (Coupled.storage coupled) "unrelated" "a write is not a cache document"
    Time.settle
    expect Nothing
    atomically (writeTVar quiet False)
    Storage.set (Coupled.storage coupled) document "bystander document"
    Time.settle
    expect Nothing
    atomically (writeTVar quiet True)
    Time.settle
    require "a completed document write never carried its pending bookmark" . (==Map.singleton resource "p-res-1-1") =<< Coupled.loadPositions coupled
    Coupled.savePosition coupled other "p-res-2-3"
    Time.settle
    require "a bookmark moved without another document write" . (==Map.singleton resource "p-res-1-1") =<< Coupled.loadPositions coupled
    -- A newer event can arrive while the first scope is quiet: all caches
    -- must settle before either scope's pending bookmark can move.
    atomically (writeTVar quiet False)
    Coupled.savePosition coupled resource "p-res-1-2"
    Storage.set (Coupled.storage coupled) document "second bystander"
    Time.settle
    require "a bystander save flushed a busy scope" . (==Map.singleton resource "p-res-1-1") =<< Coupled.loadPositions coupled
    atomically (writeTVar quiet True)
    Time.settle
    require "the quiet record did not retain both scopes" . (==Map.fromList [(resource,"p-res-1-2"),(other,"p-res-2-3")]) =<< Coupled.loadPositions coupled
    Coupled.savePosition coupled resource "e-resource-event"
    Coupled.savePosition coupled resource "p-res-2-4"
    Storage.set (Coupled.storage coupled) document "invalid positions do not advance"
    Time.settle
    require "an ephemeral or wrong-scope ID became a resumption bookmark" . (==Map.fromList [(resource,"p-res-1-2"),(other,"p-res-2-3")]) =<< Coupled.loadPositions coupled
    atomically (writeTVar quiet False)
    Coupled.savePosition coupled resource "p-res-1-4"
    Storage.set (Coupled.storage coupled) document "must not flush after disposal"
    Coupled.dispose coupled
    atomically (writeTVar quiet True)
    Time.settle
    require "disposal's cleared cache state advanced a pending bookmark" . (==Map.fromList [(resource,"p-res-1-2"),(other,"p-res-2-3")]) =<< Coupled.loadPositions coupled

fixture :: FromJSON value => Map.Map Text Value -> Text -> IO value
fixture fixtures name=case Map.lookup name fixtures of
  Just value -> case fromJSON value of Success parsed->pure parsed; Error diagnostic->ioError (userError diagnostic)
  Nothing -> ioError (userError "Missing persistence fixture")

clientCases :: Map.Map Text Value -> IO ()
clientCases fixtures = do
  time <- Time.newTime
  kept <- Storage.newMemoryStorage
  resource <- either (ioError . userError) pure (mkResourceId "res-1")
  originalAnnotation <- fixture fixtures "Annotation"
  originalDescriptor <- fixture fixtures "ResourceDescriptor"
  let annotationValue=originalAnnotation { annotationTarget=AnnotationTargetInlineBranch1 resource }
      descriptor name=originalDescriptor { resourceDescriptorU40_id=resource,resourceDescriptorName=name }
      persistence=Just (Client.CachePersistence kept "client-case" (pure 1800000000000))
      configuration=Bus.BusOptions (Time.now time) (Time.waitUntil time)
  counter <- newTVarIO (0::Integer)
  let identifier=atomically $ do modifyTVar' counter (+1); Text.pack . show <$> readTVar counter
      options=configuration identifier
      contents=Content.ContentTransport (\_ _ _ _ -> ioError (userError "Unexpected upload"))
        (\_ _ -> ioError (userError "Unexpected binary read"))
        (\_ _ _ -> ioError (userError "Unexpected streamed read"))
        (\_ _ -> fixture fixtures "GetResourceResponse")
        (\_ _ -> fixture fixtures "GetAnnotationsResponse")
        (\_ _ -> fixture fixtures "AnchoredTextAnswer") (pure ())
      connection name blocked requests = do
        inputCell <- newEmptyTMVarIO
        let send frame = do
              atomically (modifyTVar' requests (<>[busFrameChannel frame]))
              input <- atomically (readTMVar inputCell)
              (reply,payload) <- case busFrameChannel frame of
                "browse:resource-requested" -> do
                  atomically (readTMVar blocked)
                  pure ("browse:resource-result",toJSON (BrowseResourceResult (BrowseResourceResultResponse 1 (descriptor name)) mempty))
                "browse:annotation-requested" -> pure ("browse:annotation-result",toJSON (BrowseAnnotationResult (GetAnnotationResponse annotationValue Nothing Nothing mempty) mempty))
                request -> case find (\(Channel.SomeOperation operation) -> let (channel,_,_)=Channel.operationChannels operation in Channel.channelName channel==request) Channel.allOperations of
                  Nothing -> ioError (userError "Unexpected persistence request")
                  Just (Channel.SomeOperation operation) -> do
                    let (_,result,_) = Channel.operationChannels operation
                    value <- maybe (ioError (userError "Missing operation result fixture")) pure (Map.lookup (Channel.channelSchema result) fixtures)
                    pure (Channel.channelName result,value)
              case payload of
                Object fields -> Transport.receive input (BusFrame reply (busFrameCorrelationId frame) (BusFramePayload fields) Nothing)
                _ -> ioError (userError "Result fixture is not an object")
              pure (Just 1)
        (carrier,input) <- Transport.newTransport (Transport.TransportOptions "local://persisted" (Set.fromList Channel.channelNames) send (pure ()))
        atomically (putTMVar inputCell input)
        Transport.setState input Transport.Connecting
        Transport.setState input Transport.Open
        Client.newClient carrier contents Nothing options Timing.protocolSettings persistence
      load namespace = do
        _ <- Cache.fresh (Browse.resource namespace resource)
        _ <- Cache.fresh (Browse.annotations namespace resource)
        _ <- Cache.fresh (Browse.annotation namespace resource (annotationId annotationValue))
        _ <- Cache.fresh (Browse.entityTypes namespace)
        _ <- Cache.fresh (Browse.tagSchemas namespace)
        pure ()
  ready <- newTMVarIO ()
  requests <- newTVarIO []
  bracket (connection "first" ready requests) Client.dispose (load . Client.browse)
  -- Closing synchronously flushed all five opt-in views; no test sleep or
  -- elapsed clock is needed to make their last values durable.
  forM_ [minBound..maxBound] $ \query -> do
    value <- Storage.get kept (Keys.cacheKeyPrefix<>"client-case."<>persistedQueryName query)
    require "a declared persisted view was not saved on client disposal" (value/=Nothing)
  blocked <- newEmptyTMVarIO
  calls <- newTVarIO []
  bracket (connection "second" blocked calls) Client.dispose $ \client -> do
    let query=Browse.resource (Client.browse client) resource
    initial <- atomically (Cache.current query)
    require "rehydrated query did not synchronously paint its durable value" (case initial of Cache.Ready value->resourceDescriptorName value=="first"; _->False)
    watcher <- async (Cache.watch query (Stream.mapM_ (const (pure ()))))
    Time.settle
    require "first restored observation did not issue exactly one resource revalidation" . (==["browse:resource-requested"]) =<< readTVarIO calls
    inFlight <- atomically (Cache.current query)
    require "restored query flashed pending during revalidation" (case inFlight of Cache.Ready value->resourceDescriptorName value=="first"; _->False)
    atomically (putTMVar blocked ())
    Time.settle
    updated <- atomically (Cache.current query)
    require "restored query did not accept revalidated data" (case updated of Cache.Ready value->resourceDescriptorName value=="second"; _->False)
    cancel watcher
