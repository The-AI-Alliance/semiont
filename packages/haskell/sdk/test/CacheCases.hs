{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module CacheCases (cacheCases) where

import Control.Concurrent.Async (Async, async, cancel, wait)
import Control.Concurrent.STM
import Control.Exception (SomeException, bracket, finally, fromException, throwIO, toException, try)
import Control.Monad (forM_, unless, void)
import Data.Aeson (Value, ToJSON(..), object, (.=))
import Data.IORef
import Data.Maybe (isJust)
import qualified Semiont.Cache as Cache
import qualified Semiont.Internal.Cache as Internal
import Semiont.Errors (BusRequestError(..))
import Semiont.ErrorCodes (BusRequestCode(BusRequestClosed, BusRequestNotFound))
import qualified Streaming.Prelude as Stream
import System.Timeout (timeout)
import qualified ControlledTime as Time

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

data Harness = Harness (Cache.Cache Int Int) (TQueue (Int, TMVar (Either SomeException Int))) (TVar Int)

harness :: IO Harness
harness = do
  requests <- newTQueueIO
  scopes <- newTVarIO 0
  let reader key = do
        answer <- newEmptyTMVarIO
        atomically (writeTQueue requests (key,answer))
        atomically (takeTMVar answer) >>= either throwIO pure
      options = Cache.CacheOptions (pure 0) (const (atomically retry)) 5 Nothing
        (\_ -> atomically (modifyTVar' scopes (+1)) >> pure (atomically (modifyTVar' scopes (subtract 1))))
  cache <- Cache.newCache reader options
  pure (Harness cache requests scopes)

reply :: Harness -> Int -> Either SomeException Int -> IO ()
reply (Harness _ requests _) key outcome = atomically $ do
  (actual,answer) <- readTQueue requests
  unless (key == actual) (throwSTM (userError "cache fetched the wrong key"))
  putTMVar answer outcome

failure :: SomeException
failure = toException (userError "controlled cache failure")

subscriber :: Cache.Cache Int Int -> Int -> IO (Async (), TQueue (Cache.CacheState Int))
subscriber cache key = do
  output <- newTQueueIO
  reader <- async (Cache.watch (Cache.query cache key) (Stream.mapM_ (atomically . writeTQueue output)))
  pure (reader,output)

next :: TQueue (Cache.CacheState Int) -> IO (Cache.CacheState Int)
next = atomically . readTQueue
pending :: TQueue (Cache.CacheState Int) -> IO ()
pending output = next output >>= \state -> require "expected pending cache state" (case state of Cache.Pending -> True; _ -> False)
ready :: Int -> TQueue (Cache.CacheState Int) -> IO ()
ready value output = next output >>= \state -> require "expected ready cache value" (Cache.readyValue state == Just value)
failed :: TQueue (Cache.CacheState Int) -> IO ()
failed output = next output >>= \state -> require "failure must be an emission" (case state of Cache.Failed _ -> True; _ -> False)
noRequest :: Harness -> IO ()
noRequest (Harness _ requests _) = atomically (isEmptyTQueue requests) >>= require "an inert cache act issued a fetch"
noEmission :: TQueue value -> IO ()
noEmission output = atomically (isEmptyTQueue output) >>= require "cache emitted an intermediate or duplicate state"
idle :: Cache.Cache key value -> IO ()
idle cache = atomically (Cache.persistencePending cache >>= check . not)

-- | A harness whose cache keeps its values. Each save it owes queues its
-- deadline on the timers it returns, then waits for good, so a test reads
-- which steps owed one.
keptHarness :: [(Int,Int)] -> IO (Harness, TQueue Integer)
keptHarness restored = do
  requests <- newTQueueIO
  timers <- newTQueueIO
  scopes <- newTVarIO 0
  let reader key = do
        answer <- newEmptyTMVarIO
        atomically (writeTQueue requests (key,answer))
        atomically (takeTMVar answer) >>= either throwIO pure
      persister = Cache.CachePersister (pure restored) (const (pure ())) (pure ())
      options = Cache.CacheOptions (pure 0) (\deadline -> atomically (writeTQueue timers deadline) >> atomically retry) 5
        (Just persister) (const (pure (pure ())))
  cache <- Cache.newCache reader options
  pure (Harness cache requests scopes, timers)
withKept :: [(Int,Int)] -> (Harness -> TQueue Integer -> IO ()) -> IO ()
withKept restored body = bracket (keptHarness restored) (\(Harness cache _ _,_) -> Cache.dispose cache) (uncurry body)
saveOwed :: TQueue Integer -> IO ()
saveOwed timers = Time.settle >> atomically (tryReadTQueue timers) >>= require "a cache write owed no save" . isJust
noSave :: TQueue Integer -> IO ()
noSave timers = Time.settle >> atomically (isEmptyTQueue timers) >>= require "a reply that is not stored owed a save"

queryCases :: IO ()
queryCases = bracket harness (\(Harness cache _ _) -> Cache.dispose cache) $ \h@(Harness cache _ scopes) -> do
  let view = Cache.query cache 1
  initial <- atomically (Cache.current view)
  require "B1 accessor must be pure" (case initial of Cache.Pending -> True; _ -> False)
  atomically (Cache.known cache 1) >>= require "B20 merely allocating a query cannot make a key known" . not
  noRequest h
  (a,eventsA) <- subscriber cache 1
  pending eventsA
  (b,eventsB) <- subscriber cache 1
  pending eventsB
  reply h 1 (Right 10)
  ready 10 eventsA
  ready 10 eventsB
  idle cache
  noRequest h
  (c,eventsC) <- subscriber cache 1
  ready 10 eventsC
  noRequest h
  held <- readTVarIO scopes
  require "every observer, including a cache hit, must hold its scope" (held == 3)
  Cache.invalidate cache 1
  noEmission eventsA
  reply h 1 (Right 20)
  ready 20 eventsA
  ready 20 eventsB
  ready 20 eventsC
  once <- async (Cache.fresh view)
  reply h 1 (Right 30)
  wait once >>= require "fresh must force a new read" . (==30)
  ready 30 eventsA
  ready 30 eventsB
  ready 30 eventsC
  onceFailed <- async (try (Cache.fresh view) :: IO (Either SomeException Int))
  reply h 1 (Left failure)
  wait onceFailed >>= require "fresh must surface a failed fetch" . either (const True) (const False)
  idle cache
  noRequest h
  noEmission eventsA
  require "B6 stale value lost to a failed fresh read" . (== Just 30) =<< atomically (Cache.get cache 1)
  Cache.invalidate cache 1
  reply h 1 (Left failure)
  reply h 1 (Left failure)
  idle cache
  noEmission eventsA
  Cache.remove cache 1 failure
  failed eventsA
  failed eventsB
  failed eventsC
  noRequest h
  (d,eventsD) <- subscriber cache 1
  pending eventsD
  pending eventsA
  pending eventsB
  pending eventsC
  reply h 1 (Right 40)
  forM_ [eventsA,eventsB,eventsC,eventsD] (ready 40)
  Cache.set cache 1 50
  forM_ [eventsA,eventsB,eventsC,eventsD] (ready 50)
  Cache.set cache 1 50
  noEmission eventsA
  noRequest h
  Cache.dispose cache
  mapM_ wait [a,b,c,d]
  readTVarIO scopes >>= require "scope readers leaked on disposal" . (==0)
  Cache.invalidate cache 1
  Cache.invalidate cache 2
  Cache.set cache 1 60
  Cache.remove cache 1 failure
  noRequest h
  result <- try (Cache.fresh view) :: IO (Either BusRequestError Int)
  require "fresh after dispose must fail closed" (either ((==BusRequestClosed) . busRequestErrorCode) (const False) result)
  later <- Cache.observe cache 2 (Stream.toList_ . Stream.take 2)
  require "a query first created after disposal did not terminate" (null later)

failureCases :: IO ()
failureCases = bracket harness (\(Harness cache _ _) -> Cache.dispose cache) $ \h@(Harness cache _ _) -> do
  (reader,events) <- subscriber cache 1
  pending events
  reply h 1 (Left failure)
  reply h 1 (Left failure)
  failed events
  idle cache
  noRequest h
  noEmission events
  require "B15 a failed key is known" =<< atomically (Cache.known cache 1)
  (recovering,recovered) <- subscriber cache 1
  pending recovered
  pending events
  reply h 1 (Right 7)
  ready 7 recovered
  ready 7 events
  cancel recovering
  Cache.invalidateAll cache
  reply h 1 (Right 8)
  ready 8 events
  idle cache
  cancel reader
  require "B11 unobserved settled keys must stay known" . (==[1]) =<< atomically (Cache.keys cache)

-- | A subscriber's retry (B14) is reserved in the step its first failure
-- settles in, so a caller that saw that failure finds the key still fetching.
retryHandOffCases :: IO ()
retryHandOffCases = bracket harness (\(Harness cache _ _) -> Cache.dispose cache) $ \h@(Harness cache requests _) -> do
  first <- async (try (Cache.fetch cache 1) :: IO (Either SomeException Int))
  (_,answer) <- atomically (readTQueue requests)
  (reader,events) <- subscriber cache 1
  pending events
  atomically (putTMVar answer (Left failure))
  wait first >>= require "the first ask did not fail" . either (const True) (const False)
  require "B14 the key was at rest between a failure and its retry" =<< atomically (Internal.fetching cache)
  reply h 1 (Right 5)
  ready 5 events
  idle cache
  noRequest h
  noEmission events
  cancel reader

persistenceCases :: IO ()
persistenceCases = do
  clock <- newTVarIO 0
  timers <- newTQueueIO
  saves <- newTQueueIO
  requests <- newTQueueIO
  loads <- newIORef (0::Int)
  let persister = Cache.CachePersister
        (modifyIORef' loads (+1) >> pure [(1,10),(2,20)])
        (atomically . writeTQueue saves) (pure ())
      options = Cache.CacheOptions (readTVarIO clock)
        (\deadline -> atomically (writeTQueue timers deadline) >> atomically (readTVar clock >>= check . (>=deadline)))
        5 (Just persister) (const (pure (pure ())))
      reader key = do
        answer <- newEmptyTMVarIO
        atomically (writeTQueue requests (key,answer))
        atomically (takeTMVar answer) >>= either throwIO pure
  bracket (Cache.newCache reader options) Cache.dispose $ \cache -> do
    readIORef loads >>= require "B17 persister must load exactly once" . (==1)
    require "rehydrated values must be available before subscription" . (==Just 10) =<< atomically (Cache.get cache 1)
    atomically (isEmptyTQueue saves) >>= require "rehydration must not schedule a save"
    (a,eventsA) <- subscriber cache 1
    ready 10 eventsA
    (b,eventsB) <- subscriber cache 1
    ready 10 eventsB
    h <- Harness cache requests <$> newTVarIO 0
    reply h 1 (Left failure)
    reply h 1 (Left failure)
    idle cache
    noEmission eventsA
    (c,eventsC) <- subscriber cache 1
    ready 10 eventsC
    noRequest h
    -- A failed revalidation clears the restored mark: no standing retry loop.
    Cache.set cache 1 30
    mapM_ (ready 30) [eventsA,eventsB,eventsC]
    deadline <- atomically (readTQueue timers)
    require "save timing did not use the caller's clock" (deadline == 5000000)
    require "a debounced save must block bookmark persistence" =<< atomically (Cache.persistencePending cache)
    Cache.set cache 1 40
    mapM_ (ready 40) [eventsA,eventsB,eventsC]
    void (atomically (readTQueue timers))
    atomically (writeTVar clock 5000000)
    saved <- atomically (readTQueue saves)
    require "debounce saved an obsolete snapshot" (saved == [(1,40),(2,20)])
    idle cache
    Cache.remove cache 1 failure
    mapM_ failed [eventsA,eventsB,eventsC]
    Cache.dispose cache
    flushed <- atomically (readTQueue saves)
    require "dispose must flush settled values only" (flushed == [(2,20)])
    mapM_ wait [a,b,c]
    atomically (isEmptyTQueue saves) >>= require "a delayed save ran after disposal"

failedSaveCases :: IO ()
failedSaveCases = do
  attempts <- newIORef (0::Int)
  let save _ = modifyIORef' attempts (+1) >> throwIO failure
      options = Cache.CacheOptions (pure 0) (const (atomically retry)) 5
        (Just (Cache.CachePersister (pure []) save (pure ()))) (const (pure (pure ())))
  cache <- Cache.newCache (pure :: Int -> IO Int) options
  Cache.set cache 1 9
  Cache.dispose cache
  require "failed saves may not mark persistence clean" =<< atomically (Cache.persistencePending cache)
  require "failed persistence destroyed the live value" . (==Just 9) =<< atomically (Cache.get cache 1)
  readIORef attempts >>= require "dispose did not attempt its final save" . (==1)
  Cache.dispose cache
  readIORef attempts >>= require "repeated dispose saved again" . (==1)

serialSaveCases :: IO ()
serialSaveCases = do
  started <- newTQueueIO
  writes <- newTVarIO []
  released <- newEmptyTMVarIO
  count <- newTVarIO (0::Int)
  let saving entries = do
        ordinal <- atomically $ do
          modifyTVar' count (+1)
          ordinal <- readTVar count
          writeTQueue started ordinal
          pure ordinal
        if ordinal == 1 then atomically (takeTMVar released) else pure ()
        atomically (modifyTVar' writes (++ [entries]))
      options = Cache.CacheOptions (pure 0) (const (pure ())) 0
        (Just (Cache.CachePersister (pure []) saving (pure ()))) (const (pure (pure ())))
  bracket (Cache.newCache (pure :: Int -> IO Int) options) Cache.dispose $ \cache -> do
    Cache.set cache 1 10
    atomically (readTQueue started) >>= require "first save did not start" . (==1)
    Cache.set cache 1 20
    Time.settle
    atomically (isEmptyTQueue started) >>= require "two persistence writes overlapped"
    require "an overlapping update let the bookmark lead its document" =<< atomically (Cache.persistencePending cache)
    atomically (putTMVar released ())
    atomically (readTQueue started) >>= require "latest save was lost behind an older one" . (==2)
    idle cache
    readTVarIO writes >>= require "an old save overwrote a newer document" . (==[[(1,10)],[(1,20)]])

selfCloseCases :: IO ()
selfCloseCases = do
  owner <- newEmptyTMVarIO
  let saving _ = atomically (readTMVar owner) >>= Cache.dispose
      options = Cache.CacheOptions (pure 0) (const (atomically retry)) 5
        (Just (Cache.CachePersister (pure []) saving (pure ()))) (const (pure (pure ())))
  cache <- Cache.newCache (pure :: Int -> IO Int) options
  atomically (putTMVar owner cache)
  Cache.set cache 1 1
  Cache.dispose cache
  idle cache

cancellationCases :: IO ()
cancellationCases = do
  entered <- newEmptyTMVarIO
  cleanup <- newEmptyTMVarIO
  released <- newEmptyTMVarIO
  let reader (_::Int) = (atomically (putTMVar entered ()) >> atomically retry)
        `finally` (atomically (putTMVar cleanup ()) >> atomically (takeTMVar released))
      options = Cache.CacheOptions (pure 0) (const (atomically retry)) 5 Nothing (const (pure (pure ())))
  cache <- Cache.newCache reader options :: IO (Cache.Cache Int Int)
  (observer,events) <- subscriber cache 1
  pending events
  atomically (takeTMVar entered)
  closer <- async (Cache.dispose cache)
  atomically (takeTMVar cleanup)
  cancel closer
  atomically (putTMVar released ())
  Cache.dispose cache
  wait observer
  idle cache
  result <- try (Cache.fetch cache 1) :: IO (Either BusRequestError Int)
  require "cancelled dispose waiter abandoned cleanup" (either ((==BusRequestClosed) . busRequestErrorCode) (const False) result)

structuralKeyCases :: IO ()
structuralKeyCases = do
  count <- newIORef (0::Int)
  let options = Cache.CacheOptions (pure 0) (const (atomically retry)) 5 Nothing (const (pure (pure ())))
      reader (_::Value) = modifyIORef' count (+1) >> pure (1::Int)
  bracket (Cache.newCache reader options) Cache.dispose $ \cache -> do
    let first = object ["a" .= (1::Int), "b" .= object ["c" .= (2::Int)]]
        second = object ["b" .= object ["c" .= (2.0::Double)], "a" .= (1.0::Double)]
    Cache.set cache first 8
    found <- atomically (Cache.get cache second)
    require "equivalent JSON keys did not share an entry" (found == Just 8)
    readIORef count >>= require "writing an equivalent structural key fetched" . (==0)

type Answer = TMVar (Either SomeException Int)

-- | F0 asked by a read and joined by an observer, then F1 asked by an
-- invalidation in its place (B9).
withReplaced :: (Cache.Cache Int Int -> TQueue Integer -> TQueue (Cache.CacheState Int) -> Async Int -> Answer -> Answer -> IO ()) -> IO ()
withReplaced body = withKept [] $ \h@(Harness cache requests _) timers -> do
  older <- async (Cache.fetch cache 1)
  (_,f0) <- atomically (readTQueue requests)
  (reader,events) <- subscriber cache 1
  pending events
  Cache.invalidate cache 1
  (_,f1) <- atomically (readTQueue requests)
  body cache timers events older f0 f1
  noRequest h
  cancel reader

-- | Only a key's current fetch writes (B9): one an invalidation replaced or a
-- removal let go of answers its own read, and stores, emits and owes nothing.
newestWritesCases :: IO ()
newestWritesCases = do
  withReplaced $ \cache timers events older f0 f1 -> do
    atomically (putTMVar f1 (Right 1))
    ready 1 events
    saveOwed timers
    atomically (putTMVar f0 (Right 0))
    wait older >>= require "B9 a replaced fetch did not answer its own read" . (==0)
    noSave timers
    noEmission events
    atomically (Cache.get cache 1) >>= require "B9 a replaced fetch's later reply was stored" . (==Just 1)
  withReplaced $ \cache timers events older f0 f1 -> do
    atomically (putTMVar f0 (Right 0))
    wait older >>= require "B9 a replaced fetch did not answer its own read" . (==0)
    noSave timers
    noEmission events
    state <- atomically (Cache.current (Cache.query cache 1))
    require "B9 a replaced fetch's earlier reply moved its key" (case state of Cache.Pending -> True; _ -> False)
    atomically (putTMVar f1 (Right 1))
    ready 1 events
    atomically (Cache.get cache 1) >>= require "B9 the current fetch's reply was not stored" . (==Just 1)
  withReplaced $ \cache _ events _ f0 f1 -> do
    require "B17 a key read at rest while its current fetch was unanswered" =<< atomically (Internal.fetching cache)
    atomically (putTMVar f1 (Right 1))
    ready 1 events
    require "B17 a replaced fetch still counted as fetching" . not =<< atomically (Internal.fetching cache)
    atomically (putTMVar f0 (Right 0))
  withKept [] $ \h@(Harness cache requests _) timers -> do
    older <- async (Cache.fetch cache 1)
    (_,f0) <- atomically (readTQueue requests)
    (reader,events) <- subscriber cache 1
    pending events
    Cache.remove cache 1 (toException (BusRequestError BusRequestNotFound "the key was removed" Nothing))
    failed events
    saveOwed timers
    atomically (putTMVar f0 (Right 0))
    wait older >>= require "B13a a fetch a removal let go of did not answer its own read" . (==0)
    noSave timers
    noEmission events
    state <- atomically (Cache.current (Cache.query cache 1))
    require "B13a a let-go fetch's reply undid the removal" (case state of
      Cache.Failed problem -> fmap busRequestErrorCode (fromException problem) == Just BusRequestNotFound
      _ -> False)
    noRequest h
    cancel reader
  withKept [] $ \h@(Harness cache _ _) timers -> do
    (reader,events) <- subscriber cache 1
    pending events
    Cache.set cache 1 5
    ready 5 events
    saveOwed timers
    reply h 1 (Left failure)
    noSave timers
    noEmission events
    noRequest h
    atomically (Cache.get cache 1) >>= require "B14 a let-go fetch's failure moved its key" . (==Just 5)
    cancel reader

-- | A whole write lets go of the fetch in flight; a patch rides on it (B13b).
writePatchCases :: IO ()
writePatchCases = do
  withKept [] $ \h@(Harness cache requests _) timers -> do
    older <- async (Cache.fetch cache 1)
    (_,f0) <- atomically (readTQueue requests)
    (reader,events) <- subscriber cache 1
    pending events
    Cache.set cache 1 5
    ready 5 events
    saveOwed timers
    require "B13b a set left its key fetching" . not =<< atomically (Internal.fetching cache)
    atomically (putTMVar f0 (Right 0))
    wait older >>= require "B13b a fetch a set let go of did not answer its own read" . (==0)
    noSave timers
    noEmission events
    atomically (Cache.get cache 1) >>= require "B13b a let-go fetch's reply overwrote a set" . (==Just 5)
    noRequest h
    cancel reader
  withKept [] $ \h@(Harness cache requests _) timers -> do
    first <- async (Cache.fetch cache 1)
    (_,f0) <- atomically (readTQueue requests)
    (reader,events) <- subscriber cache 1
    pending events
    Cache.patch cache 1 (*10)
    noSave timers
    noEmission events
    atomically (putTMVar f0 (Right 3))
    wait first >>= require "B13b a first fetch's read did not get the patch kept with it" . (==30)
    ready 30 events
    noRequest h
    cancel reader
  withKept [] $ \h@(Harness cache _ _) _ -> do
    Cache.set cache 1 1
    (reader,events) <- subscriber cache 1
    ready 1 events
    Cache.invalidate cache 1
    Cache.patch cache 1 (+10)
    ready 11 events
    Cache.patch cache 1 (*2)
    ready 22 events
    reply h 1 (Right 5)
    ready 30 events
    noRequest h
    cancel reader
  withKept [] $ \h@(Harness cache requests _) _ -> do
    Cache.set cache 1 1
    (reader,events) <- subscriber cache 1
    ready 1 events
    Cache.invalidate cache 1
    (_,f0) <- atomically (readTQueue requests)
    Cache.patch cache 1 (+10)
    ready 11 events
    Cache.invalidate cache 1
    (_,f1) <- atomically (readTQueue requests)
    atomically (putTMVar f1 (Right 5))
    ready 5 events
    atomically (putTMVar f0 (Right 7))
    Time.settle
    noEmission events
    atomically (Cache.get cache 1) >>= require "B13b a replaced fetch's reply or patch reached the key" . (==Just 5)
    noRequest h
    cancel reader
  withKept [] $ \h@(Harness cache _ _) timers -> do
    Cache.patch cache 1 (+1)
    noSave timers
    atomically (Cache.known cache 1) >>= require "B13b a patch made an unheld key known" . not
    atomically (Cache.get cache 1) >>= require "B13b a patch gave an unheld key a value" . (==Nothing)
    noRequest h
  withKept [(1,1)] $ \h@(Harness cache requests _) timers -> do
    Cache.patch cache 1 (+10)
    atomically (Cache.get cache 1) >>= require "B13b a patch was not applied to a restored value" . (==Just 11)
    saveOwed timers
    (reader,events) <- subscriber cache 1
    ready 11 events
    Time.settle
    atomically (isEmptyTQueue requests) >>= require "B18 a patch cleared a restored value's mark" . not
    reply h 1 (Right 2)
    ready 2 events
    cancel reader

cacheCases :: IO ()
cacheCases = do
  result <- timeout 15000000 $ do
    queryCases
    failureCases
    retryHandOffCases
    newestWritesCases
    writePatchCases
    persistenceCases
    failedSaveCases
    serialSaveCases
    selfCloseCases
    cancellationCases
    structuralKeyCases
    routingKeyCases
    atomicMutationCases
    projectedQueryCases
  require "cache contract exceeded its liveness guard" (result == Just ())
  putStrLn "PASS cache B1-B18/B20: lazy reads, deduplication, retry emissions, generation fences, scoped observers, persistence and joined disposal"

data RoutedKey = RoutedKey Int Int deriving (Eq, Show)
instance ToJSON RoutedKey where toJSON (RoutedKey identity _) = toJSON identity

routingKeyCases :: IO ()
routingKeyCases = do
  let options = Cache.CacheOptions (pure 0) (const (atomically retry)) 5 Nothing (const (pure (pure ())))
      reader (RoutedKey _ route) = pure route
  bracket (Cache.newCache reader options) Cache.dispose $ \cache -> do
    let old = Cache.query cache (RoutedKey 1 10)
        latest = Cache.query cache (RoutedKey 1 20)
    Cache.fresh old >>= require "cache ignored the original routing hint" . (==10)
    Cache.fresh latest >>= require "a canonical key retained an obsolete routing hint" . (==20)
    atomically (Cache.current old) >>= require "canonical keys did not share state" . ((==Just 20) . Cache.readyValue)
    atomically (Cache.keys cache) >>= require "reading an old query changed the current routing hint" . (==[RoutedKey 1 20])
    Cache.dispose cache
    refused <- try (Cache.fresh old) :: IO (Either BusRequestError Int)
    require "closed routed cache did not refuse a read" (either ((==BusRequestClosed) . busRequestErrorCode) (const False) refused)
    atomically (Cache.current (Cache.query cache (RoutedKey 2 30))) >>= require "closed key acquired a value" . (not . Cache.isReady)
    atomically (Cache.keys cache) >>= require "disposed acts changed stored routing metadata" . (==[RoutedKey 1 20])

atomicMutationCases :: IO ()
atomicMutationCases = bracket harness (\(Harness cache _ _) -> Cache.dispose cache) $ \h@(Harness cache _ _) -> do
  Cache.set cache 1 10
  launch <- atomically (Internal.invalidateSTM cache 1)
  require "frame delivery did not reserve its invalidation atomically" =<< atomically (Cache.persistencePending cache)
  noRequest h
  require "atomic invalidation erased its stale value" . (==Just 10) =<< atomically (Cache.get cache 1)
  launch
  reply h 1 (Right 20)
  idle cache
  require "reserved invalidation never applied its answer" . (==Just 20) =<< atomically (Cache.get cache 1)
  saving <- atomically (Internal.setSTM cache 1 30)
  require "write-through did not commit with its frame" . (==Just 30) =<< atomically (Cache.get cache 1)
  saving
  ending <- atomically (Internal.removeSTM cache 1 failure)
  state <- atomically (Cache.current (Cache.query cache 1))
  require "removal did not commit with its frame" (case state of Cache.Failed _ -> True; _ -> False)
  ending
  noRequest h


projectedQueryCases :: IO ()
projectedQueryCases = bracket harness (\(Harness cache _ _) -> Cache.dispose cache) $ \h@(Harness cache _ _) -> do
  Cache.set cache 1 10
  Cache.set cache 2 20
  let combine (Cache.Ready a) (Cache.Ready b) = Cache.Ready (a+b)
      combine (Cache.Failed problem) _ = Cache.Failed problem
      combine _ (Cache.Failed problem) = Cache.Failed problem
      combine _ _ = Cache.Pending
      joined = Internal.liftQuery2 combine (+) (Cache.query cache 1) ((+1) <$> Cache.query cache 2)
  atomically (Cache.current joined) >>= require "query projection lost its value" . ((==Just 31) . Cache.readyValue)
  notices <- newTQueueIO
  reader <- async (Cache.watch joined (Stream.mapM_ (atomically . writeTQueue notices)))
  ready 31 notices
  noRequest h
  Cache.set cache 2 21
  ready 32 notices
  Cache.set cache 2 21
  Time.settle
  atomically (isEmptyTQueue notices) >>= require "joined query emitted an equal value"
  Cache.dispose cache
  wait reader


