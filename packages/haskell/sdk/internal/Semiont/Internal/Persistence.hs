{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Persistence (CachePersistence(..), persister, documentKey) where

import Data.Aeson (FromJSON, ToJSON, Value)
import Data.Aeson.Types (Parser)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.StoragePersister as Stored
import qualified Semiont.Cache as Cache
import qualified Semiont.Internal.Coupled as Coupled
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Internal.Generated.Stored as Keys
import Semiont.Internal.Generated.CachePersistence (KeptQuery, keptQueryName)

data CachePersistence = CachePersistence
  { cacheStorage :: Storage.SessionStorage
  , cachePrefix :: Text
  , cacheWallNow :: IO Scientific
  -- ^ Epoch milliseconds supplied by the host. Protocol waits use BusOptions.
  }

-- | The key a kept query's document is kept under.
documentKey :: Text -> KeptQuery -> Text
documentKey prefix query = Keys.cacheKeyPrefix<>prefix<>"."<>keptQueryName query

-- | A kept query's persister, whose every recorded save writes the places noted.
persister :: (ToJSON key, ToJSON value, FromJSON value)
  => Maybe (CachePersistence, Coupled.Coupled) -> Timing.Settings -> KeptQuery
  -> (Value -> value -> Parser key) -> IO (Maybe (Cache.CachePersister key value))
persister Nothing _ _ _=pure Nothing
persister (Just (options, coupled)) timing query decodeKey = Just <$> Stored.newStoragePersister
  (Stored.StoragePersister (cacheStorage options) (documentKey (cachePrefix options) query)
    (Timing.maxStoredBytesCount timing) (cacheWallNow options) (Coupled.written coupled)) decodeKey
