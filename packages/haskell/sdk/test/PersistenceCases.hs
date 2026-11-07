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
import Data.Text.Encoding (encodeUtf8)
import qualified Semiont.Cache as Cache
import qualified Semiont.StoragePersister as Stored
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Internal.Coupled as Coupled
import Semiont.Internal.Generated.CachePersistence (CacheDocument(..), keptQueryName)
import qualified Semiont.Internal.Generated.Stored as Keys
import Semiont.Types
import qualified ControlledTime as Time

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
readDocument :: Storage.SessionStorage -> Text -> IO CacheDocument
readDocument storage key = do
  raw <- Storage.get storage key >>= maybe (ioError (userError "No persisted cache document")) pure
  either (ioError . userError) pure (eitherDecodeStrict' (encodeUtf8 raw))

persistenceCases :: Map.Map Text Value -> IO ()
persistenceCases fixtures = do
  storage <- Storage.newMemoryStorage
  -- The host's clock need not tick in whole milliseconds; each stamp is it rounded.
  wall <- newTVarIO (10.4::Scientific)
  let unicode=Text.replicate 80 "λ"
      desired=CacheDocument [(String "b",String "new",20),(String "c",String unicode,30)]
      limit=toInteger (Lazy.length (encode desired))
      config=Stored.StoragePersister storage "case" limit (readTVarIO wall) (pure ())
      make options=Stored.newStoragePersister options (\key (_::Text) -> parseJSON key) :: IO (Cache.CachePersister Text Text)
  persister <- make config
  Cache.save persister [("a","old"),("b","old")]
  atomically (writeTVar wall 19.6)
  Cache.save persister [("a","old"),("b","new")]
  before <- readDocument storage "case"
  require "an unchanged persisted entry lost its original stamp, or a stamp was not the clock rounded" (before==CacheDocument [(String "a",String "old",10),(String "b",String "new",20)])
  atomically (writeTVar wall 30)
  Cache.save persister [("a","old"),("b","new"),("c",unicode)]
  document <- readDocument storage "case"
  require "byte eviction lost write recency or measured characters instead of UTF-8 bytes" (document==desired)
  restored <- make config
  require "durable entries did not rehydrate" . (==[("b","new"),("c",unicode)]) =<< Cache.load restored
  Cache.save restored [("b","new"),("c",unicode)]
  require "rehydrated unchanged entries lost their stamps" . (==desired) =<< readDocument storage "case"
  forM_ ["{", "null", "[]", "{}", "{\"version\":1,\"entries\":[[\"a\",7,1]]}", "{\"version\":2,\"entries\":[[\"b\",\"new\",20]]}"] $ \bad -> do
      Storage.set storage "case" bad
      reader <- make config
      require "a corrupt or wrong-version document, or an ill-typed entry, reached a cache" . null =<< Cache.load reader
  savedCases
  coupledCases
  clientCases fixtures
  putStrLn "PASS versioned cache documents, UTF-8 byte eviction, stable write stamps and quiescent bookmark coupling"

-- | A save's follow-up runs once the cache has recorded the save, so a place
-- written in it is gated by the cache it follows as by every other.
savedCases :: IO ()
savedCases = do
  owner <- newEmptyTMVarIO
  seen <- newEmptyTMVarIO
  let follow=atomically (readTMVar owner >>= Cache.persistencePending >>= putTMVar seen)
      options=Cache.CacheOptions (pure 0) (const (pure ())) 0
        (Just (Cache.CachePersister (pure []) (\_ -> pure ()) follow)) (const (pure (pure ())))
  bracket (Cache.newCache (pure :: Int -> IO Int) options) Cache.dispose $ \cache -> do
    atomically (putTMVar owner cache)
    Cache.set cache 1 10
    require "a save's follow-up ran while its cache still owed that save" . not =<< atomically (takeTMVar seen)

coupledCases :: IO ()
coupledCases = do
  underlying <- Storage.newMemoryStorage
  quiet <- newTVarIO False
  resource <- either (ioError . userError) pure (mkResourceId "res-1")
  other <- either (ioError . userError) pure (mkResourceId "res-2")
  let key=Keys.lastEventIdKeyPrefix<>"kb"
      expect label expected=do actual<-Storage.get underlying key
                               require label (actual==expected)
  bracket (Coupled.newCoupled underlying "kb") Coupled.dispose $ \coupled -> do
    let held label expected=require label . (==expected) =<< Coupled.loadPositions coupled
    Coupled.savePosition coupled resource "p-res-1-1"
    atomically (writeTVar quiet True)
    Coupled.written coupled
    expect "a place was written before its client's gate was given" Nothing
    Coupled.start coupled (not <$> readTVar quiet) (pure False)
    atomically (writeTVar quiet False)
    Coupled.written coupled
    expect "a place was written while a kept cache or the refresher was not settled" Nothing
    atomically (writeTVar quiet True)
    Time.settle
    expect "a place was written with no write of a kept cache" Nothing
    Coupled.written coupled
    held "a settled write of a kept cache did not carry its place" (Map.singleton resource "p-res-1-1")
    Coupled.savePosition coupled other "p-res-2-3"
    Time.settle
    held "a place moved with no write of a kept cache" (Map.singleton resource "p-res-1-1")
    -- A newer event can arrive while the first scope is quiet: every kept
    -- cache must settle before either scope's place can move.
    atomically (writeTVar quiet False)
    Coupled.savePosition coupled resource "p-res-1-2"
    Coupled.written coupled
    held "a write while unsettled moved a place" (Map.singleton resource "p-res-1-1")
    atomically (writeTVar quiet True)
    Coupled.written coupled
    held "the settled places did not keep both scopes" (Map.fromList [(resource,"p-res-1-2"),(other,"p-res-2-3")])
    Coupled.savePosition coupled resource "e-resource-event"
    Coupled.written coupled
    held "an ephemeral id became a place" (Map.fromList [(resource,"p-res-1-2"),(other,"p-res-2-3")])
    -- A save owed when disposal begins does not hold the places back: the
    -- disposal's flush is that save.
    Coupled.savePosition coupled resource "p-res-1-4"
    atomically (writeTVar quiet False)
    Coupled.dispose coupled
    Coupled.savePosition coupled other "p-res-2-5"
    Coupled.written coupled
    held "the disposal's flush did not write the places noted before it began, or wrote one noted after"
      (Map.fromList [(resource,"p-res-1-4"),(other,"p-res-2-3")])

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
    value <- Storage.get kept (Keys.cacheKeyPrefix<>"client-case."<>keptQueryName query)
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
