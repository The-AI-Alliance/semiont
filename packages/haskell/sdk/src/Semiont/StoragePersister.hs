{-# LANGUAGE OverloadedStrings #-}
-- | Versioned, byte-bounded cache documents over the host's atomic storage.
module Semiont.StoragePersister (StoragePersister(..), newStoragePersister) where

import Control.Concurrent.MVar (newMVar, modifyMVar)
import Control.Monad (when)
import Data.Aeson (FromJSON, ToJSON, Value, toJSON, encode, eitherDecodeStrict', fromJSON, Result(..))
import Data.Aeson.Types (Parser, parseEither)
import qualified Data.ByteString.Lazy as Lazy
import Data.List (sortOn)
import qualified Data.Map.Strict as Map
import Data.Scientific (Scientific)
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import qualified Semiont.Internal.Cache as Cache
import qualified Semiont.SessionStorage as Storage
import Semiont.Internal.Generated.CachePersistence

data StoragePersister = StoragePersister
  { persisterStorage :: Storage.SessionStorage
  , persisterStorageKey :: Text
  , persisterVersion :: Integer
  , persisterMaxBytes :: Integer
  , persisterWallNow :: IO Scientific
  -- ^ Epoch milliseconds; unchanged entries retain their previous write time.
  }

-- | A restored key may need a routing hint from its value. For ordinary keys
-- pass @\key _ -> parseJSON key@. All entries are decoded before any is loaded.
newStoragePersister :: (ToJSON key, ToJSON value, FromJSON value)
  => StoragePersister -> (Value -> value -> Parser key) -> IO (Cache.CachePersister key value)
newStoragePersister options decodeKey = do
  when (persisterMaxBytes options<0) (ioError (userError "Negative persisted-document byte cap"))
  stamps <- newMVar Map.empty
  let keyId=decodeUtf8 . Lazy.toStrict . Cache.canonical
      parse raw = do
        document <- either (const Nothing) Just (eitherDecodeStrict' (encodeUtf8 raw))
        if storedVersion document/=fromInteger (persisterVersion options) then Nothing else do
          values <- traverse (\(key,value,at) -> do
            parsed <- case fromJSON value of Error _->Nothing; Success result->Just result
            identity <- either (const Nothing) Just (parseEither (\input->decodeKey input parsed) key)
            pure (identity,parsed,key,value,at)) (storedEntries document)
          pure values
      load = modifyMVar stamps $ \_ -> do
        raw <- Storage.get (persisterStorage options) (persisterStorageKey options)
        let values=maybe [] id (raw >>= parse)
        pure (Map.fromList [(keyId key,(value,at)) | (_,_,key,value,at)<-values],[(key,value) | (key,value,_,_,_)<-values])
      save values = modifyMVar stamps $ \previous -> do
        now <- persisterWallNow options
        let records=[let encoded=toJSON value; identity=toJSON key
                         at=case Map.lookup (keyId identity) previous of Just (prior,written) | prior==encoded -> written; _->now
                     in (identity,encoded,at) | (key,value)<-values]
            bytes entries=encode (StoredDocument (fromInteger (persisterVersion options)) now entries)
            fit entries | toInteger (Lazy.length (bytes entries))<=persisterMaxBytes options = entries
                        | otherwise=case entries of []->[]; _:rest->fit rest
            retained=if toInteger (Lazy.length (bytes records))<=persisterMaxBytes options then records else fit (sortOn (\(_,_,at)->at) records)
        Storage.set (persisterStorage options) (persisterStorageKey options) (decodeUtf8 (Lazy.toStrict (bytes retained)))
        pure (Map.fromList [(keyId key,(value,at)) | (key,value,at)<-retained],())
  pure (Cache.CachePersister load save)
