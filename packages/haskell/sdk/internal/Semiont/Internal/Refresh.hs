{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module Semiont.Internal.Refresh
  ( Refresher, SubjectInfo(..), Target(..), Acts(..), newRefresher, owes, dispose
  , cacheTargets, writeTargets, updateTargets, endTargets
  ) where

import Control.Concurrent.STM
import Control.Exception (SomeException, SomeAsyncException, bracket, fromException, mask, mask_, onException, finally, throwIO, toException, try)
import Control.Monad (forM_, forever, unless, void, when)
import Data.Aeson (FromJSON, Result(..), Value(..), fromJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.List (find)
import qualified Data.Map.Strict as Map
import Data.Maybe (fromMaybe, isJust, isNothing)
import Data.Text (Text)
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (attachContext, detachContext)
import qualified Semiont.Bus as Bus
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError(..), TransportError(..))
import qualified Semiont.Internal.Cache as Cache
import qualified Semiont.Internal.Generated.CacheRefresh as Fact
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.Required as Required
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Internal.Transport as Transport
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport.Facts as Connection
import Semiont.Types (Annotation, AnnotationId, ResourceId, BusFrame(..), BusFramePayload(..))
import qualified Streaming.Prelude as Stream

data SubjectInfo = SubjectInfo
  { subjectWhen :: Maybe Text, subjectResource :: Maybe ResourceId
  , subjectAnnotation :: Maybe AnnotationId, subjectWritten :: Maybe Annotation
  } deriving (Eq, Show)
data Target = Target Text (STM (IO ()))
data Acts = Acts
  { refetch :: SubjectInfo -> Fact.Reach -> STM [Target]
  , write :: Maybe (SubjectInfo -> STM [Target])
  , end :: Maybe (SubjectInfo -> STM [Target])
  }
type Parent = Maybe Context.Context
data Window = Window Integer (Maybe (Parent, STM (IO ())))
data Refresher = Refresher
  { lifetime :: Lifetime.Lifetime, closed :: TVar Bool
  , windows :: TVar (Map.Map (Fact.Query,Text) Window), counter :: TVar Integer
  , queue :: TQueue (Parent,IO ()), clock :: Bus.BusOptions, timing :: Timing.Settings
  , acts :: Map.Map Fact.Query Acts
  , release :: IO ()
  }

-- | The member a way ends at: Just Nothing where it, or a member on it, is
-- absent or null; Nothing where a member on it is present and no object, which
-- makes the event unreadable.
memberAt :: [Text] -> Value -> Maybe (Maybe Value)
memberAt _ Null = Just Nothing
memberAt [] value = Just (Just value)
memberAt (key:rest) (Object fields) = maybe (Just Nothing) (memberAt rest) (KM.lookup (Key.fromText key) fields)
memberAt _ _ = Nothing
-- | What a way names, read as its type: Nothing where the event is unreadable there.
readPart :: FromJSON value => Maybe [Text] -> Value -> Maybe (Maybe value)
readPart Nothing _ = Just Nothing
readPart (Just way) value = memberAt way value >>= traverse (\raw -> case fromJSON raw of Error _ -> Nothing; Success parsed -> Just parsed)
-- | What an event on a channel names, by the ways of its row; Nothing when
-- the event is unreadable. A split channel's event is enriched when the member
-- its enriched row carries is present.
subject :: Text -> Value -> Maybe SubjectInfo
subject channel value = do
  row <- chosen
  let Fact.Row _ label _ (Fact.Ways resource annotation carried) _ _ _ = row
  SubjectInfo label <$> readPart resource value <*> readPart annotation value <*> readPart carried value
  where
    ofChannel = [row | row@(Fact.Row on _ _ _ _ _ _) <- Fact.rows, on == channel]
    split label = find (\(Fact.Row _ condition _ _ _ _ _) -> condition == Just label) ofChannel
    chosen = case (split "enriched", split "unenriched") of
      (Just enriched@(Fact.Row _ _ _ (Fact.Ways _ _ carried) _ _ _), Just unenriched) ->
        maybe unenriched (const enriched) <$> (readPart carried value :: Maybe (Maybe Annotation))
      _ -> case ofChannel of
        [one] -> Just one
        _ -> error "the refresh table has no single row for a channel it names"

withParent :: Parent -> IO value -> IO value
withParent parent action = bracket (attachContext (fromMaybe Context.empty parent)) detachContext (const action)

newRefresher :: Transport.EventBus -> Transport.Transport -> Bus.BusOptions -> Timing.Settings -> [(Fact.Query,Acts)] -> IO Refresher
newRefresher local wire options settings controls = mask $ \restore -> do
  when (Timing.invalidationWindowMs settings < 0) (ioError (userError "negative invalidation window"))
  let owned = Map.fromList controls
  unless (Map.size owned == length controls) (ioError (userError "duplicate live-query owner"))
  forM_ Fact.rows $ \(Fact.Row _ _ _ _ _ writes removes) -> do
    forM_ writes $ \query -> forM_ (Map.lookup query owned) $ \control ->
      when (isNothing (write control)) (ioError (userError "a refresh row writes a query its owner cannot write"))
    forM_ removes $ \query -> forM_ (Map.lookup query owned) $ \control ->
      when (isNothing (end control)) (ioError (userError "a refresh row removes a query its owner cannot end"))
  life <- Lifetime.newLifetime "live-query refresh is disposed"
  stopped <- newTVarIO False
  active <- newTVarIO Map.empty
  sequenceNumber <- newTVarIO 0
  ready <- newTQueueIO
  let runtime = Refresher life stopped active sequenceNumber ready options settings owned (pure ())
  detach <- Transport.tapLocal local (receive runtime)
  let result = runtime { release = detach }
  let begin = do
        void $ Lifetime.start life $ restore $ forever $ do
          (parent,action) <- atomically (readTQueue ready)
          outcome <- try (withParent parent action)
          case outcome of
            Right () -> pure ()
            Left (problem :: SomeException) -> case fromException problem :: Maybe SomeAsyncException of
              Just _ -> throwIO problem
              Nothing -> do
                over <- readTVarIO stopped
                unless over (Transport.reportFailure wire (TransportError Code.TransportError "live-query refresh could not start its work" Nothing Nothing))
        void $ Lifetime.start life $ restore $ State.watch (Transport.state wire) $ \states -> do
          let loop opened dropped values = do
                item <- Stream.next values
                case item of
                  Left () -> pure ()
                  Right (state,rest) -> case state of
                    Connection.Open -> do
                      when (opened && dropped) (atomically (apply result Fact.reopened Nothing nothingNamed))
                      loop True False rest
                    Connection.Closed -> pure ()
                    _ -> loop opened (dropped || opened) rest
          loop False False states
        pure result
  begin `onException` (detach `finally` Lifetime.close life)

nothingNamed :: SubjectInfo
nothingNamed = SubjectInfo Nothing Nothing Nothing Nothing

-- | A frame on one of the table's channels: its row, or, when its reading
-- refuses it or a member its row names is not what it names, the row of an
-- unreadable event.
receive :: Refresher -> Transport.Carried -> Parent -> STM ()
receive runtime carried parent = when (name `elem` Fact.channels) $ case carried of
  Transport.FrameRejected _ -> unreadable
  Transport.Arrived delivered -> do
    let raw = Object (busFramePayloadAdditionalProperties (busFramePayload (Transport.wireFrame delivered)))
    case (Required.faultChannel name raw, subject name raw) of
      (Nothing, Just info) -> apply runtime name parent info
      _ -> unreadable
  where
    name = Transport.carriedChannel carried
    unreadable = apply runtime Fact.unreadable parent nothingNamed

apply :: Refresher -> Text -> Parent -> SubjectInfo -> STM ()
apply runtime trigger parent info = do
  stopped <- readTVar (closed runtime)
  unless stopped $ do
    let candidates = [row | row@(Fact.Row on condition _ _ _ _ _) <- Fact.rows, on == trigger, condition == subjectWhen info]
    row <- case candidates of [one] -> pure one; _ -> throwSTM (userError "refresh trigger has no single matching row")
    let Fact.Row _ _ reach _ fetches writes removes = row
        immediate select query = forM_ (Map.lookup query (acts runtime)) $ \control -> do
          action <- case select control of Just value -> pure value; Nothing -> throwSTM (userError "refresh action has no implementation")
          targets <- action info
          forM_ targets $ \(Target identity mutation) -> do
            modifyTVar' (windows runtime) (Map.delete (query,identity))
            launch <- mutation
            writeTQueue (queue runtime) (parent,launch)
    mapM_ (immediate write) writes
    mapM_ (immediate end) removes
    forM_ fetches $ \query -> forM_ (Map.lookup query (acts runtime)) $ \control -> do
      targets <- refetch control info reach
      forM_ targets $ \(Target identity mutation) -> coalesce runtime (query,identity) parent mutation

coalesce :: Refresher -> (Fact.Query,Text) -> Parent -> STM (IO ()) -> STM ()
coalesce runtime key parent mutation = do
  held <- readTVar (windows runtime)
  case Map.lookup key held of
    Just (Window generation _) -> writeTVar (windows runtime) (Map.insert key (Window generation (Just (parent,mutation))) held)
    Nothing -> do
      generation <- next runtime
      writeTVar (windows runtime) (Map.insert key (Window generation Nothing) held)
      launch <- mutation
      writeTQueue (queue runtime) (parent,launch >> startTimer runtime key generation)

next :: Refresher -> STM Integer
next runtime = do
  modifyTVar' (counter runtime) (+1)
  readTVar (counter runtime)
startTimer :: Refresher -> (Fact.Query,Text) -> Integer -> IO ()
startTimer runtime key generation = do
  stopped <- readTVarIO (closed runtime)
  unless stopped $ void $ Lifetime.start (lifetime runtime) $ do
    now <- Bus.requestNow (clock runtime)
    Bus.requestWaitUntil (clock runtime) (now + Timing.invalidationWindowMs (timing runtime) * 1000000)
    atomically $ do
      over <- readTVar (closed runtime)
      held <- readTVar (windows runtime)
      unless over $ case Map.lookup key held of
        Just (Window current owed) | current == generation -> case owed of
          Nothing -> writeTVar (windows runtime) (Map.delete key held)
          Just (parent,mutation) -> do
            following <- next runtime
            writeTVar (windows runtime) (Map.insert key (Window following Nothing) held)
            launch <- mutation
            writeTQueue (queue runtime) (parent,launch >> startTimer runtime key following)
        _ -> pure ()

-- | Whether a window holds an invalidation it has not yet run (B19).
owes :: Refresher -> STM Bool
owes runtime = any (\(Window _ owed) -> isJust owed) . Map.elems <$> readTVar (windows runtime)
dispose :: Refresher -> IO ()
dispose runtime = mask_ $ do
  atomically $ do
    writeTVar (closed runtime) True
    writeTVar (windows runtime) Map.empty
    void (flushTQueue (queue runtime))
  release runtime
  Lifetime.close (lifetime runtime)

-- Select only keys held by this cache. Re-read a key at execution time so a
-- coalesced invalidation keeps the latest resource-routing hint.
cacheTargets :: Cache.Cache key value -> (SubjectInfo -> key -> Bool) -> SubjectInfo -> Fact.Reach -> STM [Target]
cacheTargets cache matches info reach = do
  keys <- Cache.keys cache
  let selected = filter (\key -> reach == Fact.Held || matches info key) keys
  pure [Target (Cache.encodeKey cache key) (do
    current <- Cache.keys cache
    case find (\candidate -> Cache.encodeKey cache candidate == Cache.encodeKey cache key) current of
      Nothing -> pure (pure ())
      Just found -> Cache.invalidateSTM cache found) | key <- selected]
writeTargets :: Cache.Cache key value -> (SubjectInfo -> key -> Bool) -> (SubjectInfo -> Maybe value -> Maybe value) -> SubjectInfo -> STM [Target]
writeTargets cache matches update info = do
  keys <- Cache.keys cache
  found <- mapM (\key -> do value <- Cache.get cache key; pure (key,update info value)) (filter (matches info) keys)
  pure [Target (Cache.encodeKey cache key) (Cache.setSTM cache key value) | (key,Just value) <- found]
updateTargets :: Cache.Cache key value -> (SubjectInfo -> key -> Bool) -> (SubjectInfo -> value -> value) -> SubjectInfo -> STM [Target]
updateTargets cache matches update info = do
  keys <- Cache.keys cache
  pure [Target (Cache.encodeKey cache key) (Cache.updateSTM cache key (update info)) | key <- keys, matches info key]

endTargets :: Cache.Cache key value -> (SubjectInfo -> key -> Bool) -> SubjectInfo -> STM [Target]
endTargets cache matches info = do
  keys <- Cache.keys cache
  pure [Target (Cache.encodeKey cache key) (Cache.removeSTM cache key
    (toException (BusRequestError Code.BusRequestNotFound "the cached entity was removed" Nothing))) | key <- keys, matches info key]
