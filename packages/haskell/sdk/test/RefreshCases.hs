{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module RefreshCases (refreshCases) where

import Control.Concurrent.STM
import Control.Exception (IOException, bracket, fromException, try)
import Control.Monad (unless, when)
import Data.Aeson (FromJSON, ToJSON, Result(..), Value(..), fromJSON, parseJSON, toJSON)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (getContext, attachContext, detachContext)
import qualified Semiont.Bus as Bus
import qualified Semiont.Cache as Cache
import qualified Semiont.Channels as Channel
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError(..))
import qualified Semiont.Internal.Cache as Cache (fetching)
import qualified Semiont.Internal.Coupled as Coupled
import qualified Semiont.Internal.Generated.CacheRefresh as Fact
import qualified Semiont.Internal.Generated.CachePersistence as Persisted
import qualified Semiont.Internal.Persistence as Persistence
import qualified Semiont.Internal.Refresh as Refresh
import qualified Semiont.Internal.Transport as Internal
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Transport as Transport
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import System.Timeout (timeout)
import qualified ControlledTime as Time

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
fixture :: FromJSON value => Map.Map Text Value -> Text -> IO value
fixture fixtures name = case Map.lookup name fixtures of
  Nothing -> ioError (userError "missing refresh test fixture")
  Just value -> case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
payload :: ToJSON value => value -> BusFramePayload
payload value = case toJSON value of Object fields -> BusFramePayload fields; _ -> error "refresh fixture is not an object"

withCarrier :: (Transport.Transport -> Transport.TransportInput -> Internal.EventBus -> IO result) -> IO result
withCarrier action = bracket
  (Transport.newTransport (Transport.TransportOptions "local://refresh" (Set.fromList Channel.channelNames) (const (pure Nothing)) (pure ())))
  (Transport.dispose . fst) $ \(carrier,input) -> bracket Internal.newEventBus Internal.closeEventBus $ \local ->
    bracket (Transport.bridgeInto carrier local) id $ \_ -> do
      Transport.setState input Transport.Connecting
      Transport.setState input Transport.Open
      action carrier input local

options :: Time.ControlledTime -> Cache.CacheOptions key value
options time = Cache.CacheOptions (Time.now time) (Time.waitUntil time) (Timing.saveDebounceMs Timing.protocolSettings) Nothing (const (pure (pure ())))
clock :: Time.ControlledTime -> Bus.BusOptions
clock time = Bus.BusOptions (Time.now time) (Time.waitUntil time) (ioError (userError "refresh clock unexpectedly used request IDs"))

windowCases :: Map.Map Text Value -> IO ()
windowCases fixtures = withCarrier $ \carrier input local -> do
  time <- Time.newTime
  count <- newTVarIO (0::Int)
  parents <- newTVarIO []
  key <- Context.newKey "refresh source context"
  resource <- either (ioError . userError) pure (mkResourceId "held")
  other <- either (ioError . userError) pure (mkResourceId "unheld")
  stored <- fixture fixtures "StoredEventResponse"
  gap <- fixture fixtures "BusResumeGap"
  let fetch (_::ResourceId) = do
        context <- getContext
        atomically $ do
          modifyTVar' count (+1)
          modifyTVar' parents (++ [Context.lookup key context])
          readTVar count
      matches info identity = Refresh.subjectResource info == Just identity
      event identity = BusFrame (Channel.channelName Channel.MarkAdded) Nothing
        (payload stored { storedEventResponseResourceId = Just identity }) (Just identity)
      waitWindow = Time.advance time (Timing.invalidationWindowMs Timing.protocolSettings * 1000000)
  bracket (Cache.newCache fetch (options time)) Cache.dispose $ \cache -> do
    Cache.fetch cache resource >>= require "first cache read did not fetch" . (==1)
    let control = Refresh.Acts (Refresh.cacheTargets cache matches) Nothing Nothing
    bracket (Refresh.newRefresher local carrier (clock time) Timing.protocolSettings [(Fact.Events,control)]) Refresh.dispose $ \refresher -> do
      Time.settle
      Transport.receive input (event other)
      Time.settle
      readTVarIO count >>= require "an event fetched an unheld key" . (==1)
      Transport.receive input (BusFrame (Channel.channelName Channel.MarkAdded) Nothing (BusFramePayload KM.empty) Nothing)
      Time.settle
      readTVarIO count >>= require "an unreadable event did not ask again for what is held" . (==2)
      waitWindow
      caller <- getContext
      applied <- bracket (attachContext (Context.insert key ("frame-owner"::Text) caller)) detachContext $ \_ -> do
        parent <- getContext
        atomically $ do
          Internal.receiveContextSTM (Just parent) input (event resource)
          Cache.persistencePending cache
      require "cache effects did not land in the frame's transaction" applied
      Time.settle
      readTVarIO count >>= require "first source invalidation was delayed" . (==3)
      readTVarIO parents >>= require "refresh work lost the delivered frame's context" . ((==Just "frame-owner") . last)
      require "a window owed an invalidation before a second event" . not =<< atomically (Refresh.owes refresher)
      Transport.receive input (event resource)
      Transport.receive input (event resource)
      Time.settle
      readTVarIO count >>= require "source invalidations did not coalesce" . (==3)
      require "coalescing let a bookmark outrun an owed invalidation" =<< atomically (Refresh.owes refresher)
      Time.advance time (Timing.invalidationWindowMs Timing.protocolSettings * 1000000 - 1000000)
      readTVarIO count >>= require "owed invalidation ran before its deadline" . (==3)
      Time.advance time 1000000
      readTVarIO count >>= require "owed invalidation did not run at its deadline" . (==4)
      readTVarIO parents >>= require "a later frame inherited an earlier frame's context" . ((==Nothing) . last)
      waitWindow
      require "an invalidation stayed owed once it ran" . not =<< atomically (Refresh.owes refresher)
      Transport.receive input (BusFrame (Channel.channelName Channel.BusResumeGap) Nothing (payload gap { busResumeGapScope = resource }) Nothing)
      Time.settle
      readTVarIO count >>= require "a resumption gap did not refresh its held scope" . (==5)
      Refresh.dispose refresher
      Transport.receive input (event resource)
      waitWindow
      readTVarIO count >>= require "disposed refresh work issued a fetch" . (==5)

writeCases :: Map.Map Text Value -> IO ()
writeCases fixtures = withCarrier $ \carrier input local -> do
  time <- Time.newTime
  requests <- newTVarIO (0::Int)
  annotation <- fixture fixtures "Annotation"
  enriched <- fixture fixtures "EnrichedResourceEvent"
  let identity = annotationId annotation
      updated = annotation { annotationModified = Just "2026-11-05T04:00:00Z" }
      fetch (_::AnnotationId) = atomically (modifyTVar' requests (+1)) >> pure annotation
      matches info item = Refresh.subjectAnnotation info == Just item
      changed value = BusFrame (Channel.channelName Channel.MarkBodyUpdated) Nothing (payload value) Nothing
      plain = enriched { enrichedResourceEventAnnotation = Nothing,
        enrichedResourceEventPayload = EnrichedResourceEventPayload (KM.singleton "annotationId" (toJSON identity)) }
  bracket (Cache.newCache fetch (options time)) Cache.dispose $ \cache -> do
    Cache.set cache identity annotation
    let control = Refresh.Acts (Refresh.cacheTargets cache matches)
          (Just (Refresh.writeTargets cache matches (\info _ -> Refresh.subjectWritten info)))
          (Just (Refresh.endTargets cache matches))
    invalid <- try (Refresh.newRefresher local carrier (clock time) Timing.protocolSettings
      [(Fact.Annotation,Refresh.Acts (Refresh.cacheTargets cache matches) Nothing Nothing)]) :: IO (Either IOException Refresh.Refresher)
    require "a query owner claimed writes/removals it could not implement" (either (const True) (const False) invalid)
    bracket (Refresh.newRefresher local carrier (clock time) Timing.protocolSettings [(Fact.Annotation,control)]) Refresh.dispose $ \refresher -> do
      Transport.receive input (changed plain)
      Time.settle
      readTVarIO requests >>= require "unenriched change did not ask again" . (==1)
      Transport.receive input (changed plain)
      Time.settle
      Transport.receive input (changed enriched { enrichedResourceEventAnnotation = Just updated })
      Time.settle
      require "enriched event did not write its value" . (==Just updated) =<< atomically (Cache.get cache identity)
      Time.advance time (2 * Timing.invalidationWindowMs Timing.protocolSettings * 1000000)
      readTVarIO requests >>= require "a known-value write left an older invalidation owed" . (==1)
      let gone = MarkDeleteOk (MarkDeleteOkResponse identity KM.empty) KM.empty
      Transport.receive input (BusFrame (Channel.channelName Channel.MarkDeleteOk) Nothing (payload gone) Nothing)
      Time.settle
      state <- atomically (Cache.current (Cache.query cache identity))
      require "removal was not a not-found state" (case state of
        Cache.Failed problem -> case fromException problem of Just failure -> busRequestErrorCode failure == Code.BusRequestNotFound; Nothing -> False
        _ -> False)
      readTVarIO requests >>= require "a removal refetched its ended key" . (==1)
      require "written/ended keys left an invalidation owed" . not =<< atomically (Refresh.owes refresher)

reopenCases :: Map.Map Text Value -> IO ()
reopenCases _ = withCarrier $ \carrier input local -> do
  time <- Time.newTime
  requests <- newTVarIO (0::Int)
  let fetch (_::Int) = atomically (modifyTVar' requests (+1) >> readTVar requests)
  bracket (Cache.newCache fetch (options time)) Cache.dispose $ \cache -> do
    Cache.set cache 1 1
    let control = Refresh.Acts (Refresh.cacheTargets cache (\_ _ -> False)) Nothing Nothing
    bracket (Refresh.newRefresher local carrier (clock time) Timing.protocolSettings [(Fact.Resources,control)]) Refresh.dispose $ \_ -> do
      Time.settle
      readTVarIO requests >>= require "initial open refreshed cached values" . (==0)
      Transport.setState input Transport.Reconnecting
      Transport.setState input Transport.Connecting
      Transport.setState input Transport.Open
      Time.settle
      readTVarIO requests >>= require "reopening did not refresh held passing-event queries" . (==1)

-- | Disposal reads the places' gate once, before the refresher or a kept cache
-- is disposed: a window owing an invalidation then holds the places back from
-- the flush, which still writes the document; an owed save does not.
disposalCases :: Map.Map Text Value -> IO ()
disposalCases fixtures = do
  (owedDocument,owedPlaces) <- disposeWith True
  require "disposal did not flush a kept cache's document while a window owed an invalidation" (owedDocument /= Nothing)
  require "disposal wrote the places while a window owed an invalidation" (owedPlaces == Nothing)
  (quietDocument,quietPlaces) <- disposeWith False
  require "disposal did not flush a kept cache's document" (quietDocument /= Nothing)
  require "disposal with nothing in flight or owed did not write the places" (quietPlaces /= Nothing)
  where
  disposeWith owing = withCarrier $ \carrier input local -> do
    time <- Time.newTime
    storage <- Storage.newMemoryStorage
    coupled <- Coupled.newCoupled storage "kb"
    resource <- either (ioError . userError) pure (mkResourceId "held")
    stored <- fixture fixtures "StoredEventResponse"
    persister <- Persistence.persister (Just (Persistence.CachePersistence storage "kb" (pure 1800000000000), coupled))
      Timing.protocolSettings Persisted.Resource (\key _ -> parseJSON key)
    let event = BusFrame (Channel.channelName Channel.MarkAdded) Nothing
          (payload stored { storedEventResponseResourceId = Just resource }) (Just resource)
        matches info identity = Refresh.subjectResource info == Just identity
    bracket (Cache.newCache (\(_::ResourceId) -> pure (1::Int)) ((options time) { Cache.cachePersister = persister })) Cache.dispose $ \cache -> do
      _ <- Cache.fetch cache resource
      let control = Refresh.Acts (Refresh.cacheTargets cache matches) Nothing Nothing
      bracket (Refresh.newRefresher local carrier (clock time) Timing.protocolSettings [(Fact.Events,control)]) Refresh.dispose $ \refresher -> do
        Coupled.start coupled (Cache.persistencePending cache) ((||) <$> Cache.fetching cache <*> Refresh.owes refresher)
        Time.settle
        when owing $ do
          Transport.receive input event
          Time.settle
          Transport.receive input event
          Time.settle
          require "a second event in a window did not owe its invalidation" =<< atomically (Refresh.owes refresher)
        Coupled.savePosition coupled resource "p-held-7"
        require "the kept cache owed no save as disposal began" =<< atomically (Cache.persistencePending cache)
        Coupled.dispose coupled
        Refresh.dispose refresher
        Cache.dispose cache
    (,) <$> Storage.get storage (Persistence.documentKey "kb" Persisted.Resource) <*> Storage.get storage (Coupled.placesKey "kb")

refreshCases :: Map.Map Text Value -> IO ()
refreshCases fixtures = do
  outcome <- timeout 10000000 (windowCases fixtures >> writeCases fixtures >> reopenCases fixtures >> disposalCases fixtures)
  require "refresh runtime exceeded its liveness guard" (outcome == Just ())
  putStrLn "PASS atomic refresh, coalescing, held-only effects, writes/removals, resumption gaps, trace context and disposal"
