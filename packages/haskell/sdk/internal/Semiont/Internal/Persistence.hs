{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Persistence (CachePersistence(..), persister) where

import Data.Aeson (FromJSON, ToJSON, Value)
import Data.Aeson.Types (Parser)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.StoragePersister as Stored
import qualified Semiont.Cache as Cache
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Internal.Generated.Stored as Keys
import Semiont.Internal.Generated.CachePersistence

data CachePersistence = CachePersistence
  { cacheStorage :: Storage.SessionStorage
  , cachePrefix :: Text
  , cacheWallNow :: IO Scientific
  -- ^ Epoch milliseconds supplied by the host. Protocol waits use BusOptions.
  }

persister :: (ToJSON key, ToJSON value, FromJSON value)
  => Maybe CachePersistence -> Timing.Settings -> PersistedQuery
  -> (Value -> value -> Parser key) -> IO (Maybe (Cache.CachePersister key value))
persister Nothing _ _ _=pure Nothing
persister (Just options) timing query decodeKey = Just <$> Stored.newStoragePersister
  (Stored.StoragePersister (cacheStorage options) (Keys.cacheKeyPrefix<>cachePrefix options<>"."<>persistedQueryName query)
    persistenceVersion (Timing.maxStoredBytesCount timing) (cacheWallNow options)) decodeKey
