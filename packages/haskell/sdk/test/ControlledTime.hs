module ControlledTime (ControlledTime, newTime, now, waitUntil, awaitDue, settle, advance, within) where

import Control.Concurrent (myThreadId, yield)
import Control.Concurrent.STM
import Control.Exception (bracket)
import Control.Monad (unless, when)
import qualified Data.Map.Strict as Map
import GHC.Conc.Sync (listThreads, threadStatus, ThreadStatus(..))

data ControlledTime = ControlledTime (TVar Integer) (TVar Integer) (TVar (Map.Map Integer Integer))

newTime :: IO ControlledTime
newTime = atomically (ControlledTime <$> newTVar 0 <*> newTVar 0 <*> newTVar Map.empty)
now :: ControlledTime -> IO Integer
now (ControlledTime clock _ _) = readTVarIO clock
waitUntil :: ControlledTime -> Integer -> IO ()
waitUntil (ControlledTime clock counter waiting) due = bracket
  (atomically $ do
    key <- readTVar counter
    writeTVar counter (key + 1)
    modifyTVar' waiting (Map.insert key due)
    pure key)
  (\key -> atomically (modifyTVar' waiting (Map.delete key)))
  (\_ -> atomically (readTVar clock >>= check . (>=due)))

-- Wait until some worker waits for exactly this instant. Unlike settle, this
-- does not depend on how the worker's threads look on the way there.
awaitDue :: ControlledTime -> Integer -> IO ()
awaitDue (ControlledTime _ _ waiting) due = atomically (readTVar waiting >>= check . elem due . Map.elems)

-- Settle the real IO runtime; no elapsed time and no fixed number of yields
-- stand in for a worker reaching its next blocking wait.
settle :: IO ()
settle = do
  caller <- myThreadId
  let idle = do
        threads <- filter (/=caller) <$> listThreads
        states <- traverse threadStatus threads
        pure (all stopped states)
      stopped ThreadRunning = False
      stopped _ = True
      loop = do
        yield
        first <- idle
        if not first then loop else do
          yield
          second <- idle
          unless second loop
  loop

advance :: ControlledTime -> Integer -> IO ()
advance time@(ControlledTime clock _ waiting) nanoseconds = do
  when (nanoseconds < 0) (ioError (userError "controlled clock cannot go backwards"))
  settle
  target <- (+nanoseconds) <$> now time
  let step = do
        next <- atomically $ do
          current <- readTVar clock
          deadlines <- Map.elems <$> readTVar waiting
          let due = filter (\deadline -> deadline > current && deadline <= target) deadlines
          pure (case due of [] -> Nothing; _ -> Just (minimum due))
        case next of
          Nothing -> atomically (writeTVar clock target) >> settle
          Just due -> atomically (writeTVar clock due) >> settle >> step
  step

-- | Whether probe comes to hold, tried once settled and after each of a
-- hundred moves of the clock by step nanoseconds.
within :: ControlledTime -> Integer -> IO Bool -> IO Bool
within time step probe = go (100 :: Int)
  where
    go left = do
      settle
      held <- probe
      if held || left == 0 then pure held else advance time step >> go (left - 1)
