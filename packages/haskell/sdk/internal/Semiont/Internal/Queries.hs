module Semiont.Internal.Queries (cacheOptions, oneReport) where

import qualified Semiont.Bus as Bus
import qualified Semiont.Internal.Cache as Cache
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Timing.Settings as Timing

cacheOptions :: Bus.BusOptions -> Timing.Settings -> (key -> IO (IO ())) -> Cache.CacheOptions key value
cacheOptions clock timing scope = Cache.CacheOptions (Bus.requestNow clock) (Bus.requestWaitUntil clock)
  (Timing.saveDebounceMs timing) Nothing scope

oneReport :: IO value -> IO (Running.Running value value)
oneReport action = Running.newRunning $ \report -> do
  value <- action
  report value
  pure value
