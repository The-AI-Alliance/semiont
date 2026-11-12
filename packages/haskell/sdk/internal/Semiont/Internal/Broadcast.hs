module Semiont.Internal.Broadcast
  ( Broadcast, Subscription, newEvents, newKeptEvents, newState, withSubscription, next, relay, publish, close
  ) where

import Control.Concurrent.STM
import Control.Exception (bracket)
import Control.Monad (unless)
import qualified Data.Map.Strict as Map
import Data.Sequence (Seq, (|>))
import qualified Data.Sequence as Seq
import Semiont.Timing (errorsKeptForFirstReaderCount)

data Broadcast value = Broadcast (TVar (Contents value))
data Contents value = Contents
  { nextKey :: Integer
  , readers :: Map.Map Integer (value -> STM ())
  -- ^ How each reader takes what is published: into its subscription's
  -- queue, or, for a relay, on within the transaction that publishes it.
  , latest :: !(Maybe value)
  , unread :: !(Unread value)
  -- ^ Both strict, as the parts of 'Unread' are: what a publication replaces
  -- or drops is let go as it is published, and not held by what replaced it.
  , stopped :: Bool
  }
-- | What is kept for the first reader while none has subscribed: the latest
-- published, oldest first, at most the count; nothing once one has or the
-- broadcast has closed, and nothing ever for events that keep nothing for one.
data Unread value = Keeping !Int !(Seq value) | Unkept
data Subscription value = Subscription (Broadcast value) Integer (TQueue value) (TVar Bool)

newEvents :: STM (Broadcast value)
newEvents = Broadcast <$> newTVar (Contents 0 Map.empty Nothing Unkept False)

-- | Events where the latest 'errorsKeptForFirstReaderCount' values published
-- before anyone subscribes reach the first subscriber, in the order
-- published: one more drops the oldest. What is still kept when they close
-- is dropped.
newKeptEvents :: STM (Broadcast value)
newKeptEvents = Broadcast <$> newTVar (Contents 0 Map.empty Nothing (Keeping (fromInteger errorsKeptForFirstReaderCount) Seq.empty) False)

newState :: value -> STM (Broadcast value)
newState value = Broadcast <$> newTVar (Contents 0 Map.empty (Just value) Unkept False)

-- | A new reader, handed by @hand@ what a reader is given first and, unless
-- the broadcast has stopped, each value published from now on.
admit :: Broadcast value -> (value -> STM ()) -> STM Integer
admit (Broadcast cell) hand = do
  current <- readTVar cell
  let key = nextKey current
  mapM_ hand (latest current)
  case unread current of Keeping _ kept -> mapM_ hand kept; Unkept -> pure ()
  writeTVar cell current { unread = Unkept }
  unless (stopped current) $ modifyTVar' cell (\held -> held
    { nextKey = key + 1, readers = Map.insert key hand (readers held) })
  pure key

leave :: Broadcast value -> Integer -> STM ()
leave (Broadcast cell) key = modifyTVar' cell (\current -> current { readers = Map.delete key (readers current) })

subscribe :: Broadcast value -> STM (Subscription value)
subscribe broadcast = do
  queue <- newTQueue
  cancelled <- newTVar False
  key <- admit broadcast (writeTQueue queue)
  pure (Subscription broadcast key queue cancelled)

unsubscribe :: Subscription value -> STM ()
unsubscribe (Subscription broadcast key queue cancelled) = do
  writeTVar cancelled True
  _ <- flushTQueue queue
  leave broadcast key

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

-- | Hands @hand@ what a new subscriber is given, and then each value
-- published, within the transaction that publishes it: before whoever
-- published it goes on. It ends when the broadcast closes, or when the
-- returned transaction stops it.
relay :: Broadcast value -> (value -> STM ()) -> STM (STM ())
relay broadcast hand = leave broadcast <$> admit broadcast hand

publish :: Broadcast value -> value -> STM ()
publish (Broadcast cell) value = do
  current <- readTVar cell
  unless (stopped current) $ do
    writeTVar cell current { latest = replacing value (latest current), unread = keep value (unread current) }
    mapM_ ($ value) (readers current)

-- | @value@ in place of the latest, for broadcasts that keep one.
replacing :: value -> Maybe value -> Maybe value
replacing value (Just _) = Just value
replacing _ Nothing = Nothing

-- | Keeps @value@ too, for the first reader, the oldest dropped beyond the count.
keep :: value -> Unread value -> Unread value
keep value (Keeping count kept) = Keeping count (Seq.drop (Seq.length kept + 1 - count) (kept |> value))
keep _ Unkept = Unkept

-- | Ends every reader's values once it has read what it was handed. A reader
-- who subscribes after is handed the latest, for state, and nothing kept for
-- a first reader.
close :: Broadcast value -> STM ()
close (Broadcast cell) = modifyTVar' cell (\current -> current { stopped = True, readers = Map.empty, unread = Unkept })
