module Semiont.Internal.Delivery
  ( Hub, newHub, withFrames, publish, closeHub, onFrameSTM
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

data Hub frame = Hub (frame -> Text) (TVar (Bool, Map.Map Text (Broadcast.Broadcast frame)))
  (TVar (Map.Map Integer (frame -> STM ()))) (TVar Integer)
instance Eq (Hub frame) where Hub _ left _ _ == Hub _ right _ _ = left == right
data PendingReply frame = PendingReply Integer (Set.Set Text) (TMVar (Maybe frame))
data Replies frame = Replies (frame -> Text) (frame -> Maybe Text) (TVar (Bool, Integer, Map.Map Text (PendingReply frame)))
data CorrelationConflict = CorrelationConflict deriving (Eq, Show)
instance Exception CorrelationConflict

newHub :: (frame -> Text) -> STM (Hub frame)
newHub named = Hub named <$> newTVar (False, Map.empty) <*> newTVar Map.empty <*> newTVar 0

channel :: Hub frame -> Text -> STM (Broadcast.Broadcast frame)
channel (Hub _ cell _ _) name = do
  (closed, channels) <- readTVar cell
  case Map.lookup name channels of
    Just events -> pure events
    Nothing -> do
      events <- Broadcast.newEvents
      if closed then Broadcast.close events
        else writeTVar cell (closed, Map.insert name events channels)
      pure events

withFrames :: Hub frame -> Text -> (Broadcast.Subscription frame -> IO value) -> IO value
withFrames hub name consume = do
  events <- atomically (channel hub name)
  Broadcast.withSubscription events consume

-- Frame effects that guard resumption state must land in the publication's
-- transaction, before either a raw reader or a request continuation can run.
onFrameSTM :: Hub frame -> (frame -> STM ()) -> IO (IO ())
onFrameSTM (Hub _ cell hooks counter) action = do
  release <- atomically $ do
    (closed,_) <- readTVar cell
    if closed then pure (pure ()) else do
      key <- readTVar counter
      writeTVar counter (key+1)
      modifyTVar' hooks (Map.insert key action)
      pure (modifyTVar' hooks (Map.delete key))
  pure (atomically release)

publish :: Hub frame -> frame -> STM ()
publish (Hub named cell hooks _) frame = do
  (closed, channels) <- readTVar cell
  unless closed $ do
    effects <- Map.elems <$> readTVar hooks
    mapM_ ($ frame) effects
    forM_ (Map.lookup (named frame) channels) $ \events -> Broadcast.publish events frame

closeHub :: Hub frame -> STM ()
closeHub (Hub _ cell hooks _) = do
  (_, channels) <- readTVar cell
  mapM_ Broadcast.close channels
  writeTVar cell (True, Map.empty)
  writeTVar hooks Map.empty

newReplies :: (frame -> Text) -> (frame -> Maybe Text) -> STM (Replies frame)
newReplies named correlated = Replies named correlated <$> newTVar (False, 0, Map.empty)

track :: Replies frame -> Text -> Set.Set Text -> STM (PendingReply frame)
track (Replies _ _ cell) correlation channels = do
  (closed, generation, pending) <- readTVar cell
  if Map.member correlation pending then throwSTM CorrelationConflict else do
    result <- newEmptyTMVar
    let reply = PendingReply generation channels result
    if closed then putTMVar result Nothing else
      writeTVar cell (False, generation + 1, Map.insert correlation reply pending)
    pure reply

forget :: Replies frame -> Text -> PendingReply frame -> STM ()
forget (Replies _ _ cell) correlation (PendingReply generation _ _) = do
  (closed, counter, pending) <- readTVar cell
  case Map.lookup correlation pending of
    Just (PendingReply current _ _) | current == generation ->
      writeTVar cell (closed, counter, Map.delete correlation pending)
    _ -> pure ()

withReply :: Replies frame -> Text -> Set.Set Text -> (PendingReply frame -> IO value) -> IO value
withReply replies correlation channels =
  bracket (atomically (track replies correlation channels)) (atomically . forget replies correlation)

awaitReply :: PendingReply frame -> STM (Maybe frame)
awaitReply (PendingReply _ _ result) = readTMVar result

awaited :: Replies frame -> STM [Text]
awaited (Replies _ _ cell) = do
  (_, _, pending) <- readTVar cell
  pure (Map.keys pending)

route :: Replies frame -> frame -> STM ()
route (Replies named correlated cell) frame = forM_ (correlated frame) $ \correlation -> do
  (closed, generation, pending) <- readTVar cell
  case Map.lookup correlation pending of
    Just (PendingReply _ channels result) | Set.member (named frame) channels -> do
      putTMVar result (Just frame)
      writeTVar cell (closed, generation, Map.delete correlation pending)
    _ -> pure ()

-- Every raw observer receives the reply before its continuation may publish
-- a derived signal. One STM transaction owns both publication and settlement.
deliver :: [Hub frame] -> Replies frame -> frame -> STM ()
deliver hubs replies frame = mapM_ (`publish` frame) hubs >> route replies frame

closeReplies :: Replies frame -> STM ()
closeReplies (Replies _ _ cell) = do
  (_, generation, pending) <- readTVar cell
  forM_ pending $ \(PendingReply _ _ result) -> putTMVar result Nothing
  writeTVar cell (True, generation, Map.empty)
