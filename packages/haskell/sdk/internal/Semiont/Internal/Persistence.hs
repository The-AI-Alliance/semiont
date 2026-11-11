{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Persistence (CachePersistence(..), persister) where

import Data.Aeson (FromJSON, ToJSON, Value)
import Data.Aeson.Types (Parser)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.StoragePersister as Stored
import qualified Semiont.Cache as Cache
import qualified Semiont.Internal.Coupled as Coupled
import Semiont.Internal.Kept (cacheKey)
import qualified Semiont.Timing.Settings as Timing
import Semiont.Internal.Generated.CachePersistence (KeptQuery)

-- | What a client keeps for one person on one knowledge base, under the
-- keys session/stored.json gives the knowledge base's id and the person's key.
data CachePersistence = CachePersistence
  { cacheStorage :: Storage.SessionStorage
  , cacheKbId :: Text
  , cachePersonKey :: Text
  , cacheWallNow :: IO Scientific
  -- ^ Epoch milliseconds supplied by the host. Protocol waits use BusOptions.
  }

-- | A kept query's persister, whose every recorded save writes the places noted.
persister :: (ToJSON key, ToJSON value, FromJSON value)
  => CachePersistence -> Coupled.Coupled -> Timing.Settings -> KeptQuery
  -> (Value -> value -> Parser key) -> IO (Cache.CachePersister key value)
persister options coupled timing query = Stored.newStoragePersister
  (Stored.StoragePersister (cacheStorage options) (cacheKey (cacheKbId options) (cachePersonKey options) query)
    (Timing.maxStoredBytesCount timing) (cacheWallNow options) (Coupled.written coupled))
