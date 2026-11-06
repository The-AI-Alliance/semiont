{-# LANGUAGE OverloadedStrings #-}
-- | A shared, debounced search. A source publishes pending ('Nothing') and
-- ready answers until its IO action ends; replacing it cancels and joins it.
module Semiont.State.Search (SearchPipeline, SearchState(..), newSearchPipeline, query, state, setQuery, dispose) where

import Control.Concurrent.Async (cancel, race)
import Control.Concurrent.STM
import Control.Exception (finally, mask)
import Control.Monad (unless, void, when)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Semiont.Internal.Generated.UnicodeCase as Unicode
import Semiont.Internal.Generated.SearchState (SearchState(..))
import qualified Semiont.Internal.StateTasks as Tasks
import qualified Semiont.Internal.StateValue as State
import Semiont.Retry (RetryOptions(..))
import OpenTelemetry.Context.ThreadLocal.Propagation (propagateContext)

data SearchPipeline value = SearchPipeline Tasks.Tasks RetryOptions Integer
  (State.StateValue Text) (State.StateValue (SearchState value))
  (TQueue (Text, Integer, IO ())) (Text -> (Maybe [value] -> IO ()) -> IO ())

newSearchPipeline :: RetryOptions -> Integer -> Text -> (Text -> (Maybe [value] -> IO ()) -> IO ()) -> IO (SearchPipeline value)
newSearchPipeline clock delay initial source = do
  when (delay < 0) (ioError (userError "search debounce must be nonnegative"))
  tasks <- Tasks.newTasks "search pipeline is closed"
  unit <- SearchPipeline tasks clock delay <$> atomically (State.newStateValue initial)
    <*> atomically (State.newStateValue (SearchState [] False)) <*> newTQueueIO <*> pure source
  following <- newTVarIO Nothing
  let stop = readTVarIO following >>= mapM_ cancel
      follow searched plan = do
        next <- case plan of
          Nothing -> Left <$> atomically (readTQueue (changes unit))
          Just (_, due, _) -> do
            wake <- race (atomically (peekTQueue (changes unit))) (retryWaitUntil clock due)
            case wake of
              Left _ -> Left <$> atomically (readTQueue (changes unit))
              Right () -> atomically (tryReadTQueue (changes unit)) >>= pure . maybe (Right ()) Left
        case next of
          Left pending -> follow searched (Just pending)
          Right () -> case plan of
            Nothing -> follow searched Nothing
            Just (wanted, _, action)
              | searched == Just wanted -> follow searched Nothing
              | otherwise -> do
                  -- Cancellation cannot orphan the previous or next source.
                  mask $ \restore -> do
                    restore stop
                    atomically (writeTVar following Nothing)
                    let trimmed = Text.dropAround Unicode.whiteSpace wanted
                    if Text.null trimmed then atomically (State.update (state unit) (SearchState [] False)) else do
                      atomically (State.update (state unit) (SearchState [] True))
                      worker <- Tasks.start tasks action
                      atomically (writeTVar following (Just worker))
                  follow (Just wanted) Nothing
  enqueue unit initial False
  void (Tasks.start tasks (follow Nothing Nothing `finally` stop))
  pure unit

query :: SearchPipeline value -> State.StateValue Text
query (SearchPipeline _ _ _ value _ _ _) = value
state :: SearchPipeline value -> State.StateValue (SearchState value)
state (SearchPipeline _ _ _ _ value _ _) = value
changes :: SearchPipeline value -> TQueue (Text, Integer, IO ())
changes (SearchPipeline _ _ _ _ _ queue _) = queue

enqueue :: SearchPipeline value -> Text -> Bool -> IO ()
enqueue unit@(SearchPipeline tasks clock delay _ _ queue source) value distinct = do
  now <- retryNow clock
  action <- propagateContext $ source (Text.dropAround Unicode.whiteSpace value) $ \answer -> atomically $ do
    over <- Tasks.closed tasks
    unless over (State.update (state unit) (maybe (SearchState [] True) (\results -> SearchState results False) answer))
  atomically $ do
    over <- Tasks.closed tasks
    current <- State.current (query unit)
    unless (over || distinct && current==value) $ do
      State.update (query unit) value
      writeTQueue queue (value,now + delay * 1000000,action)

setQuery :: SearchPipeline value -> Text -> IO ()
setQuery unit value = enqueue unit value True

dispose :: SearchPipeline value -> IO ()
dispose unit@(SearchPipeline tasks _ _ _ _ _ _) = Tasks.dispose tasks `finally`
  atomically (State.complete (query unit) >> State.complete (state unit))
