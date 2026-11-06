module Semiont.Internal.StateTasks (Tasks, newTasks, start, fork, submit, listen, closed, dispose) where

import Control.Concurrent.Async (Async)
import Control.Concurrent.STM
import Control.Exception (SomeAsyncException, SomeException, bracket, catch, finally, fromException, mask, onException, throwIO)
import Control.Monad (forever, unless, void)
import Data.Text (Text)
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (attachContext, detachContext)
import OpenTelemetry.Context.ThreadLocal.Propagation (propagateContext)
import Semiont.Errors (BusRequestError(..))
import Semiont.ErrorCodes (BusRequestCode(BusRequestClosed))
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.Transport as Local
import Semiont.Types (BusFrame(..))

-- A state unit owns its workers. Unexpected failures remain observable when
-- that owner is joined, rather than disappearing with an unobserved Async.
data Tasks = Tasks Lifetime.Lifetime (TVar (Maybe SomeException)) (TQueue (IO ())) (TQueue (IO (), TMVar ()))

newTasks :: Text -> IO Tasks
newTasks label = mask $ \restore -> do
  tasks@(Tasks _ _ _ queued) <- Tasks <$> Lifetime.newLifetime label <*> newTVarIO Nothing <*> newTQueueIO <*> newTQueueIO
  void $ start tasks $ restore $ forever $ do
    (action, accepted) <- atomically (readTQueue queued)
    void (start tasks (action `finally` void (atomically (tryPutTMVar accepted ()))))
    atomically (readTMVar accepted)
  pure tasks

closed :: Tasks -> STM Bool
closed (Tasks lifetime _ _ _) = Lifetime.isClosed lifetime

start :: Tasks -> IO result -> IO (Async result)
start (Tasks lifetime failed _ _) action = Lifetime.start lifetime (action `catch` remember)
  where
    remember problem = do
      case fromException problem :: Maybe SomeAsyncException of
        Just _ -> pure ()
        Nothing -> atomically $ do
          over <- Lifetime.isClosed lifetime
          prior <- readTVar failed
          unless (over || maybe False (const True) prior) (writeTVar failed (Just problem))
      throwIO problem

fork :: Tasks -> IO () -> IO ()
fork tasks action = void (start tasks action) `catch` \problem -> do
  over <- atomically (closed tasks)
  if over && busRequestErrorCode problem == BusRequestClosed then pure () else throwIO problem

-- Queue creation in invocation order. Once the producer knows its job id it
-- releases the next creation, while continuing to own the current job. A
-- failed creation releases the queue too; disposal cancels queued work.
submit :: Tasks -> (IO () -> IO ()) -> IO ()
submit tasks@(Tasks _ _ _ queue) action = do
  accepted <- newEmptyTMVarIO
  inherited <- propagateContext (action (void (atomically (tryPutTMVar accepted ()))))
  atomically (closed tasks >>= \over -> unless over (writeTQueue queue (inherited,accepted)))

-- Subscription installation is synchronous. The queue retains ordering
-- across channels, with the publishing context attached only while handling
-- that frame. No worker or listener outlives its state unit.
listen :: Tasks -> Local.EventBus -> [Text] -> (Local.Frame -> IO ()) -> IO ()
listen tasks@(Tasks _ _ finalizers _) bus channels consume = do
  queue <- newTQueueIO
  detach <- Local.tapLocal bus $ \frame context -> do
    over <- closed tasks
    unless (over || busFrameChannel (Local.wireFrame frame) `notElem` channels) (writeTQueue queue (frame,context))
  let work = forever $ do
        (frame, context) <- atomically (readTQueue queue)
        case context of
          Nothing -> consume frame
          Just parent -> withContext parent (consume frame)
      withContext :: Context.Context -> IO () -> IO ()
      withContext context action = bracket (attachContext context) detachContext (const action)
  void (start tasks work) `onException` detach
  release <- atomically $ do
    over <- closed tasks
    if over then pure True else writeTQueue finalizers detach >> pure False
  if release then detach else pure ()

dispose :: Tasks -> IO ()
dispose (Tasks lifetime failed finalizers _) = Lifetime.close lifetime `finally` do
  actions <- atomically (flushTQueue finalizers)
  foldr finally (readTVarIO failed >>= maybe (pure ()) throwIO) actions
