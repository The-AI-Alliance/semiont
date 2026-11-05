module Semiont.Internal.Delivery
  ( Hub, newHub, withFrames, publish, closeHub
  , Replies, PendingReply, CorrelationConflict(..), newReplies, withReply, awaitReply
  , awaited, deliver, closeReplies
  ) where

import Control.Concurrent.STM
import Control.Exception (Exception, bracket)
import Control.Monad (forM_, unless)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Semiont.Internal.Broadcast as Broadcast
import Semiont.Types (BusFrame(..))

data Hub = Hub (TVar (Bool, Map.Map Text (Broadcast.Broadcast BusFrame)))
data PendingReply = PendingReply Integer (Set.Set Text) (TMVar (Maybe BusFrame))
data Replies = Replies (TVar (Bool, Integer, Map.Map Text PendingReply))
data CorrelationConflict = CorrelationConflict deriving (Eq, Show)
instance Exception CorrelationConflict

newHub :: STM Hub
newHub = Hub <$> newTVar (False, Map.empty)

channel :: Hub -> Text -> STM (Broadcast.Broadcast BusFrame)
channel (Hub cell) name = do
  (closed, channels) <- readTVar cell
  case Map.lookup name channels of
    Just events -> pure events
    Nothing -> do
      events <- Broadcast.newEvents
      if closed then Broadcast.close events
        else writeTVar cell (closed, Map.insert name events channels)
      pure events

withFrames :: Hub -> Text -> (Broadcast.Subscription BusFrame -> IO value) -> IO value
withFrames hub name consume = do
  events <- atomically (channel hub name)
  Broadcast.withSubscription events consume

publish :: Hub -> BusFrame -> STM ()
publish (Hub cell) frame = do
  (closed, channels) <- readTVar cell
  unless closed $ forM_ (Map.lookup (busFrameChannel frame) channels) $ \events ->
    Broadcast.publish events frame

closeHub :: Hub -> STM ()
closeHub (Hub cell) = do
  (_, channels) <- readTVar cell
  mapM_ Broadcast.close channels
  writeTVar cell (True, Map.empty)

newReplies :: STM Replies
newReplies = Replies <$> newTVar (False, 0, Map.empty)

track :: Replies -> Text -> Set.Set Text -> STM PendingReply
track (Replies cell) correlation channels = do
  (closed, generation, pending) <- readTVar cell
  if Map.member correlation pending then throwSTM CorrelationConflict else do
    result <- newEmptyTMVar
    let reply = PendingReply generation channels result
    if closed then putTMVar result Nothing else
      writeTVar cell (False, generation + 1, Map.insert correlation reply pending)
    pure reply

forget :: Replies -> Text -> PendingReply -> STM ()
forget (Replies cell) correlation (PendingReply generation _ _) = do
  (closed, counter, pending) <- readTVar cell
  case Map.lookup correlation pending of
    Just (PendingReply current _ _) | current == generation ->
      writeTVar cell (closed, counter, Map.delete correlation pending)
    _ -> pure ()

withReply :: Replies -> Text -> Set.Set Text -> (PendingReply -> IO value) -> IO value
withReply replies correlation channels =
  bracket (atomically (track replies correlation channels)) (atomically . forget replies correlation)

awaitReply :: PendingReply -> STM (Maybe BusFrame)
awaitReply (PendingReply _ _ result) = readTMVar result

awaited :: Replies -> STM [Text]
awaited (Replies cell) = do
  (_, _, pending) <- readTVar cell
  pure (Map.keys pending)

route :: Replies -> BusFrame -> STM ()
route (Replies cell) frame = forM_ (busFrameCorrelationId frame) $ \correlation -> do
  (closed, generation, pending) <- readTVar cell
  case Map.lookup correlation pending of
    Just (PendingReply _ channels result) | Set.member (busFrameChannel frame) channels -> do
      putTMVar result (Just frame)
      writeTVar cell (closed, generation, Map.delete correlation pending)
    _ -> pure ()

-- Every raw observer receives the reply before its continuation may publish
-- a derived signal. One STM transaction owns both publication and settlement.
deliver :: [Hub] -> Replies -> BusFrame -> STM ()
deliver hubs replies frame = mapM_ (`publish` frame) hubs >> route replies frame

closeReplies :: Replies -> STM ()
closeReplies (Replies cell) = do
  (_, generation, pending) <- readTVar cell
  forM_ pending $ \(PendingReply _ _ result) -> putTMVar result Nothing
  writeTVar cell (True, generation, Map.empty)
