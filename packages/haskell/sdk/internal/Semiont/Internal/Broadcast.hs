module Semiont.Internal.Broadcast
  ( Broadcast, Subscription, newEvents, newState, withSubscription, next, publish, close
  ) where

import Control.Concurrent.STM
import Control.Exception (bracket)
import Control.Monad (unless)
import qualified Data.Map.Strict as Map

data Broadcast value = Broadcast (TVar (Contents value))
data Contents value = Contents
  { nextKey :: Integer
  , readers :: Map.Map Integer (TQueue value)
  , latest :: Maybe value
  , stopped :: Bool
  }
data Subscription value = Subscription (Broadcast value) Integer (TQueue value) (TVar Bool)

newEvents :: STM (Broadcast value)
newEvents = Broadcast <$> newTVar (Contents 0 Map.empty Nothing False)

newState :: value -> STM (Broadcast value)
newState value = Broadcast <$> newTVar (Contents 0 Map.empty (Just value) False)

subscribe :: Broadcast value -> STM (Subscription value)
subscribe broadcast@(Broadcast cell) = do
  current <- readTVar cell
  queue <- newTQueue
  cancelled <- newTVar False
  let key = nextKey current
  mapM_ (writeTQueue queue) (latest current)
  unless (stopped current) $ writeTVar cell current
    { nextKey = key + 1, readers = Map.insert key queue (readers current) }
  pure (Subscription broadcast key queue cancelled)

unsubscribe :: Subscription value -> STM ()
unsubscribe (Subscription (Broadcast cell) key queue cancelled) = do
  writeTVar cancelled True
  _ <- flushTQueue queue
  modifyTVar' cell (\current -> current { readers = Map.delete key (readers current) })

withSubscription :: Broadcast value -> (Subscription value -> IO result) -> IO result
withSubscription broadcast = bracket (atomically (subscribe broadcast)) (atomically . unsubscribe)

next :: Subscription value -> STM (Maybe value)
next (Subscription (Broadcast cell) _ queue cancelled) = do
  abandoned <- readTVar cancelled
  if abandoned then pure Nothing else do
    queued <- tryReadTQueue queue
    case queued of
      Just value -> pure (Just value)
      Nothing -> do
        current <- readTVar cell
        if stopped current then pure Nothing else retry

publish :: Broadcast value -> value -> STM ()
publish (Broadcast cell) value = do
  current <- readTVar cell
  unless (stopped current) $ do
    writeTVar cell current { latest = value <$ latest current }
    mapM_ (\queue -> writeTQueue queue value) (readers current)

close :: Broadcast value -> STM ()
close (Broadcast cell) = modifyTVar' cell (\current -> current { stopped = True, readers = Map.empty })
