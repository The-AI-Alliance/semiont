{-# LANGUAGE OverloadedStrings #-}
-- | Hover after a pointer rests; leaving cancels that rest. Time and waits
-- belong to the caller, and disposal joins the callback in flight.
module Semiont.State.HoverDwell (HoverDwell, newHoverDwell, enter, leave, dispose) where

import Control.Concurrent.Async (race)
import Control.Concurrent.STM
import Control.Monad (unless, void, when)
import OpenTelemetry.Context.ThreadLocal.Propagation (propagateContext)
import qualified Semiont.Internal.StateTasks as Tasks
import Semiont.Retry (RetryOptions(..))
import Semiont.Types (AnnotationId)

data Command = Enter AnnotationId Integer (IO ()) | Leave (IO ())
data HoverDwell = HoverDwell Tasks.Tasks RetryOptions Integer (TQueue Command) (Maybe AnnotationId -> IO ())

newHoverDwell :: RetryOptions -> Integer -> (Maybe AnnotationId -> IO ()) -> IO HoverDwell
newHoverDwell clock delay say = do
  when (delay < 0) (ioError (userError "hover delay must be nonnegative"))
  tasks <- Tasks.newTasks "hover dwell is closed"
  commands <- newTQueueIO
  let unit = HoverDwell tasks clock delay commands say
      follow hovered plan = do
        next <- case plan of
          Nothing -> Left <$> atomically (readTQueue commands)
          Just (due, _, _) -> do
            wake <- race (atomically (peekTQueue commands)) (retryWaitUntil clock due)
            case wake of
              Left _ -> Left <$> atomically (readTQueue commands)
              Right () -> atomically $ do
                queued <- tryReadTQueue commands
                pure (maybe (Right ()) Left queued)
        case next of
          Left (Enter identity due notify)
            | hovered == Just identity -> follow hovered plan
            | otherwise -> follow hovered (Just (due, identity, notify))
          Left (Leave notify) -> when (maybe False (const True) hovered) notify >> follow Nothing Nothing
          Right () -> case plan of
            Nothing -> follow hovered Nothing
            Just (_, identity, notify) -> notify >> follow (Just identity) Nothing
  void (Tasks.start tasks (follow Nothing Nothing))
  pure unit

enter :: HoverDwell -> AnnotationId -> IO ()
enter (HoverDwell tasks clock delay commands say) identity = do
  now <- retryNow clock
  notify <- propagateContext (say (Just identity))
  atomically (Tasks.closed tasks >>= \over -> unless over (writeTQueue commands (Enter identity (now + delay * 1000000) notify)))

leave :: HoverDwell -> IO ()
leave (HoverDwell tasks _ _ commands say) = do
  notify <- propagateContext (say Nothing)
  atomically (Tasks.closed tasks >>= \over -> unless over (writeTQueue commands (Leave notify)))

dispose :: HoverDwell -> IO ()
dispose (HoverDwell tasks _ _ _ _) = Tasks.dispose tasks
