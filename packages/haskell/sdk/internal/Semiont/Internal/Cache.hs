{-# LANGUAGE OverloadedStrings, RankNTypes, ScopedTypeVariables #-}
module Semiont.Internal.Cache
  ( Cache, Query, CacheState(..), CacheOptions(..), CachePersister(..)
  , newCache, query, current, watch, fresh, observe, fetch, get, known, keys
  , invalidate, invalidateAll, remove, set, persistencePending, dispose
  , isReady, readyValue, invalidateSTM, setSTM, removeSTM, updateSTM, encodeKey, liftQuery2
  ) where

import Control.Concurrent (myThreadId)
import Control.Concurrent.Async (Async, async, asyncThreadId, wait)
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception (SomeException, bracket, mask, throwIO, toException, try)
import Control.Monad (forM_, unless, void, when)
import Data.Aeson (ToJSON, Value(..), encode, toJSON)
import qualified Data.Aeson.KeyMap as KeyMap
import Data.Foldable (toList)
import Data.List (sortOn)
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import Data.Scientific (normalize)
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError(..))
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.StateValue as State
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream
import OpenTelemetry.Context.ThreadLocal.Propagation (tracedWithAsync)

data CacheState value = Pending | Ready value | Failed SomeException deriving Show
instance Functor CacheState where
  fmap _ Pending = Pending
  fmap transform (Ready value) = Ready (transform value)
  fmap _ (Failed problem) = Failed problem
data CachePersister key value = CachePersister
  { load :: IO [(key,value)]
  , save :: [(key,value)] -> IO ()
  }
data CacheOptions key value = CacheOptions
  { cacheNow :: IO Integer
  , cacheWaitUntil :: Integer -> IO ()
  , cacheSaveDebounceMs :: Integer
  , cachePersister :: Maybe (CachePersister key value)
  , cacheScope :: key -> IO (IO ())
  }
data Task value = Task Integer (TMVar (Either SomeException value))
data Entry key value = Entry (TVar key) (State.StateValue (CacheState value)) (TVar (Maybe (Task value))) (TVar Integer) (TVar Bool) (TVar (Maybe Integer)) (TVar [value -> value])
data Cache key value = Cache
  { entries :: TVar (Map.Map Text (Entry key value))
  , configuration :: CacheOptions key value
  , fetchValue :: key -> IO value
  , encodeKey :: key -> Text
  , equalValue :: value -> value -> Bool
  , lifetime :: Lifetime.Lifetime
  , dirty :: TVar Bool
  , saveVersion :: TVar Integer
  , persistenceLock :: MVar ()
  , disposed :: TVar Bool
  , closing :: MVar (Maybe (Async ()))
  }
data Query value = Query (STM (CacheState value))
  (forall result. (Stream (Of (CacheState value)) IO () -> IO result) -> IO result)
  (IO value)

instance Functor Query where
  fmap transform (Query projection consume readFresh) = Query
    (fmap transform <$> projection)
    (\reader -> consume (reader . Stream.map (fmap transform)))
    (transform <$> readFresh)

-- Both scoped watches register before their producers run. Their initial
-- notices, rather than later snapshots, seed the combined observation.
liftQuery2 :: Eq result => (CacheState left -> CacheState right -> CacheState result)
  -> (left -> right -> result) -> Query left -> Query right -> Query result
liftQuery2 combine values left right = Query
  (combine <$> current left <*> current right)
  (\consume -> watch left $ \leftStream -> watch right $ \rightStream -> do
    a <- Stream.next leftStream
    b <- Stream.next rightStream
    case (a,b) of
      (Right (firstLeft,leftRest),Right (firstRight,rightRest)) -> do
        state <- atomically (State.newStateValue (combine firstLeft firstRight))
        latest <- newTVarIO (firstLeft,firstRight)
        ended <- newTVarIO (False,False)
        let accept side = atomically $ do
              (x,y) <- readTVar latest
              let next = case side of Left update -> (update,y); Right update -> (x,update)
              writeTVar latest next
              prior <- State.current state
              let result=uncurry combine next
              case (prior,result) of
                (Pending,Pending) -> pure ()
                (Ready old,Ready new) | old==new -> pure ()
                _ -> State.update state result
            finish isLeft = atomically $ do
              (x,y) <- readTVar ended
              let next=if isLeft then (True,y) else (x,True)
              writeTVar ended next
              when (next==(True,True)) (State.complete state)
            pump side isLeft stream = Stream.mapM_ (accept . side) stream >> finish isLeft
        State.watch state $ \combined ->
          tracedWithAsync (pump Left True leftRest) $ \_ ->
            tracedWithAsync (pump Right False rightRest) $ \_ -> consume combined
      _ -> consume (pure ()))
  (do a <- fresh left; b <- fresh right; pure (values a b))

closed :: BusRequestError
closed = BusRequestError Code.BusRequestClosed "cache is disposed" Nothing

canonical :: Value -> Lazy.ByteString
canonical (Object fields) = "{" <> Lazy.intercalate ","
  [encode key <> ":" <> canonical value | (key,value) <- sortOn fst (KeyMap.toList fields)] <> "}"
canonical (Array values) = "[" <> Lazy.intercalate "," (map canonical (toList values)) <> "]"
canonical (Number value) = encode (Number (normalize value))
canonical value = encode value

newEntry :: key -> CacheState value -> Bool -> STM (Entry key value)
newEntry key value restored = Entry <$> newTVar key <*> State.newStateValue value <*> newTVar Nothing <*> newTVar 0 <*> newTVar restored <*> newTVar Nothing <*> newTVar []

newCache :: (ToJSON key, Eq value) => (key -> IO value) -> CacheOptions key value -> IO (Cache key value)
newCache reader options = do
  when (cacheSaveDebounceMs options < 0) (ioError (userError "negative cache save debounce"))
  initial <- maybe (pure []) load (cachePersister options)
  let render = decodeUtf8 . Lazy.toStrict . canonical . toJSON
  restored <- atomically $ Map.fromList <$> traverse (\(key,value) -> (,) (render key) <$> newEntry key (Ready value) True) initial
  Cache <$> newTVarIO restored <*> pure options <*> pure reader <*> pure render <*> pure (==)
    <*> Lifetime.newLifetime "cache is disposed" <*> newTVarIO False <*> newTVarIO 0 <*> newMVar () <*> newTVarIO False <*> newMVar Nothing

entry :: Cache key value -> key -> STM (Entry key value)
entry cache key = do
  values <- readTVar (entries cache)
  case Map.lookup (encodeKey cache key) values of
    Just value -> pure value
    Nothing -> do
      value@(Entry _ state _ _ _ _ _) <- newEntry key Pending False
      over <- readTVar (disposed cache)
      if over then State.complete state else writeTVar (entries cache) (Map.insert (encodeKey cache key) value values)
      pure value

selectEntry :: Cache key value -> key -> STM (Entry key value)
selectEntry cache key = do
  target@(Entry heldKey _ _ _ _ _ _) <- entry cache key
  over <- readTVar (disposed cache)
  unless over (writeTVar heldKey key)
  pure target

query :: Cache key value -> key -> Query value
query cache key = Query projection (observe cache key) (fetch cache key)
  where projection = entry cache key >>= \(Entry _ state _ _ _ _ _) -> State.current state
current :: Query value -> STM (CacheState value)
current (Query projection _ _) = projection
watch :: Query value -> (Stream (Of (CacheState value)) IO () -> IO result) -> IO result
watch (Query _ consume _) = consume
fresh :: Query value -> IO value
fresh (Query _ _ readFresh) = readFresh
isReady :: CacheState value -> Bool
isReady (Ready _) = True
isReady _ = False
readyValue :: CacheState value -> Maybe value
readyValue (Ready value) = Just value
readyValue _ = Nothing

publish :: Cache key value -> State.StateValue (CacheState value) -> CacheState value -> STM ()
publish cache state next = do
  prior <- State.current state
  case (prior,next) of
    (Pending,Pending) -> pure ()
    (Ready old,Ready value) | equalValue cache old value -> pure ()
    _ -> State.update state next

-- Reservation, publication and persistence dirtiness share the same STM boundary.
reserve :: Cache key value -> Entry key value -> Bool -> STM (Maybe (Task value, Bool))
reserve cache (Entry _ state active version restored _ patches) force = do
  over <- readTVar (disposed cache)
  running <- readTVar active
  prior <- State.current state
  stale <- readTVar restored
  if over || (not force && isReady prior && not stale && maybe True (const False) running)
    then pure Nothing else do
      writeTVar restored False
      case running of
        Just task -> pure (Just (task,False))
        Nothing -> do
          next <- (+1) <$> readTVar version
          writeTVar version next
          writeTVar patches []
          result <- newEmptyTMVar
          let task = Task next result
          writeTVar active (Just task)
          case prior of Failed _ -> publish cache state Pending; _ -> pure ()
          pure (Just (task,True))

startOwned :: Cache key value -> IO () -> IO ()
startOwned cache work = do
  outcome <- try (Lifetime.start (lifetime cache) work)
  case outcome of
    Right _ -> pure ()
    Left (failure :: SomeException) -> do
      over <- readTVarIO (disposed cache)
      unless over (throwIO failure)

launchFetch :: Cache key value -> Entry key value -> (Task value, Bool) -> IO ()
launchFetch cache (Entry keyCell state active version _ _ patches) (Task epoch result,owned) = when owned $
  startOwned cache $ do
    key <- readTVarIO keyCell
    outcome <- try (fetchValue cache key)
    saving <- atomically $ do
      currentVersion <- readTVar version
      over <- readTVar (disposed cache)
      transforms <- readTVar patches
      let final = if over || currentVersion /= epoch then outcome else fmap (\value -> foldl (flip ($)) value transforms) outcome
      void (tryPutTMVar result final)
      if over || currentVersion /= epoch then pure Nothing else do
        writeTVar active Nothing
        writeTVar patches []
        case final of
          Left (_ :: SomeException) -> pure Nothing
          Right value -> do
            publish cache state (Ready value)
            markDirty cache
    mapM_ (saveLater cache) saving

awaitTask :: Cache key value -> Task value -> IO value
awaitTask cache (Task _ result) = do
  outcome <- atomically $ do
    over <- readTVar (disposed cache)
    if over then pure (Left (toException closed)) else readTMVar result
  either throwIO pure outcome

fetch :: Cache key value -> key -> IO value
fetch cache key = mask $ \restore -> do
  (target,planned) <- atomically $ do
    target <- selectEntry cache key
    planned <- reserve cache target True
    pure (target,planned)
  case planned of
    Nothing -> throwIO closed
    Just plan@(task,_) -> launchFetch cache target plan >> restore (awaitTask cache task)

-- Exactly one SWR driver owns a task's bounded retry, including when fresh()
-- started that task and a subscriber joined it.
reserveBackground :: Cache key value -> Entry key value -> Bool -> STM (Maybe (Task value, Bool, Bool))
reserveBackground cache target@(Entry _ _ _ _ _ driver _) force = do
  planned <- reserve cache target force
  case planned of
    Nothing -> pure Nothing
    Just (task@(Task epoch _),owned) -> do
      prior <- readTVar driver
      writeTVar driver (Just epoch)
      pure (Just (task,owned,prior /= Just epoch))

launchBackground :: Cache key value -> Entry key value -> Maybe (Task value, Bool, Bool) -> IO ()
launchBackground cache target@(Entry _ state _ version _ driver _) planned = forM_ planned $ \(first@(Task epoch _),owned,drive) -> do
  launchFetch cache target (first,owned)
  when drive $ startOwned cache $ do
    initial <- try (awaitTask cache first)
    case initial of
      Right _ -> pure ()
      Left (_ :: SomeException) -> do
        retried <- atomically $ do
          over <- readTVar (disposed cache)
          currentVersion <- readTVar version
          if over || currentVersion /= epoch then pure Nothing else do
            retryPlan <- reserve cache target True
            forM_ retryPlan $ \(Task next _,_) -> writeTVar driver (Just next)
            pure retryPlan
        forM_ retried $ \plan@(task@(Task next _),_) -> do
          launchFetch cache target plan
          outcome <- try (awaitTask cache task)
          case outcome of
            Right _ -> pure ()
            Left (failure :: SomeException) -> atomically $ do
              over <- readTVar (disposed cache)
              currentVersion <- readTVar version
              unless (over || currentVersion /= next) $ do
                prior <- State.current state
                case prior of Ready _ -> pure (); _ -> publish cache state (Failed failure)

observe :: Cache key value -> key -> (Stream (Of (CacheState value)) IO () -> IO result) -> IO result
observe cache key consume = mask $ \restore -> do
  over <- readTVarIO (disposed cache)
  if over then restore (consume (pure ())) else
    bracket (cacheScope (configuration cache) key) id $ \_ -> do
      (target@(Entry _ state _ _ _ _ _),planned) <- atomically $ do
        target <- selectEntry cache key
        planned <- reserveBackground cache target False
        pure (target,planned)
      State.watch state $ \values -> do
        launchBackground cache target planned
        restore (consume values)

get :: Cache key value -> key -> STM (Maybe value)
get cache key = do
  values <- readTVar (entries cache)
  case Map.lookup (encodeKey cache key) values of
    Nothing -> pure Nothing
    Just (Entry _ state _ _ _ _ _) -> readyValue <$> State.current state
knownEntry :: Entry key value -> STM Bool
knownEntry (Entry _ state active _ _ _ _) = do
  value <- State.current state
  running <- readTVar active
  pure (case value of Pending -> maybe False (const True) running; _ -> True)
known :: Cache key value -> key -> STM Bool
known cache key = readTVar (entries cache) >>= maybe (pure False) knownEntry . Map.lookup (encodeKey cache key)
keys :: Cache key value -> STM [key]
keys cache = do
  values <- Map.elems <$> readTVar (entries cache)
  found <- traverse (\value@(Entry keyCell _ _ _ _ _ _) -> do kept <- knownEntry value; key <- readTVar keyCell; pure [key | kept]) values
  pure (concat found)

invalidate :: Cache key value -> key -> IO ()
invalidate cache key = mask $ \_ -> atomically (invalidateSTM cache key) >>= id

-- Reserve the work in the same transaction that applies an incoming frame.
-- A resumption bookmark then sees the content as pending before it can flush.
invalidateSTM :: Cache key value -> key -> STM (IO ())
invalidateSTM cache key = do
  over <- readTVar (disposed cache)
  if over then pure (pure ()) else do
    target@(Entry _ _ active version _ driver patches) <- selectEntry cache key
    modifyTVar' version (+1)
    writeTVar active Nothing
    writeTVar patches []
    writeTVar driver Nothing
    next <- reserveBackground cache target True
    pure (launchBackground cache target next)
invalidateAll :: Cache key value -> IO ()
invalidateAll cache = atomically (keys cache) >>= mapM_ (invalidate cache)

replaceSTM :: Cache key value -> key -> CacheState value -> STM (IO ())
replaceSTM cache key value = do
  over <- readTVar (disposed cache)
  if over then pure (pure ()) else do
    Entry _ state active version restored driver patches <- selectEntry cache key
    modifyTVar' version (+1)
    writeTVar active Nothing
    writeTVar restored False
    writeTVar patches []
    writeTVar driver Nothing
    publish cache state value
    saving <- markDirty cache
    pure (mapM_ (saveLater cache) saving)
-- Retain a known event's patch while the first complete snapshot is in flight.
-- No partial list is published or persisted as if it were a complete value.
updateSTM :: Cache key value -> key -> (value -> value) -> STM (IO ())
updateSTM cache key transform = do
  over <- readTVar (disposed cache)
  if over then pure (pure ()) else do
    Entry _ state active _ _ _ patches <- selectEntry cache key
    value <- State.current state
    case value of
      Ready prior -> replaceSTM cache key (Ready (transform prior))
      Pending -> do
        running <- readTVar active
        forM_ running (\_ -> modifyTVar' patches (++[transform]))
        pure (pure ())
      Failed _ -> pure (pure ())

setSTM :: Cache key value -> key -> value -> STM (IO ())
setSTM cache key = replaceSTM cache key . Ready
removeSTM :: Cache key value -> key -> SomeException -> STM (IO ())
removeSTM cache key = replaceSTM cache key . Failed
set :: Cache key value -> key -> value -> IO ()
set cache key value = mask $ \_ -> atomically (setSTM cache key value) >>= id
remove :: Cache key value -> key -> SomeException -> IO ()
remove cache key value = mask $ \_ -> atomically (removeSTM cache key value) >>= id

snapshot :: Cache key value -> STM [(key,value)]
snapshot cache = do
  values <- Map.elems <$> readTVar (entries cache)
  concat <$> traverse (\(Entry keyCell state _ _ _ _ _) -> do key <- readTVar keyCell; value <- State.current state; pure [(key,item) | Just item <- [readyValue value]]) values

markDirty :: Cache key value -> STM (Maybe Integer)
markDirty cache = case cachePersister (configuration cache) of
  Nothing -> pure Nothing
  Just _ -> do
    writeTVar (dirty cache) True
    modifyTVar' (saveVersion cache) (+1)
    Just <$> readTVar (saveVersion cache)

saveLater :: Cache key value -> Integer -> IO ()
saveLater cache epoch = forM_ (cachePersister (configuration cache)) $ \persister -> do
  now <- cacheNow (configuration cache)
  startOwned cache $ do
    cacheWaitUntil (configuration cache) (now + cacheSaveDebounceMs (configuration cache) * 1000000)
    eligible <- atomically $ do
      version <- readTVar (saveVersion cache)
      over <- readTVar (disposed cache)
      pure (not over && epoch == version)
    when eligible (persist cache persister epoch)

persist :: Cache key value -> CachePersister key value -> Integer -> IO ()
persist cache persister epoch = withMVar (persistenceLock cache) $ \_ -> do
  planned <- atomically $ do
    version <- readTVar (saveVersion cache)
    if version /= epoch then pure Nothing else Just <$> snapshot cache
  forM_ planned $ \values -> do
    outcome <- try (save persister values)
    case outcome of
      Left (_ :: SomeException) -> pure ()
      Right () -> atomically $ do
        version <- readTVar (saveVersion cache)
        when (version == epoch) (writeTVar (dirty cache) False)

persistencePending :: Cache key value -> STM Bool
persistencePending cache = do
  unsaved <- readTVar (dirty cache)
  values <- Map.elems <$> readTVar (entries cache)
  running <- or <$> traverse (\(Entry _ _ active _ _ _ _) -> maybe False (const True) <$> readTVar active) values
  pure (unsaved || running)

dispose :: Cache key value -> IO ()
dispose cache = mask $ \restore -> do
  closer <- modifyMVar (closing cache) $ \prior -> case prior of
    Just worker -> pure (prior,worker)
    Nothing -> do
      atomically $ do
        writeTVar (disposed cache) True
        readTVar (entries cache) >>= mapM_ (\(Entry _ state active version _ _ patches) -> do
          writeTVar active Nothing
          writeTVar patches []
          modifyTVar' version (+1)
          State.complete state) . Map.elems
      worker <- async $ do
        Lifetime.close (lifetime cache)
        forM_ (cachePersister (configuration cache)) $ \persister -> do
          pending <- readTVarIO (dirty cache)
          when pending (readTVarIO (saveVersion cache) >>= persist cache persister)
      pure (Just worker,worker)
  caller <- myThreadId
  unless (caller == asyncThreadId closer) (restore (wait closer))
