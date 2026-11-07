module Semiont.Internal.Running
  ( Running, ConsumptionError(..), newRunning, await, withReports
  ) where

import OpenTelemetry.Context.ThreadLocal.Propagation (tracedWithAsync)
import Control.Concurrent.STM
import Control.Exception (Exception, SomeException, bracket_, mask, throwIO, try)
import Control.Monad (unless)
import Control.Monad.IO.Class (liftIO)
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

data ConsumptionError = AlreadyConsumed | ObservationEnded deriving (Eq, Show)
instance Exception ConsumptionError

data Running report result = Running (TVar Bool) ((report -> IO ()) -> IO result)
data Item report result = Report report | Ended (Either SomeException result)

newRunning :: ((report -> IO ()) -> IO result) -> IO (Running report result)
newRunning start = Running <$> newTVarIO False <*> pure start

takeOnce :: Running report result -> IO ()
takeOnce (Running taken _) = atomically $ do
  previous <- readTVar taken
  if previous then throwSTM AlreadyConsumed else writeTVar taken True

await :: Running report result -> IO result
await running@(Running _ start) = mask $ \restore -> do
  takeOnce running
  restore (start (const (pure ())))

withReports :: Running report result -> (Stream (Of report) IO result -> IO value) -> IO value
withReports running@(Running _ start) consume = mask $ \restore -> do
  takeOnce running
  queue <- newTQueueIO
  stopped <- newTVarIO False
  let offer item = atomically $ do
        over <- readTVar stopped
        unless over (writeTQueue queue item)
      finish = atomically $ do
        writeTVar stopped True
        _ <- flushTQueue queue
        pure ()
      readItem = atomically $ do
        over <- readTVar stopped
        if over then throwSTM ObservationEnded else do
          item <- readTQueue queue
          case item of
            Report _ -> pure ()
            Ended _ -> writeTVar stopped True >> flushTQueue queue >> pure ()
          pure item
      reports = do
        item <- liftIO readItem
        case item of
          Report report -> Stream.yield report >> reports
          Ended outcome -> liftIO (either throwIO pure outcome)
      work = try (restore (start (offer . Report))) >>= offer . Ended
  bracket_ (pure ()) finish $
    tracedWithAsync work (\_ -> restore (consume reports))
