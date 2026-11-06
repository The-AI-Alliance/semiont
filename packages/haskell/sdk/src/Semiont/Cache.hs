-- | Lazy read-through queries and their three observable outcomes.
module Semiont.Cache
  ( Cache, Query, CacheState(..), CacheOptions(..), CachePersister(..)
  , newCache, query, current, watch, fresh, observe, fetch, get, known, keys
  , invalidate, invalidateAll, remove, set, persistencePending, dispose
  , isReady, readyValue
  ) where
import Semiont.Internal.Cache
